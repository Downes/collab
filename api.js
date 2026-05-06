import { db } from './db.js'
import { verifyToken, resolveUserDid, kvHostShort } from './auth.js'

const PORT          = parseInt(process.env.PORT  || '3003')
const SERVER_WS_URL = process.env.SERVER_WS_URL || 'wss://collab.mooc.ca'
const SERVER_HTTP_URL = SERVER_WS_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
    let body = ''
    await new Promise(resolve => {
      request.on('data', chunk => { body += chunk })
      request.on('end', resolve)
    })
    try {
      const { id, title, allow_anonymous, expires_in } = JSON.parse(body)
      if (!id) throw new Error('id is required')
      const expires_at = expires_in ? Math.floor(Date.now() / 1000) + expires_in : null
      db.prepare(`
        INSERT OR IGNORE INTO documents (id, title, allow_anonymous, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(id, title || '', allow_anonymous ? 1 : 0, expires_at)
      response.writeHead(201, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id }))
    } catch (e) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // GET /api/documents — list all documents (requires auth).
  if (method === 'GET' && url.pathname === '/api/documents') {
    const authHeader = request.headers['authorization'] || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!token || !(await verifyToken(token))) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const docs = db.prepare(
      `SELECT id, title, allow_anonymous, created_at, updated_at, expires_at
       FROM documents ORDER BY updated_at DESC`
    ).all()
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
      const title     = doc.title || doc.id
      const shareLink = `${SERVER_HTTP_URL}/doc/${id.split('/').map(encodeURIComponent).join('/')}/${mode}`
      const modeLabel = mode === 'read' ? 'Read-only' : 'Collaborative editing'
      const ownerLine = ownerDisplay
        ? (ownerDisplay.startsWith('did:')
            ? `<p><strong>Owner DID:</strong> <code>${esc(ownerDisplay)}</code></p>`
            : `<p><strong>Owner:</strong> ${esc(ownerDisplay)}</p>`)
        : ''
      const showEditor = !!doc.allow_anonymous
      const isEditable = doc.allow_anonymous && mode === 'edit'
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors })
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
    #editor-area { border: 1px solid #ddd; border-radius: 4px; background: ${isEditable ? '#fff' : '#fafafa'}; margin-top: 4px; }
    #editor-area .ProseMirror { outline: none; min-height: 240px; padding: 14px; color: #111; }
    #editor-area .ProseMirror p { margin: 0.5em 0; }
    #editor-area .ProseMirror h1 { font-size: 1.6em; margin: 0.8em 0 0.3em; }
    #editor-area .ProseMirror h2 { font-size: 1.3em; margin: 0.7em 0 0.3em; }
    #editor-area .ProseMirror ul, #editor-area .ProseMirror ol { padding-left: 1.5em; }
    #editor-area .ProseMirror blockquote { border-left: 3px solid #ccc; margin: 0.5em 0; padding-left: 1em; color: #555; }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="badge">${esc(modeLabel)}</div>
  ${ownerLine}
  <div class="link-row">
    <code id="share-link">${esc(shareLink)}</code>
    <button onclick="navigator.clipboard.writeText(document.getElementById('share-link').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>
  </div>
  ${showEditor ? `
  <div id="collab-status">connecting…</div>
  <div id="editor-area"><div id="tiptap-editor"></div></div>
  <script type="module">
    import { Editor }        from 'https://esm.sh/@tiptap/core@2'
    import StarterKit        from 'https://esm.sh/@tiptap/starter-kit@2'
    import Collaboration     from 'https://esm.sh/@tiptap/extension-collaboration@2'
    import { HocuspocusProvider } from 'https://esm.sh/@hocuspocus/provider@2'
    import * as Y            from 'https://esm.sh/yjs@13'
    const ydoc = new Y.Doc()
    const provider = new HocuspocusProvider({
      url:        ${JSON.stringify(SERVER_WS_URL)},
      name:       ${JSON.stringify(id)},
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
    new Editor({
      element:    document.getElementById('tiptap-editor'),
      editable:   ${isEditable},
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc }),
      ],
    })
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
    if (!token || !(await verifyToken(token))) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const id = decodeURIComponent(url.pathname.replace('/api/documents/', ''))
    let body = ''
    await new Promise(resolve => {
      request.on('data', chunk => { body += chunk })
      request.on('end', resolve)
    })
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
