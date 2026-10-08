import { describe, it, expect } from 'vitest'
import { groupsToCsv, parseCsvToGroups, parseCsvRows } from '../lib/valueMappingCsv.js'
import { parseValueMapping } from '../lib/packageParser.js'

describe('CSV lexer', () => {
  it('splits simple rows', () => {
    expect(parseCsvRows('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })
  it('handles quoted commas', () => {
    expect(parseCsvRows('"a,b",c')).toEqual([['a,b', 'c']])
  })
  it('handles embedded double quotes', () => {
    expect(parseCsvRows('"say ""hi""",world')).toEqual([['say "hi"', 'world']])
  })
  it('accepts semicolon separator', () => {
    expect(parseCsvRows('a;b\nc;d', ';')).toEqual([['a', 'b'], ['c', 'd']])
  })
  it('drops fully blank rows', () => {
    expect(parseCsvRows('a,b\n\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })
})

describe('groupsToCsv', () => {
  const vm = {
    agencies: ['EBMS', 'S4HC'],
    groups: [
      { id: 'g1', source: { agency: 'EBMS', schema: 'OrgGL', value: '10-1485102010100' },
                  target: { agency: 'S4HC', schema: 'CostCenter', value: '61800104' } },
      { id: 'g2', source: { agency: 'EBMS', schema: 'OrgGL', value: '10-1430300106143' },
                  target: { agency: 'S4HC', schema: 'CostCenter', value: '61800112' } },
    ],
  }
  it('writes an Agency|Schema header and value rows', () => {
    const csv = groupsToCsv(vm)
    expect(csv.split('\n')[0]).toBe('EBMS|OrgGL,S4HC|CostCenter')
    expect(csv.split('\n')[1]).toBe('10-1485102010100,61800104')
    expect(csv.split('\n')).toHaveLength(3)
  })
  it('quotes fields that contain commas', () => {
    const csv = groupsToCsv({ groups: [{
      source: { agency: 'A', schema: 'S', value: 'x,y' }, target: { agency: 'B', schema: 'T', value: 'z' } }] })
    expect(csv).toContain('"x,y"')
  })
  it('returns empty for a mapping with no groups', () => {
    expect(groupsToCsv({ groups: [] })).toBe('')
  })
})

describe('parseCsvToGroups', () => {
  it('parses a header + one row into a group', () => {
    const r = parseCsvToGroups('EBMS|OrgGL,S4HC|CostCenter\n10-1485102010100,61800104')
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].source.agency).toBe('EBMS')
    expect(r.groups[0].source.schema).toBe('OrgGL')
    expect(r.groups[0].target.value).toBe('61800104')
    expect(r.agencies).toEqual(['EBMS', 'S4HC'])
  })
  it('accepts semicolon-separated CSVs (Excel-EU)', () => {
    const r = parseCsvToGroups('A|X;B|Y\nfoo;bar')
    expect(r.groups[0].target.value).toBe('bar')
  })
  it('accepts plain header cells without a pipe', () => {
    const r = parseCsvToGroups('source,target\nfoo,bar')
    expect(r.groups[0].source.agency).toBe('source')
    expect(r.groups[0].source.schema).toBe('')
    expect(r.groups[0].target.value).toBe('bar')
  })
  it('skips blank rows', () => {
    const r = parseCsvToGroups('A|X,B|Y\nfoo,bar\n,\nbaz,qux')
    expect(r.groups.map(g => g.source.value)).toEqual(['foo', 'baz'])
  })
  it('returns empty for empty or invalid input', () => {
    expect(parseCsvToGroups('').groups).toEqual([])
    expect(parseCsvToGroups('only-a-header-no-data').groups).toEqual([])
  })
})

describe('CSV round-trip preserves the value mapping', () => {
  it('vm → csv → vm keeps every group intact', () => {
    const original = parseValueMapping(`<vm>
      <group id="g1"><entry><agency>EBMS</agency><schema>OrgGL</schema><value>a</value></entry>
                     <entry><agency>S4HC</agency><schema>CostCenter</schema><value>1</value></entry></group>
      <group id="g2"><entry><agency>EBMS</agency><schema>OrgGL</schema><value>b</value></entry>
                     <entry><agency>S4HC</agency><schema>CostCenter</schema><value>2</value></entry></group>
    </vm>`)
    const csv = groupsToCsv(original)
    const roundtripped = parseCsvToGroups(csv)
    expect(roundtripped.groups).toHaveLength(2)
    expect(roundtripped.groups[0].source.value).toBe('a')
    expect(roundtripped.groups[1].target.value).toBe('2')
    // Agencies and schemas survive too
    expect(roundtripped.groups[0].source.agency).toBe('EBMS')
    expect(roundtripped.groups[0].target.schema).toBe('CostCenter')
  })
})
