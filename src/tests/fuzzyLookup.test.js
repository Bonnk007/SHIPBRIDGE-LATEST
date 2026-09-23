import { describe, it, expect } from 'vitest'
import { fuzzyLookup } from '../lib/fuzzyLookup.js'

describe('fuzzyLookup — exact match wins', () => {
  it('returns the value keyed by the exact name', () => {
    const dict = { 'MM_Order.mmap': { entries: 3 } }
    expect(fuzzyLookup(dict, 'MM_Order.mmap')).toEqual({ entries: 3 })
  })
})

describe('fuzzyLookup — extension append', () => {
  it('resolves MM_Order to MM_Order.mmap (the real delaware case)', () => {
    // The .iflw uses mappingRef="MM_Order"; the ZIP entry is "MM_Order.mmap".
    // This is the exact mismatch that made mapping content look "not available"
    // in v48.18 until we added the extension fallback.
    const dict = { 'MM_Order.mmap': { source: 'X', target: 'Y' } }
    expect(fuzzyLookup(dict, 'MM_Order').target).toBe('Y')
  })

  it('tries .xml and .vmap too', () => {
    expect(fuzzyLookup({ 'CountryCodes.vmap': 'v' }, 'CountryCodes')).toBe('v')
    expect(fuzzyLookup({ 'thing.xml': 't' }, 'thing')).toBe('t')
  })
})

describe('fuzzyLookup — extension strip', () => {
  it('resolves MM_Order.mmap to MM_Order when the key is bare', () => {
    expect(fuzzyLookup({ 'MM_Order': { ok: true } }, 'MM_Order.mmap').ok).toBe(true)
  })
})

describe('fuzzyLookup — substring only as a last resort', () => {
  it('finds an entry whose bare form contains the query', () => {
    // The value-mapping viewer in Compare uses this path when a ref like
    // "CustomerInvoiceMapping" needs to match "MM_CustomerInvoiceMapping_v2.mmap".
    const dict = { 'MM_CustomerInvoiceMapping_v2.mmap': 42 }
    expect(fuzzyLookup(dict, 'CustomerInvoiceMapping')).toBe(42)
  })

  it('prefers exact over substring — no wrong match', () => {
    const dict = { 'Order': 'exact', 'MM_Order_v2.mmap': 'substr' }
    // Exact is checked first, so we should get 'exact'.
    expect(fuzzyLookup(dict, 'Order')).toBe('exact')
  })
})

describe('fuzzyLookup — safety', () => {
  it('returns null on null/undefined inputs', () => {
    expect(fuzzyLookup(null, 'x')).toBe(null)
    expect(fuzzyLookup({}, null)).toBe(null)
    expect(fuzzyLookup(undefined, 'x')).toBe(null)
  })

  it('returns null when no match exists', () => {
    expect(fuzzyLookup({ 'a.mmap': 1 }, 'unrelated')).toBe(null)
  })
})
