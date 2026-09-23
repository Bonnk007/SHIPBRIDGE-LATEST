// AI Technical Spec — generate a complete specification document from a
// parsed iFlow, with no template required.
//
// The division of labour matters and is visible in the UI: everything the
// AI wrote is editable prose, and everything extracted from the iFlow XML
// (step table, adapters, Content Modifier tables, Groovy source, credential
// aliases) is rendered into the document as tables the AI cannot alter. The
// "Extracted facts" strip at the top shows what was pulled from the flow so
// the author can see the document isn't guesswork.

import { useState, useEffect, useRef } from 'react'
import { downscaleImage, newImageId } from '../lib/imageUtils.js'

// Must match SPEC_SECTIONS in server/specAiDoc.js — the keys are the contract
// between the AI's JSON response, this editor, and the document builder.
const SECTIONS = [
  { key: 'overview',             title: '1. Overview',                    hint: 'What this integration does and what triggers it' },
  { key: 'highLevelDesign',      title: '2. High-Level Design',           hint: 'Integration pattern and systems involved' },
  { key: 'messageFlow',          title: '3. Message Flow',                hint: 'Walkthrough of the message path — step table is added automatically' },
  { key: 'technicalDescription', title: '4. Technical Description',       hint: 'Config decisions — CM tables and script source are added automatically' },
  { key: 'senderReceiver',       title: '5. Sender / Receiver Details',   hint: 'Channels and endpoints — adapter table is added automatically' },
  { key: 'mappings',             title: '6. Mappings & Transformations',  hint: 'Transformations applied' },
  { key: 'security',             title: '7. Security',                    hint: 'Auth and credential aliases — table is added automatically' },
  { key: 'errorHandling',        title: '8. Error Handling',              hint: 'Exception subprocesses and error paths' },
  { key: 'appendix',             title: '9. Appendix',                    hint: 'Bundled artifacts and anything else worth recording' },
]

export default function AiSpecPanel({ flow }) {
  const [sections, setSections] = useState(null)   // { key: text } once generated
  const [facts, setFacts] = useState(null)         // deterministic extraction from the server
  const [scriptExplanations, setScriptExplanations] = useState({}) // per-Groovy-script description, keyed by step name
  const [images, setImages] = useState([])         // { id, section, base64, mime, ratio, preview, caption, name }
  const [meta, setMeta] = useState({
    interfaceName: '', version: '1.0', author: '', packageName: '',
    date: new Date().toISOString().slice(0, 10),
  })
  const [context, setContext] = useState('')      // author's own business context
  const [detail, setDetail] = useState('brief')   // brief | standard | detailed
  const [busy, setBusy] = useState(false)
  const abortRef = useRef(null)
  const [busySection, setBusySection] = useState(null)
  const [sectionErrors, setSectionErrors] = useState({})  // per-section failures from the parallel generate
  const [err, setErr] = useState(null)

  // Prefill the interface name from the flow. Keyed on the flow's identity so
  // switching iFlows in the dropdown re-prefills rather than leaving the
  // previous flow's name stranded in the field. A name the user typed
  // themselves is never overwritten. Author and package stay blank — a
  // placeholder in a client document is worse than an empty field.
  const autoName = useRef(null)
  useEffect(() => {
    const name = flow?.name
    if (!name) return
    setMeta(m => {
      // Only replace if the field is empty or still holds a previous auto-fill.
      if (m.interfaceName && m.interfaceName !== autoName.current) return m
      autoName.current = name
      return { ...m, interfaceName: name }
    })
  }, [flow?.id, flow?.name])

  async function post(url, body, signal) {
    let r
    try {
      r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal,
      })
    } catch (e) {
      if (e.name === 'AbortError') throw e
      throw new Error("Couldn't reach the ShipBridge server. Make sure it's running (`npm run dev` starts both).")
    }
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `Request failed (HTTP ${r.status})`)
    return data
  }

  function cancelGenerate() {
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
  }

  async function generateAll() {
    if (!flow) return setErr('Upload an iFlow ZIP first — the spec is generated from it.')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setBusy(true); setErr(null)
    try {
      const data = await post('/api/spec-ai-generate', { flow, context, detail }, ctrl.signal)
      setSections(data.sections || {})
      setFacts(data.facts || null)
      setSectionErrors(data.errors || {})
      // Script explanations are a second call so a slow/failed script pass
      // can't cost you the whole document — the spec is already usable.
      try {
        const sc = await post('/api/spec-ai-scripts', { flow }, ctrl.signal)
        setScriptExplanations(sc.explanations || {})
      } catch { /* non-fatal — scripts still appear, just without prose */ }
    } catch (e) {
      // A cancel isn't a failure — don't shout about it.
      if (e.name !== 'AbortError') setErr(e.message)
    }
    if (abortRef.current === ctrl) abortRef.current = null
    setBusy(false)
  }

  async function regenerate(key, title, instruction) {
    setBusySection(key); setErr(null)
    try {
      const data = await post('/api/spec-ai-section', { flow, sectionKey: key, sectionTitle: title, instruction, context, detail })
      setSections(s => ({ ...s, [key]: data.text || '' }))
      setSectionErrors(e => { const n = { ...e }; delete n[key]; return n })
    } catch (e) { setErr(e.message) }
    setBusySection(null)
  }

  async function addImages(fileList, sectionKey) {
    const files = [...(fileList || [])].filter(f => f.type.startsWith('image/'))
    for (const file of files) {
      const { dataUrl, mime, base64, ratio } = await downscaleImage(file)
      setImages(imgs => [...imgs, {
        id: newImageId(), section: sectionKey, base64, mime, ratio,
        preview: dataUrl, caption: '', name: file.name,
      }])
    }
  }

  async function describeImage(id) {
    const img = images.find(i => i.id === id)
    if (!img) return
    setImages(imgs => imgs.map(i => i.id === id ? { ...i, describing: true } : i))
    try {
      const sec = SECTIONS.find(s => s.key === img.section)
      const data = await post('/api/spec-describe-image', {
        base64: img.base64, mime: img.mime,
        flowName: flow?.name, sectionTitle: sec?.title,
      })
      setImages(imgs => imgs.map(i => i.id === id ? { ...i, caption: data.caption || '', describing: false } : i))
    } catch (e) {
      setErr(e.message)
      setImages(imgs => imgs.map(i => i.id === id ? { ...i, describing: false } : i))
    }
  }

  async function exportDocx() {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/spec-ai-docx', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flow, sections, meta, scriptExplanations, detail,
          images: images.map(({ section, base64, mime, ratio, caption }) => ({ section, base64, mime, ratio, caption })),
        }),
      }).catch(() => { throw new Error("Couldn't reach the ShipBridge server.") })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Export failed (HTTP ${r.status})`) }
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${(meta.interfaceName || flow?.name || 'spec').replace(/[^a-z0-9]+/gi, '_')}_TechnicalSpec.docx`
      a.click(); URL.revokeObjectURL(a.href)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  if (!flow) {
    return (
      <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--text3)', fontSize: 14.5, lineHeight: 1.7 }}>
        Upload an iFlow ZIP first. The AI spec is generated from the flow's real configuration —
        steps, adapters, Content Modifiers, and Groovy scripts — so there's nothing to write without it.
      </div>
    )
  }

  return (
    <div>
      {/* Document metadata */}
      <div style={card}>
        <div style={microLabel}>DOCUMENT DETAILS</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          <MetaField label="Interface Name" value={meta.interfaceName} onChange={v => setMeta(m => ({ ...m, interfaceName: v }))} />
          <MetaField label="Version" value={meta.version} onChange={v => setMeta(m => ({ ...m, version: v }))} />
          <MetaField label="Author" value={meta.author} placeholder="" onChange={v => setMeta(m => ({ ...m, author: v }))} />
          <MetaField label="Package" value={meta.packageName} placeholder="" onChange={v => setMeta(m => ({ ...m, packageName: v }))} />
          <MetaField label="Date" value={meta.date} onChange={v => setMeta(m => ({ ...m, date: v }))} />
        </div>
      </div>

      {/* Author context — the one input the iFlow XML genuinely cannot supply */}
      <div style={card}>
        <div style={microLabel}>CONTEXT (OPTIONAL)</div>
        <p style={{ fontSize: 13, color: 'var(--text3)', lineHeight: 1.6, margin: '0 0 9px' }}>
          Business background the iFlow can't tell us — which systems own the data, why this
          integration exists, anything the reader needs that isn't in the XML. Used for every
          section, and for regenerating any one of them.
        </p>
        <textarea value={context} onChange={e => setContext(e.target.value)} rows={3}
          placeholder=""
          style={{ width: '100%', padding: '9px 11px', fontSize: 14, resize: 'vertical', fontFamily: 'inherit' }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 11, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--text3)', fontWeight: 600 }}>LENGTH</span>
          {[
            ['brief', 'Brief', '2–3 sentences per section'],
            ['standard', 'Standard', 'a short paragraph'],
            ['detailed', 'Detailed', 'fuller treatment'],
          ].map(([id, label, hint]) => (
            <label key={id} title={hint}
              style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13.5, cursor: 'pointer',
                       color: detail === id ? 'var(--blue)' : 'var(--text2)', fontWeight: detail === id ? 700 : 500 }}>
              <input type="radio" checked={detail === id} onChange={() => setDetail(id)} />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Generate */}
      {!sections && (
        <div style={{ ...card, textAlign: 'center', padding: '30px 22px' }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, marginBottom: 6 }}>Generate the specification</div>
          <p style={{ fontSize: 14, color: 'var(--text3)', lineHeight: 1.7, maxWidth: 560, margin: '0 auto 18px' }}>
            Claude writes all nine sections from <b>{flow.name}</b>'s real configuration. Step tables,
            adapter settings, Content Modifier headers and properties, Groovy source, and credential
            aliases are extracted from the iFlow itself — the AI writes the prose around them, never
            the facts. Everything stays editable before export.
          </p>
          <div style={{ display: 'flex', gap: 9, justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={generateAll} disabled={busy}>
              {busy ? 'Writing all nine sections…' : 'Generate spec'}
            </button>
            {busy && <button className="btn btn-ghost" onClick={cancelGenerate}>Cancel</button>}
          </div>
        </div>
      )}

      {err && (
        <div style={{ padding: '11px 14px', borderRadius: 8, background: 'var(--red-bg)', border: '1px solid rgba(185,28,28,.25)', fontSize: 14, color: 'var(--red)', marginBottom: 14, lineHeight: 1.6 }}>
          {err}
        </div>
      )}

      {sections && (
        <>
          {facts && <FactStrip facts={facts} />}

          {SECTIONS.map(sec => (
            <SectionCard
              key={sec.key} sec={sec}
              text={sections[sec.key] || ''}
              onChange={v => setSections(s => ({ ...s, [sec.key]: v }))}
              onRegenerate={(instruction) => regenerate(sec.key, sec.title, instruction)}
              busy={busySection === sec.key}
              error={sectionErrors[sec.key]}
              images={images.filter(i => i.section === sec.key)}
              onAddImages={files => addImages(files, sec.key)}
              onDescribe={describeImage}
              onCaption={(id, caption) => setImages(imgs => imgs.map(i => i.id === id ? { ...i, caption } : i))}
              onRemove={id => setImages(imgs => imgs.filter(i => i.id !== id))}
            />
          ))}

          {Object.keys(scriptExplanations).length > 0 && (
            <div style={card}>
              <div style={microLabel}>GROOVY SCRIPTS — WHAT EACH ONE DOES</div>
              <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 10 }}>
                Paired with each script's source in the Technical Description section of the document.
              </div>
              {Object.entries(scriptExplanations).map(([stepName, text]) => (
                <div key={stepName} style={{ marginBottom: 11 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text2)', marginBottom: 4 }}>{stepName}</div>
                  <textarea value={text} rows={3}
                    onChange={e => setScriptExplanations(m => ({ ...m, [stepName]: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13.5, resize: 'vertical', fontFamily: 'inherit' }} />
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 18 }}>
            <button className="btn btn-primary" onClick={exportDocx} disabled={busy}>
              {busy ? 'Building…' : '⬇ Export .docx'}
            </button>
            <button className="btn btn-ghost" onClick={generateAll} disabled={busy}>Regenerate all</button>
            {busy && <button className="btn btn-ghost" onClick={cancelGenerate}>Cancel</button>}
            <span style={{ fontSize: 13, color: 'var(--text3)' }}>
              {images.length ? `${images.length} image${images.length === 1 ? '' : 's'} attached · ` : ''}
              tables are added automatically from the iFlow
            </span>
          </div>
        </>
      )}
    </div>
  )
}

// Shows what was pulled out of the iFlow, so the author can see at a glance
// that the document is grounded in the real artifact rather than invented.
function FactStrip({ facts }) {
  const items = [
    [facts.stepCount, 'steps'],
    [facts.adapters?.length, 'adapters'],
    [facts.contentModifiers?.length, 'content modifiers'],
    [facts.scripts?.length, 'scripts'],
    [facts.mappings?.length, 'mappings'],
    [facts.security?.length, 'security entries'],
  ].filter(([n]) => n)

  return (
    <div style={{ ...card, padding: '11px 14px', display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ ...microLabel, margin: 0 }}>EXTRACTED FROM IFLOW</span>
      {items.map(([n, label]) => (
        <span key={label} style={{ fontSize: 13, color: 'var(--text2)' }}>
          <b style={{ color: 'var(--blue)' }}>{n}</b> {label}
        </span>
      ))}
      <span style={{ fontSize: 12.5, color: 'var(--text3)', marginLeft: 'auto' }}>
        rendered as tables in the document — not written by AI
      </span>
    </div>
  )
}

function SectionCard({ sec, text, onChange, onRegenerate, busy, error, images, onAddImages, onDescribe, onCaption, onRemove }) {
  const [instruction, setInstruction] = useState('')
  const [showInstruction, setShowInstruction] = useState(false)

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ fontSize: 14.5, fontWeight: 750 }}>{sec.title}</div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowInstruction(v => !v)} style={{ fontSize: 12.5 }}>
            Guide…
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => onRegenerate(instruction || undefined)} disabled={busy} style={{ fontSize: 12.5 }}>
            {busy ? 'Writing…' : 'Regenerate'}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 9 }}>{sec.hint}</div>

      {error && (
        <div style={{ padding: '8px 11px', borderRadius: 7, background: 'var(--red-bg)', border: '1px solid rgba(185,28,28,.25)', fontSize: 13, color: 'var(--red)', marginBottom: 9, lineHeight: 1.5 }}>
          This section didn't generate: {error} — hit Regenerate to retry just this one.
        </div>
      )}
      {showInstruction && (
        <input value={instruction} onChange={e => setInstruction(e.target.value)}
          placeholder=""
          style={{ width: '100%', padding: '7px 10px', fontSize: 13.5, marginBottom: 9 }} />
      )}

      <textarea value={text} onChange={e => onChange(e.target.value)} rows={Math.min(14, Math.max(4, text.split('\n').length + 1))}
        placeholder="Empty — click Regenerate, or write this section yourself."
        style={{ width: '100%', padding: '10px 12px', fontSize: 14, lineHeight: 1.65, resize: 'vertical', fontFamily: 'inherit' }} />

      {/* Images for this section */}
      <div style={{ marginTop: 10 }}>
        <label className="btn btn-ghost btn-sm" style={{ fontSize: 12.5, cursor: 'pointer', display: 'inline-block' }}>
          + Add image
          <input type="file" accept="image/*" multiple hidden
            onChange={e => { onAddImages(e.target.files); e.target.value = '' }} />
        </label>
        {images.map(img => (
          <div key={img.id} style={{ display: 'flex', gap: 11, marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg3)' }}>
            <img src={img.preview} alt="" style={{ width: 108, height: 72, objectFit: 'cover', borderRadius: 6, flexShrink: 0, border: '1px solid var(--border)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{img.name}</div>
              <textarea value={img.caption} onChange={e => onCaption(img.id, e.target.value)} rows={2}
                placeholder="Caption — write it, or let Claude describe the screenshot"
                style={{ width: '100%', padding: '6px 9px', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }} />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }} disabled={img.describing}
                  onClick={() => onDescribe(img.id)}>
                  {img.describing ? 'Looking…' : '✨ Describe with AI'}
                </button>
                <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, color: 'var(--red)' }}
                  onClick={() => onRemove(img.id)}>Remove</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function MetaField({ label, value, onChange, placeholder }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4, fontWeight: 600 }}>{label}</div>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: '100%', padding: '8px 10px', fontSize: 14 }} />
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
