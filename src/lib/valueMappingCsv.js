// CSV round-trip for CPI value mappings.
//
// The format matches how the SAP Cloud Integration UI exports and imports —
// a first row that names each column as "Agency|Schema", data rows below.
// The docs allow ; or , as the column separator; we default to comma both
// ways and accept semicolon on read, since Excel-in-Europe writes semicolons.
//
// This library is deliberately small and dependency-free: parseCsvToGroups
// gives you a structure the diff engine already knows how to compare,
// groupsToCsv gives you a string ready to hand to a .csv download. Both are
// pure functions so the tests can be tight.

// ── CSV lexer — handles quoted fields, embedded quotes and both separators
export function parseCsvRows(text, sep = ',') {
  const rows = []
  let row = []
  let field = ''
  let i = 0
  let inQuotes = false
  const s = text.replace(/\r\n/g, '\n')
  while (i < s.length) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue }
      if (c === '"') { inQuotes = false; i++; continue }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === sep) { row.push(field); field = ''; i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }
  // last field / row
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(cell => cell.length > 0))
}

// ── Header parse. Each column reads as "Agency|Schema" (CPI's convention),
// but we also accept plain names for hand-crafted files.
function parseHeader(cells) {
  return cells.map(cell => {
    const parts = cell.split('|').map(s => s.trim())
    if (parts.length >= 2) return { agency: parts[0], schema: parts[1] }
    return { agency: cell.trim(), schema: '' }
  })
}

// ── Groups → CSV ──────────────────────────────────────────────────────────
// A value mapping is a lookup: one source column, one target column, one row
// per group. That's the simplest possible layout, and it round-trips cleanly.
export function groupsToCsv(vm) {
  if (!vm?.groups?.length) return ''
  const first = vm.groups[0]
  const src = first.source, tgt = first.target
  const header = [`${src.agency || ''}|${src.schema || ''}`, `${tgt.agency || ''}|${tgt.schema || ''}`]
  const rows = vm.groups.map(g => [g.source?.value ?? '', g.target?.value ?? ''])
  return [header, ...rows].map(cells => cells.map(csvEscape).join(',')).join('\n')
}

function csvEscape(s) {
  const t = String(s ?? '')
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`
  return t
}

// ── CSV → groups ──────────────────────────────────────────────────────────
// Reads either the standard two-column shape written by groupsToCsv or a
// CPI-editor export (which may use ; as separator and pipe-delimited headers).
export function parseCsvToGroups(text) {
  if (!text || !text.trim()) return { agencies: [], groups: [], entries: [] }

  // Sniff the separator on the first non-empty line — Excel-SEA writes commas,
  // Excel-EU writes semicolons; we take whichever we see more of.
  const first = text.split(/\r?\n/).find(l => l.trim().length > 0) || ''
  const sep = first.split(';').length > first.split(',').length ? ';' : ','

  const rows = parseCsvRows(text, sep)
  if (rows.length < 2) return { agencies: [], groups: [], entries: [] }

  const cols = parseHeader(rows[0])
  if (cols.length < 2) return { agencies: [], groups: [], entries: [] }

  const [sh, th] = cols   // source and target headers
  const agencies = new Set()
  if (sh.agency) agencies.add(sh.agency)
  if (th.agency) agencies.add(th.agency)

  const groups = []
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]
    if (!cells || cells.length < 2) continue
    const sv = (cells[0] || '').trim()
    const tv = (cells[1] || '').trim()
    if (!sv && !tv) continue
    groups.push({
      id: '',
      source: { agency: sh.agency, schema: sh.schema, value: sv, isDefault: false },
      target: { agency: th.agency, schema: th.schema, value: tv, isDefault: false },
    })
  }

  const entries = groups.map(g => ({
    sourceAgency: g.source.agency, sourceIdentifier: g.source.schema, sourceValue: g.source.value,
    targetAgency: g.target.agency, targetIdentifier: g.target.schema, targetValue: g.target.value,
    isDefault: false,
  }))
  return { agencies: [...agencies].sort(), groups, entries }
}
