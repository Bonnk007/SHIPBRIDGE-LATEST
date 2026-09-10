// Multi-flow specifications.
//
// A single business process often spans several iFlows — a main flow plus the
// sub-flows it calls over ProcessDirect (splitters, enrichers, a shared mail
// alert flow). Documenting that as seven disconnected files loses the thing a
// maintainer most needs: how they fit together.
//
// Two shapes are supported, because different clients expect different things:
//
//   COMBINED  — one document. Shared front matter (title, version history,
//               business context, stakeholders, GO-Live, overall architecture)
//               written once, then the per-flow block repeated for each flow.
//
//   SEPARATE  — one document per flow, plus a linking overview document that
//               lists the flows and how they call each other. Delivered as a
//               zip.
//
// Both are driven from the same resolved flow set, so the two can't disagree
// about which flows are in scope or how they're connected.

import JSZip from 'jszip'
import { generateFromBuffer, expandImplSteps, healSplitTokens } from './specDocx.js'

const START = '{{FLOW_SECTION_START}}'
const END   = '{{FLOW_SECTION_END}}'

// Split the template into the shared prologue, the repeatable per-flow block,
// and whatever follows it. Templates without markers (a user's own uploaded
// .docx) have no per-flow block — those stay single-flow, which is correct
// rather than a failure.
export function splitFlowBlock(xml) {
  const a = xml.indexOf(START)
  const b = xml.indexOf(END)
  if (a === -1 || b === -1 || b < a) return null

  // Cut on paragraph boundaries so we never split a <w:p> in half.
  const blockStart = xml.lastIndexOf('<w:p', a)
  const afterEnd = xml.indexOf('</w:p>', b)
  if (blockStart === -1 || afterEnd === -1) return null
  const blockEnd = afterEnd + '</w:p>'.length

  return {
    head: xml.slice(0, blockStart),
    block: xml.slice(blockStart, blockEnd),
    tail: xml.slice(blockEnd),
  }
}

// Remove the marker paragraphs themselves — they're structural, never printed.
function stripMarkers(xml) {
  return xml
    .replace(/<w:p[ >][^<]*?(?:<[^>]+>)*?\{\{FLOW_SECTION_(?:START|END)\}\}(?:<[^>]+>)*?<\/w:p>/g, '')
    .split(START).join('')
    .split(END).join('')
}

// Substitute one flow's values into a cloned block. Image tokens are suffixed
// per flow (IMG_GROOVY -> IMG_GROOVY__2) so seven flows don't all compete for
// the same screenshot slot; the caller sends images with matching slots.
// The FIRST flow keeps unsuffixed slots, which is what makes a one-flow
// document byte-for-byte the same as before this feature existed.
function fillBlock(block, flow, index, numbering) {
  let out = block

  // Point this flow's implementation list at its own numbering instance so it
  // restarts at 1 instead of continuing the previous flow's list.
  if (numbering?.numIds && numbering.baseNumId && index > 0) {
    out = out.replace(
      new RegExp(`<w:numId w:val="${numbering.baseNumId}"\\s*/>`, 'g'),
      `<w:numId w:val="${numbering.numIds[index]}"/>`)
  }

  // Implementation steps expand within the block, so each flow gets its own
  // numbered list rather than one list shared across all of them.
  out = expandImplSteps(out, flow.values || {})

  // Per-flow heading and how this flow is reached.
  out = out.split('{{FLOW_HEADING}}').join(xmlEscape(flow.heading || flow.name || `Flow ${index + 1}`))
  out = out.split('{{FLOW_ENTRY}}').join(xmlEscape(flow.entryNote || ''))

  // Image slots: suffix for every flow after the first.
  if (index > 0) {
    out = out.replace(/\{\{(IMG_[A-Z0-9_]*)\}\}/g, (_, name) => `{{${name}__${index + 1}}}`)
  }

  // Text tokens for this flow. Arrays (IMPL_STEPS) were consumed above.
  for (const [key, val] of Object.entries(flow.values || {})) {
    if (Array.isArray(val)) continue
    out = out.split(`{{${key}}}`).join(xmlEscape(val ?? ''))
  }
  return out
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Replace the single per-flow block with one clone per flow.
export function expandFlowSections(xml, flows, numbering = null) {
  const parts = splitFlowBlock(xml)
  if (!parts) return xml                       // template has no per-flow block
  if (!flows?.length) return stripMarkers(xml)

  const blocks = flows.map((f, i) => fillBlock(parts.block, f, i, numbering)).join('')
  return stripMarkers(parts.head + blocks + parts.tail)
}

// ── Combined document ─────────────────────────────────────────────────────

// Each cloned block reuses the template's list numId, which makes Word treat
// all seven flows' implementation steps as ONE continuous list — flow 2 starts
// at 4, flow 3 at 9. Each flow needs its own numbering instance pointing at the
// same abstract list but with startOverride, so every flow restarts at 1.
//
// Returns the patched numbering.xml plus the numId assigned to each flow.
function addPerFlowNumbering(numberingXml, baseNumId, flowCount) {
  if (!numberingXml || flowCount < 2) return { xml: numberingXml, numIds: null }

  const baseDef = numberingXml.match(new RegExp(`<w:num w:numId="${baseNumId}"[^>]*>([\\s\\S]*?)</w:num>`))
  if (!baseDef) return { xml: numberingXml, numIds: null }
  const abstractId = (baseDef[1].match(/<w:abstractNumId w:val="(\d+)"/) || [])[1]
  if (!abstractId) return { xml: numberingXml, numIds: null }

  const used = [...numberingXml.matchAll(/<w:num w:numId="(\d+)"/g)].map(m => +m[1])
  let next = Math.max(0, ...used) + 1

  const numIds = [baseNumId]          // flow 1 keeps the original
  let additions = ''
  for (let i = 1; i < flowCount; i++) {
    const id = next++
    numIds.push(String(id))
    additions +=
      `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractId}"/>` +
      `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`
  }
  return { xml: numberingXml.replace('</w:numbering>', additions + '</w:numbering>'), numIds }
}

export async function buildCombinedDocx({ templateBuffer, shared, flows, adapters, images }) {
  const zip = await JSZip.loadAsync(templateBuffer)
  const docFile = zip.file('word/document.xml')
  if (!docFile) throw new Error('Not a valid .docx — missing word/document.xml')

  let xml = healSplitTokens(await docFile.async('string'))

  // Work out which list the implementation steps use, then mint one numbering
  // instance per flow so each flow's steps restart at 1.
  const parts = splitFlowBlock(xml)
  const baseNumId = parts
    ? (parts.block.match(/<w:numId w:val="(\d+)"/) || [])[1]
    : null
  let numIds = null
  const numFile = zip.file('word/numbering.xml')
  if (numFile && baseNumId && flows?.length > 1) {
    const patched = addPerFlowNumbering(await numFile.async('string'), baseNumId, flows.length)
    if (patched.numIds) {
      zip.file('word/numbering.xml', patched.xml)
      numIds = patched.numIds
    }
  }

  xml = expandFlowSections(xml, flows, { baseNumId, numIds })
  zip.file('word/document.xml', xml)

  // Reuse the proven single-document pipeline for images + shared tokens.
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  return generateFromBuffer(buf, shared || {}, adapters, images)
}

// The overview that ties separate documents together. This is the part that
// separate-per-flow delivery otherwise loses entirely: which flows make up the
// process, and how they call each other. Code-generated rather than
// template-substituted because it's an index, not a spec — forcing it into the
// spec template would leave most sections empty.
export async function buildOverviewDocx({ shared, flows }) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
          Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle } = await import('docx')

  const FONT = 'Calibri', ACCENT = '2F5496', HEADER_BG = 'DEE6F1'
  const p = (t, o = {}) => new Paragraph({
    spacing: { after: o.after ?? 120 }, alignment: o.align,
    children: [new TextRun({ text: String(t ?? ''), font: FONT, size: o.size ?? 21, bold: o.bold, italics: o.italics, color: o.color })],
  })
  const cell = (t, { bold = false, bg = null, width = 2400 } = {}) => new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: bg ? { type: ShadingType.CLEAR, fill: bg } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: String(t ?? ''), font: FONT, size: 19, bold })] })],
  })
  const table = (headers, rows, widths) => new Table({
    columnWidths: widths, width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'B4C6E7' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'B4C6E7' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'B4C6E7' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'B4C6E7' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'D6E0F0' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'D6E0F0' },
    },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((t, i) => cell(t, { bold: true, bg: HEADER_BG, width: widths[i] })) }),
      ...rows.map(r => new TableRow({ children: r.map((t, i) => cell(t, { width: widths[i] })) })),
    ],
  })

  const body = [
    new Paragraph({ spacing: { after: 60 }, alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'Integration Overview', font: FONT, size: 40, bold: true, color: ACCENT })] }),
    new Paragraph({ spacing: { after: 300 }, alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: shared?.INTERFACE_NAME || 'Integration Process', font: FONT, size: 28, color: '444444' })] }),
    table(['Field', 'Value'], [
      ['Interface', shared?.INTERFACE_NAME || '—'],
      ['Version', shared?.VERSION || '—'],
      ['Author', shared?.AUTHOR || '—'],
      ['Reviewer', shared?.REVIEWER || '—'],
      ['Date', shared?.REV_DATE || '—'],
      ['GO-Live', shared?.GO_LIVE || '—'],
      ['Flows in scope', String(flows.length)],
    ], [2600, 6400]),
  ]

  if (shared?.BUSINESS_CONTEXT) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 140 },
      children: [new TextRun({ text: 'Business Context', font: FONT, bold: true, color: ACCENT })] }))
    body.push(p(`This Interface is used to ${shared.BUSINESS_CONTEXT} via Cloud integration (CI).`))
  }
  if (shared?.ARCHITECTURE) {
    body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 140 },
      children: [new TextRun({ text: 'Solution Design', font: FONT, bold: true, color: ACCENT })] }))
    body.push(p(shared.ARCHITECTURE))
  }

  body.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 320, after: 140 },
    children: [new TextRun({ text: 'Integration Flows', font: FONT, bold: true, color: ACCENT })] }))
  body.push(p('Each flow below is documented in its own specification. How they connect is recorded here.',
    { italics: true, color: '666666' }))
  body.push(table(
    ['#', 'Flow', 'How it is reached', 'Document'],
    flows.map((f, i) => [
      String(i + 1),
      f.name || f.id,
      f.entryNote || '—',
      `${safeName(f.name || `flow_${i + 1}`)}.docx`,
    ]),
    [500, 2600, 3900, 2000],
  ))

  const doc = new Document({
    creator: 'ShipBridge',
    title: `Integration Overview — ${shared?.INTERFACE_NAME || ''}`,
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } }, children: body }],
  })
  return Packer.toBuffer(doc)
}

// ── Separate documents ────────────────────────────────────────────────────

// One document per flow, plus an overview that records how they connect —
// which is the part that would otherwise live only in someone's head.
export async function buildSeparateDocs({ templateBuffer, shared, flows, adaptersByFlow, imagesByFlow }) {
  const out = []

  // The linking overview goes first so it sorts to the top of the zip.
  out.push({ name: '00_Integration_Overview.docx', buffer: await buildOverviewDocx({ shared, flows }) })

  for (let i = 0; i < flows.length; i++) {
    const f = flows[i]
    // Each document is a normal single-flow document: strip the markers and
    // fill the block with just this flow's values.
    const zip = await JSZip.loadAsync(templateBuffer)
    let xml = await zip.file('word/document.xml').async('string')
      xml = healSplitTokens(xml)
    xml = expandFlowSections(xml, [{ ...f, heading: f.heading || f.name }])
    zip.file('word/document.xml', xml)
    const base = await zip.generateAsync({ type: 'nodebuffer' })

    const values = { ...(shared || {}), ...(f.values || {}), INTERFACE_NAME: f.name || shared?.INTERFACE_NAME }
    const buf = await generateFromBuffer(base, values, adaptersByFlow?.[f.id], imagesByFlow?.[f.id] || [])
    out.push({ name: `${String(i + 1).padStart(2, '0')}_${safeName(f.name || `flow_${i + 1}`)}.docx`, buffer: buf })
  }

  return out
}

function safeName(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'document'
}

// Zip a set of generated documents for download as one file.
export async function zipDocuments(docs) {
  const zip = new JSZip()
  for (const d of docs) zip.file(d.name, d.buffer)
  return zip.generateAsync({ type: 'nodebuffer' })
}
