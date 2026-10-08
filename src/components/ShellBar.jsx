// SAP Fiori Shell Bar — the dark horizontal header every S/4HANA and Fiori
// Launchpad screen has. It's the single most recognizable piece of SAP's
// visual language, and unlike the rest of the app it does NOT flip with the
// light/dark theme toggle — the real Fiori shell bar stays a fixed dark navy
// regardless of the content area's theme, which is itself part of what makes
// it read as "SAP" rather than "this app's own branding."
//
// The sidebar-toggle hamburger that used to live here has moved into the
// sidebar itself, so the shell bar no longer carries a menu button (having
// two toggles was confusing). Search and Upload stay here as global affordances.

import { ShipbridgeMark } from './ShipbridgeLogo.jsx'

const SHELL_BG = '#1d2d3e'   // SAP Fiori Horizon --sapTextColor, used here as the shell bar's fixed background
const SHELL_BORDER = '#2c3e52'

export default function ShellBar({ productName = 'ShipBridge', subtitle = 'SAP Integration Suite Accelerator', onHome, onUpload }) {
  return (
    <div style={{
      height: 44, flexShrink: 0, display: 'flex', alignItems: 'center',
      background: SHELL_BG, borderBottom: `1px solid ${SHELL_BORDER}`,
      padding: '0 14px', gap: 14, color: '#fff',
    }}>
      {/* Home / branding — clicking returns to the tile home, exactly like the
          SAP Fiori shell bar's branding area navigates to the launchpad. */}
      <button onClick={onHome} title="Home" style={{
        display: 'flex', alignItems: 'center', gap: 9, border: 'none',
        background: 'transparent', cursor: 'pointer', padding: 0, color: '#fff',
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: 6, background: 'rgba(255,255,255,.1)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <ShipbridgeMark size={16} color="#7fb0ff" />
        </div>
        <div style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: '.01em' }}>{productName}</div>
      </button>

      <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,.18)' }} />

      <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,.62)', fontWeight: 500 }}>
        {subtitle}
      </div>

      {/* Centered search — Fiori's shell bar docks search in the middle. Static
          for now; kept because the shape is a big part of what reads as SAP. */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(255,255,255,.1)', borderRadius: 6,
          height: 28, width: 'min(280px, 32vw)', padding: '0 11px',
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,.5)' }}>Search</span>
        </div>
      </div>

      {/* Global upload — reachable from every screen, not just one corner. */}
      {onUpload && (
        <button onClick={onUpload} title="Upload iFlow ZIP" style={{
          display: 'flex', alignItems: 'center', gap: 7, border: 'none',
          background: 'rgba(255,255,255,.12)', cursor: 'pointer', padding: '6px 13px', borderRadius: 6,
          color: '#fff', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, flexShrink: 0,
          transition: 'background .12s',
        }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,.2)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,.12)'}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Upload iFlow
        </button>
      )}
    </div>
  )
}
