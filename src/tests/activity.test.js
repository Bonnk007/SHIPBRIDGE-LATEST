// Activity log tests — the log is per-browser localStorage, so the
// module has to survive both a real localStorage (during use) and no
// localStorage at all (during SSR). Both are covered here.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  logActivity, getRecentActivity, clearActivity,
  formatRelativeTime, ActivityKinds,
} from '../lib/activity.js'

// vitest defaults to happy-dom / jsdom depending on config; localStorage
// exists there. If it doesn't (pure node), stub a minimal one so the tests
// exercise the "storage is present" branch rather than the fallback.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  }
}

describe('activity log', () => {
  beforeEach(() => clearActivity())

  it('starts empty', () => {
    expect(getRecentActivity()).toEqual([])
  })

  it('prepends entries so the newest is first', () => {
    logActivity({ kind: ActivityKinds.LOAD, title: 'first' })
    logActivity({ kind: ActivityKinds.TRACE, title: 'second' })
    const recent = getRecentActivity()
    expect(recent[0].title).toBe('second')
    expect(recent[1].title).toBe('first')
  })

  it('caps stored entries at 20 regardless of how many are pushed', () => {
    for (let i = 0; i < 25; i++) {
      logActivity({ kind: ActivityKinds.LOAD, title: `entry ${i}` })
    }
    // Ask for all — the log itself is capped, not just the read.
    const all = getRecentActivity(100)
    expect(all.length).toBe(20)
    // Newest survived, oldest were dropped.
    expect(all[0].title).toBe('entry 24')
    expect(all.at(-1).title).toBe('entry 5')
  })

  it('ignores entries missing required fields', () => {
    expect(logActivity({ title: 'no kind' })).toBe(null)
    expect(logActivity({ kind: ActivityKinds.LOAD })).toBe(null)
    expect(getRecentActivity()).toEqual([])
  })

  it('stamps each entry with a timestamp and unique id', () => {
    const a = logActivity({ kind: ActivityKinds.TRACE, title: 'a' })
    const b = logActivity({ kind: ActivityKinds.TRACE, title: 'b' })
    expect(a.id).not.toBe(b.id)
    expect(typeof a.timestamp).toBe('number')
  })

  it('dispatches sb-activity so same-tab listeners can refresh', () => {
    const spy = vi.fn()
    window.addEventListener('sb-activity', spy)
    logActivity({ kind: ActivityKinds.LOAD, title: 'x' })
    expect(spy).toHaveBeenCalled()
    window.removeEventListener('sb-activity', spy)
  })
})

describe('formatRelativeTime', () => {
  it('returns Just now for very recent timestamps', () => {
    expect(formatRelativeTime(Date.now())).toBe('Just now')
  })

  it('uses minutes for the first hour', () => {
    expect(formatRelativeTime(Date.now() - 3 * 60 * 1000)).toBe('3 min ago')
  })

  it('uses hours between 1 and 24', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60 * 60 * 1000)).toBe('5 hours ago')
    expect(formatRelativeTime(Date.now() - 1 * 60 * 60 * 1000)).toBe('1 hour ago')
  })

  it('says Yesterday for anything from the previous calendar day', () => {
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(16, 12, 0, 0)
    expect(formatRelativeTime(y.getTime())).toMatch(/^Yesterday, /)
  })

  it('handles falsy input without throwing', () => {
    expect(formatRelativeTime(0)).toBe('')
    expect(formatRelativeTime(null)).toBe('')
  })
})
