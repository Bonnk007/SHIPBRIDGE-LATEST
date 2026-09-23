// Documentation / Spec Builder
//
// TWO PATHS both supported:
//   A. Default Motiveminds template  — 16 predefined tokens with a curated form
//   B. Upload-your-own template      — user uploads .docx with {{TOKEN}} placeholders,
//                                       app scans it, generates form dynamically
//
// Both paths use the same server engine: template substitution via JSZip.
// The user's real client .docx is the master — logo, fonts, header, page layout
// are preserved exactly because we're modifying the real file, not rebuilding.

import { useState, useEffect, useMemo } from 'react'
import { extractAllAdapters } from '../lib/specAdapters.js'
import { resolveProcessDirect } from '../lib/specProcessDirect.js'
import { downscaleImage, newImageId } from '../lib/imageUtils.js'
import AiSpecPanel from './AiSpecPanel.jsx'
import MultiFlowPanel from './MultiFlowPanel.jsx'


// ── Curated field metadata for the DEFAULT template ──────────────────────
// Order + labels + rendering hints for the 16 tokens in motiveminds_template.docx
const DEFAULT_FIELDS = [
  // No example placeholders: this tool is handed to clients, and another
  // project's system names sitting in the fields reads as leftover template
  // cruft. `help` stays where it explains what a field means — that's
  // instruction, not someone else's data.
  { section: 'Header', label: 'Interface Name', key: 'INTERFACE_NAME' },
  { section: 'Version History', label: 'Version', key: 'VERSION', width: 100 },
  { section: 'Version History', label: 'Change Description', key: 'CHANGE_DESC' },
  { section: 'Version History', label: 'Sections', key: 'SECTIONS', width: 120 },
  { section: 'Version History', label: 'Revision Date', key: 'REV_DATE', width: 140 },
  { section: 'Version History', label: 'Author', key: 'AUTHOR' },
  { section: 'Version History', label: 'Reviewer', key: 'REVIEWER' },
  { section: 'Business Context', label: 'Business Context', key: 'BUSINESS_CONTEXT', multiline: true,
    help: 'The variable part of: "This Interface is used to <YOUR TEXT> via Cloud integration (CI)."' },
  { section: 'Business Context', label: 'GO-Live Date', key: 'GO_LIVE' },
  { section: 'Solution Design', label: 'Package Name', key: 'PACKAGE_NAME' },
  { section: 'Solution Design', label: 'Flow Name', key: 'FLOW_NAME' },
  { section: 'Solution Design', label: 'Architecture Summary', key: 'ARCHITECTURE', multiline: true,
    help: 'One line describing the hop path, e.g. source system to CI to target system' },
  { section: 'Solution Design', label: 'Sender Connectivity', key: 'CONNECTIVITY_SENDER', multiline: true },
  { section: 'Solution Design', label: 'Receiver Connectivity', key: 'CONNECTIVITY_RECEIVER', multiline: true },
  { section: 'Solution Design', label: 'Input Format', key: 'INPUT_FORMAT', width: 160 },
  { section: 'Solution Design', label: 'Output Format', key: 'OUTPUT_FORMAT', width: 160 },
  { section: 'Implementation', label: 'Exception Subprocess', key: 'EXCEPTION_TEXT', multiline: true,
    help: 'What happens on failure — mail alerts, retry logic, etc.' },
]

const TABS = [
  { id: 'spec',     label: 'Spec Document' },
  { id: 'overview', label: 'iFlow Overview' },
  { id: 'adapters', label: 'Adapter Details' },
  { id: 'pd',       label: 'ProcessDirect Flow' },
]

// ── Main page ────────────────────────────────────────────────────────────
export default function Documentation({ registry, onUpload }) {
  const flows = [...(registry?.values?.() || [])]
  const [selId, setSelId] = useState(flows[0]?.id || '')
  const flow = registry?.get?.(selId) || flows[0]
  const [tab, setTab] = useState('spec')

  const adapters = useMemo(() => flow ? extractAllAdapters(flow) : { all: [], senders: [], receivers: [], other: [] }, [flow])
  const pd       = useMemo(() => flow ? resolveProcessDirect(flow, flows) : { calls: [], inbound: [] }, [flow, flows])

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 24px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 19, fontWeight: 750, margin: 0, flex: 1 }}>Documentation</h1>
        {flows.length > 0 && (
          <select value={selId} onChange={e => setSelId(e.target.value)} style={{ minWidth: 180 }}>
            {flows.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        <input id="docs-zip-add" type="file" accept=".zip" multiple style={{ display: 'none' }} onChange={e => { onUpload?.(e.target.files); e.target.value = '' }} />
        <button className="btn btn-ghost btn-sm" onClick={() => document.getElementById('docs-zip-add').click()}>
          {flows.length ? '+ iFlow' : 'Upload iFlow'}
        </button>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 16px' }}>
        {TABS.map(t => {
          const disabled = t.id !== 'spec' && !flow
          return (
            <button key={t.id} onClick={() => !disabled && setTab(t.id)} disabled={disabled}
              title={disabled ? 'Upload an iFlow ZIP first — this tab reads its parsed steps/adapters' : undefined}
              style={{
              padding: '10px 14px', border: 'none', background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', fontSize: 14, fontWeight: tab === t.id ? 700 : 500,
              color: disabled ? 'var(--text3)' : tab === t.id ? 'var(--blue)' : 'var(--text2)',
              borderBottom: tab === t.id ? '2px solid var(--blue)' : '2px solid transparent', marginBottom: -1,
              opacity: disabled ? 0.5 : 1,
            }}>{t.label}</button>
          )
        })}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === 'spec'     && <SpecBuilder flow={flow} adapters={adapters} registry={registry} />}
        {tab === 'overview' && flow && <Overview flow={flow} adapters={adapters} pd={pd} />}
        {tab === 'adapters' && flow && <Adapters adapters={adapters} />}
        {tab === 'pd'       && flow && <PdView flow={flow} pd={pd} />}
      </div>
    </div>
  )
}

// ── Spec Builder — the main event ────────────────────────────────────────
function SpecBuilder({ flow, adapters, registry }) {
  // AI Spec is the default: one iFlow in, full 9-section document out, no
  // template required. It's what most people want most of the time — Multi-Flow
  // needs several flows selected first, and the template modes need a template.
  const [mode, setMode] = useState('ai')     // 'ai' | 'multi' | 'default' | 'upload'
  const [tokens, setTokens] = useState([])         // text tokens from the active template
  const [imageTokens, setImageTokens] = useState([]) // {{IMG_*}} placement slots found in the template
  const [tokenContext, setTokenContext] = useState({}) // surrounding template text per token
  const [fieldMeta, setFieldMeta] = useState({})     // AI-generated {label, help, type, example} per token
  const [describing, setDescribing] = useState(false) // AI field-analysis in progress
  const [existingImageCount, setExistingImageCount] = useState(0) // images already inside the active template
  const [values, setValues] = useState({})
  const [templateBase64, setTemplateBase64] = useState(null)
  const [templateName, setTemplateName] = useState('')
  const [images, setImages] = useState([])         // screenshots attached by the user — appended at the end of the doc
  const [implImages, setImplImages] = useState([]) // one screenshot per implementation step, anchored beneath it
  const [busy, setBusy] = useState(false)
  const [busyField, setBusyField] = useState(null)
  const [err, setErr] = useState(null)

  // Auto-populate from the loaded iFlow — extraction-first, user edits after.
  // Only genuinely-extracted facts get filled in here (interface name, real
  // adapter config). We never invent placeholder values like "V1" or
  // today's date — those stay blank so the box isn't mistaken for an answer.
  useEffect(() => {
    if (!flow) return
    const guessFormat = (list) => {
      const t = (list[0]?.type || '').toLowerCase()
      if (t.includes('odata')) return 'XML (OData Atom)'
      if (t.includes('soap')) return 'XML (SOAP)'
      if (t.includes('jdbc')) return 'SQL XML'
      if (t.includes('http')) return 'JSON'
      return ''
    }
    const connText = (a) => a ? `${a.type} adapter${a.address ? ` at ${a.address}` : ''}${fieldOf(a, 'Authentication') ? `, authentication: ${fieldOf(a, 'Authentication')}` : ''}${fieldOf(a, 'Credential Name') ? `, credential: ${fieldOf(a, 'Credential Name')}` : ''}.` : ''
    setValues(v => ({
      ...v,
      INTERFACE_NAME: v.INTERFACE_NAME || flow.name || '',
      FLOW_NAME: v.FLOW_NAME || flow.name || '',
      CONNECTIVITY_SENDER: v.CONNECTIVITY_SENDER || connText(adapters?.senders?.[0]),
      CONNECTIVITY_RECEIVER: v.CONNECTIVITY_RECEIVER || connText(adapters?.receivers?.[0]),
      INPUT_FORMAT: v.INPUT_FORMAT || guessFormat(adapters?.senders || []),
      OUTPUT_FORMAT: v.OUTPUT_FORMAT || guessFormat(adapters?.receivers || []),
    }))
  }, [flow, adapters])

  // Compact facts object sent to AI Generate and adapter tables to the exporter.
  const specAdapters = useMemo(() => (adapters?.all || []).map(a => ({
    direction: a.direction, type: a.type, address: a.address,
    fields: (a.fields || []).slice(0, 24).map(f => ({ label: f.label, value: f.value })),
  })), [adapters])

  const aiFacts = useMemo(() => ({
    interfaceName: flow?.name,
    senders: specAdapters.filter(a => a.direction === 'Sender'),
    receivers: specAdapters.filter(a => a.direction === 'Receiver'),
    steps: Object.values(flow?.steps || {}).slice(0, 40).map(s => ({ name: s.name, kind: s.kind || s.type })),
  }), [flow, specAdapters])

  async function generateField(key) {
    if (!flow) { setErr('Load an iFlow first — Generate drafts text from real extracted facts (interface name, adapters, steps) and has nothing to work from otherwise.'); return }
    setBusyField(key)
    try {
      const r = await fetch('/api/spec-generate-field', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: key, facts: aiFacts, currentValue: values[key] || '' }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Generation failed')
      setValues(vs => ({ ...vs, [key]: data.text }))
    } catch (e) { setErr(e.message) }
    setBusyField(null)
  }

  // Load default template tokens on mount.
  useEffect(() => {
    if (mode !== 'default') return
    fetch('/api/spec-template').then(r => r.json()).then(data => {
      setTokens(data.tokens || [])
      setImageTokens(data.imageTokens || [])
      setExistingImageCount(data.existingImageCount || 0)
    }).catch(() => setErr('Could not load default template'))
  }, [mode])

  async function handleTemplateUpload(file) {
    if (!file) return
    setBusy(true); setErr(null); setFieldMeta({})
    try {
      const buf = await file.arrayBuffer()
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
      let r
      try {
        r = await fetch('/api/spec-scan-template', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base64 }),
        })
      } catch {
        throw new Error('Could not reach the ShipBridge server. Make sure it\'s running (`npm run dev` starts both client and server).')
      }
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Scan failed')
      const textTokens = data.tokens || []
      setTokens(textTokens)
      setImageTokens(data.imageTokens || [])
      setTokenContext(data.tokenContext || {})
      setExistingImageCount(data.existingImageCount || 0)
      setTemplateBase64(base64)
      setTemplateName(file.name)
      setImages(imgs => imgs.map(i => (data.imageTokens || []).includes(i.slot) ? i : { ...i, slot: '' }))
      if (!textTokens.length && !(data.imageTokens || []).length) {
        setErr('No {{TOKEN}} placeholders found. In your .docx, type {{INTERFACE_NAME}} where text should be filled in, and {{IMG_ARCHITECTURE}} (any {{IMG_...}} name) exactly where a screenshot should be placed.')
      } else if (textTokens.length) {
        describeFields(textTokens, data.tokenContext || {})  // fire-and-forget AI analysis
      }
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  // Ask the AI to explain each detected field (label, help text, type,
  // example). Best-effort — if it fails, the form still works with humanized
  // token names, we just don't get the friendly descriptions.
  async function describeFields(tokenList, ctx) {
    setDescribing(true)
    try {
      const r = await fetch('/api/spec-describe-fields', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens: tokenList, tokenContext: ctx }),
      })
      const data = await r.json()
      if (r.ok && data.fields) setFieldMeta(data.fields)
    } catch { /* silent — form degrades gracefully to token names */ }
    setDescribing(false)
  }

  // Multi-flow export. Shared values come from the main form; per-flow values
  // and images come from the panel. Response is a .docx (combined) or a .zip
  // (separate), so the download filename follows the mode.
  // Download the example .docx from the server. Sending it through the same
  // fetch → blob → anchor pattern used elsewhere keeps behaviour consistent
  // (works with the security gate, respects rate limits) instead of using a
  // plain <a href> which would bypass those.
  async function downloadExampleTemplate() {
    try {
      const r = await fetch('/api/example-template.docx')
      if (!r.ok) throw new Error(`Download failed (HTTP ${r.status})`)
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'shipbridge_template_starter.docx'
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      setErr(e.message)
    }
  }

  async function exportMulti({ mode: outMode, flows, images, imagesByFlow }) {
    setBusy(true); setErr(null)
    try {
      const body = {
        mode: outMode, shared: values, flows, images, imagesByFlow,
        adapters: specAdapters,
      }
      if (mode === 'upload' && templateBase64) body.templateBase64 = templateBase64

      let r
      try {
        r = await fetch('/api/spec-multi-docx', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
      } catch {
        throw new Error("Could not reach the ShipBridge server. Make sure it's running (`npm run dev` starts both).")
      }
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Generation failed (HTTP ${r.status})`) }

      const blob = await r.blob()
      const stem = (values.INTERFACE_NAME || 'specification').replace(/[^a-z0-9]+/gi, '_')
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = outMode === 'separate' ? `${stem}_specs.zip` : `${stem}.docx`
      a.click(); URL.revokeObjectURL(a.href)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  async function exportDocx() {
    setBusy(true); setErr(null)
    try {
      const body = {
        values, filename: values.INTERFACE_NAME || 'spec', adapters: specAdapters,
        images: [
          ...images.filter(i => i.base64).map(({ category, caption, base64, mime, slot }) => ({ category, caption, base64, mime, slot: slot || undefined })),
          // Per-step screenshots target the {{IMPL_IMG_n}} anchor that
          // expandImplSteps writes beneath each step, so they land in place
          // rather than in the end-of-document appendix.
          ...implImages.filter(i => i.base64).map(({ caption, base64, mime, stepIndex }) => ({
            caption, base64, mime, slot: `IMPL_IMG_${stepIndex + 1}`, category: `Step ${stepIndex + 1}`,
          })),
        ],
      }
      if (mode === 'upload' && templateBase64) body.templateBase64 = templateBase64

      let r
      try {
        r = await fetch('/api/spec-docx', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
      } catch {
        // fetch() only throws on network-level failure — server unreachable,
        // dev server not running, or connection dropped mid-request.
        throw new Error('Could not reach the ShipBridge server. Make sure it\'s running (you should see "ShipBridge API http://localhost:3001" in your terminal). If you only started the client, run `npm run dev` to start both.')
      }
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Generation failed (HTTP ${r.status})`) }
      const blob = await r.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${(values.INTERFACE_NAME || 'spec').replace(/[^a-z0-9]+/gi, '_')}.docx`
      a.click(); URL.revokeObjectURL(a.href)
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1000 }}>
      {/* Mode picker */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <ModeCard active={mode === 'multi'} title="Multi-Flow" desc="One process spanning several iFlows — combined doc or separate + overview" onClick={() => setMode('multi')} />
        <ModeCard active={mode === 'ai'} title="AI Spec" desc="Full 9-section spec written from the iFlow — no template needed" onClick={() => setMode('ai')} />
        <ModeCard active={mode === 'default'} title="Default Template" desc="Motiveminds standard format — 16 curated fields" onClick={() => setMode('default')} />
        <ModeCard active={mode === 'upload'} title="Bring Your Own Template" desc="Design in Word, add {{TOKEN}} placeholders, upload" onClick={() => setMode('upload')} />
      </div>

      {/* Guide banner — only shown in the upload mode so it doesn't distract
          from the other modes. Explains the token workflow inline rather than
          linking off to a separate page. */}
      {mode === 'upload' && !templateBase64 && (
        <BuildYourOwnGuide onDownloadExample={downloadExampleTemplate} />
      )}


      {/* AI mode owns the whole panel — its own metadata, sections, images
          and export, since it shares nothing with the template paths. */}
      {mode === 'ai' && <AiSpecPanel flow={flow} />}

      {mode === 'multi' && (
        <MultiFlowPanel registry={registry} mainFlowId={flow?.id}
          sharedValues={values} busy={busy} onExport={exportMulti} />
      )}

      {/* Upload zone (only in upload mode) */}
      {mode === 'upload' && (
        <div style={{ marginBottom: 18 }}>
          <input id="tpl-upload" type="file" accept=".docx" style={{ display: 'none' }}
            onChange={e => { handleTemplateUpload(e.target.files?.[0]); e.target.value = '' }} />
          <div onClick={() => document.getElementById('tpl-upload').click()}
            style={{ border: '1.5px dashed var(--border2)', borderRadius: 10, padding: '18px 22px', textAlign: 'center', cursor: 'pointer', background: 'var(--bg2)' }}>
            {templateName ? (
              <div style={{ fontSize: 14.5, color: 'var(--text2)' }}>
                <strong>{templateName}</strong> — <span style={{ color: 'var(--blue)' }}>{tokens.length} text field{tokens.length === 1 ? '' : 's'}{imageTokens.length > 0 ? `, ${imageTokens.length} image slot${imageTokens.length === 1 ? '' : 's'}` : ''}</span>
                {existingImageCount > 0 && <span style={{ color: 'var(--text3)' }}> · {existingImageCount} image{existingImageCount === 1 ? '' : 's'} already in the file (kept as-is)</span>}
                <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 4 }}>Click to change template</div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 26, opacity: .4, marginBottom: 4 }}>⬆</div>
                <div style={{ fontSize: 14.5, fontWeight: 600 }}>Upload a .docx template</div>
                <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 4 }}>
                  Type <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>{'{{INTERFACE_NAME}}'}</code> where text goes, <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>{'{{IMG_ARCHITECTURE}}'}</code> where a screenshot goes
                </div>
              </>
            )}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 8, lineHeight: 1.6 }}>
            <strong style={{ color: 'var(--text2)' }}>Placing images in your template:</strong> type a token starting with <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>IMG_</code> (e.g. <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>{'{{IMG_ARCHITECTURE}}'}</code>, <code style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3 }}>{'{{IMG_UAT}}'}</code>) on its own line in the .docx, exactly where the screenshot should appear. Upload the screenshot below and assign it to that slot — it replaces the token at that exact spot. Images without a slot are appended at the end instead. Logos and images already in your template are never touched.
          </div>
        </div>
      )}

      {/* Form — render whatever text tokens the active template has.
          Explicitly gated on mode so a previously-uploaded template doesn't
          leak its form into the AI panel. */}
      {mode !== 'ai' && mode !== 'multi' && (mode === 'default'
        ? <DefaultForm values={values} setValues={setValues} adapters={adapters} flow={flow} onGenerate={generateField} busyField={busyField} implImages={implImages} setImplImages={setImplImages} />
        : templateName && tokens.length > 0
          ? <UploadedForm tokens={tokens} values={values} setValues={setValues} fieldMeta={fieldMeta} describing={describing} />
          : null)}

      {/* Screenshots — placed at {{IMG_*}} slots or appended at the end */}
      {mode !== 'ai' && mode !== 'multi' && (mode === 'default' || (templateName && (tokens.length > 0 || imageTokens.length > 0))) && (
        <ScreenshotsSection images={images} setImages={setImages} imageTokens={imageTokens} />
      )}

      {/* Actions */}
      {mode !== 'ai' && mode !== 'multi' && (mode === 'default' || (templateName && (tokens.length > 0 || imageTokens.length > 0))) && (
        <div style={{ marginTop: 20, display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-primary" onClick={exportDocx} disabled={busy}>
            {busy ? 'Generating…' : '⬇ Export .docx'}
          </button>
          <div style={{ fontSize: 13, color: 'var(--text3)' }}>
            {mode === 'default' ? 'Motiveminds format' : `Using ${templateName}`}
          </div>
        </div>
      )}

      {err && <div className="alert alert-error" style={{ marginTop: 14 }}>{err}</div>}
    </div>
  )
}

// The "how" for Bring Your Own Template. Shows above the upload zone until a
// template is uploaded — once one is in play the form takes over the space.
// Explains the token syntax inline (not via a separate page or modal) so the
// user sees what they need to know before deciding to click Download.
function BuildYourOwnGuide({ onDownloadExample }) {
  return (
    <div style={{
      marginBottom: 18, padding: '18px 22px',
      border: '1px solid var(--border)', borderRadius: 10,
      background: 'var(--bg2)',
    }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: 'var(--text)' }}>
        Design your template in Microsoft Word
      </div>
      <p style={{ fontSize: 14, color: 'var(--text2)', lineHeight: 1.65, margin: '0 0 12px' }}>
        Open Word, lay out the document however you want — fonts, tables, headers,
        page numbers, your company logo, anything. Wherever you want ShipBridge to
        fill in a value from the iFlow, type a placeholder like this:
      </p>
      <div style={{
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: 13, background: 'var(--bg3)',
        padding: '10px 14px', borderRadius: 6, marginBottom: 12,
        border: '1px solid var(--border)',
      }}>
        Interface Name: <span style={{ color: 'var(--blue)' }}>&#123;&#123;INTERFACE_NAME&#125;&#125;</span>
        <br/>
        Version: <span style={{ color: 'var(--blue)' }}>&#123;&#123;VERSION&#125;&#125;</span>{'    '}
        Author: <span style={{ color: 'var(--blue)' }}>&#123;&#123;AUTHOR&#125;&#125;</span>
      </div>
      <p style={{ fontSize: 14, color: 'var(--text2)', lineHeight: 1.65, margin: '0 0 14px' }}>
        Save as .docx and drop it below. ShipBridge reads your placeholders,
        generates a form for each one, and fills them in — every bit of your
        formatting survives. You can use any custom names you want; the download
        below has the full list of tokens ShipBridge already understands.
      </p>
      <button className="btn btn-primary" onClick={onDownloadExample}
        style={{ fontSize: 13.5 }}>
        ⬇ Download starter template
      </button>
      <span style={{ marginLeft: 10, fontSize: 12.5, color: 'var(--text3)' }}>
        A ready-made .docx with every token and syntax notes at the top
      </span>
    </div>
  )
}

function ModeCard({ active, title, desc, onClick }) {
  return (
    <div onClick={onClick} style={{
      flex: 1, padding: '14px 18px', border: `1.5px solid ${active ? 'var(--blue)' : 'var(--border)'}`,
      borderRadius: 10, background: active ? 'var(--blue-bg)' : 'var(--bg2)', cursor: 'pointer',
    }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: active ? 'var(--blue)' : 'var(--text)', marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 13.5, color: 'var(--text3)' }}>{desc}</div>
    </div>
  )
}

// ── Screenshots — placed at {{IMG_*}} slots or appended at the end ─────────
// Never analyzed for facts (locked decision #9): placed as-is, with an
// optional caption. Two placement modes:
//   • assigned to an {{IMG_*}} token → replaces that token in the template
//   • "End of document" → appended after all content, under a category heading
// Mirrors the screenshot-driven sections of the default template, so the
// category a user picks lines up with where the image will land.
const SCREENSHOT_CATEGORIES = [
  'Architecture Diagram', 'Sample Input Payload', 'Message Mapping', 'Groovy Scripts',
  'Output Payload', 'Sender Configuration', 'Receiver Configuration', 'Other',
]

function ScreenshotsSection({ images, setImages, imageTokens = [] }) {
  function addFiles(fileList) {
    const files = [...(fileList || [])].filter(f => f.type.startsWith('image/'))
    files.forEach(async (file) => {
      const { dataUrl, mime, base64 } = await downscaleImage(file)
      setImages(imgs => {
        const used = new Set(imgs.map(i => i.slot).filter(Boolean))
        const freeSlot = imageTokens.find(t => !used.has(t)) || ''
        return [...imgs, {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2),
          category: SCREENSHOT_CATEGORIES[0],
          caption: '',
          slot: freeSlot,
          mime,
          base64,
          preview: dataUrl,
          name: file.name,
        }]
      })
    })
  }
  const update = (id, patch) => setImages(imgs => imgs.map(i => i.id === id ? { ...i, ...patch } : i))
  const remove = (id) => setImages(imgs => imgs.filter(i => i.id !== id))

  return (
    <SectionCard title={`Screenshots${images.length ? ` (${images.length})` : ''}`}>
      <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.6 }}>
        {imageTokens.length > 0
          ? <>This template has {imageTokens.length} image slot{imageTokens.length === 1 ? '' : 's'}: {imageTokens.map(t => <code key={t} style={{ background: 'var(--bg3)', padding: '1px 4px', borderRadius: 3, marginRight: 4 }}>{`{{${t}}}`}</code>)} — assign each screenshot to a slot to place it exactly there, or choose "End of document".</>
          : <>Optional. Attach diagrams or evidence — placed exactly as uploaded, never analyzed for facts. {`To position an image at a specific spot, add a {{IMG_...}} token in your template (Upload Your Own mode); otherwise images are appended at the end under a category heading.`}</>}
      </div>

      {images.map(img => (
        <div key={img.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10, background: 'var(--bg3)' }}>
          <img src={img.preview} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              <select value={img.category} onChange={e => update(img.id, { category: e.target.value })} style={{ fontSize: 13.5 }}>
                {SCREENSHOT_CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
              <select value={img.slot || ''} onChange={e => update(img.id, { slot: e.target.value })} style={{ fontSize: 13.5 }}
                title="Where this image goes in the document">
                <option value="">Placement: End of document</option>
                {imageTokens.map(t => <option key={t} value={t}>{`Place at {{${t}}}`}</option>)}
              </select>
            </div>
            <input value={img.caption} onChange={e => update(img.id, { caption: e.target.value })} placeholder="Caption (optional)" style={{ width: '100%', fontSize: 14 }} />
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{img.name}</div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(img.id)} title="Remove">✕</button>
        </div>
      ))}

      <input id="screenshot-upload" type="file" accept="image/png,image/jpeg,image/gif" multiple style={{ display: 'none' }}
        onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => document.getElementById('screenshot-upload').click()}>
        + Add Screenshot
      </button>
    </SectionCard>
  )
}

// ── Default form — curated with sections and helper text ────────────────
// Implementation steps — unlimited, with a screenshot attachable to each.
//
// Starts at two visible steps because that's the common case; "+ Add step"
// grows the list with no cap. The document template ships four fixed slots,
// but the generator clones the first as a prototype (see expandImplSteps in
// specDocx.js), so the template is no longer the limit.
//
// Each step's screenshot lands directly beneath that step in the document via
// an {{IMPL_IMG_n}} anchor, rather than being dumped at the end.
function ImplementationSteps({ steps, setSteps, images, setImages }) {
  const list = Array.isArray(steps) && steps.length ? steps : ['', '']

  const update = (i, v) => setSteps(list.map((s, j) => (j === i ? v : s)))
  const add = () => setSteps([...list, ''])

  const remove = (i) => {
    setSteps(list.filter((_, j) => j !== i))
    // Images are bound to a step by index, so removing step i means dropping
    // its image and shifting every later image down one — otherwise a
    // screenshot silently reattaches itself to the wrong step.
    setImages(imgs => imgs
      .filter(img => img.stepIndex !== i)
      .map(img => img.stepIndex > i ? { ...img, stepIndex: img.stepIndex - 1 } : img))
  }

  async function attach(i, fileList) {
    const file = [...(fileList || [])].find(f => f.type.startsWith('image/'))
    if (!file) return
    const { dataUrl, mime, base64 } = await downscaleImage(file)
    setImages(imgs => [
      ...imgs.filter(img => img.stepIndex !== i),   // one image per step
      { id: newImageId(), stepIndex: i, base64, mime, preview: dataUrl, name: file.name, caption: '' },
    ])
  }

  return (
    <div style={{ marginTop: 4 }}>
      {list.map((text, i) => {
        const img = images.find(im => im.stepIndex === i)
        return (
          <div key={i} style={{ marginBottom: 12, padding: '11px 12px', border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text2)' }}>Step {i + 1}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <label className="btn btn-ghost btn-sm" style={{ fontSize: 12, cursor: 'pointer' }}>
                  {img ? 'Replace image' : '+ Image'}
                  <input type="file" accept="image/*" hidden
                    onChange={e => { attach(i, e.target.files); e.target.value = '' }} />
                </label>
                {list.length > 1 && (
                  <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, color: 'var(--red)' }}
                    onClick={() => remove(i)}>Remove</button>
                )}
              </div>
            </div>

            <textarea value={text} onChange={e => update(i, e.target.value)} rows={2}
              placeholder="What happens at this step…"
              style={{ width: '100%', padding: '8px 10px', fontSize: 14, resize: 'vertical', fontFamily: 'inherit' }} />

            {img && (
              <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'flex-start' }}>
                <img src={img.preview} alt="" style={{ width: 96, height: 62, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--border)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{img.name}</div>
                  <input value={img.caption} placeholder="Caption (optional)"
                    onChange={e => setImages(imgs => imgs.map(m => m.id === img.id ? { ...m, caption: e.target.value } : m))}
                    style={{ width: '100%', padding: '5px 8px', fontSize: 13 }} />
                </div>
                <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, color: 'var(--red)' }}
                  onClick={() => setImages(imgs => imgs.filter(m => m.id !== img.id))}>×</button>
              </div>
            )}
          </div>
        )
      })}
      <button className="btn btn-ghost btn-sm" onClick={add} style={{ fontSize: 13 }}>+ Add step</button>
    </div>
  )
}

function DefaultForm({ values, setValues, adapters, flow, onGenerate, busyField, implImages, setImplImages }) {
  const sections = [...new Set(DEFAULT_FIELDS.map(f => f.section))]
  return (
    <>
      {sections.map(section => (
        <SectionCard key={section} title={section}>
          {DEFAULT_FIELDS.filter(f => f.section === section).map(f => (
            <Field key={f.key} field={f} value={values[f.key] || ''}
              onChange={v => setValues(vs => ({ ...vs, [f.key]: v }))}
              onGenerate={f.multiline ? () => onGenerate(f.key) : null}
              generateDisabled={!flow}
              generating={busyField === f.key} />
          ))}
          {section === 'Implementation' && (
            <ImplementationSteps
              steps={values.IMPL_STEPS}
              setSteps={next => setValues(vs => ({ ...vs, IMPL_STEPS: next }))}
              images={implImages} setImages={setImplImages} />
          )}
          {section === 'Solution Design' && adapters?.all?.length > 0 && (
            <div style={{ marginTop: 8, padding: '10px 12px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13.5, color: 'var(--text3)' }}>
              <strong style={{ color: 'var(--text2)' }}>Auto-detected from loaded iFlow:</strong><br/>
              Senders: {adapters.senders.map(a => a.type).join(', ') || '—'}<br/>
              Receivers: {adapters.receivers.map(a => a.type).join(', ') || '—'}
            </div>
          )}
        </SectionCard>
      ))}
    </>
  )
}

// ── Uploaded template form — one input per detected token ───────────────
function UploadedForm({ tokens, values, setValues, fieldMeta = {}, describing }) {
  return (
    <SectionCard title={`Fields (${tokens.length})`}>
      {describing && (
        <div style={{ fontSize: 13.5, color: 'var(--blue)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="spinner" style={{ width: 12, height: 12 }} /> Analyzing your template to describe each field…
        </div>
      )}
      {tokens.map(token => {
        const meta = fieldMeta[token] || {}
        const multiline = meta.type === 'long' || (!meta.type && (token.includes('DESCRIPTION') || token.includes('TEXT') || token.includes('BULLET') || token.includes('CONTEXT')))
        return (
          <Field key={token}
            field={{
              label: meta.label || humanizeToken(token),
              key: token,
              multiline,
              help: meta.help || null,
              placeholder: meta.example || '',
            }}
            value={values[token] || ''}
            onChange={v => setValues(vs => ({ ...vs, [token]: v }))} />
        )
      })}
    </SectionCard>
  )
}

function fieldOf(adapter, label) {
  return (adapter?.fields || []).find(f => f.label === label)?.value || ''
}

function humanizeToken(t) {
  return t.split('_').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')
}

// ── Small UI bits ────────────────────────────────────────────────────
function SectionCard({ title, children }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg2)', padding: '18px 20px', marginBottom: 14 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 12px', color: 'var(--blue)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{title}</h2>
      {children}
    </div>
  )
}

function Field({ field, value, onChange, onGenerate, generateDisabled, generating }) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'flex', alignItems: 'center', fontSize: 13.5, fontWeight: 600, color: 'var(--text2)', marginBottom: 4 }}>
        {field.label}
        {onGenerate && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onGenerate} disabled={generating || generateDisabled}
            title={generateDisabled ? 'Load an iFlow first — Generate drafts from real extracted facts, not from nothing' : 'Draft this field from the loaded iFlow\'s real facts (adapters, steps, interface name)'}
            style={{ marginLeft: 'auto', fontSize: 12.5, padding: '2px 10px', opacity: generateDisabled ? 0.45 : 1, cursor: generateDisabled ? 'not-allowed' : 'pointer' }}>
            {generating ? 'Generating…' : '✨ Generate'}
          </button>
        )}
      </span>
      {field.multiline
        ? <textarea value={value} onChange={e => onChange(e.target.value)} rows={3} placeholder={field.placeholder} style={{ width: '100%', resize: 'vertical', fontSize: 14, fontFamily: 'inherit' }} />
        : <input value={value} onChange={e => onChange(e.target.value)} placeholder={field.placeholder} style={{ width: field.width ? `${field.width}px` : '100%', maxWidth: '100%' }} />}
      {field.help && <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 3 }}>{field.help}</div>}
    </label>
  )
}

// ── Overview / Adapters / PD tabs (kept from Layer A) ──────────────────
function Overview({ flow, adapters, pd }) {
  const steps = Object.values(flow.steps || {})
  const stat = (n, l) => (
    <div style={{ flex: 1, minWidth: 110, padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg2)', textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{n}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>{l}</div>
    </div>
  )
  return (
    <div style={{ padding: '20px 24px', maxWidth: 1000 }}>
      <h2 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 4px' }}>{flow.name}</h2>
      <p style={{ fontSize: 14, color: 'var(--text3)', margin: '0 0 16px' }}>Auto-extracted from <span className="mono">{flow.zipName || flow.id}</span></p>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {stat(steps.length, 'Steps')}
        {stat(adapters.senders.length, 'Senders')}
        {stat(adapters.receivers.length, 'Receivers')}
        {stat(pd.calls.length, 'PD calls')}
        {stat(pd.inbound.length, 'PD exposed')}
      </div>
      <div style={{ padding: '12px 14px', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14, color: 'var(--text3)' }}>
        Use the <b>Spec Document</b> tab to fill in details and export a Word document.
      </div>
    </div>
  )
}
function Adapters({ adapters }) {
  const [openId, setOpenId] = useState(adapters.all[0]?.id || null)
  const all = adapters.all
  if (!all.length) return <div style={{ padding: 40, color: 'var(--text3)', fontSize: 14 }}>No adapters found.</div>
  return (
    <div style={{ display: 'flex', minHeight: 0, height: '100%' }}>
      <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '12px 8px' }}>
        {all.map(a => (
          <button key={a.id} onClick={() => setOpenId(a.id)} style={{
            width: '100%', textAlign: 'left', padding: '8px 11px', border: 'none', borderRadius: 7, marginBottom: 2,
            background: openId === a.id ? 'var(--blue-bg)' : 'transparent', cursor: 'pointer', fontFamily: 'inherit',
          }}>
            <div style={{ fontSize: 14, fontWeight: openId === a.id ? 700 : 500, color: openId === a.id ? 'var(--blue)' : 'var(--text)' }}>{a.type}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.direction} · {a.address || '(no address)'}</div>
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {openId && all.find(a => a.id === openId) && (() => {
          const adapter = all.find(a => a.id === openId)
          return (
            <>
              <h2 style={{ fontSize: 18, fontWeight: 700 }}>{adapter.type}</h2>
              <div style={{ fontSize: 13.5, color: 'var(--text3)', marginBottom: 12 }}>{adapter.direction}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <tbody>
                  {adapter.fields.map((f, i) => (
                    <tr key={f.key} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
                      <td style={{ padding: '6px 4px', color: 'var(--text2)', width: '35%', verticalAlign: 'top' }}>{f.label}</td>
                      <td className="mono" style={{ padding: '6px 4px', wordBreak: 'break-all' }}>{f.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        })()}
      </div>
    </div>
  )
}
function PdView({ flow, pd }) {
  return (
    <div style={{ padding: '20px 24px', maxWidth: 900 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg2)', padding: '14px 16px', marginBottom: 12 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--blue)', textTransform: 'uppercase', marginBottom: 8 }}>Exposed PD Endpoints</div>
        {pd.inbound.length === 0 ? <div style={{ fontSize: 14, color: 'var(--text3)' }}>No ProcessDirect endpoints exposed.</div>
          : <ul style={{ margin: 0, paddingLeft: 18 }}>{pd.inbound.map((i, k) => <li key={k} className="mono" style={{ fontSize: 14, color: 'var(--blue)', marginBottom: 3 }}>{i.address}</li>)}</ul>}
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg2)', padding: '14px 16px' }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--blue)', textTransform: 'uppercase', marginBottom: 8 }}>Outgoing PD Calls</div>
        {pd.calls.length === 0 ? <div style={{ fontSize: 14, color: 'var(--text3)' }}>This iFlow makes no ProcessDirect calls.</div>
          : pd.calls.map((c, k) => (
            <div key={k} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="mono" style={{ fontSize: 13.5, color: 'var(--blue)', flex: 1 }}>{c.address}</span>
              {c.resolved
                ? <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--green)' }}>{c.targets.map(t => t.flowName).join(', ')}</span>
                : <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--amber2)' }}>NOT IN PACKAGE</span>}
            </div>
          ))}
      </div>
    </div>
  )
}
