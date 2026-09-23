import { describe, it, expect } from 'vitest'
import { comparePackages, _internal } from '../lib/packageCompare.js'
import { _internal as parserInternal, parseJavaProps, parseMmap, parseValueMapping } from '../lib/packageParser.js'

const { diffMeta, diffFileInventory, diffSubProcesses, diffMappings, diffParameters, diffFieldMappings, diffValueMappings, diffJars } = _internal
const { parseManifest, parseJavaProps: parseJP } = parserInternal

// ── Helpers ───────────────────────────────────────────────────────────────
function pkg(overrides = {}) {
  return {
    type: 'package',
    zipName: 'test.zip',
    meta: { bundleName: 'test', bundleVersion: '1.0.0', bundleType: 'IntegrationFlow', nodeType: 'IFLMAP', description: '' },
    parameters: {},
    subProcesses: {},
    mappings: {},
    scripts: {},
    schemas: {},
    files: [],
    ...overrides,
  }
}

function subProc(id, name, steps = {}, edges = []) {
  return { id, name, steps, edges, stepCount: Object.keys(steps).length, edgeCount: edges.length }
}

const step = (id, name, kind, config = {}) => ({ id, name, kind, config })

// ── MANIFEST parsing ──────────────────────────────────────────────────────

describe('parseManifest', () => {
  it('extracts bundle name, version, and type', () => {
    const text = [
      'Manifest-Version: 1.0',
      'Bundle-Name: my.package.flow_01',
      'Bundle-Version: 1.0.18',
      'SAP-BundleType: IntegrationFlow',
      'SAP-NodeType: IFLMAP',
    ].join('\r\n')
    const m = parseManifest(text)
    expect(m.bundleName).toBe('my.package.flow_01')
    expect(m.bundleVersion).toBe('1.0.18')
    expect(m.bundleType).toBe('IntegrationFlow')
    expect(m.nodeType).toBe('IFLMAP')
  })

  it('handles continuation lines (value wrapped with leading space)', () => {
    const text = 'Import-Package: com.sap.esb,\r\n org.apache.camel\r\nBundle-Version: 2.0.0'
    const m = parseManifest(text)
    expect(m.bundleVersion).toBe('2.0.0')
  })

  it('returns empty strings for missing manifest', () => {
    const m = parseManifest(null)
    expect(m.bundleName).toBe('')
    expect(m.bundleVersion).toBe('')
  })
})

// ── Java properties parsing ──────────────────────────────────────────────

describe('parseJavaProps', () => {
  it('parses key=value pairs', () => {
    const text = 'Hostname=https://api.example.com\nTimeout=30000'
    const p = parseJavaProps(text)
    expect(p.Hostname).toBe('https://api.example.com')
    expect(p.Timeout).toBe('30000')
  })

  it('handles escaped spaces in keys (CPI style)', () => {
    const text = 'Timeout\\ API\\ PO=120000'
    const p = parseJavaProps(text)
    expect(p['Timeout API PO']).toBe('120000')
  })

  it('skips comments and blank lines', () => {
    const text = '#comment\n\nkey=val'
    const p = parseJavaProps(text)
    expect(Object.keys(p)).toEqual(['key'])
  })

  it('returns empty object for null input', () => {
    expect(parseJavaProps(null)).toEqual({})
  })
})

// ── mmap parsing ─────────────────────────────────────────────────────────

describe('parseMmap', () => {
  const simpleMmap = `
    <xiObj xmlns="urn:sap-com:xi">
      <generic><lnks>
        <lnkRole role="SOURCE_IFR_MESS"><lnk><key typeID="xsd"><elem>Source.xsd</elem><elem>src/main/resources/xsd</elem><elem>Root</elem></key></lnk></lnkRole>
        <lnkRole role="TARGET_IFR_MESS"><lnk><key typeID="xsd"><elem>Target.xsd</elem><elem>src/main/resources/xsd</elem><elem>Root</elem></key></lnk></lnkRole>
      </lnks></generic>
      <content><tr:XiTrafo xmlns:tr="urn:sap-com:xi:mapping:xitrafo">
        <tr:Multiplicity>1:1</tr:Multiplicity>
        <tr:MetaData><mappingtool><project><transformation>
          <brick path="/Root/Record/Name" type="Dst">
            <arg><brick path="/Root/Record/Name" type="Src"/></arg>
          </brick>
          <brick path="/Root/Record/Amount" type="Dst">
            <arg><brick fname="multiply" fns="dflt" type="Func">
              <arg><brick path="/Root/Record/Amount" type="Src"/></arg>
              <arg pin="1"><brick fname="const" fns="dflt" type="Func">
                <bindings><param name="value"><value>100</value></param></bindings>
              </brick></arg>
            </brick></arg>
          </brick>
        </transformation></project></mappingtool></tr:MetaData>
      </tr:XiTrafo></content>
    </xiObj>
  `

  it('extracts source and target message types', () => {
    const r = parseMmap(simpleMmap)
    expect(r.source).toContain('Source.xsd')
    expect(r.target).toContain('Target.xsd')
  })

  it('extracts multiplicity', () => {
    expect(parseMmap(simpleMmap).multiplicity).toBe('1:1')
  })

  it('extracts direct field mappings (Source→Target)', () => {
    const r = parseMmap(simpleMmap)
    const nameMapping = r.fieldMappings.find(m => m.target === '/Root/Record/Name')
    expect(nameMapping).toBeDefined()
    expect(nameMapping.sources).toContain('/Root/Record/Name')
  })

  it('extracts function mappings with parameters', () => {
    const r = parseMmap(simpleMmap)
    const amtMapping = r.fieldMappings.find(m => m.target === '/Root/Record/Amount')
    expect(amtMapping).toBeDefined()
    expect(amtMapping.functions.some(f => f.name === 'multiply')).toBe(true)
    expect(amtMapping.functions.some(f => f.name === 'const')).toBe(true)
  })

  it('returns empty result for null/invalid input', () => {
    expect(parseMmap(null).fieldMappings).toEqual([])
    expect(parseMmap('not xml at all!!!').fieldMappings).toEqual([])
  })
})

// ── Metadata diff ────────────────────────────────────────────────────────

describe('diffMeta', () => {
  it('reports version changes', () => {
    const a = { bundleName: 'pkg', bundleVersion: '1.0.0' }
    const b = { bundleName: 'pkg', bundleVersion: '1.0.18' }
    const r = diffMeta(a, b)
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0]).toMatchObject({ field: 'bundleVersion', before: '1.0.0', after: '1.0.18' })
  })

  it('returns empty changes for identical metadata', () => {
    const a = { bundleName: 'pkg', bundleVersion: '1.0.0', bundleType: 'IntegrationFlow', nodeType: 'IFLMAP', description: '' }
    expect(diffMeta(a, a).changes).toHaveLength(0)
  })
})

// ── File inventory diff ──────────────────────────────────────────────────

describe('diffFileInventory', () => {
  it('detects added and removed files', () => {
    const a = ['a.groovy', 'b.xsd', 'c.mmap']
    const b = ['a.groovy', 'c.mmap', 'd.edmx']
    const r = diffFileInventory(a, b)
    expect(r.added).toEqual(['d.edmx'])
    expect(r.removed).toEqual(['b.xsd'])
    expect(r.common).toEqual(['a.groovy', 'c.mmap'])
  })

  it('returns empty arrays for identical inventories', () => {
    const f = ['x', 'y']
    const r = diffFileInventory(f, f)
    expect(r.added).toHaveLength(0)
    expect(r.removed).toHaveLength(0)
  })
})

// ── Sub-process diff ─────────────────────────────────────────────────────

describe('diffSubProcesses', () => {
  it('matches sub-processes by ID and diffs their steps', () => {
    const a = { p1: subProc('p1', 'Get Token', { s1: step('s1', 'CM', 'ContentModifier', { bodyType: 'a' }) }) }
    const b = { p1: subProc('p1', 'Get Token', { s1: step('s1', 'CM', 'ContentModifier', { bodyType: 'b' }) }) }
    const r = diffSubProcesses(a, b)
    expect(r.byProcess.p1.changeCount).toBeGreaterThan(0)
    expect(r.added).toHaveLength(0)
    expect(r.removed).toHaveLength(0)
  })

  it('detects added sub-processes', () => {
    const a = { p1: subProc('p1', 'Existing') }
    const b = { p1: subProc('p1', 'Existing'), p2: subProc('p2', 'New Process') }
    const r = diffSubProcesses(a, b)
    expect(r.added).toHaveLength(1)
    expect(r.added[0].name).toBe('New Process')
  })

  it('detects removed sub-processes', () => {
    const a = { p1: subProc('p1', 'Keep'), p2: subProc('p2', 'Remove') }
    const b = { p1: subProc('p1', 'Keep') }
    const r = diffSubProcesses(a, b)
    expect(r.removed).toHaveLength(1)
    expect(r.removed[0].name).toBe('Remove')
  })

  it('detects renamed sub-processes (same ID, different name)', () => {
    const a = { p1: subProc('p1', 'Old Name') }
    const b = { p1: subProc('p1', 'New Name') }
    const r = diffSubProcesses(a, b)
    expect(r.byProcess.p1.renamed).toBe(true)
    expect(r.byProcess.p1.nameA).toBe('Old Name')
    expect(r.byProcess.p1.nameB).toBe('New Name')
  })

  it('reports zero changes for identical sub-processes', () => {
    const proc = subProc('p1', 'Same', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'x' }) })
    const r = diffSubProcesses({ p1: proc }, { p1: proc })
    expect(r.byProcess.p1.changeCount).toBe(0)
  })
})

// ── Mapping diffs ────────────────────────────────────────────────────────

describe('diffMappings', () => {
  const mapA = {
    source: 'A.xsd', target: 'B.xsd', multiplicity: '1:1',
    fieldMappings: [
      { target: '/Root/Name', sources: ['/Root/Name'], functions: [] },
      { target: '/Root/Amount', sources: ['/Root/Amount'], functions: [] },
    ],
  }

  it('detects added mapping files', () => {
    const r = _internal.diffMappings({}, { 'new.mmap': mapA })
    expect(r.added).toHaveLength(1)
    expect(r.added[0].name).toBe('new.mmap')
  })

  it('detects removed mapping files', () => {
    const r = _internal.diffMappings({ 'old.mmap': mapA }, {})
    expect(r.removed).toHaveLength(1)
  })

  it('detects changed field mappings within a file', () => {
    const mapB = {
      ...mapA,
      fieldMappings: [
        { target: '/Root/Name', sources: ['/Root/FirstName'], functions: [] }, // source changed
        { target: '/Root/Amount', sources: ['/Root/Amount'], functions: [] },
        { target: '/Root/Status', sources: ['/Root/Status'], functions: [] }, // added
      ],
    }
    const r = _internal.diffMappings({ 'mm.mmap': mapA }, { 'mm.mmap': mapB })
    expect(r.changed).toHaveLength(1)
    expect(r.changed[0].fieldDiffs.length).toBeGreaterThan(0)
  })

  it('reports no changes for identical mappings', () => {
    const r = _internal.diffMappings({ 'mm.mmap': mapA }, { 'mm.mmap': mapA })
    expect(r.changed).toHaveLength(0)
  })
})

// ── Field-level mapping diffs ────────────────────────────────────────────

describe('diffFieldMappings', () => {
  it('detects added target fields', () => {
    const a = [{ target: '/Root/A', sources: ['/Root/A'], functions: [] }]
    const b = [...a, { target: '/Root/B', sources: ['/Root/B'], functions: [] }]
    const d = diffFieldMappings(a, b)
    expect(d.find(x => x.kind === 'added' && x.target === '/Root/B')).toBeDefined()
  })

  it('detects removed target fields', () => {
    const a = [
      { target: '/Root/A', sources: ['/Root/A'], functions: [] },
      { target: '/Root/B', sources: ['/Root/B'], functions: [] },
    ]
    const b = [{ target: '/Root/A', sources: ['/Root/A'], functions: [] }]
    const d = diffFieldMappings(a, b)
    expect(d.find(x => x.kind === 'removed' && x.target === '/Root/B')).toBeDefined()
  })

  it('detects changed source for a target field', () => {
    const a = [{ target: '/Root/X', sources: ['/Root/OldSource'], functions: [] }]
    const b = [{ target: '/Root/X', sources: ['/Root/NewSource'], functions: [] }]
    const d = diffFieldMappings(a, b)
    expect(d[0]).toMatchObject({ kind: 'changed', target: '/Root/X' })
  })

  it('detects added UDF function', () => {
    const a = [{ target: '/Root/X', sources: ['/Root/X'], functions: [] }]
    const b = [{ target: '/Root/X', sources: ['/Root/X'], functions: [{ name: 'trim', params: [] }] }]
    const d = diffFieldMappings(a, b)
    expect(d[0].kind).toBe('changed')
  })
})

// ── Parameter diffs ──────────────────────────────────────────────────────

describe('diffParameters', () => {
  it('detects added parameters', () => {
    const r = diffParameters({}, { Timeout: '30000' })
    expect(r.added).toHaveLength(1)
    expect(r.added[0]).toMatchObject({ key: 'Timeout', value: '30000' })
  })

  it('detects removed parameters', () => {
    const r = diffParameters({ Old: 'val' }, {})
    expect(r.removed).toHaveLength(1)
  })

  it('detects changed parameter values', () => {
    const r = diffParameters({ Host: 'dev.example.com' }, { Host: 'prd.example.com' })
    expect(r.changed).toHaveLength(1)
    expect(r.changed[0]).toMatchObject({ key: 'Host', before: 'dev.example.com', after: 'prd.example.com' })
  })

  it('returns empty for identical parameters', () => {
    const p = { A: '1', B: '2' }
    const r = diffParameters(p, p)
    expect(r.added).toHaveLength(0)
    expect(r.removed).toHaveLength(0)
    expect(r.changed).toHaveLength(0)
  })
})

// ── Full comparePackages ─────────────────────────────────────────────────

describe('comparePackages', () => {
  it('throws on missing packages', () => {
    expect(() => comparePackages(null, {})).toThrow()
    expect(() => comparePackages({}, null)).toThrow()
  })

  it('returns zero total for identical packages', () => {
    const p = pkg({
      subProcesses: { p1: subProc('p1', 'Main', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'x' }) }) },
      parameters: { Host: 'api.example.com' },
    })
    const r = comparePackages(p, p)
    expect(r.summary.total).toBe(0)
  })

  it('aggregates changes across categories', () => {
    const a = pkg({
      meta: { bundleName: 'pkg', bundleVersion: '1.0.0', bundleType: '', nodeType: '', description: '' },
      subProcesses: { p1: subProc('p1', 'Main', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'a' }) }) },
      parameters: { Host: 'dev.api.com' },
      scripts: { 'a.groovy': 'def x = 1' },
    })
    const b = pkg({
      meta: { bundleName: 'pkg', bundleVersion: '1.0.1', bundleType: '', nodeType: '', description: '' },
      subProcesses: { p1: subProc('p1', 'Main', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'b' }) }) },
      parameters: { Host: 'prd.api.com' },
      scripts: { 'a.groovy': 'def x = 2' },
    })
    const r = comparePackages(a, b)
    expect(r.summary.total).toBeGreaterThanOrEqual(3) // version + step + param + script
    expect(r.summary.byCategory.meta).toBe(1)
    expect(r.summary.byCategory.parameters).toBe(1)
    expect(r.summary.byCategory.scripts).toBe(1)
  })

  it('includes per-process change counts for the picker UI', () => {
    const a = pkg({
      subProcesses: {
        p1: subProc('p1', 'Unchanged', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'x' }) }),
        p2: subProc('p2', 'Changed', { s2: step('s2', 'B', 'ContentModifier', { bodyType: 'old' }) }),
      },
    })
    const b = pkg({
      subProcesses: {
        p1: subProc('p1', 'Unchanged', { s1: step('s1', 'A', 'ContentModifier', { bodyType: 'x' }) }),
        p2: subProc('p2', 'Changed', { s2: step('s2', 'B', 'ContentModifier', { bodyType: 'new' }) }),
      },
    })
    const r = comparePackages(a, b)
    expect(r.processes.byProcess.p1.changeCount).toBe(0)
    expect(r.processes.byProcess.p2.changeCount).toBeGreaterThan(0)
  })
})


// ── Value mapping parsing ────────────────────────────────────────────────

describe('parseValueMapping', () => {
  const elementStyle = `
    <ValueMappings>
      <entry>
        <sourceAgency>SystemA</sourceAgency><sourceIdentifier>CountryCode</sourceIdentifier><sourceValue>US</sourceValue>
        <targetAgency>SystemB</targetAgency><targetIdentifier>CountryName</targetIdentifier><targetValue>United States</targetValue>
      </entry>
      <entry>
        <sourceAgency>SystemA</sourceAgency><sourceIdentifier>CountryCode</sourceIdentifier><sourceValue>IN</sourceValue>
        <targetAgency>SystemB</targetAgency><targetIdentifier>CountryName</targetIdentifier><targetValue>India</targetValue>
      </entry>
    </ValueMappings>`

  it('extracts source and target values per entry', () => {
    const r = parseValueMapping(elementStyle)
    expect(r.entries).toHaveLength(2)
    const us = r.entries.find(e => e.sourceValue === 'US')
    expect(us.targetValue).toBe('United States')
    expect(us.sourceIdentifier).toBe('CountryCode')
  })

  it('collects the agencies involved', () => {
    const r = parseValueMapping(elementStyle)
    expect(r.agencies).toEqual(['SystemA', 'SystemB'])
  })

  it('returns empty for null or non-value-mapping XML', () => {
    expect(parseValueMapping(null).entries).toEqual([])
    expect(parseValueMapping('<other><thing/></other>').entries).toEqual([])
  })

  // These lock in the real CPI shape (<vm><group><entry/><entry/></group></vm>)
  // — the one shipping in every tenant export. Getting this wrong here means
  // Compare silently reports "no changes" on files that actually differ.
  it('reads the real CPI <vm><group> shape', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <vm version="2.0">
      <group id="g1">
        <entry><agency>EBMS</agency><schema>OrgGL</schema><value>10-1485102010100</value></entry>
        <entry><agency>S4HC</agency><schema>CostCenter</schema><value>61800104</value></entry>
      </group>
      <group id="g2">
        <entry isDefault="true"><agency>EBMS</agency><schema>OrgGL</schema><value>10-1430300106143</value></entry>
        <entry><agency>S4HC</agency><schema>CostCenter</schema><value>61800112</value></entry>
      </group>
    </vm>`
    const r = parseValueMapping(xml)
    expect(r.groups).toHaveLength(2)
    expect(r.groups[0].source.agency).toBe('EBMS')
    expect(r.groups[0].source.schema).toBe('OrgGL')
    expect(r.groups[0].target.value).toBe('61800104')
    expect(r.groups[1].source.isDefault).toBe(true)
    expect(r.agencies).toEqual(['EBMS', 'S4HC'])
  })

  it('exposes both a groups view and a flat entries view', () => {
    const xml = `<vm><group><entry><agency>A</agency><schema>S</schema><value>x</value></entry>
                 <entry><agency>B</agency><schema>T</schema><value>y</value></entry></group></vm>`
    const r = parseValueMapping(xml)
    expect(r.groups[0].target.value).toBe('y')
    expect(r.entries[0].targetValue).toBe('y')
  })
})

// ── Value mapping diffs ──────────────────────────────────────────────────

describe('diffValueMappings', () => {
  const vm = (entries, agencies = ['A', 'B']) => ({ agencies, entries })
  const e = (src, tgt) => ({
    sourceAgency: 'A', sourceIdentifier: 'Code', sourceValue: src,
    targetAgency: 'B', targetIdentifier: 'Name', targetValue: tgt,
  })

  it('detects an added value mapping file', () => {
    const r = diffValueMappings({}, { 'vm.xml': vm([e('US', 'United States')]) })
    expect(r.added).toHaveLength(1)
    expect(r.added[0].name).toBe('vm.xml')
  })

  it('detects a removed value mapping file', () => {
    const r = diffValueMappings({ 'vm.xml': vm([e('US', 'United States')]) }, {})
    expect(r.removed).toHaveLength(1)
  })

  it('detects a changed translation for an existing code', () => {
    const a = { 'vm.xml': vm([e('US', 'United States')]) }
    const b = { 'vm.xml': vm([e('US', 'USA')]) }
    const r = diffValueMappings(a, b)
    expect(r.changed).toHaveLength(1)
    const d = r.changed[0].entryDiffs[0]
    expect(d.kind).toBe('changed')
    expect(d.before.targetValue).toBe('United States')
    expect(d.after.targetValue).toBe('USA')
  })

  it('detects an added entry inside an existing file', () => {
    const a = { 'vm.xml': vm([e('US', 'United States')]) }
    const b = { 'vm.xml': vm([e('US', 'United States'), e('IN', 'India')]) }
    const r = diffValueMappings(a, b)
    expect(r.changed[0].entryDiffs.find(d => d.kind === 'added').entry.sourceValue).toBe('IN')
  })

  it('detects a removed entry inside an existing file', () => {
    const a = { 'vm.xml': vm([e('US', 'United States'), e('IN', 'India')]) }
    const b = { 'vm.xml': vm([e('US', 'United States')]) }
    const r = diffValueMappings(a, b)
    expect(r.changed[0].entryDiffs.find(d => d.kind === 'removed').entry.sourceValue).toBe('IN')
  })

  it('reports no change for identical value mappings', () => {
    const same = { 'vm.xml': vm([e('US', 'United States')]) }
    const r = diffValueMappings(same, same)
    expect(r.changed).toHaveLength(0)
  })
})

// ── JAR diffs ────────────────────────────────────────────────────────────

describe('diffJars', () => {
  it('detects added, removed and resized libraries', () => {
    const a = { 'old.jar': '100 bytes', 'same.jar': '50 bytes', 'grew.jar': '10 bytes' }
    const b = { 'new.jar': '200 bytes', 'same.jar': '50 bytes', 'grew.jar': '99 bytes' }
    const r = diffJars(a, b)
    expect(r.added.map(x => x.name)).toEqual(['new.jar'])
    expect(r.removed.map(x => x.name)).toEqual(['old.jar'])
    expect(r.changed.map(x => x.name)).toEqual(['grew.jar'])
  })

  it('reports nothing for identical libraries', () => {
    const same = { 'a.jar': '10 bytes' }
    const r = diffJars(same, same)
    expect(r.added.length + r.removed.length + r.changed.length).toBe(0)
  })
})

// ── New artifact types roll into the overall total ───────────────────────

describe('comparePackages counts the new artifact types', () => {
  const base = {
    type: 'package', zipName: 'x.zip',
    meta: { bundleName: 'p', bundleVersion: '1', bundleType: '', nodeType: '', description: '' },
    parameters: {}, subProcesses: {}, mappings: {}, valueMappings: {},
    scripts: {}, xslts: {}, jars: {}, schemas: {}, files: [],
  }

  it('counts value mapping, XSLT and JAR changes in the summary', () => {
    const a = { ...base,
      valueMappings: { 'vm.xml': { agencies: ['A'], entries: [{ sourceAgency: 'A', sourceIdentifier: 'C', sourceValue: 'US', targetAgency: 'B', targetIdentifier: 'N', targetValue: 'United States' }] } },
      xslts: { 't.xsl': '<a/>' },
      jars: { 'lib.jar': '10 bytes' },
    }
    const b = { ...base,
      valueMappings: { 'vm.xml': { agencies: ['A'], entries: [{ sourceAgency: 'A', sourceIdentifier: 'C', sourceValue: 'US', targetAgency: 'B', targetIdentifier: 'N', targetValue: 'USA' }] } },
      xslts: { 't.xsl': '<b/>' },
      jars: { 'lib.jar': '20 bytes' },
    }
    const r = comparePackages(a, b)
    expect(r.summary.byCategory.valueMappings).toBe(1)
    expect(r.summary.byCategory.xslts).toBe(1)
    expect(r.summary.byCategory.jars).toBe(1)
    expect(r.summary.total).toBeGreaterThanOrEqual(3)
  })

  it('stays at zero for two identical packages', () => {
    const r = comparePackages(base, base)
    expect(r.summary.total).toBe(0)
  })
})
