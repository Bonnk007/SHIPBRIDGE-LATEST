import React, { useState } from 'react'

const KIND_ABBR = {
  script: 'GS', xslt: 'XS', mapping: 'MM', valueMapping: 'VM',
  certificate: 'CR', processDirect: 'PD', endpoint: 'EP', schema: 'SC',
}

function RenamableFlow({ flow, onRename }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(flow.name)
  React.useEffect(() => { setDraft(flow.name) }, [flow.name])

  function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== flow.name) onRename(flow.id, next)
    else setDraft(flow.name)
  }

  return editing ? (
    <input value={draft} autoFocus
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(flow.name); setEditing(false) } }}
      style={{
        fontSize: 13, fontWeight: 600, color: 'var(--text)',
        background: 'transparent', border: 'none', outline: 'none',
        padding: 0, width: '100%', fontFamily: 'inherit',
      }} />
  ) : (
    <div onDoubleClick={() => onRename && setEditing(true)} title="Double-click to rename"
      style={{ fontSize: 13, fontWeight: 600, color: 'inherit', cursor: onRename ? 'text' : 'default', lineHeight: 1.4 }}>
      {flow.name}
    </div>
  )
}

export default function IntelligenceLeft({
  flows, flowFilter, onSetFlowFilter, filteredAssets, selected,
  onSelectAsset, onUpload, onClear, onRename, ls, deadCount, cycles, flowName,
}) {
  const [search, setSearch] = useState('')

  const displayAssets = search.trim()
    ? filteredAssets.filter(a => a.name.toLowerCase().includes(search.toLowerCase()))
    : filteredAssets

  return (
    <div style={{
      width: 310, minWidth: 310, borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', background: 'var(--bg2)',
      overflow: 'hidden',
    }}>
      {/* ── Landscape strip — all 7 stats ── */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, marginBottom: 8, letterSpacing: '.04em' }}>
          LANDSCAPE
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 6 }}>
          {[
            { label: 'iFlows', value: ls.totals.flows },
            { label: 'Scripts', value: ls.totals.scripts },
            { label: 'XSLTs', value: ls.totals.xslts },
            { label: 'Mappings', value: ls.totals.mappings },
          ].map(s => (
            <div key={s.label} style={{
              textAlign: 'center', padding: '6px 4px', borderRadius: 8,
              background: 'var(--bg)', border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>{s.value}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text2)', marginTop: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
          {[
            { label: 'PD', value: ls.totals.processDirects, color: 'var(--text)' },
            { label: 'Dead', value: deadCount, color: deadCount > 0 ? 'var(--red)' : 'var(--text)' },
            { label: 'Cycles', value: cycles.length, color: cycles.length > 0 ? 'var(--red)' : 'var(--text)' },
          ].map(s => (
            <div key={s.label} style={{
              textAlign: 'center', padding: '6px 4px', borderRadius: 8,
              background: 'var(--bg)', border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text2)', marginTop: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Loaded flows ── */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text2)', fontWeight: 600, letterSpacing: '.04em' }}>
            FLOWS ({flows.length})
          </span>
          <div style={{ display: 'flex', gap: 5 }}>
            {onUpload && (
              <label style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                padding: '3px 10px', borderRadius: 6, fontSize: 12,
                border: '1px solid var(--blue)', color: 'var(--blue)',
                background: 'transparent', cursor: 'pointer', fontWeight: 500,
              }}>
                + Add
                <input type="file" accept=".zip" multiple hidden
                  onChange={e => { onUpload(e.target.files); e.target.value = '' }} />
              </label>
            )}
            {onClear && (
              <button onClick={() => { if (confirm(`Clear all ${flows.length} loaded flows?`)) onClear() }}
                style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '3px 10px', borderRadius: 6, fontSize: 12,
                  border: '1px solid var(--border)', color: 'var(--text3)',
                  background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
                }}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div
          onClick={() => onSetFlowFilter(null)}
          style={{
            padding: '6px 12px', borderRadius: 8, cursor: 'pointer', marginBottom: 4,
            background: flowFilter === null ? 'rgba(88,166,255,.10)' : 'transparent',
            color: flowFilter === null ? '#58a6ff' : 'var(--text2)',
            fontSize: 13, fontWeight: flowFilter === null ? 600 : 400,
          }}
        >
          All flows
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 200, overflowY: 'auto' }}>
          {flows.map(f => (
            <div key={f.id}
              onClick={() => onSetFlowFilter(flowFilter === f.id ? null : f.id)}
              style={{
                padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
                background: flowFilter === f.id ? 'rgba(88,166,255,.10)' : 'transparent',
                border: flowFilter === f.id ? '1px solid rgba(88,166,255,.20)' : '1px solid transparent',
              }}
            >
              <RenamableFlow flow={f} onRename={onRename} />
              {(f.zipName || f.packageName) && (
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
                  {f.packageName ? `${f.packageName} · ` : ''}{f.zipName}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Asset browser ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '12px 16px 8px' }}>
          <input
            type="text" placeholder="Search assets…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', padding: '7px 12px', fontSize: 13, borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--bg)',
              color: 'var(--text)', fontFamily: 'inherit', boxSizing: 'border-box',
              outline: 'none',
            }}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 6 }}>
            {displayAssets.length} asset{displayAssets.length !== 1 ? 's' : ''}
            {flowFilter && <span> in {flowName(flowFilter)}</span>}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
          {displayAssets.map(a => {
            const isSelected = selected?.kind === a.kind && selected?.name === a.name
            return (
              <div key={a.kind + '::' + a.name}
                onClick={() => onSelectAsset(a.kind, a.name)}
                style={{
                  padding: '7px 12px', borderRadius: 8, cursor: 'pointer', marginBottom: 3,
                  display: 'flex', alignItems: 'center', gap: 10,
                  background: isSelected ? 'rgba(88,166,255,.10)' : 'transparent',
                  border: isSelected ? '1px solid rgba(88,166,255,.20)' : '1px solid transparent',
                }}
              >
                <span style={{
                  fontSize: 10.5, padding: '2px 6px', borderRadius: 5, fontWeight: 600,
                  fontFamily: 'ui-monospace, monospace', flexShrink: 0,
                  background: 'var(--bg)', color: isSelected ? '#58a6ff' : 'var(--text3)',
                  border: '1px solid var(--border)',
                }}>
                  {KIND_ABBR[a.kind] || a.kind.slice(0, 2).toUpperCase()}
                </span>
                <span style={{
                  fontSize: 13, color: isSelected ? '#58a6ff' : 'var(--text)',
                  fontWeight: isSelected ? 600 : 400,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  lineHeight: 1.4,
                }}>
                  {a.name}
                </span>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {a.isShared && (
                    <span style={{
                      fontSize: 10.5, padding: '2px 6px', borderRadius: 5,
                      background: 'rgba(240,136,62,.10)', color: '#f0883e',
                    }}>shared</span>
                  )}
                  {a.isDead && (
                    <span style={{
                      fontSize: 10.5, padding: '2px 6px', borderRadius: 5,
                      background: 'rgba(248,81,73,.10)', color: '#f85149',
                    }}>dead</span>
                  )}
                </span>
              </div>
            )
          })}
          {displayAssets.length === 0 && (
            <div style={{ fontSize: 13.5, color: 'var(--text3)', textAlign: 'center', marginTop: 24 }}>
              {search ? 'No assets match your search.' : 'No assets in this view.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
