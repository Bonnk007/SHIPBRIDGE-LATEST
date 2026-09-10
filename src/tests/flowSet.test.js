import { describe, it, expect } from 'vitest'
import { resolveFlowSet, validateFlowSet, describeEntry } from '../lib/flowSet.js'

// A realistic seven-flow business process: an HTTPS-triggered main flow that
// fans out over ProcessDirect, with a shared mail-alert flow called from two
// places, plus one unrelated flow that must never be pulled in.
const mk = (id, name, entry = [], exit = []) => ({ id, name, steps: {}, edges: [], entryPoints: entry, exitPoints: exit })
const pd = (address) => ({ adapterType: 'ProcessDirect', address })
const https = (address) => ({ adapterType: 'HTTPS', address })

const flows = [
  mk('main',    'Replicate Product Group', [https('/pg')],      [pd('/split'), pd('/mail')]),
  mk('split',   'Split Records',           [pd('/split')],      [pd('/enrich'), pd('/mail')]),
  mk('enrich',  'Enrich Records',          [pd('/enrich')],     [pd('/post')]),
  mk('post',    'Post to SCV2',            [pd('/post')],       []),
  mk('mail',    'MailAlertCommonFlow',     [pd('/mail')],       []),
  mk('log',     'Common Logging',          [pd('/log')],        []),   // reachable from nothing selected
  mk('other',   'Unrelated Interface',     [https('/other')],   []),
]
const registry = new Map(flows.map(f => [f.id, f]))

describe('resolveFlowSet', () => {
  const { ordered, relations, missing, depth } = resolveFlowSet(registry, 'main')

  it('finds every flow reachable through the ProcessDirect chain', () => {
    expect(ordered.map(f => f.id).sort()).toEqual(['enrich', 'mail', 'main', 'post', 'split'])
  })

  it('excludes flows that are not part of the chain', () => {
    const ids = ordered.map(f => f.id)
    expect(ids).not.toContain('other')
    expect(ids).not.toContain('log')
  })

  it('orders flows by call order, root first', () => {
    expect(ordered[0].id).toBe('main')
    // split and mail are both one hop from main, so they precede two-hop flows
    expect(depth.split).toBe(1)
    expect(depth.mail).toBe(1)
    expect(depth.enrich).toBe(2)
    expect(depth.post).toBe(3)
  })

  it('records how each flow is reached', () => {
    expect(relations.split).toMatchObject({ via: '/split', calledByName: 'Replicate Product Group' })
    expect(relations.enrich).toMatchObject({ via: '/enrich', calledByName: 'Split Records' })
    expect(relations.main).toBeUndefined()   // the root isn't called by anything
  })

  it('attributes a shared flow to whichever caller reached it first', () => {
    // mail is called by both main and split; it appears once, not twice
    expect(ordered.filter(f => f.id === 'mail')).toHaveLength(1)
  })

  it('reports ProcessDirect calls with no uploaded listener', () => {
    const partial = new Map([['main', flows[0]]])   // only the main flow uploaded
    const res = resolveFlowSet(partial, 'main')
    const addrs = res.missing.map(m => m.address).sort()
    expect(addrs).toEqual(['/mail', '/split'])
    expect(res.missing[0].calledByName).toBe('Replicate Product Group')
  })

  it('returns empty for an unknown root', () => {
    expect(resolveFlowSet(registry, 'nope').ordered).toEqual([])
  })
})

describe('validateFlowSet', () => {
  it('warns when a called flow was left out of the selection', () => {
    const { warnings } = validateFlowSet(registry, ['main', 'split'])
    // main→/mail and split→/enrich are both handled by flows not selected
    expect(warnings.some(w => w.kind === 'not-selected' && w.text.includes('MailAlertCommonFlow'))).toBe(true)
    expect(warnings.some(w => w.kind === 'not-selected' && w.text.includes('Enrich Records'))).toBe(true)
  })

  it('warns when a called flow was never uploaded at all', () => {
    const partial = new Map([['main', flows[0]]])
    const { warnings } = validateFlowSet(partial, ['main'])
    expect(warnings.every(w => w.kind === 'not-uploaded')).toBe(true)
    expect(warnings).toHaveLength(2)
  })

  it('flags a flow that nothing in the set calls and that has no external entry', () => {
    const { warnings } = validateFlowSet(registry, ['main', 'log'])
    expect(warnings.some(w => w.kind === 'orphan' && w.text.includes('Common Logging'))).toBe(true)
  })

  it('is quiet when the set is complete', () => {
    const { warnings } = validateFlowSet(registry, ['main', 'split', 'enrich', 'post', 'mail'])
    expect(warnings).toEqual([])
  })
})

describe('describeEntry', () => {
  it('describes a ProcessDirect-called flow by its caller', () => {
    expect(describeEntry(flows[1], { via: '/split', calledByName: 'Replicate Product Group' }))
      .toBe('Called by Replicate Product Group via ProcessDirect /split')
  })

  it('describes a root flow by its external entry point', () => {
    expect(describeEntry(flows[0], undefined)).toBe('Entry point: HTTPS /pg')
  })

  it('does not invent an entry point when there is none', () => {
    expect(describeEntry(mk('x', 'X'), undefined)).toBe('No inbound channel detected')
  })
})
