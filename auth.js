import { db } from './db.js'
import { getSetting } from './admin_settings.js'
import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose'

const KVSTORE_URL_ENV_DEFAULT = process.env.KVSTORE_URL || 'https://kvstore.mooc.ca'

// Resolves the current default kvstore instance: an admin override saved via
// /admin/settings takes effect immediately (no restart), falling back to the
// KVSTORE_URL env var if none has been saved. Also the sole trusted admin
// issuer (see isAdminIdentity in api.js) and the opaque-token fallback
// target. Must be the kvstore instance's public HTTPS URL, not an internal
// Docker address — a verified JWT's `iss` claim is always the public URL
// (that's what it signs with and what /.well-known/jwks.json is served
// from), so comparing against an internal address would never match.
export function defaultKvstoreUrl() {
  return getSetting(db, 'KVSTORE_URL', KVSTORE_URL_ENV_DEFAULT)
}

function qualifiedId(iss, username) {
  return `did:web:${new URL(iss).hostname}:users:${username}`
}

// Fetch the user's DID document and return { didKey, didWeb }, or null if none exists.
// didKey (did:key:...) is portable across kvstore migrations.
// didWeb (did:web:...) is tied to the current kvstore instance.
export async function resolveUserDid(username, kvstoreUrl) {
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

// Derive the short-host identifier embedded in legacy document namespaces
// (the pre-migration `username@kvhost` fallback shape, see ownsDocument).
// kvstore.mooc.ca  →  mooc.ca   (strip default 'kvstore.' prefix)
// accounts.mooc.ca →  accounts.mooc.ca  (non-default subdomain, keep as-is)
export function kvHostShort(kvstoreUrl) {
  return new URL(kvstoreUrl).hostname.replace(/^kvstore\./, '')
}

const jwksCache = new Map() // iss -> createRemoteJWKSet(...), cached per issuer, no allowlist

function jwksFor(iss) {
  let jwks = jwksCache.get(iss)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${iss}/.well-known/jwks.json`))
    jwksCache.set(iss, jwks)
  }
  return jwks
}

// Verify a Bearer token and return { username, iss, qualifiedId }, or null
// if the token is invalid.
//
// Real JWTs: open federation, no allowlist. The token's own `iss` claim
// names the kvstore instance that signed it; we fetch *that* instance's
// /.well-known/jwks.json and verify the ES256 signature against it — any
// instance can interoperate, no pre-registration needed. A client-supplied
// kvstoreUrl hint is never consulted here — `iss` is tamper-proof and
// already says where to verify.
//
// Opaque (pre-migration) tokens carry no verifiable `iss`, so they can't be
// checked locally — fall back to the callback (`GET {iss}/auth/verify`),
// but only against this server's own default kvstore (defaultKvstoreUrl()).
// Opaque tokens predate federation entirely, so they could only ever have
// come from this server's own instance; no longer honoring a client-
// supplied kvstoreUrl for this path closes the unallowlisted SSRF/token-
// forwarding gap previously documented in CLAUDE.md.
export async function verifyIdentity(token) {
  if (!token) return null
  if (token.split('.').length === 3) {
    let iss
    try { iss = decodeJwt(token).iss } catch { return null }
    if (!iss) return null
    try {
      const { payload } = await jwtVerify(token, jwksFor(iss), { issuer: iss })
      if (!payload.sub) return null
      return { username: payload.sub, iss, qualifiedId: qualifiedId(iss, payload.sub) }
    } catch {
      return null
    }
  }
  const iss = defaultKvstoreUrl()
  try {
    const res = await fetch(`${iss}/auth/verify`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data.username) return null
    return { username: data.username, iss, qualifiedId: qualifiedId(iss, data.username) }
  } catch {
    return null
  }
}

// Resolve the namespace an identity's documents are stored/owned under:
// did:key (portable across kvstore migrations) preferred, did:web (tied to
// the current instance) next, qualifiedId (did:web:<host-from-iss>:users:
// <username>, derived from the verified iss) as the last-resort fallback for
// users with no registered DID.
export async function resolveNamespace(identity) {
  const didInfo = await resolveUserDid(identity.username, identity.iss)
  return didInfo?.didKey || didInfo?.didWeb || identity.qualifiedId
}

// Backward compatibility for documents created before this migration, whose
// owner column holds the old `username@kvhost` fallback shape (derived from
// whichever kvstoreUrl was in play at creation time, pre-federation) instead
// of a qualifiedId. did:key/did:web-owned rows need no special case — they're
// already covered by the exact-match check, since resolveNamespace() prefers
// the same DID an owning session would have resolved at creation time.
export function ownsDocument(storedOwner, identity, resolvedNamespace) {
  if (storedOwner === resolvedNamespace) return true
  return storedOwner === `${identity.username}@${kvHostShort(identity.iss)}`
}
