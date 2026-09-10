// Package-level parser for SAP CPI integration packages.
//
// A real CPI package ZIP contains:
//   - One .iflw with N IntegrationProcess sub-processes (often 20+)
//   - Multiple .mmap files (Message Mappings with field-level mappings)
//   - Multiple .groovy scripts
//   - EDMX/WSDL/XSD schema files
//   - Package metadata (MANIFEST.MF, metainfo.prop, parameters.prop, .project)
//
// The v1 parser (parser.js parseZip) flattens everything into one flow object.
// This module preserves structure: sub-processes stay separate, mappings are
// parsed to field level, parameters are key-value diffable.

import JSZip from 'jszip'
import { parseCMTable, normalizePDAddress, resolveKind } from './parser.js'

// ── Public entry ──────────────────────────────────────────────────────────

export async function parsePackageZip(file) {
  const zip = await JSZip.loadAsync(file)
  const inventory = { scripts: {}, mappings: {}, xsd: {}, edmx: {}, wsdl: {} }
  let iflwText = null, iflwPath = null
  let manifest = null, metainfo = null, project = null
  let parametersRaw = null, parametersDef = null

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const name = path.split('/').pop()

    if (path.endsWith('.iflw'))       { iflwText = await entry.async('string'); iflwPath = path }
    else if (path.endsWith('.groovy')) inventory.scripts[name] = await entry.async('string')
    else if (path.endsWith('.mmap'))   inventory.mappings[name] = await entry.async('string')
    else if (path.endsWith('.xsd'))    inventory.xsd[name] = await entry.async('string')
    else if (path.endsWith('.edmx') || path.endsWith('.EDMX'))
                                      inventory.edmx[name] = await entry.async('string')
    else if (path.endsWith('.wsdl'))   inventory.wsdl[name] = await entry.async('string')
    else if (name === 'MANIFEST.MF')  manifest = await entry.async('string')
    else if (name === 'metainfo.prop') metainfo = await entry.async('string')
    else if (name === '.project')     project = await entry.async('string')
    else if (name === 'parameters.prop') parametersRaw = await entry.async('string')
    else if (name === 'parameters.propdef') parametersDef = await entry.async('string')
  }

  if (!iflwText) throw new Error('No .iflw file found in ZIP')

  const meta = parseManifest(manifest)
  const metaProps = parseJavaProps(metainfo)
  meta.description = metaProps.description || ''
  meta.source = metaProps.source || ''
  meta.target = metaProps.target || ''

  const parameters = parseJavaProps(parametersRaw)
  const subProcesses = parseMultiProcessIFlw(iflwText, inventory.scripts)
  const mappings = {}
  for (const [name, xml] of Object.entries(inventory.mappings)) {
    mappings[name] = parseMmap(xml)
  }

  // File inventory for add/remove detection
  const files = Object.entries(zip.files)
    .filter(([, e]) => !e.dir)
    .map(([path]) => path)
    .sort()

  return {
    type: 'package',
    zipName: file.name || '',
    iflwPath,
    meta,
    parameters,
    subProcesses,
    mappings,
    scripts: inventory.scripts,
    schemas: { ...inventory.xsd, ...inventory.edmx, ...inventory.wsdl },
    files,
  }
}

// ── MANIFEST.MF parser ───────────────────────────────────────────────────

function parseManifest(text) {
  if (!text) return { bundleName: '', bundleVersion: '', bundleType: '' }
  // MANIFEST.MF uses continuation lines: a line starting with a space
  // continues the previous line.
  const unfolded = text.replace(/\r\n /g, '').replace(/\n /g, '')
  const props = {}
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return {
    bundleName:    props['Bundle-Name'] || props['Bundle-SymbolicName'] || '',
    bundleVersion: props['Bundle-Version'] || '',
    bundleType:    props['SAP-BundleType'] || '',
    nodeType:      props['SAP-NodeType'] || '',
    raw: props,
  }
}

// ── Java .properties parser (parameters.prop, metainfo.prop) ─────────────

export function parseJavaProps(text) {
  if (!text) return {}
  const result = {}
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // Java properties: key=value, with backslash escapes for spaces in keys
    const match = trimmed.match(/^(.+?)(?<!\\)=(.*)$/)
    if (!match) continue
    const key = match[1].replace(/\\ /g, ' ').replace(/\\:/g, ':').replace(/\\=/g, '=').trim()
    const val = match[2].replace(/\\ /g, ' ').replace(/\\:/g, ':').replace(/\\=/g, '=').trim()
    result[key] = val
  }
  return result
}

// ── Multi-process iFlow parser ───────────────────────────────────────────
//
// Each <bpmn2:process> element is a separate IntegrationProcess. The
// <bpmn2:participant> with ifl:type="IntegrationProcess" links to it via
// processRef. We parse each process independently to get per-subprocess
// step/edge models that the existing compareFlows can diff.

export function parseMultiProcessIFlw(xml, scripts = {}) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const allEls = [...doc.querySelectorAll('*')]
  const subProcesses = {}

  // Find all IntegrationProcess participants
  const participants = allEls.filter(el =>
    (el.localName === 'participant') &&
    (el.getAttribute('ifl:type') === 'IntegrationProcess' ||
     getProps(el)['ifl:type'] === 'IntegrationProcess')
  )

  // Find all process elements
  const processEls = allEls.filter(el => el.localName === 'process')
  const processById = new Map(processEls.map(el => [el.getAttribute('id'), el]))

  // Build message flow map for adapter resolution
  const msgFlows = allEls.filter(el => el.localName === 'messageFlow')
  const adapterByRef = {}
  msgFlows.forEach(mf => {
    const props = getProps(mf)
    const details = {
      adapterType: props.ComponentType || props.componentType || mf.getAttribute('name') || 'HTTP',
      address: props.address || props.urlPath || props.httpAddressWithoutQuery || '',
      direction: props.direction || props.system || '',
      authMethod: props.authenticationMethod || props.senderAuthType || '',
      operation: props.operation || props.httpMethod || 'POST',
      credentialName: props.credentialName || '',
      rawProps: props,
    }
    const src = mf.getAttribute('sourceRef')
    const tgt = mf.getAttribute('targetRef')
    if (src) adapterByRef[src] = details
    if (tgt) adapterByRef[tgt] = details
  })

  // Participant names mapped to the Endpoint participants that connect to them
  const endpointSenders = allEls.filter(el =>
    el.localName === 'participant' &&
    el.getAttribute('ifl:type') === 'EndpointSender'
  )
  const endpointReceivers = allEls.filter(el =>
    el.localName === 'participant' &&
    (el.getAttribute('ifl:type') === 'EndpointRecevier' ||
     el.getAttribute('ifl:type') === 'EndpointReceiver')
  )

  for (const part of participants) {
    const processRef = part.getAttribute('processRef')
    const processName = part.getAttribute('name') || processRef
    const processEl = processById.get(processRef)
    if (!processEl) continue

    const parsed = parseProcessElement(processEl, processName, scripts, adapterByRef, allEls)
    subProcesses[processRef] = parsed
  }

  return subProcesses
}

// ── Parse a single <bpmn2:process> into a flow object ────────────────────

const STEP_TAGS = new Set([
  'callActivity', 'startEvent', 'endEvent', 'exclusiveGateway',
  'parallelGateway', 'serviceTask', 'subProcess',
])

function parseProcessElement(processEl, processName, scripts, adapterByRef, allEls) {
  const steps = {}
  const edges = []
  const children = [...processEl.querySelectorAll('*')]

  children.forEach(el => {
    const ln = el.localName || ''
    if (!STEP_TAGS.has(ln)) return
    // Only direct descendants of this process (not nested subProcess children at top level)
    if (el.closest('process') !== processEl && el.parentElement?.closest('process') !== processEl) {
      // Allow children of subProcess within this process
      const parentProcess = el.closest('process')
      if (parentProcess !== processEl) return
    }

    const id = el.getAttribute('id')
    const name = el.getAttribute('name') || id
    if (!id || steps[id]) return

    const props = getProps(el)
    const kind = resolveKind(el.tagName || ln, props, name)
    const config = { ...props }

    if (kind === 'ContentModifier') {
      config.headers = parseCMTable(props.headerTable || '')
      config.properties = parseCMTable(props.propertyTable || '')
      config.bodyType = props.bodyType || null
      config.bodyValue = props.bodyText || props.messageBodyText || null
    }

    if (kind === 'GroovyScript') {
      const ref = props.script || props.scriptName || ''
      config.scriptRef = ref
      config.preview = scripts[ref] || null
      if (!config.preview) {
        const nl = name.toLowerCase().replace(/\s+/g, '')
        const match = Object.keys(scripts).find(k =>
          k.replace('.groovy', '').toLowerCase().replace(/[_ ]/g, '').includes(nl.slice(0, 5))
        )
        if (match) { config.preview = scripts[match]; config.scriptMatch = 'fuzzy' }
        else { config.preview = null; config.scriptMatch = 'none' }
      } else {
        config.scriptMatch = 'exact'
      }
    }

    if (kind === 'MessageMapping') {
      config.mappingRef = props.mappingname || props.mappinguri || ''
      config.mappingPath = props.mappingpath || ''
    }

    if (kind === 'ProcessCall') {
      const rawAddr = props.address || ''
      config.pdAddress = normalizePDAddress(rawAddr)
    }

    if (['ExternalCall', 'ContentEnricher'].includes(kind)) {
      config.adapterType = props.ComponentType || 'ExternalCall'
      config.address = props.address || props.httpAddressWithoutQuery || ''
      // Merge adapter details from message flows
      if (adapterByRef[id]) Object.assign(config, adapterByRef[id])
    }

    if (kind === 'Sender' || kind === 'Receiver') {
      if (adapterByRef[id]) Object.assign(config, adapterByRef[id])
    }

    steps[id] = { id, name, kind, config }
  })

  // Sequence flows within this process
  children.forEach(el => {
    if (el.localName !== 'sequenceFlow') return
    const condEl = [...el.children].find(c =>
      ['conditionExpression', 'tFormalExpression'].includes(c.localName)
    )
    edges.push({
      source: el.getAttribute('sourceRef'),
      target: el.getAttribute('targetRef'),
      condition: condEl ? condEl.textContent.trim() : null,
      name: el.getAttribute('name') || null,
    })
  })

  const processId = processEl.getAttribute('id')

  return {
    id: processId,
    name: processName,
    steps,
    edges,
    stepCount: Object.keys(steps).length,
    edgeCount: edges.length,
  }
}

// ── Property/kind helpers (duplicated from parser.js to avoid tight coupling) ─

function getProps(el) {
  const props = {}
  const all = el.querySelectorAll('*')
  all.forEach(node => {
    const ln = node.localName || node.tagName || ''
    if (ln !== 'property' && !ln.endsWith(':property') && ln.indexOf('property') < 0) return
    const keyEl = [...node.children].find(c => (c.localName || c.tagName) === 'key')
    const valEl = [...node.children].find(c => (c.localName || c.tagName) === 'value')
    if (!keyEl) return
    const k = keyEl.textContent?.trim()
    const v = valEl?.textContent?.trim() || ''
    if (k) props[k] = v
  })
  return props
}

// resolveKind is shared from parser.js — see the import above. Keeping one
// implementation means single-iFlow parsing and package/multi-process parsing
// can never silently disagree on what a step is.

// ── Message Mapping (.mmap) parser ───────────────────────────────────────
//
// Extracts Source→Target field mappings and any UDFs used in between.
// The mmap XML uses <brick> elements with type="Src", "Dst", and "Func".

export function parseMmap(xml) {
  if (!xml) return { source: '', target: '', multiplicity: '', fieldMappings: [] }

  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  if (doc.querySelector('parsererror')) return { source: '', target: '', multiplicity: '', fieldMappings: [] }

  // Source/target message types from links
  let source = '', target = ''
  const links = doc.querySelectorAll('lnkRole')
  links.forEach(lr => {
    const role = lr.getAttribute('role') || ''
    const keyEls = lr.querySelectorAll('key > elem')
    const elems = [...keyEls].map(e => e.textContent?.trim()).filter(Boolean)
    if (role.includes('SOURCE')) source = elems.join('/')
    if (role.includes('TARGET')) target = elems.join('/')
  })

  // Multiplicity
  let multiplicity = ''
  const multEl = doc.querySelector('Multiplicity')
  if (multEl) multiplicity = multEl.textContent?.trim() || ''

  // Field mappings from transformation bricks
  const fieldMappings = []
  const dstBricks = doc.querySelectorAll('brick[type="Dst"]')
  dstBricks.forEach(dst => {
    const targetPath = dst.getAttribute('path') || ''
    if (!targetPath) return

    const args = [...dst.children].filter(c => c.localName === 'arg')
    if (!args.length) return

    const mapping = { target: targetPath, sources: [], functions: [] }

    for (const arg of args) {
      extractSources(arg, mapping)
    }

    // Only include if there's something meaningful
    if (mapping.sources.length > 0 || mapping.functions.length > 0) {
      fieldMappings.push(mapping)
    }
  })

  return { source, target, multiplicity, fieldMappings }
}

function extractSources(el, mapping) {
  const bricks = el.querySelectorAll('brick')
  bricks.forEach(b => {
    const type = b.getAttribute('type')
    const path = b.getAttribute('path') || ''
    const fname = b.getAttribute('fname') || ''

    if (type === 'Src' && path) {
      if (!mapping.sources.includes(path)) mapping.sources.push(path)
    }
    if (type === 'Func' && fname) {
      const params = []
      b.querySelectorAll('param').forEach(p => {
        const name = p.getAttribute('name') || ''
        const val = p.querySelector('value')?.textContent || ''
        if (name) params.push({ name, value: val })
      })
      mapping.functions.push({ name: fname, params })
    }
  })
}

// ── Exposed for tests ────────────────────────────────────────────────────
export const _internal = {
  parseManifest,
  parseJavaProps,
  parseMultiProcessIFlw,
  parseMmap,
  parseProcessElement,
  resolveKind,
  getProps,
}
