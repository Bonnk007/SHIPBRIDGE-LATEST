// SAP Fiori Launchpad-style Home screen.
//
// Written to match the visual conventions of a real SAP Fiori launchpad:
//   - A page of light-gray canvas holding white square tiles.
//   - Tiles grouped under muted uppercase section labels ("Analyze",
//     "Operate", "Utilities") — Fiori calls these "tile groups."
//   - "Dynamic tiles" at the top ("At a glance") that show live numbers
//     from real app state (iFlows loaded, tenant status, checkpoints),
//     which is what makes the launchpad feel alive rather than a menu.
//   - A "My iFlows" worklist below the tile groups when there's registry
//     content, with per-row Trace/Compare/Docs quick actions.
//   - A "Recent" strip at the bottom driven by the activity log so the
//     screen reflects what the user was actually doing.
//
// This is a rewrite of the previous IDE-welcome layout. That layout was
// perfectly good as a returning-user welcome screen but read as a
// developer tool, not as an SAP-native accelerator. Making Home look
// unmistakably Fiori is the whole point of this pass.

import { useEffect, useState } from 'react'
import { getRecentActivity, formatRelativeTime, ActivityKinds } from '../lib/activity.js'

const I = {
  compare:   <><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></>,
  trace:     <><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="11"/></>,
  trigger:   <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></>,
  intel:     <><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.5.5.8 1.1.9 1.8h6.2c.1-.7.4-1.3.9-1.8A7 7 0 0 0 12 2z"/></>,
  converter: <><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></>,
  docs:      <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></>,
  database:  <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/></>,
  plug:      <><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/></>,
  clock:     <><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></>,
  arrow:     <><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></>,
}

function Icon({ name, size = 15, color = 'currentColor', strokeWidth = 2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color}
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{I[name]}</svg>
  )
}

// Fiori's section label — small, uppercase, letter-spaced, muted gray.
// The single most recognizable typographic pattern in a launchpad after
// the tile itself.
function SectionLabel({ children, action, onAction }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '0 0 10px' }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--text3)',
        letterSpacing: '.09em', textTransform: 'uppercase',
      }}>{children}</div>
      {action && (
        <button onClick={onAction} style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          fontSize: 11.5, color: 'var(--blue)', padding: 0, fontFamily: 'inherit',
        }}>{action}</button>
      )}
    </div>
  )
}

// Dynamic tile — the Fiori launchpad element that shows a live number
// or short status. It's what makes a launchpad feel like a dashboard
// rather than a menu. Large numeric readout, small label below.
function DynamicTile({ label, value, subtitle, status = 'neutral', onClick }) {
  const statusColor = {
    success: 'var(--green)',
    warning: 'var(--amber2, #b45309)',
    danger:  'var(--red)',
    neutral: 'var(--text)',
  }[status] || 'var(--text)'
  return (
    <button onClick={onClick} disabled={!onClick} style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
      padding: '14px 16px', minHeight: 108, display: 'flex', flexDirection: 'column',
      alignItems: 'flex-start', textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
      fontFamily: 'inherit', color: 'inherit', transition: 'border-color .14s, box-shadow .14s, transform .14s',
    }}
      onMouseEnter={e => { if (onClick) { e.currentTarget.style.borderColor = 'var(--blue)'; e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,112,242,.10)'; e.currentTarget.style.transform = 'translateY(-1px)' } }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.05em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 'auto' }}>
        <span style={{
          fontSize: typeof value === 'string' && value.length > 6 ? 18 : 32,
          fontWeight: 300, color: statusColor, lineHeight: 1,
          letterSpacing: '-.01em',
        }}>{value}</span>
        {subtitle && <span style={{ fontSize: 12, color: 'var(--text3)' }}>{subtitle}</span>}
      </div>
    </button>
  )
}

// Feature tile — the standard Fiori tile: icon top-left, title + subtitle
// bottom-left, small badge top-right. Square-ish (min-height 128, grid
// makes width flexible), white with a hairline border, hover lifts.
function FeatureTile({ id, title, subtitle, icon, badge, onClick, disabled, disabledHint }) {
  return (
    <button onClick={disabled ? undefined : onClick} title={disabled ? disabledHint : undefined}
      style={{
        background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8,
        padding: 16, minHeight: 128, display: 'flex', flexDirection: 'column',
        textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        color: 'inherit', position: 'relative', opacity: disabled ? 0.55 : 1,
        transition: 'border-color .14s, box-shadow .14s, transform .14s',
      }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.borderColor = 'var(--blue)'; e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,112,242,.10)'; e.currentTarget.style.transform = 'translateY(-1px)' } }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none' }}>
      {badge && (
        <span style={{
          position: 'absolute', top: 12, right: 12,
          fontSize: 10, fontWeight: 700, letterSpacing: '.04em',
          padding: '2px 7px', borderRadius: 4,
          background: 'var(--blue-bg)', color: 'var(--blue)',
        }}>{badge}</span>
      )}
      <Icon name={icon} size={24} color="var(--blue)" strokeWidth={1.8}/>
      <div style={{ marginTop: 'auto', paddingTop: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>{subtitle}</div>
      </div>
    </button>
  )
}

const KIND_ICON = {
  [ActivityKinds.LOAD]: 'database',
  [ActivityKinds.TRACE]: 'trace',
  [ActivityKinds.COMPARE]: 'compare',
  [ActivityKinds.DOCS]: 'docs',
  [ActivityKinds.TRIGGER]: 'trigger',
}
const STATUS_COLOR = {
  success: 'var(--green)',
  error:   'var(--red)',
  warning: 'var(--amber2, #b45309)',
  info:    'var(--text3)',
}

export default function Home({ onNavigate, onUpload, registry, traceSession, checkpointCount = 0 }) {
  // Live activity refresh (same pattern as the previous Home).
  const [recent, setRecent] = useState(() => getRecentActivity(4))
  useEffect(() => {
    const refresh = () => setRecent(getRecentActivity(4))
    window.addEventListener('sb-activity', refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener('sb-activity', refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  const flows = registry ? [...registry.values()] : []
  const registryCount = flows.length
  const connected = !!traceSession?.connected

  return (
    <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg)', padding: '24px 32px 40px' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>

        {/* Page title */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', margin: 0 }}>My Home</h1>
          <span style={{ fontSize: 13, color: 'var(--text3)' }}>SAP Integration Suite accelerator</span>
        </div>

        {/* AT A GLANCE — Fiori "dynamic tiles" showing live state. Three
            cards side-by-side, each a real KPI drawn from app state. */}
        <SectionLabel>At a glance</SectionLabel>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12, marginBottom: 26,
        }}>
          <DynamicTile
            label="iFlows loaded"
            value={registryCount}
            subtitle={registryCount === 1 ? 'in memory' : 'in memory'}
            status={registryCount > 0 ? 'success' : 'neutral'}
            onClick={onUpload}
          />
          <DynamicTile
            label="CPI Tenant"
            value={connected ? 'Live' : 'Off'}
            subtitle={connected ? 'connected' : 'not connected'}
            status={connected ? 'success' : 'neutral'}
            onClick={() => onNavigate('trace')}
          />
          <DynamicTile
            label="Checkpoints"
            value={checkpointCount}
            subtitle={checkpointCount === 0 ? 'none pending' : (checkpointCount === 1 ? 'waiting' : 'waiting')}
            status={checkpointCount > 0 ? 'warning' : 'neutral'}
            onClick={checkpointCount > 0 ? () => onNavigate('checkpoint') : undefined}
          />
        </div>

        {/* ANALYZE — the compare / understand / document tools. */}
        <SectionLabel>Analyze</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 26 }}>
          <FeatureTile id="compare" icon="compare" title="Compare Packages"
            subtitle={registryCount >= 2 ? `Diff any two of ${registryCount} loaded` : 'Load two iFlows to diff'}
            badge="Featured"
            onClick={() => onNavigate('compare')}
            disabled={registryCount < 2}
            disabledHint="Load two or more iFlows first"/>
          <FeatureTile id="intel" icon="intel" title="Intelligence"
            subtitle={registryCount > 0 ? 'Flow dependencies' : 'Upload iFlows to explore'}
            onClick={() => onNavigate('intel')}/>
          <FeatureTile id="docs" icon="docs" title="Documentation"
            subtitle="Generate specs"
            onClick={() => onNavigate('docs')}/>
        </div>

        {/* OPERATE — the tools that talk to a live CPI tenant. */}
        <SectionLabel>Operate</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 26 }}>
          <FeatureTile id="trace" icon="trace" title="Real Trace"
            subtitle={connected ? 'Read tenant execution' : 'Connect a tenant first'}
            onClick={() => onNavigate('trace')}/>
          <FeatureTile id="trigger" icon="trigger" title="Live Trigger"
            subtitle="Send a test payload"
            onClick={() => onNavigate('trigger')}/>
        </div>

        {/* UTILITIES — everything that stands alone. */}
        <SectionLabel>Utilities</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 26 }}>
          <FeatureTile id="converter" icon="converter" title="Converter"
            subtitle="XML, JSON, CSV, YAML"
            onClick={() => onNavigate('converter')}/>
        </div>

        {/* MY IFLOWS — worklist of what's currently in the registry.
            A Fiori launchpad often sits over a work-list surface below the
            tile groups; this is that. Each row shows the assigned color,
            the entry-adapter → exit-adapter shape, and per-row quick
            actions so you don't have to enter a tool to pick the iFlow. */}
        {registryCount > 0 && (
          <>
            <SectionLabel>My iFlows</SectionLabel>
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 26 }}>
              {flows.map((f, i) => {
                const entry = (f.entryPoints || [])[0]
                const exit = (f.exitPoints || [])[0]
                const stepCount = Object.keys(f.steps || {}).length
                return (
                  <div key={f.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '11px 16px',
                    borderBottom: i < flows.length - 1 ? '1px solid var(--border)' : 'none',
                  }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: f.color || 'var(--blue)', flexShrink: 0 }}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 1 }}>
                        {entry?.adapterType || '—'} <span style={{ color: 'var(--border)' }}>→</span> {exit?.adapterType || '—'}
                        {stepCount > 0 && ` · ${stepCount} step${stepCount === 1 ? '' : 's'}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <RowAction label="Trace" onClick={() => onNavigate('trace')}/>
                      <RowAction label="Compare" onClick={() => onNavigate('compare')} disabled={registryCount < 2}/>
                      <RowAction label="Docs" onClick={() => onNavigate('docs')}/>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* RECENT — activity strip from the log. Only shows if there's
            anything to show; keeps Home from being cluttered on first run. */}
        {recent.length > 0 && (
          <>
            <SectionLabel>Recent</SectionLabel>
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              {recent.map((r, i) => {
                const clickable = !!r.target?.page
                return (
                  <button key={r.id} onClick={() => clickable && onNavigate(r.target.page)} disabled={!clickable}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 11, width: '100%',
                      padding: '9px 16px', background: 'transparent', border: 'none',
                      borderBottom: i < recent.length - 1 ? '1px solid var(--border)' : 'none',
                      cursor: clickable ? 'pointer' : 'default', textAlign: 'left',
                      fontFamily: 'inherit', color: 'inherit', transition: 'background .12s',
                    }}
                    onMouseEnter={e => { if (clickable) e.currentTarget.style.background = 'var(--bg3)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                    <Icon name={KIND_ICON[r.kind] || 'database'} size={15} color="var(--text3)" strokeWidth={1.8}/>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 1 }}>
                        {formatRelativeTime(r.timestamp)}
                        {r.subtitle && <> · <span style={{ color: STATUS_COLOR[r.status] || 'var(--text3)' }}>{r.subtitle}</span></>}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        )}

      </div>
    </div>
  )
}

function RowAction({ label, onClick, disabled }) {
  return (
    <button onClick={disabled ? undefined : onClick} disabled={disabled} style={{
      background: 'transparent', border: '1px solid var(--border)', borderRadius: 4,
      padding: '3px 9px', fontSize: 11.5, color: disabled ? 'var(--text3)' : 'var(--text2)',
      cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
      opacity: disabled ? 0.5 : 1, transition: 'border-color .12s, color .12s',
    }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.borderColor = 'var(--blue)'; e.currentTarget.style.color = 'var(--blue)' } }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = disabled ? 'var(--text3)' : 'var(--text2)' }}>
      {label}
    </button>
  )
}
