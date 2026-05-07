import { Server } from '@hocuspocus/server'
import * as Y from 'yjs'
import { db } from './db.js'
import { verifyToken, resolveUserDid, kvHostShort } from './auth.js'
import { handleRequest } from './api.js'

const PORT        = parseInt(process.env.PORT || '3003')
const KVSTORE_URL = process.env.KVSTORE_URL   || 'http://kvstore:5000'

const server = Server.configure({
  port: PORT,

  // Authenticate each WebSocket connection.
  // The client passes a token via HocuspocusProvider({ token: '...' }).
  // Anonymous access (no token or token='anonymous') is allowed only when
  // the document record has allow_anonymous=1.
  async onAuthenticate({ token, documentName, connection, requestParameters }) {
    if (requestParameters?.get('mode') === 'read') {
      connection.isReadOnly = true
    }
    if (!token || token === 'anonymous') {
      const doc = db
        .prepare('SELECT allow_anonymous FROM documents WHERE id = ?')
        .get(documentName)
      if (doc?.allow_anonymous) return
      throw new Error('Authentication required')
    }
    // Client may pass kvstoreUrl so users from any kvstore instance can authenticate.
    const clientKvUrl   = requestParameters?.get('kvstoreUrl') || null
    const effectiveKvUrl = clientKvUrl || KVSTORE_URL
    const username = await verifyToken(token, effectiveKvUrl)
    if (!username) throw new Error('Invalid token')

    // Resolve the user's portable DID (did:key preferred, did:web fallback,
    // username@kvhost as last resort).  did:key survives kvstore migrations.
    const didInfo  = await resolveUserDid(username, effectiveKvUrl)
    const namespace = didInfo?.didKey || didInfo?.didWeb
      || `${username}@${kvHostShort(effectiveKvUrl)}`

    // Cache the user's DID info locally so the share page can display it
    // without an extra kvstore round-trip.
    if (didInfo?.didKey) {
      db.prepare(`
        INSERT INTO users (did_key, did_web, username, kvhost, registered_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(did_key) DO UPDATE SET
          did_web = excluded.did_web,
          username = excluded.username,
          kvhost = excluded.kvhost,
          registered_at = unixepoch()
      `).run(didInfo.didKey, didInfo.didWeb || null, username, kvHostShort(effectiveKvUrl))
    }

    // Namespace validation: the part before the first '/' must match the
    // resolved namespace.  Joining an existing document owned by someone else
    // is always allowed; only CREATING in another's namespace is rejected.
    const slash = documentName.indexOf('/')
    if (slash !== -1) {
      const ns = documentName.slice(0, slash)
      if (ns !== namespace) {
        const exists = db.prepare('SELECT 1 FROM documents WHERE id = ?').get(documentName)
        if (!exists) throw new Error(`Cannot create document in namespace '${ns}'`)
      }
    }
    // Pre-create the document record so we can record the owner now.
    // INSERT OR IGNORE leaves existing records (and their owner) untouched.
    db.prepare(`INSERT OR IGNORE INTO documents (id, owner) VALUES (?, ?)`)
      .run(documentName, namespace)
  },

  // Load persisted Yjs state into the document on first connection.
  async onLoadDocument({ documentName, document }) {
    const row = db
      .prepare('SELECT data FROM documents WHERE id = ?')
      .get(documentName)
    if (row?.data) {
      try {
        Y.applyUpdate(document, row.data)
      } catch (e) {
        // Corrupt Yjs binary — log and serve empty document rather than crashing.
        console.error(`[collab] corrupt Yjs state for "${documentName}", serving empty document:`, e.message)
        db.prepare('UPDATE documents SET data = NULL WHERE id = ?').run(documentName)
      }
    }
    return document
  },

  // Persist Yjs state to SQLite after each change.
  async onStoreDocument({ documentName, document }) {
    try {
      const data = Buffer.from(Y.encodeStateAsUpdate(document))
      db.prepare(`
        INSERT INTO documents (id, data, updated_at)
        VALUES (?, ?, unixepoch())
        ON CONFLICT(id) DO UPDATE SET
          data       = excluded.data,
          updated_at = excluded.updated_at
      `).run(documentName, data)
    } catch (e) {
      console.error(`[collab] failed to store document "${documentName}":`, e.message)
    }
  },

  onRequest: handleRequest,
})

server.listen()
