// Spec Document generation via template substitution.
//
// Two modes:
//   1. Default Motiveminds template — bundled in server/spec_templates/
//   2. User-uploaded template — user drops in any .docx with {{TOKEN}} placeholders
//
// The engine is identical for both: load the .docx (a zip), replace {{TOKEN}}
// occurrences in word/document.xml with values from the model, repack.
// This preserves ALL formatting (logo, fonts, headers, page layout) exactly
// because we're modifying the real .docx, not re-building it.

import JSZip from 'jszip'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_TEMPLATE = join(__dirname, 'spec_templates', 'motiveminds_template.docx')

// XML-escape a value before substituting into the document body.
function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Substitute all occurrences of {{TOKEN}} for each key in `values`.
function substituteTokens(xml, values) {
  let out = xml
  for (const [key, val] of Object.entries(values)) {
    // Arrays are structural (IMPL_STEPS) and were already expanded into real
    // paragraphs upstream — stringifying one here would print "a,b,c".
    if (Array.isArray(val)) continue
    const needle = `{{${key}}}`
    // Split-join is safe and doesn't need regex escaping.
    out = out.split(needle).join(xmlEscape(val ?? ''))
  }
  // Anything still unreplaced is a field the author left blank. Print nothing
  // rather than a raw "{{REVIEWER}}" — this document goes to a client, and a
  // visible placeholder is worse than an empty line.
  out = out.replace(/\{\{[A-Z][A-Z0-9_]*\}\}/g, '')
  return out
}

// ── Adapter tables (OOXML) ────────────────────────────────────────────────
// Builds real Word tables from extracted adapter data and swaps them in
// where the template has the {{ADAPTER_TABLES}} anchor paragraph.

const TBL_BORDER = '<w:tcBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/></w:tcBorders>'

function cell(text, { bold = false, width = 2400, shade = null } = {}) {
  const shadeXml = shade ? `<w:shd w:val="clear" w:fill="${shade}"/>` : ''
  const boldXml = bold ? '<w:rPr><w:b/></w:rPr>' : ''
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${TBL_BORDER}${shadeXml}</w:tcPr>` +
    `<w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr><w:r>${boldXml}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p></w:tc>`
}

function headingP(text) {
  return `<w:p><w:pPr><w:spacing w:before="240" w:after="80"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
}

// adapters: [{ direction, type, address, fields: [{label, value}] }]
export function buildAdapterTablesXml(adapters) {
  if (!Array.isArray(adapters) || !adapters.length) return '<w:p><w:r><w:t>No adapters extracted.</w:t></w:r></w:p>'
  let xml = ''
  for (const a of adapters) {
    if (!a || typeof a !== 'object') continue
    const title = `${a.direction === 'Sender' ? 'Sender' : a.direction === 'Receiver' ? 'Receiver' : 'Adapter'} — ${a.type || 'Unknown'}`
    xml += headingP(title)
    // `fields` may arrive as an array of {label,value}, an object map, or be
    // absent/garbage — normalize to array-of-pairs so a bad shape can't throw.
    const fieldPairs = Array.isArray(a.fields)
      ? a.fields.filter(f => f && f.value && f.value !== '(blank)').map(f => [f.label, String(f.value)])
      : (a.fields && typeof a.fields === 'object')
        ? Object.entries(a.fields).filter(([, v]) => v && v !== '(blank)').map(([k, v]) => [k, String(v)])
        : []
    const rows = [['Adapter', a.type || 'Unknown'], ...(a.address ? [['Address', a.address]] : []), ...fieldPairs]
    xml += '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>'
    xml += '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6000"/></w:tblGrid>'
    rows.forEach(([k, v], i) => {
      xml += `<w:tr>${cell(k, { bold: true, width: 3000, shade: i === 0 ? 'DEEBF7' : 'F2F2F2' })}${cell(v, { width: 6000, shade: i === 0 ? 'DEEBF7' : null })}</w:tr>`
    })
    xml += '</w:tbl><w:p/>'
  }
  return xml
}

// Replace the paragraph containing {{ADAPTER_TABLES}} with generated tables.
function injectAdapterTables(xml, adapters) {
  const anchor = '{{ADAPTER_TABLES}}'
  const i = xml.indexOf(anchor)
  if (i === -1) return xml
  const pStart = xml.lastIndexOf('<w:p>', i)
  const pEnd = xml.indexOf('</w:p>', i) + '</w:p>'.length
  if (pStart === -1 || pEnd < pStart) return xml.split(anchor).join('')
  return xml.slice(0, pStart) + buildAdapterTablesXml(adapters) + xml.slice(pEnd)
}

// ── Screenshot / image support ────────────────────────────────────────────
// Users can attach images (architecture diagram, test scenario, error, UAT
// evidence, etc). These are NEVER analyzed for facts (locked decision #9) —
// they're placed at the end of the document with a caption, exactly as
// uploaded. This does not touch the template's own existing images/logo.

const EMU_PER_PX = 9525          // OOXML: 1 px @ 96dpi = 9525 EMU
const MAX_IMG_WIDTH_PX = 560      // fits inside a standard portrait page margin

// Minimal PNG/JPEG dimension readers — no extra dependency needed.
function readPngSize(buf) {
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null // not a PNG signature start
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function readJpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null // not JPEG SOI
  let i = 2
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    // SOF0..SOF15 markers (excluding DHT/JPG/DAC which share the C-range)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5)
      const width = buf.readUInt16BE(i + 7)
      return { width, height }
    }
    const segLen = buf.readUInt16BE(i + 2)
    i += 2 + segLen
  }
  return null
}

function readGifSize(buf) {
  if (buf.length < 10) return null
  const sig = buf.toString('ascii', 0, 3)
  if (sig !== 'GIF') return null
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

// Returns { width, height } in px, scaled down (aspect-preserved) if wider
// than MAX_IMG_WIDTH_PX. Falls back to a safe default if we can't parse it.
function getScaledImageSize(buffer, mime) {
  let raw = null
  if (mime?.includes('png')) raw = readPngSize(buffer)
  else if (mime?.includes('jpeg') || mime?.includes('jpg')) raw = readJpegSize(buffer)
  else if (mime?.includes('gif')) raw = readGifSize(buffer)
  raw = raw || readPngSize(buffer) || readJpegSize(buffer) || readGifSize(buffer)
  if (!raw || !raw.width || !raw.height) raw = { width: 800, height: 450 }
  if (raw.width <= MAX_IMG_WIDTH_PX) return raw
  const scale = MAX_IMG_WIDTH_PX / raw.width
  return { width: MAX_IMG_WIDTH_PX, height: Math.round(raw.height * scale) }
}

function extFromMime(mime) {
  if (mime?.includes('png')) return 'png'
  if (mime?.includes('jpeg') || mime?.includes('jpg')) return 'jpg'
  if (mime?.includes('gif')) return 'gif'
  return 'png'
}

function contentTypeFor(ext) {
  return ext === 'jpg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png'
}

// Make sure [Content_Types].xml declares a Default entry for this extension.
function ensureContentType(xml, ext) {
  if (new RegExp(`<Default Extension="${ext}"`, 'i').test(xml)) return xml
  return xml.replace('</Types>', `<Default Extension="${ext}" ContentType="${contentTypeFor(ext)}"/></Types>`)
}

// ── Token healing ─────────────────────────────────────────────────────────
// Word splits typed text across many <w:r> runs (spell-check markers,
// revision ids), so "{{INTERFACE_NAME}}" as typed by a user frequently does
// NOT exist as a contiguous string in document.xml. For every paragraph
// whose *visible text* contains a {{TOKEN}} that isn't findable in the raw
// XML, we move the paragraph's full text into its first run and empty the
// others — preserving the first run's formatting, which is what Word users
// expect for a token they typed in one style.
export function healSplitTokens(xml) {
  const TOKEN_RE = /\{\{[A-Z][A-Z0-9_]*\}\}/g
  return xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (para) => {
    const texts = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1])
    if (texts.length < 2) return para
    const joined = texts.join('')
    const tokensInJoined = joined.match(TOKEN_RE) || []
    if (!tokensInJoined.length) return para
    const tokensInPieces = texts.flatMap(t => t.match(TOKEN_RE) || [])
    // Every token visible in the joined text is already whole inside a single
    // run → nothing is split, leave the paragraph untouched.
    if (tokensInJoined.length === tokensInPieces.length) return para
    // Collapse: first <w:t> gets all text, the rest are emptied. First run's
    // formatting wins — which matches what the user typed the token in.
    let first = true
    return para.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, () => {
      if (first) { first = false; return `<w:t xml:space="preserve">${joined}</w:t>` }
      return '<w:t xml:space="preserve"></w:t>'
    })
  })
}

// Build the OOXML for one inline image (+ optional italic caption below it).
function imageBlockXml(rId, picId, label, cx, cy, caption) {
  let blocks = `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${picId}" name="${label}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${picId}" name="${label}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  if (caption) {
    blocks += `<w:p><w:pPr><w:spacing w:after="120"/><w:rPr><w:i/><w:sz w:val="18"/></w:rPr></w:pPr><w:r><w:rPr><w:i/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEscape(caption)}</w:t></w:r></w:p>`
  }
  return blocks
}

// Register one image in the package (media file + relationship + content type).
// Returns everything needed to reference it from document.xml.
function registerImage(zip, relsXml, typesXml, img, stamp, i) {
  const ext = extFromMime(img.mime)
  const mediaName = `shipbridge_img_${stamp}_${i}.${ext}`
  zip.file(`word/media/${mediaName}`, Buffer.from(img.base64, 'base64'), { base64: false })
  const rId = `rIdSbImg${stamp}${i}`
  relsXml = relsXml.replace('</Relationships>',
    `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaName}"/></Relationships>`)
  typesXml = ensureContentType(typesXml, ext)
  const { width, height } = getScaledImageSize(Buffer.from(img.base64, 'base64'), img.mime)
  // ST_DrawingElementId is an unsigned 32-bit int — Date.now() alone overflows it.
  const picId = 3000000000 + (stamp % 900000000) + i
  return { relsXml, typesXml, rId, picId, cx: width * EMU_PER_PX, cy: height * EMU_PER_PX }
}

// Find the boundaries of the paragraph containing position `i`.
// Handles both <w:p> and <w:p w:rsidR="..."> forms (real Word docs use the
// latter). Returns null if we can't safely find a whole paragraph.
function paragraphBounds(xml, i) {
  const a = xml.lastIndexOf('<w:p>', i)
  const b = xml.lastIndexOf('<w:p ', i)
  const pStart = Math.max(a, b)
  const pEnd = xml.indexOf('</w:p>', i)
  if (pStart === -1 || pEnd === -1 || pEnd < pStart) return null
  return { pStart, pEnd: pEnd + '</w:p>'.length }
}

// images: [{ base64, mime, category, caption, slot }]
// Two placement modes, applied together:
//   1. slot = an image token name (e.g. IMG_ARCHITECTURE): the paragraph
//      containing {{IMG_ARCHITECTURE}} in the template is replaced by the
//      image at that exact position.
//   2. no slot (or slot not found in the template): appended at the end of
//      the document under a category heading — the manual method.
// Any image tokens left without an assigned image are blanked out.
async function injectImages(zip, xml, images) {
  const list = (images || []).filter(i => i?.base64)
  const stamp = Date.now()
  let relsXml = await zip.file('word/_rels/document.xml.rels').async('string')
  let typesXml = await zip.file('[Content_Types].xml').async('string')
  let appendix = ''
  let touched = false

  list.forEach((img, i) => {
    const reg = registerImage(zip, relsXml, typesXml, img, stamp, i)
    relsXml = reg.relsXml; typesXml = reg.typesXml
    const label = img.category ? xmlEscape(img.category) : `Screenshot ${i + 1}`
    const block = imageBlockXml(reg.rId, reg.picId, label, reg.cx, reg.cy, img.caption)

    // Positioned: replace the whole paragraph holding {{SLOT_TOKEN}}.
    const needle = img.slot ? `{{${img.slot}}}` : null
    const at = needle ? xml.indexOf(needle) : -1
    if (at !== -1) {
      const bounds = paragraphBounds(xml, at)
      if (bounds) {
        xml = xml.slice(0, bounds.pStart) + block + xml.slice(bounds.pEnd)
        touched = true
        return
      }
      // Paragraph not safely resolvable — fall back to inline removal + append.
      xml = xml.split(needle).join('')
    }
    // Manual method: collect for the end-of-document appendix, with heading.
    appendix += headingP(label) + block + '<w:p/>'
    touched = true
  })

  // Blank any image tokens that got no image assigned — they're anchors,
  // never meant to print as literal text.
  xml = xml.replace(/\{\{(?:IMG|IMAGE|SCREENSHOT|SS|IMPL_IMG)_[A-Z0-9_]*\}\}/g, '')
  // Per-flow variants of the same anchors ({{IMG_GROOVY__2}}) and the flow
  // region markers themselves must never print as literal text either.
  xml = xml.replace(/\{\{FLOW_SECTION_(?:START|END)\}\}/g, '')

  if (appendix) {
    const sectPrIdx = xml.lastIndexOf('<w:sectPr')
    xml = sectPrIdx === -1
      ? xml.replace('</w:body>', appendix + '</w:body>')
      : xml.slice(0, sectPrIdx) + appendix + xml.slice(sectPrIdx)
  }

  if (touched) {
    zip.file('word/_rels/document.xml.rels', relsXml)
    zip.file('[Content_Types].xml', typesXml)
  }
  return xml
}


export function detectTokens(xml) {
  const tokens = new Set()
  const re = /\{\{([A-Z][A-Z0-9_]*)\}\}/g
  let m
  while ((m = re.exec(xml)) !== null) tokens.add(m[1])
  return [...tokens]
}

// Image tokens are placement anchors, not text fields. Naming convention:
// {{IMG_*}}, {{IMAGE_*}}, {{SCREENSHOT_*}} or {{SS_*}}.
export function isImageToken(t) {
  return /^(IMG|IMAGE|SCREENSHOT|SS)_/.test(t)
}

// For each text token, pull the surrounding visible text (the label/sentence
// it sits in, plus the nearest heading above it) so an AI can describe what
// the field is meant to hold. Purely deterministic extraction — no AI here.
// Returns { TOKEN: { heading, context } }.
export function extractTokenContext(xml) {
  // Flatten to plain paragraphs of visible text, tracking headings.
  const paras = []
  const paraRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g
  let pm
  while ((pm = paraRe.exec(xml)) !== null) {
    const inner = pm[1]
    const text = [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join('')
    const isHeading = /w:val="(Heading[1-6]|Title)"/i.test(inner)
    paras.push({ text, isHeading })
  }
  const out = {}
  let lastHeading = ''
  for (const p of paras) {
    if (p.isHeading && p.text.trim()) lastHeading = p.text.trim()
    const tokens = p.text.match(/\{\{([A-Z][A-Z0-9_]*)\}\}/g) || []
    for (const raw of tokens) {
      const name = raw.replace(/[{}]/g, '')
      if (isImageToken(name)) continue
      if (!out[name]) {
        // Context = the paragraph text with the token itself blanked, trimmed.
        const context = p.text.replace(/\{\{[A-Z][A-Z0-9_]*\}\}/g, '____').replace(/\s+/g, ' ').trim().slice(0, 200)
        out[name] = { heading: lastHeading, context }
      }
    }
  }
  return out
}

// Generate a .docx using the DEFAULT Motiveminds template.
// values = { INTERFACE_NAME, VERSION, AUTHOR, ... } — all 16 tokens.
export async function generateSpecDocx(values, adapters, images) {
  const buffer = readFileSync(DEFAULT_TEMPLATE)
  return generateFromBuffer(buffer, values, adapters, images)
}

// Generate a .docx using an uploaded template buffer.
// Pipeline order matters:
//   1. healSplitTokens — Word fragments typed tokens across runs; make them findable
//   2. injectAdapterTables — block-level swap at the {{ADAPTER_TABLES}} anchor
//   3. injectImages — positioned at {{IMG_*}} slots, or appended at the end
//   4. substituteTokens — plain text token replacement
// Implementation steps: unlimited, from a fixed template.
//
// The Motiveminds template ships four consecutive {{IMPL_BULLET_n}} paragraphs,
// each a proper numbered-list item. Rather than editing the template (and
// rather than capping the user at four), we treat the FIRST of those paragraphs
// as a prototype: clone it once per step the user wrote, substitute the text,
// and delete the leftover numbered paragraphs. Cloning the real paragraph means
// the list numbering, style and font come along for free — a hand-built
// paragraph would lose them.
//
// Each cloned step is followed by an empty anchor paragraph carrying
// {{IMPL_IMG_n}}, so a screenshot attached to step n lands directly beneath it
// rather than at the end of the document.
//
// `values.IMPL_STEPS` is an array of strings. The legacy IMPL_BULLET_1..4
// values still work if a caller sets them instead — in that case we leave the
// template alone and normal token substitution handles it.
// Multi-flow documents: clone the per-flow region once per iFlow.
//
// A business process usually spans several iFlows chained over ProcessDirect,
// and documenting it means documenting each. The template marks one repeatable
// region with {{FLOW_SECTION_START}} / {{FLOW_SECTION_END}}; this clones
// everything between them, suffixing every token in the clone with __1, __2, …
// so each flow gets its own values and its own screenshot slots instead of
// overwriting the previous flow's.
//
// Image tokens keep their IMG_ prefix through the rewrite ({{IMG_GROOVY}} ->
// {{IMG_GROOVY__2}}), so the existing image-slot machinery still recognises
// them without special-casing.
//
// `flowCount` of 0 or 1 collapses to a single un-suffixed section, which keeps
// single-flow documents byte-identical to how they rendered before.
export function expandFlowSections(xml, flowCount) {
  const START = '{{FLOW_SECTION_START}}'
  const END = '{{FLOW_SECTION_END}}'

  const startPara = paragraphContaining(xml, START)
  const endPara = paragraphContaining(xml, END)
  if (!startPara || !endPara) return { xml, listRestarts: [] }

  const blockStart = startPara.end
  const blockEnd = endPara.start
  if (blockEnd <= blockStart) return { xml, listRestarts: [] }

  const block = xml.slice(blockStart, blockEnd)
  const n = Math.max(1, flowCount || 1)

  // Every cloned section reuses the template's list id, which makes Word treat
  // all of them as ONE continuous list — flow 2's steps would carry on from
  // flow 1 (4., 5., 6.) instead of restarting. Each clone therefore gets its
  // own numbering id, registered in numbering.xml with a start override.
  const baseNumIds = [...new Set((block.match(/<w:numId w:val="(\d+)"\/>/g) || [])
    .map(m => (m.match(/"(\d+)"/) || [])[1]))]
  const listRestarts = []
  let nextNumId = 1000   // well clear of the template's own ids

  const clones = []
  for (let i = 1; i <= n; i++) {
    let clone = n === 1 ? block : suffixTokens(block, i)
    // The first section can keep the original numbering; later ones need
    // their own so they restart at 1.
    if (i > 1) {
      for (const base of baseNumIds) {
        const fresh = nextNumId++
        listRestarts.push({ baseNumId: base, newNumId: String(fresh) })
        clone = clone.split(`<w:numId w:val="${base}"/>`).join(`<w:numId w:val="${fresh}"/>`)
      }
    }
    clones.push(clone)
  }

  return {
    xml: xml.slice(0, startPara.start) + clones.join('') + xml.slice(endPara.end),
    listRestarts,
  }
}

// Register the cloned numbering ids in numbering.xml, each pointing at the
// same abstract definition as the id it was cloned from but overriding the
// start value so the list begins at 1 again.
function applyListRestarts(numberingXml, listRestarts) {
  if (!listRestarts.length) return numberingXml
  let out = numberingXml
  const additions = []
  for (const { baseNumId, newNumId } of listRestarts) {
    const src = out.match(new RegExp(`<w:num w:numId="${baseNumId}"[^>]*>([\\s\\S]*?)</w:num>`))
    if (!src) continue
    const absMatch = src[1].match(/<w:abstractNumId w:val="(\d+)"\/>/)
    if (!absMatch) continue
    additions.push(
      `<w:num w:numId="${newNumId}">` +
      `<w:abstractNumId w:val="${absMatch[1]}"/>` +
      `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>` +
      `</w:num>`
    )
  }
  if (!additions.length) return out
  return out.replace('</w:numbering>', additions.join('') + '</w:numbering>')
}

// Rewrite {{TOKEN}} -> {{TOKEN__n}} throughout a block.
function suffixTokens(block, n) {
  return block.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, name) => `{{${name}__${n}}}`)
}

// Locate the paragraph containing a marker, returning its byte bounds so the
// marker paragraph itself can be removed along with the region delimiters.
function paragraphContaining(xml, needle) {
  const at = xml.indexOf(needle)
  if (at === -1) return null
  const start = xml.lastIndexOf('<w:p', at)
  if (start === -1) return null
  const closeAt = xml.indexOf('</w:p>', at)
  if (closeAt === -1) return null
  return { start, end: closeAt + '</w:p>'.length }
}

export function expandImplSteps(xml, values = {}) {
  // Single-flow documents use bare tokens; multi-flow documents use the __n
  // suffix that expandFlowSections applied. Handle both by discovering which
  // IMPL_BULLET_1 variants are actually present in the document.
  const variants = [...new Set(
    (xml.match(/\{\{IMPL_BULLET_1(__\d+)?\}\}/g) || [])
      .map(t => (t.match(/__(\d+)/) || [])[1] || null)
  )]
  if (!variants.length) return xml

  let out = xml
  for (const flowNo of variants) {
    const sfx = flowNo ? `__${flowNo}` : ''
    const steps = values[`IMPL_STEPS${sfx}`]
    if (!Array.isArray(steps)) continue
    out = expandOneImplList(out, steps, sfx)
  }
  return out
}

// Expand one flow's implementation list, cloning its prototype paragraph.
function expandOneImplList(xml, steps, sfx) {
  const paraRe = /<w:p[ >][\s\S]*?<\/w:p>/g
  const protoToken = `{{IMPL_BULLET_1${sfx}}}`
  const paras = xml.match(paraRe) || []
  const proto = paras.find(p => p.includes(protoToken))
  if (!proto) return xml

  const kept = steps.map(s => String(s ?? '').trim()).filter(Boolean)

  const blocks = kept.map((text, i) => {
    const stepPara = proto.replace(protoToken, multilineRuns(text))
    // Anchor for this step's screenshot, unique per flow AND per step so
    // nothing collides across a multi-flow document.
    const imgAnchor = `<w:p><w:pPr><w:ind w:left="720"/></w:pPr><w:r><w:t>{{IMPL_IMG_${i + 1}${sfx}}}</w:t></w:r></w:p>`
    return stepPara + imgAnchor
  }).join('')

  let out = xml.replace(proto, blocks || proto.replace(protoToken, ''))
  for (let n = 2; n <= 4; n++) {
    const dead = (out.match(paraRe) || []).find(p => p.includes(`{{IMPL_BULLET_${n}${sfx}}}`))
    if (dead) out = out.replace(dead, '')
  }
  return out
}

// Word ignores a raw "\n" inside <w:t>, so a multi-line step would silently
// collapse onto one line. Split it into runs separated by explicit breaks.
function multilineRuns(text) {
  const lines = String(text ?? '').split('\n')
  return lines.map(escapeXml).join('</w:t><w:br/><w:t>')
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

export async function generateFromBuffer(templateBuffer, values, adapters, images) {
  const zip = await JSZip.loadAsync(templateBuffer)
  const docFile = zip.file('word/document.xml')
  if (!docFile) throw new Error('Not a valid .docx — missing word/document.xml')
  let xml = await docFile.async('string')
  xml = healSplitTokens(xml)
  xml = injectAdapterTables(xml, adapters)
  // Order matters. Flow sections clone first (creating __n suffixed tokens),
  // then implementation steps expand within each cloned section (creating
  // {{IMPL_IMG_n__f}} anchors), then images fill those anchors, and only then
  // does plain token substitution run.
  const flowExpansion = expandFlowSections(xml, values?.FLOW_COUNT)
  xml = flowExpansion.xml
  // Cloned sections need their own list numbering, or Word runs every flow's
  // implementation steps together as one continuous list.
  if (flowExpansion.listRestarts.length) {
    const numFile = zip.file('word/numbering.xml')
    if (numFile) {
      const patched = applyListRestarts(await numFile.async('string'), flowExpansion.listRestarts)
      zip.file('word/numbering.xml', patched)
    }
  }
  xml = expandImplSteps(xml, values)
  xml = await injectImages(zip, xml, images)
  xml = substituteTokens(xml, values || {})
  zip.file('word/document.xml', xml)
  return zip.generateAsync({ type: 'nodebuffer' })
}

// Count images already embedded in a template (word/media/*). Purely
// informational — ShipBridge never touches a template's existing images,
// so the frontend can tell the user "yours already has N — kept as-is".
function countTemplateImages(zip) {
  const IMG_RE = /^word\/media\/.+\.(png|jpe?g|gif|emf|wmf|bmp|tiff?)$/i
  return Object.keys(zip.files).filter(p => IMG_RE.test(p)).length
}

// Given an uploaded template buffer, return the tokens it uses, split into
// text tokens (form fields) and image tokens (placement slots for screenshots).
export async function scanTemplateBuffer(templateBuffer) {
  const zip = await JSZip.loadAsync(templateBuffer)
  const docFile = zip.file('word/document.xml')
  if (!docFile) throw new Error('Not a valid .docx — missing word/document.xml')
  const xml = healSplitTokens(await docFile.async('string'))
  const all = detectTokens(xml)
  return {
    tokens: all.filter(t => !isImageToken(t)),
    imageTokens: all.filter(isImageToken),
    tokenContext: extractTokenContext(xml),
    existingImageCount: countTemplateImages(zip),
  }
}

// Return the token list for the default Motiveminds template.
// Called once by the frontend to know what fields to render.
// Read the bundled default template. Exported so the multi-flow builder can
// use the same file rather than duplicating the path.
export function readDefaultTemplate() {
  return readFileSync(DEFAULT_TEMPLATE)
}

export async function scanDefaultTemplate() {
  const buffer = readFileSync(DEFAULT_TEMPLATE)
  return scanTemplateBuffer(buffer)
}
