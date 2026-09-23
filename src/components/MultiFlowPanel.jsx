// Multi-flow specification builder.
//
// Structure follows how the work actually goes: choose which iFlows the
// document covers, then work through them one at a time.
//
//   1. ATTACH   — pick flows from everything uploaded. ShipBridge can also
//                 follow the ProcessDirect chain from the first flow and add
//                 what it reaches, and warns when a flow the chain depends on
//                 is missing entirely.
//   2. DETAIL   — a dropdown selects which flow you're editing; the panel
//                 below is that flow's fields, steps and screenshots.
//   3. OUTPUT   — one combined document, or one per flow plus an overview.
//
// Two things exist because of real friction:
//   • Custom names. Uploaded iFlows frequently share a name (every project has
//     a "MailAlert"), and a document with two identical headings is unusable.
//     The display name is the author's to set, and it drives both the section
//     heading and the filename.
//   • Per-flow context + drafting. Typing connectivity, formats, steps and
//     exception handling seven times is most of the work in a seven-flow
//     document, and the parsed iFlow already answers most of it.

import { useState, useMemo, useRef } from 'react'
import { resolveFlowSet, validateFlowSet, describeEntry } from '../lib/flowSet.js'
import { downscaleImage, newImageId } from '../lib/imageUtils.js'

const PER_FLOW_FIELDS = [
  { key: 'CONNECTIVITY_SENDER', label: 'Sender Connectivity', multiline: true },
  { key: 'INPUT_FORMAT', label: 'Input Format' },
  { key: 'CONNECTIVITY_RECEIVER', label: 'Receiver Connectivity', multiline: true },
  { key: 'OUTPUT_FORMAT', label: 'Output Format' },
  { key: 'PACKAGE_NAME', label: 'Package Name' },
  { key: 'EXCEPTION_TEXT', label: 'Exception Subprocess', multiline: true },
]

const IMAGE_SLOTS = [
  ['IMG_INPUT_PAYLOAD', 'Sample input payload'],
  ['IMG_MESSAGE_MAPPING', 'Message mapping'],
  ['IMG_GROOVY', 'Groovy scripts'],
  ['IMG_OUTPUT_PAYLOAD', 'Output payload'],
  ['IMG_CONFIG_SENDER', 'Sender configuration'],
  ['IMG_CONFIG_RECEIVER', 'Receiver configuration'],
]

export default function MultiFlowPanel({ registry, mainFlowId, onExport, busy }) {
  const allFlows = useMemo(() => [...(registry?.values?.() || [])], [registry])

  const [selectedIds, setSelectedIds] = useState(() => (mainFlowId ? [mainFlowId] : []))
  const [perFlow, setPerFlow] = useState({})     // id -> { customName, context, values, images }
  const [editing, setEditing] = useState(mainFlowId || null)
  const [mode, setMode] = useState('combined')
  const [showPicker, setShowPicker] = useState(false)
  const [drafting, setDrafting] = useState(null)
  const [err, setErr] = useState(null)
  const abortRef = useRef(null)

  const flowById = useMemo(() => new Map(allFlows.map(f => [f.id, f])), [allFlows])

  const warnings = useMemo(
    () => validateFlowSet(registry, selectedIds)?.warnings || [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry, selectedIds.join('|')])

  // Display name: the author's override if set, otherwise the parsed name.
  function displayName(id) {
    return perFlow[id]?.customName?.trim() || flowById.get(id)?.name || id
  }

  // Same name twice in one document makes the sections impossible to tell
  // apart — surface it rather than letting it through silently.
  const duplicateNames = useMemo(() => {
    const counts = new Map()
    for (const id of selectedIds) {
      const n = displayName(id)
      counts.set(n, (counts.get(n) || 0) + 1)
    }
    return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, perFlow, flowById])

  function addFlow(id) {
    if (selectedIds.includes(id)) return
    setSelectedIds(ids => [...ids, id])
    setEditing(cur => cur || id)
    // Close the picker so the flow just added is immediately visible in the
    // selected list below — leaving the picker open made it look like nothing
    // happened, because the added flow rendered under the fold.
    setShowPicker(false)
  }

  function removeFlow(id) {
    const remaining = selectedIds.filter(x => x !== id)
    setSelectedIds(remaining)
    if (editing === id) setEditing(remaining[0] || null)
  }

  function move(id, dir) {
    setSelectedIds(ids => {
      const i = ids.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= ids.length) return ids
      const next = [...ids]
      const tmp = next[i]; next[i] = next[j]; next[j] = tmp
      return next
    })
  }

  // Follow the ProcessDirect chain from the first selected flow and add
  // whatever it reaches that isn't already in the document.
  function autoDiscover() {
    const root = selectedIds[0] || mainFlowId
    if (!root) return
    const { ordered } = resolveFlowSet(registry, root)
    const found = ordered.map(f => f.id).filter(id => !selectedIds.includes(id))
    if (!found.length) {
      setErr('No further flows reachable over ProcessDirect from the first flow.')
      return
    }
    setErr(null)
    setSelectedIds(ids => [...ids, ...found])
  }

  const patch = (id, part) =>
    setPerFlow(s => ({ ...s, [id]: { ...s[id], ...part } }))

  const setValue = (id, key, val) =>
    setPerFlow(s => ({ ...s, [id]: { ...s[id], values: { ...s[id]?.values, [key]: val } } }))

  async function draftFields(id) {
    const flow = flowById.get(id)
    if (!flow) return
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setDrafting(id); setErr(null)
    try {
      const r = await fetch('/api/spec-flow-fields', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow, context: perFlow[id]?.context || '' }),
        signal: ctrl.signal,
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || `Draft failed (HTTP ${r.status})`)

      // Merge rather than overwrite: anything already typed is the author's
      // and wins over a draft.
      setPerFlow(s => {
        const existing = s[id]?.values || {}
        const merged = { ...(data.values || {}) }
        for (const [k, v] of Object.entries(existing)) {
          const written = Array.isArray(v) ? v.some(x => String(x).trim()) : String(v ?? '').trim()
          if (written) merged[k] = v
        }
        return { ...s, [id]: { ...s[id], values: merged } }
      })
    } catch (e) {
      if (e.name !== 'AbortError') setErr(e.message)
    }
    if (abortRef.current === ctrl) { setDrafting(null); abortRef.current = null }
  }

  async function addImage(id, slot, fileList) {
    const file = [...(fileList || [])].find(f => f.type.startsWith('image/'))
    if (!file) return
    const { dataUrl, mime, base64 } = await downscaleImage(file)
    setPerFlow(s => ({
      ...s,
      [id]: {
        ...s[id],
        images: [...(s[id]?.images || []).filter(i => i.slot !== slot),
                 { id: newImageId(), slot, base64, mime, preview: dataUrl, name: file.name, caption: '' }],
      },
    }))
  }

  function doExport() {
    const flows = selectedIds.map((id, i) => {
      const name = displayName(id)
      return {
        id, name,
        heading: i === 0 ? `Flow 1 — ${name} (main)` : `Flow ${i + 1} — ${name}`,
        entryNote: describeEntry(flowById.get(id) || {}, null),
        values: { FLOW_NAME: name, ...(perFlow[id]?.values || {}) },
      }
    })

    // Combined output suffixes image slots by position; separate documents are
    // standalone so each keeps the plain slot name.
    const images = []
    const imagesByFlow = {}
    selectedIds.forEach((id, i) => {
      const imgs = perFlow[id]?.images || []
      imagesByFlow[id] = imgs.map(im => ({ base64: im.base64, mime: im.mime, caption: im.caption, slot: im.slot }))
      imgs.forEach(im => images.push({
        base64: im.base64, mime: im.mime, caption: im.caption,
        slot: i === 0 ? im.slot : `${im.slot}__${i + 1}`,
      }))
    })

    onExport({ mode, flows, images, imagesByFlow })
  }

  const unselected = allFlows.filter(f => !selectedIds.includes(f.id))
  const current = editing && selectedIds.includes(editing) ? editing : (selectedIds[0] || null)

  return (
    <div>
      {/* 1. Attach */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={{ ...microLabel, margin: 0 }}>FLOWS IN THIS DOCUMENT</div>
          <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>{selectedIds.length} selected</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12.5 }}
              onClick={autoDiscover} disabled={!selectedIds.length}
              title="Follow ProcessDirect calls from the first flow and add what they reach">
              Auto-discover connected
            </button>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12.5 }}
              onClick={() => setShowPicker(v => !v)} disabled={!unselected.length}>
              + Add iFlow{unselected.length ? ` (${unselected.length})` : ''}
            </button>
          </div>
        </div>

        {showPicker && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 9, padding: 8, marginBottom: 10, maxHeight: 190, overflowY: 'auto' }}>
            {unselected.length === 0
              ? <div style={{ fontSize: 13, color: 'var(--text3)', padding: 6 }}>Every uploaded iFlow is already in this document.</div>
              : unselected.map(f => (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name || f.id}</div>
                      <div style={{ fontSize: 12, color: 'var(--text3)' }}>{Object.keys(f.steps || {}).length} steps</div>
                    </div>
                    <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }} onClick={() => addFlow(f.id)}>Add</button>
                  </div>
                ))}
          </div>
        )}

        {selectedIds.length === 0 && (
          <div style={{ fontSize: 14, color: 'var(--text3)', lineHeight: 1.7, padding: '6px 0' }}>
            No flows selected yet. Add the main iFlow, then use <b>Auto-discover connected</b> to pull in
            everything it calls over ProcessDirect.
          </div>
        )}

        {selectedIds.map((id, i) => (
          <div key={id} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 9px', marginBottom: 5,
            border: '1px solid var(--border)', borderRadius: 8,
            background: current === id ? 'var(--blue-bg)' : 'var(--bg3)',
          }}>
            <span style={{ fontSize: 12.5, color: 'var(--text3)', width: 16 }}>{i + 1}.</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {displayName(id)}
                {i === 0 && <span style={{ fontSize: 11, color: 'var(--blue)', fontWeight: 800, marginLeft: 6 }}>MAIN</span>}
                {duplicateNames.has(displayName(id)) && (
                  <span style={{ fontSize: 11, color: '#e8a54b', fontWeight: 800, marginLeft: 6 }}
                    title="Another flow in this document has the same name — set a custom name so the sections can be told apart">
                    DUPLICATE NAME
                  </span>
                )}
              </div>
              {perFlow[id]?.customName?.trim() && (
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>iFlow: {flowById.get(id)?.name || id}</div>
              )}
            </div>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }} disabled={i === 0} onClick={() => move(id, -1)}>↑</button>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }} disabled={i === selectedIds.length - 1} onClick={() => move(id, 1)}>↓</button>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }} onClick={() => setEditing(id)}>Edit</button>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, color: 'var(--red)' }} onClick={() => removeFlow(id)}>×</button>
          </div>
        ))}

        {warnings.length > 0 && (
          <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid #7d5a3a', background: 'rgba(184,133,77,.10)', fontSize: 13, color: 'var(--text2)', lineHeight: 1.6 }}>
            <b style={{ color: '#e8a54b' }}>Check the flow set.</b> A spec that quietly omits part of the
            chain is the gap someone hits months later:
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {warnings.map((w, i) => <li key={i}>{w.text || w.message || String(w)}</li>)}
            </ul>
          </div>
        )}
      </div>

      {err && (
        <div style={{ padding: '10px 13px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid rgba(185,28,28,.25)', fontSize: 13.5, color: 'var(--red)', marginBottom: 14, lineHeight: 1.6 }}>
          {err}
        </div>
      )}

      {/* 2. Detail, one flow at a time */}
      {current && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ ...microLabel, margin: 0 }}>EDITING</div>
            <select value={current} onChange={e => setEditing(e.target.value)}
              style={{ padding: '7px 9px', fontSize: 14, minWidth: 240, maxWidth: 420 }}>
              {selectedIds.map((id, i) => (
                <option key={id} value={id}>{i + 1}. {displayName(id)}</option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12.5, marginLeft: 'auto' }}
              onClick={() => drafting === current ? abortRef.current?.abort() : draftFields(current)}>
              {drafting === current ? 'Cancel' : '✨ Draft this flow'}
            </button>
          </div>

          <div style={{ marginBottom: 11 }}>
            <div style={fieldLabel}>Display name in the document</div>
            <input value={perFlow[current]?.customName ?? ''} placeholder={flowById.get(current)?.name || current}
              onChange={e => patch(current, { customName: e.target.value })}
              style={inputStyle} />
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 3 }}>
              Overrides the iFlow's own name for the section heading and filename — useful when two
              uploaded flows share a name.
            </div>
          </div>

          <div style={{ marginBottom: 11 }}>
            <div style={fieldLabel}>Context for this flow</div>
            <textarea rows={3} value={perFlow[current]?.context ?? ''}
              onChange={e => patch(current, { context: e.target.value })}
              placeholder="Business knowledge the iFlow can't contain — what this flow is for, which system owns the data, anything the reader needs. Used when drafting this flow's fields."
              style={{ ...inputStyle, resize: 'vertical' }} />
          </div>

          {PER_FLOW_FIELDS.map(f => (
            <div key={f.key} style={{ marginBottom: 10 }}>
              <div style={fieldLabel}>{f.label}</div>
              {f.multiline
                ? <textarea rows={2} value={perFlow[current]?.values?.[f.key] || ''}
                    onChange={e => setValue(current, f.key, e.target.value)}
                    style={{ ...inputStyle, resize: 'vertical' }} />
                : <input value={perFlow[current]?.values?.[f.key] || ''}
                    onChange={e => setValue(current, f.key, e.target.value)}
                    style={inputStyle} />}
            </div>
          ))}

          <FlowSteps
            steps={perFlow[current]?.values?.IMPL_STEPS}
            setSteps={s => setValue(current, 'IMPL_STEPS', s)} />

          <div style={{ marginTop: 14 }}>
            <div style={fieldLabel}>SCREENSHOTS</div>
            {IMAGE_SLOTS.map(([slot, label]) => {
              const img = (perFlow[current]?.images || []).find(im => im.slot === slot)
              return (
                <div key={slot} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 5 }}>
                  <span style={{ fontSize: 13, color: 'var(--text3)', width: 172, flexShrink: 0 }}>{label}</span>
                  {img ? (
                    <>
                      <img src={img.preview} alt="" style={{ width: 54, height: 34, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--border)' }} />
                      <input value={img.caption} placeholder="Caption (optional)"
                        onChange={e => setPerFlow(s => ({ ...s, [current]: { ...s[current],
                          images: (s[current]?.images || []).map(m => m.id === img.id ? { ...m, caption: e.target.value } : m) } }))}
                        style={{ ...inputStyle, flex: 1, padding: '5px 8px', fontSize: 13 }} />
                      <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, color: 'var(--red)' }}
                        onClick={() => setPerFlow(s => ({ ...s, [current]: { ...s[current], images: (s[current]?.images || []).filter(m => m.id !== img.id) } }))}>×</button>
                    </>
                  ) : (
                    <label className="btn btn-ghost btn-sm" style={{ fontSize: 12, cursor: 'pointer' }}>
                      Attach
                      <input type="file" accept="image/*" hidden
                        onChange={e => { addImage(current, slot, e.target.files); e.target.value = '' }} />
                    </label>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 3. Output */}
      <div style={card}>
        <div style={microLabel}>OUTPUT</div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 9, cursor: 'pointer' }}>
          <input type="radio" checked={mode === 'combined'} onChange={() => setMode('combined')} style={{ marginTop: 3 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 650 }}>One combined document</div>
            <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
              Shared front matter written once, then a section per flow. One file to hand over.
            </div>
          </div>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input type="radio" checked={mode === 'separate'} onChange={() => setMode('separate')} style={{ marginTop: 3 }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 650 }}>Separate documents + overview</div>
            <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
              One .docx per flow plus a linking overview recording how they connect, delivered as a zip.
            </div>
          </div>
        </label>
      </div>

      <button className="btn btn-primary" onClick={doExport} disabled={busy || !selectedIds.length}>
        {busy ? 'Building…' : mode === 'combined' ? '⬇ Export combined .docx' : '⬇ Export .zip'}
      </button>
    </div>
  )
}

function FlowSteps({ steps, setSteps }) {
  const list = Array.isArray(steps) && steps.length ? steps : ['', '']
  return (
    <div>
      <div style={fieldLabel}>IMPLEMENTATION STEPS</div>
      {list.map((t, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 5 }}>
          <span style={{ fontSize: 12.5, color: 'var(--text3)', width: 16, paddingTop: 7 }}>{i + 1}.</span>
          <textarea rows={1} value={t}
            onChange={e => setSteps(list.map((s, j) => j === i ? e.target.value : s))}
            style={{ ...inputStyle, flex: 1, resize: 'vertical' }} />
          {list.length > 1 && (
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, color: 'var(--red)' }}
              onClick={() => setSteps(list.filter((_, j) => j !== i))}>×</button>
          )}
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }}
        onClick={() => setSteps([...list, ''])}>+ Add step</button>
    </div>
  )
}

const card = {
  background: 'var(--bg2)', border: '1px solid var(--border)',
  borderRadius: 12, padding: '16px 18px', marginBottom: 14,
}
const microLabel = {
  fontSize: 12, fontWeight: 800, letterSpacing: '.07em',
  color: 'var(--text2)', marginBottom: 12, textTransform: 'uppercase',
}
const fieldLabel = {
  fontSize: 12, color: 'var(--text3)', marginBottom: 4, fontWeight: 600,
}
const inputStyle = {
  width: '100%', padding: '7px 9px', fontSize: 14, fontFamily: 'inherit',
}
