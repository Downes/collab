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
| Variable     | Default             | Purpose                      |
|--------------|---------------------|------------------------------|
| KVSTORE_URL  | http://kvstore:5000 | kvstore auth verify endpoint |
| DATA_DIR     | /data               | SQLite database directory    |
| PORT         | 3003                | Listen port                  |

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
