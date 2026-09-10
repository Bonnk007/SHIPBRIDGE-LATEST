// ProcessDirect chain resolver across loaded iFlows.
//
// For each iFlow, finds every ProcessDirect call (Receiver direction = outgoing call
// from this flow to another iFlow's Sender PD endpoint). If the target Sender endpoint
// exists in another loaded iFlow, mark it resolved; otherwise mark "not in package".

const normalize = (a) => (a || '').trim().replace(/^pd:\/\//, '').replace(/\/+$/, '')

// Index every PD Sender endpoint across the registry: address -> [{flow}]
function buildSenderIndex(flows) {
  const idx = new Map()
  for (const flow of flows) {
    for (const a of flow.adapterList || []) {
      const t = (a.rawProps?.ComponentType || a.adapterType)
      const dir = a.rawProps?.direction
      if (t === 'ProcessDirect' && dir === 'Sender') {
        const addr = normalize(a.address || a.rawProps?.address)
        if (!addr) continue
        if (!idx.has(addr)) idx.set(addr, [])
        idx.get(addr).push({ flowId: flow.id, flowName: flow.name })
      }
    }
  }
  return idx
}

// Returns { calls: [{ from, address, resolved, targets }], inbound: [{ to, address }] }
//   `calls`   — what this flow CALLS (its Receiver PD adapters)
//   `inbound` — what this flow IS CALLED AS (its Sender PD adapters)
export function resolveProcessDirect(flow, allFlows) {
  if (!flow) return { calls: [], inbound: [] }
  const senderIndex = buildSenderIndex(allFlows)

  const calls = [], inbound = []
  for (const a of flow.adapterList || []) {
    const t = (a.rawProps?.ComponentType || a.adapterType)
    if (t !== 'ProcessDirect') continue
    const addr = normalize(a.address || a.rawProps?.address)
    const dir = a.rawProps?.direction

    if (dir === 'Receiver') {
      // Outgoing PD call. Look up the target Sender across loaded flows (exclude self).
      const matches = (senderIndex.get(addr) || []).filter(m => m.flowId !== flow.id)
      calls.push({
        from: flow.name,
        address: addr,
        resolved: matches.length > 0,
        targets: matches,
      })
    } else if (dir === 'Sender') {
      inbound.push({ to: flow.name, address: addr })
    }
  }
  // Dedupe identical outgoing calls (CPI flows often call the same PD many times).
  const seen = new Set()
  const dedupedCalls = []
  for (const c of calls) {
    const k = c.address
    if (seen.has(k)) continue
    seen.add(k); dedupedCalls.push(c)
  }
  return { calls: dedupedCalls, inbound }
}

// Across all loaded flows: a flat picture of every PD link in the workspace.
export function landscapeProcessDirect(allFlows) {
  const senderIndex = buildSenderIndex(allFlows)
  const links = []
  for (const flow of allFlows) {
    const { calls } = resolveProcessDirect(flow, allFlows)
    calls.forEach(c => links.push({ from: flow.name, ...c }))
  }
  return { links, exposedEndpoints: [...senderIndex.entries()].map(([a, fs]) => ({ address: a, flows: fs })) }
}
