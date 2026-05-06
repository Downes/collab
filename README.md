# collab

Real-time collaborative document editing server for [CList](https://github.com/Downes/CList).

Built on [Hocuspocus v2](https://tiptap.dev/docs/hocuspocus/introduction) (a Yjs WebSocket server) with SQLite persistence. The client side uses TipTap with the Collaboration extension.

---

## How it works

Clients connect over WebSocket using `HocuspocusProvider`. Each document is identified by a namespaced ID (see [Document namespacing](#document-namespacing) below). The server:

1. Authenticates the connection by verifying the client's Bearer token against a [kvstore](https://github.com/Downes/kvstore) instance.
2. Resolves the user's DID to determine their document namespace.
3. Loads any persisted Yjs state from SQLite and applies it to the shared document.
4. Streams real-time updates between all connected clients using the Yjs CRDT protocol.
5. Persists the merged Yjs state back to SQLite after each change.

---

## Document namespacing

Every document ID is prefixed with the owner's identity namespace to prevent collisions between users — including users from different kvstore instances.

The namespace is resolved in this priority order:

1. **`did:key:...`** — derived from the user's Ed25519 keypair. Portable across kvstore migrations; this is the preferred form.
2. **`did:web:...`** — tied to a specific kvstore URL. Used as fallback if no `did:key` is available.
3. **`username@kvhost`** — e.g. `stephen@mooc.ca`. Last resort for accounts without a DID.

A document ID looks like: `did:key:z6Mk.../my-notes`

Only the namespace owner can *create* a document in their namespace. Anyone with the link can *join* an existing document.

---

## Auth

WebSocket connections and REST API calls authenticate via Bearer token. The token is issued by [kvstore](https://github.com/Downes/kvstore) on login.

The server verifies tokens by calling `GET /auth/verify` on the configured kvstore instance. Clients may specify a different kvstore URL in the WebSocket connection parameters (`kvstoreUrl`), allowing users from any compatible kvstore to collaborate on the same server.

Documents can optionally allow anonymous (unauthenticated) read access by setting `allow_anonymous = 1`.

---

## File structure

| File | Purpose |
|------|---------|
| `server.js` | Entry point. Hocuspocus configuration and WebSocket hooks (`onAuthenticate`, `onLoadDocument`, `onStoreDocument`). |
| `db.js` | SQLite database initialization and schema migrations. Exports the `db` instance. |
| `auth.js` | Token verification (`verifyToken`), DID resolution (`resolveUserDid`), and kvstore host utilities. |
| `api.js` | HTTP request handler for the REST API and share-link pages. |

---

## REST API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | none | Health check — returns `{"ok":true}` |
| `POST` | `/api/register` | Bearer | Register a user; resolves and caches their DID from kvstore |
| `GET` | `/api/documents` | Bearer | List all documents, newest first |
| `POST` | `/api/documents` | Bearer | Pre-create a document record (to set title, expiry, or anonymous access before first connection) |
| `GET` | `/api/documents/:id` | Bearer | Fetch document metadata |
| `PATCH` | `/api/documents/:id` | Bearer | Update `title` or `allow_anonymous` |
| `GET` | `/doc/:id/edit` | none | Share page for co-edit link (HTML for browsers, JSON for API clients) |
| `GET` | `/doc/:id/read` | none | Share page for read-only link |
| `WS` | `/` | token | Hocuspocus WebSocket endpoint |

Document IDs containing `/` (namespaced IDs) must be URL-encoded per segment — e.g. `did%3Akey%3Az6Mk.../my-notes` — so the `/` between namespace and slug remains a real path separator while `:` characters are encoded.

---

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `KVSTORE_URL` | `http://kvstore:5000` | kvstore base URL for token verification and DID resolution |
| `DATA_DIR` | `/data` | Directory for the SQLite database |
| `PORT` | `3003` | HTTP/WebSocket listen port |
| `SERVER_WS_URL` | `wss://collab.mooc.ca` | Public WebSocket URL, used to generate share links |

---

## Database

SQLite at `$DATA_DIR/collab.db`.

**`documents` table**

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Namespaced document ID |
| `title` | TEXT | Human-readable title |
| `data` | BLOB | Serialized Yjs state vector |
| `owner` | TEXT | Namespace of the creator (DID or `username@kvhost`) |
| `allow_anonymous` | INTEGER | 1 = anonymous read access permitted |
| `created_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Unix timestamp |
| `expires_at` | INTEGER | Unix timestamp, NULL = permanent |

**`users` table**

| Column | Type | Notes |
|--------|------|-------|
| `did_key` | TEXT PK | Portable `did:key:...` identifier |
| `did_web` | TEXT | `did:web:...` tied to a kvstore URL |
| `username` | TEXT | Username on the kvstore instance |
| `kvhost` | TEXT | Short kvstore hostname (e.g. `mooc.ca`) |
| `registered_at` | INTEGER | Unix timestamp |

---

## Deployment

The server runs in Docker, proxied by Caddy.

```bash
# Build and start
cd /srv/apps/collab
docker compose up -d --build

# View logs
docker logs collab

# Health check
curl https://collab.mooc.ca/health
```

The `data/` directory is bind-mounted from the host, so the SQLite database persists across container rebuilds.

---

## Related projects

- [CList](https://github.com/Downes/CList) — the client-side app that uses this server (`js/collab.js`)
- [kvstore](https://github.com/Downes/kvstore) — credential store that handles authentication
