// Recent-activity log for the Home "Recent" list.
//
// The Home screen used to be a static tile grid, so nothing on it changed
// between sessions and it read as empty (see the IDE-welcome redesign). To
// make Home reflect what you were actually doing in the app, the components
// that produce meaningful events (loads, traces, compares, docs, triggers)
// push short entries into this log; Home pulls the last few and renders
// them as a click-to-reopen list.
//
// Storage is per-browser localStorage. Capped at 20 entries so it can't
// grow unbounded; only the newest are shown on Home. No server component
// — this is deliberately client-only, because these entries reference
// in-memory registry state that only exists in the tab that created them.
//
// Callers should use ActivityKinds so the icon/color mapping in Home stays
// in sync with the kinds we actually log.

const KEY = 'sb_activity_v1'
const CAP = 20

export const ActivityKinds = Object.freeze({
  LOAD: 'load',
  TRACE: 'trace',
  COMPARE: 'compare',
  DOCS: 'docs',
  TRIGGER: 'trigger',
})

function readAll() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function writeAll(arr) {
  try { localStorage.setItem(KEY, JSON.stringify(arr.slice(0, CAP))) } catch {}
}

// Push a new entry to the front of the log. `kind` decides the icon on
// Home; `title` and `subtitle` are shown verbatim. `status` colors the
// subtitle (success/error/warning/info). `target` is optional and, when
// present, makes the row a click-to-reopen link — { page } is one of the
// PAGES ids in App.jsx.
export function logActivity({ kind, title, subtitle = '', status = 'info', target = null }) {
  if (!kind || !title) return null
  const entry = {
    id: Math.random().toString(36).slice(2, 10),
    kind, title, subtitle, status, target,
    timestamp: Date.now(),
  }
  writeAll([entry, ...readAll()])
  // Same-tab listeners: `storage` events only fire cross-tab, so a custom
  // event is what lets Home refresh live when activity is logged from
  // another component in the same tab.
  try { window.dispatchEvent(new CustomEvent('sb-activity')) } catch {}
  return entry
}

export function getRecentActivity(limit = 5) {
  return readAll().slice(0, Math.max(0, limit))
}

export function clearActivity() {
  try { localStorage.removeItem(KEY) } catch {}
  try { window.dispatchEvent(new CustomEvent('sb-activity')) } catch {}
}

// "3 min ago" / "1 hour ago" / "Yesterday, 4:12 PM" / "Nov 3".
// Kept in this module so callers don't reinvent it and formats stay
// consistent everywhere activity is displayed.
export function formatRelativeTime(ts) {
  if (!ts) return ''
  const now = Date.now()
  const then = new Date(ts)
  const diffS = Math.max(0, Math.round((now - ts) / 1000))
  if (diffS < 60) return 'Just now'
  const diffM = Math.round(diffS / 60)
  if (diffM < 60) return `${diffM} min ago`
  // Check the calendar-day boundary BEFORE falling through to hours — a
  // trace from yesterday afternoon, read this morning, should say
  // "Yesterday, 4:12 PM", not "18 hours ago". Users think in calendar
  // days here.
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const isSameDay = then.toDateString() === today.toDateString()
  const isYesterday = then.toDateString() === yesterday.toDateString()
  if (isYesterday) {
    return `Yesterday, ${then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  }
  if (isSameDay) {
    const diffH = Math.round(diffM / 60)
    return `${diffH} hour${diffH === 1 ? '' : 's'} ago`
  }
  const diffD = Math.round((now - ts) / 86400000)
  if (diffD < 7) return `${diffD} days ago`
  return then.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
