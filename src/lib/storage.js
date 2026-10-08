// IndexedDB storage — converter snippets only.
//
// v48.22.0: removed 15 dead exports (sessions, payloads, hosts,
// mappingTemplates, exportAll, importSessions, lsGet, lsSet).
// Only the converter-snippet CRUD is used (by Converter.jsx).

const DB_NAME    = 'triggerflow'
const DB_VERSION = 1

const STORES = {
  converterSnippets: { keyPath: 'id' },
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

// ── Converter snippets ────────────────────────────────────────────────
export async function saveConverterSnippet(label, input, mode) {
  const item = { id: uid(), label, input, mode, savedAt: new Date().toISOString() }
  await put('converterSnippets', item)
  return item.id
}
export async function listConverterSnippets()       { return getAll('converterSnippets') }
export async function deleteConverterSnippet(id)    { return del('converterSnippets', id) }
