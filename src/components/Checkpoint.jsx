import { useEffect, useRef, useState } from 'react'

export default function Checkpoint({ sessions, onRelease, onAbort }) {
  const [selected, setSelected] = useState(null)
  const [editedBody, setEditedBody] = useState('')
  const [editedProps, setEditedProps] = useState('')
  const [releasing, setReleasing] = useState(false)

  // Auto-select latest session
  useEffect(() => {
    if (sessions.length > 0 && !selected) {
      setSelected(sessions[sessions.length - 1])
    }
    if (sessions.length > 0) {
      const latest = sessions[sessions.length - 1]
      if (selected && selected.id === latest.id) return
      setSelected(latest)
    }
  }, [sessions])

  useEffect(() => {
    if (selected) {
      setEditedBody(selected.body || '')
      setEditedProps(JSON.stringify(selected.properties || {}, null, 2))
    }
  }, [selected])

  async function release(withEdits = false) {
    if (!selected) return
    setReleasing(true)
    try {
      let body = selected.body
      let properties = selected.properties
      if (withEdits) {
        body = editedBody
        try { properties = JSON.parse(editedProps) } catch {}
      }
      await onRelease(selected.id, { body, properties })
    } finally {
      setReleasing(false)
    }
  }

  async function abort() {
    if (!selected) return
    await onAbort(selected.id)
  }

  const inp = {
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 14,
    color: 'var(--text)',
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box'
  }

  if (sessions.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, color: 'var(--text3)', padding: 40 }}>
        <div style={{ fontSize: 48, opacity: .15 }}>⏸</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text2)' }}>No checkpoints yet</div>
        <div style={{ fontSize: 15, textAlign: 'center', maxWidth: 460, lineHeight: 1.7 }}>
          Drop the Groovy Checkpoint script into your iFlow between any two steps.
          When CPI hits that step, the flow will pause and appear here.
        </div>
        <div style={{ marginTop: 8, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 18px', width: '100%', maxWidth: 500 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>Your SHIPBRIDGE Checkpoint URL</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13.5, color: 'var(--blue)', background: 'var(--bg3)', padding: '8px 10px', borderRadius: 6, wordBreak: 'break-all' }}>
            http://your-server:3001/api/checkpoint
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--text3)', marginTop: 8 }}>
            Paste this URL into the Groovy script's <code style={{ background: 'var(--bg3)', padding: '1px 5px', borderRadius: 3 }}>webhookUrl</code> variable.
          </div>
        </div>
        <GroovyScriptBox />
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', height: 'calc(100vh - 48px)', overflow: 'hidden' }}>

      {/* ── Left: session list ── */}
      <div style={{ borderRight: '1px solid var(--border)', overflowY: 'auto', background: 'var(--bg2)' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', fontSize: 14, fontWeight: 700, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--amber2)', display: 'inline-block', boxShadow: '0 0 6px var(--amber2)', animation: 'pulse 1.5s infinite' }}/>
          Checkpoints ({sessions.length})
        </div>
        {[...sessions].reverse().map(s => (
          <div key={s.id} onClick={() => setSelected(s)}
            style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
              background: selected?.id === s.id ? 'var(--blue-bg)' : 'transparent',
              borderLeft: selected?.id === s.id ? '3px solid var(--blue)' : '3px solid transparent' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 3 }}>
              {s.stepLabel || 'Unnamed step'}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>{new Date(s.receivedAt).toLocaleTimeString()}</div>
            <div style={{ fontSize: 12.5, marginTop: 3, padding: '1px 6px', borderRadius: 4, display: 'inline-block',
              background: s.status === 'waiting' ? 'rgba(245,158,11,.12)' : s.status === 'released' ? 'rgba(63,185,80,.1)' : 'rgba(185,28,28,.1)',
              color: s.status === 'waiting' ? 'var(--amber2)' : s.status === 'released' ? 'var(--green)' : 'var(--red)',
              fontWeight: 600 }}>
              {s.status === 'waiting' ? '⏸ Waiting' : s.status === 'released' ? '▶ Released' : '✕ Aborted'}
            </div>
          </div>
        ))}
      </div>

      {/* ── Right: detail panel ── */}
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {selected && (
          <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>

            {/* Status banner */}
            {selected.status === 'waiting' && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.3)', fontSize: 14, color: 'var(--amber2)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--amber2)', display: 'inline-block', animation: 'pulse 1.2s infinite' }}/>
                iFlow paused — waiting at: <strong>{selected.stepLabel || 'checkpoint'}</strong>
              </div>
            )}
            {selected.status === 'released' && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(63,185,80,.08)', border: '1px solid rgba(63,185,80,.25)', fontSize: 14, color: 'var(--green)', fontWeight: 600 }}>
                ▶ Released — iFlow continued
              </div>
            )}
            {selected.status === 'aborted' && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(185,28,28,.08)', border: '1px solid rgba(185,28,28,.25)', fontSize: 14, color: 'var(--red)', fontWeight: 600 }}>
                ✕ Aborted — iFlow threw an exception
              </div>
            )}

            {/* Meta info */}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {[
                ['Step', selected.stepLabel || 'Unknown'],
                ['iFlow', selected.iflowName || 'Unknown'],
                ['Received', new Date(selected.receivedAt).toLocaleTimeString()],
              ].map(([k, v]) => (
                <div key={k} style={{ padding: '5px 10px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid var(--border)', fontSize: 13.5 }}>
                  <span style={{ color: 'var(--text3)' }}>{k}: </span>
                  <span style={{ color: 'var(--text2)', fontWeight: 600 }}>{v}</span>
                </div>
              ))}
            </div>

            {/* Body + Properties editors */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text2)', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                  Body
                  {selected.status === 'waiting' && <span style={{ fontSize: 12.5, color: 'var(--text3)', fontWeight: 400 }}>(editable — changes go back to CPI)</span>}
                </div>
                <textarea
                  value={editedBody}
                  onChange={e => setEditedBody(e.target.value)}
                  readOnly={selected.status !== 'waiting'}
                  style={{ width: '100%', height: 240, padding: 10, fontSize: 13.5, fontFamily: 'JetBrains Mono, monospace',
                    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
                    color: 'var(--text)', resize: 'vertical', boxSizing: 'border-box',
                    opacity: selected.status !== 'waiting' ? 0.7 : 1 }}/>
              </div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text2)', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                  Properties
                  {selected.status === 'waiting' && <span style={{ fontSize: 12.5, color: 'var(--text3)', fontWeight: 400 }}>(editable)</span>}
                </div>
                <textarea
                  value={editedProps}
                  onChange={e => setEditedProps(e.target.value)}
                  readOnly={selected.status !== 'waiting'}
                  style={{ width: '100%', height: 240, padding: 10, fontSize: 13.5, fontFamily: 'JetBrains Mono, monospace',
                    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
                    color: 'var(--text)', resize: 'vertical', boxSizing: 'border-box',
                    opacity: selected.status !== 'waiting' ? 0.7 : 1 }}/>
              </div>
            </div>

            {/* Headers display */}
            {selected.headers && Object.keys(selected.headers).length > 0 && (
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text2)', marginBottom: 6 }}>Headers</div>
                <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                  {Object.entries(selected.headers).slice(0, 10).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '5px 12px', fontSize: 13.5, fontFamily: 'JetBrains Mono, monospace' }}>
                      <span style={{ color: 'var(--blue)', minWidth: 200, flexShrink: 0 }}>{k}</span>
                      <span style={{ color: 'var(--text2)', wordBreak: 'break-all' }}>{String(v).slice(0, 80)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action buttons */}
            {selected.status === 'waiting' && (
              <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
                <button onClick={() => release(false)} disabled={releasing}
                  style={{ padding: '10px 24px', borderRadius: 8, border: 'none', background: '#1D9E75', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {releasing ? 'Releasing…' : '▶ Release'}
                </button>
                <button onClick={() => release(true)} disabled={releasing}
                  style={{ padding: '10px 24px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg2)', color: 'var(--text)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  ▶ Release with edits
                </button>
                <button onClick={abort} disabled={releasing}
                  style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid rgba(185,28,28,.3)', background: 'rgba(185,28,28,.06)', color: 'var(--red)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  ✕ Abort
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function GroovyScriptBox() {
  const [copied, setCopied] = useState(false)
  const script = `import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.*

def Message processData(Message message) {
    // ← Change this to your SHIPBRIDGE server URL
    def webhookUrl = 'http://YOUR_IP:3001/api/checkpoint'

    def payload = [
        iflowName : 'Your iFlow Name',
        stepLabel : 'After Split Each Invoice',
        body      : message.getBody(String.class),
        headers   : message.getHeaders(),
        properties: [
            invoiceNumber: message.getProperty('invoiceNumber'),
            vendorId     : message.getProperty('vendorId'),
            amount       : message.getProperty('amount')
        ]
    ]

    def conn = new URL(webhookUrl).openConnection()
    conn.setRequestMethod('POST')
    conn.setDoOutput(true)
    conn.setConnectTimeout(180000)
    conn.setReadTimeout(180000)
    conn.setRequestProperty('Content-Type', 'application/json')
    conn.outputStream.write(
        JsonOutput.toJson(payload).getBytes('UTF-8')
    )

    def resp = new JsonSlurper().parse(conn.inputStream)

    if (resp.body)       message.setBody(resp.body)
    if (resp.headers)    resp.headers.each   { k, v -> message.setHeader(k, v.toString()) }
    if (resp.properties) resp.properties.each { k, v -> message.setProperty(k, v.toString()) }

    if (resp.abort) throw new Exception('Aborted from SHIPBRIDGE')

    return message
}`

  return (
    <div style={{ width: '100%', maxWidth: 600, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text2)' }}>Groovy Checkpoint Script — paste into your iFlow</span>
        <button onClick={() => { navigator.clipboard.writeText(script); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
          style={{ padding: '3px 10px', fontSize: 12.5, borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)', cursor: 'pointer', fontFamily: 'inherit' }}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre style={{ margin: 0, padding: '12px 14px', fontSize: 12.5, fontFamily: 'JetBrains Mono, monospace', color: 'var(--text)', lineHeight: 1.6, overflowX: 'auto', maxHeight: 220 }}>
        {script}
      </pre>
    </div>
  )
}
