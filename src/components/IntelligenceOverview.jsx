import { fuzzyLookup } from '../lib/fuzzyLookup.js'
import React, { useMemo, useState } from 'react'
import { RESOURCE_KINDS } from '../lib/dependencies.js'
import { KIND_LABEL } from './Intelligence.jsx'

// Same fuzzy key lookup as IntelligenceDetail — handles .mmap extension mismatch

export default function IntelligenceOverview({
  ls, dead, deadCount, cycles, flows, idx, flowName, onSelectAsset,
  query, setQuery, queryNames, queryResult,
}) {
  const [showContent, setShowContent] = useState(true)

  // Content resolution for the dropdown query (same logic as detail view)
  const resourceContent = useMemo(() => {
    if (!query.name) return null
    const { kind, name } = query

    if (kind === 'script') {
      for (const flow of flows) {
        for (const step of Object.values(flow.steps || {})) {
          const c = step.config || {}
          if (step.kind === 'GroovyScript' && (c.scriptRef === name || c.scriptMatchName === name) && c.preview)
            return { type: 'code', lang: 'groovy', text: c.preview, from: flow.name }
        }
        const sc = flow.scriptContents || {}
        if (sc[name]) return { type: 'code', lang: 'groovy', text: sc[name], from: flow.name }
      }
      return { type: 'code', text: null }
    }
    if (kind === 'xslt') {
      for (const flow of flows) {
        for (const step of Object.values(flow.steps || {})) {
          const c = step.config || {}
          if (step.kind === 'XSLT' && c.xsltRef === name && c.xsltContent)
            return { type: 'code', lang: 'xml', text: c.xsltContent, from: flow.name }
        }
        const xc = flow.xsltContents || {}
        if (xc[name]) return { type: 'code', lang: 'xml', text: xc[name], from: flow.name }
      }
      return { type: 'code', text: null }
    }
    if (kind === 'mapping') {
      for (const flow of flows) {
        const m = fuzzyLookup(flow.mappings, name)
        if (m) return { type: 'mapping', data: m, from: flow.name }
      }
      return { type: 'mapping', data: null }
    }
    if (kind === 'valueMapping') {
      for (const flow of flows) {
        const vm = fuzzyLookup(flow.valueMappings, name)
        if (vm) return { type: 'valueMapping', data: vm, from: flow.name }
      }
      return { type: 'valueMapping', data: null }
    }
    if (['processDirect', 'certificate', 'endpoint'].includes(kind)) return { type: 'explanatory', kind }
    if (kind === 'schema') return { type: 'schema' }
    return null
  }, [query, flows])

  const explanatoryMessages = {
    processDirect: "ProcessDirect addresses don't have a body — they're routing labels that connect flows.",
    certificate: "Certificate aliases are references only — the material lives in the tenant keystore.",
    endpoint: "External endpoint addresses — the content is the adapter configuration.",
  }

  return (
    <div style={{ padding: '20px 32px 32px', maxWidth: 960 }}>
      <h2 style={{ color: 'var(--text)', fontSize: 20, marginBottom: 6 }}>Dependency Intelligence</h2>
      <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
        Static analysis across {flows.length} loaded iFlow{flows.length !== 1 ? 's' : ''}.
        Select an asset in the left panel or use the query below.
      </p>

      {/* ── Who uses / who breaks? — the dropdown query panel ── */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <h3 style={{ color: 'var(--text)', fontSize: 16, marginBottom: 14 }}>Who uses / who breaks?</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={query.kind} onChange={e => setQuery({ kind: e.target.value, name: '' })}
            style={{ padding: '9px 12px', borderRadius: 8, background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)', fontSize: 14 }}>
            {RESOURCE_KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <select value={query.name} onChange={e => {
            const name = e.target.value
            setQuery(q => ({ ...q, name }))
            if (name) onSelectAsset(query.kind, name)
          }}
            style={{ padding: '9px 12px', borderRadius: 8, background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)', minWidth: 260, fontSize: 14 }}>
            <option value="">— select a {KIND_LABEL[query.kind]} —</option>
            {queryNames.map(n => (
              <option key={n.name} value={n.name}>
                {n.name} — {n.flows.map(id => flowName(id)).join(', ')}
              </option>
            ))}
          </select>
        </div>

        {/* Query results inline */}
        {queryResult && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 8 }}>
              Directly used by <strong style={{ color: 'var(--text)' }}>{queryResult.direct.length}</strong> flow{queryResult.direct.length !== 1 ? 's' : ''}:
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {queryResult.direct.map(id => (
                <span key={id} style={{ padding: '5px 12px', borderRadius: 8, background: 'rgba(88,166,255,.10)', color: '#58a6ff', fontSize: 14 }}>{flowName(id)}</span>
              ))}
              {queryResult.direct.length === 0 && <span style={{ color: 'var(--text3)', fontSize: 14 }}>none</span>}
            </div>
            {queryResult.impact.transitive.length > 0 && (
              <>
                <div style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 8 }}>
                  Transitively impacted via ProcessDirect ({queryResult.impact.transitive.length}):
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                  {queryResult.impact.transitive.map(id => (
                    <span key={id} style={{ padding: '5px 12px', borderRadius: 8, background: 'rgba(240,136,62,.10)', color: '#f0883e', fontSize: 14 }}>{flowName(id)}</span>
                  ))}
                </div>
              </>
            )}

            {/* Content preview for the queried resource */}
            {resourceContent && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text3)' }}>
                    CONTENT — {query.name}
                    {resourceContent.from && <span style={{ fontWeight: 400, letterSpacing: 0 }}> (from {resourceContent.from})</span>}
                  </span>
                  <button onClick={() => setShowContent(s => !s)} style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                    {showContent ? 'Hide' : 'Show'}
                  </button>
                </div>
                {showContent && (
                  <>
                    {resourceContent.type === 'code' && resourceContent.text && (
                      <pre style={{
                        margin: 0, padding: '14px 16px', borderRadius: 10, border: '1px solid var(--border)',
                        background: 'var(--bg)', color: 'var(--text)', fontSize: 13, lineHeight: 1.7,
                        fontFamily: 'JetBrains Mono, ui-monospace, monospace', overflowX: 'auto',
                        maxHeight: 340, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>{resourceContent.text}</pre>
                    )}
                    {resourceContent.type === 'code' && !resourceContent.text && (
                      <div style={{ fontSize: 13, color: 'var(--text3)', fontStyle: 'italic' }}>
                        Content for this {KIND_LABEL[query.kind]} isn't included in the uploaded ZIP.
                      </div>
                    )}
                    {resourceContent.type === 'explanatory' && (
                      <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.7 }}>
                        {explanatoryMessages[resourceContent.kind]}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Shared resources ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <h3 style={{ color: 'var(--text)', fontSize: 16, marginBottom: 14 }}>
            Shared resources <span style={{ color: 'var(--text2)', fontWeight: 400, fontSize: 14 }}>(2+ flows)</span>
          </h3>
          {RESOURCE_KINDS.flatMap(k => ls.shared[k].map(s => ({ ...s, kind: k }))).slice(0, 12).map((s, i) => (
            <div key={i}
              onClick={() => onSelectAsset(s.kind, s.name)}
              style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 14, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ color: 'var(--text)' }}>
                  <span style={{ color: 'var(--text2)', fontSize: 12.5 }}>{KIND_LABEL[s.kind]}</span> {s.name}
                </span>
                <span style={{ color: '#f0883e', fontWeight: 600, flexShrink: 0 }}>{s.count} flows</span>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 3, lineHeight: 1.5 }}>
                {(s.flows || []).map(id => flowName(id)).join(' · ')}
              </div>
            </div>
          ))}
          {RESOURCE_KINDS.every(k => ls.shared[k].length === 0) && (
            <div style={{ color: 'var(--text3)', fontSize: 14 }}>No resources are shared across flows.</div>
          )}
        </div>

        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <h3 style={{ color: 'var(--text)', fontSize: 16, marginBottom: 14 }}>Risks & complexity</h3>
          {ls.brokenPD.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 14, color: 'var(--red)', marginBottom: 6 }}>Broken ProcessDirect channels:</div>
              {ls.brokenPD.slice(0, 5).map((b, i) => (
                <div key={i} style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.5 }}>
                  {b.address} <span style={{ color: 'var(--text2)' }}>— {b.issue}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 6 }}>Most complex flows:</div>
          {ls.complexity.slice(0, 5).map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}>
              <span style={{ color: 'var(--text)' }}>{c.name}</span>
              <span style={{ color: 'var(--text2)' }}>{c.steps} steps · {c.routers} routers</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Dead assets + Cycles ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <h3 style={{ color: 'var(--text)', fontSize: 16, marginBottom: 6 }}>
            Dead assets {deadCount > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}>({deadCount})</span>}
          </h3>
          <p style={{ color: 'var(--text3)', fontSize: 13.5, marginBottom: 14 }}>Bundled in a ZIP but referenced by no step.</p>
          {deadCount === 0 && <div style={{ color: '#3fb950', fontSize: 14 }}>✓ No unused assets detected.</div>}
          {[['script', dead.scripts], ['xslt', dead.xslts], ['mapping', dead.mappings], ['schema', dead.schemas || []]].map(([kind, list]) =>
            list.length > 0 && (
              <div key={kind} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}>{KIND_LABEL[kind]}s</div>
                {list.map(item => (
                  <div key={item.name}
                    onClick={() => onSelectAsset(kind, item.name)}
                    style={{ fontSize: 14, color: 'var(--text)', padding: '4px 0', cursor: 'pointer' }}>
                    <span style={{ color: 'var(--red)', marginRight: 6 }}>●</span>{item.name}
                    <span style={{ color: 'var(--text3)', fontSize: 12.5, marginLeft: 8 }}>
                      in {(item.flows || []).map(id => flowName(id)).join(', ')}
                    </span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
          <h3 style={{ color: 'var(--text)', fontSize: 16, marginBottom: 6 }}>
            Circular dependencies {cycles.length > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}>({cycles.length})</span>}
          </h3>
          <p style={{ color: 'var(--text3)', fontSize: 13.5, marginBottom: 14 }}>ProcessDirect chains that loop back on themselves.</p>
          {cycles.length === 0 && <div style={{ color: '#3fb950', fontSize: 14 }}>✓ No circular ProcessDirect chains.</div>}
          {cycles.map((cyc, i) => (
            <div key={i} style={{ fontSize: 14, color: 'var(--text)', padding: '6px 0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
              {cyc.map((id, j) => (
                <span key={j} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ padding: '3px 10px', borderRadius: 8, background: 'rgba(248,81,73,.10)', color: '#f85149' }}>{flowName(id)}</span>
                  {j < cyc.length - 1 && <span style={{ color: 'var(--text2)' }}>→</span>}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
