// Build the default ShipBridge template from the client's blank spec document.
//
// The blank document they use has the right structure, styles, headers and
// TOC — but no {{TOKEN}} placeholders, because a human fills it in Word. This
// script inserts the tokens at the correct points so ShipBridge can substitute
// into it while preserving every bit of that formatting.
//
// Kept in the repo (rather than shipping only the output) so that when the
// client revises their blank template, regenerating the ShipBridge version is
// one command instead of an archaeology exercise:
//
//   node scripts/build-default-template.mjs <blank.docx> <out.docx>
//
// Anchors are matched on visible TEXT, not paragraph index, so the script
// survives the client adding or removing paragraphs elsewhere.

import JSZip from 'jszip'
import { readFileSync, writeFileSync } from 'fs'

const IN  = process.argv[2] || 'server/spec_templates/source_blank.docx'
const OUT = process.argv[3] || 'server/spec_templates/motiveminds_template.docx'

const PARA_RE = /<w:p[ >][\s\S]*?<\/w:p>/g

// Visible text of a paragraph, with XML entities decoded — headings like
// "Implementation & Configuration" are stored as "&amp;" and would otherwise
// never match a human-written anchor.
const textOf = (p) => [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
  .map(m => m[1])
  .join('')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
const run = (t, opts = '') => `<w:r>${opts}<w:t xml:space="preserve">${t}</w:t></w:r>`

// A Table of Contents entry repeats every heading's text and appears EARLIER
// in the document than the heading itself — so a naive text match silently
// targets the TOC and all inserted content lands inside the contents listing.
// TOC paragraphs are identifiable by their TOC* style or by carrying field
// instructions (PAGEREF / hyperlinks), so they're excluded from matching.
function isTocPara(p) {
  // TOC1/TOC2/... are contents ENTRIES. TOCHeading is not — this template
  // uses it for the "Interface : :" subtitle, which is a real body paragraph.
  if (/<w:pStyle w:val="TOC\d/i.test(p)) return true
  if (/PAGEREF|<w:instrText/.test(p)) return true
  return false
}

// Find the single body paragraph whose visible text contains `needle`.
// Throws when the anchor is missing OR ambiguous — a silent wrong match
// corrupts the template in a way that only shows up in the rendered output.
function findPara(xml, needle) {
  const hits = (xml.match(PARA_RE) || [])
    .filter(p => !isTocPara(p))
    .filter(p => textOf(p).includes(needle))
  if (!hits.length) throw new Error(`anchor not found: "${needle}"`)
  if (hits.length > 1) {
    const preview = hits.map(h => JSON.stringify(textOf(h).slice(0, 50))).join(' | ')
    throw new Error(`anchor "${needle}" is ambiguous — ${hits.length} matches: ${preview}`)
  }
  return hits[0]
}

// Append a run to the end of the paragraph containing `needle`.
function appendRun(xml, needle, token, opts) {
  const p = findPara(xml, needle)
  return xml.replace(p, p.replace(/<\/w:p>$/, run(token, opts) + '</w:p>'))
}

// Replace the entire visible text of a paragraph with a single token run,
// keeping the paragraph's own formatting (pPr) intact.
function setParaText(xml, needle, token) {
  const p = findPara(xml, needle)
  const pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0]
  const open = p.match(/^<w:p[^>]*>/)[0]
  return xml.replace(p, `${open}${pPr}${run(token)}</w:p>`)
}

// Insert raw paragraph XML directly after the paragraph containing `needle`.
function insertAfter(xml, needle, newXml) {
  const p = findPara(xml, needle)
  return xml.replace(p, p + newXml)
}

// A plain body paragraph carrying one token.
const bodyPara = (token) =>
  `<w:p><w:pPr><w:spacing w:after="60"/><w:rPr><w:sz w:val="20"/></w:rPr></w:pPr>` +
  `<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${token}</w:t></w:r></w:p>`

// A bold label followed by a token on the same line — "Input format: {{X}}".
const labelledPara = (label, token) =>
  `<w:p><w:pPr><w:spacing w:after="60"/><w:rPr><w:sz w:val="20"/></w:rPr></w:pPr>` +
  `<w:r><w:rPr><w:b/><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${label}</w:t></w:r>` +
  `<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${token}</w:t></w:r></w:p>`

// A decimal-numbered list item. numId 1 is a decimal list in this template's
// numbering.xml — the implementation steps in the client's filled examples use
// exactly this style. expandImplSteps clones this paragraph per step.
const numberedPara = (token) =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` +
  `<w:spacing w:after="40"/><w:rPr><w:sz w:val="20"/></w:rPr></w:pPr>` +
  `<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${token}</w:t></w:r></w:p>`

// An empty anchor paragraph for a screenshot slot.
const imgSlot = (token) =>
  `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r><w:t>${token}</w:t></w:r></w:p>`

const zip = await JSZip.loadAsync(readFileSync(IN))
let xml = await zip.file('word/document.xml').async('string')
const before = xml.length

// ── Header ────────────────────────────────────────────────────────────────
xml = appendRun(xml, 'Interface : :', '{{INTERFACE_NAME}}')

// ── Version history table ─────────────────────────────────────────────────
xml = setParaText(xml, '1.0', '{{VERSION}}')
xml = setParaText(xml, 'New Document', '{{CHANGE_DESC}}')
xml = setParaText(xml, 'All', '{{SECTIONS}}')

// The Date / Author / Reviewer cells are empty paragraphs immediately after
// the "Sections" cell, so they can't be found by text — take the next three
// paragraphs in document order.
{
  const paras = xml.match(PARA_RE) || []
  const idx = paras.findIndex(p => textOf(p).includes('{{SECTIONS}}'))
  if (idx === -1) throw new Error('could not locate the Sections cell')
  const tokens = ['{{REV_DATE}}', '{{AUTHOR}}', '{{REVIEWER}}']
  tokens.forEach((tok, k) => {
    const target = paras[idx + 1 + k]
    if (!target || textOf(target).trim()) throw new Error(`expected an empty cell for ${tok}`)
    xml = xml.replace(target, target.replace(/<\/w:p>$/, run(tok) + '</w:p>'))
  })
}

// ── Business Context ──────────────────────────────────────────────────────
// The blank template still carries the sentence from a previous project.
// Rebuild it as the fixed wrapper plus a token for the variable middle.
xml = setParaText(xml, 'This Interface is used to', 'This Interface is used to {{BUSINESS_CONTEXT}} via Cloud integration (CI).')

// ── GO-Live ───────────────────────────────────────────────────────────────
xml = insertAfter(xml, 'GO-Live:', bodyPara('{{GO_LIVE}}'))

// ── Solution Design ───────────────────────────────────────────────────────
// The overall architecture describes the whole landscape and appears once,
// even when the document covers several iFlows.
xml = insertAfter(xml, 'Solution Design',
  bodyPara('Below is the flow for this specific Integration.') +
  bodyPara('{{ARCHITECTURE}}') +
  imgSlot('{{IMG_ARCHITECTURE}}'))

// Everything from here to the end of Configurations is PER FLOW. The markers
// delimit the block that expandFlowSections clones — once per iFlow in the
// document, with each clone's tokens suffixed __1, __2, … so the flows don't
// overwrite each other's values or screenshots.
xml = insertAfter(xml, '{{IMG_ARCHITECTURE}}',
  `<w:p><w:r><w:t>{{FLOW_SECTION_START}}</w:t></w:r></w:p>` +
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>` +
  `<w:r><w:t xml:space="preserve">{{FLOW_HEADING}}</w:t></w:r></w:p>` +
  bodyPara('{{FLOW_ENTRY}}'))

xml = appendRun(xml, 'Package:', '{{PACKAGE_NAME}}')
xml = appendRun(xml, 'Flow:', '{{FLOW_NAME}}')

// Connectivity narrative sits under Package/Flow in the client's filled docs.
xml = insertAfter(xml, 'Flow:',
  labelledPara('Sender Connectivity: ', '{{CONNECTIVITY_SENDER}}') +
  labelledPara('Input format: ', '{{INPUT_FORMAT}}') +
  labelledPara('Receiver Connectivity: ', '{{CONNECTIVITY_RECEIVER}}') +
  labelledPara('Output format: ', '{{OUTPUT_FORMAT}}'))

// ── Implementation & Configuration ────────────────────────────────────────
// Four numbered slots. expandImplSteps clones the first for unlimited steps
// and removes any left over, so the visible count here is not a ceiling.
xml = insertAfter(xml, 'Implementation & Configuration',
  numberedPara('{{IMPL_BULLET_1}}') +
  numberedPara('{{IMPL_BULLET_2}}') +
  numberedPara('{{IMPL_BULLET_3}}') +
  numberedPara('{{IMPL_BULLET_4}}'))

xml = insertAfter(xml, 'Exception Subprocess:', bodyPara('{{EXCEPTION_TEXT}}'))

// ── Screenshot-driven sections ────────────────────────────────────────────
xml = insertAfter(xml, 'Sample input payload', imgSlot('{{IMG_INPUT_PAYLOAD}}'))
xml = insertAfter(xml, 'Message Mapping',      imgSlot('{{IMG_MESSAGE_MAPPING}}'))
xml = insertAfter(xml, 'Groovy scripts',       imgSlot('{{IMG_GROOVY}}'))
xml = insertAfter(xml, 'Output Payload',       imgSlot('{{IMG_OUTPUT_PAYLOAD}}'))

// ── Configurations ────────────────────────────────────────────────────────
xml = insertAfter(xml, 'Sender :', imgSlot('{{IMG_CONFIG_SENDER}}'))
xml = insertAfter(xml, 'Configurations :',
  bodyPara('{{ADAPTER_TABLES}}'))

// Receivers / More subsections don't exist in the blank template — the filled
// examples add them by hand. Add them with their own slots.
xml = insertAfter(xml, '{{IMG_CONFIG_SENDER}}',
  labelledPara('Receivers :', '') + imgSlot('{{IMG_CONFIG_RECEIVER}}') +
  labelledPara('More :', '')      + imgSlot('{{IMG_CONFIG_MORE}}') +
  `<w:p><w:r><w:t>{{FLOW_SECTION_END}}</w:t></w:r></w:p>`)

zip.file('word/document.xml', xml)
const buf = await zip.generateAsync({ type: 'nodebuffer' })
writeFileSync(OUT, buf)

const tokens = [...new Set((xml.match(/\{\{[A-Z][A-Z0-9_]*\}\}/g) || []))]
console.log(`xml ${before} -> ${xml.length} bytes`)
console.log(`wrote ${OUT} (${buf.length} bytes)`)
console.log(`${tokens.length} tokens:`)
tokens.forEach(t => console.log('  ', t))
