# collab

Collaborative editing server for CList, powered by Hocuspocus (Yjs) and SQLite.

## Stack
- Node.js 20 / Hocuspocus v2
- SQLite via better-sqlite3
- Yjs CRDT for conflict-free real-time sync
- Auth delegated to kvstore `/auth/verify` (same pattern as discussions, proxyp)

## Container
| Name   | Port | Network |
|--------|------|---------|
| collab | 3003 | web     |

## Domain
`collab.mooc.ca` — LIVE

## Auth
WebSocket connections pass a kvstore Bearer token via `HocuspocusProvider({ token: '...' })`.
Documents flagged `allow_anonymous=1` permit unauthenticated (read-only) connections.

## Document ID conventions
- Namespaced (preferred): `{username}/{slug}` — only the namespace owner may CREATE it; anyone may JOIN
- Legacy flat IDs are still accepted for backward compatibility
- Client auto-namespaces bare IDs: typing `my-notes` → `alice/my-notes` on Join/Create

## Environment
| Variable        | Default             | Purpose                      |
|-----------------|---------------------|------------------------------|
| KVSTORE_URL     | http://kvstore:5000 | Default kvstore auth verify endpoint (overridable at runtime, see Admin settings) |
| DATA_DIR        | /data               | SQLite database directory    |
| PORT            | 3003                | Listen port                  |
| ADMIN_USERNAMES | (none)              | Comma-separated usernames allowed to use `/admin/settings` |

## API
| Method | Path                | Auth     | Description                        |
|--------|---------------------|----------|------------------------------------|
| GET    | /health             | none     | Health check                       |
| POST   | /api/register       | Bearer   | Register user (stores username+DID) |
| GET    | /api/documents      | Bearer   | List all documents (newest first)  |
| POST   | /api/documents      | Bearer   | Create document record             |
| GET    | /api/documents/{id} | Bearer   | Get document metadata              |
| PATCH  | /api/documents/{id} | Bearer   | Update title or allow_anonymous    |
| GET    | /doc/{id}/edit      | none     | HTML share page (or JSON for API)  |
| GET    | /doc/{id}/read      | none     | HTML share page (read-only mode)   |
| WS     | /                   | token    | Hocuspocus WebSocket endpoint      |
| GET/PUT | /admin/settings    | Bearer, admin | Generic admin-editable settings pattern (see below) |

## Admin settings

Implements the generic admin-editable settings pattern (see `/srv/shared/admin_settings_node.js`
for the canonical reference copy — this app's `admin_settings.js` is a verbatim copy, since each
app keeps its own copy rather than importing a shared package across containers). This is the
Node + better-sqlite3 + manual-`http`-routing variant: `handleAdminSettingsRoutes({...})` is called
inline from `api.js`'s existing if-chain dispatcher (`handleRequest`), not registered on a
framework router, since collab has none.

Settings are stored in the `app_settings` SQLite table (`CREATE TABLE IF NOT EXISTS`, created by
`initSettingsTable(db)` in `db.js`). An admin (username in `ADMIN_USERNAMES`) can `GET`/`PUT`
`/admin/settings` with a Bearer token verified against the default kvstore instance.

Current fields:
- `ENABLED` (boolean, default `true`) — kill switch for the HTTP API. Checked as the first
  thing in `api.js`'s `handleRequest` after the `/health` check, before every other route
  except `/admin/settings`; when `false`, returns `503 {"error": "Service temporarily disabled
  by administrator"}`.
- `WS_ENABLED` (boolean, default `true`) — separate kill switch for the real-time editing
  WebSocket (Hocuspocus) protocol, independent of `ENABLED`. Checked in `server.js`'s
  `onAuthenticate`; when `false`, new connection attempts are rejected (`throw new Error(...)`,
  which Hocuspocus surfaces to the client as an auth failure). Existing open editing sessions
  are not forcibly dropped — only new connection attempts are gated.
- `KVSTORE_URL` (text, not sensitive) — the default kvstore instance used to verify a client's
  Bearer token when the client doesn't supply its own `kvstoreUrl`. Falls back to the
  `KVSTORE_URL` env var if no override has been saved; reads happen at point of use via
  `getSetting(db, "KVSTORE_URL", ...)`, so a saved override takes effect immediately, no restart.

**Important security note (pre-existing, not changed by this feature):** collab's `verifyToken`/
`resolveUserDid` (`auth.js`) already accept an arbitrary **client-supplied** `kvstoreUrl` per
request (via a `?kvstoreUrl=` query param, or a WS connection parameter), with only an HTTPS-
protocol check applied to that explicit value — unlike `annotations`/`opml2json`, there is no
domain allowlist here. This means the `KVSTORE_URL` admin setting above is **not a security
boundary** — it only changes the *default* used when a client doesn't supply its own `kvstoreUrl`.
Lower severity since it's the client's own token being forwarded to a server of the client's own
choosing, but worth tightening to an allowlist if this app's auth model is revisited.

## Database
SQLite at `$DATA_DIR/collab.db` — `documents` table:
- `id` TEXT PRIMARY KEY
- `title` TEXT
- `data` BLOB (Yjs binary state, updated by Hocuspocus after each change)
- `created_at`, `updated_at` INTEGER (Unix timestamps)
- `allow_anonymous` INTEGER (0/1)
- `expires_at` INTEGER (NULL = permanent)
- `owner` TEXT (username of creator; NULL for legacy docs)

Also: `users` table — `username`, `did`, `registered_at`

## Rebuild
```bash
cd /srv/apps/collab
docker compose up -d --build
```
