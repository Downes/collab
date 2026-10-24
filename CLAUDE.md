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

- Token verification is local JWT/JWKS ("Pattern B"), hand-implemented in
  `auth.js` (`verifyIdentity()`) using the `jose` package — this app has no
  shared `clist-kvstore-auth` package import since it's the only Node app in
  the fleet; see the other apps' CLAUDE.md for the Python equivalent. A
  JWT's own `iss` claim names the kvstore instance that signed it; we fetch
  *that* instance's `/.well-known/jwks.json` and verify the ES256 signature
  — open to any issuer, no allowlist (anyone can run their own kvstore and
  interoperate). A client-supplied `kvstoreUrl` (query param or WS connection
  parameter) is never consulted for real JWTs — `iss` is tamper-proof and
  already says where to verify.
- Opaque (pre-migration) tokens carry no `iss` and can't be verified
  locally, so they fall back to the callback (`GET {KVSTORE_URL}/auth/verify`)
  — but *only* against this server's own default `KVSTORE_URL`. A client-
  supplied `kvstoreUrl` is no longer honored for this fallback (previously it
  was, with only an HTTPS-protocol check — see the removed security note
  below); opaque tokens predate federation entirely, so they could only ever
  have come from this server's own instance.
- Identity used for document ownership is qualified, not a bare username:
  `verifyIdentity()` returns `{ username, iss, qualifiedId }`, and
  `resolveNamespace()` picks did:key (preferred, portable across kvstore
  migrations) > did:web (tied to the current instance) > `qualifiedId`
  (`did:web:<host-from-iss>:users:<username>`, derived from the verified
  `iss`) as a last-resort fallback for users with no registered DID. This
  three-tier resolution already existed here before Pattern B (richer than
  most other apps); the fix was making the kvstore instance it's driven by
  come from the authenticated `iss`, not a client-supplied hint.
- Documents created before this migration stored owner as a bare
  `username@kvhost` fallback (no instance qualifier). `ownsDocument()` in
  `auth.js` accepts either the current qualifiedId shape or that legacy
  shape, so pre-migration documents stay editable by their original owner
  with no data migration needed.
- `/admin/settings` is additionally gated by a locally-reimplemented
  `isAdminIdentity(identity)` in `api.js`, not `admin_settings.js`'s own
  `isAdmin(username)` directly, because `KVSTORE_URL` is DB-overridable here
  (see Admin settings below) and `admin_settings.js`'s `isAdmin()` only
  checks the username, not which issuer vouched for it.

## Document ID conventions
- Namespaced (preferred): `{username}/{slug}` — only the namespace owner may CREATE it; anyone may JOIN
- Legacy flat IDs are still accepted for backward compatibility
- Client auto-namespaces bare IDs: typing `my-notes` → `alice/my-notes` on Join/Create

## Environment
| Variable        | Default             | Purpose                      |
|-----------------|---------------------|------------------------------|
| KVSTORE_URL     | https://kvstore.mooc.ca | This app's own kvstore instance — opaque-token fallback target and sole trusted admin issuer (overridable at runtime, see Admin settings). Must be the public HTTPS URL, not an internal Docker address — a verified JWT's `iss` is always the public URL. |
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
- `KVSTORE_URL` (text, not sensitive) — this app's own kvstore instance: the opaque-token
  fallback verification target, and the sole trusted admin issuer (see Auth above). Falls back to
  the `KVSTORE_URL` env var if no override has been saved; reads happen at point of use via
  `getSetting(db, "KVSTORE_URL", ...)`, so a saved override takes effect immediately, no restart.
  Caution: since this is also the trusted-admin-issuer, saving a bad value here can lock the
  admin out of `/admin/settings` itself (ordinary callers are unaffected — their JWT verification
  is open to any issuer regardless of this setting). Recovery doesn't need a restart — a direct
  SQLite write: `docker exec collab sqlite3 /data/collab.db "UPDATE app_settings SET value =
  'https://kvstore.mooc.ca' WHERE key = 'KVSTORE_URL'"` (adjust path/value for collab2).

**Security note (resolved by the Pattern B migration):** collab previously accepted an arbitrary
**client-supplied** `kvstoreUrl` per request (via a `?kvstoreUrl=` query param, or a WS connection
parameter) for token verification, with only an HTTPS-protocol check applied — unlike
`annotations`/`opml2json`, there was no domain allowlist. This is now closed: real JWTs are
verified against their own tamper-proof `iss` claim (open to any issuer by design, not a
client-supplied hint), and the opaque-token fallback only ever targets this app's own
`KVSTORE_URL` — a client-supplied `kvstoreUrl` is no longer read anywhere.

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
