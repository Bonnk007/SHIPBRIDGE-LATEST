// Semantic iFlow diff.
//
// Every other CPI comparison tool diffs raw .iflw XML — including Figaf, who
// admit it in their own docs:
//   "when the full name of the element changes, in the above CallActivity_68,
//    the full content will be seen as differences. We hope to find a solution
//    for it."
//
// Because we already parse the .iflw into a semantic model (steps as objects,
// adapters as fields, scripts as separate files), we can diff MEANING rather
// than bytes. Coordinate moves in Word's process editor produce nothing.
// Renaming a step reads as one change ("~ renamed"), not as add+remove of the
// full block. This is the difference between a 300-line diff you can't read
// and a 12-line diff you can act on.
//
// Structure:
//   compareFlows(a, b) → {
//     steps:             { added, removed, renamed, changed, unchangedCount },
//     contentModifiers:  { changed },     // headers/properties/body per step
//     scripts:           { added, removed, changed },  // Groovy source diffs
//     routers:           { changed },     // branch conditions
//     adapters:          { changed },     // sender/receiver config
//     exceptionHandling: { changed },     // subprocess presence + config
//     edges:             { added, removed },
//     summary:           { total, byCategory }
//   }
//
// Each "change" carries { path, before, after } so the UI can render before/
// after inline without re-reading either flow.

// ── Kinds we treat as first-class categories ──────────────────────────────
const CATEGORY_KINDS = {
  contentModifier:  s => s.kind === 'ContentModifier',
  script:           s => s.kind === 'GroovyScript' || s.kind === 'JsScript',
  router:           s => s.kind === 'Router' || s.kind === 'ExclusiveGateway',
  adapter:          s => s.kind === 'Sender' || s.kind === 'Receiver' ||
                          s.kind === 'ExternalCall' || s.kind === 'ContentEnricher',
  exceptionHandler: s => s.kind === 'ExceptionSubProcess' || /error|exception/i.test(s.name || ''),
}

// Fields we intentionally ignore — they add noise without meaning.
//
// Layout properties (bounds, waypoints, colours) shift every time someone
// moves a box in the CPI editor and produce no functional change. Auto-
// generated tracking fields (technical version, timestamps in .iflw metadata)
// change on every save. Excluding these is the whole reason a semantic diff
// is worth doing.
const NOISE_FIELDS = new Set([
  'x', 'y', 'width', 'height', 'bounds', 'waypoints',
  'technicalVersion', 'modifiedAt', 'modifiedBy', 'createdAt', 'createdBy',
])

// Match steps between the two flows. ID first (survives rename), name second
// (survives ID change from a copy/paste). Anything left over is added/removed.
function matchSteps(a, b) {
  const byIdA = new Map(Object.entries(a.steps || {}))
  const byIdB = new Map(Object.entries(b.steps || {}))
  const matched = []                // [{ a, b, matchedBy: 'id' | 'name' }]
  const usedB = new Set()

  // Pass 1: exact ID match.
  for (const [id, stepA] of byIdA) {
    if (byIdB.has(id)) {
      matched.push({ a: stepA, b: byIdB.get(id), matchedBy: 'id' })
      usedB.add(id)
    }
  }

  // Pass 2: name match among still-unmatched steps. Renaming is common when
  // devs clone an iFlow for a new environment — same intent, new ID.
  const stillA = [...byIdA.entries()].filter(([id]) => !matched.some(m => m.a.id === id))
  for (const [id, stepA] of stillA) {
    if (!stepA.name) continue
    for (const [idB, stepB] of byIdB) {
      if (usedB.has(idB)) continue
      if (stepB.name === stepA.name && stepB.kind === stepA.kind) {
        matched.push({ a: stepA, b: stepB, matchedBy: 'name' })
        usedB.add(idB)
        break
      }
    }
  }

  const addedIds = [...byIdB.keys()].filter(id => !usedB.has(id))
  const removedIds = [...byIdA.keys()].filter(id => !matched.some(m => m.a.id === id))

  return {
    matched,
    added: addedIds.map(id => byIdB.get(id)),
    removed: removedIds.map(id => byIdA.get(id)),
  }
}

// Field-level diff of two config objects. Returns an array of change objects,
// each { field, before, after } — never fires on NOISE_FIELDS or on identical
// values. This is the atomic building block; every category uses it.
function diffConfig(a = {}, b = {}) {
  const changes = []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (NOISE_FIELDS.has(key)) continue
    const before = a[key]
    const after = b[key]
    if (deepEqual(before, after)) continue
    changes.push({ field: key, before, after })
  }
  return changes
}

function deepEqual(a, b) {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return String(a) === String(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keysA = Object.keys(a), keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  return keysA.every(k => deepEqual(a[k], b[k]))
}

// ── Groovy script line-level diff ─────────────────────────────────────────
// The parser attaches script preview text under config.preview. We produce a
// line-oriented diff: [{op: '=' | '-' | '+', text}, ...] — the same shape the
// existing payload diff view already knows how to render.
function diffLines(before, after) {
  const A = String(before || '').split('\n')
  const B = String(after || '').split('\n')
  // Simple LCS. Adequate for scripts up to a few hundred lines; anything
  // larger and a proper Myers diff would be worth adding, but that's rare.
  const m = A.length, n = B.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = A[i - 1] === B[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const out = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) { out.unshift({ op: '=', text: A[i - 1] }); i--; j-- }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { out.unshift({ op: '-', text: A[i - 1] }); i-- }
    else { out.unshift({ op: '+', text: B[j - 1] }); j-- }
  }
  while (i > 0) { out.unshift({ op: '-', text: A[--i] + '' }) }
  while (j > 0) { out.unshift({ op: '+', text: B[--j] + '' }) }
  return out
}

// ── Category diffs ────────────────────────────────────────────────────────
// Each category takes the same matched-step list and pulls out its own
// artifact type. Kept separate so the UI can render sections independently
// and users can see "0 changes to Content Modifiers" without ambiguity.

function contentModifierChanges(matched) {
  const out = []
  for (const { a, b, matchedBy } of matched) {
    if (!CATEGORY_KINDS.contentModifier(a) && !CATEGORY_KINDS.contentModifier(b)) continue
    if (!CATEGORY_KINDS.contentModifier(a) || !CATEGORY_KINDS.contentModifier(b)) continue
    // Content Modifier sets body, headers, and properties. Diff each family
    // separately so the UI can show "header X added" vs "property Y changed".
    const headers = diffCollectionByName(a.config?.headers, b.config?.headers)
    const properties = diffCollectionByName(a.config?.properties, b.config?.properties)
    const body = diffBody(a.config, b.config)
    if (!headers.length && !properties.length && !body) continue
    out.push({
      step: b.name || a.name,
      id: b.id, matchedBy,
      renamed: a.name !== b.name ? { before: a.name, after: b.name } : null,
      headers, properties, body,
    })
  }
  return out
}

// Content Modifier headers/properties are stored as arrays of {name, type,
// value} — diff by name so "header X changed from V1 to V2" reads correctly
// regardless of order.
function diffCollectionByName(a = [], b = []) {
  const byNameA = new Map((a || []).map(x => [x.name, x]))
  const byNameB = new Map((b || []).map(x => [x.name, x]))
  const changes = []
  for (const [name, before] of byNameA) {
    if (!byNameB.has(name)) { changes.push({ kind: 'removed', name, before }); continue }
    const after = byNameB.get(name)
    if (!deepEqual(before, after)) changes.push({ kind: 'changed', name, before, after })
  }
  for (const [name, after] of byNameB) {
    if (!byNameA.has(name)) changes.push({ kind: 'added', name, after })
  }
  return changes
}

function diffBody(a = {}, b = {}) {
  const beforeType = a.bodyType, afterType = b.bodyType
  const beforeVal = a.bodyValue || a.body || ''
  const afterVal = b.bodyValue || b.body || ''
  if (beforeType === afterType && beforeVal === afterVal) return null
  return { before: { type: beforeType, value: beforeVal }, after: { type: afterType, value: afterVal } }
}

function scriptChanges(matched, addedSteps, removedSteps) {
  const out = { added: [], removed: [], changed: [] }
  for (const { a, b, matchedBy } of matched) {
    if (!CATEGORY_KINDS.script(a) && !CATEGORY_KINDS.script(b)) continue
    if (!CATEGORY_KINDS.script(a) || !CATEGORY_KINDS.script(b)) continue
    const beforeSrc = a.config?.preview || ''
    const afterSrc = b.config?.preview || ''
    if (beforeSrc === afterSrc && a.config?.scriptRef === b.config?.scriptRef) continue
    out.changed.push({
      step: b.name || a.name, id: b.id, matchedBy,
      renamed: a.name !== b.name ? { before: a.name, after: b.name } : null,
      scriptRef: a.config?.scriptRef !== b.config?.scriptRef
        ? { before: a.config?.scriptRef, after: b.config?.scriptRef }
        : null,
      lines: beforeSrc !== afterSrc ? diffLines(beforeSrc, afterSrc) : null,
    })
  }
  for (const s of addedSteps.filter(CATEGORY_KINDS.script)) out.added.push(s)
  for (const s of removedSteps.filter(CATEGORY_KINDS.script)) out.removed.push(s)
  return out
}

function routerChanges(matched, edgesA, edgesB) {
  const out = []
  for (const { a, b } of matched) {
    if (!CATEGORY_KINDS.router(a) || !CATEGORY_KINDS.router(b)) continue
    // Router changes live in the outgoing edges' condition expressions.
    const outA = (edgesA || []).filter(e => e.source === a.id)
    const outB = (edgesB || []).filter(e => e.source === b.id)
    const branchDiff = diffBranches(outA, outB)
    if (!branchDiff.length) continue
    out.push({ step: b.name || a.name, id: b.id, branches: branchDiff })
  }
  return out
}

function diffBranches(a, b) {
  // Match by target step ID first, then by branch name.
  const byIdA = new Map(a.map(e => [e.target, e]))
  const byIdB = new Map(b.map(e => [e.target, e]))
  const changes = []
  for (const [target, before] of byIdA) {
    if (!byIdB.has(target)) { changes.push({ kind: 'removed', target, before }); continue }
    const after = byIdB.get(target)
    if (before.condition !== after.condition || before.name !== after.name) {
      changes.push({ kind: 'changed', target, before, after })
    }
  }
  for (const [target, after] of byIdB) {
    if (!byIdA.has(target)) changes.push({ kind: 'added', target, after })
  }
  return changes
}

function adapterChanges(matched) {
  const out = []
  for (const { a, b, matchedBy } of matched) {
    if (!CATEGORY_KINDS.adapter(a) || !CATEGORY_KINDS.adapter(b)) continue
    const diffs = diffConfig(a.config, b.config)
    if (!diffs.length && a.name === b.name) continue
    out.push({
      step: b.name || a.name, id: b.id, matchedBy,
      kind: b.kind,
      renamed: a.name !== b.name ? { before: a.name, after: b.name } : null,
      fields: diffs,
    })
  }
  return out
}

function exceptionHandlerChanges(matched, added, removed) {
  const out = { added: [], removed: [], changed: [] }
  for (const { a, b } of matched) {
    if (!CATEGORY_KINDS.exceptionHandler(a) || !CATEGORY_KINDS.exceptionHandler(b)) continue
    const diffs = diffConfig(a.config, b.config)
    if (!diffs.length && a.name === b.name) continue
    out.changed.push({
      step: b.name || a.name, id: b.id,
      renamed: a.name !== b.name ? { before: a.name, after: b.name } : null,
      fields: diffs,
    })
  }
  for (const s of added.filter(CATEGORY_KINDS.exceptionHandler)) out.added.push(s)
  for (const s of removed.filter(CATEGORY_KINDS.exceptionHandler)) out.removed.push(s)
  return out
}

function stepChanges(matched, added, removed) {
  // Every matched step: report renames, kind changes, and any config diffs
  // NOT already covered by a category above. This is the "everything else"
  // bucket so nothing meaningful gets silently dropped.
  const renamed = matched
    .filter(({ a, b }) => a.name !== b.name)
    .map(({ a, b, matchedBy }) => ({ before: a.name, after: b.name, id: b.id, matchedBy }))
  const changed = matched
    .filter(({ a, b }) => {
      // Skip things already reported by a specific category
      if (CATEGORY_KINDS.contentModifier(a) || CATEGORY_KINDS.script(a) ||
          CATEGORY_KINDS.router(a) || CATEGORY_KINDS.adapter(a) ||
          CATEGORY_KINDS.exceptionHandler(a)) return false
      return diffConfig(a.config, b.config).length > 0
    })
    .map(({ a, b, matchedBy }) => ({
      step: b.name || a.name, id: b.id, kind: b.kind, matchedBy,
      fields: diffConfig(a.config, b.config),
    }))
  return {
    added, removed, renamed, changed,
    unchangedCount: matched.length - renamed.length - changed.length,
  }
}

function edgeChanges(edgesA = [], edgesB = []) {
  const keyOf = e => `${e.source}→${e.target}${e.condition ? `[${e.condition}]` : ''}`
  const setA = new Set((edgesA || []).map(keyOf))
  const setB = new Set((edgesB || []).map(keyOf))
  const added = (edgesB || []).filter(e => !setA.has(keyOf(e)))
  const removed = (edgesA || []).filter(e => !setB.has(keyOf(e)))
  return { added, removed }
}

// ── Public entry point ────────────────────────────────────────────────────
export function compareFlows(a, b) {
  if (!a || !b) throw new Error('compareFlows requires two flow objects')

  const { matched, added, removed } = matchSteps(a, b)

  const contentModifiers = contentModifierChanges(matched)
  const scripts = scriptChanges(matched, added, removed)
  const routers = routerChanges(matched, a.edges || [], b.edges || [])
  const adapters = adapterChanges(matched)
  const exceptionHandling = exceptionHandlerChanges(matched, added, removed)
  const steps = stepChanges(matched, added, removed)
  const edges = edgeChanges(a.edges, b.edges)

  const total =
    contentModifiers.length +
    scripts.added.length + scripts.removed.length + scripts.changed.length +
    routers.length +
    adapters.length +
    exceptionHandling.added.length + exceptionHandling.removed.length + exceptionHandling.changed.length +
    steps.added.length + steps.removed.length + steps.renamed.length + steps.changed.length +
    edges.added.length + edges.removed.length

  return {
    a: { name: a.name, id: a.id, zipName: a.zipName },
    b: { name: b.name, id: b.id, zipName: b.zipName },
    steps,
    contentModifiers,
    scripts,
    routers,
    adapters,
    exceptionHandling,
    edges,
    summary: {
      total,
      byCategory: {
        steps: steps.added.length + steps.removed.length + steps.renamed.length + steps.changed.length,
        contentModifiers: contentModifiers.length,
        scripts: scripts.added.length + scripts.removed.length + scripts.changed.length,
        routers: routers.length,
        adapters: adapters.length,
        exceptionHandling: exceptionHandling.added.length + exceptionHandling.removed.length + exceptionHandling.changed.length,
        edges: edges.added.length + edges.removed.length,
      },
    },
  }
}

// Exposed for tests.
export const _internal = { matchSteps, diffConfig, diffLines, diffCollectionByName, diffBranches, CATEGORY_KINDS, NOISE_FIELDS }
