import JSZip from 'jszip'

export const FLOW_COLORS = [
  '#3fb950','#58a6ff','#bc8cff','#f0883e','#14b8a6',
  '#f59e0b','#06b6d4','#a78bfa','#34d399','#fb923c'
]

export async function parseZip(file) {
  const zip = await JSZip.loadAsync(file)
  const scripts = {}, xslts = {}, mmaps = {}

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    if (path.endsWith('.groovy')) scripts[path.split('/').pop()] = await entry.async('string')
    if (path.endsWith('.xsl') || path.endsWith('.xslt')) xslts[path.split('/').pop()] = await entry.async('string')
    if (path.endsWith('.mmap')) mmaps[path.split('/').pop()] = path
  }

  let iflwText = null, iflwName = file.name.replace('.zip','')
  for (const [path, entry] of Object.entries(zip.files)) {
    if (!entry.dir && path.endsWith('.iflw')) {
      iflwText = await entry.async('string')
      iflwName = path.split('/').pop().replace('.iflw','')
      break
    }
  }
  if (!iflwText) throw new Error('No .iflw file found in ZIP')
  const flow = parseIFlw(iflwText, iflwName, scripts, xslts, mmaps)
  flow.zipName = file.name || ''
  flow.iflwName = iflwName  // the .iflw artifact name — used for trace matching
  return flow
}

/**
 * Robust property extractor — handles both ifl:property and property elements.
 * Uses key/value child text content, which works with any namespace prefix.
 */
function getProps(el) {
  const props = {}
  // Find all elements whose localName is 'property' regardless of namespace
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
export function parseCMTable(xmlStr) {
  if (!xmlStr || !xmlStr.trim()) return []
  try {
    // CPI stores the table as HTML-encoded XML inside the value element.
    // textContent already decoded it, so we just wrap and parse.
    const wrapped = `<root>${xmlStr}</root>`
    const doc = new DOMParser().parseFromString(wrapped, 'text/xml')
    if (doc.querySelector('parsererror')) {
      // Try unescaping manually if DOMParser fails
      const unescaped = xmlStr
        .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'")
      const doc2 = new DOMParser().parseFromString(`<root>${unescaped}</root>`, 'text/xml')
      if (doc2.querySelector('parsererror')) return []
      return extractRows(doc2)
    }
    return extractRows(doc)
  } catch { return [] }
}

function extractRows(doc) {
  const rows = []
  doc.querySelectorAll('row').forEach(row => {
    const cell = {}
    row.querySelectorAll('cell').forEach(c => {
      const id = c.getAttribute('id')
      if (id) cell[id] = c.textContent?.trim() || ''
    })
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

export function normalizePDAddress(addr) {
  if (!addr) return ''
  const s = addr.trim()
  if (s.startsWith('pd://')) return s
  if (s.startsWith('pd:/'))  return 'pd:/' + s.slice(4)
  if (s.startsWith('/'))     return 'pd:/' + s
  return 'pd://' + s
}

function parseIFlw(xml, fallbackName, scripts, xslts, mmaps) {
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
    const addrType  = props.ComponentType || props.componentType || mfName || 'HTTP'
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
