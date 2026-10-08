// ProcessDirect chain resolver across loaded iFlows.
//
// For each iFlow, finds every ProcessDirect call (Receiver direction = outgoing call
// from this flow to another iFlow's Sender PD endpoint). If the target Sender endpoint
// exists in another loaded iFlow, mark it resolved; otherwise mark "not in package".

import { normalizePDAddress, pdKey } from './parser.js'

// Matching and display are two different things. Matching uses pdKey() — the
// same case-insensitive key every other module uses. Display keeps the author's
// original casing, so the UI shows `Orders_Split`, not `orders_split`.
const displayAddr = (a) => normalizePDAddress(a).replace(/^pd:\/\//, '')

// Index every PD Sender endpoint across the registry: address -> [{flow}]
function buildSenderIndex(flows) {
  const idx = new Map()
  for (const flow of flows) {
    for (const a of flow.adapterList || []) {
      const t = (a.rawProps?.ComponentType || a.adapterType)
      const dir = a.rawProps?.direction
      if (t === 'ProcessDirect' && dir === 'Sender') {
        const key = pdKey(a.address || a.rawProps?.address)
        if (!key) continue
        if (!idx.has(key)) idx.set(key, [])
        idx.get(key).push({ flowId: flow.id, flowName: flow.name })
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
    const raw = a.address || a.rawProps?.address
    const addr = displayAddr(raw)
    const key = pdKey(raw)
    const dir = a.rawProps?.direction

    if (dir === 'Receiver') {
      // Outgoing PD call. Look up the target Sender across loaded flows (exclude self).
      const matches = (senderIndex.get(key) || []).filter(m => m.flowId !== flow.id)
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
