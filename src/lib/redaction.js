// Share-safe payload redaction. Used by TraceViewer (display preview) and
// by debug-report export. Pure functions, no side effects.
//
// Each category has a `regex` (or array) that finds matches in plain text and
// a `replace` that produces a safe substitute keeping enough shape to debug.

export const REDACTION_CATEGORIES = [
  {
    key: 'credentials',
    label: 'Passwords & auth headers',
    patterns: [
      // Authorization: Bearer …  /  Basic …
      { re: /(Authorization\s*[:=]\s*)(Bearer|Basic|Negotiate)\s+\S+/gi, sub: '$1$2 ***REDACTED***' },
      // API keys in headers (x-api-key, apikey, x-rapidapi-key)
      { re: /((?:x-)?api[_-]?key\s*[:=]\s*)["']?[A-Za-z0-9._\-]{8,}["']?/gi, sub: '$1***REDACTED***' },
      // password/passwd JSON or query fields
      { re: /("(?:password|passwd|pwd|client_secret|clientSecret|secret)"\s*:\s*")[^"]+(")/gi, sub: '$1***REDACTED***$2' },
      { re: /(\b(?:password|passwd|pwd|client_secret|secret)=)[^&\s"]+/gi, sub: '$1***REDACTED***' },
    ],
  },
  {
    key: 'tokens',
    label: 'Bearer tokens & long secrets',
    patterns: [
      // JWT-looking tokens
      { re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, sub: '***JWT_REDACTED***' },
      // Long opaque tokens (40+ base64-ish)
      { re: /\b[A-Za-z0-9+/=_-]{40,}\b/g, sub: '***LONG_TOKEN_REDACTED***' },
    ],
  },
  {
    key: 'cookies',
    label: 'Cookies & session IDs',
    patterns: [
      { re: /(Cookie\s*[:=]\s*)[^\n\r]+/gi, sub: '$1***REDACTED***' },
      { re: /(Set-Cookie\s*[:=]\s*)[^\n\r]+/gi, sub: '$1***REDACTED***' },
      { re: /(JSESSIONID|SAPSESSIONID[^=]*|PHPSESSID|connect\.sid)=[^;\s]+/gi, sub: '$1=***REDACTED***' },
    ],
  },
  {
    key: 'emails',
    label: 'Email addresses',
    patterns: [
      { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, sub: '***EMAIL***' },
    ],
  },
  {
    key: 'hostnames',
    label: 'Hostnames & tenant URLs',
    patterns: [
      // Full URLs: keep scheme + host shape but mask actual host
      { re: /(https?:\/\/)([A-Za-z0-9.-]+)(\.hana\.ondemand\.com)/g, sub: '$1***TENANT***$3' },
      { re: /(https?:\/\/)([A-Za-z0-9.-]+)(\.sap\.com)/g,            sub: '$1***HOST***$3' },
    ],
  },
  {
    key: 'clientIds',
    label: 'BTP client IDs',
    patterns: [
      // sb-xxxx-...!b12345  (BTP service-key clientid shape)
      { re: /sb-[A-Za-z0-9._-]+![bp]\d+/g, sub: '***CLIENT_ID***' },
    ],
  },
]

export function redactPayload(text, enabledCats) {
  if (!text || typeof text !== 'string') return text
  let out = text
  for (const cat of REDACTION_CATEGORIES) {
    if (!enabledCats?.[cat.key]) continue
    for (const p of cat.patterns) out = out.replace(p.re, p.sub)
  }
  return out
}
