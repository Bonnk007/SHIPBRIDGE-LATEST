// AI Spec generation — the "generate a whole technical spec from the iFlow"
// path, as opposed to the two template-substitution paths.
//
// DIVISION OF LABOUR (this is the important bit):
//   • FACTS come from the parser. Step order, adapter types, timeouts,
//     Content Modifier header/property tables, Groovy source, ProcessDirect
//     addresses — all extracted from the iFlow XML, never asked of the AI.
//   • PROSE comes from the AI, and is given those facts as grounding. It
//     writes the Overview, the Technical Description, the per-step narrative.
//
// That split is deliberate. An AI-invented adapter timeout or endpoint URL in
// a document a consultant hands to a client is a genuine problem, and the
// failure is silent — it reads perfectly. So anything checkable is extracted.

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, TableLayoutType,
  ImageRun, PageBreak, TableOfContents,
} from 'docx'

// ── Fact extraction ───────────────────────────────────────────────────────

// Walk the flow from its start node, following edges, so steps come out in
// execution order rather than XML-declaration order. Falls back to declaration
// order for anything unreachable (error subprocesses, orphaned nodes).
export function orderSteps(flow) {
  const steps = flow?.steps || {}
  const edges = flow?.edges || []
  const ids = Object.keys(steps)
  if (!ids.length) return []

  const out = []
  const seen = new Set()
  const adj = new Map()
  for (const e of edges) {
    if (!e?.sourceRef || !e?.targetRef) continue
    if (!adj.has(e.sourceRef)) adj.set(e.sourceRef, [])
    adj.get(e.sourceRef).push(e.targetRef)
  }

  const start = flow.startId && steps[flow.startId] ? flow.startId : ids[0]
  const stack = [start]
  while (stack.length) {
    const id = stack.shift()
    if (!id || seen.has(id) || !steps[id]) continue
    seen.add(id)
    out.push(steps[id])
    for (const next of (adj.get(id) || [])) if (!seen.has(next)) stack.push(next)
  }
  // Anything the walk didn't reach still belongs in the document.
  for (const id of ids) if (!seen.has(id)) out.push(steps[id])
  return out
}

// Human label for a step's type. The parser's `kind` is machine-ish
// (ContentModifier, GroovyScript); specs read better with spaces.
function humanKind(kind) {
  if (!kind) return 'Step'
  return String(kind)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^Process Direct/, 'ProcessDirect')
}

// Pull the configuration worth documenting for one step, as label/value rows.
// Only fields that actually carry meaning in a spec — not every raw XML prop,
// which would drown the reader in Camel internals.
const CONFIG_ALLOW = [
  ['address', 'Address'], ['httpAddressWithoutQuery', 'Endpoint'],
  ['adapterType', 'Adapter'], ['componentType', 'Component'],
  ['httpMethod', 'HTTP Method'], ['httpRequestTimeout', 'Timeout (ms)'],
  ['timeout', 'Timeout'], ['authenticationMethod', 'Authentication'],
  ['credentialName', 'Credential Alias'], ['privateKeyAlias', 'Private Key Alias'],
  ['proxyType', 'Proxy Type'], ['locationId', 'Cloud Connector Location'],
  ['queueName', 'Queue'], ['scriptRef', 'Script File'],
  ['mappingRef', 'Mapping'], ['mappingPath', 'Mapping Path'],
  ['xsltRef', 'XSLT'], ['expression', 'Condition'],
  ['throwException', 'Throw Exception'], ['bodyType', 'Body Type'],
]

export function stepConfigRows(step) {
  const cfg = step?.config || {}
  const rows = []
  for (const [key, label] of CONFIG_ALLOW) {
    const v = cfg[key]
    if (v == null || v === '' || typeof v === 'object') continue
    rows.push({ label, value: String(v) })
  }
  return rows
}

// Build the complete deterministic fact sheet. This is what gets handed to the
// AI as grounding AND what gets rendered as tables in the document — so the
// tables and the prose can never disagree.
export function buildSpecFacts(flow) {
  const ordered = orderSteps(flow)

  const steps = ordered.map((s, i) => ({
    index: i + 1,
    id: s.id,
    name: s.name || s.id,
    kind: s.kind || null,
    kindLabel: humanKind(s.kind),
    config: stepConfigRows(s),
  }))

  // Content Modifiers carry the headers/properties a spec reader most wants:
  // "what did this flow actually set?". The parser already parses these tables.
  const contentModifiers = ordered
    .filter(s => s.kind === 'ContentModifier')
    .map(s => ({
      name: s.name || s.id,
      id: s.id,
      headers: (s.config?.headers || []).map(h => ({
        name: h.name ?? h.Name ?? '', type: h.type ?? h.Type ?? '', value: h.value ?? h.Value ?? '',
      })).filter(h => h.name),
      properties: (s.config?.properties || []).map(p => ({
        name: p.name ?? p.Name ?? '', type: p.type ?? p.Type ?? '', value: p.value ?? p.Value ?? '',
      })).filter(p => p.name),
      bodyType: s.config?.bodyType || null,
      bodyConfig: s.config?.bodyConfig || null,
    }))
    .filter(cm => cm.headers.length || cm.properties.length || cm.bodyConfig)

  // Groovy scripts, with source where the parser could resolve it. `match`
  // matters: 'fuzzy' means we guessed by filename similarity and could be
  // wrong, so the document says so rather than presenting it as certain.
  const scripts = ordered
    .filter(s => s.kind === 'GroovyScript')
    .map(s => ({
      stepName: s.name || s.id,
      file: s.config?.scriptRef || null,
      source: s.config?.preview || null,
      match: s.config?.scriptMatch || 'none',
      matchedName: s.config?.scriptMatchName || null,
    }))

  const mappings = ordered
    .filter(s => s.kind === 'MessageMapping' || s.config?.mappingRef)
    .map(s => ({
      stepName: s.name || s.id,
      ref: s.config?.mappingRef || null,
      path: s.config?.mappingPath || null,
    }))

  // Security-relevant facts, gathered across all adapters. Credential ALIASES
  // only — never a secret value, which the iFlow XML doesn't contain anyway
  // (CPI stores them in the secure store), but worth being explicit about.
  const security = []
  for (const s of ordered) {
    const c = s.config || {}
    const entry = {
      step: s.name || s.id,
      authentication: c.authenticationMethod || null,
      credentialAlias: c.credentialName || null,
      privateKeyAlias: c.privateKeyAlias || null,
      proxyType: c.proxyType || null,
      locationId: c.locationId || null,
    }
    if (entry.authentication || entry.credentialAlias || entry.privateKeyAlias) security.push(entry)
  }

  const adapters = (flow?.adapterList || []).map(a => ({
    direction: a.direction || a.dir || null,
    type: a.adapterType || a.type || null,
    address: a.address || null,
    step: a.stepName || a.name || null,
  }))

  return {
    flowName: flow?.name || flow?.id || 'Integration Flow',
    stepCount: steps.length,
    steps,
    adapters,
    contentModifiers,
    scripts,
    mappings,
    security,
    entryPoints: flow?.entryPoints || [],
    exitPoints: flow?.exitPoints || [],
    bundled: flow?.bundled || { scripts: [], xslts: [], mappings: [] },
  }
}

// A compact version of the facts for the AI prompt. Groovy source is capped —
// a 500-line script would crowd out everything else, and the AI only needs
// enough to describe what the script does.
export function factsForPrompt(facts) {
  return {
    flowName: facts.flowName,
    stepCount: facts.stepCount,
    steps: facts.steps.map(s => ({
      index: s.index, name: s.name, type: s.kindLabel,
      config: Object.fromEntries(s.config.map(r => [r.label, r.value])),
    })),
    adapters: facts.adapters,
    contentModifiers: facts.contentModifiers.map(cm => ({
      name: cm.name,
      setsHeaders: cm.headers.map(h => h.name),
      setsProperties: cm.properties.map(p => p.name),
      bodyType: cm.bodyType,
    })),
    groovyScripts: facts.scripts.map(s => ({
      step: s.stepName, file: s.file, matchQuality: s.match,
      source: s.source ? String(s.source).slice(0, 2500) : null,
    })),
    mappings: facts.mappings,
    security: facts.security,
    entryPoints: facts.entryPoints,
    exitPoints: facts.exitPoints,
  }
}

// Each section only needs part of the fact sheet. Slicing it per section keeps
// prompts small (which is what stops responses being truncated) and sharpens
// the writing — a section about security shouldn't be reasoning past a wall of
// Groovy source it doesn't need.
export function factsForSection(facts, key) {
  const base = { flowName: facts.flowName, stepCount: facts.stepCount }
  const allSteps = facts.steps.map(s => ({
    index: s.index, name: s.name, type: s.kindLabel,
    config: Object.fromEntries(s.config.map(r => [r.label, r.value])),
  }))

  switch (key) {
    case 'overview':
    case 'highLevelDesign':
      return { ...base, steps: allSteps, adapters: facts.adapters,
               entryPoints: facts.entryPoints, exitPoints: facts.exitPoints }
    case 'messageFlow':
      return { ...base, steps: allSteps }
    case 'technicalDescription':
      return { ...base, steps: allSteps,
               contentModifiers: facts.contentModifiers,
               groovyScripts: facts.scripts.map(s => ({
                 step: s.stepName, file: s.file,
                 source: s.source ? String(s.source).slice(0, 2000) : null,
               })) }
    case 'senderReceiver':
      return { ...base, adapters: facts.adapters,
               entryPoints: facts.entryPoints, exitPoints: facts.exitPoints,
               senderReceiverSteps: allSteps.filter(s => /Sender|Receiver/i.test(s.type)) }
    case 'mappings':
      return { ...base, mappings: facts.mappings,
               bundledMappings: facts.bundled?.mappings || [] }
    case 'security':
      return { ...base, security: facts.security, adapters: facts.adapters }
    case 'errorHandling':
      // Error handling lives in exception subprocesses and error-ish steps —
      // give the model the whole step list so it can spot their absence too.
      return { ...base, steps: allSteps }
    case 'appendix':
      return { ...base, bundled: facts.bundled,
               entryPoints: facts.entryPoints, exitPoints: facts.exitPoints }
    default:
      return { ...base, steps: allSteps }
  }
}

// ── Document generation ───────────────────────────────────────────────────

const FONT = 'Calibri'
const ACCENT = '2F5496'
const HEADER_BG = 'DEE6F1'

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 120, before: opts.before ?? 0 },
    alignment: opts.align,
    children: [new TextRun({
      text: String(text ?? ''), font: FONT, size: opts.size ?? 21,
      bold: opts.bold, italics: opts.italics, color: opts.color,
    })],
  })
}

function h(text, level) {
  return new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 320 : 240, after: 140 },
    children: [new TextRun({ text: String(text ?? ''), font: FONT, bold: true, color: ACCENT })],
  })
}

// Multi-line prose → one Paragraph per line. docx-js renders "\n" literally,
// so text must be split before it reaches a TextRun.
function prose(text) {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return [p('Not Provided', { italics: true, color: '888888' })]
  return lines.map(line => {
    const bullet = line.match(/^[-*•]\s+(.*)$/)
    if (bullet) {
      return new Paragraph({
        bullet: { level: 0 }, spacing: { after: 80 },
        children: [new TextRun({ text: bullet[1], font: FONT, size: 21 })],
      })
    }
    return p(line)
  })
}

function cell(text, { bold = false, bg = null, width = 2400 } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: bg ? { type: ShadingType.CLEAR, fill: bg } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      spacing: { after: 0 },
      children: [new TextRun({ text: String(text ?? ''), font: FONT, size: 19, bold })],
    })],
  })
}

// Column widths must sum to the table width, and every cell needs its own
// width in DXA — percentage widths break in Google Docs.
//
// layout: FIXED is essential. Without it Word ignores columnWidths and runs
// its autofit algorithm, which collapses a narrow column (like "#") to a
// sliver and wraps text one character per line. The widths below are only
// respected because the layout is fixed.
function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0)
  return new Table({
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    width: { size: total, type: WidthType.DXA },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: 'B4C6E7' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'B4C6E7' },
      left:   { style: BorderStyle.SINGLE, size: 4, color: 'B4C6E7' },
      right:  { style: BorderStyle.SINGLE, size: 4, color: 'B4C6E7' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'D6E0F0' },
      insideVertical:   { style: BorderStyle.SINGLE, size: 2, color: 'D6E0F0' },
    },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((t, i) => cell(t, { bold: true, bg: HEADER_BG, width: widths[i] })),
      }),
      ...rows.map(r => new TableRow({
        children: r.map((t, i) => cell(t, { width: widths[i] })),
      })),
    ],
  })
}

// How much of a script/body gets dumped verbatim into the document. This is
// the deterministic content (not AI prose), so it needs its own knob — before
// this, a flow with several sizeable Groovy scripts produced a document that
// stayed huge no matter what "detail" level the author picked, because detail
// only ever throttled the AI's writing, never the extracted code dumps.
const CODE_LINE_LIMITS = { brief: 20, standard: 35, detailed: 60 }
const CM_BODY_LINE_LIMITS = { brief: 10, standard: 18, detailed: 30 }

function codeBlock(text, maxLines = 60) {
  const lines = String(text ?? '').split('\n')
  const shown = lines.slice(0, maxLines)
  const out = shown.map(line => new Paragraph({
    spacing: { after: 0 },
    shading: { type: ShadingType.CLEAR, fill: 'F4F4F4' },
    children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 17 })],
  }))
  if (lines.length > maxLines) {
    out.push(p(`… ${lines.length - maxLines} more lines (see the script file in the package)`,
      { italics: true, color: '888888', size: 17 }))
  }
  return out
}

// Images the user attached. Each carries either a caption they wrote or one
// the AI produced — both are the user's to keep or edit before export.
function imageBlocks(images, section) {
  const mine = (images || []).filter(i => (i.section || 'Appendix') === section && i.base64)
  const out = []
  for (const img of mine) {
    try {
      out.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 160, after: 60 },
        children: [new ImageRun({
          type: (img.mime || '').includes('png') ? 'png' : 'jpg',
          data: Buffer.from(img.base64, 'base64'),
          transformation: { width: 560, height: Math.round(560 * (img.ratio || 0.56)) },
        })],
      }))
      if (img.caption) {
        out.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
          children: [new TextRun({ text: img.caption, font: FONT, size: 18, italics: true, color: '666666' })],
        }))
      }
    } catch { /* a corrupt image shouldn't kill the whole document */ }
  }
  return out
}

// The nine sections, in order. `key` matches what the AI returns.
export const SPEC_SECTIONS = [
  { key: 'overview',            title: '1. Overview' },
  { key: 'highLevelDesign',     title: '2. High-Level Design' },
  { key: 'messageFlow',         title: '3. Message Flow' },
  { key: 'technicalDescription',title: '4. Technical Description' },
  { key: 'senderReceiver',      title: '5. Sender / Receiver Details' },
  { key: 'mappings',            title: '6. Mappings & Transformations' },
  { key: 'security',            title: '7. Security' },
  { key: 'errorHandling',       title: '8. Error Handling' },
  { key: 'appendix',            title: '9. Appendix' },
]

// System-level architecture diagram: "SENDER → SAP Cloud Integration → RECEIVER".
//
// Drawn as a Word table rather than an embedded image, deliberately. A table
// renders identically everywhere, survives the docx→PDF path, and stays
// editable — a consultant can retype a system name in Word without going back
// to ShipBridge. An image would be prettier and useless the moment a name is
// wrong.
//
// The systems come from the flow's real sender and receiver adapters, so this
// is extraction, not decoration.
function architectureTable(facts) {
  const senders = facts.adapters.filter(a => /sender/i.test(a.direction || ''))
  const receivers = facts.adapters.filter(a => /receiver/i.test(a.direction || ''))

  // Fall back to entry/exit points when adapter direction wasn't resolved.
  const senderLines = senders.length
    ? senders.map(a => [a.type, a.address].filter(Boolean).join(' · '))
    : (facts.entryPoints || []).map(e => [e.adapterType, e.address].filter(Boolean).join(' · '))
  const receiverLines = receivers.length
    ? receivers.map(a => [a.type, a.address].filter(Boolean).join(' · '))
    : (facts.exitPoints || []).map(e => [e.adapterType, e.address].filter(Boolean).join(' · '))

  if (!senderLines.length && !receiverLines.length) return null

  // A cell holding a titled box: bold heading, then detail lines beneath.
  const box = (title, lines, { fill = 'F2F6FC', border = '8FAADC' } = {}) => new TableCell({
    width: { size: 2900, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill },
    margins: { top: 140, bottom: 140, left: 140, right: 140 },
    verticalAlign: 'center',
    borders: {
      top: { style: BorderStyle.SINGLE, size: 8, color: border },
      bottom: { style: BorderStyle.SINGLE, size: 8, color: border },
      left: { style: BorderStyle.SINGLE, size: 8, color: border },
      right: { style: BorderStyle.SINGLE, size: 8, color: border },
    },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: lines.length ? 80 : 0 },
        children: [new TextRun({ text: title, font: FONT, size: 20, bold: true, color: '1F3864' })],
      }),
      ...(lines.length ? lines : []).map(l => new Paragraph({
        alignment: AlignmentType.CENTER, spacing: { after: 40 },
        children: [new TextRun({ text: l, font: FONT, size: 16, color: '444444' })],
      })),
    ],
  })

  // Arrow cell — no borders, just the glyph, so the boxes read as connected.
  const arrow = () => new TableCell({
    width: { size: 650, type: WidthType.DXA },
    verticalAlign: 'center',
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
    },
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: '→', font: FONT, size: 28, bold: true, color: '8FAADC' })],
    })],
  })

  return new Table({
    columnWidths: [2900, 650, 2900, 650, 2900],
    layout: TableLayoutType.FIXED,
    width: { size: 10000, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE },
    },
    rows: [new TableRow({
      children: [
        box(senderLines.length ? 'Sender' : 'Source', senderLines),
        arrow(),
        box('SAP Cloud Integration', [facts.flowName], { fill: 'E8F0FE', border: '4A7EBB' }),
        arrow(),
        box(receiverLines.length ? 'Receiver' : 'Target', receiverLines),
      ],
    })],
  })
}

export async function buildAiSpecDocx({ facts, sections = {}, images = [], meta = {}, scriptExplanations = {}, detail = 'brief' }) {
  const codeMax = CODE_LINE_LIMITS[detail] || CODE_LINE_LIMITS.brief
  const cmBodyMax = CM_BODY_LINE_LIMITS[detail] || CM_BODY_LINE_LIMITS.brief
  const body = []

  // Title block
  body.push(new Paragraph({
    spacing: { after: 80 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: 'Technical Specification', font: FONT, size: 40, bold: true, color: ACCENT })],
  }))
  body.push(new Paragraph({
    spacing: { after: 320 },
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: facts.flowName, font: FONT, size: 28, color: '444444' })],
  }))

  const metaRows = [
    ['Interface Name', meta.interfaceName || facts.flowName],
    ['Version', meta.version || '1.0'],
    ['Author', meta.author || 'Not Provided'],
    ['Date', meta.date || new Date().toISOString().slice(0, 10)],
    ['Package', meta.packageName || 'Not Provided'],
    ['Steps', String(facts.stepCount)],
  ]
  body.push(table(['Field', 'Value'], metaRows, [2600, 6400]))

  body.push(new Paragraph({ children: [new PageBreak()] }))

  // Table of contents. Word builds this from the Heading styles at open time;
  // `updateFields` below makes it prompt to populate rather than showing an
  // empty field. LibreOffice populates it on conversion.
  body.push(new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({ text: 'Contents', font: FONT, size: 28, bold: true, color: ACCENT })],
  }))
  body.push(new TableOfContents('Contents', {
    hyperlink: true,
    headingStyleRange: '1-2',
  }))
  body.push(new Paragraph({ children: [new PageBreak()] }))

  for (const sec of SPEC_SECTIONS) {
    body.push(h(sec.title, HeadingLevel.HEADING_1))
    body.push(...prose(sections[sec.key]))

    // Deterministic tables live alongside the AI prose, per section.
    if (sec.key === 'messageFlow' && facts.steps.length) {
      body.push(h('Execution Steps', HeadingLevel.HEADING_2))
      body.push(table(
        ['#', 'Step', 'Type', 'Key Configuration'],
        facts.steps.map(s => [
          String(s.index), s.name, s.kindLabel,
          s.config.length ? s.config.map(r => `${r.label}: ${r.value}`).join('; ') : '—',
        ]),
        [500, 2950, 1900, 3650],
      ))
    }

    if (sec.key === 'technicalDescription') {
      for (const cm of facts.contentModifiers) {
        body.push(h(`Content Modifier — ${cm.name}`, HeadingLevel.HEADING_2))
        // One combined table instead of two — a flow with several Content
        // Modifiers otherwise doubles its table count for no reading benefit;
        // "Kind" keeps headers and properties distinguishable in one pass.
        if (cm.headers.length || cm.properties.length) {
          const rows = [
            ...cm.headers.map(x => ['Header', x.name, x.type || '—', x.value || '—']),
            ...cm.properties.map(x => ['Property', x.name, x.type || '—', x.value || '—']),
          ]
          body.push(table(['Kind', 'Name', 'Type', 'Value'], rows, [1400, 2400, 1500, 3700]))
        }
        if (cm.bodyConfig) {
          body.push(p('Message body:', { bold: true, before: 140 }))
          body.push(...codeBlock(cm.bodyConfig, cmBodyMax))
        }
      }
      for (const sc of facts.scripts) {
        body.push(h(`Script — ${sc.stepName}`, HeadingLevel.HEADING_2))
        body.push(p(`File: ${sc.file || 'Not Provided'}`))
        if (sc.match === 'fuzzy') {
          body.push(p(`Note: this source was matched to the step by filename similarity (${sc.matchedName}) — verify it is the correct script.`,
            { italics: true, color: 'AA6600' }))
        }
        // The explanation for THIS script, paired with THIS script's source —
        // so a reader never has to work out which paragraph describes which
        // file when a flow has several scripts.
        const explanation = scriptExplanations?.[sc.stepName]
        if (explanation) {
          body.push(p('What it does', { bold: true, before: 120 }))
          body.push(...prose(explanation))
          body.push(p('Source', { bold: true, before: 120 }))
        }
        if (sc.source) body.push(...codeBlock(sc.source, codeMax))
        else body.push(p('Script source not found in the package.', { italics: true, color: '888888' }))
      }
    }

    if (sec.key === 'senderReceiver' && facts.adapters.length) {
      body.push(h('Adapter Configuration', HeadingLevel.HEADING_2))
      body.push(table(
        ['Direction', 'Type', 'Address', 'Step'],
        facts.adapters.map(a => [a.direction || '—', a.type || '—', a.address || '—', a.step || '—']),
        [1600, 1800, 4000, 1600],
      ))
    }

    if (sec.key === 'mappings') {
      if (facts.mappings.length) {
        body.push(table(
          ['Step', 'Mapping', 'Path'],
          facts.mappings.map(m => [m.stepName, m.ref || '—', m.path || '—']),
          [2800, 3200, 3000],
        ))
      } else {
        body.push(p('No message mappings are configured in this integration flow.', { italics: true }))
      }
    }

    if (sec.key === 'security' && facts.security.length) {
      body.push(h('Authentication & Credentials', HeadingLevel.HEADING_2))
      body.push(table(
        ['Step', 'Authentication', 'Credential Alias', 'Proxy'],
        facts.security.map(s => [s.step, s.authentication || '—', s.credentialAlias || s.privateKeyAlias || '—', s.proxyType || '—']),
        [2600, 2200, 2600, 1600],
      ))
      body.push(p('Credential aliases refer to entries in the CPI secure store. No secret values are contained in this document.',
        { italics: true, color: '666666', before: 120 }))
    }

    if (sec.key === 'appendix') {
      const b = facts.bundled || {}
      const rows = [
        ['Groovy scripts', (b.scripts || []).join(', ') || '—'],
        ['XSLT files', (b.xslts || []).join(', ') || '—'],
        ['Message mappings', (b.mappings || []).join(', ') || '—'],
      ]
      body.push(h('Package Contents', HeadingLevel.HEADING_2))
      body.push(table(['Artifact type', 'Files'], rows, [2600, 6400]))

      if (facts.entryPoints?.length) {
        body.push(h('Entry Points', HeadingLevel.HEADING_2))
        body.push(table(['Adapter', 'Address'],
          facts.entryPoints.map(e => [e.adapterType || '—', e.address || '—']), [2600, 6400]))
      }
      if (facts.exitPoints?.length) {
        body.push(h('Exit Points', HeadingLevel.HEADING_2))
        body.push(table(['Adapter', 'Address'],
          facts.exitPoints.map(e => [e.adapterType || '—', e.address || '—']), [2600, 6400]))
      }
    }

    body.push(...imageBlocks(images, sec.key))
  }

  const doc = new Document({
    creator: 'ShipBridge',
    title: `Technical Specification — ${facts.flowName}`,
    // Without this the table of contents opens as an empty field until the
    // reader knows to press F9 — which they won't.
    features: { updateFields: true },
    styles: {
      default: {
        document: { run: { font: FONT, size: 21 } },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
      children: body,
    }],
  })

  return Packer.toBuffer(doc)
}
