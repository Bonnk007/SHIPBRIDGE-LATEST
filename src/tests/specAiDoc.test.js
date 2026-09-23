import { describe, it, expect } from 'vitest'
import { orderSteps, buildSpecFacts, stepConfigRows, factsForPrompt } from '../../server/specAiDoc.js'

// A flow whose XML declaration order deliberately does NOT match execution
// order — that's the case that matters, since a spec listing steps in the
// wrong order is worse than no spec.
const flow = {
  name: 'Test_Flow',
  startId: 'Sender_1',
  steps: {
    End_1:     { id: 'End_1',     name: 'End',            kind: 'EndEvent',        config: {} },
    Script_1:  { id: 'Script_1',  name: 'Enrich',         kind: 'GroovyScript',
                 config: { scriptRef: 'enrich.groovy', preview: 'def x = 1', scriptMatch: 'exact' } },
    Sender_1:  { id: 'Sender_1',  name: 'HTTPS Sender',   kind: 'Sender',
                 config: { adapterType: 'HTTPS', address: '/in', authenticationMethod: 'Client Certificate' } },
    CM_1:      { id: 'CM_1',      name: 'Set Headers',    kind: 'ContentModifier',
                 config: { headers: [{ name: 'X-Trace', type: 'Expression', value: '${id}' }],
                           properties: [{ name: 'amount', type: 'Constant', value: '100' }] } },
    Receiver_1:{ id: 'Receiver_1',name: 'HTTP Receiver',  kind: 'Receiver',
                 config: { adapterType: 'HTTP', httpMethod: 'GET', httpRequestTimeout: '60000',
                           credentialName: 'MY_CRED', internalCamelProp: 'should-not-appear' } },
  },
  edges: [
    { sourceRef: 'Sender_1',   targetRef: 'CM_1' },
    { sourceRef: 'CM_1',       targetRef: 'Script_1' },
    { sourceRef: 'Script_1',   targetRef: 'Receiver_1' },
    { sourceRef: 'Receiver_1', targetRef: 'End_1' },
  ],
  adapterList: [{ direction: 'Sender', adapterType: 'HTTPS', address: '/in', stepName: 'HTTPS Sender' }],
  entryPoints: [], exitPoints: [],
  bundled: { scripts: ['enrich.groovy'], xslts: [], mappings: [] },
}

describe('orderSteps', () => {
  it('follows edges rather than declaration order', () => {
    const names = orderSteps(flow).map(s => s.name)
    expect(names).toEqual(['HTTPS Sender', 'Set Headers', 'Enrich', 'HTTP Receiver', 'End'])
  })

  it('still includes steps unreachable from the start node', () => {
    const orphaned = {
      ...flow,
      steps: { ...flow.steps, Orphan_1: { id: 'Orphan_1', name: 'Error Handler', kind: 'GroovyScript', config: {} } },
    }
    const names = orderSteps(orphaned).map(s => s.name)
    expect(names).toContain('Error Handler')
    expect(names).toHaveLength(6)
  })

  it('does not loop forever on a cycle', () => {
    const cyclic = { ...flow, edges: [...flow.edges, { sourceRef: 'End_1', targetRef: 'Sender_1' }] }
    expect(orderSteps(cyclic)).toHaveLength(5)
  })

  it('returns an empty list for a flow with no steps', () => {
    expect(orderSteps({ steps: {}, edges: [] })).toEqual([])
    expect(orderSteps(null)).toEqual([])
  })
})

describe('stepConfigRows', () => {
  it('keeps spec-relevant config and drops internal properties', () => {
    const rows = stepConfigRows(flow.steps.Receiver_1)
    const labels = rows.map(r => r.label)
    expect(labels).toContain('HTTP Method')
    expect(labels).toContain('Timeout (ms)')
    expect(labels).toContain('Credential Alias')
    // Raw Camel internals must not leak into a client-facing document
    expect(rows.some(r => r.value === 'should-not-appear')).toBe(false)
  })

  it('skips object-valued config so tables never render [object Object]', () => {
    const rows = stepConfigRows(flow.steps.CM_1)
    expect(rows.every(r => typeof r.value === 'string')).toBe(true)
  })
})

describe('buildSpecFacts', () => {
  const facts = buildSpecFacts(flow)

  it('numbers steps in execution order', () => {
    expect(facts.steps.map(s => s.index)).toEqual([1, 2, 3, 4, 5])
    expect(facts.steps[0].name).toBe('HTTPS Sender')
  })

  it('humanizes the step type for reading', () => {
    expect(facts.steps[1].kindLabel).toBe('Content Modifier')
    expect(facts.steps[2].kindLabel).toBe('Groovy Script')
  })

  it('extracts Content Modifier headers and properties verbatim', () => {
    expect(facts.contentModifiers).toHaveLength(1)
    expect(facts.contentModifiers[0].headers[0]).toMatchObject({ name: 'X-Trace', value: '${id}' })
    expect(facts.contentModifiers[0].properties[0]).toMatchObject({ name: 'amount', value: '100' })
  })

  it('carries Groovy source and its match quality', () => {
    expect(facts.scripts).toHaveLength(1)
    expect(facts.scripts[0].source).toBe('def x = 1')
    expect(facts.scripts[0].match).toBe('exact')
  })

  it('collects credential aliases but never secret values', () => {
    const aliases = facts.security.map(s => s.credentialAlias).filter(Boolean)
    expect(aliases).toContain('MY_CRED')
    // The iFlow XML holds aliases only; assert we didn't invent a secret field
    expect(JSON.stringify(facts.security)).not.toMatch(/password|secret/i)
  })

  it('survives a flow with no steps', () => {
    const empty = buildSpecFacts({ name: 'Empty', steps: {}, edges: [] })
    expect(empty.stepCount).toBe(0)
    expect(empty.steps).toEqual([])
  })
})

describe('factsForPrompt', () => {
  it('caps Groovy source so one long script cannot crowd out the fact sheet', () => {
    const big = {
      ...flow,
      steps: { ...flow.steps, Script_1: { ...flow.steps.Script_1, config: { ...flow.steps.Script_1.config, preview: 'x'.repeat(9000) } } },
    }
    const prompt = factsForPrompt(buildSpecFacts(big))
    expect(prompt.groovyScripts[0].source.length).toBeLessThanOrEqual(2500)
  })

  it('passes step config through as labelled pairs', () => {
    const prompt = factsForPrompt(buildSpecFacts(flow))
    expect(prompt.steps[0].config).toHaveProperty('Adapter', 'HTTPS')
  })
})

describe('generated document layout', () => {
  // The crushed-column bug: without an explicit FIXED layout, Word ignores
  // columnWidths and autofits, collapsing narrow columns until text wraps one
  // character per line. Both conditions below must hold for tables to render.
  it('declares fixed table layout so column widths are honoured', async () => {
    const { buildAiSpecDocx } = await import('../../server/specAiDoc.js')
    const JSZip = (await import('jszip')).default
    const facts = buildSpecFacts(flow)
    const buf = await buildAiSpecDocx({ facts, sections: { messageFlow: 'x' }, meta: {} })
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('word/document.xml').async('string')
    expect(xml).toContain('w:tblLayout')
    expect(xml).toMatch(/w:type="fixed"/)
  })

  it('keeps every table inside the printable width', async () => {
    const { buildAiSpecDocx } = await import('../../server/specAiDoc.js')
    const JSZip = (await import('jszip')).default
    const facts = buildSpecFacts(flow)
    const buf = await buildAiSpecDocx({ facts, sections: {}, meta: {} })
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('word/document.xml').async('string')

    // Letter (12240 DXA) minus the 1100 margins set on the section.
    const PRINTABLE = 12240 - 2200
    const gridWidths = [...xml.matchAll(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/g)]
      .map(m => [...m[1].matchAll(/w:w="(\d+)"/g)].reduce((a, c) => a + Number(c[1]), 0))
    expect(gridWidths.length).toBeGreaterThan(0)
    for (const total of gridWidths) expect(total).toBeLessThanOrEqual(PRINTABLE)
  })

  it('includes a table of contents field that Word will populate', async () => {
    const { buildAiSpecDocx } = await import('../../server/specAiDoc.js')
    const JSZip = (await import('jszip')).default
    const facts = buildSpecFacts(flow)
    const buf = await buildAiSpecDocx({ facts, sections: {}, meta: {} })
    const zip = await JSZip.loadAsync(buf)
    const doc = await zip.file('word/document.xml').async('string')
    const settings = await zip.file('word/settings.xml').async('string')
    expect(doc).toMatch(/TOC/)
    // Heading styles are what the TOC indexes — without them it renders empty.
    expect(doc).toMatch(/w:val="Heading1"/)
    // Without updateFields the reader sees an empty field until they press F9.
    expect(settings).toContain('updateFields')
  })
})

describe('document density scales with detail level', () => {
  // The bug this guards against: "detail" (brief/standard/detailed) used to
  // only throttle the AI's prose. The deterministic script/body dumps stayed
  // at a fixed cap regardless — so a document could still be enormous on
  // "brief" if the flow had a few sizeable Groovy scripts. A brief document
  // must now be measurably smaller than a detailed one for the same flow.
  const bigScript = 'def x = 1\n'.repeat(200)   // 200 lines — well past every cap
  const flowWithBigScript = {
    ...flow,
    steps: { ...flow.steps, Script_1: { ...flow.steps.Script_1, config: { ...flow.steps.Script_1.config, preview: bigScript } } },
  }

  async function bodyLineCount(detail) {
    const { buildAiSpecDocx } = await import('../../server/specAiDoc.js')
    const JSZip = (await import('jszip')).default
    const facts = buildSpecFacts(flowWithBigScript)
    const buf = await buildAiSpecDocx({ facts, sections: {}, meta: {}, detail })
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('word/document.xml').async('string')
    return (xml.match(/<w:p[ >]/g) || []).length
  }

  it('brief produces a shorter document than detailed for the same flow', async () => {
    const briefLen = await bodyLineCount('brief')
    const detailedLen = await bodyLineCount('detailed')
    expect(briefLen).toBeLessThan(detailedLen)
  })

  it('defaults to brief when no detail level is given', async () => {
    const { buildAiSpecDocx } = await import('../../server/specAiDoc.js')
    const JSZip = (await import('jszip')).default
    const facts = buildSpecFacts(flowWithBigScript)
    const withDefault = await buildAiSpecDocx({ facts, sections: {}, meta: {} })
    const withExplicitBrief = await buildAiSpecDocx({ facts, sections: {}, meta: {}, detail: 'brief' })
    const zip1 = await JSZip.loadAsync(withDefault)
    const zip2 = await JSZip.loadAsync(withExplicitBrief)
    const xml1 = await zip1.file('word/document.xml').async('string')
    const xml2 = await zip2.file('word/document.xml').async('string')
    expect(xml1.length).toBe(xml2.length)
  })

  it('merges Content Modifier headers and properties into one table instead of two', async () => {
    const { buildAiSpecDocx } = await import('../../server/specAiDoc.js')
    const JSZip = (await import('jszip')).default
    const facts = buildSpecFacts(flow)   // flow.CM_1 has one header and one property
    const buf = await buildAiSpecDocx({ facts, sections: {}, meta: {} })
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file('word/document.xml').async('string')
    // One combined table has a "Kind" column with both "Header" and "Property" rows.
    expect(xml).toContain('Kind')
    expect(xml).toContain('Header')
    expect(xml).toContain('Property')
  })
})
