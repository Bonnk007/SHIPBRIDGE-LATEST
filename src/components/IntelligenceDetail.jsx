import { fuzzyLookup } from '../lib/fuzzyLookup.js'
import React, { useMemo, useState } from 'react'
import { KIND_LABEL } from './Intelligence.jsx'

// ── Fuzzy key lookup for mappings/value-mappings ─────────────────────

// ── Visual mapping diagram ───────────────────────────────────────────
// Draws source fields on the left, target fields on the right, with
// connecting lines and function labels.
// ── Mapping viewer ──────────────────────────────────────────────────
//
// Two views of the same parsed mmap, and a small router that picks one:
//
//   MappingDiagramSVG — the bezier diagram. Beautiful for small mappings
//                       (say 5–10 field pairs). Above that it becomes an
//                       unreadable smear of overlapping curves — the
//                       delaware Person mapping (30+ pairs, 7-function
//                       chains) is the failure case that motivated the
//                       row view below.
//
//   MappingRows       — a compact table row per field pair. Source name,
//                       arrow, target name, full function chain wrapping
//                       to multiple lines if it needs to. Always readable,
//                       even at 100+ pairs.
//
// The wrapper picks by size (12 pairs is the threshold — small enough that
// bezier still looks tidy, big enough that most simple mappings still get
// the pretty view) and shows a toggle so the user can override.
const DIAGRAM_THRESHOLD = 12

function MappingDiagram({ data }) {
  const [mode, setMode] = useState(null)      // null = auto, 'diagram', 'rows'

  if (!data) return <div style={{ fontSize: 13.5, color: 'var(--text3)', fontStyle: 'italic' }}>Mapping data not available in this ZIP.</div>

  const fm = data.fieldMappings || []
  if (fm.length === 0) {
    return (
      <div>
        <MappingHeader data={data} />
        <div style={{ fontSize: 13.5, color: 'var(--text3)', fontStyle: 'italic' }}>
          No field-level mappings extracted (the mapping may use a structure-level copy).
        </div>
      </div>
    )
  }

  const effectiveMode = mode || (fm.length <= DIAGRAM_THRESHOLD ? 'diagram' : 'rows')

  return (
    <div>
      <MappingHeader data={data} />
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10, flexWrap: 'wrap', gap: 8,
      }}>
        <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
          {fm.length} field pair{fm.length === 1 ? '' : 's'}
        </div>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <ViewToggle label="Diagram" active={effectiveMode === 'diagram'} onClick={() => setMode('diagram')} />
          <ViewToggle label="Rows"    active={effectiveMode === 'rows'}    onClick={() => setMode('rows')} />
        </div>
      </div>
      {effectiveMode === 'diagram'
        ? <MappingDiagramSVG data={data} />
        : <MappingRows data={data} />}
      {data.schemaRefs && data.schemaRefs.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text2)' }}>
          References schemas: {data.schemaRefs.join(', ')}
        </div>
      )}
    </div>
  )
}

// Small toggle-button pair for the mode picker. Kept inline (not a Button
// component) because it only exists in this one place.
function ViewToggle({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 12px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
      background: active ? 'var(--blue-bg)' : 'transparent',
      color: active ? 'var(--blue)' : 'var(--text2)',
      border: 'none', fontWeight: active ? 600 : 500,
    }}>{label}</button>
  )
}

// Compact header — source → target type names in small pills. The old header
// was two 46%-wide boxes that clamped to two lines; on long EDMX paths they
// still ate a lot of vertical space. This is a single row of small chips
// that ellipsise cleanly and keep the full path in the tooltip.
function MappingHeader({ data }) {
  if (!data.source && !data.target) return null
  const chip = (label, kind) => (
    <span title={label} style={{
      display: 'inline-block', maxWidth: 260, padding: '3px 9px', borderRadius: 5,
      background: kind === 'src' ? 'var(--blue-bg)' : 'var(--green-bg)',
      color:      kind === 'src' ? 'var(--blue)'    : 'var(--green)',
      border: `1px solid ${kind === 'src' ? 'var(--blue)' : 'var(--green)'}`,
      fontSize: 12, fontWeight: 600, fontFamily: 'ui-monospace, monospace',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      verticalAlign: 'middle',
    }}>{label}</span>
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
      {chip(data.source || '(source)', 'src')}
      <span style={{ color: 'var(--text3)', fontSize: 14 }}>→</span>
      {chip(data.target || '(target)', 'tgt')}
      {data.multiplicity && (
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>({data.multiplicity})</span>
      )}
    </div>
  )
}

// ── The row-based view ──────────────────────────────────────────────
//
// The important properties this view has that the bezier one doesn't:
//   - no overlaps, ever — each pair is its own row
//   - the full function chain reads left-to-right on a monospace line and
//     wraps naturally when it's too wide for the column
//   - target and source names truncate with ellipsis and reveal the full
//     path on hover; no text ever overlaps another element
//   - works at any scale, from 3 pairs to 300
//
// Trade-off: no "flow" feeling from the connecting curves. At scale, the
// curves stopped communicating anything anyway (see the delaware smear).
function MappingRows({ data }) {
  const fm = data.fieldMappings || []
  const short = (path) => {
    const parts = String(path || '').replace(/^\//, '').split('/')
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : parts.join('/')
  }
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)', overflow: 'hidden' }}>
      <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) 20px minmax(0, 1.2fr) minmax(0, 1.6fr)',
        gap: 12, padding: '10px 14px', background: 'var(--bg2)',
        borderBottom: '1px solid var(--border)', fontSize: 11.5, fontWeight: 600,
        color: 'var(--text2)', letterSpacing: '.04em',
      }}>
        <div>SOURCE</div>
        <div></div>
        <div>TARGET</div>
        <div>FUNCTIONS</div>
      </div>
      {fm.map((m, i) => (
        <div key={i} style={{
          display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) 20px minmax(0, 1.2fr) minmax(0, 1.6fr)',
          gap: 12, padding: '8px 14px', alignItems: 'center',
          borderBottom: i < fm.length - 1 ? '1px solid var(--border)' : 'none',
          fontSize: 12.5, fontFamily: 'ui-monospace, monospace',
        }}>
          {/* Source — one or many. Multiple sources stack vertically. */}
          <div style={{ minWidth: 0 }}>
            {m.sources.length === 0 && <span style={{ color: 'var(--text3)' }}>—</span>}
            {m.sources.map((s, si) => (
              <div key={si} title={s} style={{
                color: 'var(--blue)', whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
                marginTop: si === 0 ? 0 : 2,
              }}>{short(s)}</div>
            ))}
          </div>
          <div style={{ color: 'var(--text3)', textAlign: 'center' }}>→</div>
          <div title={m.target} style={{
            color: 'var(--green)', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
          }}>{short(m.target)}</div>
          {/* Function chain — full real names from the mmap, wraps if wide. */}
          <div style={{ minWidth: 0 }}>
            {(!m.functions || m.functions.length === 0)
              ? <span style={{ color: 'var(--text3)', fontSize: 11.5 }}>—</span>
              : (
                <div style={{
                  color: 'var(--blue)', fontSize: 11.5, lineHeight: 1.5,
                  wordBreak: 'break-word', whiteSpace: 'normal',
                }}>
                  {m.functions.map((f, fi) => (
                    <span key={fi}>
                      {fi > 0 && <span style={{ color: 'var(--text3)', margin: '0 4px' }}>→</span>}
                      <span title={f.name}>{f.name}</span>
                    </span>
                  ))}
                </div>
              )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── The bezier view (existing SVG diagram) ──────────────────────────
//
// Unchanged from v48.20 apart from being lifted into its own function so
// the router above can pick it. Still the best view for small mappings.
function MappingDiagramSVG({ data }) {
  const fm = data.fieldMappings || []

  const srcPaths = []
  const srcSet = new Set()
  const tgtPaths = []
  const tgtSet = new Set()
  for (const m of fm) {
    for (const s of m.sources) {
      if (!srcSet.has(s)) { srcSet.add(s); srcPaths.push(s) }
    }
    if (!tgtSet.has(m.target)) { tgtSet.add(m.target); tgtPaths.push(m.target) }
  }

  const shortName = (path) => {
    const parts = path.replace(/^\//, '').split('/')
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : parts.join('/')
  }

  const targetLabels = fm
    .filter(m => m.functions && m.functions.length > 0)
    .map(m => m.functions.map(f => f.name).join(' → '))
  const maxLabelChars = targetLabels.reduce((n, s) => Math.max(n, s.length), 0)
  const PILL_W = maxLabelChars > 0 ? Math.min(260, Math.max(72, maxLabelChars * 6.4 + 20)) : 0
  const PILL_GAP = PILL_W > 0 ? 10 : 0

  const ROW_H = 36
  const PAD_TOP = 60
  const leftH = srcPaths.length * ROW_H + PAD_TOP
  const rightH = tgtPaths.length * ROW_H + PAD_TOP
  const svgH = Math.max(leftH, rightH, 140) + 20

  const LEFT_X = 20
  const LEFT_W = 240
  const RIGHT_X = 480
  const RIGHT_W = 240
  const SVG_W = RIGHT_X + RIGHT_W + PILL_GAP + PILL_W + 20

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)', padding: '4px 0' }}>
      <svg width={SVG_W} height={svgH} style={{ display: 'block' }}>
        <text x={LEFT_X + 10} y={28} fill="var(--text2)" fontSize="12" fontWeight="600" fontFamily="inherit">
          SOURCE FIELDS ({srcPaths.length})
        </text>
        <text x={RIGHT_X + 10} y={28} fill="var(--text2)" fontSize="12" fontWeight="600" fontFamily="inherit">
          TARGET FIELDS ({tgtPaths.length})
        </text>
        {PILL_W > 0 && (
          <text x={RIGHT_X + RIGHT_W + PILL_GAP + PILL_W / 2} y={28}
            fill="var(--text2)" fontSize="12" fontWeight="600" fontFamily="inherit" textAnchor="middle">
            FUNCTIONS
          </text>
        )}

        {srcPaths.map((s, i) => {
          const y = PAD_TOP + i * ROW_H
          return (
            <g key={'s' + i}>
              <rect x={LEFT_X} y={y} width={LEFT_W} height={ROW_H - 4} rx="6"
                fill="var(--blue-bg)" stroke="var(--blue)" strokeWidth="1" />
              <text x={LEFT_X + 12} y={y + (ROW_H - 4) / 2 + 1}
                fill="var(--blue)" fontSize="12" fontFamily="ui-monospace, monospace" dominantBaseline="central">
                <title>{s}</title>{shortName(s)}
              </text>
            </g>
          )
        })}

        {tgtPaths.map((t, i) => {
          const y = PAD_TOP + i * ROW_H
          return (
            <g key={'t' + i}>
              <rect x={RIGHT_X} y={y} width={RIGHT_W} height={ROW_H - 4} rx="6"
                fill="var(--green-bg)" stroke="var(--green)" strokeWidth="1" />
              <text x={RIGHT_X + 12} y={y + (ROW_H - 4) / 2 + 1}
                fill="var(--green)" fontSize="12" fontFamily="ui-monospace, monospace" dominantBaseline="central">
                <title>{t}</title>{shortName(t)}
              </text>
            </g>
          )
        })}

        {fm.map((m, mi) => {
          const tgtIdx = tgtPaths.indexOf(m.target)
          if (tgtIdx < 0) return null
          const tgtY = PAD_TOP + tgtIdx * ROW_H + (ROW_H - 4) / 2
          return m.sources.map((s, si) => {
            const srcIdx = srcPaths.indexOf(s)
            if (srcIdx < 0) return null
            const srcY = PAD_TOP + srcIdx * ROW_H + (ROW_H - 4) / 2
            const x1 = LEFT_X + LEFT_W
            const x2 = RIGHT_X
            const midX = (x1 + x2) / 2
            const hasFn = m.functions.length > 0
            return (
              <path key={`c${mi}-${si}`}
                d={`M${x1} ${srcY} C${midX} ${srcY}, ${midX} ${tgtY}, ${x2} ${tgtY}`}
                fill="none" stroke={hasFn ? 'var(--blue)' : 'var(--text3)'}
                strokeWidth={hasFn ? 1.5 : 1} strokeOpacity={hasFn ? 0.55 : 0.3}
              />
            )
          })
        })}

        {PILL_W > 0 && fm.map((m, mi) => {
          if (!m.functions || m.functions.length === 0) return null
          const tgtIdx = tgtPaths.indexOf(m.target)
          if (tgtIdx < 0) return null
          const y = PAD_TOP + tgtIdx * ROW_H
          const label = m.functions.map(f => f.name).join(' → ')
          const pillX = RIGHT_X + RIGHT_W + PILL_GAP
          return (
            <g key={`fn${mi}`}>
              <rect x={pillX} y={y + 3} width={PILL_W} height={ROW_H - 10} rx={(ROW_H - 10) / 2}
                fill="var(--blue-bg)" stroke="var(--blue)" strokeWidth="1" />
              <text x={pillX + PILL_W / 2} y={y + (ROW_H - 4) / 2 + 1}
                fill="var(--blue)" fontSize="10.5" fontFamily="ui-monospace, monospace"
                textAnchor="middle" dominantBaseline="central">
                <title>{label}</title>{label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}


// ── Value mapping ────────────────────────────────────────────────────

function ValueMappingContent({ data }) {
  if (!data) return <div style={{ fontSize: 13.5, color: 'var(--text3)', fontStyle: 'italic' }}>Value mapping data not available in this ZIP.</div>
  const { agencies = [], entries = [] } = data
  return (
    <div>
      {agencies.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          {agencies.map((ag, i) => (
            <div key={i} style={{ fontSize: 14, color: 'var(--text)', marginBottom: 6 }}>
              <span style={{ color: 'var(--text2)', fontSize: 13 }}>{ag.sourceAgency || 'Source'}</span>
              <span style={{ fontWeight: 600 }}> {ag.sourceScheme || '?'}</span>
              <span style={{ margin: '0 10px', color: 'var(--text3)' }}>→</span>
              <span style={{ color: 'var(--text2)', fontSize: 13 }}>{ag.targetAgency || 'Target'}</span>
              <span style={{ fontWeight: 600 }}> {ag.targetScheme || '?'}</span>
            </div>
          ))}
        </div>
      )}
      {entries.length > 0 ? (
        <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)' }}>
                <th style={{ padding: '10px 14px', textAlign: 'left', color: 'var(--text2)', fontWeight: 600, fontSize: 12.5, borderBottom: '1px solid var(--border)' }}>Source value</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', color: 'var(--text2)', fontWeight: 600, fontSize: 12.5, borderBottom: '1px solid var(--border)' }}>Target value</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, 25).map((e, i) => (
                <tr key={i} style={{ borderBottom: i < entries.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <td style={{ padding: '7px 14px', color: 'var(--text)', fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>{e.sourceValue ?? e.source ?? '—'}</td>
                  <td style={{ padding: '7px 14px', color: 'var(--text)', fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }}>{e.targetValue ?? e.target ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length > 25 && (
            <div style={{ padding: '8px 14px', fontSize: 13, color: 'var(--text3)', borderTop: '1px solid var(--border)', background: 'var(--bg2)' }}>
              …and {entries.length - 25} more entries
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 13.5, color: 'var(--text3)', fontStyle: 'italic' }}>No value mapping entries extracted.</div>
      )}
    </div>
  )
}

// ── Schema content ───────────────────────────────────────────────────

function SchemaContent({ name, flows }) {
  const referencedBy = useMemo(() => {
    const refs = []
    for (const flow of flows) {
      for (const [mapName, r] of Object.entries(flow.mappingSchemaRefs || {})) {
        if ((r || []).includes(name)) refs.push({ kind: 'mapping', name: mapName, flow: flow.name })
      }
      for (const step of Object.values(flow.steps || {})) {
        const rp = step.config?.rawProps || {}
        const schemaRefs = [rp.edmxFilePath, rp.xsdName, rp.xsdPath, rp.wsdlName, rp.wsdlPath, rp.schemaFilePath, rp.schemaPath]
        for (const ref of schemaRefs) {
          if (!ref) continue
          const base = ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref
          if (base === name) refs.push({ kind: 'adapter', name: step.name || step.id, flow: flow.name })
        }
      }
    }
    return refs
  }, [name, flows])

  return (
    <div>
      {referencedBy.length > 0 ? (
        <div>
          <div style={{ fontSize: 13.5, color: 'var(--text2)', marginBottom: 8 }}>Referenced by:</div>
          {referencedBy.map((ref, i) => (
            <div key={i} style={{ padding: '5px 0', fontSize: 14, color: 'var(--text)' }}>
              <span style={{ color: 'var(--text2)', fontSize: 13 }}>{ref.kind === 'mapping' ? 'Mapping' : 'Adapter'}</span>{' '}
              {ref.name}
              <span style={{ color: 'var(--text3)', fontSize: 13, marginLeft: 8 }}>in {ref.flow}</span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 13.5, color: 'var(--text3)', fontStyle: 'italic' }}>No direct references found from mappings or adapters.</div>
      )}
      <div style={{
        marginTop: 12, padding: '12px 14px', borderRadius: 10, background: 'var(--bg2)',
        border: '1px solid var(--border)', fontSize: 13.5, color: 'var(--text2)', lineHeight: 1.7,
      }}>
        Schema content (XSD/EDMX/WSDL source) is available in the ZIP but not extracted for display yet.
      </div>
    </div>
  )
}

// ── Main detail component ────────────────────────────────────────────

// Named re-export so tests can exercise the mapping viewer's mode-picking
// logic in isolation. Not used by the app itself.
export { MappingDiagram as MappingViewerForTest }

export default function IntelligenceDetail({ selected, flows, result, flowName, allAssets, onBack }) {
  const [showContent, setShowContent] = useState(true)

  const resourceContent = useMemo(() => {
    if (!selected) return null
    const { kind, name } = selected

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
    // Mappings — fuzzy key lookup to handle .mmap extension mismatch
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
    if (kind === 'schema') return { type: 'schema' }
    if (['processDirect', 'certificate', 'endpoint'].includes(kind)) return { type: 'explanatory', kind }
    return null
  }, [selected, flows])

  const asset = allAssets.find(a => a.kind === selected.kind && a.name === selected.name)

  const explanatoryMessages = {
    processDirect: "ProcessDirect addresses don't have a body — they're routing labels that connect flows. See who uses this address in the impact section below.",
    certificate: "Certificate aliases are references only. The actual key material lives in the tenant keystore on the CPI runtime.",
    endpoint: "External endpoint addresses represent the adapter configuration — the content is the connection parameters shown in the flow diagram.",
  }

  return (
    <div style={{ padding: '20px 32px 32px', maxWidth: 960 }}>
      {/* ── Back button ── */}
      <button onClick={onBack}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '6px 14px', borderRadius: 8, fontSize: 13.5,
          border: '1px solid var(--border)', color: 'var(--text2)',
          background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
          marginBottom: 20,
        }}>
        ← Back to overview
      </button>

      {/* ── Header ── */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 12.5, padding: '3px 10px', borderRadius: 6, fontWeight: 600,
            background: 'rgba(88,166,255,.10)', color: '#58a6ff',
          }}>
            {KIND_LABEL[selected.kind]}
          </span>
          {asset?.isShared && (
            <span style={{ fontSize: 12.5, padding: '3px 10px', borderRadius: 6, background: 'rgba(240,136,62,.10)', color: '#f0883e' }}>
              shared · {asset.flowIds.length} flows
            </span>
          )}
          {asset?.isDead && (
            <span style={{ fontSize: 12.5, padding: '3px 10px', borderRadius: 6, background: 'rgba(248,81,73,.10)', color: '#f85149' }}>
              dead — unreferenced by any step
            </span>
          )}
        </div>
        <h2 style={{ color: 'var(--text)', fontSize: 22, margin: 0, wordBreak: 'break-word', lineHeight: 1.3 }}>
          {selected.name}
        </h2>
        {asset && (
          <div style={{ fontSize: 14, color: 'var(--text2)', marginTop: 6 }}>
            Owned by: {asset.flowIds.map(id => flowName(id)).join(', ')}
          </div>
        )}
      </div>

      {/* ── Content viewer ── */}
      {resourceContent && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text3)' }}>
              CONTENT
              {resourceContent.from && <span style={{ fontWeight: 400, letterSpacing: 0, marginLeft: 8 }}>from {resourceContent.from}</span>}
            </span>
            {(resourceContent.type === 'code' || resourceContent.type === 'mapping' || resourceContent.type === 'valueMapping') && (
              <button onClick={() => setShowContent(s => !s)} style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                {showContent ? 'Hide' : 'Show'}
              </button>
            )}
          </div>

          {showContent && (
            <>
              {resourceContent.type === 'code' && (
                resourceContent.text ? (
                  <pre style={{
                    margin: 0, padding: '16px 18px', borderRadius: 10, border: '1px solid var(--border)',
                    background: 'var(--bg)', color: 'var(--text)', fontSize: 13, lineHeight: 1.7,
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace', overflowX: 'auto',
                    maxHeight: 400, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>{resourceContent.text}</pre>
                ) : (
                  <div style={{ fontSize: 13.5, color: 'var(--text3)', fontStyle: 'italic' }}>
                    Content for this {KIND_LABEL[selected.kind]} isn't included in the uploaded ZIP (only the reference).
                  </div>
                )
              )}

              {resourceContent.type === 'mapping' && <MappingDiagram data={resourceContent.data} />}
              {resourceContent.type === 'valueMapping' && <ValueMappingContent data={resourceContent.data} />}
              {resourceContent.type === 'schema' && <SchemaContent name={selected.name} flows={flows} />}

              {resourceContent.type === 'explanatory' && (
                <div style={{
                  padding: '14px 16px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--border)',
                  fontSize: 14, color: 'var(--text2)', lineHeight: 1.7,
                }}>
                  {explanatoryMessages[resourceContent.kind]}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Impact section ── */}
      {result && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text3)', marginBottom: 10 }}>
            DIRECTLY USED BY
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            {result.direct.map(id => (
              <span key={id} style={{ padding: '5px 12px', borderRadius: 8, background: 'rgba(88,166,255,.10)', color: '#58a6ff', fontSize: 14 }}>
                {flowName(id)}
              </span>
            ))}
            {result.direct.length === 0 && <span style={{ color: 'var(--text3)', fontSize: 14 }}>none</span>}
          </div>

          {result.impact.transitive.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text3)', marginBottom: 10 }}>
                TRANSITIVELY IMPACTED VIA PROCESSDIRECT
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
                {result.impact.transitive.map(id => (
                  <span key={id} style={{ padding: '5px 12px', borderRadius: 8, background: 'rgba(240,136,62,.10)', color: '#f0883e', fontSize: 14 }}>
                    {flowName(id)}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Status summary ── */}
      {asset && (asset.isShared || asset.isDead) && (
        <div style={{
          padding: '16px 18px', borderRadius: 12, background: 'var(--bg2)',
          border: '1px solid var(--border)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.06em', color: 'var(--text3)', marginBottom: 10 }}>
            STATUS
          </div>
          {asset.isShared && (
            <div style={{ fontSize: 14, color: '#f0883e', marginBottom: 6, lineHeight: 1.6 }}>
              ⚠ Shared — changing this {KIND_LABEL[selected.kind].toLowerCase()} affects {asset.flowIds.length} flows.
              Coordinate changes across: {asset.flowIds.map(id => flowName(id)).join(', ')}.
            </div>
          )}
          {asset.isDead && (
            <div style={{ fontSize: 14, color: '#f85149', lineHeight: 1.6 }}>
              ● Dead — bundled in the ZIP but not referenced by any step.
              Safe to remove from {asset.flowIds.map(id => flowName(id)).join(', ')}.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
