import JSZip from 'jszip'
import { parseMmap } from './packageParser.js'

export const FLOW_COLORS = [
  '#3fb950','#58a6ff','#bc8cff','#f0883e','#14b8a6',
  '#f59e0b','#06b6d4','#a78bfa','#34d399','#fb923c'
]

export async function parseZip(file) {
  const zip = await JSZip.loadAsync(file)
  const scripts = {}, xslts = {}, mmaps = {}
  // Schemas: we only need the filenames (not the content) to check dead-vs-
  // referenced. mmap contents we DO need in order to pull the <lnk> refs out
  // and know which XSD/EDMX each mapping points at.
  const schemas = []
  const mmapContents = {}

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    if (path.endsWith('.groovy')) scripts[path.split('/').pop()] = await entry.async('string')
    if (path.endsWith('.xsl') || path.endsWith('.xslt')) xslts[path.split('/').pop()] = await entry.async('string')
    if (path.endsWith('.mmap')) {
      const name = path.split('/').pop()
      mmaps[name] = path
      mmapContents[name] = await entry.async('string')
    }
    if (/\.(xsd|edmx|wsdl)$/i.test(path)) schemas.push(path.split('/').pop())
  }

  let iflwText = null, iflwName = file.name.replace('.zip','')
  const iflwPaths = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && path.endsWith('.iflw')) {
      iflwPaths.push(path)
      if (iflwText === null) {
        iflwText = await entry.async('string')
        iflwName = path.split('/').pop().replace('.iflw','')
      }
    }
  }
  if (!iflwText) throw new Error('No .iflw file found in ZIP')
  // A multi-artifact package has more than one. We analyse the first, but say
  // so rather than letting the others disappear without a trace.
  if (iflwPaths.length > 1 && typeof console !== 'undefined' && console.warn) {
    console.warn(`[parseZip] ZIP contains ${iflwPaths.length} iFlows; analysing ${iflwName} only.`)
  }
  const flow = parseIFlw(iflwText, iflwName, scripts, xslts, mmaps)
  flow.zipName = file.name || ''
  flow.iflwName = iflwName

  // Schemas bundled in the ZIP go into the dead-asset check, and the refs we
  // pull out of each mmap tell us which schemas are actually used indirectly
  // through a mapping (an XSD only touched by a mapping is very common and
  // would otherwise show as dead).
  flow.bundled = flow.bundled || { scripts: [], xslts: [], mappings: [] }
  flow.bundled.schemas = schemas
  const mappingSchemaRefs = {}
  for (const [name, xml] of Object.entries(mmapContents)) {
    const refs = extractSchemaRefsFromMmap(xml)
    if (refs.length) mappingSchemaRefs[name] = refs
  }
  flow.mappingSchemaRefs = mappingSchemaRefs

  // v48.18.0 — Carry parsed mapping data and raw script contents onto the
  // flow so Intelligence can display content for every asset kind, not just
  // scripts that happen to be step-referenced. Previously this data was
  // parsed (mmapContents) or available (scripts dict) but discarded before
  // reaching the component layer.
  const parsedMappings = {}
  for (const [name, xml] of Object.entries(mmapContents)) {
    try { parsedMappings[name] = parseMmap(xml) } catch { /* skip unparseable */ }
  }
  flow.mappings = parsedMappings
  flow.scriptContents = scripts   // { filename: sourceCode } — fallback for bundled-but-unreferenced scripts
  flow.xsltContents = xslts       // same treatment for XSLTs

  return flow
}

// Pull XSD/EDMX/WSDL filenames out of a message-mapping XML. The link shape is
// <lnk><key typeID="xsd|edmx|wsdl"><elem>Name.xsd</elem>...</key></lnk> — the
// first <elem> is the filename, and that's the key that matches the bundled
// schema inventory. Kept inline (not imported from packageParser) to avoid a
// circular import — parser.js is imported by packageParser.js.
function extractSchemaRefsFromMmap(xml) {
  if (!xml) return []
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    if (doc.querySelector('parsererror')) return []
    const out = new Set()
    for (const key of doc.querySelectorAll('lnkRole key')) {
      const typeID = (key.getAttribute('typeID') || '').toLowerCase()
      if (!['xsd', 'edmx', 'wsdl'].includes(typeID)) continue
      const first = key.querySelector('elem')
      const name = first?.textContent?.trim()
      if (name) out.add(name)
    }
    return [...out]
  } catch { return [] }
}

/**
 * Robust property extractor — handles both ifl:property and property elements.
 * Uses key/value child text content, which works with any namespace prefix.
 */
function isPropertyEl(node) {
  const ln = node.localName || node.tagName || ''
  return ln === 'property' || ln.endsWith(':property')
}

function readPropertyInto(props, node) {
  const kids = [...node.children]
  const keyEl = kids.find(c => (c.localName || c.tagName) === 'key')
  const valEl = kids.find(c => (c.localName || c.tagName) === 'value')
  if (!keyEl) return
  const k = keyEl.textContent?.trim()
  const v = valEl?.textContent?.trim() || ''
  if (k) props[k] = v
}

function getProps(el) {
  const props = {}
  if (!el) return props

  // Only this element's OWN properties. The previous implementation used
  // querySelectorAll('*'), which walks the entire subtree — so a container
  // step (subProcess is in STEP_TAGS) absorbed the properties of every step
  // nested inside it, last-wins. An exception subprocess containing a Groovy
  // step therefore came out with activityType 'Script' and resolveKind
  // reported it as a GroovyScript, complete with a bogus scriptRef.
  // CPI nests properties under <extensionElements>; some elements carry them
  // as direct children instead, so handle both — but never recurse past them.
  for (const child of [...el.children]) {
    const ln = child.localName || child.tagName || ''
    if (ln === 'extensionElements' || ln.endsWith(':extensionElements')) {
      for (const p of [...child.children]) {
        if (isPropertyEl(p)) readPropertyInto(props, p)
      }
    } else if (isPropertyEl(child)) {
      readPropertyInto(props, child)
    }
  }
  return props
}

export function resolveKind(tag, props, name = '') {
  const at  = props.activityType  || props.ComponentType || ''
  const mt  = (props.mappingType  || '').toLowerCase()
  const nl  = name.toLowerCase()
  const sub = (props.subActivityType || '').toLowerCase()

  if (at === 'Script' || sub === 'groovyscript')               return 'GroovyScript'
  if (at === 'Mapping' || mt === 'messagemapping')              return 'MessageMapping'
  if (at === 'Filter')                                          return 'Filter'
  if (at === 'Splitter')                                        return 'Splitter'
  if (at === 'Gather')                                          return 'Gather'
  if (at === 'ExternalCall')                                    return 'ExternalCall'
  if (at === 'contentEnricherWithLookup' || at === 'Enricher')  return 'ContentModifier'  // Enricher = ContentModifier in CPI
  if (at === 'ProcessCallElement')                              return 'ProcessCall'
  if (at === 'XmlModifier')                                     return 'XmlModifier'
  if (at === 'ContentModifier')                                 return 'ContentModifier'
  if (at === 'JsonToXmlConverter')                              return 'JsonToXml'
  if (at === 'XmlToJsonConverter')                              return 'XmlToJson'
  if (at === 'StartEvent')                                      return 'Sender'
  if (at === 'StartErrorEvent')                                 return 'ErrorStart'
  if (at === 'EndEvent')                                        return 'Receiver'
  if (at === 'ErrorEventSubProcessTemplate')                    return 'ErrorSubProcess'
  if (at === 'ExclusiveGateway')                                return 'Router'

  const bare = tag.replace('bpmn2:', '')
  if (bare === 'startEvent')       return 'Sender'
  if (bare === 'endEvent')         return 'Receiver'
  if (bare === 'exclusiveGateway') return 'Router'
  if (bare === 'parallelGateway')  return 'Splitter'
  if (bare === 'subProcess')       return 'SubProcess'
  if (bare === 'serviceTask')      return 'ExternalCall'
  if (bare === 'callActivity') {
    if (nl.includes('groovy') || nl.includes('script'))          return 'GroovyScript'
    if (nl.includes('mapping') || nl.match(/^mm[_ ]/))           return 'MessageMapping'
    if (nl.includes('xslt'))                                     return 'XSLT'
    if (nl.match(/^cm[_ ]/) || nl.includes('content mod'))       return 'ContentModifier'
    if (nl.includes('json to xml') || nl.includes('json2xml'))   return 'JsonToXml'
    if (nl.includes('xml to json') || nl.includes('xml2json'))   return 'XmlToJson'
    if (nl.includes('splitter'))  return 'Splitter'
    if (nl.includes('gather'))    return 'Gather'
    if (nl.includes('filter'))    return 'Filter'
    return 'CallActivity'
  }
  return 'Unknown'
}

/**
 * Parse CPI Content Modifier table (headerTable or propertyTable).
 * Values are HTML-entity-encoded XML stored inside an XML element value.
 * DOMParser.textContent decodes entities, giving us raw XML to re-parse.
 */
/**
 * Escape bare ampersands that are not already part of an entity reference.
 * A Content Modifier value like `${property.a} & ${property.b}` is extremely
 * common and makes the surrounding table unparseable as XML.
 */
function escapeBareAmps(str) {
  return str.replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#[0-9]+;|#x[0-9a-fA-F]+;)/g, '&amp;')
}

/**
 * Last-resort row reader. Pulls <cell id="...">...</cell> out of each <row>
 * textually, so a raw `<` or `>` inside a cell's VALUE (e.g. an expression like
 * `${header.count} < 5`) costs that one cell rather than the whole table.
 */
function extractRowsLenient(xmlStr) {
  const rows = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi
  let rowMatch
  while ((rowMatch = rowRe.exec(xmlStr)) !== null) {
    const cell = {}
    const cellRe = /<cell\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/cell>/gi
    let cellMatch
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const id = cellMatch[1]
      const raw = cellMatch[2]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
      if (id) cell[id] = raw.trim()
    }
    if (Object.keys(cell).length) rows.push(cell)
  }
  return normalizeRows(rows)
}

/**
 * Parse CPI Content Modifier table (headerTable or propertyTable).
 * Values are HTML-entity-encoded XML stored inside an XML element value.
 * DOMParser.textContent decodes entities, giving us raw XML to re-parse.
 *
 * Escalating strategy. The previous version tried strict parse, then a manual
 * unescape that was a no-op on already-decoded text, then returned [] — so a
 * single raw `<` or `&` anywhere in any value silently erased every header and
 * property for that step from the spec document, with no warning.
 */
export function parseCMTable(xmlStr) {
  if (!xmlStr || !xmlStr.trim()) return []
  const attempts = [
    xmlStr,
    escapeBareAmps(xmlStr),
  ]
  for (const candidate of attempts) {
    try {
      const doc = new DOMParser().parseFromString(`<root>${candidate}</root>`, 'text/xml')
      if (!doc.querySelector('parsererror')) return extractRows(doc)
    } catch { /* fall through to the next strategy */ }
  }
  // Still unparseable — recover what we can textually rather than losing the lot.
  const lenient = extractRowsLenient(xmlStr)
  if (lenient.length) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`[parseCMTable] table was not well-formed XML; recovered ${lenient.length} row(s) leniently. A cell value probably contains a raw < or &.`)
    }
    return lenient
  }
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('[parseCMTable] could not parse Content Modifier table; headers/properties for this step will be missing.')
  }
  return []
}

/**
 * Turn raw {cellId: text} maps into the row shape the rest of the app expects.
 * Shared by the strict (DOM) and lenient (textual) readers so the two cannot
 * produce different results for the same table.
 */
function normalizeRows(cells) {
  const rows = []
  cells.forEach(cell => {
    if (!cell.Name) return

    const rawType = (cell.Type || cell.SourceType || '').toLowerCase().trim()
    let type = 'constant'
    if (rawType === 'xpath' || rawType === 'xpath expression')   type = 'xpath'
    else if (rawType === 'expression' || rawType === 'groovy')   type = 'expression'
    else if (rawType === 'header')                               type = 'header'
    else if (rawType === 'property')                             type = 'property'
    else if (rawType === 'body' || rawType === 'message body')   type = 'body'

    rows.push({
      name:     cell.Name,
      value:    cell.Value || cell.Default || '',
      type,
      dataType: cell['Data Type'] || cell.Datatype || 'java.lang.String',
      action:   (cell.Action || 'Create').toLowerCase(),
      xpath:    type === 'xpath' ? (cell.Value || '') : null,
    })
  })
  return rows
}

function extractRows(doc) {
  const cells = []
  doc.querySelectorAll('row').forEach(row => {
    const cell = {}
    row.querySelectorAll('cell').forEach(c => {
      const id = c.getAttribute('id')
      if (id) cell[id] = c.textContent?.trim() || ''
    })
    cells.push(cell)
  })
  return normalizeRows(cells)
}

/**
 * Canonical ProcessDirect address: always `pd://` + path with no leading slash.
 *
 * The old version returned `'pd:/' + s.slice(4)` for a `pd:/` input, which
 * rebuilt the input unchanged (the intent was `pd://`). A single-slash address
 * therefore stayed single-slash while a bare name became `pd://name`, and
 * specProcessDirect stripped only `pd://` — so the two forms never matched and
 * a resolvable call rendered as "not in package".
 */
export function normalizePDAddress(addr) {
  if (!addr) return ''
  const s = String(addr).trim()
  if (!s) return ''
  // Strip any leading pd: scheme and all leading slashes, then rebuild once.
  const path = s.replace(/^pd:/i, '').replace(/^\/+/, '')
  if (!path) return ''
  return 'pd://' + path
}

/**
 * Comparison key for two ProcessDirect addresses. Case- and slash-insensitive,
 * so `pd://Orders`, `/orders` and `Orders` all compare equal. Every module that
 * matches addresses must use THIS — flowSet.js and dependencies.js previously
 * each had their own, and they disagreed on case, which meant a pair could link
 * in the Spec Builder and not in impact analysis.
 */
export function pdKey(addr) {
  if (!addr) return ''
  return normalizePDAddress(addr).slice('pd://'.length).replace(/\/+$/, '').toLowerCase()
}

// Exported so it can be tested directly. parseZip() is the only production
// caller, but the parsing logic here is the highest-risk code in the app and it
// had no direct test coverage at all while it was module-private.
export function parseIFlw(xml, fallbackName, scripts = {}, xslts = {}, mmaps = {}) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const steps = {}, edges = [], entryPoints = [], exitPoints = []
  const adapterMap = {}
  const adapterList = []

  // Process name — find participant with IntegrationProcess type
  let processName = fallbackName
  const allEls = [...doc.querySelectorAll('*')]
  const intProc = allEls.find(el =>
    (el.localName === 'participant' || el.tagName?.includes('participant')) &&
    (el.getAttribute('ifl:type') === 'IntegrationProcess' ||
     getProps(el)['ifl:type'] === 'IntegrationProcess')
  )
  if (intProc) processName = intProc.getAttribute('name') || fallbackName

  // MessageFlows — adapter details
  const msgFlows = allEls.filter(el =>
    el.localName === 'messageFlow' || el.tagName === 'bpmn2:messageFlow'
  )

  // Deferred: must run AFTER BPMN steps are built, otherwise srcKnown/tgtKnown
  // are always false and entry/exit points never get created.
  const processMsgFlows = () => msgFlows.forEach(mf => {
    const props     = getProps(mf)
    const mfName    = mf.getAttribute('name') || ''
    const sourceRef = mf.getAttribute('sourceRef')
    const targetRef = mf.getAttribute('targetRef')
    // Never fall back to mfName: a ProcessDirect message flow with no
    // ComponentType would take its own *name* as its adapter type, so
    // dependencies.js classified it as a plain endpoint instead of a
    // processDirect link and the chain broke with no error.
    const addrType  = props.ComponentType || props.componentType || 'HTTP'
    const rawAddr   = props.address || props.urlPath || props.httpAddressWithoutQuery || ''
    const address   = addrType === 'ProcessDirect' ? normalizePDAddress(rawAddr) : rawAddr
    const direction = props.direction || props.system || ''

    const adapterDetails = {
      adapterType:   addrType,
      direction,
      address,
      authMethod:    props.authenticationMethod || props.senderAuthType || '',
      csrfProtected: props.csrfProtected || props.xsrfProtection || '',
      operation:     props.operation || props.httpMethod || 'POST',
      userRole:      props.userRole || '',
      resourcePath:  props.resourcePath || '',
      rawProps:      props,
      messageFlowId: mf.getAttribute('id') || '',
      messageFlowName: mfName,
      sourceRef, targetRef,
    }

    // Keep a full adapter list — every messageFlow, even ones connecting to participants only.
    adapterList.push(adapterDetails)

    if (sourceRef) adapterMap[sourceRef] = adapterDetails
    if (targetRef) adapterMap[targetRef] = adapterDetails

    if (sourceRef && targetRef) {
      const srcKnown = !!steps[sourceRef]
      const tgtKnown = !!steps[targetRef]

      if (!srcKnown && tgtKnown) {
        const pEl = allEls.find(el => el.getAttribute('id') === sourceRef)
        const pName = pEl?.getAttribute('name') || 'Sender'
        steps[sourceRef] = {
          id: sourceRef, name: pName,
          kind: addrType === 'ProcessDirect' ? 'ProcessDirectReceiver' : 'Sender',
          config: { ...adapterDetails }
        }
        edges.push({ source: sourceRef, target: targetRef, condition: null, name: null })
        if (addrType === 'ProcessDirect') entryPoints.push({ adapterType: 'ProcessDirect', address })
        else if (address) entryPoints.push({ adapterType: addrType, address })
      } else if (srcKnown && !tgtKnown) {
        if (steps[sourceRef]) steps[sourceRef].config = { ...steps[sourceRef].config, ...adapterDetails }
        if (addrType === 'ProcessDirect') exitPoints.push({ stepId: sourceRef, adapterType: 'ProcessDirect', address })
        else exitPoints.push({ stepId: sourceRef, adapterType: addrType, address })
      }
    }
  })

  // BPMN process elements
  const STEP_TAGS = new Set([
    'callActivity','startEvent','endEvent','exclusiveGateway',
    'parallelGateway','serviceTask','subProcess'
  ])

  allEls.forEach(el => {
    const ln = el.localName || ''
    if (!STEP_TAGS.has(ln)) return

    const id   = el.getAttribute('id')
    const name = el.getAttribute('name') || id
    if (!id || steps[id]) return

    const props = getProps(el)
    const kind  = resolveKind(el.tagName, props, name)
    const config = { ...props }

    if (kind === 'ContentModifier') {
      config.headers    = parseCMTable(props.headerTable   || '')
      config.properties = parseCMTable(props.propertyTable || '')
      config.bodyConfig = props.bodyText || props.messageBodyText || null
      config.bodyType   = props.bodyType || null

      // Debug: log what we found
      config._debug = {
        hasHeaderTable:   !!props.headerTable,
        hasPropertyTable: !!props.propertyTable,
        headerCount:      config.headers.length,
        propertyCount:    config.properties.length,
      }
    }

    if (kind === 'GroovyScript') {
      const ref = props.script || props.scriptName || ''
      config.scriptRef = ref
      config.preview   = scripts[ref] || null
      if (config.preview) {
        config.scriptMatch = 'exact'
      } else {
        const nl = name.toLowerCase().replace(/\s+/g,'')
        const match = Object.keys(scripts).find(k =>
          k.replace('.groovy','').toLowerCase().replace(/[_ ]/g,'').includes(nl.slice(0,5))
        )
        if (match) {
          config.preview = scripts[match]
          config.scriptMatch = 'fuzzy'          // matched by name heuristic — may be wrong
          config.scriptMatchName = match
        } else {
          // No reliable match — do NOT silently load an unrelated script
          config.preview = null
          config.scriptMatch = 'none'
          config.availableScripts = Object.keys(scripts)
        }
      }
    }

    if (kind === 'MessageMapping') {
      config.mappingRef  = props.mappingname || props.mappinguri || ''
      config.mappingPath = props.mappingpath || ''
    }

    if (kind === 'XSLT') {
      const ref = props.xsltName || props.mappinguri || props.xsltFileName || ''
      config.xsltRef = ref
      config.xsltContent = xslts[ref] || (Object.keys(xslts).length === 1 ? Object.values(xslts)[0] : null)
    }

    if (kind === 'Splitter') {
      config.splitExpression = props.xpathExpression || props.splitExpression || props.expression || ''
      config.splitType = props.splitterType || props.subActivityType || 'General'
    }

    if (kind === 'ProcessCall') {
      const rawAddr = props.address || ''
      config.pdAddress = normalizePDAddress(rawAddr)
      exitPoints.push({ stepId: id, adapterType: 'ProcessDirect', address: config.pdAddress })
    }

    if (['ExternalCall','ContentEnricher'].includes(kind)) {
      config.adapterType = props.ComponentType || 'ExternalCall'
      config.address     = props.address || props.httpAddressWithoutQuery || ''
    }

    steps[id] = { id, name, kind, config }
  })

  // Now that steps exist, resolve adapters / entry / exit points
  processMsgFlows()

  // Sequence flows
  allEls.forEach(el => {
    if (el.localName !== 'sequenceFlow') return
    const condEl = [...el.children].find(c => ['conditionExpression','tFormalExpression'].includes(c.localName))
    edges.push({
      source:    el.getAttribute('sourceRef'),
      target:    el.getAttribute('targetRef'),
      condition: condEl ? condEl.textContent.trim() : null,
      name:      el.getAttribute('name') || null
    })
  })

  const startId =
    Object.keys(steps).find(id => steps[id].kind === 'Sender' && !steps[id].name.toLowerCase().includes('error')) ||
    Object.keys(steps).find(id => steps[id].kind === 'ProcessDirectReceiver') ||
    Object.keys(steps).find(id => steps[id].kind === 'Sender') ||
    Object.keys(steps)[0]

  return {
    id: fallbackName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0,40),
    name: processName,
    iflwName: fallbackName,  // artifact name from .iflw filename — used for trace matching
    steps, edges, startId, entryPoints, exitPoints, adapterMap, adapterList,
    // Everything bundled in the ZIP, so dead-asset detection can compare
    // bundled-vs-referenced. Names only (not contents) to keep it light.
    bundled: {
      scripts: Object.keys(scripts || {}),
      xslts:   Object.keys(xslts   || {}),
      mappings: Object.keys(mmaps  || {}),
    },
  }
}
