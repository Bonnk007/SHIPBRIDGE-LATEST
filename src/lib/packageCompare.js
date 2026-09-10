// Package-level comparison engine.
//
// Wraps compareFlows() per sub-process and adds:
//   - Package metadata diff (manifest version, bundle info)
//   - File inventory diff (files added/removed between versions)
//   - Message Mapping field-level diffs
//   - Groovy script diffs (standalone, not just step-attached)
//   - Schema diffs (XSD/EDMX text-level)
//   - Externalized parameter diffs
//
// The sub-process picker in the UI uses the per-process change counts
// returned here to badge each process.

import { compareFlows, _internal as compareInternal } from './iflowCompare.js'

const { diffLines, diffConfig } = compareInternal

// ── Public entry ──────────────────────────────────────────────────────────

export function comparePackages(a, b) {
  if (!a || !b) throw new Error('comparePackages requires two package objects')

  const meta = diffMeta(a.meta, b.meta)
  const files = diffFileInventory(a.files, b.files)
  const processes = diffSubProcesses(a.subProcesses, b.subProcesses)
  const mappings = diffMappings(a.mappings, b.mappings)
  const scripts = diffScripts(a.scripts, b.scripts)
  const schemas = diffSchemas(a.schemas, b.schemas)
  const parameters = diffParameters(a.parameters, b.parameters)

  // Total change count
  const processChanges = Object.values(processes.byProcess)
    .reduce((sum, p) => sum + (p.diff ? p.diff.summary.total : 0), 0)
  const totalProcessStructural = processes.added.length + processes.removed.length

  const total =
    meta.changes.length +
    files.added.length + files.removed.length +
    processChanges + totalProcessStructural +
    mappings.changed.length + mappings.added.length + mappings.removed.length +
    scripts.changed.length + scripts.added.length + scripts.removed.length +
    schemas.changed.length + schemas.added.length + schemas.removed.length +
    parameters.changed.length + parameters.added.length + parameters.removed.length

  return {
    a: { zipName: a.zipName, bundleName: a.meta?.bundleName, bundleVersion: a.meta?.bundleVersion },
    b: { zipName: b.zipName, bundleName: b.meta?.bundleName, bundleVersion: b.meta?.bundleVersion },
    meta,
    files,
    processes,
    mappings,
    scripts,
    schemas,
    parameters,
    summary: {
      total,
      byCategory: {
        meta: meta.changes.length,
        files: files.added.length + files.removed.length,
        processes: processChanges + totalProcessStructural,
        mappings: mappings.changed.length + mappings.added.length + mappings.removed.length,
        scripts: scripts.changed.length + scripts.added.length + scripts.removed.length,
        schemas: schemas.changed.length + schemas.added.length + schemas.removed.length,
        parameters: parameters.changed.length + parameters.added.length + parameters.removed.length,
      },
    },
  }
}

// ── Metadata diff ────────────────────────────────────────────────────────

function diffMeta(a = {}, b = {}) {
  const changes = []
  const fields = ['bundleName', 'bundleVersion', 'bundleType', 'nodeType', 'description']
  for (const f of fields) {
    const before = a[f] || ''
    const after = b[f] || ''
    if (before !== after) changes.push({ field: f, before, after })
  }
  return { before: a, after: b, changes }
}

// ── File inventory diff ──────────────────────────────────────────────────

function diffFileInventory(filesA = [], filesB = []) {
  const setA = new Set(filesA)
  const setB = new Set(filesB)
  return {
    added: filesB.filter(f => !setA.has(f)),
    removed: filesA.filter(f => !setB.has(f)),
    common: filesA.filter(f => setB.has(f)),
  }
}

// ── Sub-process diff ─────────────────────────────────────────────────────
//
// Match sub-processes by ID first, then by name. For each matched pair,
// run the existing compareFlows engine.

export function diffSubProcesses(subA = {}, subB = {}) {
  const byProcess = {}
  const added = []
  const removed = []
  const matchedB = new Set()

  // Pass 1: match by process ID
  for (const [id, procA] of Object.entries(subA)) {
    if (subB[id]) {
      const diff = safeCompareFlows(procA, subB[id])
      byProcess[id] = {
        name: subB[id].name || procA.name,
        nameA: procA.name,
        nameB: subB[id].name,
        diff,
        changeCount: diff ? diff.summary.total : 0,
        renamed: procA.name !== subB[id].name,
      }
      matchedB.add(id)
    }
  }

  // Pass 2: name match for unmatched
  for (const [idA, procA] of Object.entries(subA)) {
    if (byProcess[idA]) continue
    const nameMatch = Object.entries(subB).find(
      ([idB, procB]) => !matchedB.has(idB) && procB.name === procA.name
    )
    if (nameMatch) {
      const [idB, procB] = nameMatch
      const diff = safeCompareFlows(procA, procB)
      byProcess[idA] = {
        name: procB.name,
        nameA: procA.name,
        nameB: procB.name,
        diff,
        changeCount: diff ? diff.summary.total : 0,
        renamed: false,
        matchedBy: 'name',
        idA, idB,
      }
      matchedB.add(idB)
    } else {
      removed.push({ id: idA, name: procA.name, stepCount: procA.stepCount || Object.keys(procA.steps || {}).length })
    }
  }

  // Unmatched in B = added
  for (const [id, proc] of Object.entries(subB)) {
    if (!matchedB.has(id) && !Object.values(byProcess).some(p => p.idB === id)) {
      added.push({ id, name: proc.name, stepCount: proc.stepCount || Object.keys(proc.steps || {}).length })
    }
  }

  return { byProcess, added, removed }
}

function safeCompareFlows(a, b) {
  try { return compareFlows(a, b) }
  catch { return null }
}

// ── Mapping diffs ────────────────────────────────────────────────────────
//
// For each matched mapping file, diff the field-level mappings:
// target path is the key, sources and functions are compared.

function diffMappings(mapA = {}, mapB = {}) {
  const added = []
  const removed = []
  const changed = []

  const namesA = new Set(Object.keys(mapA))
  const namesB = new Set(Object.keys(mapB))

  for (const name of namesB) {
    if (!namesA.has(name)) added.push({ name, mapping: mapB[name] })
  }
  for (const name of namesA) {
    if (!namesB.has(name)) removed.push({ name, mapping: mapA[name] })
  }

  // Matched: compare field mappings
  for (const name of namesA) {
    if (!namesB.has(name)) continue
    const a = mapA[name], b = mapB[name]
    const fieldDiffs = diffFieldMappings(a.fieldMappings || [], b.fieldMappings || [])
    const metaChanged =
      a.source !== b.source ||
      a.target !== b.target ||
      a.multiplicity !== b.multiplicity
    if (fieldDiffs.length > 0 || metaChanged) {
      changed.push({
        name,
        metaChanges: metaChanged ? {
          source: { before: a.source, after: b.source },
          target: { before: a.target, after: b.target },
          multiplicity: { before: a.multiplicity, after: b.multiplicity },
        } : null,
        fieldDiffs,
      })
    }
  }

  return { added, removed, changed }
}

function diffFieldMappings(fieldsA, fieldsB) {
  const diffs = []
  const byTargetA = new Map(fieldsA.map(f => [f.target, f]))
  const byTargetB = new Map(fieldsB.map(f => [f.target, f]))

  for (const [target, a] of byTargetA) {
    if (!byTargetB.has(target)) {
      diffs.push({ kind: 'removed', target, before: a })
      continue
    }
    const b = byTargetB.get(target)
    const srcChanged = JSON.stringify(a.sources) !== JSON.stringify(b.sources)
    const fnChanged = JSON.stringify(a.functions) !== JSON.stringify(b.functions)
    if (srcChanged || fnChanged) {
      diffs.push({ kind: 'changed', target, before: a, after: b })
    }
  }
  for (const [target, b] of byTargetB) {
    if (!byTargetA.has(target)) diffs.push({ kind: 'added', target, after: b })
  }

  return diffs
}

// ── Script diffs (standalone files, not step-attached) ───────────────────

function diffScripts(scrA = {}, scrB = {}) {
  const added = []
  const removed = []
  const changed = []

  for (const name of Object.keys(scrB)) {
    if (!(name in scrA)) added.push({ name })
  }
  for (const name of Object.keys(scrA)) {
    if (!(name in scrB)) { removed.push({ name }); continue }
    if (scrA[name] !== scrB[name]) {
      changed.push({ name, lines: diffLines(scrA[name], scrB[name]) })
    }
  }

  return { added, removed, changed }
}

// ── Schema diffs (XSD/EDMX — text-level) ─────────────────────────────────

function diffSchemas(schA = {}, schB = {}) {
  const added = []
  const removed = []
  const changed = []

  for (const name of Object.keys(schB)) {
    if (!(name in schA)) added.push({ name })
  }
  for (const name of Object.keys(schA)) {
    if (!(name in schB)) { removed.push({ name }); continue }
    if (schA[name] !== schB[name]) {
      changed.push({ name, lines: diffLines(schA[name], schB[name]) })
    }
  }

  return { added, removed, changed }
}

// ── Parameter diffs ──────────────────────────────────────────────────────

function diffParameters(parA = {}, parB = {}) {
  const added = []
  const removed = []
  const changed = []

  for (const key of Object.keys(parB)) {
    if (!(key in parA)) added.push({ key, value: parB[key] })
  }
  for (const key of Object.keys(parA)) {
    if (!(key in parB)) { removed.push({ key, value: parA[key] }); continue }
    if (parA[key] !== parB[key]) {
      changed.push({ key, before: parA[key], after: parB[key] })
    }
  }

  return { added, removed, changed }
}

// Exposed for tests
export const _internal = {
  diffMeta, diffFileInventory, diffSubProcesses, diffMappings,
  diffScripts, diffSchemas, diffParameters, diffFieldMappings,
}
