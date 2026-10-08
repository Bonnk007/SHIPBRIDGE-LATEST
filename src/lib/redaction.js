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
      // Authorization / Proxy-Authorization, with or without a scheme, and
      // with or without the quoting a JSON-rendered header carries. The old
      // pattern required the scheme IMMEDIATELY after the separator, so
      // `"Authorization": "Bearer eyJ..."` did not match at all — the opening
      // quote blocked it — and that is exactly how a captured CPI header is
      // serialised. `Authorization: Token abc` was missed for the same reason.
      { re: /((?:Proxy-)?Authorization"?\s*[:=]\s*"?)(Bearer|Basic|Negotiate|Token|ApiKey)?\s*[^\s"',}\]]+/gi,
        sub: (_m, p1, scheme) => `${p1}${scheme ? scheme + ' ' : ''}***REDACTED***` },
      // API-key style headers, including the ones the server already blocks
      // outbound (x-api-key, apikey, x-rapidapi-key) plus CSRF and auth tokens.
      { re: /((?:x-)?(?:api[_-]?key|auth[_-]?token|csrf[_-]?token|access[_-]?token|refresh[_-]?token)"?\s*[:=]\s*)["']?[A-Za-z0-9._\-]{6,}["']?/gi,
        sub: '$1***REDACTED***' },
      // JSON object fields.
      { re: /("(?:password|passwd|pwd|passphrase|client_secret|clientSecret|apiSecret|secret|credential)"\s*:\s*")[^"]*(")/gi,
        sub: '$1***REDACTED***$2' },
      // Query-string / form-encoded fields.
      { re: /(\b(?:password|passwd|pwd|passphrase|client_secret|clientSecret|apiSecret|secret)=)[^&\s"]+/gi,
        sub: '$1***REDACTED***' },
      // XML elements — CPI payloads and iFlow config are full of these, and the
      // JSON-only pattern above never touched them.
      { re: /(<\s*([A-Za-z0-9_.:-]*(?:password|passwd|pwd|passphrase|secret|credential)[A-Za-z0-9_.:-]*)\s*(?:\s[^>]*)?>)[^<]*(<\/\s*\2\s*>)/gi,
        sub: '$1***REDACTED***$3' },
      // YAML / properties / plain `key: value` and `key = value` lines.
      { re: /^(\s*(?:password|passwd|pwd|passphrase|client_secret|clientSecret|apiSecret|secret)\s*[:=]\s*)(?!\s*$).+$/gim,
        sub: '$1***REDACTED***' },
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
      // The host part is written as unambiguous labels rather than
      // [A-Za-z0-9.-]+\. , which could backtrack quadratically on a crafted
      // non-matching string.
      { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, sub: '***EMAIL***' },
    ],
  },
  {
    key: 'hostnames',
    label: 'Hostnames & tenant URLs',
    patterns: [
      // Previously this masked only *.hana.ondemand.com and *.sap.com, which
      // is an allowlist of two domains rather than hostname redaction. It let
      // through my123456.s4hana.cloud.sap (S/4HANA Cloud — .cloud.sap is not
      // .sap.com), successfactors.com, ariba.com, sapcloud.cn, every
      // customer-owned domain, bare Host: headers and raw IPs.
      //
      // Named SAP domains first, so the mask says what kind of host it was.
      { re: /(https?:\/\/)([A-Za-z0-9.-]+)(\.hana\.ondemand\.com)/gi, sub: '$1***TENANT***$3' },
      { re: /(https?:\/\/)([A-Za-z0-9.-]+)(\.(?:s4hana\.)?cloud\.sap)/gi, sub: '$1***TENANT***$3' },
      { re: /(https?:\/\/)([A-Za-z0-9.-]+)(\.(?:sap\.com|successfactors\.com|successfactors\.eu|ariba\.com|sapcloud\.cn|sapsf\.com|sapsf\.eu))/gi,
        sub: '$1***HOST***$3' },
      // Then everything else: mask the host of any remaining absolute URL.
      // The path is deliberately kept — it is the endpoint being debugged.
      // Loopback is excluded: it names no tenant and is useful to keep while
      // debugging a local server.
      { re: /(https?:\/\/)(?!\*\*\*|127\.0\.0\.1|0\.0\.0\.0|localhost\b)([A-Za-z0-9._~%-]+(?::[^@\s/]*)?@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?=[:/?#\s"']|$)/gi,
        sub: '$1***HOST***' },
      // Host / :authority headers.
      { re: /^(\s*(?:Host|:authority)\s*:\s*).+$/gim, sub: '$1***HOST***' },
      // Bare IPv4, excluding the loopback and link-local addresses that carry
      // no tenant information and are useful to see while debugging.
      { re: /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b|169\.254\.)((?:\d{1,3}\.){3}\d{1,3})\b/g, sub: '***IP***' },
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


// ── Structural redaction ─────────────────────────────────────────────────
//
// Object/header-level redaction: deep-walks an object and masks values whose
// KEY names look sensitive (password, token, cookie, api key, etc.). Used by
// export/debug flows to make sure secrets never appear in downloaded JSON.
// The payload-text redaction above and this key-based redaction are separate
// jobs — they complement each other and both should run on any share-safe
// export.

const normalizeKey = (k) => String(k).toLowerCase().replace(/[_\-\s]/g, '')

const SENSITIVE_KEYS = new Set([
  'password','passwd','secret','client_secret','clientsecret',
  'token','access_token','bearer','authorization','auth',
  'apikey','api_key','x-api-key','x-rapidapi-key',
  'private_key','privatekey','credential','credentials',
  'sessionid','cookie','set-cookie',
].map(normalizeKey))

// Exact matching after normalisation was too narrow for real CPI headers: it
// let through Proxy-Authorization, X-Auth-Token, refresh_token, passphrase,
// apiSecret and x-csrf-token, and `pwd` was in the text patterns but not here.
// A substring test over these stems catches the family rather than the
// individual spellings.
const SENSITIVE_KEY_STEMS = [
  'password', 'passwd', 'pwd', 'passphrase',
  'secret', 'token', 'authorization', 'credential',
  'apikey', 'privatekey', 'sessionid', 'cookie', 'csrf',
]

const MASK = '***REDACTED***'

export function isSensitiveKey(key) {
  if (!key) return false
  const k = normalizeKey(key)
  if (SENSITIVE_KEYS.has(k)) return true
  if (SENSITIVE_KEY_STEMS.some(stem => k.includes(stem))) return true
  // `auth` on its own is sensitive; `author` and `authority` are not.
  return k === 'auth' || /^x?auth(entication)?$/.test(k)
}

/** Deep-redact an object — removes sensitive values (returns new object) */
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

/**
 * Redact CPI's header / exchange-property rows: arrays of { name, value }.
 *
 * This is the shape Real Trace actually works with, and nothing in the app was
 * redacting it. The value is masked outright when the NAME looks sensitive, and
 * otherwise still runs through the text patterns so a tenant URL or a bearer
 * token sitting in an innocuously-named header is caught too.
 */
export function redactNameValueRows(rows, enabledCats) {
  if (!Array.isArray(rows)) return rows
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row
    const name = row.name ?? row.Name
    if (isSensitiveKey(name)) {
      return { ...row, ...(row.value !== undefined ? { value: MASK } : { Value: MASK }) }
    }
    if (typeof row.value === 'string') return { ...row, value: redactPayload(row.value, enabledCats) }
    if (typeof row.Value === 'string') return { ...row, Value: redactPayload(row.Value, enabledCats) }
    return row
  })
}

/**
 * Share-safe copy of one trace step. Masks the header and property rows and the
 * error text, which is where credential aliases and receiver endpoints actually
 * appear — CPI error strings routinely carry the full URL.
 */
export function redactTraceStep(step, enabledCats) {
  if (!step || typeof step !== 'object') return step
  const out = { ...step }
  out.Headers = redactNameValueRows(step.Headers, enabledCats)
  out.MessageHeaders = redactNameValueRows(step.MessageHeaders, enabledCats)
  out.ExchangeProperties = redactNameValueRows(step.ExchangeProperties, enabledCats)
  if (typeof step.Error === 'string') out.Error = redactPayload(step.Error, enabledCats)
  if (typeof step.ErrorInformation === 'string') {
    out.ErrorInformation = redactPayload(step.ErrorInformation, enabledCats)
  }
  return out
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
