import { useState, useRef, useEffect } from 'react'

const SYSTEM = `You are the ShipBridge CPI Assistant — a focused helper for SAP Cloud Integration (CPI) developers working inside the ShipBridge workspace. You help specifically with:
- Explaining an uploaded iFlow: what it does, step by step
- Explaining errors and exceptions seen in a Real Trace or Checkpoint session
- Suggesting test payloads (valid, invalid, edge cases) for a flow
- Explaining router branch conditions and which branch a message would take
- Explaining likely Groovy script and message-mapping behaviour

Stay on SAP CPI / integration topics. If asked something unrelated (general knowledge, non-CPI coding, etc.), briefly redirect back to how you can help with their iFlows — do not answer off-topic questions at length.

About ShipBridge:
- Real Trace: reads the actual Message Processing Log and trace data from a deployed CPI tenant — real payloads, real errors, real timing at every step.
- Live Trigger: tests deployed iFlows by sending real payloads to a tenant, without needing a sender system.
- Intelligence: maps shared scripts, ProcessDirect links, dead assets and circular dependencies across loaded flows.
- Converter: converts payloads between XML, JSON, CSV, YAML, XSLT and Markdown.
- Documentation / Spec Builder: turns an iFlow into a Technical Specification Word document.
- Checkpoint: pauses a real CPI iFlow mid-execution (via a Groovy webhook script) so its body/headers/properties can be inspected and edited before release.

Be clear about what's read directly from CPI (Real Trace, Checkpoint) vs AI-assisted (Groovy/mapping explanations, spec field drafting) vs deterministic extraction (adapters, dependencies). Be concise, practical, and friendly. Use bullet points when listing steps.`

const QUICK = [
  'Explain what this iFlow does',
  'Why did this step fail?',
  'Suggest test payloads for this flow',
  'Which router branch will my message take?',
  'Explain this Groovy script behaviour',
]

export default function HelpPanel({ open, onClose }) {
  const [messages, setMessages] = useState([
    { role:'assistant', text:'Hi! I\'m the ShipBridge CPI assistant. Ask me about your uploaded iFlows, a trace you\'re debugging, test payloads, or Groovy and mapping behaviour.' }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef()

  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:'smooth'}) },[messages])

  async function send(text) {
    const q = text||input.trim(); if(!q) return
    setInput('')
    const history = [...messages, {role:'user',text:q}]
    setMessages(history)
    setLoading(true)
    try {
      const apiMessages = history.map(m=>({role:m.role==='assistant'?'assistant':'user',content:m.text}))
      const resp = await fetch('/api/simulate',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({system:SYSTEM,message:q,history:apiMessages.slice(0,-1)})
      })
      const reader=resp.body.getReader(),dec=new TextDecoder()
      let buf='',full=''
      setMessages(m=>[...m,{role:'assistant',text:''}])
      while(true){
        const{done,value}=await reader.read(); if(done)break
        buf+=dec.decode(value,{stream:true})
        const lines=buf.split('\n');buf=lines.pop()
        for(const line of lines){
          if(!line.startsWith('data: '))continue
          const data=line.slice(6);if(data==='[DONE]')continue
          try{const ev=JSON.parse(data);if(ev.type==='content_block_delta'&&ev.delta?.type==='text_delta'){full+=ev.delta.text;setMessages(m=>{const c=[...m];c[c.length-1]={role:'assistant',text:full};return c})}}catch{}
        }
      }
    } catch(e){ setMessages(m=>[...m,{role:'assistant',text:'Error: '+e.message}]) }
    finally{setLoading(false)}
  }

  function clearChat() {
    setMessages([{role:'assistant',text:'Chat cleared. Ask me anything!'}])
  }

  return(
    <>
      {open&&<div style={{position:'fixed',inset:0,zIndex:99}} onClick={onClose}/>}
      <div className={`help-panel ${open?'open':''}`}>
        <div style={{padding:'12px 16px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between',background:'var(--bg3)'}}>
          <div>
            <div style={{fontWeight:700,fontSize:15}}>ShipBridge CPI Assistant</div>
            <div style={{fontSize:12,color:'var(--text3)',marginTop:1}}>Ask anything — CPI, SAP, coding, or general</div>
          </div>
          <div style={{display:'flex',gap:6}}>
            <button className="btn btn-ghost btn-sm" onClick={clearChat} title="Clear chat">🗑 Clear</button>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
          </div>
        </div>

        <div style={{padding:'10px 14px',borderBottom:'1px solid var(--border)',background:'var(--bg)'}}>
          <p style={{fontSize:11,fontWeight:600,color:'var(--text3)',marginBottom:8,letterSpacing:'.06em',textTransform:'uppercase'}}>Quick questions</p>
          <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
            {QUICK.map(q=>(
              <button key={q} onClick={()=>send(q)}
                style={{fontSize:11,padding:'3px 9px',border:'1px solid var(--border)',borderRadius:4,background:'transparent',cursor:'pointer',color:'var(--text2)',transition:'all .1s',fontFamily:'inherit'}}
                onMouseEnter={e=>{e.target.style.borderColor='var(--blue)';e.target.style.color='var(--blue)'}}
                onMouseLeave={e=>{e.target.style.borderColor='var(--border)';e.target.style.color='var(--text2)'}}>
                {q}
              </button>
            ))}
          </div>
        </div>

        <div style={{flex:1,overflow:'auto',padding:'14px',display:'flex',flexDirection:'column',gap:10}}>
          {messages.map((m,i)=>(
            <div key={i} style={{display:'flex',justifyContent:m.role==='user'?'flex-end':'flex-start'}}>
              <div className={`chat-bubble ${m.role}`} style={{whiteSpace:'pre-wrap'}}>
                {m.text||<span className="dot"/>}
              </div>
            </div>
          ))}
          <div ref={bottomRef}/>
        </div>

        <div style={{padding:'10px 14px',borderTop:'1px solid var(--border)',display:'flex',gap:8}}>
          <input type="text" value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&send()}
            placeholder="Ask anything…"
            style={{flex:1,padding:'8px 12px',fontSize:13,border:'1px solid var(--border)',borderRadius:6,background:'var(--bg)',color:'var(--text)',fontFamily:'inherit'}}
          />
          <button className="btn btn-primary btn-sm" onClick={()=>send()} disabled={loading||!input.trim()}>Send</button>
        </div>
      </div>
    </>
  )
}
