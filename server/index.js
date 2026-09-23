import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import * as dotenv from 'dotenv'
import { generateSpecDocx, generateFromBuffer, scanTemplateBuffer, scanDefaultTemplate, readDefaultTemplate } from './specDocx.js'
import { isAllowedUrl } from './urlAllowlist.js'
import { listMessageProcessingLogs, fetchMessageTrace, fetchTracePayload } from './cpiTrace.js'
import { buildSpecFacts, factsForSection, buildAiSpecDocx, SPEC_SECTIONS } from './specAiDoc.js'
import { buildCombinedDocx, buildSeparateDocs, zipDocuments } from './specMultiFlow.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env from the PROJECT ROOT, not the current working directory —
// otherwise starting the server from anywhere else silently finds no key.
dotenv.config({ path: join(__dirname, '../.env') })

// Normalize the key: people routinely paste it with quotes or trailing spaces,
// both of which would otherwise fail the sk-ant- check for no visible reason.
if (process.env.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY.trim().replace(/^["']|["']$/g, '')
}

const app   = express()
const PORT  = process.env.PORT  || 3001
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'

// ── Security helpers ──────────────────────────────────────────────────────
// URL allowlist lives in ./urlAllowlist.js (shared with cpiTrace.js)

// Headers that must never be overridden by caller-supplied custom headers
const BLOCKED_REQUEST_HEADER_KEYS = new Set([
  'authorization','x-api-key','x-rapidapi-key','x-amz-security-token',
  'cookie','proxy-authorization','api-key','apikey','x-forwarded-for',
  'host','content-length','transfer-encoding',
])

// Headers masked in responses sent back to the frontend
const SENSITIVE_RESPONSE_HEADER_KEYS = new Set([
  'authorization','x-api-key','set-cookie','cookie','proxy-authorization',
])

// BTP/CPI host patterns allowed for Live Trigger.
// Covers: *.hana.ondemand.com, *.cfapps.*.hana.ondemand.com,
//         *.it-cpiXXX.cfapps.*.hana.ondemand.com, *.sap.com
// Strip sensitive keys from caller-supplied custom headers before forwarding
function cleanHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([k, v]) =>
        k && v != null &&
        typeof k === 'string' &&
        !/[\r\n]/.test(k) &&
        !BLOCKED_REQUEST_HEADER_KEYS.has(k.trim().toLowerCase())
      )
      .map(([k, v]) => [k.trim(), String(v)])
  )
}

// ── CORS + body ───────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:4173',
    process.env.FRONTEND_URL,
  ].filter(Boolean)
}))
app.use(express.json({ limit: '75mb' }))

// ── Access gate + rate limiting ───────────────────────────────────────────
// The server proxies a paid Anthropic key and relays requests to CPI tenants,
// so a public deployment must not be wide open. Set APP_PASSWORD in the
// environment (e.g. on Render) and every /api route except /api/health
// requires the matching `x-shipbridge-key` header. Unset = open (local dev).
import { timingSafeEqual } from 'crypto'
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim()

function keyMatches(supplied) {
  const a = Buffer.from(String(supplied || ''))
  const b = Buffer.from(APP_PASSWORD)
  return a.length === b.length && timingSafeEqual(a, b)
}

app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD) return next()
  if (req.path === '/health') return next()
  if (keyMatches(req.headers['x-shipbridge-key'])) return next()
  res.status(401).json({ error: 'Access key required', code: 'UNAUTHORIZED' })
})

// Minimal in-memory sliding-window limiter — per IP, per bucket. Enough to
// stop a scripted drain of the AI endpoints; not a substitute for a WAF.
const rateBuckets = new Map()
function rateLimit({ windowMs, max, bucket }) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown'
    const key = `${bucket}:${ip}`
    const now = Date.now()
    const hits = (rateBuckets.get(key) || []).filter(t => now - t < windowMs)
    if (hits.length >= max) {
      return res.status(429).json({ error: 'Too many requests. Wait a moment and retry.', code: 'RATE_LIMITED' })
    }
    hits.push(now)
    rateBuckets.set(key, hits)
    next()
  }
}
// Sweep stale buckets so the map can't grow unbounded.
setInterval(() => {
  const now = Date.now()
  for (const [k, hits] of rateBuckets) {
    const live = hits.filter(t => now - t < 10 * 60_000)
    if (live.length) rateBuckets.set(k, live); else rateBuckets.delete(k)
  }
}, 60_000).unref()

// AI endpoints spend real money per call — tighter budget.
const AI_ROUTES = ['/api/simulate', '/api/spec-generate-field', '/api/spec-describe-fields',
  '/api/cpi-trace/explain', '/api/spec-ai-generate', '/api/spec-ai-section',
  '/api/spec-describe-image', '/api/spec-ai-scripts', '/api/spec-flow-fields']
app.use(AI_ROUTES, rateLimit({ windowMs: 60_000, max: 30, bucket: 'ai' }))
app.use('/api', rateLimit({ windowMs: 60_000, max: 240, bucket: 'general' }))

// Turn body-parser failures (payload too large, malformed JSON) into a clear
// JSON error. Without this Express drops the connection and the browser shows
// a bare "Failed to fetch" with no explanation.
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Upload too large. Your template + screenshots exceed the size limit. Try smaller/fewer images — ShipBridge already downsizes them, but very large originals can still be too big.' })
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed request body.' })
  }
  if (err) return res.status(400).json({ error: err.message || 'Request error' })
  next()
})

// ── AI simulation ─────────────────────────────────────────────────────────
app.post('/api/simulate', async (req, res) => {
  const { system, message, history } = req.body
  if (!system || !message) return res.status(400).json({ error: 'Missing system or message' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.startsWith('sk-ant-')) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured. Add it to .env and restart.' })
  }

  // Prior turns (if any) go before the current message so the model has
  // conversation context. Only role/content are trusted from the client.
  const priorTurns = Array.isArray(history)
    ? history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map(m => ({ role: m.role, content: m.content }))
    : []

  try {
    const { default: fetch } = await import('node-fetch')
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2048, stream: true, system,
        messages: [...priorTurns, { role: 'user', content: message }],
      }),
    })

    if (!upstream.ok) {
      let msg = `Claude API error ${upstream.status}`
      try {
        const e = await upstream.json()
        if (e.error?.type === 'authentication_error') msg = 'Invalid API key. Check ANTHROPIC_API_KEY in .env'
        else if (e.error?.type === 'rate_limit_error') msg = 'Rate limit hit. Wait a moment and retry.'
        else if (e.error?.message) msg = e.error.message
      } catch {}
      return res.status(upstream.status).json({ error: msg })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    upstream.body.pipe(res)
    upstream.body.on('error', () => res.end())
    req.on('close', () => upstream.body.destroy())
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// ── OAuth2 token (never logs secrets) ─────────────────────────────────────
app.post('/api/live-trigger-token', async (req, res) => {
  const { tokenUrl, clientId, clientSecret } = req.body
  if (!tokenUrl || !clientId) return res.status(400).json({ error: 'tokenUrl and clientId required' })
  if (!isAllowedUrl(tokenUrl)) return res.status(400).json({ error: 'Token URL must use https://' })

  try {
    const { default: fetch } = await import('node-fetch')
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret || '',
    })
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.error_description || data.error || 'Token request failed' })
    res.json({ access_token: data.access_token, token_type: data.token_type, expires_in: data.expires_in })
  } catch (err) {
    res.status(500).json({ error: 'OAuth2 error: ' + err.message })
  }
})

// ── Live Trigger (never logs credentials) ─────────────────────────────────
app.post('/api/live-trigger', async (req, res) => {
  const {
    host, path: urlPath, method,
    username, password, authHeader,
    contentType, payload, customHeaders,
    timeout: timeoutMs,
  } = req.body

  if (!host) return res.status(400).json({ error: 'host is required', code: 'MISSING_HOST' })
  if (!isAllowedUrl(host)) {
    return res.status(400).json({
      error: 'Invalid host. Live Trigger only connects to *.hana.ondemand.com (SAP BTP/CPI) or localhost. Add custom hosts via ALLOWED_HOSTS in .env.',
      code: 'INVALID_HOST',
    })
  }

  try {
    const { default: fetch } = await import('node-fetch')
    const url   = `${host.replace(/\/$/, '')}${urlPath || '/http/trigger'}`
    const start = Date.now()

    // Build auth — credentials stay in memory, never logged
    let authorization = authHeader || ''
    if (!authorization && (username || password)) {
      authorization = 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64')
    }

    const headers = {
      'Content-Type': contentType || 'application/xml',
      ...(authorization ? { 'Authorization': authorization } : {}),
      ...cleanHeaders(customHeaders),
    }

    const httpMethod = (method || 'POST').toUpperCase()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(parseInt(timeoutMs) || 60000, 300000))

    const upstream = await fetch(url, {
      method: httpMethod,
      headers,
      body: ['GET', 'HEAD'].includes(httpMethod) ? undefined : (payload || ''),
      signal: controller.signal,
      // Don't auto-follow: an allowlisted host could 302 to an internal
      // address, and node-fetch would follow it past the allowlist. Surface
      // the redirect to the caller instead.
      redirect: 'manual',
    }).finally(() => clearTimeout(timer))

    const body = await upstream.text()
    const resHeaders = {}
    upstream.headers.forEach((v, k) => {
      resHeaders[k] = SENSITIVE_RESPONSE_HEADER_KEYS.has(k.toLowerCase()) ? '***' : v
    })

    res.json({ status: upstream.status, body, headers: resHeaders, durationMs: Date.now() - start, url })
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timed out. CPI did not respond in time.', code: 'TIMEOUT' })
    }
    res.status(500).json({ error: `Cannot reach CPI: ${err.message}`, code: 'NETWORK_ERROR' })
  }
})


// ── Checkpoint endpoint ────────────────────────────────────────────────────
// Holds the HTTP connection open until the user clicks Release/Abort
const checkpointWaiters = new Map()
const MAX_PENDING_CHECKPOINTS = 50

app.post('/api/checkpoint', (req, res) => {
  // Reject when too many checkpoints are already pending — prevents unbounded growth
  if (checkpointWaiters.size >= MAX_PENDING_CHECKPOINTS) {
    return res.status(429).json({
      error: `Too many pending checkpoints (max ${MAX_PENDING_CHECKPOINTS}). Release or abort existing ones first.`,
      code: 'CHECKPOINT_LIMIT',
    })
  }
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2)
  const session = {
    id,
    iflowName:  req.body.iflowName  || 'Unknown iFlow',
    stepLabel:  req.body.stepLabel  || 'Checkpoint',
    body:       req.body.body       || '',
    headers:    req.body.headers    || {},
    properties: req.body.properties || {},
    receivedAt: new Date().toISOString(),
    status: 'waiting'
  }

  // Store the response object so we can release it later
  checkpointWaiters.set(id, { res, session })

  // Notify SSE listeners about new checkpoint
  broadcastCheckpoint({ type: 'new', session })

  // If not released within 5 minutes, auto-release unchanged
  const timeout = setTimeout(() => {
    if (checkpointWaiters.has(id)) {
      checkpointWaiters.get(id).res.json({ body: session.body, headers: {}, properties: {}, abort: false })
      checkpointWaiters.delete(id)
      broadcastCheckpoint({ type: 'timeout', id })
    }
  }, 300000)

  // Clean up if the held connection closes (CPI side gave up / network drop).
  // Deleting the waiter matters as much as clearing the timer: without it,
  // dead entries accumulate until MAX_PENDING_CHECKPOINTS permanently rejects
  // new checkpoints until a server restart.
  res.on('close', () => {
    clearTimeout(timeout)
    if (checkpointWaiters.has(id)) {
      checkpointWaiters.delete(id)
      broadcastCheckpoint({ type: 'closed', id })
    }
  })
})

// Release a checkpoint (called from the UI)
app.post('/api/checkpoint/:id/release', (req, res) => {
  const { id } = req.params
  const waiter = checkpointWaiters.get(id)
  if (!waiter) return res.status(404).json({ error: 'Checkpoint not found or already released' })

  const { body, properties, headers, abort } = req.body
  waiter.res.json({ body: body || waiter.session.body, properties: properties || {}, headers: headers || {}, abort: !!abort })
  checkpointWaiters.delete(id)
  broadcastCheckpoint({ type: 'released', id, abort: !!abort })
  res.json({ ok: true })
})

// SSE stream so the UI gets notified of new checkpoints in real time
const checkpointListeners = new Set()

app.get('/api/checkpoint/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection',    'keep-alive')
  res.write('data: {"type":"connected"}\n\n')
  checkpointListeners.add(res)
  req.on('close', () => checkpointListeners.delete(res))
})

function broadcastCheckpoint(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`
  checkpointListeners.forEach(r => { try { r.write(msg) } catch {} })
}

// ── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const key   = process.env.ANTHROPIC_API_KEY || ''
  const keyOk = key.startsWith('sk-ant-') && key.length > 20
  res.json({ status: 'ok', apiKeyConfigured: keyOk, model: MODEL })
})

// ── Spec document (.docx) generation via template substitution ────────────
// GET  /api/spec-template — returns the token list for the default Motiveminds template
// POST /api/spec-scan-template — accepts a base64 .docx, returns its tokens
// POST /api/spec-docx — generates a .docx (uses default or uploaded template)

app.get('/api/spec-template', async (req, res) => {
  try {
    const info = await scanDefaultTemplate()
    res.json({ ...info, kind: 'default', name: 'Motiveminds Standard' })
  } catch (e) {
    console.error('spec-template error:', e.message)
    res.status(500).json({ error: 'Failed to load default template' })
  }
})

app.post('/api/spec-scan-template', async (req, res) => {
  try {
    const { base64 } = req.body || {}
    if (!base64) return res.status(400).json({ error: 'base64 template required' })
    const buffer = Buffer.from(base64, 'base64')
    const info = await scanTemplateBuffer(buffer)
    res.json({ ...info, kind: 'uploaded' })
  } catch (e) {
    console.error('spec-scan-template error:', e.message)
    res.status(400).json({ error: e.message || 'Failed to scan template' })
  }
})

app.post('/api/spec-docx', async (req, res) => {
  try {
    const { values, filename, templateBase64, adapters, images } = req.body || {}
    if (!values || typeof values !== 'object') {
      return res.status(400).json({ error: 'values object required' })
    }
    const buffer = templateBase64
      ? await generateFromBuffer(Buffer.from(templateBase64, 'base64'), values, adapters, images)
      : await generateSpecDocx(values, adapters, images)
    const safe = (filename || values.INTERFACE_NAME || 'spec')
      .replace(/[^a-z0-9]+/gi, '_').slice(0, 80)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.docx"`)
    res.send(buffer)
  } catch (e) {
    console.error('spec-docx error:', e.message)
    res.status(500).json({ error: e.message || 'Failed to generate document' })
  }
})

// AI drafting for one spec field, grounded in extracted facts. Non-streaming.
app.post('/api/spec-generate-field', async (req, res) => {
  const { field, facts, currentValue } = req.body || {}
  if (!field) return res.status(400).json({ error: 'field required' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.startsWith('sk-ant-')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  try {
    const { default: fetch } = await import('node-fetch')
    const system = `You draft one field of a SAP CPI Technical Specification document.
Rules: Use ONLY the facts provided — never invent adapter names, URLs, systems or credentials.
Write in the terse professional style of SAP integration specs. No markdown, no headings, plain text only.
Return ONLY the field text, nothing else. 1-3 sentences unless the field is a bullet list (then one line per bullet).`
    const message = `Field to draft: ${field}\n\nExtracted facts from the iFlow:\n${JSON.stringify(facts || {}, null, 2)}\n${currentValue ? `\nUser's current draft (improve it): ${currentValue}` : ''}`
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: [{ role: 'user', content: message }] }),
    })
    const data = await upstream.json()
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error?.message || 'AI error' })
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim()
    res.json({ text })
  } catch (e) {
    console.error('spec-generate-field error:', e.message)
    res.status(500).json({ error: 'Generation failed' })
  }
})

// AI describes each template field so the form is self-explanatory. Takes the
// tokens + their surrounding template text (from scanTemplateBuffer) and
// returns, per token: a plain-English description, a suggested input type, and
// a placeholder example. One AI call for the whole template. Best-effort:
// if AI is unavailable, the frontend falls back to humanized token names.
app.post('/api/spec-describe-fields', async (req, res) => {
  const { tokens, tokenContext } = req.body || {}
  if (!Array.isArray(tokens) || !tokens.length) return res.status(400).json({ error: 'tokens[] required' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.startsWith('sk-ant-')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  try {
    const { default: fetch } = await import('node-fetch')
    const system = `You label form fields for a SAP CPI Technical Specification builder.
Given placeholder token names and the surrounding text from a Word template, describe what each field should contain.
For each token return: "label" (2-4 word human name), "help" (one short sentence explaining what to enter), "type" ("short" for a line, "long" for a paragraph, or "date"), and "example" (a brief realistic example value).
Base your answer on the token name AND its surrounding context. Do not invent specific system names or URLs in examples — keep examples generic.
Return ONLY a JSON object mapping each token to its {label, help, type, example}. No markdown, no prose, no code fences.`
    const message = `Tokens and their context from the template:\n${JSON.stringify(
      tokens.map(t => ({ token: t, ...(tokenContext?.[t] || {}) })), null, 2)}`
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages: [{ role: 'user', content: message }] }),
    })
    const data = await upstream.json()
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error?.message || 'AI error' })
    let text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim()
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    let fields
    try { fields = JSON.parse(text) } catch { return res.status(502).json({ error: 'AI returned an unparseable response' }) }
    res.json({ fields })
  } catch (e) {
    console.error('spec-describe-fields error:', e.message)
    res.status(500).json({ error: 'Field description failed' })
  }
})

// ── CPI Trace fetch ────────────────────────────────────────────────────────
// Reads Message Processing Logs and trace data from the user's CPI tenant.
// Credentials (clientid/clientsecret) are passed per-request and never logged.

function validateTenantInput(req, res) {
  const { tenantUrl, tokenUrl, clientId, clientSecret } = req.body || {}
  if (!tenantUrl || !tokenUrl || !clientId) {
    res.status(400).json({ error: 'tenantUrl, tokenUrl, clientId required' })
    return null
  }
  if (!isAllowedUrl(tenantUrl) || !isAllowedUrl(tokenUrl)) {
    res.status(400).json({ error: 'Tenant or token URL not on allowlist (must be a *.hana.ondemand.com or *.sap.com host)' })
    return null
  }
  return { tenantUrl, tokenUrl, clientId, clientSecret }
}

app.post('/api/cpi-trace/list', async (req, res) => {
  const creds = validateTenantInput(req, res); if (!creds) return
  const { iflowName, correlationId, sinceMinutes, top } = req.body || {}
  try {
    const result = await listMessageProcessingLogs({ ...creds, iflowName, correlationId, sinceMinutes, top })
    res.json(result)
  } catch (err) {
    console.error('cpi-trace/list error:', err.message)
    res.status(err.status || 500).json({ error: err.message })
  }
})

app.post('/api/cpi-trace/fetch', async (req, res) => {
  const creds = validateTenantInput(req, res); if (!creds) return
  const { messageGuid } = req.body || {}
  if (!messageGuid) return res.status(400).json({ error: 'messageGuid required' })
  try {
    const result = await fetchMessageTrace({ ...creds, messageGuid })
    res.json(result)
  } catch (err) {
    console.error('cpi-trace/fetch error:', err.message)
    res.status(err.status || 500).json({ error: err.message })
  }
})

app.post('/api/cpi-trace/payload', async (req, res) => {
  const creds = validateTenantInput(req, res); if (!creds) return
  const { traceMessageId } = req.body || {}
  if (!traceMessageId) return res.status(400).json({ error: 'traceMessageId required' })
  try {
    const result = await fetchTracePayload({ ...creds, traceMessageId })
    res.json(result)
  } catch (err) {
    console.error('cpi-trace/payload error:', err.message)
    // CPI's payload endpoint throws a raw Java "Array index out of range: 0"
    // when the payload row exists in metadata but the actual bytes are gone or
    // empty — most often because trace retention (~1 hour) already swept them,
    // or because the step never carried a body (end events, some routers).
    // Surface that plainly instead of a scary "500 Internal Server Error".
    const looksLikeEmpty = /array index out of range|index[:\s]+0/i.test(err.message || '')
    if (looksLikeEmpty) {
      return res.status(404).json({
        error: 'Payload unavailable',
        reason: 'expired-or-empty',
        detail: 'CPI has this trace message recorded but no body bytes to return. Either the ~1-hour trace retention has already expired, or this step never carried a payload (common for end events and some routers). Fire a fresh message with Trace log level to capture new payloads.',
      })
    }

    // A 403 on the payload endpoint while RunSteps reads fine is NOT a missing
    // role — the same token just fetched the step list. In practice it means
    // CPI no longer has the bytes: trace payloads are kept about an hour, and
    // once swept, CPI refuses the read rather than returning empty. Saying
    // "Forbidden" sends people to BTP to hunt a permission that isn't the
    // problem, so say what it actually means.
    if (err.status === 403) {
      return res.status(403).json({
        error: 'Payload no longer available',
        reason: 'trace-expired',
        detail: 'CPI kept this step\'s metadata but has already discarded its message body. Trace payloads are retained for roughly an hour. Because the step list and headers loaded with the same credentials, this is not a permissions problem — fire a fresh message with the iFlow at Trace log level and open that run instead.',
      })
    }

    res.status(err.status || 500).json({ error: err.message })
  }
})

// AI explains a trace step — or the whole run — grounded strictly in real
// extracted facts: the CPI runtime record, captured headers/exchange
// properties, payloads, and (when the iFlow ZIP is loaded) the step's actual
// design config. This is the one thing CPI's monitor cannot do: it shows WHAT
// happened but never WHY. Facts come from the trace; AI only explains.
// Streams so text appears as it's written rather than after a dead pause.
app.post('/api/cpi-trace/explain', async (req, res) => {
  const { step, steps, design, designs, payloadBefore, payloadAfter, flowName, mode, question } = req.body || {}
  const wholeRun = mode === 'run'
  if (!wholeRun && !step) return res.status(400).json({ error: 'step required' })
  if (wholeRun && !Array.isArray(steps)) return res.status(400).json({ error: 'steps[] required for run mode' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.startsWith('sk-ant-')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  const GROUNDING = `ABSOLUTE RULE: use ONLY the facts given. Never invent values. If something isn't in the data, say so — do not guess.
Be extremely terse. The reader is a consultant debugging live. No preamble. Max 4-5 lines total.`

    const systemStep = `You explain ONE step of a real SAP CPI execution in 3-5 lines total.

${GROUNDING}

Line 1: What it did (one sentence).
Line 2-3: What changed — only headers/properties/body that actually appear in the data.
Line 4 (only if needed): Flag an error or suspicious value. If clean, stop at line 3.`

    const systemRun = `You explain a complete SAP CPI execution in 4-6 lines total.

${GROUNDING}

Line 1-2: What came in, what happened, what went out.
Line 3: Where time was spent (only if one step dominates).
Line 4-5: Any errors or flags. If clean, say so in one line.
Do not narrate every step — the reader sees the step list already.`

  try {
    const { default: fetch } = await import('node-fetch')

    let system, userContent
    if (wholeRun) {
      system = systemRun
      const facts = {
        flowName: flowName || null,
        stepCount: steps.length,
        steps: steps.slice(0, 40).map(s => ({
          modelStepId: s.ModelStepId, activity: s.Activity, status: s.Status,
          error: s.Error, branch: s.BranchId,
          startedAt: s.StepStart, endedAt: s.StepStop,
          designName: s.__designName || null, designKind: s.__designKind || null,
          headerCount: (s.Headers || []).length,
          payloadPreview: s.__payload ? String(s.__payload).slice(0, 1500) : null,
        })),
        designFromIFlowZip: designs || '(iFlow ZIP not loaded — no design config available)',
      }
      userContent = `Explain this whole CPI run.\n\n${JSON.stringify(facts, null, 2)}`
    } else {
      system = systemStep
      const facts = {
        flowName: flowName || null,
        step: {
          modelStepId: step.ModelStepId, stepId: step.StepId, activity: step.Activity,
          status: step.Status, error: step.Error, branch: step.BranchId,
          startedAt: step.StepStart, endedAt: step.StepStop,
        },
        // Cap these — a trace can carry 30+ headers and a large body.
        headers: (step.Headers || []).slice(0, 40),
        exchangeProperties: (step.ExchangeProperties || []).slice(0, 40),
        designFromIFlowZip: design || '(iFlow ZIP not loaded — no design config available)',
        payloadEnteringStep: payloadBefore ? String(payloadBefore).slice(0, 6000) : '(not captured)',
        payloadAfterStep: payloadAfter ? String(payloadAfter).slice(0, 6000) : '(not captured)',
      }
      userContent = `Explain this CPI step.\n\n${JSON.stringify(facts, null, 2)}`
    }

    // A follow-up question ("why was this slow?") reuses the same grounded facts.
    if (question) userContent += `\n\nThe consultant asks specifically: ${question}\nAnswer that question directly, still using only the facts above.`

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: wholeRun ? 600 : 350, stream: true, system,
        messages: [{ role: 'user', content: userContent }],
      }),
    })

    if (!upstream.ok) {
      let msg = `AI error ${upstream.status}`
      try { const e = await upstream.json(); msg = e.error?.message || msg } catch {}
      return res.status(upstream.status).json({ error: msg })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    upstream.body.pipe(res)
    upstream.body.on('error', () => res.end())
    req.on('close', () => upstream.body.destroy())
  } catch (e) {
    console.error('cpi-trace/explain error:', e.message)
    if (!res.headersSent) res.status(500).json({ error: 'Explanation failed' })
  }
})

// ── AI Spec generation ────────────────────────────────────────────────────
//
// Generates a full technical specification from a parsed iFlow. The AI writes
// the narrative sections ONLY — every checkable fact (step order, adapter
// types, timeouts, Content Modifier tables, Groovy source, credential aliases)
// is extracted from the iFlow XML and rendered as tables alongside the prose.
// The AI receives those same facts as grounding, so the prose and the tables
// cannot contradict each other.

// Per-section briefs. Generating each section as its own small call is what
// makes this both fast and reliable: nine short prompts run concurrently
// (wall-clock cost of roughly one), each response is small enough that it can't
// be truncated mid-thought, and a single failed section no longer costs the
// whole document.
const SECTION_BRIEFS = {
  overview:             'What this integration does, what triggers it, what it produces. 1-2 sentences.',
  highLevelDesign:      'The integration pattern in one sentence (synchronous, async, splitter, etc).',
  messageFlow:          'One sentence summarizing the message path. The step table below shows each step — do not list them here.',
  technicalDescription: 'Only config NOT visible in the Content Modifier and script tables below. If everything is in the tables, say so in one sentence.',
  senderReceiver:       'One sentence. The adapter table below has the full detail.',
  mappings:             'Transformations applied to the message. If there are no mappings configured, say exactly that in one sentence and stop.',
  security:             'One sentence on the auth method. The credential table below lists aliases.',
  errorHandling:        'Exception handling in one sentence. If none configured, say so.',
  appendix:             'One sentence. The artifact table below lists everything.',
}

const SPEC_SYSTEM = `You write SAP Cloud Integration technical specification documents for integration consultants.

You are given an EXTRACTED FACT SHEET from a real iFlow — its steps in execution order, adapter configuration, Content Modifier tables, Groovy source, and security settings.

ABSOLUTE RULES:
- Use ONLY the facts provided. Never invent endpoint URLs, system names, timeouts, credential names, queue names, or business context that isn't in the fact sheet.
- If the flow doesn't use the feature a section is about, say so plainly in one sentence. Do not pad.
- Business context (why this integration exists, which business process it serves) is NOT in the fact sheet. Do not guess it — describe what the flow technically does.
- Do not reproduce the raw tables; they are rendered separately in the document. Describe and interpret instead.

Write for a technical reader who will maintain this integration in two years. Specific and concrete, plain prose.

LENGTH DISCIPLINE — this matters as much as accuracy:
- Say the thing once. Never restate a fact that a table in the document already shows.
- Cut anything a competent integration consultant already knows. Do not explain what an adapter is, what ProcessDirect does, or why error handling is good practice.
- No filler openings ("This section describes…", "In this integration…") and no summary closings.
- If a section has one sentence worth of content, write one sentence. Short is a feature, not a gap.
- Prefer a short bullet list over a paragraph when listing more than two things.

Return ONLY the body text for the requested section. No heading, no JSON, no markdown fences, no preamble.`

// One section, one call. Returns plain text — no JSON envelope, so there is
// nothing to escape and nothing to fail parsing.
// How much prose each section gets. The default is deliberately BRIEF —
// a specification that buries the reader is worse than a short one, and an
// over-long section is far more annoying to trim than a short one is to expand.
const DETAIL_LEVELS = {
  brief:    { maxTokens: 250,  guidance: 'Maximum brevity: 1-2 sentences only. State only what is NOT already visible in the tables below this section. Omit anything a reader can see in the step table, adapter table, or Content Modifier tables. No preamble, no restating the section title, no repeating facts the tables already show.' },
  standard: { maxTokens: 750,  guidance: 'Keep it tight: one short paragraph, or up to 5 bullets.' },
  detailed: { maxTokens: 1400, guidance: 'Give a fuller treatment where the facts support it, but never pad — if a section has little to say, say little.' },
}

async function generateSection({ apiKey, sectionKey, sectionTitle, facts, instruction, context, detail }) {
  const { default: fetch } = await import('node-fetch')
  const brief = SECTION_BRIEFS[sectionKey] || 'Write this section from the fact sheet.'
  const slice = factsForSection(facts, sectionKey)
  const level = DETAIL_LEVELS[detail] || DETAIL_LEVELS.brief

  const body = {
    model: MODEL, max_tokens: level.maxTokens, system: SPEC_SYSTEM,
    messages: [{ role: 'user', content:
      `FACT SHEET:\n${JSON.stringify(slice, null, 2)}\n\n` +
      // Author context is business knowledge the iFlow XML cannot contain —
      // which system owns the data, why the integration exists. It's the one
      // input that legitimately isn't extracted, so it's marked as the
      // author's own words rather than something to infer from.
      (context ? `CONTEXT FROM THE AUTHOR (their own words — trust this, but do not invent beyond it):\n${context}\n\n` : '') +
      `Write the "${sectionTitle}" section.\n${brief}\n${level.guidance}` +
      (instruction ? `\n\nThe author asks specifically: ${instruction}` : '') }],
  }

  // One retry on 429/529 — nine concurrent calls can briefly trip a rate limit,
  // and losing a section to that would be a poor reason to fail.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    })
    if (r.ok) {
      const data = await r.json()
      return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim()
    }
    if ((r.status === 429 || r.status === 529) && attempt === 0) {
      await new Promise(res => setTimeout(res, 1500))
      continue
    }
    const e = await r.json().catch(() => ({}))
    throw new Error(e.error?.message || `AI error ${r.status}`)
  }
}

app.post('/api/spec-ai-generate', async (req, res) => {
  const { flow, context, detail } = req.body || {}
  if (!flow || !flow.steps) return res.status(400).json({ error: 'flow (parsed iFlow model) required' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.startsWith('sk-ant-')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  try {
    const facts = buildSpecFacts(flow)

    // All sections at once. Settled rather than all-or-nothing: a section that
    // fails comes back empty with its error recorded, and the other eight are
    // still there to work with.
    const results = await Promise.allSettled(
      SPEC_SECTIONS.map(sec =>
        generateSection({ apiKey, sectionKey: sec.key, sectionTitle: sec.title, facts, context, detail })
          .then(text => ({ key: sec.key, text }))
      )
    )

    const sections = {}
    const errors = {}
    results.forEach((r, i) => {
      const key = SPEC_SECTIONS[i].key
      if (r.status === 'fulfilled') sections[key] = r.value.text
      else { sections[key] = ''; errors[key] = r.reason?.message || 'Generation failed' }
    })

    // Facts go back too — the client renders them and sends them to the docx
    // endpoint, so extraction happens exactly once.
    res.json({ sections, facts, errors: Object.keys(errors).length ? errors : undefined })
  } catch (e) {
    console.error('spec-ai-generate error:', e.message)
    res.status(500).json({ error: `Spec generation failed: ${e.message}` })
  }
})

// Regenerate ONE section — used by the per-section "Regenerate" button so a
// user unhappy with one paragraph doesn't have to redo the whole document.
// Same code path as the bulk generate, so the two can't drift apart.
app.post('/api/spec-ai-section', async (req, res) => {
  const { flow, sectionKey, sectionTitle, instruction, context, detail } = req.body || {}
  if (!flow || !sectionKey) return res.status(400).json({ error: 'flow and sectionKey required' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.startsWith('sk-ant-')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  try {
    const facts = buildSpecFacts(flow)
    const text = await generateSection({
      apiKey, sectionKey, sectionTitle: sectionTitle || sectionKey, facts, instruction, context, detail,
    })
    res.json({ text })
  } catch (e) {
    console.error('spec-ai-section error:', e.message)
    res.status(500).json({ error: `Section generation failed: ${e.message}` })
  }
})

// Explain each Groovy script individually, so the document can pair every
// script's source with a description of that specific script — rather than one
// paragraph vaguely covering all of them. One AI call for all scripts, keyed
// by step name so the pairing can't drift.
// Describe an attached screenshot. Claude reads the image itself — this is a
// real description of what's pictured, not a guess from the filename.
app.post('/api/spec-describe-image', async (req, res) => {
  const { base64, mime, flowName, sectionTitle } = req.body || {}
  if (!base64) return res.status(400).json({ error: 'base64 image required' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.startsWith('sk-ant-')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  const mediaType = (mime || '').includes('png') ? 'image/png'
    : (mime || '').includes('webp') ? 'image/webp'
    : (mime || '').includes('gif') ? 'image/gif' : 'image/jpeg'

  try {
    const { default: fetch } = await import('node-fetch')
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 300,
        system: `You write figure captions for SAP Cloud Integration technical specification documents.
Describe what the screenshot actually shows, in one or two sentences, as a caption a technical reader would find useful.
Describe only what is visibly in the image. Do not speculate about anything outside the frame. No preamble, no "This image shows" — write the caption directly.`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: `Caption this screenshot.${flowName ? ` It relates to the integration flow "${flowName}".` : ''}${sectionTitle ? ` It appears in the "${sectionTitle}" section.` : ''}` },
          ],
        }],
      }),
    })
    const data = await upstream.json()
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error?.message || 'AI error' })
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim()
    res.json({ caption: text })
  } catch (e) {
    console.error('spec-describe-image error:', e.message)
    res.status(500).json({ error: 'Image description failed' })
  }
})

app.post('/api/spec-ai-scripts', async (req, res) => {
  const { flow } = req.body || {}
  if (!flow?.steps) return res.status(400).json({ error: 'flow required' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.startsWith('sk-ant-')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  try {
    const facts = buildSpecFacts(flow)
    const withSource = facts.scripts.filter(s => s.source)
    if (!withSource.length) return res.json({ explanations: {} })

    const { default: fetch } = await import('node-fetch')
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 2500,
        system: `You explain Groovy scripts from SAP Cloud Integration iFlows, for a technical specification document.

For each script, write 2-4 sentences covering: what it does to the message, which headers or properties it reads or sets, and anything a maintainer should know (external calls, error handling, assumptions about the payload).

Describe only what the code actually does. Do not speculate about intent beyond what's written, and do not invent behaviour the script doesn't contain. If a script is trivial, say so briefly rather than padding.

Return ONLY a JSON object mapping each script's step name to its explanation string. No markdown fences, no prose outside the JSON.`,
        messages: [{ role: 'user', content: JSON.stringify(
          withSource.map(s => ({ stepName: s.stepName, file: s.file, source: String(s.source).slice(0, 6000) })), null, 2) }],
      }),
    })
    const data = await upstream.json()
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error?.message || 'AI error' })

    let text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim()
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    let explanations
    try { explanations = JSON.parse(text) }
    catch { return res.status(502).json({ error: 'AI returned an unparseable script response' }) }
    res.json({ explanations })
  } catch (e) {
    console.error('spec-ai-scripts error:', e.message)
    res.status(500).json({ error: 'Script explanation failed' })
  }
})

// Build the .docx for the AI spec path. Unlike the two template paths, there's
// no client template to preserve here — the document is generated from
// scratch, so it's code-generated with docx-js rather than substituted.
app.post('/api/spec-ai-docx', async (req, res) => {
  const { flow, facts: clientFacts, sections, images, meta, scriptExplanations, detail } = req.body || {}
  if (!sections) return res.status(400).json({ error: 'sections required' })
  try {
    // Prefer re-deriving facts from the flow so the document can't drift from
    // the source; fall back to what the client holds if the flow wasn't sent.
    const facts = flow?.steps ? buildSpecFacts(flow) : clientFacts
    if (!facts) return res.status(400).json({ error: 'flow or facts required' })

    const buffer = await buildAiSpecDocx({ facts, sections, images: images || [], meta: meta || {}, scriptExplanations: scriptExplanations || {}, detail: detail || 'brief' })
    const safe = String(meta?.interfaceName || facts.flowName || 'spec').replace(/[^a-z0-9]+/gi, '_')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="${safe}_TechnicalSpec.docx"`)
    res.send(buffer)
  } catch (e) {
    console.error('spec-ai-docx error:', e.message)
    res.status(500).json({ error: `Document generation failed: ${e.message}` })
  }
})

// Draft ONE flow's specification fields. In a document covering seven flows,
// hand-typing connectivity, formats, implementation steps and exception
// handling for each one is most of the work — and it's work the parsed iFlow
// already answers. The author's context supplies the business framing the XML
// can't contain; everything else comes from the extracted facts.
// Example template — a .docx a user can download, open in Word, and customize
// as the starting point for their own template. Includes every token
// ShipBridge understands, with a short explanation of the syntax at the top.
// This is what the "Bring Your Own Template" mode links to.
app.get('/api/example-template.docx', async (_req, res) => {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
    TableLayoutType,
  } = await import('docx')

  const FONT = 'Calibri', ACCENT = '2F5496'
  const h = (t, lvl = HeadingLevel.HEADING_1) => new Paragraph({
    heading: lvl, spacing: { before: 280, after: 140 },
    children: [new TextRun({ text: t, font: FONT, bold: true, color: ACCENT })],
  })
  const p = (t, opts = {}) => new Paragraph({
    spacing: { after: opts.after ?? 100 },
    children: [new TextRun({ text: String(t ?? ''), font: FONT, size: 22, ...opts })],
  })
  const code = (t) => new Paragraph({
    spacing: { after: 60 }, shading: { type: ShadingType.CLEAR, fill: 'F1F3F5' },
    children: [new TextRun({ text: String(t), font: 'Consolas', size: 20 })],
  })
  const cell = (t, { bold = false, bg = null } = {}) => new TableCell({
    shading: bg ? { type: ShadingType.CLEAR, fill: bg } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      spacing: { after: 0 },
      children: [new TextRun({ text: String(t), font: FONT, size: 21, bold })],
    })],
  })
  const versionTable = new Table({
    columnWidths: [1200, 3400, 1400, 1600, 1800],
    layout: TableLayoutType.FIXED,
    width: { size: 9400, type: WidthType.DXA },
    rows: [
      new TableRow({ tableHeader: true, children:
        ['Version', 'Change Description', 'Date', 'Author', 'Reviewer'].map(t =>
          cell(t, { bold: true, bg: 'DEE6F1' })) }),
      new TableRow({ children: [
        cell('{{VERSION}}'), cell('{{CHANGE_DESC}}'),
        cell('{{REV_DATE}}'), cell('{{AUTHOR}}'), cell('{{REVIEWER}}'),
      ] }),
    ],
  })

  const doc = new Document({
    creator: 'ShipBridge',
    title: 'ShipBridge template — example',
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
      children: [
        // How-to at the top of the document. Users delete this section when
        // they customize — it's here so they see the syntax the first time.
        new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 120 },
          children: [new TextRun({ text: 'ShipBridge template — starter', font: FONT, bold: true, color: ACCENT, size: 36 })] }),
        p('Design this document however you want in Word — fonts, colours, tables, headers, logos, page numbers, anything. Wherever you want ShipBridge to fill in a value, add a {{TOKEN}} placeholder using the exact names below. Delete this "How this works" section when you save your version.', { italics: true, color: '666666' }),

        h('How this works', HeadingLevel.HEADING_2),
        p('Tokens are typed literally, including the double curly braces. Type them as normal text — do not use Word\'s field feature.', { after: 60 }),
        code('Interface Name: {{INTERFACE_NAME}}'),
        code('Package: {{PACKAGE_NAME}}    Flow: {{FLOW_NAME}}'),
        p('Image slots work the same way, but the token name starts with IMG_. Place it on its own line where you want the image to appear:', { after: 60 }),
        code('{{IMG_ARCHITECTURE}}'),
        p('When you upload this file into ShipBridge, it reads the tokens and generates a form for each one. Fill the form, click Export, and the tokens are replaced with your values in the .docx — every bit of your formatting survives.', { after: 60 }),

        h('Available tokens'),
        p('Copy-paste any of these into your document:', { after: 60 }),

        h('Header', HeadingLevel.HEADING_2),
        code('{{INTERFACE_NAME}}    the name of this integration'),

        h('Version history', HeadingLevel.HEADING_2),
        p('You can lay these out however you like — a table is common. Example:', { after: 60 }),
        versionTable,
        p('', { after: 60 }),
        code('{{VERSION}}    {{CHANGE_DESC}}    {{SECTIONS}}'),
        code('{{REV_DATE}}    {{AUTHOR}}    {{REVIEWER}}'),

        h('Business context', HeadingLevel.HEADING_2),
        code('{{BUSINESS_CONTEXT}}    a paragraph on what this integration is for'),
        code('{{GO_LIVE}}    go-live date'),

        h('Solution design', HeadingLevel.HEADING_2),
        code('{{PACKAGE_NAME}}    the CPI package'),
        code('{{FLOW_NAME}}    the iFlow name'),
        code('{{ARCHITECTURE}}    one-line hop path, e.g. SAP ERP → CI → SCV2'),
        code('{{CONNECTIVITY_SENDER}}    sender adapter details'),
        code('{{CONNECTIVITY_RECEIVER}}    receiver adapter details'),
        code('{{INPUT_FORMAT}}    e.g. IDOC, JSON, XML'),
        code('{{OUTPUT_FORMAT}}    e.g. JSON, CSV'),

        h('Implementation', HeadingLevel.HEADING_2),
        p('Implementation steps are a list — ShipBridge expands unlimited steps from one placeholder. Put four numbered items with these tokens; extra steps clone the first paragraph automatically:', { after: 60 }),
        code('1. {{IMPL_BULLET_1}}'),
        code('2. {{IMPL_BULLET_2}}'),
        code('3. {{IMPL_BULLET_3}}'),
        code('4. {{IMPL_BULLET_4}}'),
        p('', { after: 40 }),
        code('{{EXCEPTION_TEXT}}    exception subprocess behaviour'),

        h('Image slots', HeadingLevel.HEADING_2),
        p('Place each on its own line. Attach the matching screenshot in ShipBridge, and it lands exactly where the token is:', { after: 60 }),
        code('{{IMG_ARCHITECTURE}}'),
        code('{{IMG_INPUT_PAYLOAD}}'),
        code('{{IMG_MESSAGE_MAPPING}}'),
        code('{{IMG_GROOVY}}'),
        code('{{IMG_OUTPUT_PAYLOAD}}'),
        code('{{IMG_CONFIG_SENDER}}'),
        code('{{IMG_CONFIG_RECEIVER}}'),
        code('{{IMG_CONFIG_MORE}}'),

        h('Custom tokens'),
        p('You are not limited to the tokens above. Any {{YOUR_TOKEN_NAME}} you type generates a matching form field in ShipBridge, and the AI will suggest what to write there based on the iFlow. Names must be uppercase with underscores.', { after: 60 }),
        code('{{CLIENT_NAME}}    {{PROJECT_CODE}}    {{APPROVER_INITIALS}}'),

        h('Save and upload'),
        p('Save the file as .docx (not .doc). Back in ShipBridge, click "Bring Your Own Template" and upload it. The form will auto-generate from your tokens.', { after: 60 }),
      ],
    }],
  })

  const buffer = await Packer.toBuffer(doc)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  res.setHeader('Content-Disposition', 'attachment; filename="shipbridge_template_starter.docx"')
  res.send(buffer)
})

app.post('/api/spec-flow-fields', async (req, res) => {
  const { flow, context, detail } = req.body || {}
  if (!flow?.steps) return res.status(400).json({ error: 'flow required' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey?.startsWith('sk-ant-')) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  try {
    const facts = buildSpecFacts(flow)
    const level = DETAIL_LEVELS[detail] || DETAIL_LEVELS.brief

    const { default: fetch } = await import('node-fetch')
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1400,
        system: `You fill in the specification fields for ONE SAP Cloud Integration iFlow, from its extracted configuration.

ABSOLUTE RULES:
- Use ONLY the facts given plus the author's context. Never invent endpoints, system names, credentials, formats, or timeouts.
- If a field genuinely cannot be answered from the facts, return an empty string for it rather than guessing.
- ${level.guidance}

Return ONLY a JSON object with these keys, each a string except IMPL_STEPS:
"CONNECTIVITY_SENDER" — how the flow is triggered and by what, one or two sentences.
"INPUT_FORMAT" — the inbound payload format (e.g. IDOC, JSON, XML, CSV). Short.
"CONNECTIVITY_RECEIVER" — where the flow sends its output and over what adapter.
"OUTPUT_FORMAT" — the outbound payload format. Short.
"EXCEPTION_TEXT" — the exception handling. If no exception subprocess exists, say so plainly in one sentence.
"IMPL_STEPS" — an ARRAY of strings, one per implementation step, in execution order. Each names the real step and says what it does. Keep each to one line.

No markdown fences, no prose outside the JSON.`,
        messages: [{ role: 'user', content:
          `EXTRACTED FACTS:\n${JSON.stringify(factsForSection(facts, 'technicalDescription'), null, 2)}\n\n` +
          `ADAPTERS:\n${JSON.stringify(facts.adapters, null, 2)}\n\n` +
          (context ? `AUTHOR CONTEXT (their own words — business knowledge not present in the iFlow):\n${context}\n` : '') }],
      }),
    })
    const data = await upstream.json()
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error?.message || 'AI error' })

    let text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim()
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    let values
    try { values = JSON.parse(text) }
    catch { return res.status(502).json({ error: 'AI returned an unparseable response. Try again.' }) }

    // IMPL_STEPS must be an array — the document builder relies on that to
    // expand the numbered list, and a string here would render as one step.
    if (values.IMPL_STEPS && !Array.isArray(values.IMPL_STEPS)) {
      values.IMPL_STEPS = String(values.IMPL_STEPS).split('\n').map(s => s.replace(/^\d+[.)]\s*/, '').trim()).filter(Boolean)
    }
    res.json({ values })
  } catch (e) {
    console.error('spec-flow-fields error:', e.message)
    res.status(500).json({ error: 'Field drafting failed' })
  }
})

// Multi-flow specification. One business process often spans several iFlows
// (a main flow plus the sub-flows it calls over ProcessDirect), and both
// delivery shapes are supported because clients differ:
//   mode=combined — one .docx, shared front matter + a section per flow
//   mode=separate — a .zip of one .docx per flow plus a linking overview
// AI summary for the Compare feature. Deliberately uses Haiku, not Sonnet:
// this is a small structured-diff → 4-6 lines of prose task, exactly the case
// Haiku is priced and tuned for. Cheaper than Sonnet, fast enough to feel
// instant.
//
// SECURITY: only the structured diff object is sent — never the raw iFlow
// XML, never scripts as full source, never adapter addresses. What Anthropic
// sees is "step X changed field Y from A to B" — enough to summarize, not
// enough to reconstruct anything sensitive on its own.
//
// PRIVACY: the endpoint is triggered by the user's explicit "Explain in plain
// English" click, not automatically. If someone never clicks, nothing leaves
// their network.
app.post('/api/compare-summary', async (req, res) => {
  const { diff } = req.body || {}
  if (!diff || typeof diff !== 'object') return res.status(400).json({ error: 'diff required' })
  if (diff.summary?.total === 0) {
    return res.json({ summary: 'No functional changes between the two flows.' })
  }

  // Trim the diff to only what matters for a summary. Scripts especially can
  // get long — we send only the counts + first few lines, not the full LCS.
  const trimmed = trimDiffForSummary(diff)

  const system = `You explain SAP CPI iFlow differences in plain English for a consultant reviewing a change.

STRICT RULES:
- Use ONLY the facts in the diff below. Never invent step names, values, or behaviour.
- If a field name is unfamiliar, describe what changed factually — do not guess what it does.
- 4-6 lines total. No preamble, no headers, no restating the question.
- Focus on what matters operationally: credential aliases (dev vs prod), timeouts, error handling changes, added/removed steps.
- If a change looks risky (removed error handling, credential switch, timeout reduction), call it out on its own line.

The reader will see the full diff below your summary — you don't need to list everything, just characterize what happened.`

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Haiku is deliberately chosen for this small structured-summary task.
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system,
        messages: [{ role: 'user', content: `Diff:\n${JSON.stringify(trimmed, null, 2)}` }],
      }),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`)
    const summary = data.content?.[0]?.text || ''
    res.json({ summary })
  } catch (e) {
    console.error('compare-summary error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Slim the diff object before sending — scripts and long values otherwise
// blow through the token budget quickly. We keep summary metadata and enough
// specifics for the model to write about them.
function trimDiffForSummary(diff) {
  const trimStr = (s) => (typeof s === 'string' && s.length > 200) ? s.slice(0, 200) + '…' : s
  const trimVal = (v) => typeof v === 'string' ? trimStr(v) : v
  return {
    a: diff.a, b: diff.b,
    summary: diff.summary,
    steps: {
      added: diff.steps.added.map(s => ({ name: s.name, kind: s.kind })),
      removed: diff.steps.removed.map(s => ({ name: s.name, kind: s.kind })),
      renamed: diff.steps.renamed,
      changed: diff.steps.changed.map(s => ({
        step: s.step, kind: s.kind,
        fields: s.fields.map(f => ({ field: f.field, before: trimVal(f.before), after: trimVal(f.after) })),
      })),
    },
    contentModifiers: diff.contentModifiers.map(cm => ({
      step: cm.step,
      headers: cm.headers.map(h => ({ kind: h.kind, name: h.name })),
      properties: cm.properties.map(p => ({ kind: p.kind, name: p.name })),
      bodyChanged: !!cm.body,
    })),
    scripts: {
      added: diff.scripts.added.map(s => ({ name: s.name })),
      removed: diff.scripts.removed.map(s => ({ name: s.name })),
      changed: diff.scripts.changed.map(s => ({
        step: s.step,
        scriptRef: s.scriptRef,
        // Don't send the full source — just the counts so the model knows the scale.
        addedLines: s.lines?.filter(l => l.op === '+').length ?? 0,
        removedLines: s.lines?.filter(l => l.op === '-').length ?? 0,
      })),
    },
    routers: diff.routers.map(r => ({
      step: r.step,
      branches: r.branches.map(b => ({
        kind: b.kind,
        before: b.before?.condition, after: b.after?.condition,
      })),
    })),
    adapters: diff.adapters.map(a => ({
      step: a.step, kind: a.kind,
      fields: a.fields.map(f => ({ field: f.field, before: trimVal(f.before), after: trimVal(f.after) })),
    })),
    exceptionHandling: {
      added: diff.exceptionHandling.added.map(s => ({ name: s.name })),
      removed: diff.exceptionHandling.removed.map(s => ({ name: s.name })),
      changed: diff.exceptionHandling.changed.map(s => ({ step: s.step })),
    },
    edges: {
      addedCount: diff.edges.added.length,
      removedCount: diff.edges.removed.length,
    },
  }
}

app.post('/api/spec-multi-docx', async (req, res) => {
  const { mode, shared, flows, templateBase64, adapters, images, imagesByFlow, adaptersByFlow } = req.body || {}
  if (!Array.isArray(flows) || !flows.length) return res.status(400).json({ error: 'flows[] required' })

  try {
    const templateBuffer = templateBase64
      ? Buffer.from(templateBase64, 'base64')
      : await readDefaultTemplate()

    if (mode === 'separate') {
      const docs = await buildSeparateDocs({ templateBuffer, shared, flows, adaptersByFlow, imagesByFlow })
      const zipped = await zipDocuments(docs)
      const safe = String(shared?.INTERFACE_NAME || 'specifications').replace(/[^a-z0-9]+/gi, '_')
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader('Content-Disposition', `attachment; filename="${safe}_specs.zip"`)
      return res.send(zipped)
    }

    const buffer = await buildCombinedDocx({ templateBuffer, shared, flows, adapters, images })
    const safe = String(shared?.INTERFACE_NAME || 'specification').replace(/[^a-z0-9]+/gi, '_')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.docx"`)
    res.send(buffer)
  } catch (e) {
    console.error('spec-multi-docx error:', e.message)
    res.status(500).json({ error: `Document generation failed: ${e.message}` })
  }
})

// ── Static (production) ───────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const distPath = join(__dirname, '../dist')
  app.use(express.static(distPath))
  app.get('*', (req, res) => res.sendFile(join(distPath, 'index.html')))
}

app.listen(PORT, () => {
  const raw = process.env.ANTHROPIC_API_KEY
  const key = (raw || '').trim()
  const keyOk = key.startsWith('sk-ant-') && key.length > 20
  console.log(`\nShipBridge API  http://localhost:${PORT}  [model: ${MODEL}]`)

  if (keyOk) {
    console.log(`  API key: configured (${key.slice(0, 11)}…${key.slice(-4)})`)
  } else {
    // Say exactly WHAT is wrong — "missing" is useless when the file exists.
    const envPath = join(__dirname, '../.env')
    const envExists = existsSync(envPath)
    console.log('  WARNING: AI features disabled — ANTHROPIC_API_KEY not usable.')
    if (!envExists) {
      console.log(`  → No .env file at ${envPath}`)
      console.log('    Create it:  cp .env.example .env   then paste your key.')
    } else if (!raw) {
      console.log(`  → .env exists at ${envPath}, but ANTHROPIC_API_KEY isn't set in it.`)
      console.log('    The line must look like:  ANTHROPIC_API_KEY=sk-ant-...')
    } else if (raw !== key) {
      console.log('  → The key has surrounding whitespace. Remove any trailing spaces.')
    } else if (/^["']/.test(key)) {
      console.log('  → The key is wrapped in quotes. Write it WITHOUT quotes:')
      console.log('    ANTHROPIC_API_KEY=sk-ant-...   (not "sk-ant-...")')
    } else if (!key.startsWith('sk-ant-')) {
      console.log(`  → The key doesn't start with "sk-ant-" (got "${key.slice(0, 8)}…").`)
    } else {
      console.log('  → The key looks too short to be valid.')
    }
    console.log('    Remember: .env is read only at startup — RESTART the server after editing it.')
  }
  console.log('')
})
