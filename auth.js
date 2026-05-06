const KVSTORE_URL = process.env.KVSTORE_URL || 'http://kvstore:5000'

// Fetch the user's DID document and return { didKey, didWeb }, or null if none exists.
// didKey (did:key:...) is portable across kvstore migrations.
// didWeb (did:web:...) is tied to the current kvstore instance.
export async function resolveUserDid(username, kvstoreUrl = KVSTORE_URL) {
  try {
    const res = await fetch(`${kvstoreUrl}/users/${username}/did.json`)
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
// kvstoreUrl defaults to the server's own KVSTORE_URL env var; pass an explicit
// value to support users authenticating against a different kvstore instance.
export async function verifyToken(token, kvstoreUrl = KVSTORE_URL) {
  // Only accept HTTPS (or the default env-var URL which may be internal http://).
  if (kvstoreUrl !== KVSTORE_URL) {
    try { if (new URL(kvstoreUrl).protocol !== 'https:') return null } catch { return null }
  }
  try {
    const res = await fetch(`${kvstoreUrl}/auth/verify`, {
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
  try {
    const host = new URL(kvstoreUrl).hostname
    return host.startsWith('kvstore.') ? host.slice('kvstore.'.length) : host
  } catch {
    return new URL(KVSTORE_URL).hostname
  }
}

// Reverse of kvHostShort: given a short-host, return the full kvstore base URL.
export function shortHostToKvUrl(shortHost) {
  const dots = (shortHost.match(/\./g) || []).length
  const host = dots === 1 ? `kvstore.${shortHost}` : shortHost
  return `https://${host}`
}
