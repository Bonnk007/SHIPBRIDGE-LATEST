import React, { useState, useMemo, useCallback } from 'react'
import { buildIndex, usedBy, impactOf, landscape, deadAssets, circularDependencies, RESOURCE_KINDS } from '../lib/dependencies.js'
import IntelligenceLeft from './IntelligenceLeft.jsx'
import IntelligenceDetail from './IntelligenceDetail.jsx'
import IntelligenceOverview from './IntelligenceOverview.jsx'

const KIND_LABEL = {
  script: 'Groovy Script',
  xslt: 'XSLT',
  mapping: 'Message Mapping',
  valueMapping: 'Value Mapping',
  certificate: 'Certificate',
  processDirect: 'ProcessDirect',
  endpoint: 'Endpoint',
  schema: 'Schema',
}

export { KIND_LABEL }

export default function Intelligence({ registry, onUpload, onRename, onClear }) {
  const flows = useMemo(() => [...(registry?.values() || [])], [registry])
  const idx = useMemo(() => buildIndex(flows), [flows])
  const ls  = useMemo(() => landscape(idx), [idx])
  const dead = useMemo(() => deadAssets(idx), [idx])
  const cycles = useMemo(() => circularDependencies(idx), [idx])
  const deadCount = dead.scripts.length + dead.xslts.length + dead.mappings.length + (dead.schemas?.length || 0)

  const [selected, setSelected] = useState(null)
  const [flowFilter, setFlowFilter] = useState(null)

  // The old dropdown query — preserved
  const [query, setQuery] = useState({ kind: 'script', name: '' })

  const allAssets = useMemo(() => {
    const assets = []
    const seen = new Set()
    for (const kind of RESOURCE_KINDS) {
      const m = idx.index.get(kind)
      if (!m) continue
      for (const [name, flowSet] of m.entries()) {
        const key = kind + '::' + name
        if (seen.has(key)) continue
        seen.add(key)
        const flowIds = [...flowSet]
        const isShared = flowIds.length > 1
        let isDead = false
        const deadLists = { script: dead.scripts, xslt: dead.xslts, mapping: dead.mappings, schema: dead.schemas || [] }
        if (deadLists[kind]) isDead = deadLists[kind].some(d => d.name === name)
        assets.push({ kind, name, flowIds, isShared, isDead })
      }
    }
    return assets.sort((a, b) => a.name.localeCompare(b.name))
  }, [idx, dead])

  const filteredAssets = useMemo(() => {
    if (!flowFilter) return allAssets
    return allAssets.filter(a => a.flowIds.includes(flowFilter))
  }, [allAssets, flowFilter])

  // Dropdown query names
  const queryNames = useMemo(() => {
    const m = idx.index.get(query.kind)
    if (!m) return []
    return [...m.entries()]
      .map(([name, set]) => ({ name, flows: [...set] }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [idx, query.kind])

  // Impact data for selected asset OR dropdown query
  const activeKind = selected?.kind || (query.name ? query.kind : null)
  const activeName = selected?.name || query.name

  const activeResult = useMemo(() => {
    if (!activeKind || !activeName) return null
    return {
      direct: usedBy(idx, activeKind, activeName),
      impact: impactOf(idx, activeKind, activeName),
    }
  }, [idx, activeKind, activeName])

  const flowName = useCallback((id) => registry.get(id)?.name || id, [registry])

  const handleSelectAsset = useCallback((kind, name) => {
    setSelected(prev => (prev?.kind === kind && prev?.name === name) ? null : { kind, name })
    setQuery({ kind, name })
  }, [])

  const handleBack = useCallback(() => {
    setSelected(null)
  }, [])

  if (flows.length === 0) {
    return (
      <div style={{ flex: 1, maxWidth: 900, margin: '40px auto', textAlign: 'center', color: 'var(--text2)' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🧠</div>
        <h2 style={{ color: 'var(--text)' }}>Dependency Intelligence</h2>
        <p style={{ lineHeight: 1.7, fontSize: 15 }}>
          Upload iFlow ZIPs to inspect scripts, mappings, and schemas, detect dead assets,
          and run impact analysis across your landscape.
        </p>
        {onUpload && (
          <label className="btn btn-primary" style={{ cursor: 'pointer', display: 'inline-block', marginTop: 14 }}>
            Upload iFlow ZIPs
            <input type="file" accept=".zip" multiple hidden
              onChange={e => { onUpload(e.target.files); e.target.value = '' }} />
          </label>
        )}
        <p style={{ fontSize: 13.5, color: 'var(--text3)', marginTop: 14, lineHeight: 1.6 }}>
          Dead asset detection and content inspection work on a single iFlow.
          Cross-flow analysis (shared resources, ProcessDirect chains) needs two or more.
        </p>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
      <IntelligenceLeft
        flows={flows}
        flowFilter={flowFilter}
        onSetFlowFilter={setFlowFilter}
        filteredAssets={filteredAssets}
        selected={selected}
        onSelectAsset={handleSelectAsset}
        onUpload={onUpload}
        onClear={onClear}
        onRename={onRename}
        ls={ls}
        deadCount={deadCount}
        cycles={cycles}
        flowName={flowName}
      />

      <div style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
        {selected ? (
          <IntelligenceDetail
            selected={selected}
            flows={flows}
            result={activeResult}
            flowName={flowName}
            allAssets={allAssets}
            onBack={handleBack}
          />
        ) : (
          <IntelligenceOverview
            ls={ls}
            dead={dead}
            deadCount={deadCount}
            cycles={cycles}
            flows={flows}
            idx={idx}
            flowName={flowName}
            onSelectAsset={handleSelectAsset}
            query={query}
            setQuery={setQuery}
            queryNames={queryNames}
            queryResult={query.name ? activeResult : null}
          />
        )}
      </div>
    </div>
  )
}
