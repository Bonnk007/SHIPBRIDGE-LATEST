// CPI Trace fetcher — reads Message Processing Logs and their trace data
// from a deployed Integration Suite tenant (cfapps.*.hana.ondemand.com).
//
// What it does:
//   1. Authenticates via OAuth2 client_credentials (using a service key).
//   2. Lists recent MPLs (filterable by integration flow name).
//   3. Fetches a single MPL with its trace messages (per-step records).
//   4. Downloads the payload attachment for each trace message.
//
// What it does NOT do:
//   - Deploy anything to the tenant.
//   - Modify any iFlow.
//   - Persist credentials. The clientid/clientsecret are passed per-request.
//
// All values are extracted as-is from CPI's response. We never invent fields.

import { isAllowedUrl } from './urlAllowlist.js'

// Small in-memory token cache — keyed by (tokenUrl + clientId) → { token, expiresAt }
// Per-process only; resets on server restart. Never written to disk.
const tokenCache = new Map()

async function getToken({ tokenUrl, clientId, clientSecret }) {
  const key = `${tokenUrl}::${clientId}`
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now() + 5_000) return cached.token

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
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const msg = data.error_description || data.error || `Token request failed (HTTP ${r.status})`
    throw new Error(msg)
  }
  const expiresAt = Date.now() + ((data.expires_in || 3600) * 1000)
  tokenCache.set(key, { token: data.access_token, expiresAt })
  return data.access_token
}

// Helper: call the CPI OData API with a bearer token.
async function cpiGet(tenantUrl, path, token, { accept = 'application/json' } = {}) {
  const fullUrl = new URL(path, tenantUrl).toString()
  if (!isAllowedUrl(fullUrl)) throw new Error(`URL not in allowlist: ${fullUrl}`)
  const { default: fetch } = await import('node-fetch')
  const r = await fetch(fullUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
    // A redirect off an allowlisted CPI host would carry the bearer token
    // wherever CPI points; don't follow it automatically.
    redirect: 'manual',
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    const truncated = text.length > 500 ? text.slice(0, 500) + '…' : text
    const err = new Error(`CPI API ${r.status} ${r.statusText} at ${path}: ${truncated}`)
    err.status = r.status
    err.path = path
    throw err
  }
  return r
}

// List recent MPLs. Optionally filter by integration flow name and a time window.
// Returns the raw array as CPI returns it — caller decides what fields to use.
export async function listMessageProcessingLogs({ tenantUrl, tokenUrl, clientId, clientSecret, iflowName, correlationId, sinceMinutes = 60, top = 50 }) {
  // Both values are interpolated into the OData query string — coerce to
  // bounded integers so a crafted string can't smuggle extra query options.
  top = Math.min(Math.max(parseInt(top, 10) || 50, 1), 500)
  sinceMinutes = Math.min(Math.max(parseInt(sinceMinutes, 10) || 60, 1), 60 * 24 * 30)
  const token = await getToken({ tokenUrl, clientId, clientSecret })
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString().replace(/\.\d+Z$/, 'Z')
  const esc = (s) => String(s).replace(/'/g, "''")
  // CPI's OData v2 filter requires: LogStart ge datetime'2026-07-27T08:00:00'
  // The datetime prefix is mandatory. The Z timezone suffix causes a parse error.
  const sinceNoZ = since.replace(/Z$/, '')
  const filters = [`LogStart ge datetime'${sinceNoZ}'`]
  if (iflowName) filters.push(`IntegrationFlowName eq '${esc(iflowName)}'`)
  // The Live Trigger auto-chain tags each fired message with SAP_ApplicationID,
  // which CPI surfaces on the MPL as ApplicationMessageId — that's how we find
  // the exact message we just fired instead of guessing "the newest one".
  if (correlationId) filters.push(`ApplicationMessageId eq '${esc(correlationId)}'`)
  // Build the query string manually. URLSearchParams encodes the single quotes
  // in `datetime'...'` to %27 — CPI's OData v2 doesn't decode them in filter
  // expressions and rejects the whole request as a malformed literal. The
  // colons in the ISO timestamp also get encoded, producing the same rejection.
  const filter = filters.join(' and ')
  const qs = `$filter=${encodeURIComponent(filter)}&$orderby=LogStart%20desc&$top=${top}&$format=json`
    .replace(/%27/g, "'")       // restore the datetime quotes CPI requires
  const path = `/api/v1/MessageProcessingLogs?${qs}`
  const r = await cpiGet(tenantUrl, path, token)
  const data = await r.json()
  // OData v2 wraps results under d.results; OData v4 returns plain `value`.
  const list = data?.d?.results ?? data?.value ?? []
  return { count: list.length, messages: list }
}

// RunStepProperties is NOT a flat list to classify by name prefix — it's a
// small, fixed set of specially-named entries, confirmed against a real
// tenant response:
//   • TraceIds              — array of NUMERIC ids for TraceMessages(id)/$value.
//                              This is the payload link — we never need a
//                              separate TraceMessages fetch, expand or not.
//   • HTTPRequestHeaders,
//     HTTPResponseHeaders   — a Java toString() TEXT BLOB of "Key: Value"
//                              lines (not structured JSON), one CPI packs the
//                              actual message headers into.
//   • Activities            — a Java toString() blob describing sub-activities:
//                              "[{Activity=X, StartTime=..., StopTime=...}, ...]"
//   • Name                  — a short human description of the step
//                              ("Sending message to receiver").
//   • anything else         — genuine SAP_*/Camel* exchange properties,
//                              already proper Name/Value pairs.
function parseStepProperties(props) {
  const byName = Object.fromEntries((props || []).map(p => [p?.Name ?? p?.name, p?.Value ?? p?.value]))

  const traceIds = toArray(byName.TraceIds).map(v => String(v).trim()).filter(Boolean)
  const headers = [
    ...parseHeaderBlob(byName.HTTPRequestHeaders, 'request'),
    ...parseHeaderBlob(byName.HTTPResponseHeaders, 'response'),
  ]
  const activities = parseActivitiesBlob(byName.Activities)
  const description = typeof byName.Name === 'string' ? byName.Name : null

  const KNOWN = new Set(['TraceIds', 'HTTPRequestHeaders', 'HTTPResponseHeaders', 'Activities', 'Name'])
  const exchangeProperties = (props || [])
    .filter(p => !KNOWN.has(p?.Name ?? p?.name))
    .map(p => ({ name: p?.Name ?? p?.name, value: stringifyValue(p?.Value ?? p?.value) }))
    .filter(p => p.name)
    .sort((a, b) => a.name.localeCompare(b.name))

  return { traceIds, headers, activities, description, exchangeProperties }
}

// CPI's Value fields sometimes arrive as a JS array/object already (clean
// JSON) and sometimes as a Java-toString() STRING like "[60]" or
// "[Sending, message]" — handle both without assuming which.
function toArray(v) {
  if (v == null) return []
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    const m = v.match(/^\[(.*)\]$/s)
    if (m) return m[1].split(',').map(s => s.trim()).filter(Boolean)
    return [v]
  }
  return [v]
}

function stringifyValue(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

// Parse a "Key: Value\nKey2: Value2" text blob into {name, value, dir} rows.
// `dir` tags whether it came from the request or response side, since a
// header name (e.g. Content-Type) can legitimately appear in both.
function parseHeaderBlob(blob, dir) {
  if (!blob) return []
  const text = typeof blob === 'string' ? blob : stringifyValue(blob)
  const rows = []
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const name = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (name) rows.push({ name, value, dir })
  }
  return rows
}

// Parse the "[{Activity=X, StartTime=..., StopTime=...}, {...}]" Java
// toString() blob into structured rows. Defensive: on anything unexpected,
// falls back to returning nothing rather than throwing — a step is still
// useful without its sub-activity breakdown.
function parseActivitiesBlob(blob) {
  if (!blob) return []
  const text = typeof blob === 'string' ? blob : stringifyValue(blob)
  const out = []
  try {
    const objRe = /\{([^{}]*)\}/g
    // Only these three keys are real field delimiters. An Activity value can
    // itself contain "key=value"-shaped text (e.g. a URL query string like
    // "...restoreHeaders?headers=CamelHttpUri,..."), so we must NOT split on
    // any generic "\w+=" — only on these known field names.
    const FIELD_RE = /(?:^|,\s*)(Activity|StartTime|StopTime)=/g
    let m
    while ((m = objRe.exec(text)) !== null) {
      const body = m[1]
      const starts = []
      let fm
      FIELD_RE.lastIndex = 0
      while ((fm = FIELD_RE.exec(body)) !== null) starts.push({ key: fm[1], at: fm.index, valAt: FIELD_RE.lastIndex })
      const entry = {}
      for (let i = 0; i < starts.length; i++) {
        const end = i + 1 < starts.length ? starts[i + 1].at : body.length
        let val = body.slice(starts[i].valAt, end).trim().replace(/,\s*$/, '')
        entry[starts[i].key] = val
      }
      if (Object.keys(entry).length) out.push(entry)
    }
  } catch { /* leave out empty — never let a parse quirk break the step */ }
  return out
}

// Normalize an expanded OData navigation property into a plain array.
// CPI (OData v2) returns expanded collections as { results: [...] }, but the
// same field can appear as a bare array, a single object, or a { __deferred }
// stub when the expand didn't actually resolve — this flattens all of them and
// treats a deferred stub as "nothing came back".
function unwrapNav(nav) {
  if (!nav) return []
  if (Array.isArray(nav)) return nav
  if (nav.results && Array.isArray(nav.results)) return nav.results
  if (nav.__deferred) return []            // expand didn't resolve — no inline data
  if (typeof nav === 'object') return [nav]
  return []
}


// Message state at a step: the Camel HEADERS and EXCHANGE PROPERTIES as they
// stood when the message passed through.
//
// This is a different thing from RunStepProperties' HTTPRequestHeaders /
// HTTPResponseHeaders, and the distinction matters:
//
//   • RunStepProperties gives HTTP TRANSPORT headers (Content-Type,
//     CamelHttpMethod, SAP-PASSPORT). CPI records them only at
//     adapter-processing steps, which is why they appear on one step and
//     nowhere else in the run.
//   • The TraceMessage carries the MESSAGE state — the headers and properties
//     a Content Modifier, script or mapping actually sets. This is what CPI's
//     own "Message Content" viewer shows, and what someone means when they
//     ask "what did this Content Modifier set?".
//
// Message state at a step — the Camel headers and exchange properties the
// message had when it passed through.
//
// CONFIRMED FROM LIVE TENANT LOGS (2026-07-27):
//
//   The TraceMessage entity carries:
//     Properties        → message headers (SAP's naming is confusing)
//     ExchangeProperties → exchange properties
//   There is NO "Headers" collection — that was the wrong field name.
//
//   The entity key (TraceId field) does NOT work with TraceMessages(id) — that
//   returns 404. The correct path is to expand directly on the navigation:
//     RunSteps(RunId='X',ChildCount=N)/TraceMessages?$expand=Properties,ExchangeProperties
//
//   This avoids the entity-key problem entirely and returns data inline.
async function fetchStepMessageState(tenantUrl, token, runId, childCount) {
  const attempts = [
    // Best: both expanded in one call.
    `/api/v1/MessageProcessingLogRunSteps(RunId='${runId}',ChildCount=${childCount})/TraceMessages?$expand=Properties,ExchangeProperties&$format=json`,
    // If multi-expand 501s, try them individually.
    `/api/v1/MessageProcessingLogRunSteps(RunId='${runId}',ChildCount=${childCount})/TraceMessages?$expand=ExchangeProperties&$format=json`,
    `/api/v1/MessageProcessingLogRunSteps(RunId='${runId}',ChildCount=${childCount})/TraceMessages?$expand=Properties&$format=json`,
    // Bare navigation — entities may carry them inline on some tenants.
    `/api/v1/MessageProcessingLogRunSteps(RunId='${runId}',ChildCount=${childCount})/TraceMessages?$format=json`,
  ]

  for (const path of attempts) {
    const label = path.includes('Properties,ExchangeProperties') ? 'dual'
                : path.includes('ExchangeProperties') ? 'exprops'
                : path.includes('Properties') ? 'props' : 'bare'
    try {
      const r = await cpiGet(tenantUrl, path, token)
      const body = await r.json()
      const entities = unwrapNav(body?.d) || unwrapNav(body) || []
      if (process.env.DEBUG_TRACE) console.log(`[trace-state] RunSteps(${runId},${childCount}) ${label}: ${entities.length} entities`)

      const allProps = []    // message headers (SAP calls them "Properties")
      const allExProps = []  // exchange properties

      for (const entity of entities.slice(0, 3)) {
        const props = unwrapNav(entity?.Properties)
        const exProps = unwrapNav(entity?.ExchangeProperties)
        if (props.length || exProps.length) {
          if (process.env.DEBUG_TRACE) console.log(`[trace-state]   → props=${props.length} exProps=${exProps.length}`)
        }
        allProps.push(...props)
        allExProps.push(...exProps)
      }

      if (allProps.length || allExProps.length) {
        return {
          headers: allProps.map(toPair).filter(x => x.name),
          properties: allExProps.map(toPair).filter(x => x.name),
        }
      }
      if (label === 'bare') break
    } catch (e) {
      if (process.env.DEBUG_TRACE) console.log(`[trace-state] RunSteps(${runId},${childCount}) ${label}: ${e.status || e.message}`)
      if (e.status && ![400, 403, 404, 500, 501].includes(e.status)) throw e
    }
  }
  return null
}

const toPair = (p) => ({
  name: p?.Name ?? p?.name ?? '',
  value: stringifyValue(p?.Value ?? p?.value ?? ''),
})

// Enrich steps with message state, in parallel but capped.
async function attachMessageState(tenantUrl, token, steps) {
  const targets = steps.filter(s => s.runId && s.childCount != null)
  const LIMIT = 4
  for (let i = 0; i < targets.length; i += LIMIT) {
    const batch = targets.slice(i, i + LIMIT)
    await Promise.all(batch.map(async (step) => {
      const state = await fetchStepMessageState(tenantUrl, token, step.runId, step.childCount).catch(() => null)
      if (!state) return
      if (state.headers.length) step.messageHeaders = state.headers
      if (state.properties.length) {
        step.exchangeProperties = state.properties.sort((a, b) => a.name.localeCompare(b.name))
      }
    }))
  }
}

//
// CPI's real entity chain — there is NO direct MPL→TraceMessages navigation:
//
//   MessageProcessingLogs('{guid}')
//     → /Runs                                  (MessageProcessingLogRuns)
//       → /RunSteps                            (MessageProcessingLogRunSteps, keyed RunId + ChildCount)
//         → /TraceMessages                     (one per captured payload)
//           → TraceMessages({id})/$value       (the actual bytes — see fetchTracePayload)
//
// Each run step is flattened with its trace messages attached, so the UI gets
// one ordered list of steps with payload references.
export async function fetchMessageTrace({ tenantUrl, tokenUrl, clientId, clientSecret, messageGuid }) {
  // CPI MessageGuids are alphanumeric with dashes/underscores. Strip anything
  // else so the value can't break out of the OData key literal below.
  messageGuid = String(messageGuid || '').replace(/[^A-Za-z0-9\-_]/g, '')
  if (!messageGuid) throw Object.assign(new Error('Invalid messageGuid'), { status: 400 })
  const token = await getToken({ tokenUrl, clientId, clientSecret })

  // 1. MPL summary
  const mplPath = `/api/v1/MessageProcessingLogs('${messageGuid}')?$format=json`
  const mplRes = await cpiGet(tenantUrl, mplPath, token)
  const mplData = await mplRes.json()
  const mpl = mplData?.d ?? mplData

  const unwrap = (d) => d?.d?.results ?? d?.d ?? d?.value ?? []

  // 2. Runs for this message (usually 1, more if the flow was re-processed).
  let runs = []
  try {
    const r = await cpiGet(tenantUrl, `/api/v1/MessageProcessingLogs('${messageGuid}')/Runs?$format=json`, token)
    runs = unwrap(await r.json())
    if (!Array.isArray(runs)) runs = [runs]
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e
  }

  // 3. Run steps per run.
  //
  //    Confirmed against a real tenant response (not guessed):
  //      • RunSteps?$expand=RunStepProperties  → WORKS, and RunStepProperties
  //        contains a "TraceIds" entry with the numeric IDs needed for
  //        TraceMessages(id)/$value — so this alone gives us everything:
  //        headers, exchange properties, activities, AND the payload links.
  //      • RunSteps?$expand=TraceMessages      → "Not Implemented" (501) on
  //        this tenant. Never attempted — there's no reason to, TraceIds
  //        already gives us the same information via the working endpoint.
  const steps = []
  let traceForbidden = false

  for (const run of runs) {
    const runId = run?.RunId ?? run?.Id
    if (!runId) continue
    const rid = encodeURIComponent(runId)

    let list = null
    try {
      const r = await cpiGet(tenantUrl, `/api/v1/MessageProcessingLogRuns('${rid}')/RunSteps?$expand=RunStepProperties&$format=json`, token)
      list = unwrap(await r.json())
    } catch (e) {
      if (e.status === 403) traceForbidden = true
      else if (e.status !== 404 && e.status !== 400 && e.status !== 501) throw e
      // 501 here would mean even RunStepProperties expand isn't supported —
      // fall through to plain RunSteps below rather than failing the request.
    }

    // Fallback: plain RunSteps, no expand — still gives the step timeline
    // even if properties are unavailable on this tenant/role.
    if (list === null) {
      try {
        const r = await cpiGet(tenantUrl, `/api/v1/MessageProcessingLogRuns('${rid}')/RunSteps?$format=json`, token)
        list = unwrap(await r.json())
      } catch (e) {
        if (e.status !== 404 && e.status !== 400 && e.status !== 403) throw e
        continue
      }
    }

    for (const s of (Array.isArray(list) ? list : [list]).filter(Boolean)) {
      const props = unwrapNav(s?.RunStepProperties)
      const { traceIds, headers, activities, description, exchangeProperties } = parseStepProperties(props)

      steps.push({
        runId,
        childCount: s?.ChildCount,
        stepId: s?.StepId ?? s?.ModelStepId ?? null,
        modelStepId: s?.ModelStepId ?? null,
        branchId: s?.BranchId ?? null,
        status: s?.Status ?? null,
        error: s?.Error ?? null,
        activity: s?.Activity ?? null,
        stepStart: s?.StepStart ?? null,
        stepStop: s?.StepStop ?? null,
        description,
        headers,
        activities,
        exchangeProperties,
        // Payload links come straight from RunStepProperties' TraceIds — no
        // separate TraceMessages call needed at all.
        traceMessages: traceIds.map(id => ({ traceId: id, modelStepId: s?.ModelStepId ?? null })),
      })
    }
  }

  // Enrich with message state (Camel headers + exchange properties). Optional:
  // if the tenant doesn't expose it, or the trace has already been swept, the
  // steps keep whatever RunStepProperties gave us.
  await attachMessageState(tenantUrl, token, steps).catch(() => {})

  // Order steps as they executed. CPI returns them REVERSED (ChildCount 7→1),
  // and several steps routinely share an identical StepStart millisecond — so
  // ChildCount is the authoritative sequence, not the timestamp.
  steps.sort((a, b) => (a.childCount ?? 0) - (b.childCount ?? 0))

  const traceCount = steps.reduce((n, s) => n + s.traceMessages.length, 0)

  // Flatten to ONE ENTRY PER STEP for the viewer's timeline, in PascalCase
  // (the shape the UI reads). A step with no captured payload still appears —
  // it just has no TraceId, so the payload pane shows "no payload at this step"
  // instead of the whole run being hidden. Steps that captured multiple
  // payloads (e.g. before/after) emit one row each.
  const traceMessages = steps.flatMap(s => {
    const base = {
      ModelStepId: s.modelStepId ?? s.stepId,
      StepId: s.stepId,
      BranchId: s.branchId,
      Status: s.status,
      Error: s.error,
      Activity: s.activity,
      StepStart: s.stepStart,
      StepStop: s.stepStop,
      RunId: s.runId,
      ChildCount: s.childCount,
      Description: s.description,
      // Two distinct things, deliberately kept apart:
      //   MessageHeaders — Camel message state (what a Content Modifier sets)
      //   Headers        — HTTP transport headers at adapter steps
      MessageHeaders: s.messageHeaders || [],
      Headers: s.headers,
      Activities: s.activities,
      ExchangeProperties: s.exchangeProperties,
    }
    if (!s.traceMessages.length) return [{ ...base, TraceId: null, HasPayload: false }]
    return s.traceMessages.map(t => ({
      ...base,
      TraceId: t.traceId,
      ModelStepId: t.modelStepId ?? base.ModelStepId,
      PayloadSize: t.payloadSize,
      MimeType: t.mimeType,
      HasPayload: Boolean(t.traceId),
    }))
  })

  return {
    mpl,
    runs,
    steps,
    traceMessages,
    // Three distinct states the UI must NOT conflate:
    //   • traceForbidden → key lacks permission to read trace data (fix: role)
    //   • traceWasOff    → steps captured but no payloads (fix: log level = Trace)
    //   • noRunData      → nothing at all (expired, or never ran)
    traceForbidden: traceForbidden && traceCount === 0,
    traceWasOff: !traceForbidden && steps.length > 0 && traceCount === 0,
    noRunData: steps.length === 0,
    traceCount,
  }
}

// Download a single trace message's payload bytes (the actual message body
// at that step). Returns base64 + content-type so the UI can render properly.
export async function fetchTracePayload({ tenantUrl, tokenUrl, clientId, clientSecret, traceMessageId }) {
  const token = await getToken({ tokenUrl, clientId, clientSecret })

  // TraceMessages uses a NUMERIC key — TraceMessages(123)/$value, not
  // TraceMessages('123')/$value. Quoting it yields a 400/404 on most tenants.
  // Some tenants still accept the quoted form, so fall back to it rather than
  // failing outright.
  const raw = String(traceMessageId).replace(/^'|'$/g, '').replace(/[^A-Za-z0-9\-_]/g, '')
  if (!raw) throw Object.assign(new Error('Invalid traceMessageId'), { status: 400 })
  const isNumeric = /^\d+$/.test(raw)
  const candidates = isNumeric
    ? [`/api/v1/TraceMessages(${raw})/$value`, `/api/v1/TraceMessages('${raw}')/$value`]
    : [`/api/v1/TraceMessages('${raw}')/$value`, `/api/v1/TraceMessages(${raw})/$value`]

  let lastErr
  for (const path of candidates) {
    try {
      const r = await cpiGet(tenantUrl, path, token, { accept: '*/*' })
      const buf = await r.arrayBuffer()
      const contentType = r.headers.get('content-type') || 'application/octet-stream'
      return {
        base64: Buffer.from(buf).toString('base64'),
        contentType,
        sizeBytes: buf.byteLength,
      }
    } catch (e) {
      lastErr = e
      if (e.status !== 400 && e.status !== 404) throw e   // real error — don't mask it
    }
  }
  throw lastErr || new Error('Trace payload not found')
}
