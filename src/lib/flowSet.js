// Working out which iFlows belong in one specification document.
//
// A business process rarely lives in a single iFlow. A main flow calls
// sub-flows over ProcessDirect, which call shared utility flows (mail alerts,
// logging), and documenting the process means documenting all of them.
// Asking a human to list them by hand is how a flow gets left out of a spec —
// and a missing sub-flow is the kind of gap nobody notices until someone has
// to maintain the thing two years later.
//
// ShipBridge already parses ProcessDirect entry and exit points, so the set
// can be derived instead: start at the main flow and follow the chain.

import { buildIndex } from './dependencies.js'

const norm = (a) => String(a || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase()

// Map every ProcessDirect address to the flows that send to it and the flows
// that listen on it. `producers` send, `consumers` receive.
function pdChannels(flows) {
  const channels = new Map()
  const touch = (addr) => {
    const a = norm(addr)
    if (!channels.has(a)) channels.set(a, { producers: new Set(), consumers: new Set() })
    return channels.get(a)
  }
  for (const flow of flows) {
    for (const ep of flow.exitPoints || []) {
      if (ep.adapterType === 'ProcessDirect') touch(ep.address).producers.add(flow.id)
    }
    for (const ep of flow.entryPoints || []) {
      if (ep.adapterType === 'ProcessDirect') touch(ep.address).consumers.add(flow.id)
    }
  }
  return channels
}

/**
 * Resolve the full set of flows reachable from `rootId`.
 *
 * Returns:
 *   ordered  — flows in document order: root first, then breadth-first along
 *              the ProcessDirect chain, so the document reads in call order.
 *   relations— per flow: how it's reached ({ via, calledBy }) for the root's
 *              descendants; the root itself has none.
 *   missing  — ProcessDirect addresses that a selected flow calls but which no
 *              uploaded flow listens on. These are the forgotten iFlows.
 *   depth    — hop count from the root, for indenting or labelling.
 */
export function resolveFlowSet(registry, rootId) {
  const flows = [...(registry?.values?.() || [])]
  const byId = new Map(flows.map(f => [f.id, f]))
  const root = byId.get(rootId)
  if (!root) return { ordered: [], relations: {}, missing: [], depth: {} }

  const channels = pdChannels(flows)
  const ordered = [root]
  const seen = new Set([rootId])
  const relations = {}
  const depth = { [rootId]: 0 }
  const missing = []
  const missingSeen = new Set()

  // Breadth-first so the document lists flows in the order they're called,
  // not in whatever order the Map happened to iterate.
  const queue = [rootId]
  while (queue.length) {
    const currentId = queue.shift()
    const current = byId.get(currentId)
    if (!current) continue

    for (const ep of current.exitPoints || []) {
      if (ep.adapterType !== 'ProcessDirect') continue
      const addr = norm(ep.address)
      const channel = channels.get(addr)
      const listeners = [...(channel?.consumers || [])].filter(id => id !== currentId)

      // Nobody listens on this address among the uploaded flows — the target
      // iFlow either wasn't uploaded, or genuinely doesn't exist.
      if (!listeners.length) {
        if (!missingSeen.has(addr)) {
          missingSeen.add(addr)
          missing.push({ address: ep.address, calledBy: currentId, calledByName: current.name })
        }
        continue
      }

      for (const id of listeners) {
        if (seen.has(id)) continue
        seen.add(id)
        depth[id] = (depth[currentId] ?? 0) + 1
        relations[id] = { via: ep.address, calledBy: currentId, calledByName: current.name }
        ordered.push(byId.get(id))
        queue.push(id)
      }
    }
  }

  return { ordered, relations, missing, depth }
}

/**
 * Validate a user-chosen set of flows.
 *
 * People edit the auto-discovered list — deselecting something they consider
 * out of scope, or adding a flow the graph didn't reach. Both are legitimate,
 * but a set that omits a flow the others call produces a document describing a
 * chain that dead-ends. This reports that without blocking it: the user may
 * have a good reason, so it's a warning, not an error.
 */
export function validateFlowSet(registry, selectedIds) {
  const flows = [...(registry?.values?.() || [])]
  const byId = new Map(flows.map(f => [f.id, f]))
  const selected = selectedIds.map(id => byId.get(id)).filter(Boolean)
  const selectedSet = new Set(selectedIds)
  const channels = pdChannels(flows)

  const warnings = []

  for (const flow of selected) {
    for (const ep of flow.exitPoints || []) {
      if (ep.adapterType !== 'ProcessDirect') continue
      const channel = channels.get(norm(ep.address))
      const listeners = [...(channel?.consumers || [])].filter(id => id !== flow.id)

      if (!listeners.length) {
        warnings.push({
          kind: 'not-uploaded',
          text: `${flow.name} calls ${ep.address} via ProcessDirect, but no uploaded iFlow listens on that address. Upload it, or the document will describe a chain that dead-ends.`,
        })
        continue
      }
      const included = listeners.filter(id => selectedSet.has(id))
      if (!included.length) {
        const names = listeners.map(id => byId.get(id)?.name || id).join(', ')
        warnings.push({
          kind: 'not-selected',
          text: `${flow.name} calls ${ep.address}, handled by ${names} — which isn't included in this document.`,
        })
      }
    }
  }

  // A flow nobody in the set calls and which has no external entry point is
  // probably here by accident.
  for (const flow of selected) {
    const hasExternalEntry = (flow.entryPoints || []).some(ep => ep.adapterType !== 'ProcessDirect')
    if (hasExternalEntry) continue
    const isCalledBySelected = selected.some(other =>
      other.id !== flow.id &&
      (other.exitPoints || []).some(ep =>
        ep.adapterType === 'ProcessDirect' &&
        (flow.entryPoints || []).some(en => en.adapterType === 'ProcessDirect' && norm(en.address) === norm(ep.address))))
    if (!isCalledBySelected) {
      warnings.push({
        kind: 'orphan',
        text: `${flow.name} has no external sender and isn't called by any other flow in this document — check it belongs here.`,
      })
    }
  }

  return { warnings }
}

// A one-line description of how a flow is entered, for the per-flow heading in
// the document. Extracted, never written by hand.
export function describeEntry(flow, relation) {
  if (relation?.via) {
    return `Called by ${relation.calledByName} via ProcessDirect ${relation.via}`
  }
  const external = (flow.entryPoints || []).filter(ep => ep.adapterType !== 'ProcessDirect')
  if (external.length) {
    const e = external[0]
    return `Entry point: ${e.adapterType}${e.address ? ` ${e.address}` : ''}`
  }
  const pd = (flow.entryPoints || []).find(ep => ep.adapterType === 'ProcessDirect')
  if (pd) return `ProcessDirect endpoint ${pd.address}`
  return 'No inbound channel detected'
}
