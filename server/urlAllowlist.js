// Shared URL allowlist for outbound calls from the server.
// Used by Live Trigger, OAuth2 token fetch, and CPI trace fetch.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const CPI_HOST_PATTERNS = [
  /\.hana\.ondemand\.com$/i,
  /\.sap\.com$/i,
]

// Loopback is allowed for local development only. On a deployed instance it
// turns Live Trigger into a port scanner for whatever else runs in the
// container, so it is gated on NODE_ENV. Self-hosters who genuinely need a
// local target can name it explicitly in ALLOWED_HOSTS.
function loopbackAllowed() {
  return process.env.NODE_ENV !== 'production'
}

export function isAllowedUrl(rawUrl) {
  try {
    const p = new URL(rawUrl)
    const isLocal = LOCAL_HOSTS.has(p.hostname)
    if (p.protocol === 'http:' && isLocal && loopbackAllowed()) return true
    if (p.protocol !== 'https:') return false
    if (isLocal) return loopbackAllowed()
    const extra = (process.env.ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean)
    if (extra.includes(p.hostname)) return true
    return CPI_HOST_PATTERNS.some(rx => rx.test(p.hostname))
  } catch { return false }
}
