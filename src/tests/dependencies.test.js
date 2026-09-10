import { describe, it, expect } from 'vitest'
import {
  flowResources, buildIndex, usedBy, impactOf, downstreamFlows, landscape
} from '../lib/dependencies.js'

// Minimal flow factory matching parseIFlw() output shape
function flow(id, { steps = {}, exitPD = [], entryPD = [], endpoints = [], edges = [] } = {}) {
  return {
    id, name: id, steps, edges, startId: null,
    entryPoints: [
      ...entryPD.map(a => ({ adapterType: 'ProcessDirect', address: a })),
      ...endpoints.map(a => ({ adapterType: 'HTTP', address: a })),
    ],
    exitPoints: exitPD.map(a => ({ stepId: 'x', adapterType: 'ProcessDirect', address: a })),
    adapterMap: {},
  }
}

const groovy   = (ref) => ({ id: 's', name: 's', kind: 'GroovyScript',  config: { scriptRef: ref } })
const mapping  = (ref) => ({ id: 'm', name: 'm', kind: 'MessageMapping', config: { mappingRef: ref } })

describe('flowResources', () => {
  it('extracts script and mapping refs', () => {
    const f = flow('A', { steps: { s: groovy('invoiceTransform.groovy'), m: mapping('VM_MAP') } })
    const res = flowResources(f)
    expect(res).toContainEqual({ kind: 'script', name: 'invoiceTransform.groovy' })
    expect(res).toContainEqual({ kind: 'mapping', name: 'VM_MAP' })
  })

  it('extracts processDirect channels from both ends', () => {
    const f = flow('A', { exitPD: ['pd://OrderFlow'], entryPD: ['pd://InboundFlow'] })
    const res = flowResources(f)
    expect(res).toContainEqual({ kind: 'processDirect', name: 'pd://OrderFlow' })
    expect(res).toContainEqual({ kind: 'processDirect', name: 'pd://InboundFlow' })
  })

  it('de-dupes repeated refs within a flow', () => {
    const f = flow('A', { steps: { s: groovy('x.groovy'), s2: { ...groovy('x.groovy'), id: 's2' } } })
    const scripts = flowResources(f).filter(r => r.kind === 'script')
    expect(scripts).toHaveLength(1)
  })
})

describe('usedBy', () => {
  it('finds all flows referencing a shared script', () => {
    const idx = buildIndex([
      flow('A', { steps: { s: groovy('shared.groovy') } }),
      flow('B', { steps: { s: groovy('shared.groovy') } }),
      flow('C', { steps: { s: groovy('other.groovy') } }),
    ])
    expect(usedBy(idx, 'script', 'shared.groovy').sort()).toEqual(['A', 'B'])
    expect(usedBy(idx, 'script', 'other.groovy')).toEqual(['C'])
    expect(usedBy(idx, 'script', 'missing.groovy')).toEqual([])
  })
})

describe('downstreamFlows / impact', () => {
  // A --pd://X--> B --pd://Y--> C
  const flows = [
    flow('A', { exitPD: ['pd://X'] }),
    flow('B', { entryPD: ['pd://X'], exitPD: ['pd://Y'], steps: { s: groovy('mid.groovy') } }),
    flow('C', { entryPD: ['pd://Y'] }),
  ]
  const idx = buildIndex(flows)

  it('resolves direct downstream via ProcessDirect', () => {
    expect(downstreamFlows(idx, 'A')).toEqual(['B'])
    expect(downstreamFlows(idx, 'B')).toEqual(['C'])
  })

  it('impactOf walks the chain transitively', () => {
    // changing mid.groovy directly hits B, transitively C (B calls C via pd)
    const r = impactOf(idx, 'script', 'mid.groovy')
    expect(r.direct).toEqual(['B'])
    expect(r.transitive).toContain('C')
    expect(r.all.sort()).toEqual(['B', 'C'])
  })
})

describe('landscape', () => {
  const idx = buildIndex([
    flow('A', { steps: { s: groovy('shared.groovy'), m: mapping('VM') }, exitPD: ['pd://X'] }),
    flow('B', { steps: { s: groovy('shared.groovy') }, entryPD: ['pd://X'] }),
    flow('C', { exitPD: ['pd://Orphan'] }),  // produced, never consumed
  ])
  const ls = landscape(idx)

  it('counts totals', () => {
    expect(ls.totals.flows).toBe(3)
    expect(ls.totals.scripts).toBe(1)        // shared.groovy counted once
    expect(ls.totals.processDirects).toBe(2) // pd://X, pd://Orphan
  })

  it('flags shared resources used by 2+ flows', () => {
    const sharedScript = ls.shared.script.find(s => s.name === 'shared.groovy')
    expect(sharedScript.count).toBe(2)
  })

  it('detects broken ProcessDirect channels', () => {
    expect(ls.brokenPD.some(b => b.address === 'pd://Orphan')).toBe(true)
  })

  it('ranks most complex flow', () => {
    expect(ls.mostComplex).toBeTruthy()
  })
})

import { deadAssets, circularDependencies } from '../lib/dependencies.js'

// flow factory variant that also sets bundled assets
function flowB(id, opts = {}) {
  const f = flow(id, opts)
  f.bundled = opts.bundled || { scripts: [], xslts: [], mappings: [] }
  return f
}

describe('deadAssets', () => {
  it('flags bundled scripts that no step references', () => {
    const idx = buildIndex([
      flowB('A', {
        steps: { s: groovy('used.groovy') },
        bundled: { scripts: ['used.groovy', 'orphan.groovy', 'leftover.groovy'], xslts: [], mappings: [] },
      }),
    ])
    const dead = deadAssets(idx)
    expect(dead.scripts).toEqual(['leftover.groovy', 'orphan.groovy'])
  })

  it('counts a script referenced in any flow as alive', () => {
    const idx = buildIndex([
      flowB('A', { steps: {}, bundled: { scripts: ['shared.groovy'], xslts: [], mappings: [] } }),
      flowB('B', { steps: { s: groovy('shared.groovy') }, bundled: { scripts: [], xslts: [], mappings: [] } }),
    ])
    expect(deadAssets(idx).scripts).toEqual([])
  })

  it('returns empty when nothing is bundled', () => {
    const idx = buildIndex([flow('A', { steps: { s: groovy('x.groovy') } })])
    const dead = deadAssets(idx)
    expect(dead.scripts).toEqual([])
    expect(dead.xslts).toEqual([])
  })
})

describe('circularDependencies', () => {
  it('detects a simple A->B->A loop', () => {
    const idx = buildIndex([
      flow('A', { exitPD: ['pd://X'], entryPD: ['pd://Y'] }),
      flow('B', { entryPD: ['pd://X'], exitPD: ['pd://Y'] }),
    ])
    const cycles = circularDependencies(idx)
    expect(cycles.length).toBe(1)
    // closed loop, starts/ends on same id
    expect(cycles[0][0]).toBe(cycles[0][cycles[0].length - 1])
    expect(new Set(cycles[0])).toEqual(new Set(['A', 'B']))
  })

  it('detects a 3-flow A->B->C->A loop', () => {
    const idx = buildIndex([
      flow('A', { exitPD: ['pd://1'], entryPD: ['pd://3'] }),
      flow('B', { entryPD: ['pd://1'], exitPD: ['pd://2'] }),
      flow('C', { entryPD: ['pd://2'], exitPD: ['pd://3'] }),
    ])
    const cycles = circularDependencies(idx)
    expect(cycles.length).toBe(1)
    expect(new Set(cycles[0])).toEqual(new Set(['A', 'B', 'C']))
  })

  it('returns no cycles for a linear chain', () => {
    const idx = buildIndex([
      flow('A', { exitPD: ['pd://1'] }),
      flow('B', { entryPD: ['pd://1'], exitPD: ['pd://2'] }),
      flow('C', { entryPD: ['pd://2'] }),
    ])
    expect(circularDependencies(idx)).toEqual([])
  })

  it('does not double-report the same cycle from different start nodes', () => {
    const idx = buildIndex([
      flow('A', { exitPD: ['pd://X'], entryPD: ['pd://Y'] }),
      flow('B', { entryPD: ['pd://X'], exitPD: ['pd://Y'] }),
    ])
    expect(circularDependencies(idx).length).toBe(1)
  })
})
