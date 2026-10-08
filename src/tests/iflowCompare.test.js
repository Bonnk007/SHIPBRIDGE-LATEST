import { describe, it, expect } from 'vitest'
import { compareFlows, _internal } from '../lib/iflowCompare.js'

// Minimal flow builder. Real parsed flows have many more fields; these tests
// only include what the diff engine actually reads, so a change to the parser
// doesn't cascade unnecessarily.
function flow(id, name, steps = {}, edges = [], extra = {}) {
  return { id, name, zipName: `${name}.zip`, steps, edges, ...extra }
}
const step = (id, name, kind, config = {}) => ({ id, name, kind, config })

describe('compareFlows — step matching', () => {
  it('matches steps by ID first, so renaming reads as one change not add+remove', () => {
    const a = flow('a', 'F', { s1: step('s1', 'Old Name', 'ContentModifier', { bodyType: 'expression' }) })
    const b = flow('b', 'F', { s1: step('s1', 'New Name', 'ContentModifier', { bodyType: 'expression' }) })
    const result = compareFlows(a, b)
    expect(result.steps.renamed).toHaveLength(1)
    expect(result.steps.renamed[0]).toMatchObject({ before: 'Old Name', after: 'New Name' })
    expect(result.steps.added).toHaveLength(0)
    expect(result.steps.removed).toHaveLength(0)
  })

  it('falls back to name matching when IDs differ (copy-pasted step)', () => {
    // This is the case Figaf explicitly gave up on in their tool.
    const a = flow('a', 'F', { CM_1: step('CM_1', 'Set Headers', 'ContentModifier', {}) })
    const b = flow('b', 'F', { CM_57: step('CM_57', 'Set Headers', 'ContentModifier', {}) })
    const result = compareFlows(a, b)
    expect(result.steps.added).toHaveLength(0)
    expect(result.steps.removed).toHaveLength(0)
  })

  it('does not name-match when the kind differs', () => {
    // "Router" and "Content Modifier" happen to share a name — different things.
    const a = flow('a', 'F', { s1: step('s1', 'Check', 'Router', {}) })
    const b = flow('b', 'F', { s2: step('s2', 'Check', 'ContentModifier', {}) })
    const result = compareFlows(a, b)
    expect(result.steps.added).toHaveLength(1)
    expect(result.steps.removed).toHaveLength(1)
  })

  it('reports genuinely new and removed steps', () => {
    const a = flow('a', 'F', { s1: step('s1', 'A', 'ContentModifier') })
    const b = flow('b', 'F', {
      s1: step('s1', 'A', 'ContentModifier'),
      s2: step('s2', 'B', 'ContentModifier'),
    })
    const result = compareFlows(a, b)
    expect(result.steps.added).toHaveLength(1)
    expect(result.steps.added[0].id).toBe('s2')
  })
})

describe('compareFlows — noise filtering', () => {
  it('ignores layout coordinate changes — moving a box in Word\'s editor should produce zero output', () => {
    // The single biggest source of false-positive noise in raw-XML diff tools.
    const a = flow('a', 'F', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'expression', x: 100, y: 200 }) })
    const b = flow('b', 'F', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'expression', x: 450, y: 380 }) })
    const result = compareFlows(a, b)
    expect(result.summary.total).toBe(0)
  })

  it('ignores auto-generated timestamps and technical version numbers', () => {
    const a = flow('a', 'F', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'x', modifiedAt: '2026-01-01', technicalVersion: 5 }) })
    const b = flow('b', 'F', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'x', modifiedAt: '2026-07-15', technicalVersion: 8 }) })
    expect(compareFlows(a, b).summary.total).toBe(0)
  })
})

describe('compareFlows — Content Modifiers', () => {
  it('reports added, removed, and changed headers by name', () => {
    const a = flow('a', 'F', { s1: step('s1', 'Set', 'ContentModifier', {
      headers: [
        { name: 'X-Correlation', type: 'Expression', value: '${id}' },
        { name: 'X-Region', type: 'Constant', value: 'EU' },
      ],
    })})
    const b = flow('b', 'F', { s1: step('s1', 'Set', 'ContentModifier', {
      headers: [
        { name: 'X-Correlation', type: 'Expression', value: '${property.corr}' }, // changed
        { name: 'X-Env', type: 'Constant', value: 'PRD' },                        // added
        // X-Region removed
      ],
    })})
    const result = compareFlows(a, b)
    expect(result.contentModifiers).toHaveLength(1)
    const kinds = result.contentModifiers[0].headers.map(h => h.kind).sort()
    expect(kinds).toEqual(['added', 'changed', 'removed'])
  })

  it('does not fire when nothing meaningful changed', () => {
    const cm = { bodyType: 'expression', headers: [{ name: 'X', type: 'Constant', value: '1' }] }
    const a = flow('a', 'F', { s1: step('s1', 'Set', 'ContentModifier', cm) })
    const b = flow('b', 'F', { s1: step('s1', 'Set', 'ContentModifier', cm) })
    expect(compareFlows(a, b).contentModifiers).toHaveLength(0)
  })

  it('reports body transformation type changes', () => {
    const a = flow('a', 'F', { s1: step('s1', 'Set', 'ContentModifier', { bodyType: 'constant', bodyValue: 'hello' }) })
    const b = flow('b', 'F', { s1: step('s1', 'Set', 'ContentModifier', { bodyType: 'expression', bodyValue: '${in.body}' }) })
    const result = compareFlows(a, b)
    expect(result.contentModifiers[0].body).toMatchObject({
      before: { type: 'constant' },
      after: { type: 'expression' },
    })
  })
})

describe('compareFlows — Groovy scripts', () => {
  it('produces a line-level diff of the script source', () => {
    const a = flow('a', 'F', { s1: step('s1', 'Enrich', 'GroovyScript', {
      scriptRef: 'enrich.groovy',
      preview: 'def x = 1\ndef y = 2\ndef z = 3',
    })})
    const b = flow('b', 'F', { s1: step('s1', 'Enrich', 'GroovyScript', {
      scriptRef: 'enrich.groovy',
      preview: 'def x = 1\ndef y = 42\ndef z = 3\ndef w = 4',
    })})
    const result = compareFlows(a, b)
    expect(result.scripts.changed).toHaveLength(1)
    const lines = result.scripts.changed[0].lines
    expect(lines.some(l => l.op === '-' && l.text === 'def y = 2')).toBe(true)
    expect(lines.some(l => l.op === '+' && l.text === 'def y = 42')).toBe(true)
    expect(lines.some(l => l.op === '+' && l.text === 'def w = 4')).toBe(true)
    // Unchanged lines are preserved for context
    expect(lines.some(l => l.op === '=' && l.text === 'def x = 1')).toBe(true)
  })

  it('reports scriptRef changes (different file referenced)', () => {
    const a = flow('a', 'F', { s1: step('s1', 'Run', 'GroovyScript', { scriptRef: 'dev.groovy', preview: 'x' }) })
    const b = flow('b', 'F', { s1: step('s1', 'Run', 'GroovyScript', { scriptRef: 'prd.groovy', preview: 'x' }) })
    expect(compareFlows(a, b).scripts.changed[0].scriptRef).toMatchObject({
      before: 'dev.groovy', after: 'prd.groovy',
    })
  })
})

describe('compareFlows — adapters', () => {
  it('reports credential alias changes — the "works in dev, not prod" bug', () => {
    // Most common CPI production incident. Making this obvious in the diff is
    // half the reason to build the tool at all.
    const a = flow('a', 'F', { r1: step('r1', 'ERP', 'Receiver', { adapterType: 'HTTPS', credentialName: 'DEV_CRED' }) })
    const b = flow('b', 'F', { r1: step('r1', 'ERP', 'Receiver', { adapterType: 'HTTPS', credentialName: 'PRD_CRED' }) })
    const result = compareFlows(a, b)
    const change = result.adapters[0].fields.find(f => f.field === 'credentialName')
    expect(change).toMatchObject({ before: 'DEV_CRED', after: 'PRD_CRED' })
  })

  it('reports timeout and HTTP method changes', () => {
    const a = flow('a', 'F', { r1: step('r1', 'API', 'Receiver', { adapterType: 'HTTPS', httpMethod: 'GET', httpRequestTimeout: '30000' }) })
    const b = flow('b', 'F', { r1: step('r1', 'API', 'Receiver', { adapterType: 'HTTPS', httpMethod: 'POST', httpRequestTimeout: '60000' }) })
    const fields = compareFlows(a, b).adapters[0].fields.map(f => f.field).sort()
    expect(fields).toEqual(['httpMethod', 'httpRequestTimeout'])
  })
})

describe('compareFlows — router branches', () => {
  it('reports changed condition expressions on router edges', () => {
    const a = flow('a', 'F', { r1: step('r1', 'Split', 'Router') },
      [{ source: 'r1', target: 't1', condition: "${property.amount} > 100" }])
    const b = flow('b', 'F', { r1: step('r1', 'Split', 'Router') },
      [{ source: 'r1', target: 't1', condition: "${property.amount} > 500" }])
    expect(compareFlows(a, b).routers[0].branches[0]).toMatchObject({
      kind: 'changed',
      before: { condition: "${property.amount} > 100" },
      after: { condition: "${property.amount} > 500" },
    })
  })
})

describe('compareFlows — exception handling', () => {
  it('detects when an exception subprocess was added', () => {
    // "Removed error handling in prod" is a career-limiting incident.
    // Making it impossible to miss is the whole point of this category.
    const a = flow('a', 'F', { s1: step('s1', 'Main', 'ContentModifier') })
    const b = flow('b', 'F', {
      s1: step('s1', 'Main', 'ContentModifier'),
      e1: step('e1', 'Error Handler', 'ExceptionSubProcess'),
    })
    expect(compareFlows(a, b).exceptionHandling.added).toHaveLength(1)
  })

  it('detects removed exception subprocesses', () => {
    const a = flow('a', 'F', {
      s1: step('s1', 'Main', 'ContentModifier'),
      e1: step('e1', 'Error Handler', 'ExceptionSubProcess'),
    })
    const b = flow('b', 'F', { s1: step('s1', 'Main', 'ContentModifier') })
    expect(compareFlows(a, b).exceptionHandling.removed).toHaveLength(1)
  })
})

describe('compareFlows — edges (message flow paths)', () => {
  it('reports added and removed edges', () => {
    const a = flow('a', 'F', {}, [{ source: 's1', target: 's2' }])
    const b = flow('b', 'F', {}, [{ source: 's1', target: 's2' }, { source: 's2', target: 's3' }])
    const r = compareFlows(a, b)
    expect(r.edges.added).toHaveLength(1)
    expect(r.edges.removed).toHaveLength(0)
  })
})

describe('compareFlows — summary', () => {
  it('sums totals across categories', () => {
    const a = flow('a', 'F', {
      s1: step('s1', 'CM', 'ContentModifier', { bodyType: 'expression' }),
      s2: step('s2', 'Script', 'GroovyScript', { scriptRef: 'a.groovy', preview: 'line1' }),
    })
    const b = flow('b', 'F', {
      s1: step('s1', 'CM', 'ContentModifier', { bodyType: 'constant' }),
      s2: step('s2', 'Script', 'GroovyScript', { scriptRef: 'b.groovy', preview: 'line1' }),
      s3: step('s3', 'New', 'ContentModifier'),
    })
    const r = compareFlows(a, b)
    expect(r.summary.total).toBeGreaterThanOrEqual(3)
    expect(r.summary.byCategory.contentModifiers).toBeGreaterThan(0)
    expect(r.summary.byCategory.scripts).toBeGreaterThan(0)
    expect(r.summary.byCategory.steps).toBeGreaterThan(0)
  })

  it('returns zero total for identical flows', () => {
    const s = { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'x' }) }
    expect(compareFlows(flow('a', 'F', s), flow('b', 'F', s)).summary.total).toBe(0)
  })
})

describe('compareFlows — input validation', () => {
  it('throws on missing flows rather than returning garbage', () => {
    expect(() => compareFlows(null, {})).toThrow()
    expect(() => compareFlows({}, null)).toThrow()
  })
})
