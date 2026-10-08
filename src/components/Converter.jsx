import { useState, useEffect } from 'react'
import yaml from 'js-yaml'
import { marked } from 'marked'
import { saveConverterSnippet, listConverterSnippets, deleteConverterSnippet } from '../lib/storage.js'
import { deferRevoke } from '../lib/downloadUtils.js'

// ── XML ────────────────────────────────────────────────────────────────────
function prettyXML(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error(err.textContent.split('\n')[0])
  let ind = 0
  return new XMLSerializer().serializeToString(doc)
    .replace(/></g,'>\n<').split('\n').map(line => {
      const t = line.trim()
      if (t.startsWith('</')) ind = Math.max(0, ind - 1)
      const out = '  '.repeat(ind) + t
      if (t.startsWith('<') && !t.startsWith('</') && !t.startsWith('<?') && !t.startsWith('<!') && !t.endsWith('/>') && !t.match(/<.*>.*<\/.*>/)) ind++
      return out
    }).join('\n')
}
function minifyXML(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML')
  return new XMLSerializer().serializeToString(doc).replace(/>\s+</g,'><')
}
function validateXML(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const err = doc.querySelector('parsererror')
  if (err) return { ok:false, msg: err.textContent.split('\n')[0] }
  return { ok:true, msg:`Valid XML — ${doc.querySelectorAll('*').length} elements` }
}
function xmlToJSON(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML')
  function node(n) {
    if (n.nodeType===3) return n.textContent.trim()||null
    const obj={}
    for (const c of n.childNodes) {
      if (c.nodeType!==1) continue
      const k=c.tagName,v=node(c)
      if(obj[k]!==undefined){if(!Array.isArray(obj[k]))obj[k]=[obj[k]];obj[k].push(v)}
      else obj[k]=v
    }
    return Object.keys(obj).length?obj:(n.textContent.trim()||null)
  }
  return JSON.stringify(node(doc.documentElement),null,2)
}
// XML element names cannot start with a digit or contain most punctuation
// (XML 1.0 §2.3 Name). JSON keys like "3" or "12184" produce invalid XML
// unless sanitized — CPI will reject them at import. Prefix digit-starting
// keys with an underscore and replace disallowed characters, matching what
// the built-in JSON-to-XML converters do.
function xmlSafeName(name) {
  let n = String(name).replace(/[^A-Za-z0-9_.\-]/g, '_')
  if (!n) n = '_'
  if (/^[0-9.\-]/.test(n)) n = '_' + n
  return n
}

function jsonToXML(jsonStr, root='root') {
  const obj = JSON.parse(jsonStr)
  const pad = (d) => '  '.repeat(d)
  function conv(o, tag, depth) {
    const safeTag = xmlSafeName(tag)
    if (o === null || o === undefined) return `${pad(depth)}<${safeTag}/>`
    if (typeof o !== 'object') return `${pad(depth)}<${safeTag}>${escXml(String(o))}</${safeTag}>`
    if (Array.isArray(o)) return o.map(i => conv(i, tag, depth)).join('\n')
    const inner = Object.entries(o).map(([k, v]) => conv(v, k, depth + 1)).join('\n')
    return `${pad(depth)}<${safeTag}>\n${inner}\n${pad(depth)}</${safeTag}>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + conv(obj, root, 0)
}
const escXml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
const unescXml = s => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'")

// ── XSD generation ─────────────────────────────────────────────────────────
//
// Infer an XSD schema from a sample payload. This solves the SAP CPI pain
// point where developers paste sample XML into a mapping and need a .xsd to
// import — CPI has no built-in "sample → schema" step, so people use
// external websites or Notepad++ plugins today (see SAP Community blog
// "Graphical XSD Builder & XML To XSD Converter").
//
// The inference is deliberately loose — we build a starting-point schema
// the developer will tighten by hand. Every leaf is xs:string unless the
// text unambiguously looks numeric / boolean / date, in which case we pick
// the narrowest fitting built-in type. Repeated sibling elements become
// maxOccurs="unbounded" on the child. Optional siblings become minOccurs="0".

const XS_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
const XS_DATE     = /^\d{4}-\d{2}-\d{2}$/
const XS_INT      = /^-?\d+$/
const XS_DECIMAL  = /^-?\d+\.\d+$/
const XS_BOOL     = /^(true|false)$/i

function inferXsdType(samples) {
  const vals = samples.filter(v => v !== null && v !== undefined && v !== '')
  if (vals.length === 0) return 'xs:string'
  if (vals.every(v => XS_BOOL.test(v)))     return 'xs:boolean'
  if (vals.every(v => XS_INT.test(v)))      return 'xs:integer'
  if (vals.every(v => XS_INT.test(v) || XS_DECIMAL.test(v))) return 'xs:decimal'
  if (vals.every(v => XS_DATETIME.test(v))) return 'xs:dateTime'
  if (vals.every(v => XS_DATE.test(v)))     return 'xs:date'
  return 'xs:string'
}

// Walk one or more XML sample documents into a shape tree:
//   { children: Map<name, {samples, occurrences, node}>, textSamples: [...] }
// occurrences counts how many parent instances the child appeared in — an
// element seen in every parent is required, one seen sometimes is optional.
function analyzeXmlNode(el, shape) {
  shape.instances = (shape.instances || 0) + 1
  const kids = [...el.children]
  const kidCountsThisParent = new Map()
  for (const kid of kids) {
    const name = kid.tagName
    kidCountsThisParent.set(name, (kidCountsThisParent.get(name) || 0) + 1)
    if (!shape.children) shape.children = new Map()
    if (!shape.children.has(name)) {
      shape.children.set(name, { instances: 0, maxInOneParent: 0, textSamples: [], childShape: null })
    }
    const child = shape.children.get(name)
    if (kid.children.length === 0) {
      // Leaf — collect text sample
      const text = (kid.textContent || '').trim()
      if (text) child.textSamples.push(text)
    } else {
      if (!child.childShape) child.childShape = {}
      analyzeXmlNode(kid, child.childShape)
    }
  }
  for (const [name, count] of kidCountsThisParent) {
    const child = shape.children.get(name)
    child.instances += 1                                    // seen in this parent
    if (count > child.maxInOneParent) child.maxInOneParent = count
  }
}

function emitComplexType(shape, indent) {
  const pad = '  '.repeat(indent)
  const pad1 = '  '.repeat(indent + 1)
  const pad2 = '  '.repeat(indent + 2)
  if (!shape.children || shape.children.size === 0) return ''
  let out = `${pad}<xs:complexType>\n${pad1}<xs:sequence>\n`
  for (const [name, child] of shape.children) {
    const optional = child.instances < shape.instances ? ' minOccurs="0"' : ''
    const unbounded = child.maxInOneParent > 1 ? ' maxOccurs="unbounded"' : ''
    if (child.childShape) {
      out += `${pad2}<xs:element name="${xmlSafeName(name)}"${optional}${unbounded}>\n`
      out += emitComplexType(child.childShape, indent + 3)
      out += `${pad2}</xs:element>\n`
    } else {
      const type = inferXsdType(child.textSamples)
      out += `${pad2}<xs:element name="${xmlSafeName(name)}" type="${type}"${optional}${unbounded}/>\n`
    }
  }
  out += `${pad1}</xs:sequence>\n${pad}</xs:complexType>\n`
  return out
}

function xmlToXSD(xml, targetNamespace) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new Error(err.textContent.split('\n')[0])
  const root = doc.documentElement
  if (!root) throw new Error('XML has no root element')
  const shape = {}
  analyzeXmlNode(root, shape)
  // SAP CPI's Message Mapping import expects a schema with a single global
  // element and elementFormDefault="qualified" for reliable behaviour — see
  // SAP Community threads on XSD import issues. Adding a targetNamespace is
  // optional but recommended; passing it exposes xmlns and targetNamespace
  // together so the namespace prefix works inside CPI's mapping editor.
  const ns = targetNamespace || ''
  const nsAttr = ns
    ? ` targetNamespace="${escXml(ns)}" xmlns="${escXml(ns)}" elementFormDefault="qualified"`
    : ` elementFormDefault="qualified"`
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`
  out += `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"${nsAttr}>\n`
  out += `  <xs:annotation>\n`
  out += `    <xs:documentation>Generated by ShipBridge from a sample payload. Type inference is a starting point — review restrictions, patterns and cardinalities before deploying.</xs:documentation>\n`
  out += `  </xs:annotation>\n`
  out += `  <xs:element name="${xmlSafeName(root.tagName)}">\n`
  out += emitComplexType(shape, 2)
  out += `  </xs:element>\n</xs:schema>\n`
  return out
}

// JSON → XSD reuses the XML pipeline: convert to XML first, then to XSD.
// This keeps one source of truth for shape inference and means both paths
// produce identical schemas from equivalent inputs.
function jsonToXSD(jsonStr, root, targetNamespace) {
  const xml = jsonToXML(jsonStr, root || 'root')
  return xmlToXSD(xml, targetNamespace || '')
}


// ── CSV ─────────────────────────────────────────────────────────────────────
function parseCSV(text, delim=',') {
  const rows=[];let row=[],field='',inQ=false,i=0
  while(i<text.length){
    const c=text[i]
    if(inQ){
      if(c==='"'&&text[i+1]==='"'){field+='"';i+=2;continue}
      if(c==='"'){inQ=false;i++;continue}
      field+=c
    }else{
      if(c==='"'){inQ=true;i++;continue}
      if(c===delim){row.push(field);field='';i++;continue}
      if(c==='\n'||(c==='\r'&&text[i+1]==='\n')){row.push(field);rows.push(row);row=[];field='';if(c==='\r')i++;i++;continue}
      field+=c
    }
    i++
  }
  if(field||row.length){row.push(field);rows.push(row)}
  return rows
}
function csvToJSON(text,delim){
  const rows=parseCSV(text,delim);if(!rows.length)return'[]'
  const hdrs=rows[0]
  return JSON.stringify(rows.slice(1).filter(r=>r.some(f=>f.trim())).map(row=>{const o={};hdrs.forEach((h,i)=>{o[h.trim()]=row[i]?.trim()??''});return o}),null,2)
}
function csvToXML(text,delim){
  const data=JSON.parse(csvToJSON(text,delim))
  return `<?xml version="1.0" encoding="UTF-8"?>\n<root>\n`+data.map(o=>`  <row>\n${Object.entries(o).map(([k,v])=>`    <${k}>${escXml(v)}</${k}>`).join('\n')}\n  </row>`).join('\n')+'\n</root>'
}
function jsonToCSV(text){
  var data = JSON.parse(text)
  var arr = Array.isArray(data) ? data : [data]
  var hdrs = Object.keys(arr[0] || {})
  function qf(val) {
    var s = String(val == null ? '' : val)
    var hasSpecial = s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\\n') >= 0
    return hasSpecial ? '"' + s.split('"').join('""') + '"' : s
  }
  return hdrs.join(',') + '\n' + arr.map(function(row){ return hdrs.map(function(h){ return qf(row[h]) }).join(',') }).join('\n')
}

// ── XPath ───────────────────────────────────────────────────────────────────
function runXPath(xml,xpath){
  try{
    const doc=new DOMParser().parseFromString(xml,'text/xml')
    if(doc.querySelector('parsererror'))return{error:'Invalid XML'}
    const r=doc.evaluate(xpath,doc,null,XPathResult.ANY_TYPE,null)
    const vals=[]
    if(r.resultType===XPathResult.STRING_TYPE)return{values:[r.stringValue]}
    if(r.resultType===XPathResult.NUMBER_TYPE)return{values:[String(r.numberValue)]}
    if(r.resultType===XPathResult.BOOLEAN_TYPE)return{values:[String(r.booleanValue)]}
    let n=r.iterateNext()
    while(n){vals.push(n.textContent||new XMLSerializer().serializeToString(n));n=r.iterateNext()}
    return{values:vals.length?vals:['(no match)']}
  }catch(e){return{error:e.message}}
}

function autoDetect(text){
  const t=text.trim()
  if(t.startsWith('<'))return'xml'
  if(t.startsWith('{')||t.startsWith('['))return'json'
  if(/^#{1,6}\s/m.test(t)||/^[-*]\s/m.test(t)||t.includes('```')||/\[.+\]\(.+\)/.test(t))return'md'
  if(t.includes(',')||t.includes(';')||t.includes('\t'))return'csv'
  return'text'
}

const DELIMITERS={'Comma (,)':',','Semicolon (;)':';','Tab':'\t','Pipe (|)':'|'}
// All actions with source → target info
const ACTIONS = {
  xml:[
    {id:'pretty',    label:'Pretty Print',    src:'XML',  tgt:'XML'},
    {id:'minify',    label:'Minify',           src:'XML',  tgt:'XML'},
    {id:'validate',  label:'Validate',         src:'XML',  tgt:'✓'},
    {id:'escape',    label:'Escape',           src:'XML',  tgt:'Text'},
    {id:'unescape',  label:'Unescape',         src:'Text', tgt:'XML'},
    {id:'rmxmldecl', label:'Remove <?xml?>',   src:'XML',  tgt:'XML'},
    {id:'xml2json',  label:'→ JSON',           src:'XML',  tgt:'JSON'},
    {id:'xml2csv',   label:'→ CSV',            src:'XML',  tgt:'CSV'},
    {id:'xml2yaml',  label:'→ YAML',           src:'XML',  tgt:'YAML'},
    {id:'xslt-transform', label:'Apply XSLT',  src:'XML',  tgt:'XML'},
  ],
  md:[
    {id:'md2html',  label:'→ HTML',            src:'MD',   tgt:'HTML'},
  ],
  json:[
    {id:'json-pretty',label:'Pretty Print',   src:'JSON', tgt:'JSON'},
    {id:'json-minify', label:'Minify',         src:'JSON', tgt:'JSON'},
    {id:'json-validate',label:'Validate',      src:'JSON', tgt:'✓'},
    {id:'json2xml',    label:'→ XML',          src:'JSON', tgt:'XML'},
    {id:'json2csv',    label:'→ CSV',          src:'JSON', tgt:'CSV'},
    {id:'json2yaml',   label:'→ YAML',         src:'JSON', tgt:'YAML'},
  ],
  csv:[
    {id:'csv2json',label:'→ JSON',             src:'CSV',  tgt:'JSON'},
    {id:'csv2xml', label:'→ XML',              src:'CSV',  tgt:'XML'},
  ],
  text:[
    {id:'yaml2json', label:'YAML → JSON',      src:'YAML', tgt:'JSON'},
    {id:'yaml2xml',  label:'YAML → XML',       src:'YAML', tgt:'XML'},
    {id:'yaml-pretty', label:'YAML Pretty',    src:'YAML', tgt:'YAML'},
    {id:'md2html',  label:'Markdown → HTML',   src:'MD',   tgt:'HTML'},
  ],
}


// Basic HTML indenter — good enough for the marked.parse() output. Not a
// general HTML formatter (no attribute wrapping, no comment handling), just
// enough to make blog-post markdown output legible instead of one long line.
function prettyHTML(html) {
  const tokens = html.replace(/></g, '>\n<').split('\n')
  let depth = 0
  const VOID = new Set(['br','hr','img','input','meta','link','source','track','wbr','area','base','col','embed','param'])
  return tokens.map(line => {
    const t = line.trim()
    if (!t) return null
    const close = /^<\//.test(t)
    const selfClose = /\/>\s*$/.test(t) || VOID.has((t.match(/^<([a-z0-9]+)/i) || [])[1]?.toLowerCase())
    const openAndClose = /^<([a-z0-9]+)[^>]*>.*<\/\1>\s*$/i.test(t)
    if (close) depth = Math.max(0, depth - 1)
    const out = '  '.repeat(depth) + t
    if (!close && !selfClose && !openAndClose && /^</.test(t)) depth++
    return out
  }).filter(Boolean).join('\n')
}


// Detect what's in the output pane by sniffing the first non-whitespace char
// (and a couple of shapes for edge cases) and route to the right pretty-
// printer. Order matters — XML/XSD/HTML all start with '<', so try structured
// XML parsing first and fall back to HTML if the parser rejects it.
function prettifyAny(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return text
  const first = trimmed[0]

  // JSON — { or [
  if (first === '{' || first === '[') {
    try { return JSON.stringify(JSON.parse(trimmed), null, 2) } catch { /* fall through */ }
  }

  // XML / XSD / HTML — <
  if (first === '<') {
    // Try strict XML first (works for XML, XSD, valid XHTML)
    try { return prettyXML(trimmed) } catch { /* fall through */ }
    // Fall back to the HTML indenter (loose parse — works for marked's output)
    try { return prettyHTML(trimmed) } catch { /* fall through */ }
  }

  // YAML — no reliable first-char signal, try to load and re-dump
  try {
    const parsed = yaml.load(trimmed)
    if (parsed !== null && typeof parsed === 'object') return yaml.dump(parsed)
  } catch { /* fall through */ }

  // Nothing recognised — return original so we don't destroy CSV/plain text.
  return text
}

export default function Converter() {
  const [input,      setInput]      = useState('')
  const [output,     setOutput]     = useState('')
  const [inputType,  setInputType]  = useState('auto')
  const [action,     setAction]     = useState('pretty')
  const [error,      setError]      = useState(null)
  const [validation, setValidation] = useState(null)
  const [delim,      setDelim]      = useState('Comma (,)')
  const [xmlRoot,    setXmlRoot]    = useState('root')
  const [xsdNs,      setXsdNs]      = useState('')
  const [xsdOpen,    setXsdOpen]    = useState(false)
  const [copied,     setCopied]     = useState(false)
  const [xpathOpen,  setXpathOpen]  = useState(false)
  const [xpath,      setXpath]      = useState('')
  const [xpathRes,   setXpathRes]   = useState(null)
  const [snippets,   setSnippets]   = useState([])
  const [xsltSheet,  setXsltSheet]  = useState('')

  useEffect(()=>{ listConverterSnippets().then(setSnippets).catch(()=>{}) },[])

  const detectedType = inputType==='auto' ? autoDetect(input) : inputType
  const availableActions = ACTIONS[detectedType] || ACTIONS.text
  const currentAction = availableActions.find(a=>a.id===action)

  // Reset action when type changes and current action not available
  useEffect(()=>{
    if(!availableActions.find(a=>a.id===action)){
      setAction(availableActions[0]?.id||'pretty')
    }
  },[detectedType])

  function run(){
    setError(null);setValidation(null);setOutput('')
    const d=DELIMITERS[delim]
    try{
      let result=''
      switch(action){
        case 'pretty':      result=prettyXML(input);break
        case 'minify':      result=minifyXML(input);break
        case 'validate':    {const v=validateXML(input);setValidation(v);result=input;break}
        case 'escape':      result=escXml(input);break
        case 'unescape':    result=unescXml(input);break
        case 'rmxmldecl':   result=input.replace(/^<\?xml[^?]*\?>\s*/,'');break
        case 'xml2json':    result=xmlToJSON(input);break
        case 'xml2csv':     {const j=JSON.parse(xmlToJSON(input));const arr=Array.isArray(Object.values(j)[0])?Object.values(j)[0]:[j];const hdrs=Object.keys(arr[0]||{});result=hdrs.join(',')+'\n'+arr.map(r=>hdrs.map(h=>String(r[h]??'')).join(',')).join('\n');break}
        case 'xml2yaml':    result=yaml.dump(JSON.parse(xmlToJSON(input)));break
        case 'json2yaml':   result=yaml.dump(JSON.parse(input));break
        case 'yaml2json':   result=JSON.stringify(yaml.load(input),null,2);break
        case 'yaml2xml':    result=jsonToXML(JSON.stringify(yaml.load(input)),xmlRoot);break
        case 'yaml-pretty': result=yaml.dump(yaml.load(input));break
        case 'md2html':     result=prettyHTML(marked.parse(input));break
        case 'xslt-transform': {
          const xmlDoc=new DOMParser().parseFromString(input,'text/xml')
          const xslDoc=new DOMParser().parseFromString(xsltSheet,'text/xml')
          if(xmlDoc.querySelector('parsererror'))throw new Error('Input is not valid XML')
          if(xslDoc.querySelector('parsererror'))throw new Error('Stylesheet is not valid XSLT/XML')
          const proc=new XSLTProcessor();proc.importStylesheet(xslDoc)
          const out=proc.transformToDocument(xmlDoc)
          const raw=new XMLSerializer().serializeToString(out)
          // Pretty-print the XSLT result so it matches every other XML
          // output in Converter. If the transform emitted plain text (say,
          // XSLT with <xsl:output method="text"/>) prettyXML would throw,
          // so fall back to raw.
          try { result = prettyXML(raw) } catch { result = raw }
          break
        }
        case 'json-pretty': result=JSON.stringify(JSON.parse(input),null,2);break
        case 'json-minify': result=JSON.stringify(JSON.parse(input));break
        case 'json-validate':{try{JSON.parse(input);setValidation({ok:true,msg:'Valid JSON'});result=input}catch(e){setValidation({ok:false,msg:e.message});result=''}break}
        case 'json2xml':    result=jsonToXML(input,xmlRoot);break
        case 'json2csv':    result=jsonToCSV(input);break
        case 'csv2json':    result=csvToJSON(input,d);break
        case 'csv2xml':     result=csvToXML(input,d);break
        default: result=input
      }
      setOutput(result)
    }catch(e){setError(e.message)}
  }

  async function saveSnippet(){
    const label=prompt('Name this snippet:');if(!label)return
    await saveConverterSnippet(label,input,action)
    setSnippets(await listConverterSnippets())
  }

  function copy(text){navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),1500)}

  function downloadOutput(){
    const EXT={JSON:'json',XML:'xml',CSV:'csv',YAML:'yaml',HTML:'html','✓':'txt',MD:'md',XSD:'xsd'}
    const ext=EXT[currentAction?.tgt]||'txt'
    const MIME={json:'application/json',xml:'application/xml',csv:'text/csv',yaml:'text/yaml',html:'text/html',txt:'text/plain',md:'text/markdown'}
    const blob=new Blob([output],{type:MIME[ext]})
    const a=document.createElement('a')
    a.href=URL.createObjectURL(blob)
    a.download=`converted.${ext}`
    a.click()
    deferRevoke(a.href)
  }
  function swap(){setInput(output);setOutput('');setError(null);setValidation(null)}
  function clear(){setInput('');setOutput('');setError(null);setValidation(null)}

  const ta={background:'var(--bg)',border:'none',outline:'none',resize:'none',
    fontFamily:'JetBrains Mono,monospace',fontSize:12,color:'var(--text)',lineHeight:1.6,
    flex:1,padding:'12px',width:'100%',boxSizing:'border-box'}
  const inp={background:'var(--bg)',border:'1px solid var(--border)',borderRadius:6,
    padding:'6px 10px',fontSize:12,color:'var(--text)',fontFamily:'inherit',outline:'none'}

  return (
    <div style={{display:'flex',flexDirection:'column',height:'calc(100vh - 48px)',overflow:'hidden'}}>

      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <div style={{padding:'8px 14px',borderBottom:'1px solid var(--border)',background:'var(--bg2)',display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>

        {/* Source type */}
        <select value={inputType} onChange={e=>{setInputType(e.target.value)}}
          style={{...inp,padding:'5px 8px'}}>
          <option value="auto">Auto Detect</option>
          <option value="xml">XML</option>
          <option value="json">JSON</option>
          <option value="csv">CSV</option>
          <option value="text">Text</option>
        </select>

        {/* Source → Target badge */}
        {currentAction && (
          <div style={{display:'flex',alignItems:'center',gap:5}}>
            <span style={{fontSize:11,padding:'2px 7px',borderRadius:4,background:'var(--bg3)',border:'1px solid var(--border)',color:'var(--text3)',fontWeight:600}}>
              {currentAction.src}
            </span>
            <span style={{color:'var(--text3)',fontSize:13}}>→</span>
            <span style={{fontSize:11,padding:'2px 7px',borderRadius:4,
              background: currentAction.tgt==='✓'?'var(--green-bg)':'var(--blue-bg)',
              border: currentAction.tgt==='✓'?'1px solid rgba(63,185,80,.3)':'1px solid rgba(88,166,255,.3)',
              color: currentAction.tgt==='✓'?'var(--green)':'var(--blue)',fontWeight:600}}>
              {currentAction.tgt}
            </span>
          </div>
        )}

        {/* Action dropdown */}
        <select value={action} onChange={e=>setAction(e.target.value)} style={{...inp,padding:'5px 8px'}}>
          {availableActions.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
        </select>

        {/* Action-specific options */}
        {(action==='json2xml'||action==='json2xsd')&&(
          <input value={xmlRoot} onChange={e=>setXmlRoot(e.target.value)}
            placeholder="root element name"
            style={{...inp,width:140}}/>
        )}

        {action==='xslt-transform'&&(
          <textarea value={xsltSheet} onChange={e=>setXsltSheet(e.target.value)}
            placeholder="Paste your XSLT stylesheet here…"
            style={{...inp,width:'100%',minHeight:90,fontFamily:'JetBrains Mono,monospace',fontSize:12,resize:'vertical',marginTop:6}}/>
        )}
        {(action==='csv2json'||action==='csv2xml')&&(
          <select value={delim} onChange={e=>setDelim(e.target.value)} style={{...inp,padding:'5px 8px'}}>
            {Object.keys(DELIMITERS).map(d=><option key={d}>{d}</option>)}
          </select>
        )}

        <button onClick={run}
          style={{padding:'6px 18px',borderRadius:6,border:'none',background:'var(--blue)',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>
          Convert
        </button>

        <button onClick={()=>setXsdOpen(true)} title="Generate an XSD schema from a JSON or XML sample"
          style={{padding:'6px 14px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg2)',color:'var(--text)',fontSize:13,fontWeight:500,cursor:'pointer',fontFamily:'inherit'}}>
          Generate XSD →
        </button>

        {/* Right side */}
        <div style={{marginLeft:'auto',display:'flex',gap:5,alignItems:'center'}}>
          <button onClick={swap} title="Swap input/output"
            style={{padding:'4px 8px',fontSize:13,borderRadius:5,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text2)',cursor:'pointer'}}>⇄</button>
          <button onClick={clear}
            style={{padding:'4px 9px',fontSize:12,borderRadius:5,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text2)',cursor:'pointer',fontFamily:'inherit'}}>Clear</button>
          <button onClick={saveSnippet}
            style={{padding:'4px 9px',fontSize:12,borderRadius:5,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text2)',cursor:'pointer',fontFamily:'inherit'}}>Save</button>
          {snippets.length>0&&snippets.map(s=>(
            <div key={s.id} style={{display:'flex',gap:3,alignItems:'center',padding:'2px 7px',borderRadius:5,background:'var(--bg2)',border:'1px solid var(--border)'}}>
              <button onClick={()=>setInput(s.input)} style={{background:'none',border:'none',cursor:'pointer',fontSize:11,color:'var(--text)',fontFamily:'inherit'}}>{s.label}</button>
              <button onClick={async()=>{await deleteConverterSnippet(s.id);setSnippets(await listConverterSnippets())}} style={{background:'none',border:'none',cursor:'pointer',fontSize:11,color:'var(--text3)'}}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* Validation banner */}
      {validation&&(
        <div style={{padding:'5px 14px',background:validation.ok?'var(--green-bg)':'var(--red-bg)',borderBottom:'1px solid var(--border)',fontSize:12,color:validation.ok?'var(--green)':'var(--red)',fontWeight:600}}>
          {validation.ok?'✓':'✕'} {validation.msg}
        </div>
      )}

      {/* ── Editors ─────────────────────────────────────────────── */}
      <div style={{flex:1,display:'grid',gridTemplateColumns:'1fr 1fr',overflow:'hidden'}}>

        {/* Input */}
        <div style={{display:'flex',flexDirection:'column',borderRight:'1px solid var(--border)',overflow:'hidden'}}>
          <div style={{padding:'5px 12px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',gap:8,background:'var(--bg3)',flexShrink:0}}>
            <span style={{fontSize:12,fontWeight:600,color:'var(--text2)'}}>Input</span>
            {inputType==='auto'&&input&&(
              <span style={{fontSize:11,padding:'1px 6px',borderRadius:4,background:'var(--blue-bg)',color:'var(--blue)',fontWeight:600}}>
                {detectedType.toUpperCase()}
              </span>
            )}
            {input&&<span style={{fontSize:11,color:'var(--text3)',marginLeft:'auto'}}>{input.length} chars</span>}
          </div>
          <textarea style={{...ta}} value={input} onChange={e=>setInput(e.target.value)}
            placeholder="Paste your input here…"/>

          {/* XPath tester — XML only, hidden by default */}
          {detectedType==='xml'&&(
            <div style={{borderTop:'1px solid var(--border)',background:'var(--bg3)',flexShrink:0}}>
              <button onClick={()=>setXpathOpen(o=>!o)}
                style={{width:'100%',padding:'5px 12px',display:'flex',alignItems:'center',justifyContent:'space-between',background:'transparent',border:'none',cursor:'pointer',fontFamily:'inherit',color:'var(--text3)',fontSize:12}}>
                <span>XPath Tester <span style={{fontSize:11,opacity:.6}}>(optional)</span></span>
                <span style={{transform:xpathOpen?'rotate(180deg)':'none',display:'inline-block',transition:'transform .15s'}}>▾</span>
              </button>
              {xpathOpen&&(
                <div style={{padding:'8px 12px',borderTop:'1px solid var(--border)'}}>
                  <div style={{display:'flex',gap:6}}>
                    <input value={xpath} onChange={e=>setXpath(e.target.value)} placeholder=""
                      style={{flex:1,padding:'5px 8px',fontSize:12,border:'1px solid var(--border)',borderRadius:5,background:'var(--bg)',color:'var(--text)',fontFamily:'monospace'}}
                      onKeyDown={e=>e.key==='Enter'&&setXpathRes(runXPath(input,xpath))}/>
                    <button onClick={()=>setXpathRes(runXPath(input,xpath))}
                      style={{padding:'5px 12px',fontSize:12,borderRadius:5,border:'none',background:'var(--blue)',color:'#fff',cursor:'pointer',fontFamily:'inherit'}}>Test</button>
                  </div>
                  {xpathRes&&(
                    <div style={{marginTop:6,fontSize:12,fontFamily:'monospace',color:xpathRes.error?'var(--red)':'var(--green)'}}>
                      {xpathRes.error?`Error: ${xpathRes.error}`:xpathRes.values.map((v,i)=><div key={i}>[{i}] {v}</div>)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div style={{padding:'8px 12px',borderTop:'1px solid var(--border)',background:'var(--bg3)',flexShrink:0}}>
            <button onClick={run}
              style={{width:'100%',padding:'8px',borderRadius:6,border:'none',background:'var(--blue)',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>
              Convert →
            </button>
          </div>
        </div>

        {/* Output */}
        <div style={{display:'flex',flexDirection:'column',overflow:'hidden'}}>
          <div style={{padding:'5px 12px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',gap:8,background:'var(--bg3)',flexShrink:0}}>
            <span style={{fontSize:12,fontWeight:600,color:'var(--text2)'}}>Output</span>
            {output&&<span style={{fontSize:11,color:'var(--text3)',marginLeft:'auto'}}>{output.length} chars</span>}
            {output&&(
              <button onClick={()=>setOutput(prettifyAny(output))}
                title="Detects XML, JSON, YAML, HTML and re-indents. Leaves CSV or plain text untouched."
                style={{fontSize:11,padding:'2px 8px',borderRadius:4,border:'1px solid var(--border)',background:'var(--bg2)',color:'var(--text2)',cursor:'pointer',fontFamily:'inherit'}}>
                ✨ Pretty
              </button>
            )}
            {output&&(
              <button onClick={()=>copy(output)}
                style={{fontSize:11,padding:'2px 8px',borderRadius:4,border:'1px solid var(--border)',background:'var(--bg2)',color:'var(--text2)',cursor:'pointer',fontFamily:'inherit'}}>
                {copied?'✓ Copied':'Copy'}
              </button>
            )}
            {output&&(
              <button onClick={downloadOutput}
                style={{fontSize:11,padding:'2px 8px',borderRadius:4,border:'1px solid var(--border)',background:'var(--bg2)',color:'var(--text2)',cursor:'pointer',fontFamily:'inherit'}}>
                ⬇ Download
              </button>
            )}
          </div>
          {error?(
            <div style={{padding:14,color:'var(--red)',fontSize:13,fontFamily:'monospace'}}>Error: {error}</div>
          ):(
            <textarea style={{...ta}} value={output} onChange={e => setOutput(e.target.value)} placeholder="Result will appear here after clicking Convert… (editable)"/>
          )}
        </div>
      </div>

      {xsdOpen && (
        <XsdGeneratePanel
          input={input}
          xmlRoot={xmlRoot} setXmlRoot={setXmlRoot}
          xsdNs={xsdNs} setXsdNs={setXsdNs}
          onGenerate={(xsd) => { setOutput(xsd); setError(null); setXsdOpen(false) }}
          onError={(e) => { setError(e); setXsdOpen(false) }}
          onClose={() => setXsdOpen(false)}
        />
      )}
    </div>
  )
}

// ── Generate XSD panel ─────────────────────────────────────────────────
//
// Dedicated flow for "sample payload → XSD schema" — the CPI Message
// Mapping import case. Kept as its own panel (not an item in the action
// dropdown) because it needs two inputs the other conversions don't (root
// name + targetNamespace), and it's a use-case people specifically look
// for. Auto-detects whether the input is XML or JSON.
function XsdGeneratePanel({ input, xmlRoot, setXmlRoot, xsdNs, setXsdNs, onGenerate, onError, onClose }) {
  const trimmed = String(input || '').trim()
  const looksXml = trimmed.startsWith('<')
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  const kind = looksXml ? 'XML' : looksJson ? 'JSON' : 'unknown'

  function generate() {
    if (!trimmed) return onError('Paste a sample payload in the Input pane first.')
    try {
      const xsd = looksXml
        ? xmlToXSD(trimmed, xsdNs)
        : looksJson
          ? jsonToXSD(trimmed, xmlRoot, xsdNs)
          : (() => { throw new Error('Sample must be XML (starts with <) or JSON (starts with { or [).') })()
      onGenerate(xsd)
    } catch (e) {
      onError(e.message || String(e))
    }
  }

  const backdrop = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
  }
  const card = {
    background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 12,
    padding: 20, width: 'min(520px, 92vw)', maxHeight: '90vh', overflow: 'auto',
    boxShadow: '0 10px 40px rgba(0,0,0,.25)',
  }
  const label = { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em',
    color: 'var(--text3)', fontWeight: 600, marginBottom: 4, display: 'block' }
  const inp = { width: '100%', padding: '7px 10px', borderRadius: 6,
    border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--text)',
    fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>Generate XSD from sample</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text3)', fontSize: 20, cursor: 'pointer', padding: 0, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text2)', marginBottom: 16, lineHeight: 1.5 }}>
          Paste XML or JSON on the left. ShipBridge infers types, cardinality, and structure.
          Review before importing to CPI Message Mapping.
        </div>

        <div style={{ marginBottom: 14 }}>
          <span style={label}>Detected input</span>
          <div style={{ padding: '6px 10px', borderRadius: 6, background: 'var(--bg3)',
            fontSize: 12.5, color: kind === 'unknown' ? 'var(--amber)' : 'var(--green)',
            fontFamily: 'JetBrains Mono, monospace' }}>
            {kind === 'unknown' ? '⚠ No XML or JSON detected in the Input pane' : `✓ ${kind}`}
          </div>
        </div>

        {kind === 'JSON' && (
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Root element name</label>
            <input value={xmlRoot} onChange={(e) => setXmlRoot(e.target.value)}
              placeholder="root" style={inp} />
          </div>
        )}

        <div style={{ marginBottom: 18 }}>
          <label style={label}>Target namespace <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, color: 'var(--text3)' }}>(optional, recommended for CPI)</span></label>
          <input value={xsdNs} onChange={(e) => setXsdNs(e.target.value)}
            placeholder="http://acme.com/schema" style={inp} />
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>
            Leave blank for a no-namespace schema.
          </div>
        </div>

        <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 16, lineHeight: 1.5,
          padding: '8px 10px', borderRadius: 6, background: 'var(--bg3)' }}>
          <div style={{ marginBottom: 3 }}><span style={{ color: 'var(--green)' }}>✓</span> elementFormDefault="qualified" always</div>
          <div style={{ marginBottom: 3 }}><span style={{ color: 'var(--green)' }}>✓</span> Single global root element</div>
          <div><span style={{ color: 'var(--green)' }}>✓</span> Inferred types (integer, decimal, date, boolean, string)</div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--bg3)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer',
              fontFamily: 'inherit' }}>Cancel</button>
          <button onClick={generate} disabled={kind === 'unknown'}
            style={{ padding: '7px 18px', borderRadius: 6, border: 'none',
              background: kind === 'unknown' ? 'var(--bg3)' : 'var(--blue)',
              color: kind === 'unknown' ? 'var(--text3)' : '#fff', fontSize: 13, fontWeight: 600,
              cursor: kind === 'unknown' ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}>
            Generate XSD
          </button>
        </div>
      </div>
    </div>
  )
}
