// Guards around the compare engine: the LCS size limit, the noise-field
// exclusions, and the ProcessDirect normalizer agreeing across modules.

import { describe, it, expect } from 'vitest'
import { compareFlows, DIFF_LINE_LIMIT } from '../lib/iflowCompare.js'
import { buildIndex, usedBy, landscape } from '../lib/dependencies.js'
import { resolveFlowSet } from '../lib/flowSet.js'
import { pdKey } from '../lib/parser.js'

// Minimal flow shape, matching what parseIFlw returns.
const mkFlow = (id, steps = {}, extra = {}) => ({
  id, name: id, steps, edges: [], startId: null,
  entryPoints: [], exitPoints: [], adapterMap: {}, adapterList: [],
  ...extra,
})
// NOTE: `id` matters. parseIFlw emits `steps[id] = { id, name, kind, config }`,
// and matchSteps needs the field to agree with the map key. Omitting it here is
// exactly the "fixtures in a shape the parser never produces" trap.
const mkScriptStep = (id, name, preview) => ({
  id, name, kind: 'GroovyScript', type: 'callActivity',
  config: { scriptRef: `${name}.groovy`, preview },
})

describe('LCS size guard', () => {
  it('exposes a limit', () => {
    expect(typeof DIFF_LINE_LIMIT).toBe('number')
    expect(DIFF_LINE_LIMIT).toBeGreaterThan(100)
  })

  it('does not allocate an (m+1)x(n+1) matrix for a huge file', () => {
    // packageCompare calls diffLines on raw EDMX/XSD, where 20k lines is normal.
    // Unguarded this asked for ~4e8 array slots and killed the tab.
    const big = (n, salt) => Array.from({ length: n }, (_, i) => `line ${i} ${salt}`).join('\n')
    const a = mkFlow('A', { s1: mkScriptStep('s1', 's1', big(DIFF_LINE_LIMIT + 500, 'a')) })
    const b = mkFlow('B', { s1: mkScriptStep('s1', 's1', big(DIFF_LINE_LIMIT + 500, 'b')) })

    const started = Date.now()
    const diff = compareFlows(a, b)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(5000)
    const changed = diff.scripts.changed[0]
    expect(changed).toBeTruthy()
    // Reports "too large" rather than silently rendering nothing.
    expect(changed.lines.some(l => l.op === '!' || l.truncated)).toBe(true)
  })

  it('still produces a real line diff under the limit', () => {
    const a = mkFlow('A', { s1: mkScriptStep('s1', 's1', 'one\ntwo\nthree') })
    const b = mkFlow('B', { s1: mkScriptStep('s1', 's1', 'one\nTWO\nthree') })
    const lines = compareFlows(a, b).scripts.changed[0].lines
    expect(lines.some(l => l.op === '-' && l.text === 'two')).toBe(true)
    expect(lines.some(l => l.op === '+' && l.text === 'TWO')).toBe(true)
  })
})

describe('diffConfig noise exclusions', () => {
  const adapterStep = (addr, mfId) => ({
    id: 's1', name: 'Receiver', kind: 'Receiver', type: 'callActivity',
    config: {
      adapterType: 'HTTP', address: addr, messageFlowId: mfId,
      rawProps: { address: addr, ComponentType: 'HTTP' },
    },
  })

  it('does not report a change when only messageFlowId differs', () => {
    // CPI regenerates this id on copy/re-save, which produced a confident
    // "adapter changed" on an identical adapter.
    const a = mkFlow('A', { s1: adapterStep('https://x/y', 'MessageFlow_1') })
    const b = mkFlow('B', { s1: adapterStep('https://x/y', 'MessageFlow_77') })
    expect(compareFlows(a, b).summary.total).toBe(0)
  })

  it('does not double-report an address change via rawProps', () => {
    // Adapter-kind steps are reported under `adapters`, not `steps.changed`.
    const a = mkFlow('A', { s1: adapterStep('https://x/old', 'MessageFlow_1') })
    const b = mkFlow('B', { s1: adapterStep('https://x/new', 'MessageFlow_1') })
    const diff = compareFlows(a, b)
    const fields = diff.adapters.flatMap(c => c.fields.map(f => f.field))
    expect(fields.filter(f => f === 'address')).toHaveLength(1)
    expect(fields).not.toContain('rawProps')
    expect(diff.summary.total).toBe(1)          // once, not twice
  })
})

describe('exception-handler categorisation', () => {
  const cm = (name) => ({ id: 's1', name, kind: 'ContentModifier', type: 'callActivity', config: { headers: [], properties: [] } })

  it('does not count a Content Modifier named "Set Error Message" twice', () => {
    // CATEGORY_KINDS listed kinds resolveKind never emits, leaving a name regex
    // that also matched steps already claimed by another category.
    const a = mkFlow('A', { s1: cm('Set Error Message') })
    const b = mkFlow('B', { s1: { ...cm('Set Error Message'), config: { headers: [{ name: 'X' }], properties: [] } } })
    const d = compareFlows(a, b)
    const counted = Object.values(d.summary.byCategory).reduce((n, v) => n + v, 0)
    expect(counted).toBeLessThanOrEqual(d.summary.total)
  })

  it('detects a structural error subprocess regardless of its name', () => {
    const handler = (name) => ({ id: 'e1', name, kind: 'ErrorSubProcess', type: 'subProcess', config: {} })
    const a = mkFlow('A', {})
    const b = mkFlow('B', { e1: handler('Fault Handler') })   // no "error"/"exception" in the name
    expect(compareFlows(a, b).exceptionHandling.added.map(s => s.name)).toContain('Fault Handler')
  })
})

describe('ProcessDirect normalization is shared, not per-module', () => {
  // flowSet.js lowercased and stripped slashes; dependencies.js only trimmed.
  // A pair differing in case linked in the Spec Builder but not in impact
  // analysis — the one feature whose whole value is being right about breakage.
  const producer = mkFlow('caller', {}, {
    exitPoints: [{ stepId: 's1', adapterType: 'ProcessDirect', address: 'pd://Orders_Split' }],
  })
  const consumer = mkFlow('callee', {}, {
    entryPoints: [{ stepId: 's2', adapterType: 'ProcessDirect', address: '/orders_split' }],
  })

  it('links a case- and slash-mismatched pair in impact analysis', () => {
    const ls = landscape(buildIndex([producer, consumer]))
    expect(ls.brokenPD).toHaveLength(0)
  })

  it('links the same pair in the flow set used by the Spec Builder', () => {
    const registry = new Map([[producer.id, producer], [consumer.id, consumer]])
    const set = resolveFlowSet(registry, 'caller')
    expect(set.ordered.map(f => f.id)).toContain('callee')
  })

  it('reports a readable address for a genuinely broken channel', () => {
    const orphan = mkFlow('lonely', {}, {
      exitPoints: [{ stepId: 's1', adapterType: 'ProcessDirect', address: 'pd://Orphan_Channel' }],
    })
    const ls = landscape(buildIndex([orphan]))
    // Not the lowercased match key — the user has to recognise this.
    expect(ls.brokenPD.map(b => b.address)).toContain('pd://Orphan_Channel')
  })

  it('usedBy finds a resource whatever case the caller asks with', () => {
    const idx = buildIndex([producer, consumer])
    expect(usedBy(idx, 'processDirect', 'ORDERS_SPLIT')).toContain('caller')
    expect(usedBy(idx, 'processDirect', '/orders_split/')).toContain('callee')
  })

  it('pdKey is the single source of truth', () => {
    expect(pdKey('pd://Orders_Split')).toBe(pdKey('/orders_split'))
  })
})
