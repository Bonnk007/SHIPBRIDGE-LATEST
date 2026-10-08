import { describe, it, expect } from 'vitest'
import { splitFlowBlock, expandFlowSections } from '../../server/specMultiFlow.js'

describe('per-flow block expansion', () => {
  const tpl =
    '<w:body>' +
    '<w:p><w:r><w:t>{{INTERFACE_NAME}}</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>{{FLOW_SECTION_START}}</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>{{FLOW_HEADING}}</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>{{FLOW_NAME}}</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>{{IMG_GROOVY}}</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>{{FLOW_SECTION_END}}</w:t></w:r></w:p>' +
    '</w:body>'

  it('splits the template into shared prologue and repeatable block', () => {
    const parts = splitFlowBlock(tpl)
    expect(parts).not.toBeNull()
    expect(parts.head).toContain('{{INTERFACE_NAME}}')
    expect(parts.block).toContain('{{FLOW_NAME}}')
    expect(parts.head).not.toContain('{{FLOW_NAME}}')
  })

  it('returns null for a template with no per-flow block', () => {
    expect(splitFlowBlock('<w:body><w:p><w:r><w:t>{{X}}</w:t></w:r></w:p></w:body>')).toBeNull()
  })

  it('clones the block once per flow and fills each with its own values', () => {
    const out = expandFlowSections(tpl, [
      { name: 'A', heading: 'Flow 1 — A', values: { FLOW_NAME: 'A' } },
      { name: 'B', heading: 'Flow 2 — B', values: { FLOW_NAME: 'B' } },
    ])
    expect(out).toContain('Flow 1 — A')
    expect(out).toContain('Flow 2 — B')
    expect(out).toContain('>A<')
    expect(out).toContain('>B<')
    // Shared prologue must appear exactly once
    expect(out.match(/\{\{INTERFACE_NAME\}\}/g)).toHaveLength(1)
  })

  it('suffixes image slots after the first flow so they do not collide', () => {
    const out = expandFlowSections(tpl, [
      { name: 'A', values: {} }, { name: 'B', values: {} }, { name: 'C', values: {} },
    ])
    expect(out).toContain('{{IMG_GROOVY}}')       // flow 1 keeps the plain slot
    expect(out).toContain('{{IMG_GROOVY__2}}')
    expect(out).toContain('{{IMG_GROOVY__3}}')
  })

  it('strips the markers so they never print in the document', () => {
    const out = expandFlowSections(tpl, [{ name: 'A', values: {} }])
    expect(out).not.toContain('FLOW_SECTION_START')
    expect(out).not.toContain('FLOW_SECTION_END')
  })

  it('escapes values so an ampersand in a flow name cannot corrupt the XML', () => {
    const out = expandFlowSections(tpl, [{ name: 'A & B', heading: 'H', values: { FLOW_NAME: 'A & B' } }])
    expect(out).toContain('A &amp; B')
    expect(out).not.toMatch(/A & B/)
  })
})
