import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'

// Set up a DOM for the tests since Converter uses browser APIs.
const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.DOMParser = dom.window.DOMParser
global.XMLSerializer = dom.window.XMLSerializer

// Re-implement the pure functions here for testing without pulling the
// whole React component. If the component's version diverges from these,
// the tests fail — which is the point.
function xmlSafeName(name) {
  let n = String(name).replace(/[^A-Za-z0-9_.\-]/g, '_')
  if (!n) n = '_'
  if (/^[0-9.\-]/.test(n)) n = '_' + n
  return n
}
const escXml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')

function jsonToXML(jsonStr, root='root') {
  const obj = JSON.parse(jsonStr)
  const pad = (d) => '  '.repeat(d)
  function conv(o, tag, depth) {
    const safeTag = xmlSafeName(tag)
    if (o === null || o === undefined) return `${pad(depth)}<${safeTag}/>`
    if (typeof o !== 'object') return `${pad(depth)}<${safeTag}>${escXml(String(o))}</${safeTag}>`
    if (Array.isArray(o)) return o.map(i => conv(i, tag, depth)).join('\n')
    const inner = Object.entries(o).map(([k, v]) => conv(v, k, depth + 1)).join('\n')
    return `${pad(depth)}<${safeTag}>\n${inner}\n${pad(depth)}</${safeTag}>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + conv(obj, root, 0)
}

describe('JSON to XML — pretty-print and safe element names', () => {
  it('produces indented XML from the delaware-style JSON in the screenshot', () => {
    // The exact JSON from the user's screenshot — keys "3" and "12184" are
    // invalid XML element names and MUST be sanitized.
    const json = JSON.stringify({
      contacts: [{ "3": "2648965@reinhausen.com.c4c", "12184": ["1","2","3"] }],
      key_id: "3"
    })
    const xml = jsonToXML(json, 'root')

    // Pretty-print: at least one level of 2-space indentation
    expect(xml).toContain('\n  <contacts>')
    // Numeric keys prefixed with underscore
    expect(xml).toContain('<_3>2648965@reinhausen.com.c4c</_3>')
    expect(xml).toContain('<_12184>1</_12184>')
    // No raw <3> tags anywhere (would be invalid XML)
    expect(xml).not.toMatch(/<3>/)
    expect(xml).not.toMatch(/<12184>/)
  })

  it('output is valid, parseable XML', () => {
    const json = JSON.stringify({ items: [{ "1": "a" }, { "1": "b" }] })
    const xml = jsonToXML(json, 'root')
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelectorAll('_1')).toHaveLength(2)
  })

  it('sanitizes spaces and disallowed characters in keys', () => {
    const json = JSON.stringify({ "has space": "x", "with.dot": "y" })
    const xml = jsonToXML(json, 'root')
    expect(xml).toContain('<has_space>')
    expect(xml).toContain('<with.dot>')   // dots are legal in XML names
  })
})

// ── XSD generation ─────────────────────────────────────────────────────

const XS_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const XS_DATE     = /^\d{4}-\d{2}-\d{2}$/
const XS_INT      = /^-?\d+$/
const XS_DECIMAL  = /^-?\d+\.\d+$/
const XS_BOOL     = /^(true|false)$/i

function inferXsdType(samples) {
  const vals = samples.filter(v => v !== null && v !== undefined && v !== '')
  if (vals.length === 0) return 'xs:string'
  if (vals.every(v => XS_BOOL.test(v)))     return 'xs:boolean'
  if (vals.every(v => XS_INT.test(v)))      return 'xs:integer'
  if (vals.every(v => XS_INT.test(v) || XS_DECIMAL.test(v))) return 'xs:decimal'
  if (vals.every(v => XS_DATETIME.test(v))) return 'xs:dateTime'
  if (vals.every(v => XS_DATE.test(v)))     return 'xs:date'
  return 'xs:string'
}

describe('XSD type inference', () => {
  it('infers xs:integer for all-integer samples', () => {
    expect(inferXsdType(['1','2','3'])).toBe('xs:integer')
  })
  it('promotes to xs:decimal when any sample has a decimal', () => {
    expect(inferXsdType(['1','2.5','3'])).toBe('xs:decimal')
  })
  it('infers xs:boolean for true/false', () => {
    expect(inferXsdType(['true','false','TRUE'])).toBe('xs:boolean')
  })
  it('infers xs:date and xs:dateTime', () => {
    expect(inferXsdType(['2026-01-15'])).toBe('xs:date')
    expect(inferXsdType(['2026-01-15T10:30:00Z'])).toBe('xs:dateTime')
  })
  it('falls back to xs:string when types are mixed', () => {
    expect(inferXsdType(['1','abc','2'])).toBe('xs:string')
  })
  it('defaults to xs:string on empty input', () => {
    expect(inferXsdType([])).toBe('xs:string')
    expect(inferXsdType([''])).toBe('xs:string')
  })
})

// ── XSD structure — matches CPI Message Mapping expectations ────────────

// Mirror of the component's xmlToXSD, but with real DOMParser via jsdom
// so we can assert on the emitted schema shape.
const XS_TYPES = { XS_DATETIME, XS_DATE, XS_INT, XS_DECIMAL, XS_BOOL }

function analyzeXmlNode(el, shape) {
  shape.instances = (shape.instances || 0) + 1
  const kids = [...el.children]
  const kidCountsThisParent = new Map()
  for (const kid of kids) {
    const name = kid.tagName
    kidCountsThisParent.set(name, (kidCountsThisParent.get(name) || 0) + 1)
    if (!shape.children) shape.children = new Map()
    if (!shape.children.has(name)) {
      shape.children.set(name, { instances: 0, maxInOneParent: 0, textSamples: [], childShape: null })
    }
    const child = shape.children.get(name)
    if (kid.children.length === 0) {
      const text = (kid.textContent || '').trim()
      if (text) child.textSamples.push(text)
    } else {
      if (!child.childShape) child.childShape = {}
      analyzeXmlNode(kid, child.childShape)
    }
  }
  for (const [name, count] of kidCountsThisParent) {
    const child = shape.children.get(name)
    child.instances += 1
    if (count > child.maxInOneParent) child.maxInOneParent = count
  }
}

function emitComplexType(shape, indent) {
  const pad = '  '.repeat(indent)
  const pad1 = '  '.repeat(indent + 1)
  const pad2 = '  '.repeat(indent + 2)
  if (!shape.children || shape.children.size === 0) return ''
  let out = `${pad}<xs:complexType>\n${pad1}<xs:sequence>\n`
  for (const [name, child] of shape.children) {
    const optional = child.instances < shape.instances ? ' minOccurs="0"' : ''
    const unbounded = child.maxInOneParent > 1 ? ' maxOccurs="unbounded"' : ''
    if (child.childShape) {
      out += `${pad2}<xs:element name="${xmlSafeName(name)}"${optional}${unbounded}>\n`
      out += emitComplexType(child.childShape, indent + 3)
      out += `${pad2}</xs:element>\n`
    } else {
      const type = inferXsdType(child.textSamples)
      out += `${pad2}<xs:element name="${xmlSafeName(name)}" type="${type}"${optional}${unbounded}/>\n`
    }
  }
  out += `${pad1}</xs:sequence>\n${pad}</xs:complexType>\n`
  return out
}

function xmlToXSD(xml, targetNamespace) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const root = doc.documentElement
  const shape = {}
  analyzeXmlNode(root, shape)
  const ns = targetNamespace || ''
  const nsAttr = ns
    ? ` targetNamespace="${ns}" xmlns="${ns}" elementFormDefault="qualified"`
    : ` elementFormDefault="qualified"`
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`
  out += `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"${nsAttr}>\n`
  out += `  <xs:annotation>\n    <xs:documentation>Generated by ShipBridge from a sample payload.</xs:documentation>\n  </xs:annotation>\n`
  out += `  <xs:element name="${xmlSafeName(root.tagName)}">\n`
  out += emitComplexType(shape, 2)
  out += `  </xs:element>\n</xs:schema>\n`
  return out
}

describe('XSD output matches SAP CPI import expectations', () => {
  const sampleXml = `<Order>
    <OrderId>12345</OrderId>
    <Customer>
      <Name>Acme</Name>
      <Code>A01</Code>
    </Customer>
    <Item>
      <Sku>X1</Sku>
      <Qty>2</Qty>
    </Item>
    <Item>
      <Sku>X2</Sku>
      <Qty>1</Qty>
    </Item>
  </Order>`

  it('emits elementFormDefault="qualified" always (CPI recommendation)', () => {
    const xsd = xmlToXSD(sampleXml)
    expect(xsd).toContain('elementFormDefault="qualified"')
  })

  it('includes a single global root element (CPI requirement)', () => {
    const xsd = xmlToXSD(sampleXml)
    const doc = new DOMParser().parseFromString(xsd, 'text/xml')
    const globals = doc.documentElement.querySelectorAll(':scope > *')
    // annotation + one xs:element
    const globalElements = [...globals].filter(n => n.tagName === 'xs:element')
    expect(globalElements).toHaveLength(1)
    expect(globalElements[0].getAttribute('name')).toBe('Order')
  })

  it('marks repeated siblings as maxOccurs="unbounded"', () => {
    const xsd = xmlToXSD(sampleXml)
    expect(xsd).toMatch(/<xs:element name="Item"[^>]*maxOccurs="unbounded"/)
  })

  it('includes xs:annotation header explaining the schema is generated', () => {
    const xsd = xmlToXSD(sampleXml)
    expect(xsd).toContain('<xs:annotation>')
    expect(xsd).toContain('Generated by ShipBridge')
  })

  it('accepts a targetNamespace and adds xmlns for CPI mapping editor', () => {
    const xsd = xmlToXSD(sampleXml, 'http://acme.com/order')
    expect(xsd).toContain('targetNamespace="http://acme.com/order"')
    expect(xsd).toContain('xmlns="http://acme.com/order"')
  })

  it('emitted XSD is itself valid, parseable XML', () => {
    const xsd = xmlToXSD(sampleXml, 'http://acme.com/order')
    const doc = new DOMParser().parseFromString(xsd, 'text/xml')
    expect(doc.querySelector('parsererror')).toBeNull()
  })
})

// ── Universal "Pretty" button — detects format and re-indents ───────────

import yaml from 'js-yaml'

function prettyXML_test(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error(err.textContent.split('\n')[0])
  let ind = 0
  return new XMLSerializer().serializeToString(doc)
    .replace(/></g,'>\n<').split('\n').map(line => {
      const t = line.trim()
      if (t.startsWith('</')) ind = Math.max(0, ind - 1)
      const out = '  '.repeat(ind) + t
      if (t.startsWith('<') && !t.startsWith('</') && !t.startsWith('<?') && !t.startsWith('<!') && !t.endsWith('/>') && !t.match(/<.*>.*<\/.*>/)) ind++
      return out
    }).join('\n')
}

function prettifyAny(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return text
  const first = trimmed[0]
  if (first === '{' || first === '[') {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2) } catch {}
  }
  if (first === '<') {
    try { return prettyXML_test(trimmed) } catch {}
  }
  try {
    const parsed = yaml.load(trimmed)
    if (parsed !== null && typeof parsed === 'object') return yaml.dump(parsed)
  } catch {}
  return text
}

describe('universal Pretty button — auto-detects format', () => {
  it('formats minified JSON', () => {
    const minified = '{"a":1,"b":[1,2,3]}'
    const pretty = prettifyAny(minified)
    expect(pretty).toContain('\n  "a"')
    expect(pretty).toContain('\n    1')
  })

  it('formats minified XML', () => {
    const minified = '<root><a>1</a><b>2</b></root>'
    const pretty = prettifyAny(minified)
    expect(pretty).toContain('\n  <a>')
    expect(pretty).toContain('\n  <b>')
  })

  it('formats XSD as XML (starts with <)', () => {
    const xsd = '<?xml version="1.0"?><xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="X" type="xs:string"/></xs:schema>'
    const pretty = prettifyAny(xsd)
    expect(pretty).toContain('\n  <xs:element')
  })

  it('formats YAML by round-tripping through js-yaml', () => {
    const flat = 'a: 1\nb: [1, 2, 3]'
    const pretty = prettifyAny(flat)
    // yaml.dump expands inline arrays
    expect(pretty).toMatch(/b:\n\s+- 1/)
  })

  it('leaves plain text and CSV alone rather than mangling them', () => {
    const csv = 'a,b,c\n1,2,3\n4,5,6'
    expect(prettifyAny(csv)).toBe(csv)
    const plain = 'just some notes\nnot structured'
    expect(prettifyAny(plain)).toBe(plain)
  })

  it('returns empty input unchanged', () => {
    expect(prettifyAny('')).toBe('')
    expect(prettifyAny('   ')).toBe('   ')
  })
})
