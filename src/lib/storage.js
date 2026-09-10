import { redact } from './redact.js'

const DB_NAME    = 'triggerflow'
const DB_VERSION = 1

const STORES = {
  sessions:         { keyPath: 'id' },
  payloads:         { keyPath: 'id' },
  hosts:            { keyPath: 'id' },
  mappingTemplates: { keyPath: 'id' },
  converterSnippets:{ keyPath: 'id' },
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => {
      const db = e.target.result
      Object.entries(STORES).forEach(([name, opts]) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts)
      })
    }
    req.onsuccess = e => resolve(e.target.result)
    req.onerror   = e => reject(e.target.error)
  })
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2)
}

async function put(store, item) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite')
    const req = tx.objectStore(store).put(item)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = e => reject(e.target.error)
  })
}

async function getAll(store) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror   = e => reject(e.target.error)
  })
}

async function del(store, id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite')
    const req = tx.objectStore(store).delete(id)
    req.onsuccess = () => resolve()
    req.onerror   = e => reject(e.target.error)
  })
}

async function getOne(store, id) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(id)
    req.onsuccess = () => resolve(req.result)
    req.onerror   = e => reject(e.target.error)
  })
}

// ── Sessions ─────────────────────────────────────────────────────────────
export async function saveSession(session) {
  const item = {
    id:        session.id || uid(),
    name:      session.name || `Session ${new Date().toLocaleString()}`,
    savedAt:   new Date().toISOString(),
    // Strip credentials before saving
    data:      redact(session.data || session),
  }
  await put('sessions', item)
  return item.id
}

export async function listSessions()        { return getAll('sessions') }
export async function loadSession(id)       { return getOne('sessions', id) }
export async function deleteSession(id)     { return del('sessions', id) }

// ── Payload samples ───────────────────────────────────────────────────────
export async function savePayload(label, body, contentType = 'application/xml') {
  const item = { id: uid(), label, body, contentType, savedAt: new Date().toISOString() }
  await put('payloads', item)
  return item.id
}
export async function listPayloads()    { return getAll('payloads') }
export async function deletePayload(id) { return del('payloads', id) }

// ── Recent CPI hosts (no secrets) ─────────────────────────────────────────
export async function saveHost(host, path) {
  const id = btoa(host + path).slice(0, 20)
  await put('hosts', { id, host, path, lastUsed: new Date().toISOString() })
}
export async function listHosts()   { return getAll('hosts') }
export async function deleteHost(id){ return del('hosts', id) }

// ── Mapping templates ─────────────────────────────────────────────────────
export async function saveMappingTemplate(name, rows) {
  const item = { id: uid(), name, rows, savedAt: new Date().toISOString() }
  await put('mappingTemplates', item)
  return item.id
}
export async function listMappingTemplates()        { return getAll('mappingTemplates') }
export async function deleteMappingTemplate(id)     { return del('mappingTemplates', id) }

// ── Converter snippets ────────────────────────────────────────────────────
export async function saveConverterSnippet(label, input, mode) {
  const item = { id: uid(), label, input, mode, savedAt: new Date().toISOString() }
  await put('converterSnippets', item)
  return item.id
}
export async function listConverterSnippets()       { return getAll('converterSnippets') }
export async function deleteConverterSnippet(id)    { return del('converterSnippets', id) }

// ── Export / Import ───────────────────────────────────────────────────────
export async function exportAllSessions() {
  const sessions = await listSessions()
  const payloads = await listPayloads()
  const hosts    = await listHosts()
  // Never include secrets
  return JSON.stringify(redact({ sessions, payloads, hosts, exportedAt: new Date().toISOString() }), null, 2)
}

export async function importSessions(jsonStr) {
  const data = JSON.parse(jsonStr)
  if (data.sessions) for (const s of data.sessions) await put('sessions', s)
  if (data.payloads) for (const p of data.payloads) await put('payloads', p)
  if (data.hosts)    for (const h of data.hosts)    await put('hosts', h)
}

// ── localStorage helpers (non-sensitive only) ─────────────────────────────
export function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v != null ? JSON.parse(v) : fallback }
  catch { return fallback }
}

export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}
