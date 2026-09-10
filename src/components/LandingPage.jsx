// SAP Fiori-styled marketing landing page.
//
// Rebuilt from the earlier dark "space" theme into a light, professional,
// enterprise look that reads as part of the SAP ecosystem: SAP brand blue
// (#0070f2), Fiori's shell-bar navy, light gray canvas, white cards, the
// restrained type and generous whitespace of a Fiori app. This is what a
// prospective client sees first, so it has to look like SAP tooling — not a
// generic dark SaaS product.

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import ShipbridgeLogo, { ShipbridgeMark } from './ShipbridgeLogo.jsx'

// SAP Fiori Horizon tokens (the real published values).
const SAP = {
  blue:    '#0070f2',
  blueDk:  '#0057d2',
  navy:    '#354a5f',   // Fiori shell bar background
  text:    '#1d2d3e',
  sub:     '#556b82',
  faint:   '#8996a6',
  bg:      '#f5f6f7',
  card:    '#ffffff',
  border:  '#d9d9d9',
  borderLt:'#e5e8ec',
  green:   '#30914c',
  amber:   '#e76500',
  red:     '#d20a0a',
}

const FEATURES = [
  { id: 'compare', title: 'Compare Packages', badge: 'Featured', icon: 'compare',
    desc: 'Semantic diff between two CPI package versions — grouped by sub-process, down to message-mapping field level. Answers "what shipped in this transport?" in seconds.' },
  { id: 'trace', title: 'Real CPI Trace', icon: 'trace',
    desc: 'Reads the actual execution trace from your tenant — real payloads, real errors, real timing — and maps every step back to your iFlow design.' },
  { id: 'trigger', title: 'Live Trigger', icon: 'trigger',
    desc: 'Send payloads to deployed CPI endpoints with OAuth2 or Basic Auth — no sender system or Postman setup needed.' },
  { id: 'intel', title: 'Dependency Intelligence', icon: 'intel',
    desc: 'See shared scripts, the impact of a change, dead assets and cycles across every loaded iFlow.' },
  { id: 'converter', title: 'Payload Converter', icon: 'converter',
    desc: 'XML, JSON, CSV, YAML, XSLT and Markdown — convert, pretty-print and download while you work.' },
  { id: 'docs', title: 'Spec Generator', icon: 'docs',
    desc: 'Turn an iFlow into a complete Technical Specification document — answer a few questions, export to Word.' },
]

const ICONS = {
  compare:   <><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/></>,
  trace:     <><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="11"/><line x1="12" y1="1" x2="12" y2="4"/></>,
  trigger:   <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></>,
  intel:     <><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.5.5.8 1.1.9 1.8h6.2c.1-.7.4-1.3.9-1.8A7 7 0 0 0 12 2z"/></>,
  converter: <><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></>,
  docs:      <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></>,
  home:      <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>,
}

const STATS = [
  { n: '20+', label: 'Sub-processes diffed per package' },
  { n: '6', label: 'Integrated developer tools' },
  { n: '1 min', label: 'From ZIP to full spec document' },
]

export default function LandingPage({ onStart }) {
  const [ready, setReady] = useState(false)
  useEffect(() => { const t = setTimeout(() => setReady(true), 40); return () => clearTimeout(t) }, [])
  const go = (id) => onStart(id)

  return (
    <div style={{ background: SAP.bg, color: SAP.text, fontFamily: "'72','72full',Arial,Helvetica,sans-serif", minHeight: '100vh' }}>
      <style>{`
        @keyframes lp-fade { from { opacity:0; transform: translateY(14px) } to { opacity:1; transform:none } }
        .lp-nav { background:none; border:none; color:rgba(255,255,255,.82); font-size:13.5px; font-weight:500;
          cursor:pointer; font-family:inherit; padding:7px 12px; border-radius:6px; transition:background .12s,color .12s; }
        .lp-nav:hover { background:rgba(255,255,255,.12); color:#fff; }
        .lp-tile { transition: box-shadow .16s, transform .16s, border-color .16s; }
        .lp-tile:hover { box-shadow:0 6px 20px rgba(0,112,242,.10); transform:translateY(-2px); border-color:${SAP.blue}; }
        .lp-primary { transition: background .14s, box-shadow .14s, transform .14s; }
        .lp-primary:hover { background:${SAP.blueDk}; box-shadow:0 4px 14px rgba(0,112,242,.32); transform:translateY(-1px); }
        .lp-secondary { transition: background .14s, border-color .14s; }
        .lp-secondary:hover { background:#eef1f5; border-color:${SAP.borderLt}; }
      `}</style>

      {/* ── Fiori shell bar ── */}
      <header style={{
        height: 48, background: SAP.navy, display: 'flex', alignItems: 'center',
        padding: '0 22px', gap: 16, position: 'sticky', top: 0, zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 6, background: 'rgba(255,255,255,.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ShipbridgeMark size={17} color="#7fb0ff"/>
          </div>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: 16, letterSpacing: '.02em' }}>ShipBridge</span>
          <span style={{ color: 'rgba(255,255,255,.5)', fontSize: 12.5, marginLeft: 2 }}>SAP Integration Suite Accelerator</span>
        </div>
        <nav style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
          <button className="lp-nav" onClick={() => go('home')}>Home</button>
          <button className="lp-nav" onClick={() => go('compare')}>Compare</button>
          <button className="lp-nav" onClick={() => go('trace')}>Real Trace</button>
          <button className="lp-nav" onClick={() => go('trigger')}>Live Trigger</button>
          <button className="lp-nav" onClick={() => go('intel')}>Intelligence</button>
          <button className="lp-nav" onClick={() => go('docs')}>Documentation</button>
        </nav>
      </header>

      {/* ── Hero ── */}
      <section style={{ maxWidth: 1120, margin: '0 auto', padding: '72px 32px 56px', textAlign: 'center' }}>
        <div style={{ animation: ready ? 'lp-fade .6s both' : 'none' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 13px', borderRadius: 20,
            border: `1px solid ${SAP.border}`, background: '#fff', marginBottom: 24,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: SAP.blue }}/>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: SAP.sub }}>A developer accelerator for SAP Cloud Integration</span>
          </div>
          <h1 style={{ fontSize: 'clamp(34px, 5vw, 56px)', fontWeight: 700, lineHeight: 1.1, margin: 0, letterSpacing: '-.02em', color: SAP.text }}>
            See exactly what your<br/>iFlow shipped — and did.
          </h1>
          <p style={{ fontSize: 17, color: SAP.sub, maxWidth: 620, margin: '22px auto 0', lineHeight: 1.6 }}>
            ShipBridge reads real execution traces from your tenant, diffs two package versions down to the mapping field, and turns the result into specifications and impact analysis — all in one workspace.
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 30, flexWrap: 'wrap' }}>
            <button className="lp-primary" onClick={() => go('home')} style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '13px 28px', borderRadius: 8,
              border: 'none', background: SAP.blue, color: '#fff', fontSize: 15.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}>Open ShipBridge →</button>
            <button className="lp-secondary" onClick={() => go('compare')} style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '13px 26px', borderRadius: 8,
              border: `1px solid ${SAP.border}`, background: '#fff', color: SAP.text, fontSize: 15.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}>Compare packages</button>
          </div>
        </div>

        {/* Stat row */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 48, marginTop: 56, flexWrap: 'wrap', animation: ready ? 'lp-fade .6s .15s both' : 'none' }}>
          {STATS.map(s => (
            <div key={s.label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 30, fontWeight: 700, color: SAP.blue }}>{s.n}</div>
              <div style={{ fontSize: 13, color: SAP.sub, marginTop: 4, maxWidth: 160 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Feature tiles ── */}
      <section style={{ maxWidth: 1120, margin: '0 auto', padding: '8px 32px 64px' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h2 style={{ fontSize: 28, fontWeight: 700, margin: 0, color: SAP.text, letterSpacing: '-.01em' }}>Everything a CPI developer needs</h2>
          <p style={{ fontSize: 15, color: SAP.sub, margin: '10px auto 0', maxWidth: 560 }}>Six tools in one accelerator, built around how integration work actually happens.</p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
          {FEATURES.map((f, i) => (
            <motion.button key={f.id}
              onClick={() => go(f.id)}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.4, delay: (i % 3) * 0.08 }}
              className="lp-tile"
              style={{
                background: SAP.card, border: `1px solid ${SAP.border}`, borderRadius: 10,
                padding: '20px 22px', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                display: 'flex', flexDirection: 'column', gap: 12, position: 'relative',
              }}>
              {f.badge && (
                <span style={{
                  position: 'absolute', top: 18, right: 18, fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em',
                  padding: '2px 8px', borderRadius: 4, background: 'rgba(0,112,242,.1)', color: SAP.blue,
                }}>{f.badge}</span>
              )}
              <div style={{ width: 44, height: 44, borderRadius: 9, background: 'rgba(0,112,242,.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke={SAP.blue} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{ICONS[f.icon]}</svg>
              </div>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: SAP.text, marginBottom: 6 }}>{f.title}</div>
                <div style={{ fontSize: 13.5, color: SAP.sub, lineHeight: 1.55 }}>{f.desc}</div>
              </div>
              <div style={{ marginTop: 'auto', fontSize: 13, fontWeight: 600, color: SAP.blue, display: 'flex', alignItems: 'center', gap: 5 }}>
                Open <span style={{ fontSize: 14 }}>→</span>
              </div>
            </motion.button>
          ))}
        </div>
      </section>

      {/* ── What it connects to (BTP access) ── */}
      <section style={{ background: '#fff', borderTop: `1px solid ${SAP.border}`, borderBottom: `1px solid ${SAP.border}` }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', padding: '56px 32px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 40, alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: 26, fontWeight: 700, margin: 0, color: SAP.text, letterSpacing: '-.01em' }}>Connects to your tenant, read-only</h2>
            <p style={{ fontSize: 15, color: SAP.sub, margin: '14px 0 0', lineHeight: 1.65 }}>
              ShipBridge uses a standard SAP BTP Process Integration Runtime service key. It only ever reads — it never creates, changes, or deletes anything in your tenant. Credentials stay in your browser session and are never persisted.
            </p>
          </div>
          <div style={{ background: SAP.bg, border: `1px solid ${SAP.border}`, borderRadius: 10, padding: '20px 22px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: SAP.faint, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 12 }}>Roles required</div>
            {[['MessagePayloadsRead', 'Read message payloads at each step'], ['MonitoringDataRead', 'Read run metadata and status']].map(([role, why]) => (
              <div key={role} style={{ display: 'flex', gap: 10, padding: '9px 0', borderBottom: `1px solid ${SAP.borderLt}` }}>
                <span style={{ color: SAP.green, flexShrink: 0, marginTop: 1 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                <div>
                  <code style={{ fontSize: 13, fontWeight: 600, color: SAP.text, fontFamily: 'JetBrains Mono, monospace' }}>{role}</code>
                  <div style={{ fontSize: 12.5, color: SAP.sub, marginTop: 2 }}>{why}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section style={{ maxWidth: 1120, margin: '0 auto', padding: '64px 32px', textAlign: 'center' }}>
        <h2 style={{ fontSize: 30, fontWeight: 700, margin: 0, color: SAP.text, letterSpacing: '-.01em' }}>Know what shipped. Before it ships.</h2>
        <p style={{ fontSize: 15.5, color: SAP.sub, margin: '12px auto 26px', maxWidth: 540 }}>
          Drop in two package versions and see every real change in seconds — or connect your tenant and read a live trace.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="lp-primary" onClick={() => go('home')} style={{
            padding: '13px 28px', borderRadius: 8, border: 'none', background: SAP.blue, color: '#fff',
            fontSize: 15.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>Open ShipBridge →</button>
          <button className="lp-secondary" onClick={() => go('trace')} style={{
            padding: '13px 26px', borderRadius: 8, border: `1px solid ${SAP.border}`, background: '#fff', color: SAP.text,
            fontSize: 15.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>Read a real trace</button>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ borderTop: `1px solid ${SAP.border}`, background: '#fff' }}>
        <div style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 32px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <ShipbridgeMark size={18} color={SAP.blue}/>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: SAP.text, letterSpacing: '.02em' }}>ShipBridge</span>
          <span style={{ fontSize: 12.5, color: SAP.faint }}>SAP Integration Suite Accelerator</span>
        </div>
      </footer>
    </div>
  )
}
