import { useState, useEffect, useRef } from 'react'

const COMMANDS = [
  { id:'goto-trace', label:'Go to Real Trace', desc:'Read execution trace from your CPI tenant', icon:'🛰', action:'goto-trace' },
  { id:'goto-trigger', label:'Open Live Trigger', desc:'Send real payload to CPI', icon:'🚀', action:'goto-trigger' },
  { id:'goto-intel', label:'Go to Intelligence', desc:'Cross-flow dependency analysis', icon:'🧠', action:'goto-intel' },
  { id:'goto-converter', label:'Go to Converter', desc:'Convert XML/JSON/CSV/YAML/XSLT', icon:'🔄', action:'goto-converter' },
  { id:'goto-docs', label:'Go to Documentation', desc:'Generate a Technical Specification', icon:'📄', action:'goto-docs' },
  { id:'clear', label:'Clear Registry', desc:'Remove all loaded iFlows', icon:'🗑', action:'clear' },
  { id:'help', label:'Open Help', desc:'Get assistance from AI', icon:'💬', action:'open-help' },
]

export default function CommandBar({ onAction, onClose }) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef()

  useEffect(() => { inputRef.current?.focus() }, [])

  const filtered = COMMANDS.filter(c =>
    !query || c.label.toLowerCase().includes(query.toLowerCase()) || c.desc.toLowerCase().includes(query.toLowerCase())
  )

  function handleKey(e) {
    if(e.key === 'Escape') { e.preventDefault(); onClose() }
    if(e.key === 'ArrowDown') { e.preventDefault(); setSelected(s=>Math.min(s+1, filtered.length-1)) }
    if(e.key === 'ArrowUp') { e.preventDefault(); setSelected(s=>Math.max(s-1, 0)) }
    if(e.key === 'Enter') { e.preventDefault(); if(filtered[selected]) { onAction(filtered[selected].action); onClose() } }
  }

  return (
    <div className="command-bar" onClick={onClose}>
      <div className="command-box" onClick={e=>e.stopPropagation()}>
        <div style={{display:'flex',alignItems:'center',gap:10,padding:'0 14px',borderBottom:'1px solid var(--border)'}}>
          <span style={{fontSize:16,color:'var(--text3)'}}>⌘</span>
          <input
            ref={inputRef}
            className="command-input"
            value={query}
            onChange={e=>{setQuery(e.target.value);setSelected(0)}}
            onKeyDown={handleKey}
            placeholder="Type a command or search…"
          />
          <span style={{fontSize:11,color:'var(--text3)',whiteSpace:'nowrap'}}>ESC to close</span>
        </div>
        {filtered.length === 0 && (
          <div style={{padding:'20px',textAlign:'center',color:'var(--text3)',fontSize:13}}>No commands found</div>
        )}
        {filtered.map((c,i)=>(
          <div key={c.id}
            className={`command-item ${i===selected?'selected':''}`}
            onClick={()=>{onAction(c.action);onClose()}}
            onMouseEnter={()=>setSelected(i)}
          >
            <span style={{fontSize:16,width:24,textAlign:'center'}}>{c.icon}</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:500,color:'var(--text)',fontSize:13}}>{c.label}</div>
              <div style={{fontSize:12,color:'var(--text3)'}}>{c.desc}</div>
            </div>
            {c.shortcut&&<span style={{fontSize:11,color:'var(--text3)',fontFamily:'monospace',background:'var(--bg3)',padding:'2px 6px',borderRadius:4}}>{c.shortcut}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
