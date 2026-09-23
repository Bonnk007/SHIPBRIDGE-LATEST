// SAP BTP-style left side navigation. Compact type scale, icon-rail collapse.
//
// The sidebar-collapse hamburger lives here (replacing the leftward back-arrow
// that used to be at the top). The ShellBar above no longer carries a menu
// toggle — having two toggles in adjacent chrome was confusing, and the
// sidebar hamburger is the more discoverable one because it sits right next
// to the thing it toggles. Font sizes are tightened to match SAP BTP
// Cockpit's side-nav proportions (13px items, 10.5px section labels) so the
// panel reads less loud next to the Fiori shell bar.
import { ShipbridgeMark } from './ShipbridgeLogo.jsx'

const ICONS = {
  home:      <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>,
  trigger:   <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></>,
  intel:     <><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.5.5.8 1.1.9 1.8h6.2c.1-.7.4-1.3.9-1.8A7 7 0 0 0 12 2z"/></>,
  converter: <><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></>,
  checkpoint:<><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/></>,
  docs:      <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></>,
  trace:     <><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="11"/><line x1="12" y1="1" x2="12" y2="4"/></>,
  compare:   <><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></>,
}

export default function Sidebar({
  pages, page, onNavigate, onHome, theme, onToggleTheme,
  registryCount, cpBadge, collapsed = false, onToggleCollapse,
}) {
  const width = collapsed ? 56 : 220

  return (
    <aside style={{
      width, flexShrink: 0, background: 'var(--bg2)', borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', height: '100%', position: 'sticky', top: 0,
      transition: 'width .15s ease',
    }}>
      {/* Brand row — hamburger replaces the back arrow and toggles the rail.
          When collapsed we drop the wordmark and keep only the icon + toggle. */}
      <div style={{
        display: 'flex', alignItems: 'center',
        borderBottom: '1px solid var(--border)',
        padding: collapsed ? '10px 0' : '10px 8px 10px 10px',
        gap: 6, justifyContent: collapsed ? 'center' : 'flex-start',
      }}>
        <button onClick={onToggleCollapse} title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          style={{
            width: 28, height: 28, borderRadius: 6, border: 'none', background: 'transparent',
            color: 'var(--text3)', cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            transition: 'background .12s, color .12s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg3)'; e.currentTarget.style.color = 'var(--text)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text3)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>

        {!collapsed && (
          <button onClick={onHome} title="Home" style={{
            display: 'flex', alignItems: 'center', gap: 9, padding: '4px 4px 4px 2px',
            border: 'none', background: 'transparent', cursor: 'pointer',
            flex: 1, textAlign: 'left', minWidth: 0,
          }}>
            <div style={{
              width: 26, height: 26, borderRadius: 6, background: 'var(--bg3)',
              border: '1px solid var(--border)', display: 'flex',
              alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <ShipbridgeMark size={15}/>
            </div>
            <div style={{ lineHeight: 1.2, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', letterSpacing: '.1em' }}>SHIPBRIDGE</div>
              <div style={{ fontSize: 10.5, color: 'var(--text3)', letterSpacing: '.04em' }}>CPI DEV TOOLS</div>
            </div>
          </button>
        )}

        {collapsed && (
          // Collapsed rail still needs a way back to the landing page.
          // Without this, a user who collapses the sidebar has no visible
          // brand surface to click and can get stuck inside the app.
          <button onClick={onHome} title="Home" aria-label="Home" style={{
            width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)',
            background: 'var(--bg3)', cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0,
          }}>
            <ShipbridgeMark size={14}/>
          </button>
        )}
      </div>

      {/* Nav */}
      <nav style={{ padding: collapsed ? '10px 6px' : '10px 8px', flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {!collapsed && (
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text3)', letterSpacing: '.08em', padding: '6px 10px 4px' }}>
            WORKSPACE
          </div>
        )}
        {pages.map(p => {
          const active = page === p.id
          return (
            <button key={p.id} onClick={() => onNavigate(p.id)}
              title={collapsed ? p.label : undefined}
              style={{
                display: 'flex', alignItems: 'center',
                gap: collapsed ? 0 : 10,
                justifyContent: collapsed ? 'center' : 'flex-start',
                padding: collapsed ? '9px 0' : '7px 10px', borderRadius: 6,
                border: 'none', cursor: 'pointer', width: '100%',
                textAlign: 'left', fontFamily: 'inherit',
                fontSize: 13, fontWeight: active ? 600 : 500,
                background: active ? 'var(--blue-bg)' : 'transparent',
                color: active ? 'var(--blue)' : 'var(--text2)',
                transition: 'background .12s, color .12s', position: 'relative',
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg3)' }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}>
              {active && <span style={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 3, background: 'var(--blue)' }} />}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>{ICONS[p.id]}</svg>
              {!collapsed && <span style={{ flex: 1 }}>{p.label}</span>}
              {!collapsed && p.badge && (
                <span style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: '.05em',
                  padding: '2px 5px', borderRadius: 4,
                  background: 'var(--blue)', color: '#fff',
                }}>{p.badge}</span>
              )}
              {!collapsed && p.id === 'checkpoint' && cpBadge > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, minWidth: 16, height: 16, borderRadius: 8, background: 'var(--red)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>{cpBadge}</span>
              )}
            </button>
          )
        })}
      </nav>

      {/* Footer: status + theme */}
      <div style={{
        borderTop: '1px solid var(--border)',
        padding: collapsed ? '10px 6px' : '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {!collapsed && registryCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--text3)' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
            {registryCount} iFlow{registryCount !== 1 ? 's' : ''} loaded
          </div>
        )}
        <button onClick={onToggleTheme}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            display: 'flex', alignItems: 'center',
            gap: collapsed ? 0 : 8,
            justifyContent: collapsed ? 'center' : 'flex-start',
            padding: collapsed ? '7px 0' : '6px 9px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text2)',
            cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, width: '100%',
          }}>
          {theme === 'dark'
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>}
          {!collapsed && (theme === 'dark' ? 'Light mode' : 'Dark mode')}
        </button>
      </div>
    </aside>
  )
}
