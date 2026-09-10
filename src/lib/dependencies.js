// ── CPI Dependency Intelligence ──────────────────────────────────────────
// Pure analysis layer built on top of parseIFlw() output. No runtime, no AI.
// Given many parsed flows, build a reverse index from shared resources to the
// flows that reference them, then answer impact / landscape questions.
//
// Each input flow is the object returned by parseIFlw():
//   { id, name, steps, edges, startId, entryPoints, exitPoints, adapterMap }

// Resource kinds we track across the landscape.
export const RESOURCE_KINDS = [
  'script',        // Groovy scripts
  'xslt',          // XSLT transforms
  'mapping',       // message mappings
  'processDirect', // pd:// channels (the cross-flow glue)
  'valueMapping',  // value mapping references
  'certificate',   // security material / certificate aliases
  'endpoint',      // external adapter endpoints (http/sftp/odata/...)
]

function norm(v) {
  return (v == null ? '' : String(v)).trim()
}

// Extract every resource a single flow references, as {kind, name} pairs.
export function flowResources(flow) {
  const out = []
  const add = (kind, name) => { const n = norm(name); if (n) out.push({ kind, name: n }) }

  for (const step of Object.values(flow.steps || {})) {
    const c = step.config || {}
    if (step.kind === 'GroovyScript')  add('script', c.scriptRef || c.scriptMatchName)
    if (step.kind === 'XSLT')          add('xslt', c.xsltRef || c.scriptRef)
    if (step.kind === 'MessageMapping') add('mapping', c.mappingRef || c.mappingPath)

    // Value mappings can appear on mappings or content modifiers
    if (c.valueMapping) add('valueMapping', c.valueMapping)
    if (Array.isArray(c.valueMappings)) c.valueMappings.forEach(v => add('valueMapping', v))

    // Certificates / security material referenced by adapters
    if (c.privateKeyAlias)   add('certificate', c.privateKeyAlias)
    if (c.publicKeyAlias)    add('certificate', c.publicKeyAlias)
    if (c.credentialName)    add('certificate', c.credentialName)
  }

  // ProcessDirect channels — both ends matter for chaining
  for (const ep of flow.exitPoints || []) {
    if (ep.adapterType === 'ProcessDirect') add('processDirect', ep.address)
    else if (ep.address) add('endpoint', ep.address)
  }
  for (const ep of flow.entryPoints || []) {
    if (ep.adapterType === 'ProcessDirect') add('processDirect', ep.address)
    else if (ep.address) add('endpoint', ep.address)
  }

  // De-dupe within a single flow
  const seen = new Set()
  return out.filter(r => {
    const k = r.kind + '::' + r.name
    if (seen.has(k)) return false
    seen.add(k); return true
  })
}

// Build the reverse index: resource -> flows that use it.
// Returns { index: Map<kind, Map<name, Set<flowId>>>, flows: Map<id, flow> }
export function buildIndex(flows) {
  const index = new Map()
  const flowMap = new Map()
  for (const kind of RESOURCE_KINDS) index.set(kind, new Map())

  for (const flow of flows) {
    flowMap.set(flow.id, flow)
    for (const { kind, name } of flowResources(flow)) {
      const byName = index.get(kind)
      if (!byName.has(name)) byName.set(name, new Set())
      byName.get(name).add(flow.id)
    }
  }
  return { index, flows: flowMap }
}

// "Which flows use <resource>?"  Returns array of flow ids.
export function usedBy(idx, kind, name) {
  const byName = idx.index.get(kind)
  if (!byName) return []
  const set = byName.get(norm(name))
  return set ? [...set] : []
}

// ── ProcessDirect chain resolution ────────────────────────────────────────
// A flow that exits to pd://X is "calling" any flow that enters on pd://X.
function pdCallers(idx) {
  // Map pd address -> { producers: Set<flowId>, consumers: Set<flowId> }
  const channels = new Map()
  for (const flow of idx.flows.values()) {
    for (const ep of flow.exitPoints || []) {
      if (ep.adapterType !== 'ProcessDirect') continue
      const a = norm(ep.address)
      if (!channels.has(a)) channels.set(a, { producers: new Set(), consumers: new Set() })
      channels.get(a).producers.add(flow.id)
    }
    for (const ep of flow.entryPoints || []) {
      if (ep.adapterType !== 'ProcessDirect') continue
      const a = norm(ep.address)
      if (!channels.has(a)) channels.set(a, { producers: new Set(), consumers: new Set() })
      channels.get(a).consumers.add(flow.id)
    }
  }
  return channels
}

// Direct downstream flows reachable from `flowId` via ProcessDirect.
export function downstreamFlows(idx, flowId) {
  const channels = pdCallers(idx)
  const flow = idx.flows.get(flowId)
  if (!flow) return []
  const out = new Set()
  for (const ep of flow.exitPoints || []) {
    if (ep.adapterType !== 'ProcessDirect') continue
    const ch = channels.get(norm(ep.address))
    if (ch) ch.consumers.forEach(c => { if (c !== flowId) out.add(c) })
  }
  return [...out]
}

// ── Impact analysis ────────────────────────────────────────────────────────
// "If I change <resource>, who is affected (directly + transitively via pd)?"
export function impactOf(idx, kind, name) {
  const direct = usedBy(idx, kind, name)
  const affected = new Set(direct)
  const queue = [...direct]
  // Walk ProcessDirect downstream so callers of an affected flow are flagged too
  while (queue.length) {
    const id = queue.shift()
    for (const down of downstreamFlows(idx, id)) {
      if (!affected.has(down)) { affected.add(down); queue.push(down) }
    }
  }
  return {
    direct,
    transitive: [...affected].filter(id => !direct.includes(id)),
    all: [...affected],
  }
}

// ── Dead asset detection ───────────────────────────────────────────────────
// Assets bundled in a flow's ZIP but referenced by no step in any flow.
// Returns { scripts: [...], xslts: [...], mappings: [...] } of dead asset names.
export function deadAssets(idx) {
  const flows = [...idx.flows.values()]

  // What's bundled across all flows
  const bundled = { scripts: new Set(), xslts: new Set(), mappings: new Set() }
  for (const f of flows) {
    const b = f.bundled || {}
    ;(b.scripts  || []).forEach(n => bundled.scripts.add(norm(n)))
    ;(b.xslts    || []).forEach(n => bundled.xslts.add(norm(n)))
    ;(b.mappings || []).forEach(n => bundled.mappings.add(norm(n)))
  }

  // What's actually referenced (index keys come from flowResources)
  const refScripts  = new Set(idx.index.get('script').keys())
  const refXslts    = new Set(idx.index.get('xslt').keys())
  const refMappings = new Set(idx.index.get('mapping').keys())

  const dead = (bundledSet, refSet) =>
    [...bundledSet].filter(name => !refSet.has(name)).sort()

  return {
    scripts:  dead(bundled.scripts,  refScripts),
    xslts:    dead(bundled.xslts,    refXslts),
    mappings: dead(bundled.mappings, refMappings),
  }
}

// ── Circular ProcessDirect dependency detection ────────────────────────────
// Finds cycles in the flow-to-flow call graph built from ProcessDirect.
// Returns an array of cycles, each a closed list of flow ids: ['A','B','C','A'].
export function circularDependencies(idx) {
  // Build adjacency: flow -> flows it calls downstream via pd
  const adj = new Map()
  for (const id of idx.flows.keys()) adj.set(id, downstreamFlows(idx, id))

  const cycles = []
  const seenCycles = new Set()         // canonical signature dedupe
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map([...idx.flows.keys()].map(id => [id, WHITE]))
  const stack = []

  function recordCycle(startId) {
    const i = stack.indexOf(startId)
    if (i < 0) return
    const cyc = stack.slice(i)
    // Canonical signature: rotate to smallest id first so A>B>A == B>A>B
    const min = [...cyc].sort()[0]
    const r = cyc.indexOf(min)
    const rotated = [...cyc.slice(r), ...cyc.slice(0, r)]
    const sig = rotated.join('>')
    if (seenCycles.has(sig)) return
    seenCycles.add(sig)
    cycles.push([...rotated, rotated[0]])   // close the loop for display
  }

  function dfs(u) {
    color.set(u, GRAY)
    stack.push(u)
    for (const v of adj.get(u) || []) {
      if (color.get(v) === GRAY) recordCycle(v)
      else if (color.get(v) === WHITE) dfs(v)
    }
    stack.pop()
    color.set(u, BLACK)
  }

  for (const id of idx.flows.keys()) {
    if (color.get(id) === WHITE) dfs(id)
  }
  return cycles
}

// ── Landscape summary ────────────────────────────────────────────────────────
export function landscape(idx) {
  const flows = [...idx.flows.values()]
  const count = (kind) => idx.index.get(kind).size

  // Shared resources = referenced by 2+ flows (the risky ones to change)
  const shared = {}
  for (const kind of RESOURCE_KINDS) {
    shared[kind] = [...idx.index.get(kind).entries()]
      .filter(([, set]) => set.size > 1)
      .map(([name, set]) => ({ name, flows: [...set], count: set.size }))
      .sort((a, b) => b.count - a.count)
  }

  // Orphans = pd channels produced but never consumed, or consumed but never produced
  const channels = pdCallers(idx)
  const brokenPD = []
  for (const [addr, ch] of channels.entries()) {
    if (ch.producers.size === 0) brokenPD.push({ address: addr, issue: 'consumed but no producer' })
    if (ch.consumers.size === 0) brokenPD.push({ address: addr, issue: 'produced but no consumer' })
  }

  // Complexity per flow = steps + edges + branch count
  const complexity = flows.map(f => {
    const steps = Object.keys(f.steps || {}).length
    const edges = (f.edges || []).length
    const routers = Object.values(f.steps || {}).filter(s => s.kind === 'Router').length
    return { id: f.id, name: f.name, steps, edges, routers, score: steps + edges + routers * 3 }
  }).sort((a, b) => b.score - a.score)

  return {
    totals: {
      flows: flows.length,
      scripts: count('script'),
      xslts: count('xslt'),
      mappings: count('mapping'),
      processDirects: count('processDirect'),
      valueMappings: count('valueMapping'),
      certificates: count('certificate'),
      endpoints: count('endpoint'),
    },
    shared,
    brokenPD,
    complexity,
    mostComplex: complexity[0] || null,
  }
}
