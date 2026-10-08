// The .docx template upload path. `btoa(String.fromCharCode(...bytes))` threw
// RangeError: Maximum call stack size exceeded on any realistic template, which
// made "Bring your own template" unusable with a real client file.

import { describe, it, expect } from 'vitest'
import { fileToBase64 } from '../lib/imageUtils.js'

const makeFile = (bytes, name = 'template.docx') =>
  new File([new Uint8Array(bytes)], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })

describe('fileToBase64', () => {
  it('encodes a small file correctly', async () => {
    const bytes = [...'PK\u0003\u0004hello'].map(c => c.charCodeAt(0))
    const b64 = await fileToBase64(makeFile(bytes))
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(Uint8Array.from(bytes)))
  })

  it('handles a 2MB file — the size that used to blow the call stack', async () => {
    const size = 2 * 1024 * 1024
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) bytes[i] = i % 256

    // Proof the old approach really does throw at this size.
    expect(() => btoa(String.fromCharCode(...bytes))).toThrow()

    const b64 = await fileToBase64(makeFile(bytes))
    const decoded = Buffer.from(b64, 'base64')
    expect(decoded.length).toBe(size)
    expect(decoded[0]).toBe(0)
    expect(decoded[size - 1]).toBe((size - 1) % 256)
  })

  it('strips the data: URL prefix', async () => {
    const b64 = await fileToBase64(makeFile([1, 2, 3]))
    expect(b64).not.toContain(',')
    expect(b64).not.toMatch(/^data:/)
  })
})
