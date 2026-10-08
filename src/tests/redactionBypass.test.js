// Negative redaction tests.
//
// Every pre-existing test in redaction.test.js asserts that something IS
// matched. None asserted that a secret does not survive, so a whole family of
// bypasses passed the suite: JSON-shaped auth headers, XML and YAML password
// shapes, non-hana SAP domains, customer domains, Host: headers and bare IPs.
// These tests are written the other way round — they fail if a secret leaks.

import { describe, it, expect } from 'vitest'
import {
  redactPayload, isSensitiveKey, redactTraceStep, redactNameValueRows,
  REDACTION_CATEGORIES,
} from '../lib/redaction.js'

const ALL = Object.fromEntries(REDACTION_CATEGORIES.map(c => [c.key, true]))
const scrub = (t) => redactPayload(t, ALL)

describe('credentials — auth headers must not survive in any shape', () => {
  it('masks a JSON-serialised Authorization header', () => {
    // The old pattern required the scheme immediately after the separator, so
    // the opening quote blocked the match entirely.
    const out = scrub('{"Authorization": "Bearer eyJhbGciOiJSUzI1NiJ9.payloadpart.sigpart"}')
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9')
    expect(out).toContain('REDACTED')
  })

  it.each([
    ['Proxy-Authorization',   'Proxy-Authorization: Basic QWxhZGRpbjpvcGVuc2VzYW1l', 'QWxhZGRpbjpvcGVuc2VzYW1l'],
    ['Token scheme',          'Authorization: Token abc123secret',                   'abc123secret'],
    ['no scheme at all',      'Authorization: justaRawOpaqueValue',                  'justaRawOpaqueValue'],
  ])('masks %s', (_label, input, secret) => {
    expect(scrub(input)).not.toContain(secret)
  })

  it.each([
    ['XML element',        '<Password>hunter2</Password>',                        'hunter2'],
    ['namespaced XML',     '<sap:clientSecret>abc.def:ghi</sap:clientSecret>',    'abc.def:ghi'],
    ['YAML line',          'password: hunter2',                                   'hunter2'],
    ['properties line',    'clientSecret = my-secret-value',                      'my-secret-value'],
    ['query string',       'grant_type=x&client_secret=sh0rt',                    'sh0rt'],
    ['short JSON secret',  '{"client_secret":"s3cr3t"}',                          's3cr3t'],
  ])('masks a secret in %s', (_label, input, secret) => {
    expect(scrub(input)).not.toContain(secret)
  })

  it('catches secrets shorter than the 40-char long-token rule', () => {
    // That catch-all was the only net under the specific patterns, and it
    // missed anything short or containing a dot or colon.
    expect(scrub('{"password":"a.b:c"}')).not.toContain('a.b:c')
  })
})

describe('hostnames — not just two SAP domains', () => {
  it.each([
    ['S/4HANA Cloud (.cloud.sap)', 'https://my123456.s4hana.cloud.sap/odata/x', 'my123456'],
    ['SuccessFactors',             'https://api4.successfactors.com/odata',     'api4'],
    ['Ariba',                      'https://openapi.ariba.com/api',             'openapi'],
    ['customer-owned domain',      'https://erp.acme-corp.co.uk/sap/opu',       'erp.acme-corp.co.uk'],
    ['userinfo in the URL',        'https://user:pw@tenant.example.net/x',      'tenant.example.net'],
  ])('masks the host of %s', (_label, input, secret) => {
    expect(scrub(input)).not.toContain(secret)
  })

  it('masks a Host header', () => {
    const out = scrub('Host: my-tenant.it-cpi017.cfapps.eu10.hana.ondemand.com')
    expect(out).not.toContain('my-tenant')
  })

  it('masks a bare private IP', () => {
    expect(scrub('connecting to 10.42.7.19:8443')).not.toContain('10.42.7.19')
  })

  it('still masks the hana.ondemand tenant it always did', () => {
    expect(scrub('https://abc.it-cpi017.cfapps.eu10.hana.ondemand.com/x')).not.toContain('abc.it-cpi017')
  })
})

describe('must NOT over-mask — the tool still has to be usable', () => {
  it.each([
    ['loopback',            'http://127.0.0.1:3001/api/health',               '127.0.0.1'],
    ['the endpoint path',   'https://x.hana.ondemand.com/http/OrderCreate',   '/http/OrderCreate'],
    ['plain prose',         'Splitter produced 42 messages in 1.3s',          '42 messages'],
    ['an author field',     '{"author":"Praveen"}',                           'Praveen'],
    ['a CPI header name',   'SAP_MessageProcessingLogID: AGh7',               'SAP_MessageProcessingLogID'],
  ])('keeps %s', (_label, input, keep) => {
    expect(scrub(input)).toContain(keep)
  })
})

describe('isSensitiveKey — family matching, not an exact list', () => {
  it.each(['Proxy-Authorization', 'X-Auth-Token', 'refresh_token', 'pwd',
           'passphrase', 'apiSecret', 'x-csrf-token', 'CLIENT_SECRET'])
  ('treats %s as sensitive', (k) => expect(isSensitiveKey(k)).toBe(true))

  it.each(['Content-Type', 'author', 'authority', 'SAP_MessageType', 'retryCount', ''])
  ('leaves %s alone', (k) => expect(isSensitiveKey(k)).toBe(false))
})

describe('redactTraceStep — the path that was not wired up at all', () => {
  const step = {
    ModelStepId: 'Call_1',
    Status: 'FAILED',
    Headers: [
      { name: 'Authorization', value: 'Bearer eyJabc.defghij.klmnop' },
      { name: 'Content-Type', value: 'application/xml' },
    ],
    MessageHeaders: [{ name: 'SAP_ApplicationID', value: 'ORD-99' }],
    ExchangeProperties: [
      { name: 'CredentialAlias', value: 'PRD_ARIBA_USER' },
      { name: 'retryCount', value: '3' },
    ],
    Error: 'HttpException: POST https://erp.acme-corp.co.uk/sap/opu failed',
  }

  const out = redactTraceStep(step, ALL)
  const blob = JSON.stringify(out)

  it('masks a token in a header value', () => {
    expect(blob).not.toContain('eyJabc.defghij.klmnop')
  })

  it('masks a hostname inside the error text', () => {
    // exportReport stamped "Redacted for sharing" and then wrote this verbatim.
    expect(blob).not.toContain('erp.acme-corp.co.uk')
  })

  it('keeps the values a consultant actually needs', () => {
    expect(blob).toContain('application/xml')
    expect(blob).toContain('ORD-99')
    expect(blob).toContain('Call_1')
  })

  it('does not mutate the input', () => {
    expect(step.Headers[0].value).toBe('Bearer eyJabc.defghij.klmnop')
  })

  it('passes through non-objects safely', () => {
    expect(redactTraceStep(null, ALL)).toBeNull()
    expect(redactNameValueRows(undefined, ALL)).toBeUndefined()
  })
})

describe('redaction is opt-in per category', () => {
  it('leaves everything alone when no category is enabled', () => {
    const raw = 'Authorization: Bearer secret-value-here'
    expect(redactPayload(raw, {})).toBe(raw)
  })

  it('only applies the categories that are on', () => {
    const raw = 'Authorization: Bearer tok\nhttps://x.hana.ondemand.com/y'
    const credsOnly = redactPayload(raw, { credentials: true })
    expect(credsOnly).not.toContain('Bearer tok')
    expect(credsOnly).toContain('x.hana.ondemand.com')   // hostnames category is off
  })
})
