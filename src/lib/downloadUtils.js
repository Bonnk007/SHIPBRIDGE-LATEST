// Shared download helpers.

/**
 * Release a blob URL, but not in the same tick as the click that used it.
 *
 * Revoking immediately after `a.click()` works in Chrome and silently cancels
 * the download in Firefox and Safari, which is why several exports in
 * ShipBridge appeared to do nothing in those browsers. One minute is far longer
 * than any save dialog needs and still bounds the leak.
 */
export function deferRevoke(url, delayMs = 60_000) {
  if (!url) return
  setTimeout(() => {
    try { URL.revokeObjectURL(url) } catch { /* already gone */ }
  }, delayMs)
}
