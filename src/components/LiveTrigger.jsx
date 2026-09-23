import { useState, useEffect, useRef } from 'react'

const METHODS       = ['POST','PUT','PATCH','GET','DELETE']
const CONTENT_TYPES = ['application/xml','application/json','text/xml','text/plain','application/x-www-form-urlencoded']
const AUTH_MODES    = ['Basic Auth','OAuth2 Client Credentials','No Auth']

const ERROR_HINTS = {
  401: 'Invalid credentials or missing ESBMessaging.send role. Check username/password.',
  403: 'Access denied. Ensure user has ESBMessaging.send role in BTP Cockpit. Also uncheck CSRF Protected on the sender.',
  404: 'Endpoint not found. Check iFlow is deployed and the path matches your HTTPS sender address.',
  415: 'Wrong Content-Type. Your iFlow sender may expect application/xml or application/json.',
  500: 'CPI internal error. Check iFlow logs in Monitor → Message Processing.',
  503: 'CPI runtime not available. Try restarting the iFlow from Monitor.',
}

function prettify(text, ct) {
  if (!text) return ''
  try {
    if (ct?.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      return JSON.stringify(JSON.parse(text), null, 2)
    }
    if (ct?.includes('xml') || text.trim().startsWith('<')) {
      const doc = new DOMParser().parseFromString(text, 'text/xml')
      const ser = new XMLSerializer()
      let raw = ser.serializeToString(doc)
      // Indent XML
      let indent = 0
      return raw
        .replace(/></g, '>\n<')
        .split('\n')
        .map(line => {
          if (line.match(/^<\//)) indent = Math.max(0, indent - 1)
          const out = '  '.repeat(indent) + line.trim()
          if (line.match(/^<[^/!?][^>]*[^/]>/) && !line.match(/<.*>.*<\/.*>/)) indent++
          return out
        })
        .join('\n')
    }
  } catch {}
  return text
}

function buildCPIErrorHint(status, body) {
  const hint = ERROR_HINTS[status]
  if (hint) return hint
  if (status === 0) return 'Network error — CPI tenant not reachable. Check host URL and your internet connection.'
  if (status >= 200 && status < 300) return null
  return `HTTP ${status} — check CPI message processing logs for details.`
}

export default function LiveTrigger() {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem('tf_live_config') || '{}') }
    catch { return {} }
  })()

  const [host,        setHost]        = useState(saved.host        || '')
  const [path,        setPath]        = useState(saved.path        || '')
  const [authMode,    setAuthMode]    = useState(saved.authMode    || 'Basic Auth')
  const [username,    setUsername]    = useState(saved.basicUsername || '')
  const [password,    setPassword]    = useState('')   // never persist password
  const [clientId,    setClientId]    = useState(saved.oauthClientId || '')
  const [clientSecret,setClientSecret]= useState('')   // never persist
  const [tokenUrl,    setTokenUrl]    = useState(saved.tokenUrl    || '')
  const [method,      setMethod]      = useState(saved.method      || 'POST')
  const [contentType, setContentType] = useState(saved.contentType || 'application/xml')
  const [customHdrs,  setCustomHdrs]  = useState(saved.customHdrs  || '')
  const [timeout,     setTimeout2]    = useState(saved.timeout     || 60)
  const [payload,     setPayload]     = useState('')
  const [result,      setResult]      = useState(null)
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState(null)
  const [responseTab, setRespTab]     = useState('pretty')
  const [showPwd,     setShowPwd]     = useState(false)
  const tokenCacheRef = useRef(null)   // { token, expiresAt, tokenUrl, clientId }

  // Persist config (no passwords)
  useEffect(() => {
    try {
      localStorage.setItem('tf_live_config', JSON.stringify({
        host, path, authMode,
        basicUsername: username,
        oauthClientId: clientId,
        tokenUrl, method, contentType, customHdrs, timeout
      }))
    } catch {}
  }, [host, path, authMode, username, clientId, tokenUrl, method, contentType, customHdrs, timeout])

  const finalUrl = host && path
    ? host.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path)
    : ''

  // Fetch an OAuth2 token, reusing the cache unless `force` is set.
  // `force` is used after a 401 — the cached token may have been revoked or
  // expired early, so we discard it and get a fresh one.
  async function getOAuthToken({ force = false } = {}) {
    const cache = tokenCacheRef.current
    const now = Date.now()
    if (!force && cache?.token && cache.expiresAt - 60000 > now &&
        cache.tokenUrl === tokenUrl && cache.clientId === clientId) {
      return cache.token
    }
    const tokenRes = await fetch('/api/live-trigger-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenUrl, clientId, clientSecret }),
    })
    const tokenData = await tokenRes.json()
    if (tokenData.error) throw new Error('OAuth2 error: ' + tokenData.error)
    tokenCacheRef.current = {
      token: tokenData.access_token,
      expiresAt: now + (Number(tokenData.expires_in) || 3600) * 1000,
      tokenUrl, clientId,
    }
    return tokenData.access_token
  }

  async function send() {
    if (!host) return setError('CPI Host URL is required')
    if (!finalUrl.startsWith('https://') && !finalUrl.startsWith('http://'))
      return setError('Host must start with https://')

    setLoading(true); setError(null); setResult(null)

    try {
      // Parse custom headers
      const parsedCustomHdrs = {}
      if (customHdrs.trim()) {
        customHdrs.split('\n').forEach(line => {
          const idx = line.indexOf(':')
          if (idx > 0) {
            const k = line.slice(0, idx).trim()
            const v = line.slice(idx + 1).trim()
            if (k) parsedCustomHdrs[k] = v
          }
        })
      }

      const doSend = async (authHeader) => {
        const res = await fetch('/api/live-trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            host, path, method, contentType, payload,
            username: authMode === 'Basic Auth' ? username : '',
            password: authMode === 'Basic Auth' ? password : '',
            authHeader,
            customHeaders: parsedCustomHdrs,
            timeout: parseInt(timeout) * 1000,
          }),
        })
        return res.json()
      }

      const isOAuth = authMode === 'OAuth2 Client Credentials'
      let authHeader = isOAuth ? 'Bearer ' + await getOAuthToken() : ''
      let data = await doSend(authHeader)

      // 401 with OAuth2 → the token was likely stale/revoked. Discard it, get a
      // fresh one, and retry ONCE. A second 401 is a real auth problem (wrong
      // client, missing ESBMessaging.send role) and is surfaced as-is.
      if (isOAuth && data?.status === 401) {
        authHeader = 'Bearer ' + await getOAuthToken({ force: true })
        const retried = await doSend(authHeader)
        data = { ...retried, retriedAfter401: true }
      }

      if (data.error && !data.status) throw new Error(data.error)
      setResult(data)
      setRespTab('pretty')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function downloadResponse() {
    if (!result?.body) return
    const blob = new Blob([result.body], { type: result.headers?.['content-type'] || 'text/plain' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = 'cpi-response.txt'; a.click()
    URL.revokeObjectURL(url)
  }

  const prettyBody  = prettify(result?.body, result?.headers?.['content-type'])
  const bodySize    = result?.body ? new Blob([result.body]).size : 0
  const statusColor = result ? (result.status >= 200 && result.status < 300 ? 'var(--green)' : 'var(--red)') : 'var(--text3)'
  const hint        = result ? buildCPIErrorHint(result.status, result.body) : null

  const inp = { background:'var(--bg)', border:'1px solid var(--border)', borderRadius:6, padding:'7px 10px', fontSize:13, color:'var(--text)', fontFamily:'inherit', width:'100%', boxSizing:'border-box' }

  return (
    <div style={{ display:'grid', gridTemplateColumns:'320px 1fr', height:'calc(100vh - 48px)', overflow:'hidden' }}>

      {/* ── Left panel ─────────────────────────────────────── */}
      <div style={{ borderRight:'1px solid var(--border)', overflowY:'auto', background:'var(--bg2)' }}>
        <div style={{ padding:'16px 18px', borderBottom:'1px solid var(--border)' }}>
          <div style={{ fontSize:17, fontWeight:700, color:'var(--text)', marginBottom:3 }}>Live Trigger</div>
          <div style={{ fontSize:12, color:'var(--text3)', lineHeight:1.5 }}>
            Fire a payload directly at your deployed CPI iFlow and see the real response.
          </div>
        </div>

        <div style={{ padding:'14px 18px', display:'flex', flexDirection:'column', gap:14 }}>

          {/* Host */}
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'var(--text2)', display:'block', marginBottom:5 }}>CPI Host URL *</label>
            <input style={inp} value={host} onChange={e=>setHost(e.target.value)}
              placeholder=""/>
          </div>

          {/* Path */}
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'var(--text2)', display:'block', marginBottom:5 }}>Endpoint Path *</label>
            <input style={inp} value={path} onChange={e=>setPath(e.target.value)} placeholder=""/>
            {finalUrl && <div style={{ fontSize:11, color:'var(--text3)', marginTop:4, wordBreak:'break-all' }}>
              {finalUrl}
            </div>}
          </div>

          {/* Method + Content-Type */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <div>
              <label style={{ fontSize:12, fontWeight:600, color:'var(--text2)', display:'block', marginBottom:5 }}>Method</label>
              <select style={{...inp}} value={method} onChange={e=>setMethod(e.target.value)}>
                {METHODS.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize:12, fontWeight:600, color:'var(--text2)', display:'block', marginBottom:5 }}>Timeout (s)</label>
              <input style={inp} type="number" value={timeout} onChange={e=>setTimeout2(e.target.value)} min={5} max={300}/>
            </div>
          </div>

          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'var(--text2)', display:'block', marginBottom:5 }}>Content-Type</label>
            <select style={{...inp}} value={contentType} onChange={e=>setContentType(e.target.value)}>
              {CONTENT_TYPES.map(ct => <option key={ct}>{ct}</option>)}
            </select>
          </div>

          {/* Auth */}
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'var(--text2)', display:'block', marginBottom:5 }}>Authentication</label>
            <select style={{...inp, marginBottom:8}} value={authMode} onChange={e=>setAuthMode(e.target.value)}>
              {AUTH_MODES.map(a => <option key={a}>{a}</option>)}
            </select>

            {authMode === 'Basic Auth' && <>
              <input style={{...inp, marginBottom:6}} value={username} onChange={e=>setUsername(e.target.value)} placeholder=""/>
              <div style={{ position:'relative' }}>
                <input style={{...inp, paddingRight:36}} type={showPwd?'text':'password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password (not saved)"/>
                <button onClick={()=>setShowPwd(s=>!s)} style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'var(--text3)', fontSize:13 }}>
                  {showPwd ? 'Hide' : 'Show'}
                </button>
              </div>
              {password && <button onClick={()=>setPassword('')} style={{ fontSize:11, color:'var(--text3)', background:'none', border:'none', cursor:'pointer', marginTop:4, padding:0 }}>Clear password</button>}
            </>}

            {authMode === 'OAuth2 Client Credentials' && <>
              <input style={{...inp, marginBottom:6}} value={tokenUrl} onChange={e=>setTokenUrl(e.target.value)} placeholder=""/>
              <input style={{...inp, marginBottom:6}} value={clientId} onChange={e=>setClientId(e.target.value)} placeholder=""/>
              <input style={{...inp}} type="password" value={clientSecret} onChange={e=>{setClientSecret(e.target.value); tokenCacheRef.current=null}} placeholder="Client Secret (not saved)"/>
            </>}
          </div>

          {/* Custom headers */}
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'var(--text2)', display:'block', marginBottom:5 }}>Custom Headers <span style={{fontWeight:400, color:'var(--text3)'}}>(optional, one per line)</span></label>
            <textarea style={{...inp, resize:'vertical', fontFamily:'JetBrains Mono, monospace', fontSize:12}} rows={3}
              value={customHdrs} onChange={e=>setCustomHdrs(e.target.value)}
              placeholder=""/>
          </div>

          {/* Payload */}
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'var(--text2)', display:'block', marginBottom:5 }}>Payload {method === 'GET' && <span style={{fontWeight:400, color:'var(--text3)'}}>(ignored for GET)</span>}</label>
            <div style={{ position:'relative' }}>
              <textarea style={{...inp, resize:'vertical', fontFamily:'JetBrains Mono, monospace', fontSize:12, minHeight:120}} rows={6}
                value={payload} onChange={e=>setPayload(e.target.value)}
                placeholder=""/>

            </div>
            {payload && <div style={{ fontSize:11, color:'var(--text3)', textAlign:'right' }}>{payload.length} chars</div>}
          </div>

          {/* Send button */}
          <button onClick={send} disabled={loading || !host}
            style={{ padding:'11px', borderRadius:8, border:'none', background: loading ? 'var(--bg4)' : 'linear-gradient(135deg,#238636,#3fb950)',
              color:'#fff', fontSize:14, fontWeight:700, cursor: loading||!host ? 'not-allowed' : 'pointer', fontFamily:'inherit',
              boxShadow: loading ? 'none' : '0 2px 12px rgba(63,185,80,.35)' }}>
            {loading ? 'Sending...' : `${method} to CPI`}
          </button>

          {error && <div style={{ padding:'10px 12px', borderRadius:6, background:'var(--red-bg)', border:'1px solid rgba(185,28,28,.25)', fontSize:13, color:'var(--red)' }}>
            {error}
          </div>}
        </div>
      </div>

      {/* ── Right panel — response ──────────────────────────── */}
      <div style={{ overflowY:'auto', display:'flex', flexDirection:'column' }}>
        {!result ? (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'var(--text3)', gap:12 }}>
            <div style={{ fontSize:40, opacity:.2 }}>⚡</div>
            <div style={{ fontSize:16, fontWeight:600, color:'var(--text2)' }}>No response yet</div>
            <div style={{ fontSize:13 }}>Fill in the config and click Send</div>
          </div>
        ) : (
          <div style={{ padding:'18px 20px', flex:1, display:'flex', flexDirection:'column', gap:14 }}>
            {/* Status bar */}
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', borderRadius:8, background:'var(--bg2)', border:'1px solid var(--border)', flexWrap:'wrap' }}>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <div style={{ width:10, height:10, borderRadius:'50%', background: statusColor }}/>
                <span style={{ fontWeight:700, fontSize:15, color: statusColor }}>HTTP {result.status}</span>
              </div>
              <span style={{ fontSize:13, color:'var(--text3)' }}>{result.durationMs}ms</span>
              {bodySize > 0 && <span style={{ fontSize:13, color:'var(--text3)' }}>{(bodySize/1024).toFixed(1)} KB</span>}
              {result.headers?.['content-type'] && <span style={{ fontSize:12, color:'var(--text3)', fontFamily:'monospace' }}>{result.headers['content-type']}</span>}
              {result.retriedAfter401 && (
                <span style={{ fontSize:11, padding:'2px 7px', borderRadius:4, background:'var(--amber-bg)', color:'var(--amber2)', fontWeight:600 }}
                  title="The first attempt returned 401, so the OAuth2 token was refreshed and the request retried once.">
                  token refreshed · retried
                </span>
              )}
              <div style={{display:'flex',gap:6,marginLeft:'auto'}}>
                <button onClick={()=>navigator.clipboard.writeText(result.body)} style={{ fontSize:12, padding:'4px 10px', borderRadius:5, border:'1px solid var(--border)', background:'var(--bg3)', cursor:'pointer', color:'var(--text2)', fontFamily:'inherit' }}>Copy</button>
                <button onClick={downloadResponse} style={{ fontSize:12, padding:'4px 10px', borderRadius:5, border:'1px solid var(--border)', background:'var(--bg3)', cursor:'pointer', color:'var(--text2)', fontFamily:'inherit' }}>Download</button>
              </div>
            </div>

            {/* Error hint */}
            {hint && result.status !== 200 && (
              <div style={{ padding:'10px 14px', borderRadius:8, background:'var(--amber-bg)', border:'1px solid rgba(180,83,9,.25)', fontSize:13, color:'var(--amber2)' }}>
                <strong>Hint:</strong> {hint}
              </div>
            )}

            {/* Response tabs */}
            <div style={{ display:'flex', gap:0, borderBottom:'1px solid var(--border)' }}>
              {['pretty','raw','headers'].map(t => (
                <button key={t} onClick={()=>setRespTab(t)}
                  style={{ padding:'7px 16px', fontSize:13, fontWeight: responseTab===t ? 600 : 400,
                    color: responseTab===t ? 'var(--blue)' : 'var(--text3)',
                    borderBottom: responseTab===t ? '2px solid var(--blue)' : '2px solid transparent',
                    background:'transparent', border:'none', cursor:'pointer', fontFamily:'inherit', textTransform:'capitalize' }}>
                  {t === 'pretty' ? 'Pretty' : t === 'raw' ? 'Raw' : 'Headers'}
                </button>
              ))}
            </div>

            {/* Response body */}
            <div style={{ flex:1, background:'var(--bg)', border:'1px solid var(--border)', borderRadius:8, overflow:'auto' }}>
              {responseTab === 'headers' ? (
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                  <tbody>
                    {Object.entries(result.headers || {}).map(([k,v]) => (
                      <tr key={k} style={{ borderBottom:'1px solid var(--border)' }}>
                        <td style={{ padding:'7px 14px', fontWeight:600, color:'var(--text2)', width:'40%', fontFamily:'monospace' }}>{k}</td>
                        <td style={{ padding:'7px 14px', color:'var(--text)', fontFamily:'monospace', wordBreak:'break-all' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <pre style={{ margin:0, padding:14, fontSize:12, fontFamily:'JetBrains Mono, monospace', color:'var(--text)', lineHeight:1.6, whiteSpace:'pre-wrap', wordBreak:'break-word' }}>
                  {responseTab === 'pretty' ? (prettyBody || result.body || '(empty response)') : (result.body || '(empty response)')}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
