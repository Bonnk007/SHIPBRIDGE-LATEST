import React, { useState, useMemo, useCallback } from 'react'
import {
  UploadCloud, ArrowRight, ArrowLeftRight,
  Plus, Minus, Pencil, Circle,
  FileText, Braces, Route, Cable, ShieldAlert, GitBranch, Boxes,
  Sparkles, Package, ChevronDown, ChevronRight,
  FileCode, Database, Settings2, ArrowRightLeft, MapPin,
  CheckCircle2, AlertCircle, Eye, EyeOff,
} from 'lucide-react'
import { compareFlows } from '../lib/iflowCompare.js'
import { parsePackageZip } from '../lib/packageParser.js'
import { comparePackages } from '../lib/packageCompare.js'
import { parseZip } from '../lib/parser.js'

// ── Main ──────────────────────────────────────────────────────────────────

export default function CompareView({ registry }) {
  const [pkgA, setPkgA] = useState(null)
  const [pkgB, setPkgB] = useState(null)
  const [loading, setLoading] = useState(null)
  const [error, setError] = useState(null)
  const [aiSummary, setAiSummary] = useState(null)
  const [aiBusy, setAiBusy] = useState(false)

  const reset = useCallback(() => {
    setPkgA(null); setPkgB(null); setError(null); setAiSummary(null)
  }, [])

  const diff = useMemo(() => {
    if (!pkgA || !pkgB) return null
    try {
      // Package-level compare if both are packages
      if (pkgA.type === 'package' && pkgB.type === 'package') return comparePackages(pkgA, pkgB)
      // Legacy single-flow compare
      return { legacy: true, result: compareFlows(pkgA, pkgB) }
    } catch (e) { setError(e.message); return null }
  }, [pkgA, pkgB])

  const handleFile = useCallback(async (file, slot) => {
    if (!file || !file.name.endsWith('.zip')) {
      setError('Please choose a .zip export of an iFlow or CPI package')
      return
    }
    setError(null)
    setLoading(slot)
    try {
      // Try package parse first, fall back to legacy single-flow
      let parsed
      try {
        parsed = await parsePackageZip(file)
      } catch {
        parsed = await parseZip(file)
      }
      if (slot === 'a') setPkgA(parsed)
      else setPkgB(parsed)
    } catch (e) {
      setError(`Couldn't parse ${file.name}: ${e.message}`)
    } finally {
      setLoading(null)
    }
  }, [])

  const requestAiSummary = useCallback(async () => {
    if (!diff) return
    setAiBusy(true); setAiSummary(null)
    try {
      const r = await fetch('/api/compare-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diff }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setAiSummary(data.summary || '(no summary returned)')
    } catch (e) {
      setAiSummary(`Couldn't reach AI: ${e.message}`)
    } finally {
      setAiBusy(false)
    }
  }, [diff])

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px' }}>
      <Header hasDiff={!!diff} hasAny={!!(pkgA || pkgB)} onReset={reset} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 20, alignItems: 'stretch', marginBottom: 22 }}>
        <PackagePicker
          label="Before" hint="e.g. current PRD version"
          pkg={pkgA} loading={loading === 'a'}
          onFile={f => handleFile(f, 'a')}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)' }}>
          <ArrowLeftRight size={22} />
        </div>
        <PackagePicker
          label="After" hint="e.g. new deployment"
          pkg={pkgB} loading={loading === 'b'}
          onFile={f => handleFile(f, 'b')}
        />
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', marginBottom: 16,
          background: 'var(--red-bg)', border: '1px solid var(--red)',
          borderRadius: 8, color: 'var(--red)', fontSize: 13.5,
        }}>{error}</div>
      )}

      {diff && !diff.legacy && <PackageSummaryBar diff={diff} aiBusy={aiBusy} onAskAi={requestAiSummary} onReset={reset} />}
      {diff && diff.legacy && <LegacySummaryBar diff={diff.result} aiBusy={aiBusy} onAskAi={requestAiSummary} onReset={reset} />}
      {aiSummary && <AiSummaryPanel text={aiSummary} onDismiss={() => setAiSummary(null)} />}
      {diff && !diff.legacy && <PackageDiffBody diff={diff} pkgA={pkgA} pkgB={pkgB} />}
      {diff && diff.legacy && <LegacyDiffBody diff={diff.result} />}

      {!diff && (pkgA || pkgB) && (
        <div style={{ padding: '32px 22px', textAlign: 'center', color: 'var(--text3)', fontSize: 14 }}>
          Add {pkgA ? 'the "After"' : 'the "Before"'} package to see what changed.
        </div>
      )}
    </div>
  )
}

// ── Header ────────────────────────────────────────────────────────────────

function Header({ hasDiff, hasAny, onReset }) {
  return (
    <div style={{ marginBottom: 22, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ flex: 1 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <GitBranch size={22} style={{ color: 'var(--blue)' }} />
          Compare Packages
        </h1>
        <p style={{ fontSize: 14, color: 'var(--text3)', margin: 0, lineHeight: 1.55, maxWidth: 720 }}>
          Package-level semantic diff — compares sub-processes, message mappings, scripts, schemas, and externalized parameters.
          Layout moves and auto-generated fields are filtered out.
        </p>
      </div>
      {hasAny && (
        <button className="btn btn-ghost btn-sm" onClick={onReset}
          style={{ fontSize: 12.5, marginTop: 6, flexShrink: 0 }}>
          ✕ Reset
        </button>
      )}
    </div>
  )
}

// ── Package Picker ────────────────────────────────────────────────────────

function PackagePicker({ label, hint, pkg: p, loading, onFile }) {
  if (p) {
    const isPackage = p.type === 'package'
    const procCount = isPackage ? Object.keys(p.subProcesses || {}).length : 0
    const stepCount = isPackage
      ? Object.values(p.subProcesses || {}).reduce((s, proc) => s + Object.keys(proc.steps || {}).length, 0)
      : Object.keys(p.steps || {}).length
    return (
      <div style={{
        padding: '14px 18px',
        border: '1.5px solid var(--blue)', borderRadius: 10, background: 'var(--blue-bg)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', letterSpacing: '.06em', textTransform: 'uppercase' }}>{label}</span>
          {isPackage && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'var(--blue)', color: '#fff', fontWeight: 700 }}>PACKAGE</span>}
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 3 }}>
          {isPackage ? (p.meta?.bundleName || p.zipName) : (p.name || p.zipName)}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text3)' }}>
          {isPackage
            ? `v${p.meta?.bundleVersion || '?'} · ${procCount} sub-processes · ${stepCount} steps · ${Object.keys(p.mappings || {}).length} mappings`
            : `${stepCount} steps · ${(p.edges || []).length} edges`
          }
        </div>
        <div style={{ marginTop: 8 }}>
          <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer', fontSize: 12 }}>
            Change
            <input type="file" accept=".zip" hidden onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
          </label>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      padding: '18px 20px',
      border: '2px dashed var(--border2)', borderRadius: 10, background: 'var(--bg2)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}
      onDragOver={e => { e.preventDefault(); e.currentTarget.style.background = 'var(--bg3)' }}
      onDragLeave={e => { e.currentTarget.style.background = 'var(--bg2)' }}
      onDrop={e => {
        e.preventDefault()
        e.currentTarget.style.background = 'var(--bg2)'
        if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0])
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)', letterSpacing: '.06em', textTransform: 'uppercase' }}>{label}</span>
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>· {hint}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <UploadCloud size={26} style={{ color: 'var(--text3)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, color: 'var(--text2)', marginBottom: 3 }}>
            {loading ? 'Parsing…' : 'Drop a .zip here, or'}
          </div>
          <label className="btn btn-primary btn-sm" style={{ cursor: 'pointer', fontSize: 12.5 }}>
            Choose file
            <input type="file" accept=".zip" hidden onChange={e => e.target.files[0] && onFile(e.target.files[0])} />
          </label>
        </div>
      </div>
    </div>
  )
}

// ── Package Summary Bar ───────────────────────────────────────────────────

function PackageSummaryBar({ diff, aiBusy, onAskAi, onReset }) {
  const cat = diff.summary.byCategory
  return (
    <div style={{
      padding: '14px 18px', marginBottom: 16,
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
    }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
        {diff.summary.total === 0 ? 'Identical' : `${diff.summary.total} changes`}
      </div>
      {diff.a?.bundleVersion && diff.b?.bundleVersion && diff.a.bundleVersion !== diff.b.bundleVersion && (
        <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 12, background: 'var(--blue-bg)', color: 'var(--blue)', fontWeight: 600 }}>
          v{diff.a.bundleVersion} → v{diff.b.bundleVersion}
        </span>
      )}
      <div style={{ flex: 1, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text3)' }}>
        {Object.entries(cat).filter(([, n]) => n > 0).map(([k, n]) => (
          <span key={k}>{humanizePkgCategory(k)}: {n}</span>
        ))}
      </div>
      {diff.summary.total > 0 && (
        <button className="btn btn-ghost btn-sm"
          onClick={onAskAi} disabled={aiBusy}
          style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}
          title="Sends the structured diff (not raw XML) to Anthropic for a plain-English summary."
        >
          <Sparkles size={13} />
          {aiBusy ? 'Thinking…' : 'Explain in plain English'}
        </button>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onReset}
        style={{ fontSize: 12.5 }} title="Clear both packages and start over">
        ↺ Reset
      </button>
    </div>
  )
}

function humanizePkgCategory(key) {
  const map = {
    meta: 'Metadata', files: 'Files', processes: 'Sub-processes',
    mappings: 'Mappings', scripts: 'Scripts', schemas: 'Schemas', parameters: 'Parameters',
  }
  return map[key] || key
}

// ── AI Summary ────────────────────────────────────────────────────────────

function AiSummaryPanel({ text, onDismiss }) {
  return (
    <div style={{
      padding: '14px 18px', marginBottom: 16,
      background: 'var(--blue-bg)', border: '1px solid var(--blue)', borderRadius: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Sparkles size={14} style={{ color: 'var(--blue)' }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', letterSpacing: '.06em', textTransform: 'uppercase' }}>AI Summary</span>
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', fontSize: 11 }} onClick={onDismiss}>✕ Close</button>
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{text}</div>
    </div>
  )
}

// ── Package Diff Body ─────────────────────────────────────────────────────

function PackageDiffBody({ diff, pkgA, pkgB }) {
  return (
    <>
      {diff.meta.changes.length > 0 && <MetaSection meta={diff.meta} />}
      {(diff.files.added.length > 0 || diff.files.removed.length > 0) && <FilesSection files={diff.files} />}
      <SubProcessSection processes={diff.processes} pkgA={pkgA} pkgB={pkgB} />
      {(diff.mappings.added.length + diff.mappings.removed.length + diff.mappings.changed.length > 0) && <MappingsSection mappings={diff.mappings} />}
      {(diff.scripts.added.length + diff.scripts.removed.length + diff.scripts.changed.length > 0) && <PkgScriptsSection scripts={diff.scripts} />}
      {(diff.schemas.added.length + diff.schemas.removed.length + diff.schemas.changed.length > 0) && <SchemasSection schemas={diff.schemas} />}
      {(diff.parameters.added.length + diff.parameters.removed.length + diff.parameters.changed.length > 0) && <ParametersSection parameters={diff.parameters} />}
    </>
  )
}

// ── Section: Metadata ─────────────────────────────────────────────────────

function MetaSection({ meta }) {
  return (
    <Section icon={Package} title="Package metadata" count={meta.changes.length}>
      {meta.changes.map(c => (
        <BeforeAfter key={c.field} before={c.before} after={c.after} label={c.field} />
      ))}
    </Section>
  )
}

// ── Section: Files ────────────────────────────────────────────────────────

function FilesSection({ files }) {
  const total = files.added.length + files.removed.length
  return (
    <Section icon={FileText} title="File inventory" count={total}>
      {files.added.map(f => (
        <div key={f} style={{ padding: '3px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="added" /> <code style={{ fontSize: 12, marginLeft: 6 }}>{f}</code>
        </div>
      ))}
      {files.removed.map(f => (
        <div key={f} style={{ padding: '3px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="removed" /> <code style={{ fontSize: 12, marginLeft: 6 }}>{f}</code>
        </div>
      ))}
    </Section>
  )
}

// ── Section: Sub-processes (the picker) ───────────────────────────────────

function SubProcessSection({ processes, pkgA, pkgB }) {
  const [selected, setSelected] = useState(null)
  const entries = Object.entries(processes.byProcess)
  const totalChanges = entries.reduce((s, [, p]) => s + p.changeCount, 0) + processes.added.length + processes.removed.length

  return (
    <Section icon={Boxes} title="Sub-processes" count={totalChanges} defaultOpen>
      {/* Added / Removed processes */}
      {processes.added.map(p => (
        <div key={p.id} style={{ padding: '6px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="added" />
          <span style={{ marginLeft: 8, fontWeight: 600 }}>{p.name}</span>
          <span style={{ color: 'var(--text3)', marginLeft: 8 }}>{p.stepCount} steps</span>
        </div>
      ))}
      {processes.removed.map(p => (
        <div key={p.id} style={{ padding: '6px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="removed" />
          <span style={{ marginLeft: 8, fontWeight: 600 }}>{p.name}</span>
          <span style={{ color: 'var(--text3)', marginLeft: 8 }}>{p.stepCount} steps</span>
        </div>
      ))}

      {/* Picker list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: processes.added.length + processes.removed.length > 0 ? 10 : 0 }}>
        {entries.map(([id, proc]) => {
          const isSelected = selected === id
          const hasChanges = proc.changeCount > 0
          // Get the "after" subprocess steps for the step list
          const subB = pkgB?.subProcesses?.[id] || pkgB?.subProcesses?.[proc.idB]
          const stepList = subB ? Object.values(subB.steps || {}) : []
          return (
            <div key={id}>
              <button
                onClick={() => setSelected(isSelected ? null : id)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px', background: isSelected ? 'var(--bg3)' : 'transparent',
                  border: '1px solid ' + (isSelected ? 'var(--border2)' : 'transparent'),
                  borderRadius: 8, cursor: 'pointer', textAlign: 'left', color: 'var(--text)',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg3)' }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
              >
                {isSelected ? <ChevronDown size={14} /> : <ChevronRight size={14} style={{ color: 'var(--text3)' }} />}
                {hasChanges
                  ? <AlertCircle size={14} style={{ color: 'var(--blue)' }} />
                  : <CheckCircle2 size={14} style={{ color: '#5fa872' }} />
                }
                <span style={{ fontSize: 13.5, fontWeight: hasChanges ? 700 : 400, flex: 1 }}>
                  {proc.name}
                  {proc.renamed && <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 6 }}>← {proc.nameA}</span>}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text3)', marginRight: 4 }}>
                  {stepList.length} steps
                </span>
                <span style={{
                  fontSize: 11, padding: '1px 8px', borderRadius: 12, fontWeight: 700,
                  background: hasChanges ? 'var(--blue-bg)' : 'var(--bg3)',
                  color: hasChanges ? 'var(--blue)' : 'var(--text3)',
                }}>
                  {proc.changeCount === 0 ? 'identical' : `${proc.changeCount}`}
                </span>
              </button>
              {isSelected && (
                <div style={{ padding: '6px 0 12px 36px' }}>
                  {/* Step list — like trace execution view */}
                  {stepList.length > 0 && (
                    <div style={{ marginBottom: 14, padding: '10px 14px', background: 'var(--bg3)', borderRadius: 8, border: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 8 }}>
                        STEPS IN THIS PROCESS
                      </div>
                      {stepList.map((s, i) => {
                        const kindColor = {
                          ContentModifier: 'var(--blue)', GroovyScript: '#a78bfa', MessageMapping: '#14b8a6',
                          ExternalCall: '#f0883e', Router: '#f59e0b', Sender: '#5fa872', Receiver: '#5fa872',
                          Splitter: '#06b6d4', Gather: '#06b6d4', ProcessCall: '#bc8cff',
                        }[s.kind] || 'var(--text3)'
                        return (
                          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13 }}>
                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: kindColor, flexShrink: 0 }} />
                            <span style={{ fontWeight: 500, color: 'var(--text)' }}>{s.name}</span>
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{s.kind}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {/* Diff details */}
                  {proc.diff && <LegacyDiffBody diff={proc.diff} />}
                  {!proc.diff && proc.changeCount === 0 && (
                    <div style={{ fontSize: 13, color: 'var(--text3)' }}>
                      No functional changes in this sub-process.
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}

// ── Section: Message Mappings ─────────────────────────────────────────────

function MappingsSection({ mappings }) {
  const total = mappings.added.length + mappings.removed.length + mappings.changed.length
  return (
    <Section icon={ArrowRightLeft} title="Message Mappings" count={total}>
      {mappings.added.map(m => (
        <ChangeGroup key={m.name} title={<><Plus size={13} style={{ color: '#5fa872' }} /> {m.name}</>}>
          <AddRemoveBadge kind="added" />
          {m.mapping?.fieldMappings?.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{m.mapping.fieldMappings.length} field mappings</div>
          )}
        </ChangeGroup>
      ))}
      {mappings.removed.map(m => (
        <ChangeGroup key={m.name} title={<><Minus size={13} style={{ color: '#d97666' }} /> {m.name}</>}>
          <AddRemoveBadge kind="removed" />
        </ChangeGroup>
      ))}
      {mappings.changed.map(m => <MappingChange key={m.name} change={m} />)}
    </Section>
  )
}

function MappingChange({ change }) {
  return (
    <ChangeGroup title={change.name} subtitle={change.metaChanges ? 'Source/target schema changed' : null}>
      {change.metaChanges && (
        <div style={{ marginBottom: 8 }}>
          {change.metaChanges.source.before !== change.metaChanges.source.after && (
            <BeforeAfter before={change.metaChanges.source.before} after={change.metaChanges.source.after} label="Source schema" />
          )}
          {change.metaChanges.target.before !== change.metaChanges.target.after && (
            <BeforeAfter before={change.metaChanges.target.before} after={change.metaChanges.target.after} label="Target schema" />
          )}
        </div>
      )}
      {change.fieldDiffs.map((fd, i) => (
        <FieldMappingDiff key={i} diff={fd} />
      ))}
    </ChangeGroup>
  )
}

function FieldMappingDiff({ diff: fd }) {
  const targetLeaf = fd.target?.split('/').pop() || fd.target
  if (fd.kind === 'added') {
    return (
      <div style={{ padding: '4px 0', fontSize: 13 }}>
        <AddRemoveBadge kind="added" />
        <code style={{ fontSize: 12, marginLeft: 6 }}>{targetLeaf}</code>
        <span style={{ color: 'var(--text3)', marginLeft: 6 }}>← {fd.after?.sources?.map(s => s.split('/').pop()).join(', ') || '?'}</span>
        {fd.after?.functions?.length > 0 && (
          <span style={{ color: 'var(--blue)', marginLeft: 6, fontSize: 11 }}>
            fn: {fd.after.functions.map(f => f.name).join(', ')}
          </span>
        )}
      </div>
    )
  }
  if (fd.kind === 'removed') {
    return (
      <div style={{ padding: '4px 0', fontSize: 13 }}>
        <AddRemoveBadge kind="removed" />
        <code style={{ fontSize: 12, marginLeft: 6 }}>{targetLeaf}</code>
      </div>
    )
  }
  // changed
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 12.5, marginBottom: 4 }}>
        <AddRemoveBadge kind="changed" />
        <code style={{ fontSize: 12, marginLeft: 6, fontWeight: 600 }}>{targetLeaf}</code>
      </div>
      {fd.before && fd.after && JSON.stringify(fd.before.sources) !== JSON.stringify(fd.after.sources) && (
        <BeforeAfter
          before={fd.before.sources?.map(s => s.split('/').pop()).join(', ')}
          after={fd.after.sources?.map(s => s.split('/').pop()).join(', ')}
          label="Sources"
        />
      )}
      {fd.before && fd.after && JSON.stringify(fd.before.functions) !== JSON.stringify(fd.after.functions) && (
        <BeforeAfter
          before={fd.before.functions?.map(f => f.name).join(', ') || '(none)'}
          after={fd.after.functions?.map(f => f.name).join(', ') || '(none)'}
          label="Functions"
        />
      )}
    </div>
  )
}

// ── Section: Scripts (package-level) ──────────────────────────────────────

function PkgScriptsSection({ scripts }) {
  const total = scripts.added.length + scripts.removed.length + scripts.changed.length
  return (
    <Section icon={Braces} title="Groovy Scripts" count={total}>
      {scripts.added.map(s => (
        <div key={s.name} style={{ padding: '4px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="added" /> <code style={{ fontSize: 12, marginLeft: 6 }}>{s.name}</code>
        </div>
      ))}
      {scripts.removed.map(s => (
        <div key={s.name} style={{ padding: '4px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="removed" /> <code style={{ fontSize: 12, marginLeft: 6 }}>{s.name}</code>
        </div>
      ))}
      {scripts.changed.map(s => <ScriptFileChange key={s.name} change={s} />)}
    </Section>
  )
}

function ScriptFileChange({ change }) {
  const [expanded, setExpanded] = useState(false)
  const adds = change.lines?.filter(l => l.op === '+').length || 0
  const rems = change.lines?.filter(l => l.op === '-').length || 0
  return (
    <ChangeGroup title={change.name}>
      <button onClick={() => setExpanded(v => !v)} className="btn btn-ghost btn-sm"
        style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        {expanded ? '▾' : '▸'}
        <span style={{ color: '#5fa872' }}>+{adds}</span>
        <span style={{ color: '#d97666' }}>−{rems}</span>
        <span style={{ color: 'var(--text3)' }}>lines</span>
      </button>
      {expanded && change.lines && <LineDiff lines={change.lines} />}
    </ChangeGroup>
  )
}

// ── Section: Schemas ──────────────────────────────────────────────────────

function SchemasSection({ schemas }) {
  const total = schemas.added.length + schemas.removed.length + schemas.changed.length
  return (
    <Section icon={Database} title="Schemas (XSD/EDMX)" count={total}>
      {schemas.added.map(s => (
        <div key={s.name} style={{ padding: '4px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="added" /> <code style={{ fontSize: 12, marginLeft: 6 }}>{s.name}</code>
        </div>
      ))}
      {schemas.removed.map(s => (
        <div key={s.name} style={{ padding: '4px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="removed" /> <code style={{ fontSize: 12, marginLeft: 6 }}>{s.name}</code>
        </div>
      ))}
      {schemas.changed.map(s => <SchemaChange key={s.name} change={s} />)}
    </Section>
  )
}

function SchemaChange({ change }) {
  const [expanded, setExpanded] = useState(false)
  const adds = change.lines?.filter(l => l.op === '+').length || 0
  const rems = change.lines?.filter(l => l.op === '-').length || 0
  return (
    <ChangeGroup title={change.name}>
      <button onClick={() => setExpanded(v => !v)} className="btn btn-ghost btn-sm"
        style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        {expanded ? '▾' : '▸'}
        <span style={{ color: '#5fa872' }}>+{adds}</span>
        <span style={{ color: '#d97666' }}>−{rems}</span>
        <span style={{ color: 'var(--text3)' }}>lines</span>
      </button>
      {expanded && change.lines && <LineDiff lines={change.lines} />}
    </ChangeGroup>
  )
}

// ── Section: Parameters ───────────────────────────────────────────────────

function ParametersSection({ parameters }) {
  const total = parameters.added.length + parameters.removed.length + parameters.changed.length
  return (
    <Section icon={Settings2} title="Externalized Parameters" count={total}>
      {parameters.added.map(p => (
        <div key={p.key} style={{ padding: '4px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="added" />
          <code style={{ fontSize: 12, marginLeft: 6 }}>{p.key}</code>
          <span style={{ color: 'var(--text3)', marginLeft: 8 }}>= {p.value}</span>
        </div>
      ))}
      {parameters.removed.map(p => (
        <div key={p.key} style={{ padding: '4px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="removed" />
          <code style={{ fontSize: 12, marginLeft: 6 }}>{p.key}</code>
          <span style={{ color: 'var(--text3)', marginLeft: 8 }}>was {p.value}</span>
        </div>
      ))}
      {parameters.changed.map(p => (
        <BeforeAfter key={p.key} before={p.before} after={p.after} label={p.key} />
      ))}
    </Section>
  )
}

// ── Legacy single-flow diff (backward compat with v1 compare) ─────────────

function LegacySummaryBar({ diff, aiBusy, onAskAi, onReset }) {
  const cat = diff.summary.byCategory
  return (
    <div style={{
      padding: '14px 18px', marginBottom: 16,
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
    }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
        {diff.summary.total === 0 ? 'Identical' : `${diff.summary.total} changes`}
      </div>
      <div style={{ flex: 1, display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text3)' }}>
        {Object.entries(cat).filter(([, n]) => n > 0).map(([k, n]) => (
          <span key={k}>{humanizeLegacyCategory(k)}: {n}</span>
        ))}
      </div>
      {diff.summary.total > 0 && (
        <button className="btn btn-ghost btn-sm" onClick={onAskAi} disabled={aiBusy}
          style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}
          title="Sends the structured diff to Anthropic for a plain-English summary.">
          <Sparkles size={13} />
          {aiBusy ? 'Thinking…' : 'Explain in plain English'}
        </button>
      )}
      <button className="btn btn-ghost btn-sm" onClick={onReset}
        style={{ fontSize: 12.5 }} title="Clear both flows and start over">
        ↺ Reset
      </button>
    </div>
  )
}

function LegacyDiffBody({ diff }) {
  return (
    <>
      <StepsSection steps={diff.steps} />
      <ContentModifiersSection items={diff.contentModifiers} />
      <LegacyScriptsSection scripts={diff.scripts} />
      <RoutersSection routers={diff.routers} />
      <AdaptersSection adapters={diff.adapters} />
      <ExceptionsSection eh={diff.exceptionHandling} />
      <EdgesSection edges={diff.edges} />
    </>
  )
}

function humanizeLegacyCategory(key) {
  const map = {
    steps: 'Steps', contentModifiers: 'Content Modifiers', scripts: 'Groovy',
    routers: 'Routers', adapters: 'Adapters', exceptionHandling: 'Exception handling', edges: 'Connections',
  }
  return map[key] || key
}

// ── Shared primitives ─────────────────────────────────────────────────────

function Section({ icon: Icon, title, count, children, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen != null ? defaultOpen : count > 0)
  return (
    <div style={{
      marginBottom: 14,
      border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg2)', overflow: 'hidden',
    }}>
      <button onClick={() => setOpen(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', background: 'transparent', border: 0, cursor: 'pointer',
          textAlign: 'left', color: 'var(--text)',
        }}
      >
        <Icon size={17} style={{ color: count > 0 ? 'var(--blue)' : 'var(--text3)' }} />
        <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
        <span style={{
          fontSize: 12, padding: '2px 9px', borderRadius: 20,
          background: count > 0 ? 'var(--blue-bg)' : 'var(--bg3)',
          color: count > 0 ? 'var(--blue)' : 'var(--text3)',
          fontWeight: 700,
        }}>
          {count === 0 ? 'no changes' : `${count} change${count > 1 ? 's' : ''}`}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div style={{ padding: '0 16px 14px' }}>{children}</div>}
    </div>
  )
}

function BeforeAfter({ before, after, label }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1fr 20px 1fr',
      alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13,
    }}>
      <ValueChip tone="removed">{stringify(before)}</ValueChip>
      <ArrowRight size={13} style={{ color: 'var(--text3)', justifySelf: 'center' }} />
      <ValueChip tone="added">{stringify(after)}</ValueChip>
      {label && <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text3)', marginTop: -2 }}>{label}</div>}
    </div>
  )
}

function ValueChip({ tone, children }) {
  const color = tone === 'removed' ? '#d97666' : tone === 'added' ? '#5fa872' : 'var(--text)'
  const bg = tone === 'removed' ? 'rgba(217,118,102,0.10)' : tone === 'added' ? 'rgba(95,168,114,0.10)' : 'var(--bg3)'
  return (
    <div style={{
      padding: '6px 10px', borderRadius: 6, background: bg, color,
      fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12,
      wordBreak: 'break-all', minHeight: 26, display: 'flex', alignItems: 'center',
    }}>
      {children || <span style={{ fontStyle: 'italic', opacity: 0.6 }}>(empty)</span>}
    </div>
  )
}

function stringify(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function ChangeGroup({ children, title, subtitle }) {
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        {title}
      </div>
      {subtitle && <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 8 }}>{subtitle}</div>}
      {children}
    </div>
  )
}

function AddRemoveBadge({ kind }) {
  if (kind === 'added')   return <span style={{ fontSize: 11, fontWeight: 700, color: '#5fa872', padding: '1px 7px', background: 'rgba(95,168,114,0.15)', borderRadius: 4 }}>ADDED</span>
  if (kind === 'removed') return <span style={{ fontSize: 11, fontWeight: 700, color: '#d97666', padding: '1px 7px', background: 'rgba(217,118,102,0.15)', borderRadius: 4 }}>REMOVED</span>
  return <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', padding: '1px 7px', background: 'var(--blue-bg)', borderRadius: 4 }}>CHANGED</span>
}

function SubBlock({ label, children }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.05em', color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

function LineDiff({ lines }) {
  return (
    <pre style={{
      marginTop: 8, padding: 12, background: 'var(--bg3)', borderRadius: 6,
      fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12,
      lineHeight: 1.55, overflow: 'auto', maxHeight: 400,
    }}>
      {lines.map((l, i) => (
        <div key={i} style={{
          padding: '0 6px',
          color: l.op === '+' ? '#5fa872' : l.op === '-' ? '#d97666' : 'var(--text2)',
          background: l.op === '+' ? 'rgba(95,168,114,0.08)' : l.op === '-' ? 'rgba(217,118,102,0.08)' : 'transparent',
        }}>
          <span style={{ opacity: 0.4, marginRight: 8 }}>{l.op === '=' ? ' ' : l.op}</span>
          {l.text || '\u00A0'}
        </div>
      ))}
    </pre>
  )
}

// ── Legacy sections (reused for per-subprocess diffs) ─────────────────────

function StepsSection({ steps }) {
  const total = steps.added.length + steps.removed.length + steps.renamed.length + steps.changed.length
  return (
    <Section icon={Boxes} title="Steps" count={total}>
      {steps.added.map(s => (
        <ChangeGroup key={`+${s.id}`} title={<><Plus size={13} style={{ color: '#5fa872' }} /> {s.name || s.id}</>} subtitle={s.kind}>
          <AddRemoveBadge kind="added" />
        </ChangeGroup>
      ))}
      {steps.removed.map(s => (
        <ChangeGroup key={`-${s.id}`} title={<><Minus size={13} style={{ color: '#d97666' }} /> {s.name || s.id}</>} subtitle={s.kind}>
          <AddRemoveBadge kind="removed" />
        </ChangeGroup>
      ))}
      {steps.renamed.map(s => (
        <ChangeGroup key={`~${s.id}`} title={<><Pencil size={12} style={{ color: 'var(--blue)' }} /> Renamed</>}>
          <BeforeAfter before={s.before} after={s.after} />
        </ChangeGroup>
      ))}
      {steps.changed.map(s => (
        <ChangeGroup key={`c${s.id}`} title={<><Pencil size={12} style={{ color: 'var(--blue)' }} /> {s.step}</>} subtitle={s.kind}>
          {s.fields.map(f => (
            <BeforeAfter key={f.field} before={f.before} after={f.after} label={f.field} />
          ))}
        </ChangeGroup>
      ))}
    </Section>
  )
}

function ContentModifiersSection({ items }) {
  return (
    <Section icon={FileText} title="Content Modifiers" count={items.length}>
      {items.map(cm => (
        <ChangeGroup key={cm.id} title={cm.step} subtitle={cm.renamed && `Renamed from "${cm.renamed.before}"`}>
          {cm.headers.length > 0 && (
            <SubBlock label="Headers">
              {cm.headers.map(h => <NameValueChange key={h.name} item={h} />)}
            </SubBlock>
          )}
          {cm.properties.length > 0 && (
            <SubBlock label="Properties">
              {cm.properties.map(h => <NameValueChange key={h.name} item={h} />)}
            </SubBlock>
          )}
          {cm.body && (
            <SubBlock label="Body">
              <BeforeAfter before={`${cm.body.before.type || '?'} · ${cm.body.before.value || ''}`}
                           after={`${cm.body.after.type || '?'} · ${cm.body.after.value || ''}`} />
            </SubBlock>
          )}
        </ChangeGroup>
      ))}
    </Section>
  )
}

function NameValueChange({ item }) {
  if (item.kind === 'added') {
    return (
      <div style={{ padding: '4px 0', fontSize: 13 }}>
        <AddRemoveBadge kind="added" /> <code style={{ fontSize: 12 }}>{item.name}</code>
        <span style={{ color: 'var(--text3)', marginLeft: 6 }}>= {stringify(item.after?.value)}</span>
      </div>
    )
  }
  if (item.kind === 'removed') {
    return (
      <div style={{ padding: '4px 0', fontSize: 13 }}>
        <AddRemoveBadge kind="removed" /> <code style={{ fontSize: 12 }}>{item.name}</code>
        <span style={{ color: 'var(--text3)', marginLeft: 6 }}>was {stringify(item.before?.value)}</span>
      </div>
    )
  }
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ fontSize: 12.5, marginBottom: 2 }}><code>{item.name}</code></div>
      <BeforeAfter before={stringify(item.before?.value)} after={stringify(item.after?.value)} />
    </div>
  )
}

function LegacyScriptsSection({ scripts }) {
  const total = scripts.added.length + scripts.removed.length + scripts.changed.length
  return (
    <Section icon={Braces} title="Groovy Scripts" count={total}>
      {scripts.added.map(s => (
        <ChangeGroup key={`+${s.id}`} title={<><Plus size={13} style={{ color: '#5fa872' }} /> {s.name || s.id}</>}>
          <AddRemoveBadge kind="added" />
        </ChangeGroup>
      ))}
      {scripts.removed.map(s => (
        <ChangeGroup key={`-${s.id}`} title={<><Minus size={13} style={{ color: '#d97666' }} /> {s.name || s.id}</>}>
          <AddRemoveBadge kind="removed" />
        </ChangeGroup>
      ))}
      {scripts.changed.map(s => <LegacyScriptChange key={s.id} change={s} />)}
    </Section>
  )
}

function LegacyScriptChange({ change }) {
  const [expanded, setExpanded] = useState(false)
  const adds = change.lines?.filter(l => l.op === '+').length || 0
  const rems = change.lines?.filter(l => l.op === '-').length || 0
  return (
    <ChangeGroup title={change.step} subtitle={change.renamed && `Renamed from "${change.renamed.before}"`}>
      {change.scriptRef && (
        <SubBlock label="Script reference">
          <BeforeAfter before={change.scriptRef.before} after={change.scriptRef.after} />
        </SubBlock>
      )}
      {change.lines && (
        <div style={{ marginTop: 6 }}>
          <button onClick={() => setExpanded(v => !v)} className="btn btn-ghost btn-sm"
            style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            {expanded ? '▾' : '▸'}
            <span style={{ color: '#5fa872' }}>+{adds}</span>
            <span style={{ color: '#d97666' }}>−{rems}</span>
            <span style={{ color: 'var(--text3)' }}>lines</span>
          </button>
          {expanded && <LineDiff lines={change.lines} />}
        </div>
      )}
    </ChangeGroup>
  )
}

function RoutersSection({ routers }) {
  return (
    <Section icon={Route} title="Router branches" count={routers.length}>
      {routers.map(r => (
        <ChangeGroup key={r.id} title={r.step}>
          {r.branches.map((b, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <AddRemoveBadge kind={b.kind} />
              <span style={{ marginLeft: 8, fontSize: 12.5, color: 'var(--text3)' }}>→ {b.target}</span>
              {b.kind === 'changed' && <BeforeAfter before={b.before?.condition || '(default)'} after={b.after?.condition || '(default)'} label="condition" />}
              {b.kind === 'added' && <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text3)' }}>Condition: {b.after?.condition || '(default)'}</div>}
              {b.kind === 'removed' && <div style={{ fontSize: 12, marginTop: 4, color: 'var(--text3)' }}>Was: {b.before?.condition || '(default)'}</div>}
            </div>
          ))}
        </ChangeGroup>
      ))}
    </Section>
  )
}

function AdaptersSection({ adapters }) {
  return (
    <Section icon={Cable} title="Adapters" count={adapters.length}>
      {adapters.map(a => (
        <ChangeGroup key={a.id} title={a.step} subtitle={`${a.kind}${a.renamed ? ` · renamed from "${a.renamed.before}"` : ''}`}>
          {a.fields.map(f => (
            <BeforeAfter key={f.field} before={f.before} after={f.after} label={f.field} />
          ))}
        </ChangeGroup>
      ))}
    </Section>
  )
}

function ExceptionsSection({ eh }) {
  const total = eh.added.length + eh.removed.length + eh.changed.length
  return (
    <Section icon={ShieldAlert} title="Exception handling" count={total}>
      {eh.added.map(s => (
        <ChangeGroup key={`+${s.id}`} title={<><Plus size={13} style={{ color: '#5fa872' }} /> {s.name}</>}>
          <AddRemoveBadge kind="added" />
        </ChangeGroup>
      ))}
      {eh.removed.map(s => (
        <ChangeGroup key={`-${s.id}`} title={<><Minus size={13} style={{ color: '#d97666' }} /> {s.name}</>}>
          <AddRemoveBadge kind="removed" />
        </ChangeGroup>
      ))}
      {eh.changed.map(s => (
        <ChangeGroup key={s.id} title={s.step}>
          {s.fields.map(f => <BeforeAfter key={f.field} before={f.before} after={f.after} label={f.field} />)}
        </ChangeGroup>
      ))}
    </Section>
  )
}

function EdgesSection({ edges }) {
  const total = edges.added.length + edges.removed.length
  return (
    <Section icon={GitBranch} title="Message flow connections" count={total}>
      {edges.added.map((e, i) => (
        <div key={`+${i}`} style={{ padding: '4px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="added" />
          <code style={{ marginLeft: 8, fontSize: 12 }}>{e.source} → {e.target}</code>
          {e.condition && <span style={{ color: 'var(--text3)', marginLeft: 8 }}>[{e.condition}]</span>}
        </div>
      ))}
      {edges.removed.map((e, i) => (
        <div key={`-${i}`} style={{ padding: '4px 0', fontSize: 13 }}>
          <AddRemoveBadge kind="removed" />
          <code style={{ marginLeft: 8, fontSize: 12 }}>{e.source} → {e.target}</code>
          {e.condition && <span style={{ color: 'var(--text3)', marginLeft: 8 }}>[{e.condition}]</span>}
        </div>
      ))}
    </Section>
  )
}
