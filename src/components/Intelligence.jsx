import { useState, useMemo } from 'react'
import { buildIndex, usedBy, impactOf, landscape, deadAssets, circularDependencies, RESOURCE_KINDS } from '../lib/dependencies.js'

const KIND_LABEL = {
  script: 'Groovy Script', xslt: 'XSLT', mapping: 'Message Mapping',
  processDirect: 'ProcessDirect', valueMapping: 'Value Mapping',
  certificate: 'Certificate', endpoint: 'Endpoint',
}

function Stat({ label, value }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 13.5, color: 'var(--text2)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

export default function Intelligence({ registry, onUpload }) {
  const flows = useMemo(() => [...(registry?.values() || [])], [registry])
  const idx = useMemo(() => buildIndex(flows), [flows])
  const ls  = useMemo(() => landscape(idx), [idx])
  const dead = useMemo(() => deadAssets(idx), [idx])
  const cycles = useMemo(() => circularDependencies(idx), [idx])
  const deadCount = dead.scripts.length + dead.xslts.length + dead.mappings.length

  const [query, setQuery] = useState({ kind: 'script', name: '' })

  // All resource names of the selected kind, for the dropdown
  const names = useMemo(() => {
    const m = idx.index.get(query.kind)
    return m ? [...m.keys()].sort() : []
  }, [idx, query.kind])

  const result = useMemo(() => {
    if (!query.name) return null
    return { direct: usedBy(idx, query.kind, query.name), impact: impactOf(idx, query.kind, query.name) }
  }, [idx, query])

  // Pull the actual content of the selected resource from the parsed steps
  const resourceContent = useMemo(() => {
    if (!query.name) return null
    for (const flow of flows) {
      for (const step of Object.values(flow.steps || {})) {
        const c = step.config || {}
        if (query.kind === 'script' && step.kind === 'GroovyScript' &&
            (c.scriptRef === query.name || c.scriptMatchName === query.name) && c.preview)
          return { lang: 'groovy', text: c.preview, from: flow.name }
        if (query.kind === 'xslt' && step.kind === 'XSLT' &&
            c.xsltRef === query.name && c.xsltContent)
          return { lang: 'xml', text: c.xsltContent, from: flow.name }
      }
    }
    if (query.kind === 'script' || query.kind === 'xslt')
      return { lang: null, text: null, from: null }   // known kind, content missing
    return null                                        // kinds with no content (PD, endpoints…)
  }, [flows, query])
  const [showContent, setShowContent] = useState(true)

  const flowName = (id) => registry.get(id)?.name || id

  if (flows.length === 0) {
    return (
      <div style={{ flex: 1, maxWidth: 900, margin: '40px auto', textAlign: 'center', color: 'var(--text2)' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🧠</div>
        <h2 style={{ color: 'var(--text)' }}>Dependency Intelligence</h2>
        <p style={{ lineHeight: 1.7 }}>
          Upload two or more iFlow ZIPs to map ProcessDirect dependencies, run impact analysis,
          and spot dead scripts and mappings across the whole landscape.
        </p>
        {onUpload && (
          <label className="btn btn-primary" style={{ cursor: 'pointer', display: 'inline-block', marginTop: 14 }}>
            Upload iFlow ZIPs
            <input type="file" accept=".zip" multiple hidden
              onChange={e => { onUpload(e.target.files); e.target.value = '' }} />
          </label>
        )}
        <p style={{ fontSize: 13.5, color: 'var(--text3)', marginTop: 14 }}>
          Analysis is strongest with several flows loaded — a single iFlow has nothing to be
          compared against.
        </p>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, maxWidth: 1200, margin: '0 auto', width: '100%', padding: '20px 24px' }}>
      <h2 style={{ color: 'var(--text)', marginBottom: 4 }}>Dependency Intelligence</h2>
      <p style={{ color: 'var(--text2)', fontSize: 14, marginBottom: 20 }}>
        Static analysis across {flows.length} loaded iFlow{flows.length !== 1 ? 's' : ''}. No runtime — this reads parsed structure only.
      </p>

      {/* Landscape totals */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 24 }}>
        <Stat label="iFlows" value={ls.totals.flows} />
        <Stat label="Scripts" value={ls.totals.scripts} />
        <Stat label="XSLTs" value={ls.totals.xslts} />
        <Stat label="Mappings" value={ls.totals.mappings} />
        <Stat label="ProcessDirect" value={ls.totals.processDirects} />
        <Stat label="Dead assets" value={deadCount} />
        <Stat label="Circular deps" value={cycles.length} />
      </div>

      {/* Impact query */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginBottom: 24 }}>
        <h3 style={{ color: 'var(--text)', fontSize: 15, marginBottom: 12 }}>Who uses / who breaks?</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={query.kind} onChange={e => setQuery({ kind: e.target.value, name: '' })}
            style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)' }}>
            {RESOURCE_KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <select value={query.name} onChange={e => setQuery(q => ({ ...q, name: e.target.value }))}
            style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--bg3)', color: 'var(--text)', border: '1px solid var(--border)', minWidth: 240 }}>
            <option value="">— select a {KIND_LABEL[query.kind]} —</option>
            {names.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        {result && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 6 }}>
              Directly used by <strong style={{ color: 'var(--text)' }}>{result.direct.length}</strong> flow{result.direct.length !== 1 ? 's' : ''}:
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {result.direct.map(id => (
                <span key={id} style={{ padding: '4px 10px', borderRadius: 6, background: 'rgba(88,166,255,.12)', color: '#58a6ff', fontSize: 14 }}>{flowName(id)}</span>
              ))}
              {result.direct.length === 0 && <span style={{ color: 'var(--text2)', fontSize: 14 }}>none</span>}
            </div>
            {result.impact.transitive.length > 0 && (
              <>
                <div style={{ fontSize: 14, color: 'var(--text2)', marginBottom: 6 }}>
                  Transitively impacted via ProcessDirect ({result.impact.transitive.length}):
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {result.impact.transitive.map(id => (
                    <span key={id} style={{ padding: '4px 10px', borderRadius: 6, background: 'rgba(240,136,62,.12)', color: '#f0883e', fontSize: 14 }}>{flowName(id)}</span>
                  ))}
                </div>
              </>
            )}

            {resourceContent && (
              <div style={{ marginTop:16 }}>
                {resourceContent.text ? (
                  <>
                    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
                      <span style={{ fontSize:11, fontWeight:700, letterSpacing:'.06em', color:'var(--text3)' }}>
                        CONTENT — {query.name} <span style={{ fontWeight:400, letterSpacing:0 }}>(from {resourceContent.from})</span>
                      </span>
                      <button onClick={()=>setShowContent(s=>!s)} style={{ background:'none', border:'none', color:'var(--blue)', cursor:'pointer', fontSize:12, fontFamily:'inherit' }}>
                        {showContent ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {showContent && (
                      <pre style={{
                        margin:0, padding:'14px 16px', borderRadius:8, border:'1px solid var(--border)',
                        background:'var(--bg)', color:'var(--text)', fontSize:12.5, lineHeight:1.6,
                        fontFamily:'JetBrains Mono, monospace', overflowX:'auto', maxHeight:340, overflowY:'auto',
                        whiteSpace:'pre-wrap', wordBreak:'break-word',
                      }}>{resourceContent.text}</pre>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize:12, color:'var(--text3)', fontStyle:'italic' }}>
                    Content for this {KIND_LABEL[query.kind]} isn't included in the uploaded ZIP (only the reference).
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Shared resources (highest change risk) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
          <h3 style={{ color: 'var(--text)', fontSize: 15, marginBottom: 12 }}>Shared resources <span style={{ color: 'var(--text2)', fontWeight: 400, fontSize: 13.5 }}>(used by 2+ flows)</span></h3>
          {RESOURCE_KINDS.flatMap(k => ls.shared[k].map(s => ({ ...s, kind: k }))).slice(0, 12).map((s, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 14 }}>
              <span style={{ color: 'var(--text)' }}><span style={{ color: 'var(--text2)', fontSize: 12.5 }}>{KIND_LABEL[s.kind]}</span> {s.name}</span>
              <span style={{ color: '#f0883e', fontWeight: 600 }}>{s.count} flows</span>
            </div>
          ))}
          {RESOURCE_KINDS.every(k => ls.shared[k].length === 0) && <div style={{ color: 'var(--text2)', fontSize: 14 }}>No resources are shared across flows.</div>}
        </div>

        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
          <h3 style={{ color: 'var(--text)', fontSize: 15, marginBottom: 12 }}>Risks & complexity</h3>
          {ls.brokenPD.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13.5, color: 'var(--red)', marginBottom: 4 }}>Broken ProcessDirect channels:</div>
              {ls.brokenPD.slice(0, 5).map((b, i) => (
                <div key={i} style={{ fontSize: 14, color: 'var(--text)' }}>{b.address} <span style={{ color: 'var(--text2)' }}>— {b.issue}</span></div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 13.5, color: 'var(--text2)', marginBottom: 4 }}>Most complex flows:</div>
          {ls.complexity.slice(0, 5).map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '3px 0' }}>
              <span style={{ color: 'var(--text)' }}>{c.name}</span>
              <span style={{ color: 'var(--text2)' }}>{c.steps} steps · {c.routers} routers</span>
            </div>
          ))}
        </div>
      </div>

      {/* Dead assets + circular dependencies */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
          <h3 style={{ color: 'var(--text)', fontSize: 15, marginBottom: 4 }}>
            Dead assets {deadCount > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}>({deadCount})</span>}
          </h3>
          <p style={{ color: 'var(--text2)', fontSize: 13.5, marginBottom: 12 }}>Bundled in a ZIP but referenced by no step.</p>
          {deadCount === 0 && <div style={{ color: '#3fb950', fontSize: 14 }}>✓ No unused assets detected.</div>}
          {[['script', dead.scripts], ['xslt', dead.xslts], ['mapping', dead.mappings]].map(([kind, list]) =>
            list.length > 0 && (
              <div key={kind} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12.5, color: 'var(--text2)', marginBottom: 4 }}>{KIND_LABEL[kind]}s</div>
                {list.map(name => (
                  <div key={name} style={{ fontSize: 14, color: 'var(--text)', padding: '3px 0' }}>
                    <span style={{ color: 'var(--red)', marginRight: 6 }}>●</span>{name}
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
          <h3 style={{ color: 'var(--text)', fontSize: 15, marginBottom: 4 }}>
            Circular dependencies {cycles.length > 0 && <span style={{ color: 'var(--red)', fontWeight: 600 }}>({cycles.length})</span>}
          </h3>
          <p style={{ color: 'var(--text2)', fontSize: 13.5, marginBottom: 12 }}>ProcessDirect chains that loop back on themselves.</p>
          {cycles.length === 0 && <div style={{ color: '#3fb950', fontSize: 14 }}>✓ No circular ProcessDirect chains.</div>}
          {cycles.map((cyc, i) => (
            <div key={i} style={{ fontSize: 14, color: 'var(--text)', padding: '6px 0', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
              {cyc.map((id, j) => (
                <span key={j} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ padding: '2px 8px', borderRadius: 6, background: 'rgba(248,81,73,.12)', color: '#f85149' }}>{flowName(id)}</span>
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
