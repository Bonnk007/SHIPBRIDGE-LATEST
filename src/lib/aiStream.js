// Shared helpers for streamed AI output.
//
// streamAI  — reads an Anthropic SSE stream from one of our /api endpoints and
//             calls onChunk with the accumulated text as it arrives.
// renderMd  — turns the small subset of markdown the AI actually emits
//             (**bold**, `code`, bullets, headings) into React-safe segments.
//             Deliberately minimal: we control the prompt, so we know what
//             comes back. No dependency, no dangerouslySetInnerHTML.

// POST to `url` with `body`, stream the response, call onChunk(fullTextSoFar).
// Returns the final text. Throws on network/API failure with a usable message.
export async function streamAI(url, body, onChunk, signal) {
  let resp
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (e.name === 'AbortError') throw e
    throw new Error("Couldn't reach the ShipBridge server. Is it running?")
  }

  // Errors come back as plain JSON, not a stream.
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw new Error(data.error || `AI request failed (HTTP ${resp.status})`)
  }

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = '', full = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()                     // keep the trailing partial line
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') continue
      try {
        const ev = JSON.parse(payload)
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          full += ev.delta.text
          onChunk(full)
        }
        // The API can also stream an error mid-stream.
        if (ev.type === 'error') throw new Error(ev.error?.message || 'AI stream error')
      } catch (e) {
        if (e instanceof SyntaxError) continue   // partial JSON — ignore
        throw e
      }
    }
  }
  return full
}

// Parse the markdown subset our prompts produce into a flat block list.
// Each block: { type: 'h' | 'li' | 'p', parts: [...] }
// Each part:  { text, bold?, code? }
export function renderMd(md) {
  if (!md) return []
  const blocks = []
  for (const rawLine of String(md).split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue

    // Heading: markdown #, or a line that is entirely bolded (**What it did**)
    const hMatch = line.match(/^#{1,4}\s+(.*)$/)
    const boldOnly = line.match(/^\*\*(.+?)\*\*:?\s*$/)
    if (hMatch) { blocks.push({ type: 'h', parts: inline(hMatch[1]) }); continue }
    if (boldOnly) { blocks.push({ type: 'h', parts: inline(boldOnly[1]) }); continue }

    // Bullet
    const liMatch = line.match(/^\s*[-*•]\s+(.*)$/)
    if (liMatch) { blocks.push({ type: 'li', parts: inline(liMatch[1]) }); continue }

    // Numbered item — treat as a bullet, the number is noise in a short answer
    const numMatch = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (numMatch) { blocks.push({ type: 'li', parts: inline(numMatch[1]) }); continue }

    blocks.push({ type: 'p', parts: inline(line) })
  }
  return blocks
}

// Split a line into bold / code / plain runs.
function inline(text) {
  const parts = []
  // Alternates on **bold** and `code`, keeping the delimiters as capture groups.
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0, m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) })
    const tok = m[0]
    if (tok.startsWith('**')) parts.push({ text: tok.slice(2, -2), bold: true })
    else parts.push({ text: tok.slice(1, -1), code: true })
    last = m.index + tok.length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts.length ? parts : [{ text }]
}
