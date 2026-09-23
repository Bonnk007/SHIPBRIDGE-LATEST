// Shared URL allowlist for outbound calls from the server.
// Used by Live Trigger, OAuth2 token fetch, and CPI trace fetch.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const CPI_HOST_PATTERNS = [
  /\.hana\.ondemand\.com$/i,
  /\.sap\.com$/i,
]

export function isAllowedUrl(rawUrl) {
  try {
    const p = new URL(rawUrl)
    if (p.protocol === 'http:' && LOCAL_HOSTS.has(p.hostname)) return true
    if (p.protocol !== 'https:') return false
    if (LOCAL_HOSTS.has(p.hostname)) return true
    const extra = (process.env.ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean)
    if (extra.includes(p.hostname)) return true
    return CPI_HOST_PATTERNS.some(rx => rx.test(p.hostname))
  } catch { return false }
}
