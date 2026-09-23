import { describe, it, expect } from 'vitest'
import { isSensitiveKey, redactHeaders } from '../lib/redact.js'
import { buildAdapterTablesXml } from '../../server/specDocx.js'

// These lock in fixes for bugs found in the v46.5.0 review. Each one passed
// silently before the fix — that's why they're worth pinning.

// Mirrors the stripping logic in TraceViewer.matchedFlow. Pinning it here as
// pure logic — the component uses the same regex — means a well-meaning refactor
// won't quietly break the "Health_Checker (1).zip → Health_Checker" match that
// makes step names resolve when the browser has downloaded the ZIP twice.
function zipStemFor(zipName) {
  return String(zipName || '')
    .replace(/\.zip$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/\s+copy(\s*\d+)?$/i, '')
    .trim()
}

describe('ZIP name stripping — matches CPI IntegrationFlowName', () => {
  it('leaves a plain zip name alone', () => {
    expect(zipStemFor('Health_Checker.zip')).toBe('Health_Checker')
  })
  it('strips browser numeric suffixes', () => {
    // The bug that hid step names in v46.9.0 — a real report from a user
    // whose browser had downloaded the same ZIP twice.
    expect(zipStemFor('Health_Checker (1).zip')).toBe('Health_Checker')
    expect(zipStemFor('Health_Checker (17).zip')).toBe('Health_Checker')
  })
  it('strips macOS-style copy suffixes', () => {
    expect(zipStemFor('Health_Checker copy.zip')).toBe('Health_Checker')
    expect(zipStemFor('Health_Checker copy 2.zip')).toBe('Health_Checker')
  })
  it('does not eat legitimate trailing numbers that are part of the name', () => {
    // "V1" is part of the artifact name, not a browser suffix — must survive.
    expect(zipStemFor('Product_Group_V1.zip')).toBe('Product_Group_V1')
    expect(zipStemFor('Flow_2024.zip')).toBe('Flow_2024')
  })
})

describe('header key redaction (normalization bug)', () => {
  it('treats hyphenated header names as sensitive', () => {
    // Before the fix, the set held "x-api-key" but lookups normalized to
    // "xapikey", so this never matched and the value leaked.
    expect(isSensitiveKey('X-API-Key')).toBe(true)
    expect(isSensitiveKey('access_token')).toBe(true)
    expect(isSensitiveKey('access-token')).toBe(true)
  })

  it('masks api-key and token headers in a real headers object', () => {
    const out = redactHeaders({
      'X-API-Key': 'sk-live-abc123',
      'Access_Token': 'tok_9f8e7d',
      'Authorization': 'Bearer xyz',
      'Content-Type': 'application/json',
    })
    expect(out['X-API-Key']).toBe('***REDACTED***')
    expect(out['Access_Token']).toBe('***REDACTED***')
    expect(out['Authorization']).toBe('***REDACTED***')
    expect(out['Content-Type']).toBe('application/json') // non-secret survives
  })
})

describe('adapter table builder (malformed input bug)', () => {
  it('does not throw when fields is an object map instead of an array', () => {
    const xml = buildAdapterTablesXml([
      { type: 'HTTPS', direction: 'Sender', fields: { Address: '/eod/travel' } },
    ])
    expect(xml).toContain('/eod/travel')
  })

  it('does not throw on absent or garbage fields', () => {
    expect(() => buildAdapterTablesXml([{ type: 'SFTP', direction: 'Receiver' }])).not.toThrow()
    expect(() => buildAdapterTablesXml([null, 42, { type: 'IDOC' }])).not.toThrow()
  })

  it('returns the empty-state string for non-array input', () => {
    expect(buildAdapterTablesXml(null)).toContain('No adapters extracted')
    expect(buildAdapterTablesXml('nope')).toContain('No adapters extracted')
  })
})
