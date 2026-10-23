import { db } from './db.js'
import { getSetting } from './admin_settings.js'

const KVSTORE_URL_ENV_DEFAULT = process.env.KVSTORE_URL || 'http://kvstore:5000'

// Resolves the current default kvstore instance: an admin override saved via
// /admin/settings takes effect immediately (no restart), falling back to the
// KVSTORE_URL env var if none has been saved.
function defaultKvstoreUrl() {
  return getSetting(db, 'KVSTORE_URL', KVSTORE_URL_ENV_DEFAULT)
}

// Resolve an explicit client-supplied kvstoreUrl (if any) against the current
// default. Use this for non-auth purposes (DID lookup, namespace display)
// where there's no https-only restriction to apply.
export function resolveKvstoreUrl(explicitUrl = null) {
  return explicitUrl || defaultKvstoreUrl()
}

// Fetch the user's DID document and return { didKey, didWeb }, or null if none exists.
// didKey (did:key:...) is portable across kvstore migrations.
// didWeb (did:web:...) is tied to the current kvstore instance.
export async function resolveUserDid(username, kvstoreUrl = null) {
  const effective = kvstoreUrl || defaultKvstoreUrl()
  try {
    const res = await fetch(`${effective}/users/${username}/did.json`)
    if (!res.ok) return null
    const doc = await res.json()
    const didWeb = doc.id || null
    const didKey = (Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : [])
      .find(id => typeof id === 'string' && id.startsWith('did:key:')) || null
    return (didKey || didWeb) ? { didKey, didWeb } : null
  } catch {
    return null
  }
}

// Returns the verified username, or null if the token is invalid.
// kvstoreUrl defaults to the server's current default (env var, or an admin
// override saved via /admin/settings); pass an explicit value to support
// users authenticating against a different kvstore instance.
export async function verifyToken(token, kvstoreUrl = null) {
  const explicit = kvstoreUrl != null
  const effective = explicit ? kvstoreUrl : defaultKvstoreUrl()
  // Only accept HTTPS for an explicit, client-chosen URL (the default may be
  // an internal http:// address, e.g. http://kvstore:5000).
  if (explicit) {
    try { if (new URL(effective).protocol !== 'https:') return null } catch { return null }
  }
  try {
    const res = await fetch(`${effective}/auth/verify`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.username || null
  } catch {
    return null
  }
}

// Derive the short-host identifier embedded in document namespaces.
// kvstore.mooc.ca  →  mooc.ca   (strip default 'kvstore.' prefix)
// accounts.mooc.ca →  accounts.mooc.ca  (non-default subdomain, keep as-is)
export function kvHostShort(kvstoreUrl) {
  const effective = kvstoreUrl || defaultKvstoreUrl()
  try {
    const host = new URL(effective).hostname
    return host.startsWith('kvstore.') ? host.slice('kvstore.'.length) : host
  } catch {
    return new URL(defaultKvstoreUrl()).hostname
  }
}

// Reverse of kvHostShort: given a short-host, return the full kvstore base URL.
export function shortHostToKvUrl(shortHost) {
  const dots = (shortHost.match(/\./g) || []).length
  const host = dots === 1 ? `kvstore.${shortHost}` : shortHost
  return `https://${host}`
}
