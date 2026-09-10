// Keys whose values should never appear in exports, logs, or debug output.
// Lookups strip `_ - space` before matching, so the set must be stored in the
// same normalized form — otherwise entries like 'x-api-key' can never match
// (the incoming 'X-API-Key' normalizes to 'xapikey', which wasn't in the set).
const normalizeKey = (k) => String(k).toLowerCase().replace(/[_\-\s]/g, '')

const SENSITIVE_KEYS = new Set([
  'password','passwd','secret','client_secret','clientsecret',
  'token','access_token','bearer','authorization','auth',
  'apikey','api_key','x-api-key','x-rapidapi-key',
  'private_key','privatekey','credential','credentials',
  'sessionid','cookie','set-cookie',
].map(normalizeKey))

const MASK = '***REDACTED***'

export function isSensitiveKey(key) {
  if (!key) return false
  return SENSITIVE_KEYS.has(normalizeKey(key))
}

/** Deep-redact an object — removes sensitive values in place (returns new object) */
export function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj
  if (Array.isArray(obj)) return obj.map(redact)
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      if (isSensitiveKey(k)) return [k, MASK]
      if (typeof v === 'object' && v !== null) return [k, redact(v)]
      return [k, v]
    })
  )
}

/** Redact a headers object for display */
export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {}
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) =>
      isSensitiveKey(k) ? [k, MASK] : [k, v]
    )
  )
}

/** Safe JSON stringify — removes sensitive keys */
export function safeStringify(obj, indent = 2) {
  return JSON.stringify(redact(obj), null, indent)
}
