import { describe, it, expect } from 'vitest'
import { redactPayload, REDACTION_CATEGORIES } from '../lib/redaction.js'

const ALL_ON = Object.fromEntries(REDACTION_CATEGORIES.map(c => [c.key, true]))

describe('redaction', () => {
  it('returns input unchanged when nothing enabled', () => {
    expect(redactPayload('Authorization: Bearer abc123', {})).toBe('Authorization: Bearer abc123')
  })

  it('masks bearer tokens', () => {
    const out = redactPayload('Authorization: Bearer ey.LongTokenValueHere', ALL_ON)
    expect(out).not.toContain('ey.LongTokenValueHere')
    expect(out).toContain('REDACTED')
  })

  it('masks basic auth', () => {
    const out = redactPayload('Authorization: Basic dXNlcjpwYXNz', ALL_ON)
    expect(out).not.toContain('dXNlcjpwYXNz')
  })

  it('masks passwords in JSON', () => {
    const out = redactPayload('{"username":"x","password":"secret123"}', ALL_ON)
    expect(out).not.toContain('secret123')
    expect(out).toContain('"username":"x"')   // non-secret survives
  })

  it('masks client_secret', () => {
    const out = redactPayload('"client_secret":"abcdef-123"', ALL_ON)
    expect(out).not.toContain('abcdef-123')
  })

  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const out = redactPayload('token=' + jwt, { tokens: true })
    // The third JWT segment is itself a long-base64 token, so the long-token
    // pattern may match the signature before the JWT regex catches the whole.
    // Either way, the secret content must be masked.
    expect(out).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
    expect(out).toMatch(/REDACTED/)
  })

  it('masks emails when enabled', () => {
    const out = redactPayload('user@example.com sent it', { emails: true })
    expect(out).not.toContain('user@example.com')
    expect(out).toContain('EMAIL')
  })

  it('preserves emails when disabled', () => {
    const out = redactPayload('user@example.com sent it', { credentials: true })
    expect(out).toContain('user@example.com')
  })

  it('masks tenant hostnames', () => {
    const out = redactPayload('https://customer123.it-cpi.cfapps.eu10.hana.ondemand.com', { hostnames: true })
    expect(out).not.toContain('customer123.it-cpi.cfapps.eu10')
    expect(out).toContain('***TENANT***')
  })

  it('masks BTP client IDs', () => {
    const out = redactPayload('sb-abc123!b9999', { clientIds: true })
    expect(out).not.toContain('sb-abc123!b9999')
    expect(out).toContain('CLIENT_ID')
  })

  it('returns empty input as-is', () => {
    expect(redactPayload('', ALL_ON)).toBe('')
    expect(redactPayload(null, ALL_ON)).toBe(null)
  })
})
