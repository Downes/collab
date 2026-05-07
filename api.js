import { db } from './db.js'
import { verifyToken, resolveUserDid, kvHostShort } from './auth.js'
import { randomBytes } from 'crypto'

const PORT          = parseInt(process.env.PORT  || '3003')
const SERVER_WS_URL = process.env.SERVER_WS_URL || 'wss://collab.mooc.ca'

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// JSON-encode a value for safe embedding inside an HTML <script> block.
// JSON.stringify does not escape </, which the HTML parser reads as </script>.
function scriptJson(v) {
  return JSON.stringify(v).replace(/<\//g, '<\\/')
}

const BODY_LIMIT = 65536 // 64 KB — enough for any document metadata payload

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
      if (body.length > BODY_LIMIT) {
        request.destroy()
        reject(new Error('Request body too large'))
      }
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

// Lightweight HTTP handler for health check and document management API.
// Resolve to indicate the request was handled; throw to let Hocuspocus 404.
export async function handleRequest({ request, response }) {
  // Hocuspocus calls writeHead/end again after onRequest resolves without
  // checking headersSent first.  Make both idempotent so the second call
  // is a silent no-op instead of throwing ERR_HTTP_HEADERS_SENT.
  const _writeHead = response.writeHead.bind(response)
  const _end       = response.end.bind(response)
  response.writeHead = (...a) => response.headersSent   ? response : _writeHead(...a)
  response.end       = (...a) => response.writableEnded ? response : _end(...a)

  const url    = new URL(request.url, `http://localhost:${PORT}`)
  const method = request.method

  if (method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }

  // POST /api/register — register a user on this collab server.
  if (method === 'POST' && url.pathname === '/api/register') {
    const authHeader = request.headers['authorization'] || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    const username = await verifyToken(token)
    if (!username) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    await new Promise(resolve => {
      request.on('data', () => {})
      request.on('end', resolve)
    })
    const didInfo = await resolveUserDid(username)
    if (didInfo?.didKey) {
      db.prepare(`
        INSERT INTO users (did_key, did_web, username, kvhost, registered_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(did_key) DO UPDATE SET
          did_web = excluded.did_web,
          username = excluded.username,
          kvhost = excluded.kvhost,
          registered_at = unixepoch()
      `).run(didInfo.didKey, didInfo.didWeb || null, username, kvHostShort(process.env.KVSTORE_URL || 'http://kvstore:5000'))
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ username, didKey: didInfo?.didKey || null, didWeb: didInfo?.didWeb || null }))
    return
  }

  // POST /api/documents — create a document record before first connection.
  if (method === 'POST' && url.pathname === '/api/documents') {
    const authHeader = request.headers['authorization'] || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    const postUsername = await verifyToken(token)
    if (!token || !postUsername) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    let body
    try { body = await readBody(request) } catch (e) {
      response.writeHead(413, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: e.message }))
      return
    }
    try {
      const { id, title, allow_anonymous, expires_in } = JSON.parse(body)
      if (!id) throw new Error('id is required')
      const didInfo   = await resolveUserDid(postUsername)
      const namespace = didInfo?.didKey || didInfo?.didWeb
        || `${postUsername}@${kvHostShort(process.env.KVSTORE_URL || 'http://kvstore:5000')}`
      const expires_at = expires_in ? Math.floor(Date.now() / 1000) + expires_in : null
      db.prepare(`
        INSERT OR IGNORE INTO documents (id, title, allow_anonymous, expires_at, owner)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, title || '', allow_anonymous ? 1 : 0, expires_at, namespace)
      response.writeHead(201, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id }))
    } catch (e) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // GET /api/documents — list documents owned by the authenticated user.
  if (method === 'GET' && url.pathname === '/api/documents') {
    const authHeader = request.headers['authorization'] || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    const listKvUrl  = url.searchParams.get('kvstoreUrl') || null
    const listEffKv  = listKvUrl || process.env.KVSTORE_URL || 'http://kvstore:5000'
    const listUser   = await verifyToken(token, listEffKv)
    if (!token || !listUser) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const didInfo   = await resolveUserDid(listUser, listEffKv)
    const namespace = didInfo?.didKey || didInfo?.didWeb
      || `${listUser}@${kvHostShort(listEffKv)}`
    const docs = db.prepare(
      `SELECT id, title, allow_anonymous, created_at, updated_at, expires_at
       FROM documents WHERE owner = ? ORDER BY updated_at DESC`
    ).all(namespace)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(docs))
    return
  }

  // GET /doc/...  — public share-link endpoint (CORS open to all origins).
  // Supports single-segment IDs (/doc/Test2/edit) and namespaced IDs
  // (/doc/alice/my-notes/edit).  The last segment is treated as the mode
  // if it equals 'edit' or 'read'; everything else is the document ID.
  if (method === 'GET' && url.pathname.startsWith('/doc/')) {
    const segs = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent)
    const last = segs[segs.length - 1]
    const mode = (last === 'edit' || last === 'read') ? last : 'edit'
    const id   = (last === 'edit' || last === 'read') ? segs.slice(0, -1).join('/') : segs.join('/')
    const cors = { 'Access-Control-Allow-Origin': '*' }
    if (!id) {
      response.writeHead(404, { 'Content-Type': 'application/json', ...cors })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    const doc = db
      .prepare('SELECT id, title, allow_anonymous, owner FROM documents WHERE id = ?')
      .get(id)
    if (!doc) {
      const accepts = request.headers['accept'] || ''
      if (accepts.includes('text/html')) {
        response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...cors })
        response.end(`<!DOCTYPE html><html><body><h2>Document not found</h2><p>No document with ID <code>${esc(id)}</code> exists on this server.</p></body></html>`)
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json', ...cors })
        response.end(JSON.stringify({ error: 'not found' }))
      }
      return
    }
    const ownerDisplay = doc.owner || null
    const accepts = request.headers['accept'] || ''
    if (accepts.includes('text/html')) {
      const title     = doc.title || (doc.id.includes('/') ? doc.id.split('/').pop() : doc.id)
      const modeLabel = mode === 'read' ? 'Read-only' : 'Collaborative editing'
      const ownerUser = ownerDisplay
        ? db.prepare('SELECT username, did_web FROM users WHERE did_key = ?').get(ownerDisplay)
        : null
      const ownerName    = ownerUser?.username || ownerDisplay
      // did:web:host:path → https://host/path/did.json
      const ownerDidUrl  = ownerUser?.did_web
        ? 'https://' + ownerUser.did_web.replace(/^did:web:/, '').replace(/:/g, '/') + '/did.json'
        : null
      const ownerLine = ownerName
        ? `<p><strong>Owner:</strong> ${ownerDidUrl ? `<a href="${esc(ownerDidUrl)}" target="_blank" rel="noopener">${esc(ownerName)}</a>` : esc(ownerName)}</p>`
        : ''
      const showEditor = !!doc.allow_anonymous
      const isEditable = doc.allow_anonymous && mode === 'edit'
      const nonce = randomBytes(16).toString('base64')
      const csp = [
        "default-src 'none'",
        `script-src 'nonce-${nonce}' https://esm.sh`,
        "style-src 'unsafe-inline'",
        `connect-src ${SERVER_WS_URL.replace(/^wss?:/, 'wss:')} https://esm.sh`,
        "img-src 'none'",
        "worker-src 'none'",
      ].join('; ')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, ...cors })
      response.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} — Collab</title>
  <style>
    body { font-family: sans-serif; max-width: ${showEditor ? '860px' : '600px'}; margin: 40px auto; padding: 0 20px; color: #222; }
    h1   { font-size: 1.4em; margin-bottom: 4px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; word-break: break-all; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 0.8em;
             background: ${mode === 'read' ? '#eee' : '#ddeedd'}; color: #333; margin-bottom: 16px; }
    .link-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    button { padding: 4px 12px; cursor: pointer; border: 1px solid #ccc; border-radius: 3px;
             background: #f5f5f5; font-size: 0.85em; }
    button:hover { background: #e8e8e8; }
    .note { margin-top: 24px; font-size: 0.85em; color: #666; border-top: 1px solid #eee; padding-top: 12px; }
    #collab-status { font-size: 0.8em; color: #888; margin: 12px 0 4px; }
    #format-toolbar { display: flex; flex-wrap: wrap; gap: 3px; padding: 6px 8px; border: 1px solid #ddd; border-bottom: none; border-radius: 4px 4px 0 0; background: #f9f9f9; margin-top: 4px; }
    #format-toolbar button { padding: 2px 7px; font-size: 0.82em; min-width: 28px; border-radius: 3px; background: #fff; border: 1px solid #ccc; cursor: pointer; line-height: 1.5; }
    #format-toolbar button:hover { background: #e8e8e8; }
    #format-toolbar button.is-active { background: #dde8ff; border-color: #99a; }
    #format-toolbar .sep { width: 1px; background: #ddd; margin: 2px 3px; align-self: stretch; }
    #editor-area { border: 1px solid #ddd; border-radius: ${isEditable ? '0 0 4px 4px' : '4px'}; background: ${isEditable ? '#fff' : '#fafafa'}; }
    #editor-area .ProseMirror { outline: none; min-height: 240px; padding: 14px; color: #111; }
    #editor-area .ProseMirror p { margin: 0.5em 0; }
    #editor-area .ProseMirror h1 { font-size: 1.6em; margin: 0.8em 0 0.3em; }
    #editor-area .ProseMirror h2 { font-size: 1.3em; margin: 0.7em 0 0.3em; }
    #editor-area .ProseMirror ul, #editor-area .ProseMirror ol { padding-left: 1.5em; }
    #editor-area .ProseMirror blockquote { border-left: 3px solid #ccc; margin: 0.5em 0; padding-left: 1em; color: #555; }
    #presence-bar { display: flex; align-items: center; gap: 8px; margin: 10px 0 4px; flex-wrap: wrap; font-size: 0.82em; }
    #presence-list { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; min-height: 22px; }
    .presence-dot { display: inline-block; padding: 2px 9px; border-radius: 10px; color: #fff; font-weight: 500; }
    .presence-dot.is-me { outline: 2px solid #555; outline-offset: 1px; }
    #name-edit { display: flex; align-items: center; gap: 4px; color: #666; white-space: nowrap; }
    #name-edit input { padding: 1px 6px; border: 1px solid #ccc; border-radius: 3px; font-size: 1em; width: 110px; }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
    <div class="badge" style="margin-bottom:0">${esc(modeLabel)}</div>
    ${ownerLine ? ownerLine.replace('<p>', '<span>').replace('</p>', '</span>') : ''}
  </div>
  ${showEditor ? `
  <div id="collab-status">connecting…</div>
  <div id="presence-bar">
    <span id="presence-list"></span>
    <span id="name-edit">You: <input id="my-name" type="text" maxlength="30" placeholder="your name"><button id="name-set">Set</button></span>
  </div>
  ${isEditable ? `
  <div id="format-toolbar">
    <button data-cmd="bold"><strong>B</strong></button>
    <button data-cmd="italic"><em>I</em></button>
    <button data-cmd="strike"><s>S</s></button>
    <div class="sep"></div>
    <button data-cmd="h1">H1</button>
    <button data-cmd="h2">H2</button>
    <div class="sep"></div>
    <button data-cmd="bullet">• List</button>
    <button data-cmd="ordered">1. List</button>
    <button data-cmd="blockquote">❝</button>
    <div class="sep"></div>
    <button data-cmd="link">Link</button>
  </div>
  <div id="link-bar" style="display:none;align-items:center;gap:5px;padding:4px 8px;border:1px solid #ddd;border-top:none;border-bottom:none;background:#f9f9f9">
    <input id="link-url" type="url" placeholder="https://…" style="flex:1;padding:2px 6px;border:1px solid #ccc;border-radius:3px;font-size:0.82em">
    <button id="link-apply" style="padding:2px 8px;font-size:0.82em;border:1px solid #ccc;border-radius:3px;background:#fff;cursor:pointer">Apply</button>
    <button id="link-remove" style="padding:2px 8px;font-size:0.82em;border:1px solid #ccc;border-radius:3px;background:#fff;cursor:pointer">Remove</button>
    <button id="link-cancel" style="padding:2px 8px;font-size:0.82em;border:1px solid #ccc;border-radius:3px;background:#fff;cursor:pointer">✕</button>
    <span id="link-err" style="font-size:0.8em;color:#c00;display:none">https:// links only</span>
  </div>` : ''}
  <div id="editor-area"><div id="tiptap-editor"></div></div>
  <script type="module" nonce="${nonce}">
    import { Editor }        from 'https://esm.sh/@tiptap/core@2'
    import StarterKit        from 'https://esm.sh/@tiptap/starter-kit@2'
    import Collaboration     from 'https://esm.sh/@tiptap/extension-collaboration@2'
    import Link              from 'https://esm.sh/@tiptap/extension-link@2'
    import { HocuspocusProvider } from 'https://esm.sh/@hocuspocus/provider@2'
    import * as Y            from 'https://esm.sh/yjs@13'

    const w1 = ['cat','crow','dawn','dusk','fox','frost','gold','jade','lake','moon','oak','pine','rain','reef','rose','sage','star','sun','tree','wolf']
    const w2 = ['brook','burn','crest','fall','field','gate','hill','house','land','light','ridge','rise','side','stone','vale','watch','way','wood','croft','moor']
    const _hashUser = new URLSearchParams(location.hash.replace(/^#/, '')).get('user')
    let myName  = (_hashUser && _hashUser.trim()) || w1[Math.random() * w1.length | 0] + w2[Math.random() * w2.length | 0]
    const HUES  = ['#e06c75','#98c379','#e5c07b','#61afef','#c678dd','#56b6c2','#d19a66','#be5046']
    const myColor = HUES[Math.floor(Math.random() * HUES.length)]
    const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')

    const ydoc = new Y.Doc()
    const provider = new HocuspocusProvider({
      url:        ${scriptJson(SERVER_WS_URL)},
      name:       ${scriptJson(id)},
      document:   ydoc,
      token:      'anonymous',
      parameters: ${isEditable ? '{}' : '{ mode: "read" }'},
      onStatus: ({ status }) => {
        const s = document.getElementById('collab-status')
        if (s) s.textContent = status
      },
      onAuthenticationFailed: () => {
        const s = document.getElementById('collab-status')
        if (s) s.textContent = 'Authentication required — this document is not publicly accessible.'
      },
    })

    const myId = provider.awareness.clientID
    provider.awareness.setLocalStateField('user', { name: myName, color: myColor })
    document.getElementById('my-name').value = myName

    function renderPresence() {
      const list = document.getElementById('presence-list')
      if (!list) return
      list.textContent = ''
      const entries = [...provider.awareness.getStates().entries()].filter(([, s]) => s.user)
      if (!entries.length) {
        const none = document.createElement('span')
        none.style.color = '#aaa'
        none.textContent = 'no one else here yet'
        list.appendChild(none)
        return
      }
      entries.forEach(([uid, s], i) => {
        if (i > 0) list.appendChild(document.createTextNode(' '))
        const safeColor = /^#[0-9a-f]{3,6}$/i.test(s.user.color || '') ? s.user.color : '#888888'
        const span = document.createElement('span')
        span.className = 'presence-dot' + (uid === myId ? ' is-me' : '')
        span.style.background = safeColor
        span.textContent = s.user.name || 'Anonymous'
        list.appendChild(span)
      })
    }
    provider.awareness.on('change', renderPresence)
    provider.on('connect', renderPresence)

    function applyName(raw) {
      const name = raw.trim()
      if (!name) return
      myName = name
      provider.awareness.setLocalStateField('user', { name: myName, color: myColor })
    }
    const nameInput = document.getElementById('my-name')
    document.getElementById('name-set').addEventListener('click', () => applyName(nameInput.value))
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyName(nameInput.value) })

    const editor = new Editor({
      element:    document.getElementById('tiptap-editor'),
      editable:   ${isEditable},
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc }),
        Link.configure({ openOnClick: ${isEditable ? 'false' : 'true'}, validate: href => /^https?:\/\//i.test(href) }),
      ],
    })
    ${isEditable ? `
    function updateToolbar() {
      document.querySelectorAll('#format-toolbar button').forEach(btn => {
        const c = btn.dataset.cmd
        const active =
          c === 'bold'       ? editor.isActive('bold') :
          c === 'italic'     ? editor.isActive('italic') :
          c === 'strike'     ? editor.isActive('strike') :
          c === 'h1'         ? editor.isActive('heading', { level: 1 }) :
          c === 'h2'         ? editor.isActive('heading', { level: 2 }) :
          c === 'bullet'     ? editor.isActive('bulletList') :
          c === 'ordered'    ? editor.isActive('orderedList') :
          c === 'blockquote' ? editor.isActive('blockquote') :
          c === 'link'       ? editor.isActive('link') : false
        btn.classList.toggle('is-active', active)
      })
    }
    editor.on('selectionUpdate', updateToolbar)
    editor.on('transaction', updateToolbar)
    document.querySelectorAll('#format-toolbar button').forEach(btn => {
      btn.addEventListener('mousedown', e => {
        e.preventDefault()
        const c = btn.dataset.cmd
        if      (c === 'bold')       editor.chain().focus().toggleBold().run()
        else if (c === 'italic')     editor.chain().focus().toggleItalic().run()
        else if (c === 'strike')     editor.chain().focus().toggleStrike().run()
        else if (c === 'h1')         editor.chain().focus().toggleHeading({ level: 1 }).run()
        else if (c === 'h2')         editor.chain().focus().toggleHeading({ level: 2 }).run()
        else if (c === 'bullet')     editor.chain().focus().toggleBulletList().run()
        else if (c === 'ordered')    editor.chain().focus().toggleOrderedList().run()
        else if (c === 'blockquote') editor.chain().focus().toggleBlockquote().run()
        else if (c === 'link') {
          const bar = document.getElementById('link-bar')
          const inp = document.getElementById('link-url')
          inp.value = editor.getAttributes('link').href || ''
          inp.style.borderColor = '#ccc'
          document.getElementById('link-err').style.display = 'none'
          bar.style.display = 'flex'
          inp.focus(); inp.select()
        }
      })
    })
    function applyLinkBar() {
      const inp = document.getElementById('link-url')
      const url = inp.value.trim()
      if (url === '') {
        editor.chain().focus().unsetLink().run()
        document.getElementById('link-bar').style.display = 'none'
      } else if (/^https?:\/\//i.test(url)) {
        editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
        document.getElementById('link-bar').style.display = 'none'
      } else {
        inp.style.borderColor = '#c00'
        document.getElementById('link-err').style.display = 'inline'
      }
    }
    document.getElementById('link-apply').addEventListener('click', applyLinkBar)
    document.getElementById('link-remove').addEventListener('click', () => {
      editor.chain().focus().unsetLink().run()
      document.getElementById('link-bar').style.display = 'none'
    })
    document.getElementById('link-cancel').addEventListener('click', () => {
      document.getElementById('link-bar').style.display = 'none'
    })
    document.getElementById('link-url').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); applyLinkBar() }
      if (e.key === 'Escape') document.getElementById('link-bar').style.display = 'none'
    })` : ''}
  </script>` : `
  <p class="note">To open this document, paste the link above into a CList collab panel.</p>`}
</body>
</html>`)
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json', ...cors })
      response.end(JSON.stringify({
        id: doc.id, title: doc.title, allow_anonymous: doc.allow_anonymous,
        owner: ownerDisplay, server: SERVER_WS_URL, mode,
      }))
    }
    return
  }

  // GET /api/documents/:id — fetch document metadata (not Yjs content).
  if (method === 'GET' && url.pathname.startsWith('/api/documents/')) {
    const id  = decodeURIComponent(url.pathname.replace('/api/documents/', ''))
    const doc = db
      .prepare(`SELECT id, title, allow_anonymous, created_at, updated_at, expires_at
                FROM documents WHERE id = ?`)
      .get(id)
    if (!doc) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(doc))
    return
  }

  // PATCH /api/documents/:id — update allow_anonymous or title.
  if (method === 'PATCH' && url.pathname.startsWith('/api/documents/')) {
    const authHeader = request.headers['authorization'] || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    const clientKvUrl   = url.searchParams.get('kvstoreUrl') || null
    const effectiveKvUrl = clientKvUrl || process.env.KVSTORE_URL || 'http://kvstore:5000'
    const patchUsername = await verifyToken(token, effectiveKvUrl)
    if (!token || !patchUsername) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const id = decodeURIComponent(url.pathname.replace('/api/documents/', ''))
    // Ownership check: resolve the caller's namespace and compare to the stored owner.
    const didInfo   = await resolveUserDid(patchUsername, effectiveKvUrl)
    const namespace = didInfo?.didKey || didInfo?.didWeb
      || `${patchUsername}@${kvHostShort(effectiveKvUrl)}`
    const doc = db.prepare('SELECT owner FROM documents WHERE id = ?').get(id)
    if (!doc) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'document not found' }))
      return
    }
    if (doc.owner && doc.owner !== namespace) {
      response.writeHead(403, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'forbidden' }))
      return
    }
    let body
    try { body = await readBody(request) } catch (e) {
      response.writeHead(413, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: e.message }))
      return
    }
    try {
      const updates = JSON.parse(body)
      const setClauses = []
      const params = []
      if (updates.allow_anonymous !== undefined) {
        setClauses.push('allow_anonymous = ?')
        params.push(updates.allow_anonymous ? 1 : 0)
      }
      if (updates.title !== undefined) {
        setClauses.push('title = ?')
        params.push(String(updates.title).slice(0, 500))
      }
      if (!setClauses.length) throw new Error('No updatable fields provided')
      setClauses.push('updated_at = unixepoch()')
      params.push(id)
      const result = db.prepare(
        `UPDATE documents SET ${setClauses.join(', ')} WHERE id = ?`
      ).run(...params)
      if (result.changes === 0) {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'document not found' }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id }))
    } catch (e) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // Unrecognised route.
  response.writeHead(404, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: 'not found' }))
}
