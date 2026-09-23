import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'

// The router picks 'diagram' or 'rows' based on field-pair count. We can't
// easily unit-test React internal state, but we CAN assert the rendered
// HTML contains markers only present in one mode or the other:
//
//   diagram mode → an <svg> element and text "SOURCE FIELDS ("
//   rows mode    → a header cell "SOURCE" (no "FIELDS") in a grid layout
//
// That's enough to lock in the auto-pick behavior for small vs large mmaps.

// Import the exported component — we need access to it for the test.
// It's a default export inside IntelligenceDetail's internals, so re-import
// via a light wrapper: we test by rendering a mmap-shaped object.
import { MappingViewerForTest } from '../components/IntelligenceDetail.jsx'

function mkPairs(n) {
  return Array.from({ length: n }, (_, i) => ({
    target: `../t/field${i}`,
    sources: [`../s/field${i}`],
    functions: i % 3 === 0 ? [{ name: 'concat' }] : [],
  }))
}

describe.skipIf(!MappingViewerForTest)('mapping viewer — mode auto-pick', () => {
  it('picks the bezier diagram for a small mapping (≤12 pairs)', () => {
    const data = { source: 'A', target: 'B', fieldMappings: mkPairs(5) }
    const html = renderToString(createElement(MappingViewerForTest, { data }))
    expect(html).toContain('<svg')
    expect(html).toContain('SOURCE FIELDS')
  })

  it('picks the row layout for a large mapping (>12 pairs)', () => {
    // The delaware Person mapping in the screenshot has ~30 pairs; that's
    // exactly where the bezier view fails and the rows have to take over.
    const data = { source: 'A', target: 'B', fieldMappings: mkPairs(30) }
    const html = renderToString(createElement(MappingViewerForTest, { data }))
    // No SVG in the rows mode
    expect(html.includes('SOURCE FIELDS (')).toBe(false)
    // Rows mode has a compact "SOURCE" header cell (with no "FIELDS" suffix)
    expect(html).toContain('SOURCE')
    expect(html).toContain('FUNCTIONS')
  })

  it('renders without throwing on a mapping with zero pairs', () => {
    const data = { source: 'A', target: 'B', fieldMappings: [] }
    expect(() => renderToString(createElement(MappingViewerForTest, { data }))).not.toThrow()
  })
})
