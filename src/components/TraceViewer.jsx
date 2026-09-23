// Real Trace — redesigned viewer.
// Security model unchanged: clientSecret in React state only (session), never persisted.
// Non-secrets (tenantUrl/tokenUrl/clientId) in localStorage for convenience.

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { redactPayload, REDACTION_CATEGORIES } from '../lib/redaction.js'
import { streamAI, renderMd } from '../lib/aiStream.js'

const NONSECRET_KEY = 'shipbridge.cpi.tenant'
const loadNonSecret = () => { try { return JSON.parse(localStorage.getItem(NONSECRET_KEY) || '{}') } catch { return {} } }
const saveNonSecret = (c) => {
  const { tenantUrl, tokenUrl, clientId } = c || {}
  localStorage.setItem(NONSECRET_KEY, JSON.stringify({ tenantUrl, tokenUrl, clientId }))
}

const STATUS = {
  COMPLETED:  { color: 'var(--green)',  label: 'COMPLETED' },
  PROCESSING: { color: 'var(--blue)',   label: 'PROCESSING' },
  FAILED:     { color: '#e0645f',       label: 'FAILED' },
  ESCALATED:  { color: '#e8a54b',       label: 'ESCALATED' },
  RETRY:      { color: '#e8a54b',       label: 'RETRY' },
  CANCELLED:  { color: 'var(--text3)',  label: 'CANCELLED' },
}
const statusOf = (s) => STATUS[s] || { color: 'var(--text3)', label: s || '—' }

export default function TraceViewer({ registry, onUpload, traceSession, setTraceSession }) {
  const [nonSecret, setNonSecret] = useState(loadNonSecret)
  // Secret and connected state live in App so they survive tab switches.
  // Falling back to local state if the props aren't passed keeps the
  // component working standalone (tests, future refactors).
  const [_localSecret, _setLocalSecret] = useState('')
  const [_localConnected, _setLocalConnected] = useState(false)
  const clientSecret = traceSession?.clientSecret ?? _localSecret
  const connected = traceSession?.connected ?? _localConnected
  const setClientSecret = (v) => setTraceSession ? setTraceSession(s => ({ ...s, clientSecret: v })) : _setLocalSecret(v)
  const setConnected = (v) => setTraceSession ? setTraceSession(s => ({ ...s, connected: v })) : _setLocalConnected(v)

  const creds = useMemo(() => ({ ...nonSecret, clientSecret }), [nonSecret, clientSecret])
  const hasCreds = Boolean(creds.tenantUrl && creds.tokenUrl && creds.clientId && creds.clientSecret)

  const [iflowName, setIflowName] = useState('')
  const [messageGuid, setMessageGuid] = useState('')
  const [recent, setRecent] = useState(null)
  const [trace, setTrace] = useState(null)
  const [sel, setSel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [payloadWidth, setPayloadWidth] = useState(() => {
    // Persist the payload pane width so a user's preferred layout survives.
    // Clamp to a sensible range in case a browser returned junk.
    const saved = parseInt(localStorage.getItem('tf_payloadWidth') || '', 10)
    return isFinite(saved) && saved >= 280 && saved <= 1200 ? saved : 480
  })
  useEffect(() => { localStorage.setItem('tf_payloadWidth', String(payloadWidth)) }, [payloadWidth])

  const [payloads, setPayloads] = useState({})
  const [shareSafe, setShareSafe] = useState(false)
  const [redactCats, setRedactCats] = useState(Object.fromEntries(REDACTION_CATEGORIES.map(c => [c.key, true])))

  const matchedFlow = useMemo(() => {
    const name = trace?.mpl?.IntegrationFlowName
    if (!name) return null
    const flows = [...(registry?.values?.() || [])]
    // Normalize for comparison: CPI uses dots (delaware.ap.if_global_process_01),
    // ZIP filenames use underscores, parser IDs use dashes. Strip all three plus
    // case to match regardless of separator convention.
    const norm = (s) => (s || '').toLowerCase().replace(/[._\-\s]/g, '')

    for (const f of flows) {
      if (f.name === name || f.id === name) return f
      // Browsers append suffixes to disambiguate downloaded duplicates:
      //   Health_Checker (1).zip
      //   Health_Checker copy.zip
      //   Health_Checker copy 2.zip
      // CPI knows the flow as "Health_Checker" — strip these before comparing
      // or the match silently fails and step names never resolve.
      const zipStem = (f.zipName || '')
        .replace(/\.zip$/i, '')
        .replace(/\s*\(\d+\)$/, '')          // (1), (2), ...
        .replace(/\s+copy(\s*\d+)?$/i, '')   // copy, copy 2, ...
        .trim()
      if (zipStem && zipStem === name) return f
      // Normalized match: dots vs underscores vs dashes all equivalent
      const nn = norm(name)
      if (norm(f.name) === nn || norm(f.id) === nn || norm(zipStem) === nn) return f
      // Also try the iflw artifact name stored by parser (if present)
      if (f.iflwName && norm(f.iflwName) === nn) return f
    }
    // Log why we didn't match — makes this debuggable without console.log spam
    // when it does match. Only fires when a match is expected but failed.
    if (flows.length > 0) {
      console.log('[match] no flow matched trace name', JSON.stringify(name),
        '— registry has:', flows.map(f => ({ name: f.name, id: f.id, zipName: f.zipName, iflwName: f.iflwName })))
    }
    return null
  }, [trace?.mpl, registry])

  const updateNonSecret = useCallback((patch) => {
    const next = { ...nonSecret, ...patch }
    setNonSecret(next); saveNonSecret(next)
  }, [nonSecret])

  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...creds, ...body }) })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    return data
  }
  async function listRecent() {
    setBusy(true); setErr(null)
    try { setRecent(await api('/api/cpi-trace/list', { iflowName: iflowName || undefined, sinceMinutes: 60, top: 30 })) }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  async function fetchTrace(guid) {
    setBusy(true); setErr(null); setTrace(null); setPayloads({}); setSel(0)
    try { setTrace(await api('/api/cpi-trace/fetch', { messageGuid: guid })) }
    catch (e) { setErr(e.message) }
    setBusy(false)
  }
  // Fetch one step's payload. Three outcomes stored in state so the UI can
  // distinguish them cleanly (loading / empty / body / error):
  //   • { loading: true }              — request in flight
  //   • { text, base64, contentType }  — real body captured
  //   • { empty: true, reason, detail } — CPI recorded the step but has no
  //                                       bytes (end events, adapter-only
  //                                       steps, expired retention). Common
  //                                       and expected — not an error.
  //   • { error: string }              — actual failure worth surfacing
  async function loadPayload(id) {
    if (!id) return
    // Skip if already fetched (including empty/error results — those are answers too)
    if (payloads[id] && !payloads[id].loading) return
    setPayloads(p => ({ ...p, [id]: { loading: true } }))
    try {
      const r = await fetch('/api/cpi-trace/payload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...creds, traceMessageId: id }),
      })
      const data = await r.json().catch(() => ({}))
      // The server tags the two "there is genuinely no body" cases so the UI
      // can explain them instead of dumping CPI's raw XML into the pane.
      // 404 expired-or-empty  → the step never carried a body
      // 403 trace-expired     → the body existed but CPI has already swept it
      if ((r.status === 404 || r.status === 403) &&
          (data.reason === 'expired-or-empty' || data.reason === 'trace-expired')) {
        setPayloads(p => ({ ...p, [id]: { empty: true, reason: data.reason, detail: data.detail } }))
        return
      }
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      const text = decodeIfText(data.base64, data.contentType)
      setPayloads(p => ({ ...p, [id]: { ...data, text } }))
    } catch (e) {
      setPayloads(p => ({ ...p, [id]: { error: e.message } }))
    }
  }

  // Which steps in this run actually captured headers / exchange properties.
  // CPI attaches them to particular steps (usually the adapter-processing
  // ones), so an empty tab on some other step is normal — the UI uses this to
  // point at where the data really is instead of showing a dead end.
  const elsewhere = useMemo(() => {
    const list = trace?.traceMessages || []
    const pick = (key) => list
      .map((s, index) => ({ index, count: (s[key] || []).length, step: s }))
      .filter(x => x.count > 0)
      .map(x => ({
        index: x.index,
        count: x.count,
        label: stepLabel(x.step, matchedFlow?.steps?.[x.step.ModelStepId], x.index),
      }))
    return {
      msgHeaders: pick('MessageHeaders'),
      headers: pick('Headers'),
      props: pick('ExchangeProperties'),
    }
  }, [trace, matchedFlow])

  // ── Item 1: auto-load every step's payload as soon as a trace opens ──────
  // Fires all fetches in parallel — CPI handles concurrent trace reads fine
  // for a single run — so by the time the user clicks any step, its body (or
  // its honest "no body captured" note) is already there. No more per-step
  // "Load from CPI" clicks. Steps with no TraceId are skipped entirely.
  useEffect(() => {
    if (!trace?.traceMessages?.length) return
    const ids = [...new Set(trace.traceMessages.map(s => s.TraceId).filter(Boolean))]
    for (const id of ids) loadPayload(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace])

  // ── AI: explain a step, or the whole run ─────────────────────────────────
  // Grounded in real facts only (locked decision #1). Payloads are redacted
  // before they leave the browser whenever Share-safe is on — an AI call is an
  // export, so the same rule applies as for the Markdown report.
  const [explaining, setExplaining] = useState(false)
  const [explanation, setExplanation] = useState(null)
  const [explainScope, setExplainScope] = useState(null)  // 'step' | 'run'
  const [explainErr, setExplainErr] = useState(null)
  const abortRef = useRef(null)
  const autoExplained = useRef(new Set())   // steps we've already auto-explained

  const scrub = useCallback(
    (t) => (t && shareSafe) ? redactPayload(t, redactCats) : t,
    [shareSafe, redactCats])

  async function runExplain(body, scope) {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setExplaining(true); setExplanation(''); setExplainErr(null); setExplainScope(scope)
    try {
      await streamAI('/api/cpi-trace/explain', body, setExplanation, ctrl.signal)
    } catch (e) {
      if (e.name !== 'AbortError') setExplainErr(e.message)
    } finally {
      if (abortRef.current === ctrl) { setExplaining(false); abortRef.current = null }
    }
  }

  function explainStep(step, i, question) {
    const design = matchedFlow?.steps?.[step.ModelStepId] || null
    const before = scrub(payloads[step.TraceId]?.text)
    // The next step's payload IS this step's output — that's what lets the AI
    // say what actually changed, rather than just describing the input.
    const next = (trace?.traceMessages || []).slice(i + 1).find(s => s.TraceId)
    const after = scrub(payloads[next?.TraceId]?.text)
    return runExplain({
      mode: 'step', step, design,
      payloadBefore: before, payloadAfter: after,
      flowName: trace?.mpl?.IntegrationFlowName,
      question,
    }, 'step')
  }

  function explainRun(question) {
    const list = (trace?.traceMessages || []).map(s => {
      const d = matchedFlow?.steps?.[s.ModelStepId]
      return {
        ...s,
        __designName: d?.name || null,
        __designKind: d?.kind || d?.type || null,
        __payload: scrub(payloads[s.TraceId]?.text) || null,
      }
    })
    return runExplain({
      mode: 'run', steps: list,
      designs: matchedFlow ? '(iFlow ZIP loaded — step names and kinds included per step)' : null,
      flowName: trace?.mpl?.IntegrationFlowName,
      question,
    }, 'run')
  }

  // Auto-explain a failed step: if the user clicks a step that errored, they
  // want to know why — making them click again is pure friction. Once per step.
  useEffect(() => {
    const s = (trace?.traceMessages || [])[sel]
    if (!s?.Error) return
    const key = `${s.RunId}:${s.ChildCount}`
    if (autoExplained.current.has(key)) return
    autoExplained.current.add(key)
    explainStep(s, sel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, trace])

  // Clear the explanation when the selected step changes — a stale explanation
  // shown against a different step would be actively misleading.
  useEffect(() => {
    const s = (trace?.traceMessages || [])[sel]
    if (s?.Error) return          // the auto-explain effect handles this one
    abortRef.current?.abort()
    setExplanation(null); setExplainErr(null); setExplaining(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel])

  // ═══════════ CONNECT SCREEN ═══════════
  if (!connected || !hasCreds) {
    return (
      // `safe center` on alignItems: flex still centers the card vertically
      // when there's room, but falls back to top-alignment when the card is
      // taller than the viewport. Without `safe`, flex distributes overflow
      // equally to both ends — the top overflow ends up hidden behind the
      // shell bar and is unreachable by scroll. `overflow: auto` handles the
      // scrollable-tall case.
      <div style={{ flex: 1, display: 'flex', alignItems: 'safe center', justifyContent: 'center', padding: 24, overflow: 'auto' }}>
        <div style={{ width: '100%', maxWidth: 560 }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--blue-bg)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, marginBottom: 14 }}>🛰</div>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: '0 0 6px' }}>Connect to CPI</h1>
            <p style={{ fontSize: 14.5, color: 'var(--text3)', margin: 0 }}>Paste the 4 values from your BTP service key (api plan).</p>
          </div>

          <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16, padding: '24px 26px', boxShadow: 'var(--shadow-md)' }}>
            <CredInput label="Tenant URL" hint="the API host — no -rt suffix" placeholder=""
              value={nonSecret.tenantUrl} onChange={v => updateNonSecret({ tenantUrl: v })}/>
            <CredInput label="Token URL" placeholder=""
              value={nonSecret.tokenUrl} onChange={v => updateNonSecret({ tokenUrl: v })}/>
            <CredInput label="Client ID" value={nonSecret.clientId} onChange={v => updateNonSecret({ clientId: v })}/>
            <CredInput label="Client Secret" secret value={clientSecret} onChange={setClientSecret}
              hint="session only — cleared on refresh, never saved"/>
            <button className="btn btn-primary" disabled={!hasCreds} onClick={() => setConnected(true)}
              style={{ width: '100%', justifyContent: 'center', marginTop: 6, padding: '11px 0', fontSize: 15.5 }}>
              Connect →
            </button>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text3)', textAlign: 'center', marginTop: 14, lineHeight: 1.6 }}>
            Credentials go only to your own server, which calls your own tenant.<br/>Nothing is stored server-side.
          </p>
        </div>
      </div>
    )
  }

  // ═══════════ SEARCH SCREEN (no trace loaded) ═══════════
  if (!trace) {
    return (
      <div style={{ flex: 1, overflow: 'auto' }}>
        <TopBar creds={creds} onDisconnect={() => { setConnected(false); setClientSecret('') }} shareSafe={shareSafe} setShareSafe={setShareSafe}/>
        <div style={{ maxWidth: 780, margin: '0 auto', padding: '36px 24px' }}>

          <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 6px' }}>Pick a message to trace</h1>
          <p style={{ fontSize: 14.5, color: 'var(--text3)', margin: '0 0 26px' }}>Fire a message at your iFlow (with Trace log level ON), then find it here.</p>

          {/* iFlow ZIP — upload here so step names resolve when the trace opens */}
          <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px' }}>
            <div style={{ flex: 1 }}>
              <div style={microLabel}>IFLOW ZIP</div>
              <div style={{ fontSize: 13.5, color: 'var(--text3)', lineHeight: 1.5 }}>
                {registry?.size ? (
                  <>{registry.size} iFlow{registry.size > 1 ? 's' : ''} loaded: {[...registry.values()].map(f => f.zipName || f.name).join(', ')}</>
                ) : (
                  <>Upload your iFlow ZIP so the trace shows real step names instead of model IDs like CallActivity_5.</>
                )}
              </div>
            </div>
            {onUpload && (
              <label className="btn btn-ghost" style={{ cursor: 'pointer', fontSize: 13.5, flexShrink: 0 }}>
                + Upload ZIP
                <input type="file" accept=".zip" multiple hidden
                  onChange={e => { onUpload(e.target.files); e.target.value = '' }} />
              </label>
            )}
          </div>

          {/* MessageGuid direct */}
          <div style={cardStyle}>
            <div style={microLabel}>FETCH BY MESSAGEGUID</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <input value={messageGuid} onChange={e => setMessageGuid(e.target.value)} placeholder=""
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 14, padding: '10px 14px' }}
                onKeyDown={e => e.key === 'Enter' && messageGuid.trim() && fetchTrace(messageGuid.trim())}/>
              <button className="btn btn-primary" onClick={() => fetchTrace(messageGuid.trim())} disabled={busy || !messageGuid.trim()}>
                {busy ? '…' : 'Fetch'}
              </button>
            </div>
          </div>

          {/* Recent list */}
          <div style={cardStyle}>
            <div style={microLabel}>RECENT MESSAGES · LAST 60 MIN</div>
            <div style={{ display: 'flex', gap: 10, marginBottom: recent ? 16 : 0 }}>
              <input value={iflowName} onChange={e => setIflowName(e.target.value)} placeholder="Filter by iFlow name (optional)"
                style={{ flex: 1, padding: '10px 14px' }}/>
              <button className="btn btn-ghost" onClick={listRecent} disabled={busy}>{busy ? 'Loading…' : 'Refresh'}</button>
            </div>
            {recent && recent.messages.length === 0 && (
              <div style={{ padding: '22px 0', textAlign: 'center', fontSize: 14, color: 'var(--text3)' }}>
                No messages in the last hour. Fire one at your iFlow first.
              </div>
            )}
            {recent && recent.messages.map(m => {
              const st = statusOf(m.Status)
              return (
                <div key={m.MessageGuid} onClick={() => { setMessageGuid(m.MessageGuid); fetchTrace(m.MessageGuid) }}
                  className="trace-row"
                  style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 14px', borderRadius: 10, cursor: 'pointer', border: '1px solid var(--border)', marginBottom: 8, background: 'var(--bg)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: st.color, flexShrink: 0 }}/>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.IntegrationFlowName || '(unnamed flow)'}</div>
                    <div className="mono" style={{ fontSize: 12.5, color: 'var(--text3)' }}>{m.MessageGuid}</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.04em', color: st.color }}>{st.label}</span>
                  <span style={{ fontSize: 13, color: 'var(--text3)', flexShrink: 0 }}>{formatDate(m.LogStart)}</span>
                </div>
              )
            })}
          </div>

          {err && <ErrorCard err={err}/>}
        </div>
      </div>
    )
  }

  // ═══════════ TRACE VIEW ═══════════
  const steps = trace.traceMessages || []
  const step = steps[sel]
  const mpl = trace.mpl || {}
  const mplStatus = statusOf(mpl.Status || mpl.MessageProcessingState)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <TopBar creds={creds} onDisconnect={() => { setConnected(false); setClientSecret('') }} shareSafe={shareSafe} setShareSafe={setShareSafe}>
        <button className="btn btn-ghost btn-sm" onClick={() => { setTrace(null); setRecent(null) }}>← Messages</button>
        <div style={{ width: 1, height: 20, background: 'var(--border)' }}/>
        <span style={{ fontSize: 14.5, fontWeight: 700 }}>{mpl.IntegrationFlowName}</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: mplStatus.color, padding: '3px 10px', borderRadius: 20, background: `color-mix(in srgb, ${mplStatus.color} 14%, transparent)` }}>{mplStatus.label}</span>
        <span style={{ fontSize: 13, color: 'var(--text3)' }}>{durationMs(mpl)}</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text3)' }} title={mpl.MessageGuid}>{(mpl.MessageGuid || '').slice(0, 12)}…</span>
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
          onClick={() => explainRun()} disabled={explaining}
          title="Explain the whole run — what happened, where the time went, what to look at">
          {explaining && explainScope === 'run' ? 'Thinking…' : '✨ Explain run'}
        </button>
        <button className="btn btn-ghost btn-sm"
          onClick={() => exportReport({ trace, matchedFlow, payloads, shareSafe, redactCats })}>⬇ Report</button>
      </TopBar>

      {trace.noRunData ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 460, textAlign: 'center' }}>
            <div style={{ fontSize: 38, marginBottom: 12, opacity: .5 }}>📡</div>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 8px' }}>No run data</h2>
            <p style={{ fontSize: 14.5, color: 'var(--text3)', lineHeight: 1.7 }}>
              CPI returned no run steps for this message. Trace data is discarded after about an hour — if this message is older than that, its steps are gone. Set the iFlow's log level to <b>Trace</b> (Monitor → Manage Integration Content → Set Log Level) and fire a fresh message.
            </p>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Flow structure diagram — from the uploaded iFlow ZIP */}
          {matchedFlow && <FlowDiagram flow={matchedFlow} />}

          {/* Cross-step change summary — deterministic scan of what each
              step changed (headers set, body transformed, properties added).
              Not AI; purely data extraction. Collapsed by default. */}
          <RunChangeSummary steps={trace.traceMessages || []} payloads={payloads} matchedFlow={matchedFlow} />

          {/* Whole-run AI explanation sits above the panes — about the run, not a step */}
          {explainScope === 'run' && (explaining || explanation || explainErr) && (
            <div style={{ padding: '14px 18px 0', flexShrink: 0 }}>
              <AiPanel text={explanation} busy={explaining} error={explainErr} shareSafe={shareSafe}
                scope="run" onAsk={(q) => explainRun(q)} onStop={() => abortRef.current?.abort()}
                onDismiss={() => { setExplanation(null); setExplainErr(null); setExplainScope(null) }} />
            </div>
          )}
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `300px 1fr 6px ${payloadWidth}px`, minHeight: 0 }}>
          {/* TIMELINE */}
          <div style={{ borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '18px 0' }}>
            {trace.traceForbidden && (
              <div style={{ margin: '0 16px 14px', padding: '10px 12px', border: '1px solid #7d5a3a', borderRadius: 8, background: 'rgba(184,133,77,.10)', fontSize: 13, color: 'var(--text3)', lineHeight: 1.6 }}>
                <b style={{ color: '#e8a54b' }}>Trace data forbidden (403).</b> Steps loaded, but your service key isn't allowed to read trace payloads. Add the <b>TraceConfigurationRead</b> role (and keep <b>MonitoringDataRead</b>) to the service key on the <b>api</b> plan, then reconnect.
              </div>
            )}
            {trace.traceWasOff && (
              <div style={{ margin: '0 16px 14px', padding: '10px 12px', border: '1px solid var(--border2)', borderRadius: 8, background: 'var(--bg3)', fontSize: 13, color: 'var(--text3)', lineHeight: 1.6 }}>
                <b style={{ color: 'var(--text2)' }}>Steps only, no payloads.</b> This message ran at <b>Info</b> log level, so CPI captured the step timeline but not the message bodies. Set log level to <b>Trace</b> and re-fire to capture payloads.
              </div>
            )}
            <div style={{ ...microLabel, padding: '0 20px', marginBottom: 12 }}>EXECUTION · {steps.length} STEPS</div>
            {steps.map((s, i) => {
              const st = statusOf(s.Status || s.MessageProcessingResult)
              const active = i === sel
              const design = matchedFlow?.steps?.[s.ModelStepId]
              return (
                <div key={s.TraceId || s.Id || i} onClick={() => setSel(i)}
                  style={{ display: 'flex', gap: 12, padding: '0 20px', cursor: 'pointer', position: 'relative' }}>
                  {/* connector line + dot */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 14, flexShrink: 0 }}>
                    <div style={{ width: 2, flex: i === 0 ? '0 0 6px' : '0 0 6px', background: i === 0 ? 'transparent' : 'var(--border)' }}/>
                    <div style={{ width: active ? 13 : 9, height: active ? 13 : 9, borderRadius: '50%', background: st.color, border: active ? `3px solid color-mix(in srgb, ${st.color} 30%, transparent)` : 'none', flexShrink: 0, transition: 'all .15s' }}/>
                    <div style={{ width: 2, flex: 1, background: i === steps.length - 1 ? 'transparent' : 'var(--border)' }}/>
                  </div>
                  <div style={{ flex: 1, padding: '6px 10px', marginBottom: 4, borderRadius: 9, background: active ? 'var(--blue-bg)' : 'transparent', minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: active ? 750 : 550, color: active ? 'var(--blue)' : 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {stepLabel(s, design, i)}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text3)', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {design && <span>{design.kind || design.type}</span>}
                      {!design && s.ModelStepId && <span className="mono">{s.ModelStepId}</span>}
                      {durationMs(s) && <span>{durationMs(s)}</span>}
                      <span style={{ color: st.color, fontWeight: 700 }}>{st.label}</span>
                      <StepBadges step={s} payload={payloads[s.TraceId]} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* STEP DETAIL */}
          <div style={{ overflowY: 'auto', padding: '22px 26px' }}>
            {step ? (() => {
              // For the diff tab: find the nearest previous step that has an
              // actual loaded body — end events and adapter-only steps in
              // between get skipped so "before" is a meaningful comparison,
              // not an empty capture.
              const currBody = payloads[step.TraceId]
              let prev = null
              for (let j = sel - 1; j >= 0; j--) {
                const p = trace.traceMessages[j]
                const pb = payloads[p.TraceId]
                if (pb?.text != null && !pb.empty && !pb.error) { prev = { step: p, payload: pb }; break }
              }
              return (
                <StepDetail step={step} mpl={mpl} design={matchedFlow?.steps?.[step.ModelStepId]}
                  currBody={currBody} prevBody={prev}
                  onExplain={() => explainStep(step, sel)}
                  onAsk={(q) => explainStep(step, sel, q)}
                  onStop={() => abortRef.current?.abort()}
                  explaining={explaining} explanation={explanation}
                  explainErr={explainErr} explainScope={explainScope}
                  shareSafe={shareSafe} redactCats={redactCats}
                  elsewhere={elsewhere} onJump={(i) => setSel(i)} onUpload={onUpload}
                  onDismiss={() => { setExplanation(null); setExplainErr(null); setExplainScope(null) }}/>
              )
            })() : <div style={{ color: 'var(--text3)', fontSize: 14 }}>Select a step.</div>}
          </div>

          {/* Drag handle to resize the payload pane. onMouseDown attaches
              window listeners so drag continues even when the cursor moves
              off the 6px handle; the listeners remove themselves on mouseup. */}
          <div onMouseDown={(e) => {
              e.preventDefault()
              const startX = e.clientX
              const startW = payloadWidth
              const move = (ev) => {
                const w = Math.min(1200, Math.max(280, startW - (ev.clientX - startX)))
                setPayloadWidth(w)
              }
              const up = () => {
                window.removeEventListener('mousemove', move)
                window.removeEventListener('mouseup', up)
                document.body.style.cursor = ''
                document.body.style.userSelect = ''
              }
              document.body.style.cursor = 'col-resize'
              document.body.style.userSelect = 'none'
              window.addEventListener('mousemove', move)
              window.addEventListener('mouseup', up)
            }}
            style={{ cursor: 'col-resize', background: 'var(--border)', position: 'relative' }}
            title="Drag to resize the payload pane"
          >
            <div style={{ position: 'absolute', top: 0, bottom: 0, left: -2, right: -2 }}/>
          </div>

          {/* PAYLOAD */}
          <div style={{ borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <PayloadPane step={step} payloads={payloads} onLoad={loadPayload}
              shareSafe={shareSafe} redactCats={redactCats} setRedactCats={setRedactCats}/>
          </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════ pieces ═══════════

function TopBar({ creds, onDisconnect, shareSafe, setShareSafe, children }) {
  return (
    <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg2)', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 10 }}>
      {children || (
        <>
          <span style={{ fontSize: 15, fontWeight: 800 }}>Real Trace</span>
          <span className="mono" style={{ fontSize: 12.5, color: 'var(--text3)' }}>{host(creds.tenantUrl)}</span>
        </>
      )}
      {!children && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        <ShareToggle on={shareSafe} onChange={setShareSafe}/>
        <button className="btn btn-ghost btn-sm" onClick={onDisconnect}>Disconnect</button>
      </div>}
      {children && <>
        <ShareToggle on={shareSafe} onChange={setShareSafe}/>
        <button className="btn btn-ghost btn-sm" onClick={onDisconnect}>Disconnect</button>
      </>}
    </div>
  )
}

function StepDetail({ step, mpl, design, currBody, prevBody, onExplain, explaining, explanation, explainErr, explainScope, shareSafe, redactCats, onAsk, onStop, onDismiss, elsewhere, onJump, onUpload }) {
  const st = statusOf(step.Status || step.MessageProcessingResult)
  const error = step.Error || step.ErrorInformation
  // Two different things, and conflating them is what made this confusing:
  //   msgHeaders — Camel message state; what a Content Modifier / script sets
  //   httpHeaders — HTTP transport headers, only recorded at adapter steps
  const msgHeaders = step.MessageHeaders || []
  const httpHeaders = step.Headers || []
  const exProps = step.ExchangeProperties || []
  const activities = step.Activities || []
  const [tab, setTab] = useState('overview')

  // Diff is only meaningful when THIS step has a body and there's a previous
  // step-with-body to compare it against. Skip the tab otherwise so it doesn't
  // sit there teasing the user with something they can't click.
  const hasDiff = Boolean(currBody?.text != null && !currBody.empty && !currBody.error && prevBody?.payload?.text != null)

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'msgheaders', label: `Message Headers${msgHeaders.length ? ` (${msgHeaders.length})` : ''}` },
    { id: 'props', label: `Exchange Properties${exProps.length ? ` (${exProps.length})` : ''}` },
    { id: 'headers', label: `HTTP Headers${httpHeaders.length ? ` (${httpHeaders.length})` : ''}` },
    { id: 'activities', label: `Activities${activities.length ? ` (${activities.length})` : ''}` },
    hasDiff ? { id: 'diff', label: 'Diff vs prev' } : null,
  ].filter(Boolean)

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <h2 style={{ fontSize: 19, fontWeight: 800, margin: 0 }}>{stepLabel(step, design, 0)}</h2>
          <span style={{ fontSize: 12, fontWeight: 800, color: st.color, padding: '3px 10px', borderRadius: 20, background: `color-mix(in srgb, ${st.color} 14%, transparent)` }}>{st.label}</span>
          <button className="btn btn-ghost btn-sm" onClick={onExplain} disabled={explaining}
            style={{ marginLeft: 'auto', fontSize: 13, whiteSpace: 'nowrap' }}
            title={shareSafe ? 'Payloads are redacted before being sent' : 'Explain this step using the real trace data and iFlow design'}>
            {explaining ? 'Thinking…' : '✨ Explain'}
          </button>
        </div>
        <div style={{ fontSize: 14, color: 'var(--text3)' }}>
          {design?.kind || design?.type || 'Runtime step'}
          {durationMs(step) ? ` · ${durationMs(step)}` : ''}
          {step.Activity ? ` · ${step.Activity}` : ''}
        </div>
        {step.Description && <div style={{ fontSize: 13.5, color: 'var(--text2)', marginTop: 4, fontStyle: 'italic' }}>{step.Description}</div>}
        {!design && step.ModelStepId && (
          <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 6, lineHeight: 1.5 }}>
            CPI's API only returns the model ID (<code>{step.ModelStepId}</code>) — it has no step names.{' '}
            {onUpload ? (
              <label style={{ color: 'var(--blue)', cursor: 'pointer', fontWeight: 600 }}>
                Upload the iFlow ZIP
                <input type="file" accept=".zip" hidden onChange={e => { onUpload(e.target.files); e.target.value = '' }} />
              </label>
            ) : 'Upload the iFlow ZIP on the main screen'} to resolve real names and design config.
          </div>
        )}
      </div>

      <AiPanel text={explanation} busy={explaining} error={explainErr} shareSafe={shareSafe}
        scope={explainScope} onAsk={onAsk} onStop={onStop}
        onDismiss={onDismiss} />

      {error && (
        <div style={{ padding: '14px 16px', borderRadius: 12, background: 'color-mix(in srgb, #e0645f 10%, transparent)', border: '1px solid color-mix(in srgb, #e0645f 35%, transparent)', marginBottom: 18 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: '#e0645f', letterSpacing: '.05em', marginBottom: 6 }}>ERROR</div>
          <div className="mono" style={{ fontSize: 14, lineHeight: 1.6, wordBreak: 'break-word' }}>{error}</div>
        </div>
      )}

      {/* Tabs — mirrors CPI's own Header / Exchange Properties / Payload split */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', marginBottom: 14 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '7px 12px', border: 'none', background: 'transparent', cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13.5, fontWeight: tab === t.id ? 750 : 550,
            color: tab === t.id ? 'var(--blue)' : 'var(--text3)',
            borderBottom: tab === t.id ? '2px solid var(--blue)' : '2px solid transparent', marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <InfoGrid rows={[
          ['Model Step ID', step.ModelStepId, true],
          ['Step ID', step.StepId, true],
          ['Activity', step.Activity],
          ['Branch', step.BranchId],
          ['Started', formatDate(step.StepStart)],
          ['Ended', formatDate(step.StepStop)],
          ['Duration', durationMs(step)],
          ['Trace ID', step.TraceId, true],
          ['MessageGuid', mpl.MessageGuid, true],
        ]}/>
      )}

      {tab === 'msgheaders' && (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 8, lineHeight: 1.55 }}>
            The message's own headers as they stood at this step — what a Content Modifier,
            script or mapping sets.
          </div>
          <PropTable rows={msgHeaders} empty="No message headers recorded at this step."
            elsewhere={elsewhere?.msgHeaders} onJump={onJump} kind="message headers" />
        </>
      )}
      {tab === 'headers' && (
        <>
          <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 8, lineHeight: 1.55 }}>
            HTTP transport headers on the adapter call — not the message's own headers.
            CPI records these only at adapter-processing steps.
          </div>
          <PropTable rows={httpHeaders} empty="No HTTP headers captured at this step."
            elsewhere={elsewhere?.headers} onJump={onJump} kind="HTTP headers" />
        </>
      )}
      {tab === 'props'   && <PropTable rows={exProps} empty="No exchange properties captured at this step."
        elsewhere={elsewhere?.props} onJump={onJump} kind="exchange properties" />}
      {tab === 'activities' && <ActivityList rows={activities} empty="No sub-activity breakdown captured at this step." />}
      {tab === 'diff' && hasDiff && (
        <PayloadDiff
          before={prevBody.payload.text} beforeLabel={stepLabel(prevBody.step, null, 0) + (prevBody.step.ModelStepId ? ` (${prevBody.step.ModelStepId})` : '')}
          after={currBody.text} afterLabel={stepLabel(step, design, 0) + (step.ModelStepId ? ` (${step.ModelStepId})` : '')}
          shareSafe={shareSafe} redactCats={redactCats}
        />
      )}

      {design && tab === 'overview' && (
        <div style={{ marginTop: 20, padding: '16px 18px', borderRadius: 12, background: 'var(--bg3)', border: '1px solid var(--border)' }}>
          <div style={{ ...microLabel, marginBottom: 10 }}>FROM IFLOW DESIGN</div>
          <InfoGrid rows={[
            ['Type', design.kind || design.type],
            ['Script', design.config?.scriptRef, true],
            ['Mapping', design.config?.mappingRef, true],
            ['XSLT', design.config?.xsltRef, true],
            ['Adapter', design.config?.adapterType],
            ['Address', design.config?.address, true],
          ]}/>
        </div>
      )}
    </>
  )
}

function PayloadPane({ step, payloads, onLoad, shareSafe, redactCats, setRedactCats }) {
  const id = step?.TraceId || step?.Id
  const data = id ? payloads[id] : null
  const text = data?.text
  const [pretty, setPretty] = useState(true)
  const display = useMemo(() => {
    let d = (!text || !shareSafe) ? text : redactPayload(text, redactCats)
    if (d && pretty) d = prettify(d)
    return d
  }, [text, shareSafe, redactCats, pretty])

  return (
    <>
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={microLabel}>PAYLOAD</span>
        {id && !data && <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => onLoad(id)}>Load from CPI</button>}
        {text != null && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }}
              onClick={() => setPretty(p => !p)}>{pretty ? 'Raw' : 'Beautify'}</button>
            <button className="btn btn-ghost btn-sm" style={{ fontSize: 12 }}
              onClick={() => navigator.clipboard?.writeText(display || '')}>Copy</button>
          </div>
        )}
        {shareSafe && <span style={{ marginLeft: text != null ? 0 : 'auto', fontSize: 12, fontWeight: 700, color: '#e8a54b' }}>REDACTED</span>}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '14px 18px' }}>
        {!id && step && <Hint>No payload captured at this step. CPI only stores message bodies when the iFlow runs at <b>Trace</b> log level (and keeps them ~1 hour).</Hint>}
        {!id && !step && <Hint>Select a step.</Hint>}
        {id && !data && <Hint>Click "Load from CPI" to fetch this step's payload.</Hint>}
        {data?.empty && <Hint>{data.detail || 'Payload no longer available — trace retention (~1 hour) has expired. Fire a fresh message with Trace on to capture new payloads.'}</Hint>}
        {data?.error && <div style={{ fontSize: 14, color: '#e0645f', lineHeight: 1.6 }}>{data.error}</div>}
        {text != null && <pre style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{display}</pre>}
        {data && text == null && !data.error && !data.empty && <Hint>Binary · {data.sizeBytes} bytes · {data.contentType}</Hint>}
      </div>
      {shareSafe && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 18px', maxHeight: 180, overflowY: 'auto' }}>
          <div style={{ ...microLabel, marginBottom: 8 }}>MASKING</div>
          {REDACTION_CATEGORIES.map(cat => (
            <label key={cat.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, marginBottom: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={!!redactCats[cat.key]} onChange={e => setRedactCats({ ...redactCats, [cat.key]: e.target.checked })}/>
              {cat.label}
            </label>
          ))}
        </div>
      )}
    </>
  )
}

// Name/value table for step headers and exchange properties. These lists run
// long (30+ rows is normal in CPI), so it's filterable. Values are shown
// verbatim as extracted from CPI — never interpreted or reformatted.
function PropTable({ rows, empty, elsewhere, onJump, kind }) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    if (!q.trim()) return rows
    const needle = q.toLowerCase()
    return rows.filter(r =>
      String(r.name).toLowerCase().includes(needle) ||
      String(r.value).toLowerCase().includes(needle))
  }, [rows, q])

  if (!rows?.length) {
    // CPI attaches headers and exchange properties to particular steps —
    // typically the adapter-processing ones — not to every step in the run.
    // An empty tab therefore looks like a bug when it isn't, so point at the
    // steps that DID capture this data rather than leaving a dead end.
    return (
      <div>
        <Hint>{empty}</Hint>
        {elsewhere?.length > 0 && (
          <div style={{ marginTop: 10, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 9, background: 'var(--bg3)', fontSize: 13, color: 'var(--text3)', lineHeight: 1.6 }}>
            CPI records {kind} against specific steps rather than all of them. In this run,
            {elsewhere.length === 1 ? ' it was captured at:' : ' they were captured at:'}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 7 }}>
              {elsewhere.map(e => (
                <button key={e.index} onClick={() => onJump?.(e.index)}
                  style={{ fontSize: 12.5, padding: '3px 9px', borderRadius: 20, cursor: 'pointer',
                           border: '1px solid var(--blue)', background: 'var(--blue-bg)',
                           color: 'var(--blue)', fontFamily: 'inherit', fontWeight: 600 }}>
                  {e.index + 1}. {e.label} ({e.count})
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={`Filter ${rows.length} entries…`}
        style={{ width: '100%', padding: '7px 10px', fontSize: 13.5, marginBottom: 10 }}/>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
        {filtered.map((r, i) => (
          <div key={r.name + i} style={{
            display: 'grid', gridTemplateColumns: 'minmax(110px, 36%) 1fr', gap: 12,
            padding: '8px 12px', borderBottom: i === filtered.length - 1 ? 'none' : '1px solid var(--border)',
            background: i % 2 ? 'var(--bg3)' : 'transparent', fontSize: 13.5,
          }}>
            <div className="mono" style={{ color: 'var(--text2)', fontWeight: 600, wordBreak: 'break-word', display: 'flex', alignItems: 'center', gap: 6 }}>
              {r.dir && (
                <span title={r.dir === 'request' ? 'Sent in the request' : 'Received in the response'}
                  style={{ fontSize: 11, fontWeight: 800, padding: '1px 5px', borderRadius: 4, color: r.dir === 'request' ? 'var(--blue)' : '#8db8f0', background: r.dir === 'request' ? 'var(--blue-bg)' : 'color-mix(in srgb, #8db8f0 14%, transparent)', flexShrink: 0 }}>
                  {r.dir === 'request' ? '→ REQ' : '← RES'}
                </span>
              )}
              {r.name}
            </div>
            <div className="mono" style={{ color: 'var(--text)', wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
              {String(r.value) || <span style={{ color: 'var(--text3)' }}>(empty)</span>}
            </div>
          </div>
        ))}
        {!filtered.length && <div style={{ padding: '14px 12px', fontSize: 13.5, color: 'var(--text3)' }}>No match for "{q}".</div>}
      </div>
    </div>
  )
}

// Streamed AI output. Clearly marked as AI and visually distinct from the
// extracted facts around it — that separation is what makes the rest of the
// tool trustworthy.
function AiPanel({ text, busy, error, shareSafe, scope, onAsk, onStop, onDismiss }) {
  const blocks = useMemo(() => renderMd(text), [text])
  const [customQ, setCustomQ] = useState('')
  if (!busy && !text && !error) return null

  const followUps = scope === 'run'
    ? ['Where did the time go?', 'Anything suspicious?']
    : ['Why did this take so long?', 'What exactly changed here?', 'Explain the payload line by line']

  return (
    <div style={{ marginBottom: 16, padding: '13px 15px', borderRadius: 12, border: '1px solid var(--blue)', background: 'var(--blue-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ ...microLabel, color: 'var(--blue)' }}>
          AI · {scope === 'run' ? 'WHOLE RUN' : 'THIS STEP'}
        </span>
        {shareSafe && <span style={{ fontSize: 11, fontWeight: 800, color: '#e8a54b' }}>REDACTED</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {busy && <button className="btn btn-ghost btn-sm" style={{ fontSize: 12.5 }} onClick={onStop}>Stop</button>}
          {!busy && onDismiss && <button className="btn btn-ghost btn-sm" style={{ fontSize: 12.5 }} onClick={onDismiss}>✕ Close</button>}
        </div>
      </div>

      {error ? (
        <div style={{ fontSize: 14, color: '#e0645f', lineHeight: 1.6 }}>{error}</div>
      ) : (
        <>
          <div style={{ fontSize: 14, lineHeight: 1.75 }}>
            {blocks.map((b, i) => {
              const content = b.parts.map((p, j) =>
                p.bold ? <strong key={j}>{p.text}</strong>
                : p.code ? <code key={j} style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 4, fontSize: 13 }}>{p.text}</code>
                : <span key={j}>{p.text}</span>)
              if (b.type === 'h') return <div key={i} style={{ fontWeight: 750, color: 'var(--text)', marginTop: i ? 12 : 0, marginBottom: 3 }}>{content}</div>
              if (b.type === 'li') return <div key={i} style={{ display: 'flex', gap: 7, marginBottom: 3 }}><span style={{ color: 'var(--blue)', flexShrink: 0 }}>•</span><span>{content}</span></div>
              return <div key={i} style={{ marginBottom: 6 }}>{content}</div>
            })}
            {busy && <span style={{ display: 'inline-block', width: 7, height: 13, background: 'var(--blue)', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'sb-blink 1s step-end infinite' }}/>}
          </div>

          {/* Follow-ups + free-text question */}
          {!busy && text && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {followUps.map(q => (
                  <button key={q} onClick={() => onAsk(q)} style={{
                    fontSize: 12.5, padding: '4px 9px', borderRadius: 20, cursor: 'pointer',
                    border: '1px solid var(--border2)', background: 'var(--bg2)', color: 'var(--text2)', fontFamily: 'inherit',
                  }}>{q}</button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={customQ}
                  onChange={e => setCustomQ(e.target.value)}
                  placeholder="Ask about this payload…"
                  onKeyDown={e => { if (e.key === 'Enter' && customQ.trim()) { onAsk(customQ.trim()); setCustomQ('') } }}
                  style={{ flex: 1, padding: '7px 12px', fontSize: 13, borderRadius: 8, border: '1px solid var(--border2)', background: 'var(--bg)', fontFamily: 'inherit' }}
                />
                <button className="btn btn-primary btn-sm" style={{ fontSize: 12.5, flexShrink: 0 }}
                  disabled={!customQ.trim()}
                  onClick={() => { onAsk(customQ.trim()); setCustomQ('') }}>
                  Ask
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Sub-activity breakdown within a step (removeHeader, setProperty, etc), the
// same data CPI's own "Activities" sub-tab shows. Parsed server-side from a
// Java toString() blob — see parseActivitiesBlob in cpiTrace.js.
function ActivityList({ rows, empty }) {
  if (!rows?.length) return <Hint>{empty}</Hint>
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      {rows.map((r, i) => (
        <div key={i} style={{
          padding: '9px 12px', borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border)',
          background: i % 2 ? 'var(--bg3)' : 'transparent',
        }}>
          <div className="mono" style={{ fontSize: 13.5, color: 'var(--text)', wordBreak: 'break-word' }}>{r.Activity}</div>
          {(r.StartTime || r.StopTime) && (
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
              {r.StartTime}{r.StopTime && r.StopTime !== r.StartTime ? ` → ${r.StopTime}` : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// Static flow diagram from the uploaded iFlow ZIP. Structure only —
// deliberately no per-node status coloring and no click-to-jump, per the
// scoped Chunk C decision. Its job is to give the reader a spatial picture
// of the flow to anchor everything else against.
function FlowDiagram({ flow }) {
  const [expanded, setExpanded] = useState(false)
  const layout = useMemo(() => layOutFlow(flow), [flow])
  if (!layout) return null

  return (
    <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg2)' }}>
        <button onClick={() => setExpanded(e => !e)} style={{
          width: '100%', padding: '10px 14px', border: 'none', background: 'transparent', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit', color: 'var(--text)', textAlign: 'left',
        }}>
          <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>{expanded ? '▾' : '▸'}</span>
          <span style={{ fontSize: 13.5, fontWeight: 750 }}>iFlow structure</span>
          <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>
            from uploaded ZIP · {layout.nodes.length} nodes · {layout.edges.length} connections
          </span>
        </button>
        {expanded && (
          <div style={{ borderTop: '1px solid var(--border)', background: 'var(--bg)', overflow: 'auto', maxHeight: 320 }}>
            <svg width={layout.width} height={layout.height} style={{ display: 'block' }}>
              {/* edges first, so nodes overlay */}
              {layout.edges.map((e, i) => (
                <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke="var(--border2)" strokeWidth="1.5" markerEnd="url(#sb-arrow)" />
              ))}
              <defs>
                <marker id="sb-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text3)" />
                </marker>
              </defs>
              {layout.nodes.map(n => (
                <g key={n.id}>
                  <rect x={n.x - n.w/2} y={n.y - n.h/2} width={n.w} height={n.h} rx="6"
                    fill="var(--bg3)" stroke="var(--border2)" strokeWidth="1.2" />
                  <text x={n.x} y={n.y - 3} textAnchor="middle" fontSize="10" fontWeight="700" fill="var(--text)">
                    {truncate(n.name || n.id, 22)}
                  </text>
                  <text x={n.x} y={n.y + 10} textAnchor="middle" fontSize="8.5" fill="var(--text3)">
                    {truncate(n.kind || '', 22)}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        )}
      </div>
    </div>
  )
}

// Layered layout: longest-path from start assigns each node to a column,
// then nodes in the same column stack vertically. Good enough for typical
// integration flows (linear + a few branches); doesn't try to be dagre.
function layOutFlow(flow) {
  const stepMap = flow?.steps
  if (!stepMap) return null
  const nodes = Object.values(stepMap).filter(Boolean)
  if (!nodes.length) return null

  const edges = (flow.edges || []).filter(e => e.sourceRef && e.targetRef && stepMap[e.sourceRef] && stepMap[e.targetRef])
  const outgoing = new Map()
  const incoming = new Map()
  for (const e of edges) {
    if (!outgoing.has(e.sourceRef)) outgoing.set(e.sourceRef, [])
    if (!incoming.has(e.targetRef)) incoming.set(e.targetRef, [])
    outgoing.get(e.sourceRef).push(e.targetRef)
    incoming.get(e.targetRef).push(e.sourceRef)
  }

  // Longest-path depth = column. Nodes with no incoming edges start at 0.
  // Iterative relaxation, capped so cycles don't loop forever.
  const depth = new Map(nodes.map(n => [n.id, 0]))
  const maxIters = nodes.length * 2
  for (let k = 0; k < maxIters; k++) {
    let changed = false
    for (const e of edges) {
      const d = (depth.get(e.sourceRef) || 0) + 1
      if (d > (depth.get(e.targetRef) || 0)) { depth.set(e.targetRef, d); changed = true }
    }
    if (!changed) break
  }

  // Group nodes by column, stack vertically within each column
  const cols = new Map()
  for (const n of nodes) {
    const d = depth.get(n.id) || 0
    if (!cols.has(d)) cols.set(d, [])
    cols.get(d).push(n)
  }
  const colOrder = [...cols.keys()].sort((a, b) => a - b)

  const NODE_W = 130, NODE_H = 42, COL_GAP = 55, ROW_GAP = 12, PAD = 20
  const laidNodes = []
  const pos = new Map()
  let maxRows = 0
  colOrder.forEach((col, ci) => {
    const list = cols.get(col)
    maxRows = Math.max(maxRows, list.length)
    list.forEach((n, ri) => {
      const x = PAD + NODE_W/2 + ci * (NODE_W + COL_GAP)
      const y = PAD + NODE_H/2 + ri * (NODE_H + ROW_GAP)
      pos.set(n.id, { x, y })
      laidNodes.push({ ...n, x, y, w: NODE_W, h: NODE_H })
    })
  })

  const laidEdges = edges.map(e => {
    const a = pos.get(e.sourceRef), b = pos.get(e.targetRef)
    if (!a || !b) return null
    // Enter/exit through the vertical midline of each box
    return { x1: a.x + NODE_W/2, y1: a.y, x2: b.x - NODE_W/2 - 2, y2: b.y }
  }).filter(Boolean)

  const width  = PAD * 2 + colOrder.length * NODE_W + (colOrder.length - 1) * COL_GAP
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP
  return { nodes: laidNodes, edges: laidEdges, width, height }
}

// Deterministic per-step "what changed" scan. Compares each step's headers,
// exchange properties, and body against the PREVIOUS step's — reports the
// concrete diff (added/removed/modified) without inventing anything. Zero
// AI. If a step has no captured body, we compare only its metadata.
function RunChangeSummary({ steps, payloads, matchedFlow }) {
  const [expanded, setExpanded] = useState(false)
  const changes = useMemo(() => computeRunChanges(steps, payloads), [steps, payloads])
  if (!changes.length) return null

  const totalChanges = changes.reduce((n, c) => n + c.changes.length, 0)
  const stepsChanged = changes.filter(c => c.changes.length).length

  return (
    <div style={{ padding: '12px 18px 0', flexShrink: 0 }}>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', background: 'var(--bg2)' }}>
        <button onClick={() => setExpanded(e => !e)} style={{
          width: '100%', padding: '10px 14px', border: 'none', background: 'transparent', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'inherit', color: 'var(--text)', textAlign: 'left',
        }}>
          <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>{expanded ? '▾' : '▸'}</span>
          <span style={{ fontSize: 13.5, fontWeight: 750 }}>What changed at each step</span>
          <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>
            {stepsChanged} of {changes.length} steps · {totalChanges} change{totalChanges === 1 ? '' : 's'} total
          </span>
        </button>
        {expanded && (
          <div style={{ borderTop: '1px solid var(--border)', maxHeight: 240, overflowY: 'auto' }}>
            {changes.map((c, i) => {
              const design = matchedFlow?.steps?.[c.step.ModelStepId]
              const label = stepLabel(c.step, design, i)
              return (
                <div key={i} style={{ padding: '8px 14px', borderBottom: i === changes.length - 1 ? 'none' : '1px solid var(--border)', fontSize: 13 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text2)', marginBottom: c.changes.length ? 3 : 0 }}>
                    {i + 1}. {label}
                    {c.step.ModelStepId && <span style={{ marginLeft: 6, color: 'var(--text3)', fontWeight: 400, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{c.step.ModelStepId}</span>}
                  </div>
                  {c.changes.length === 0 ? (
                    <div style={{ color: 'var(--text3)', fontStyle: 'italic', fontSize: 12.5 }}>No changes vs previous step.</div>
                  ) : (
                    c.changes.map((ch, j) => (
                      <div key={j} style={{ color: 'var(--text3)', paddingLeft: 12, lineHeight: 1.55 }}>
                        <span style={{ color: ch.tone === 'add' ? '#5fa8f5' : ch.tone === 'rem' ? '#e0645f' : 'var(--text2)', fontWeight: 700 }}>
                          {ch.tone === 'add' ? '+ ' : ch.tone === 'rem' ? '− ' : '~ '}
                        </span>
                        {ch.text}
                      </div>
                    ))
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// Given the step list + already-loaded payloads, produce a per-step list of
// concrete changes. Pure comparison — nothing is inferred or invented.
function computeRunChanges(steps, payloads) {
  if (!steps?.length) return []
  const rows = []
  for (let i = 0; i < steps.length; i++) {
    const curr = steps[i]
    const prev = i > 0 ? steps[i - 1] : null
    if (!prev) { rows.push({ step: curr, changes: [] }); continue }

    const changes = []

    // Header diff — matched by name+direction
    const prevHdrKey = new Map((prev.Headers || []).map(h => [`${h.dir || ''}|${h.name}`, h.value]))
    const currHdrKey = new Map((curr.Headers || []).map(h => [`${h.dir || ''}|${h.name}`, h.value]))
    for (const [k, v] of currHdrKey) {
      if (!prevHdrKey.has(k))              changes.push({ tone: 'add', text: `header ${k.split('|')[1]} set to "${truncate(v, 60)}"` })
      else if (prevHdrKey.get(k) !== v)    changes.push({ tone: 'mod', text: `header ${k.split('|')[1]} changed: "${truncate(prevHdrKey.get(k), 30)}" → "${truncate(v, 30)}"` })
    }
    for (const [k] of prevHdrKey) if (!currHdrKey.has(k))
      changes.push({ tone: 'rem', text: `header ${k.split('|')[1]} removed` })

    // Exchange property diff
    const prevProp = new Map((prev.ExchangeProperties || []).map(p => [p.name, p.value]))
    const currProp = new Map((curr.ExchangeProperties || []).map(p => [p.name, p.value]))
    for (const [k, v] of currProp) {
      if (!prevProp.has(k))              changes.push({ tone: 'add', text: `property ${k} = "${truncate(v, 60)}"` })
      else if (prevProp.get(k) !== v)    changes.push({ tone: 'mod', text: `property ${k} changed: "${truncate(prevProp.get(k), 30)}" → "${truncate(v, 30)}"` })
    }
    for (const [k] of prevProp) if (!currProp.has(k))
      changes.push({ tone: 'rem', text: `property ${k} removed` })

    // Body diff — only if both are loaded and non-empty
    const pB = payloads[prev.TraceId], cB = payloads[curr.TraceId]
    if (pB?.text != null && cB?.text != null && !pB.empty && !cB.empty && !pB.error && !cB.error) {
      if (pB.text !== cB.text) {
        const before = pB.sizeBytes ?? pB.text.length
        const after = cB.sizeBytes ?? cB.text.length
        const delta = after - before
        changes.push({ tone: 'mod', text: `body transformed (${humanBytes(before)} → ${humanBytes(after)}${delta ? `, ${delta > 0 ? '+' : ''}${delta} bytes` : ''})` })
      }
    } else if (!pB?.text && cB?.text != null && !cB.empty && !cB.error) {
      changes.push({ tone: 'add', text: `body set (${humanBytes(cB.sizeBytes ?? cB.text.length)})` })
    }

    rows.push({ step: curr, changes })
  }
  return rows
}

function truncate(s, n) {
  const str = String(s ?? '')
  return str.length <= n ? str : str.slice(0, n - 1) + '…'
}

// Line-based diff of two payload bodies, using longest-common-subsequence
// to align them. Pure deterministic extraction — no AI, no interpretation.
// Handles JSON pretty-printing so a single 5-line body doesn't compare as one
// giant line.
//
// Returns [{ op: '=' | '-' | '+', text }] — a Myers-style edit script,
// grouped conceptually into hunks by the renderer.
function computeLineDiff(beforeText, afterText) {
  const beforeLines = prettifyForDiff(beforeText).split('\n')
  const afterLines  = prettifyForDiff(afterText).split('\n')

  // LCS matrix. Fine for the payload sizes we deal with (< a few thousand
  // lines). For anything bigger, CPI would have truncated the trace anyway.
  const n = beforeLines.length, m = afterLines.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      lcs[i][j] = beforeLines[i-1] === afterLines[j-1]
        ? lcs[i-1][j-1] + 1
        : Math.max(lcs[i-1][j], lcs[i][j-1])
    }
  }

  const out = []
  let i = n, j = m
  while (i > 0 && j > 0) {
    if (beforeLines[i-1] === afterLines[j-1])       { out.push({ op: '=', text: beforeLines[i-1] }); i--; j-- }
    else if (lcs[i-1][j] >= lcs[i][j-1])             { out.push({ op: '-', text: beforeLines[i-1] }); i-- }
    else                                              { out.push({ op: '+', text: afterLines[j-1] }); j-- }
  }
  while (i > 0) { out.push({ op: '-', text: beforeLines[--i] === undefined ? '' : beforeLines[i] }) }
  while (j > 0) { out.push({ op: '+', text: afterLines[--j]  === undefined ? '' : afterLines[j] }) }
  return out.reverse()
}

// If both sides parse as JSON, pretty-print with the same indent so we
// compare structure, not whitespace. Otherwise leave as-is.
function prettifyForDiff(s) {
  if (!s || typeof s !== 'string') return String(s ?? '')
  const t = s.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return s
  try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return s }
}

function PayloadDiff({ before, after, beforeLabel, afterLabel, shareSafe, redactCats }) {
  const [showUnchanged, setShowUnchanged] = useState(false)
  const diff = useMemo(() => {
    // Redact BEFORE diffing when share-safe is on — otherwise you'd see
    // secrets in the diff even though they'd be masked in the raw payload.
    const b = shareSafe ? redactPayload(before || '', redactCats) : (before || '')
    const a = shareSafe ? redactPayload(after || '',  redactCats) : (after  || '')
    return computeLineDiff(b, a)
  }, [before, after, shareSafe, redactCats])

  const stats = useMemo(() => {
    let add = 0, rem = 0, same = 0
    for (const d of diff) d.op === '+' ? add++ : d.op === '-' ? rem++ : same++
    return { add, rem, same }
  }, [diff])

  if (stats.add === 0 && stats.rem === 0) {
    return (
      <div>
        <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.6 }}>
          Comparing this step against <b style={{ color: 'var(--text2)' }}>{beforeLabel}</b>.
        </div>
        <div style={{ padding: '16px 18px', borderRadius: 10, background: 'var(--bg3)', border: '1px solid var(--border)', fontSize: 14, color: 'var(--text3)' }}>
          <b style={{ color: 'var(--text2)' }}>No changes.</b> The body is identical to the previous step's body — this step didn't transform the message payload. (It may still have changed headers or properties — check those tabs.)
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: 'var(--text3)', lineHeight: 1.6 }}>
          Comparing against <b style={{ color: 'var(--text2)' }}>{beforeLabel}</b>
          {' → '}
          <b style={{ color: 'var(--text2)' }}>{afterLabel}</b>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
          <span style={{ color: '#5fa8f5', fontWeight: 700 }}>+{stats.add}</span>
          <span style={{ color: '#e0645f', fontWeight: 700 }}>−{stats.rem}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text3)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showUnchanged} onChange={e => setShowUnchanged(e.target.checked)} />
            Show unchanged
          </label>
        </div>
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>
        {renderDiffHunks(diff, showUnchanged)}
      </div>
    </div>
  )
}

// Collapse long unchanged runs to "… N unchanged lines …" when showUnchanged
// is off — a Content Modifier that adds one header shouldn't drown you in
// 400 lines of identical JSON.
function renderDiffHunks(diff, showUnchanged) {
  const rows = []
  let sameBuf = []
  const flushSame = (key) => {
    if (!sameBuf.length) return
    if (showUnchanged) {
      sameBuf.forEach((l, i) => rows.push(diffRow('=', l, key + ':same:' + i)))
    } else if (sameBuf.length <= 3) {
      // Small runs: show anyway, they're useful context around a change
      sameBuf.forEach((l, i) => rows.push(diffRow('=', l, key + ':small:' + i)))
    } else {
      // Longer runs: show first line, elide, show last line
      rows.push(diffRow('=', sameBuf[0], key + ':first'))
      rows.push(<div key={key + ':elide'} style={{ padding: '4px 12px', color: 'var(--text3)', background: 'var(--bg2)', fontStyle: 'italic', textAlign: 'center' }}>… {sameBuf.length - 2} unchanged lines …</div>)
      rows.push(diffRow('=', sameBuf[sameBuf.length - 1], key + ':last'))
    }
    sameBuf = []
  }

  diff.forEach((d, i) => {
    if (d.op === '=') sameBuf.push(d.text)
    else { flushSame('run' + i); rows.push(diffRow(d.op, d.text, 'r' + i)) }
  })
  flushSame('end')
  return rows
}

function diffRow(op, text, key) {
  const style = op === '+' ? { background: 'color-mix(in srgb, #5fa8f5 15%, transparent)', color: '#5fa8f5', borderLeft: '3px solid #5fa8f5' }
              : op === '-' ? { background: 'color-mix(in srgb, #e0645f 12%, transparent)', color: '#e0645f', borderLeft: '3px solid #e0645f' }
              :              { color: 'var(--text3)', borderLeft: '3px solid transparent' }
  return (
    <div key={key} style={{ padding: '2px 8px 2px 5px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', ...style }}>
      <span style={{ display: 'inline-block', width: 12, opacity: 0.5, userSelect: 'none' }}>{op === '=' ? ' ' : op}</span>
      {text || '\u00a0'}
    </div>
  )
}

function InfoGrid({ rows }) {
  const visible = rows.filter(([, v]) => v != null && v !== '')
  if (!visible.length) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 8, columnGap: 14, fontSize: 14 }}>
      {visible.map(([k, v, mono]) => (
        <div key={k} style={{ display: 'contents' }}>
          <div style={{ color: 'var(--text3)' }}>{k}</div>
          <div className={mono ? 'mono' : ''} style={{ wordBreak: 'break-all', fontSize: mono ? 11.5 : 12.5 }}>{v}</div>
        </div>
      ))}
    </div>
  )
}

function CredInput({ label, value, onChange, placeholder, secret, hint }) {
  const [show, setShow] = useState(!secret)
  return (
    <label style={{ display: 'block', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text2)' }}>{label}</span>
        {hint && <span style={{ fontSize: 12, color: 'var(--text3)' }}>{hint}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type={show ? 'text' : 'password'} value={value || ''} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          style={{ flex: 1, padding: '10px 13px', fontSize: 14 }}/>
        {secret && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShow(s => !s)}>{show ? '🙈' : '👁'}</button>}
      </div>
    </label>
  )
}

const ShareToggle = ({ on, onChange }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, padding: '5px 12px', borderRadius: 20, cursor: 'pointer', border: `1px solid ${on ? '#e8a54b' : 'var(--border)'}`, background: on ? 'color-mix(in srgb, #e8a54b 12%, transparent)' : 'transparent', color: on ? '#e8a54b' : 'var(--text2)', fontWeight: 600 }}>
    <input type="checkbox" checked={on} onChange={e => onChange(e.target.checked)} style={{ margin: 0, width: 12, height: 12 }}/>
    Share-safe
  </label>
)

const Hint = ({ children }) => <div style={{ fontSize: 14, color: 'var(--text3)' }}>{children}</div>
const ErrorCard = ({ err }) => (
  <div style={{ padding: '16px 18px', borderRadius: 12, background: 'color-mix(in srgb, #e0645f 8%, transparent)', border: '1px solid color-mix(in srgb, #e0645f 30%, transparent)', marginTop: 6 }}>
    <div style={{ fontSize: 12.5, fontWeight: 800, color: '#e0645f', letterSpacing: '.05em', marginBottom: 6 }}>ERROR</div>
    <div style={{ fontSize: 14, wordBreak: 'break-word', lineHeight: 1.6 }}>{err}</div>
    <div style={{ fontSize: 13, color: 'var(--text3)', marginTop: 8 }}>
      Checklist: correct API host (no -rt) · service key on <b>api</b> plan with <b>MonitoringRead</b> · Trace enabled on the iFlow.
    </div>
  </div>
)

const cardStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 22px', marginBottom: 16 }
const microLabel = { fontSize: 12, fontWeight: 800, letterSpacing: '.07em', color: 'var(--text2)', textTransform: 'uppercase' }

const host = (u) => { try { return new URL(u).hostname } catch { return u || '' } }
function formatDate(d) {
  if (!d) return ''
  const m = typeof d === 'string' ? d.match(/\/Date\((\d+)\)\//) : null
  const date = m ? new Date(Number(m[1])) : new Date(d)
  return isNaN(date) ? String(d) : date.toISOString().replace('T', ' ').slice(0, 19)
}
const parseD = (d) => { if (!d) return null; const m = typeof d === 'string' ? d.match(/\/Date\((\d+)\)\//) : null; const t = m ? new Date(+m[1]) : new Date(d); return isNaN(t) ? null : +t }
// CPI's RunSteps carry the BPMN model ID (MessageFlow_4, CallActivity_5) — not
// the name the developer typed. The readable name lives in the iFlow design, so
// if the matching iFlow ZIP is loaded we resolve it; otherwise we show the raw
// ID rather than inventing one.
// At-a-glance status pills on each timeline step: body loaded, empty, or
// still loading; count of headers/properties/activities the step captured.
// Everything reads from data already fetched — nothing new comes over the
// wire to render these.
function StepBadges({ step, payload }) {
  const bodyBadge = (() => {
    if (!step?.HasPayload) return null
    if (!payload) return { label: '⋯ body', title: 'Loading body from CPI', tone: 'muted' }
    if (payload.loading) return { label: '⋯ body', title: 'Loading body from CPI', tone: 'muted' }
    if (payload.empty) return { label: '∅ body', title: 'Step has a trace ID but CPI stored no bytes for it (common for end events / adapter-only steps)', tone: 'muted' }
    if (payload.error) return { label: '! body', title: `Couldn't load body: ${payload.error}`, tone: 'error' }
    if (payload.text != null || payload.base64) {
      const size = payload.sizeBytes ?? (payload.text ? payload.text.length : 0)
      return { label: `body · ${humanBytes(size)}`, title: `Body captured (${size} bytes)`, tone: 'ok' }
    }
    return null
  })()

  const items = [
    bodyBadge,
    step.MessageHeaders?.length     ? { label: `${step.MessageHeaders.length} msg hdr`, title: `${step.MessageHeaders.length} message headers (what the flow set)`, tone: 'ok' } : null,
    step.Headers?.length            ? { label: `${step.Headers.length} http hdr`, title: `${step.Headers.length} HTTP transport headers at this adapter step`, tone: 'neutral' } : null,
    step.ExchangeProperties?.length ? { label: `${step.ExchangeProperties.length} prop`, title: `${step.ExchangeProperties.length} exchange properties`, tone: 'neutral' } : null,
    step.Activities?.length         ? { label: `${step.Activities.length} act`,  title: `${step.Activities.length} sub-activities`, tone: 'neutral' } : null,
  ].filter(Boolean)

  if (!items.length) return null
  const bg = { ok: 'var(--blue-bg)', muted: 'var(--bg3)', error: 'color-mix(in srgb, #e0645f 15%, transparent)', neutral: 'var(--bg3)' }
  const fg = { ok: 'var(--blue)', muted: 'var(--text3)', error: '#e0645f', neutral: 'var(--text3)' }
  return (
    <>
      {items.map((b, i) => (
        <span key={i} title={b.title}
          style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 5, background: bg[b.tone], color: fg[b.tone], whiteSpace: 'nowrap' }}>
          {b.label}
        </span>
      ))}
    </>
  )
}

function humanBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function stepLabel(step, design, i) {
  return design?.name
    || step?.Activity
    || step?.ModelStepId
    || step?.StepId
    || step?.Name
    || `Step ${i + 1}`
}

function durationMs(o) {
  const a = parseD(o?.StepStart || o?.LogStart || o?.Timestamp)
  const b = parseD(o?.StepStop || o?.LogEnd)
  if (!a || !b) return ''
  const ms = b - a
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}
// Pretty-print XML or JSON for the payload pane. CPI trace payloads often
// arrive as a single line — especially XML — which is unreadable without
// formatting. JSON gets standard 2-space indent; XML gets a simple regex
// formatter that's good enough for reading without pulling in a DOM parser.
function prettify(s) {
  if (!s || typeof s !== 'string') return s
  const t = s.trim()

  // JSON
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.stringify(JSON.parse(t), null, 2) } catch { /* not JSON */ }
  }

  // XML — indent by tag depth. Not a real parser, but handles the common
  // case of a single-line XML payload correctly.
  if (t.startsWith('<')) {
    try {
      let indent = 0, out = ''
      const tokens = t.replace(/>\s*</g, '>\n<').split('\n')
      for (const tok of tokens) {
        const trimmed = tok.trim()
        if (!trimmed) continue
        if (trimmed.startsWith('</'))        indent = Math.max(0, indent - 1)
        out += '  '.repeat(indent) + trimmed + '\n'
        if (trimmed.startsWith('<') && !trimmed.startsWith('</') && !trimmed.startsWith('<?') &&
            !trimmed.endsWith('/>') && !trimmed.includes('</'))
          indent++
      }
      return out.trimEnd()
    } catch { return s }
  }

  return s
}

function decodeIfText(base64, ct) {
  if (!base64) return ''
  // CPI's trace endpoint returns application/octet-stream for EVERYTHING —
  // including XML, JSON, and plain text. Trusting the content-type here means
  // every payload shows as "Binary" even when it's perfectly readable XML.
  // So: try to decode as UTF-8 first; only fall back to binary if the bytes
  // aren't valid text (contains control chars other than whitespace).
  try {
    const decoded = atob(base64)
    // Quick heuristic: if the first 200 chars contain control characters
    // (other than \t \n \r) it's genuinely binary. Otherwise treat as text.
    const sample = decoded.slice(0, 200)
    const hasBinaryChars = /[\x00-\x08\x0E-\x1F]/.test(sample)
    if (hasBinaryChars) return null
    return decoded
  } catch { return null }
}

function exportReport({ trace, matchedFlow, payloads, shareSafe, redactCats }) {
  const mpl = trace.mpl || {}
  const L = [`# Debug Report — ${mpl.IntegrationFlowName || 'iFlow'}`, '',
    `- MessageGuid: \`${mpl.MessageGuid}\``, `- Status: ${mpl.Status}`,
    `- Started: ${formatDate(mpl.LogStart)}`, `- Duration: ${durationMs(mpl)}`]
  if (shareSafe) L.push('- _Redacted for sharing_')
  L.push('', '## Steps', '')
  ;(trace.traceMessages || []).forEach((s, i) => {
    L.push(`### ${i + 1}. ${s.ModelStepId || `Step ${i + 1}`} — ${s.Status || '?'}`)
    if (s.Error || s.ErrorInformation) L.push(`- Error: ${s.Error || s.ErrorInformation}`)
    const design = matchedFlow?.steps?.[s.ModelStepId]
    if (design) L.push(`- Type: ${design.kind || design.type}`)
    const p = payloads[s.TraceId || s.Id]
    if (p?.text != null) L.push('', '```', (shareSafe ? redactPayload(p.text, redactCats) : p.text).slice(0, 4000), '```')
    L.push('')
  })
  const blob = new Blob([L.join('\n')], { type: 'text/markdown' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(mpl.IntegrationFlowName || 'trace').replace(/[^a-z0-9]+/gi, '_')}_debug.md`
  a.click(); URL.revokeObjectURL(a.href)
}
