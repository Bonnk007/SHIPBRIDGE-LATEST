// Generic adapter field extractor for the Spec Builder.
// Reads the raw <ifl:property> bag from each messageFlow and groups fields
// into sensible buckets. Every value carries a source tag so the UI can
// show "Extracted from iFlow" vs "Not found" vs "User entered".

// Keys that describe ShipBridge/CPI internals, not real config.
const INTERNAL = new Set([
  'ComponentNS', 'ComponentSWCVId', 'ComponentSWCVName', 'Vendor',
  'componentVersion', 'cmdVariantUri', 'TransportProtocolVersion',
  'MessageProtocolVersion', 'enableMPLAttachments', 'isXSDGenerationRequired',
])

// Categorize a key by its meaning — purely lexical, no AI needed.
function classify(key) {
  const k = key.toLowerCase()
  if (/(auth|credential|token|alias|user|password|oauth|secret)/.test(k)) return 'security'
  if (/(address|url|host|endpoint|path|port|resource|proxy)/.test(k))     return 'endpoint'
  if (/(protocol|message)/.test(k))                                       return 'transport'
  if (/(timeout|retry|chunk|page|pagination|size|connectionreuse)/.test(k)) return 'tuning'
  if (/(method|operation|verb|httpmethod|query|field|filter|select|orderby|format)/.test(k)) return 'operation'
  if (/(header|content[-]?type|csrf|cors)/.test(k))                       return 'protocol'
  if (/(direction|system|name|type)/.test(k))                             return 'identity'
  return 'other'
}

const GROUP_LABEL = {
  identity:  'Identity',
  endpoint:  'Endpoint',
  transport: 'Transport',
  security:  'Security',
  operation: 'Operation',
  tuning:    'Tuning',
  protocol:  'Protocol',
  other:     'Other',
}

// Pretty-print a camelCase or PascalCase key.
function humanLabel(k) {
  return k
    .replace(/^[a-z]/, c => c.toUpperCase())
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
}

// One adapter -> { type, direction, name, fields: [{ group, key, label, value, source }] }
export function extractAdapter(adapter) {
  const props = adapter.rawProps || {}
  const fields = []
  for (const [k, v] of Object.entries(props)) {
    if (INTERNAL.has(k)) continue
    const value = (v ?? '').toString().trim()
    if (!value && k.toLowerCase() !== 'address') continue   // keep address even if blank (signal: missing)
    fields.push({
      group: classify(k),
      key: k,
      label: humanLabel(k),
      value: value || '(blank)',
      source: value ? 'extracted' : 'missing',
    })
  }
  // Stable group order, then alpha within
  const ORDER = ['identity', 'endpoint', 'transport', 'security', 'operation', 'protocol', 'tuning', 'other']
  fields.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group) || a.label.localeCompare(b.label))

  return {
    id:        adapter.messageFlowId || `${adapter.adapterType}-${Math.random().toString(36).slice(2, 7)}`,
    type:      adapter.adapterType || 'Unknown',
    direction: (props.direction || 'Unknown'),     // literal 'direction' property is the truth
    name:      adapter.messageFlowName || adapter.adapterType,
    address:   (adapter.address || '').replace(/^pd:\/\//, ''),  // strip internal prefix; show raw CPI path
    fields,
  }
}

// Group fields by their classification, for rendering as sections.
export function groupAdapterFields(adapter) {
  const groups = {}
  for (const f of adapter.fields) {
    if (!groups[f.group]) groups[f.group] = { label: GROUP_LABEL[f.group], fields: [] }
    groups[f.group].fields.push(f)
  }
  return groups
}

// All adapters from one parsed iFlow, separated by direction.
export function extractAllAdapters(flow) {
  const list = (flow?.adapterList || []).map(extractAdapter)
  const senders   = list.filter(a => /sender/i.test(a.direction))
  const receivers = list.filter(a => /receiver/i.test(a.direction))
  const other     = list.filter(a => !/sender|receiver/i.test(a.direction))
  return { all: list, senders, receivers, other }
}
