// Node/better-sqlite3 + manual http routing variant of the generic
// admin-settings module (reference copy — never mounted or imported at
// runtime). Each adopting app keeps its own verbatim copy; when you change
// this file, copy the change into every adopting app's copy by hand.
//
// Differences from the other variants:
//   - /srv/shared/admin_settings.py          — Flask + sqlite3 (sync, cached g.db)
//   - /srv/shared/admin_settings_fastapi.py  — FastAPI + aiosqlite (async, Depends())
//   - /srv/shared/admin_settings_redis.py    — FastAPI + Redis (async, manual headers)
//   - this file                               — Node + better-sqlite3 (sync db calls,
//     no framework — the adopting app dispatches routes itself via a manual
//     if-chain, not Express, so this exports a handler the app calls inline)
//
// Contract:
//   new SettingField(key, label, type, sensitive, validate, help)
//     - type in {"text", "url", "secret", "boolean"}
//     - "boolean" values are stored/transmitted as the literal strings
//       "true"/"false" (same TEXT column as everything else) — the CList
//       renderer draws a checkbox for this type and the app treats the
//       string "false" as off, anything else as on.
//     - validate: optional (value: string) => string|null (error message, or null if valid)
//   initSettingsTable(db)                     — CREATE TABLE IF NOT EXISTS, call once at startup
//   getSetting(db, key, default_ = null)      — call at point of use, every call, never cached
//   isAdmin(username)                          — username in ADMIN_USERNAMES (parsed once from env)
//   await handleAdminSettingsRoutes({ method, url, request, response, db, schema, requireAdmin, defaults })
//     — returns true if it handled the request (GET/PUT /admin/settings), false otherwise.
//     `requireAdmin` is an async (request) => { username, err } where err is
//     null or { status, body }, matching this app's existing manual
//     Authorization-header-parsing style.
//
// Adopting an app:
//   1. Copy this file into the app directory verbatim.
//   2. Add it to the Dockerfile's explicit COPY line if one exists (see
//      localrss_reader's CLAUDE.md for the crash-loop this causes if missed).
//   3. Call initSettingsTable(db) once at startup.
//   4. Declare SETTINGS_SCHEMA and an async requireAdmin(request) helper.
//   5. Call `if (await handleAdminSettingsRoutes({...})) return` from the
//      app's existing request-dispatch chain, before its final 404 fallback.
//   6. Replace frozen constant reads at their point of use with
//      getSetting(db, "KEY", process.env.KEY || "...").
//   7. Add ADMIN_USERNAMES=<comma-separated usernames> to docker-compose.yml.
//   8. Update that app's CLAUDE.md: new env var, new /admin/settings
//      endpoints, DB-override-falls-back-to-env precedence.

const SETTINGS_TABLE = 'app_settings'
const BODY_LIMIT = 65536 // 64 KB — plenty for a settings PUT payload

export class SettingField {
  constructor(key, label, type, sensitive, validate = null, help = null) {
    this.key = key
    this.label = label
    this.type = type
    this.sensitive = sensitive
    this.validate = validate
    this.help = help
  }
}

const ADMIN_USERNAMES = new Set(
  (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim()).filter(Boolean)
)

export function isAdmin(username) {
  return !!username && ADMIN_USERNAMES.has(username)
}

export function initSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
}

export function getSetting(db, key, default_ = null) {
  const row = db.prepare(`SELECT value FROM ${SETTINGS_TABLE} WHERE key = ?`).get(key)
  return (row && row.value) ? row.value : default_
}

function setSettings(db, data) {
  const stmt = db.prepare(`
    INSERT INTO ${SETTINGS_TABLE} (key, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)
  const txn = db.transaction(entries => {
    for (const [k, v] of entries) stmt.run(k, v)
  })
  txn(Object.entries(data))
}

function mask(value) {
  // Fixed-length mask regardless of real length, so the mask itself never
  // leaks how long the underlying secret is.
  if (!value) return null
  return '•'.repeat(8) + value.slice(-4)
}

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

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

export async function handleAdminSettingsRoutes({ method, url, request, response, db, schema, requireAdmin, defaults = {} }) {
  if (url.pathname !== '/admin/settings') return false
  if (method !== 'GET' && method !== 'PUT') return false

  const { err } = await requireAdmin(request)
  if (err) {
    sendJson(response, err.status, err.body)
    return true
  }

  const schemaByKey = new Map(schema.map(f => [f.key, f]))

  const schemaJson = () => schema.map(f => ({
    key: f.key, label: f.label, type: f.type, sensitive: f.sensitive, help: f.help,
  }))
  const maskedValues = () => {
    const out = {}
    for (const f of schema) {
      const raw = getSetting(db, f.key, defaults[f.key] ?? null)
      out[f.key] = f.sensitive ? mask(raw) : raw
    }
    return out
  }

  if (method === 'GET') {
    sendJson(response, 200, { schema: schemaJson(), values: maskedValues() })
    return true
  }

  // PUT — validate-then-write: nothing is persisted unless every key in the
  // request passes, so a partial PUT never leaves settings half-applied.
  let body
  try {
    body = await readBody(request)
  } catch (e) {
    sendJson(response, 413, { error: e.message })
    return true
  }
  let data
  try {
    data = JSON.parse(body)
  } catch {
    sendJson(response, 400, { error: 'Invalid JSON body' })
    return true
  }
  for (const key of Object.keys(data)) {
    if (!schemaByKey.has(key)) {
      sendJson(response, 400, { error: `Unknown setting: ${key}` })
      return true
    }
  }
  for (const [key, value] of Object.entries(data)) {
    const field = schemaByKey.get(key)
    if (field.validate) {
      const error = field.validate(value)
      if (error) {
        sendJson(response, 400, { error: `${key}: ${error}` })
        return true
      }
    }
  }
  setSettings(db, data)
  sendJson(response, 200, { schema: schemaJson(), values: maskedValues() })
  return true
}
