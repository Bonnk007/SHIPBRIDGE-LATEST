import Checkpoint from './components/Checkpoint.jsx'
import Intelligence from './components/Intelligence.jsx'
import Documentation from './components/Documentation.jsx'
import CompareView from './components/CompareView.jsx'
import TraceViewer from './components/TraceViewer.jsx'
import Sidebar from './components/Sidebar.jsx'
import ShellBar from './components/ShellBar.jsx'
import Home from './components/Home.jsx'
import DraggableFab from './components/DraggableFab.jsx'
import LandingPage from './components/LandingPage.jsx'
import HelpPanel from './components/HelpPanel.jsx'
import LiveTrigger from './components/LiveTrigger.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import CommandBar from './components/CommandBar.jsx'
import Converter from './components/Converter.jsx'
import { useState, useRef, useEffect } from 'react'
import { parseZip, FLOW_COLORS } from './lib/parser.js'
import { autoLink } from './lib/linker.js'
import { logActivity, ActivityKinds } from './lib/activity.js'

const PAGES = [
  { id:'home',      label:'Home',          icon:'⌂' },
  { id:'trace',     label:'Real Trace',    icon:'🛰' },
  { id:'trigger',   label:'Live Trigger',  icon:'🚀' },
  { id:'compare',   label:'Compare',       icon:'🔀', badge:'v2' },
  { id:'intel',     label:'Intelligence',  icon:'🧠' },
  { id:'converter', label:'Converter',     icon:'🔄' },
  { id:'docs',      label:'Documentation', icon:'📄' },
]

export default function App() {
  const [page, setPage] = useState('home')
  // Trace session survives tab switches so you don't re-enter credentials
  // after checking Live Trigger. Secret is in React state only — never persisted.
  const [traceSession, setTraceSession] = useState({ connected: false, clientSecret: '' })
  const [theme, setTheme] = useState(() => localStorage.getItem('tf_theme') || 'light')
  const [registry, setRegistry] = useState(new Map())
  const [links, setLinks] = useState([])
  const [loading, setLoading] = useState(false)
  const [showLanding, setShowLanding] = useState(true)
  const [apiKeyOk, setApiKeyOk] = useState(null)
  const [checkpoints, setCheckpoints] = useState([])
  const [cpBadge, setCpBadge] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [locked, setLocked] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const fileRef = useRef()

  // Theme
  useEffect(() => {
    document.documentElement.className = theme === 'light' ? 'light' : ''
    try { localStorage.setItem('tf_theme', theme) } catch {}
  }, [theme])

  // API health check. /api/health is always open; a protected deployment is
  // detected by probing a gated endpoint and looking for a 401.
  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(d => setApiKeyOk(d.apiKeyConfigured)).catch(() => setApiKeyOk(false))
    fetch('/api/spec-template').then(r => { if (r.status === 401) setLocked(true) }).catch(() => {})
  }, [])

  // Checkpoint events
  useEffect(() => {
    const es = new EventSource('/api/checkpoint/stream')
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'new') {
          setCheckpoints(prev => [...prev, data.session])
          setCpBadge(n => n + 1)
          setPage('checkpoint')
          setShowLanding(false)
        } else if (data.type === 'released' || data.type === 'timeout') {
          setCheckpoints(prev => prev.map(s =>
            s.id === data.id ? { ...s, status: data.abort ? 'aborted' : 'released' } : s
          ))
        }
      } catch {}
    }
    return () => es.close()
  }, [])

  // Browser back → landing
  useEffect(() => {
    if (!showLanding) { try { window.history.pushState({ tf: 1 }, '') } catch {} }
  }, [showLanding])
  useEffect(() => {
    function onPopState() { setShowLanding(true); setPage('home') }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Keyboard: cmd bar
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdOpen(o => !o) }
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) { e.preventDefault(); setCmdOpen(true) }
      if (e.key === 'Escape') setCmdOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function handleStart(id) {
    setShowLanding(false)
    const valid = ['home', 'trigger', 'converter', 'intel', 'docs', 'trace', 'compare']
    setPage(valid.includes(id) ? id : 'home')
  }

  function handleCommand(action) {
    if (action === 'clear') clearAll()
    else if (action === 'goto-trigger') setPage('trigger')
    else if (action === 'goto-trace') setPage('trace')
    else if (action === 'goto-compare') setPage('compare')
    else if (action === 'goto-intel') setPage('intel')
    else if (action === 'goto-converter') setPage('converter')
    else if (action === 'goto-docs') setPage('docs')
    else if (action === 'open-help') setHelpOpen(true)
  }

  function addFlows(newFlows) {
    setRegistry(prev => {
      const next = new Map(prev)
      newFlows.forEach(f => {
        let id = f.id, n = 2
        while (next.has(id)) id = `${f.id}-${n++}`
        f.id = id
        const names = new Set([...next.values()].map(x => x.name))
        if (names.has(f.name)) {
          const zipBase = (f.zipName || '').replace(/\.zip$/i, '')
          f.name = zipBase && zipBase.toLowerCase() !== f.name.toLowerCase() ? `${f.name} — ${zipBase}` : `${f.name} (${n - 1})`
        }
        f.color = FLOW_COLORS[next.size % FLOW_COLORS.length]
        next.set(id, f)
      })
      setLinks(autoLink(next)); return next
    })
  }

  async function handleFiles(files) {
    const zips = [...files].filter(f => f.name.endsWith('.zip'))
    if (!zips.length) { alert('Please select .zip files — export each iFlow from SAP CPI as a ZIP'); return }
    setLoading(true)
    try {
      const parsed = await Promise.all(zips.map(f => parseZip(f)))
      addFlows(parsed)
      // Each successful load becomes a Home "Recent" entry — clicking it
      // opens Intelligence, which is where a freshly-loaded iFlow is most
      // often looked at first (dependency map, entry/exit adapters).
      parsed.forEach(f => {
        const stepCount = Object.keys(f.steps || {}).length
        logActivity({
          kind: ActivityKinds.LOAD,
          title: `Loaded ${f.name}`,
          subtitle: stepCount ? `${stepCount} step${stepCount === 1 ? '' : 's'}` : 'iFlow',
          status: 'info',
          target: { page: 'intel' },
        })
      })
    }
    catch (e) { alert('Error: ' + e.message) }
    finally { setLoading(false) }
  }

  function clearAll() { setRegistry(new Map()); setLinks([]) }

  // Protected deployment with no stored key yet — ask for it before anything
  // else. A wrong key just re-locks; the key lives in localStorage only.
  if (locked && !localStorage.getItem('sb_app_key')) {
    return <UnlockGate onUnlock={(key) => {
      localStorage.setItem('sb_app_key', key)
      fetch('/api/spec-template').then(r => {
        if (r.status === 401) { localStorage.removeItem('sb_app_key'); alert('That access key was not accepted.') }
        else setLocked(false)
      }).catch(() => setLocked(false))
    }} theme={theme} />
  }

  if (showLanding) return <LandingPage onStart={handleStart} theme={theme} onToggleTheme={() => setTheme(t => t === 'light' ? 'dark' : 'light')} />

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ShellBar onHome={() => { setShowLanding(true); setPage('home') }} />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Sidebar
          pages={cpBadge > 0 || checkpoints.length > 0 ? [...PAGES, { id: 'checkpoint', label: 'Checkpoint' }] : PAGES}
          page={page} onNavigate={setPage}
          theme={theme} onToggleTheme={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
          registryCount={registry.size} cpBadge={cpBadge}
          onHome={() => { setShowLanding(true); setPage('home') }}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(c => !c)}
        />
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'auto' }}>
          {apiKeyOk === false && (
            <div style={{ padding: '8px 20px', background: 'var(--amber-bg)', borderBottom: '1px solid var(--border)', fontSize: 14, color: 'var(--amber2)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>⚠ AI features unavailable</strong>
              Add <code style={{ background: 'var(--bg3)', padding: '1px 6px', borderRadius: 4 }}>ANTHROPIC_API_KEY=sk-ant-...</code> to your <code style={{ background: 'var(--bg3)', padding: '1px 6px', borderRadius: 4 }}>.env</code> file and restart the server.
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}
                onClick={() => fetch('/api/health').then(r => r.json()).then(d => setApiKeyOk(d.apiKeyConfigured)).catch(() => {})}>Recheck</button>
            </div>
          )}

          {/* A render error used to unmount everything and leave a blank
              screen with the cause only in the console. The boundary keeps the
              app usable and shows what actually broke. resetKey clears it when
              the user navigates away. */}
          <ErrorBoundary label={page} resetKey={page}>
          {/* Real Trace stays mounted even when hidden. Otherwise switching to
              Live Trigger and back throws away the connection, the loaded trace,
              every fetched payload, and the client secret — forcing a restart.
              Only TraceViewer needs this treatment; other pages hold no state
              worth preserving. */}
          <div style={{
            display: page === 'trace' ? 'flex' : 'none',
            flex: 1, minHeight: 0,
          }}>
            <TraceViewer registry={registry} onUpload={handleFiles}
              traceSession={traceSession} setTraceSession={setTraceSession} />
          </div>
          {page === 'home' && <Home
            onNavigate={setPage}
            onUpload={() => fileRef.current?.click()}
            registry={registry}
            traceSession={traceSession}
            checkpointCount={cpBadge}
          />}
          {page === 'trigger' && <LiveTrigger />}
          {page === 'compare' && <CompareView registry={registry} />}
          {page === 'intel' && <Intelligence registry={registry} onUpload={handleFiles} />}
          {page === 'converter' && <Converter />}
          {page === 'docs' && <Documentation registry={registry} onUpload={handleFiles} />}
          {page === 'checkpoint' && <Checkpoint sessions={checkpoints}
            onRelease={(id, data) => fetch(`/api/checkpoint/${id}/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) }).then(() => setCheckpoints(prev => prev.filter(s => s.id !== id)))}
            onAbort={(id) => fetch(`/api/checkpoint/${id}/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ abort: true }) }).then(() => setCheckpoints(prev => prev.filter(s => s.id !== id)))} />}
          </ErrorBoundary>

          {/* hidden global file input so any page can trigger uploads */}
          <input ref={fileRef} type="file" accept=".zip" multiple style={{ display: 'none' }}
            onChange={e => { handleFiles(e.target.files); e.target.value = '' }} />
        </main>
      </div>

      {!showLanding && <DraggableFab onClick={() => setHelpOpen(true)}>🤖</DraggableFab>}
      {cmdOpen && <CommandBar onAction={handleCommand} onClose={() => setCmdOpen(false)} />}
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}

// Minimal unlock screen for password-protected deployments. Brown palette,
// consistent with the rest of the app (locked design decision #6).
function UnlockGate({ onUnlock, theme }) {
  const [key, setKey] = useState('')
  const submit = () => { if (key.trim()) onUnlock(key.trim()) }
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: theme === 'light' ? '#f5f0e8' : '#1a1512', color: theme === 'light' ? '#2b2119' : '#e8dccb',
    }}>
      <div style={{ width: 340, padding: 32, borderRadius: 12, background: theme === 'light' ? '#fff' : '#241d18', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>ShipBridge</div>
        <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 20 }}>This deployment is protected. Enter the access key to continue.</div>
        <input
          type="password" value={key} autoFocus
          onChange={e => setKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="Access key"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d9a066', background: 'transparent', color: 'inherit', fontSize: 15, marginBottom: 14, boxSizing: 'border-box' }}
        />
        <button
          onClick={submit}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none', background: '#d9a066', color: '#2b2119', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}
        >Unlock</button>
      </div>
    </div>
  )
}
