import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestSignature, makeReplayFetch } from './replayFetch.js'

describe('requestSignature', () => {
  it('normalizes: drops token/api_key, sorts query, keeps method+path', () => {
    const a = requestSignature('GET', 'https://api.assrt.net/v1/sub/search?token=SECRET&q=hi&filelist=1', undefined)
    const b = requestSignature('GET', 'https://api.assrt.net/v1/sub/search?filelist=1&q=hi&token=OTHER', undefined)
    expect(a).toBe(b)
    expect(a).toContain('GET')
    expect(a).toContain('/v1/sub/search')
    expect(a).not.toContain('SECRET')
  })

  it('folds POST body into the signature', () => {
    const a = requestSignature('POST', 'https://x/api/download', JSON.stringify({ file_id: 1 }))
    const b = requestSignature('POST', 'https://x/api/download', JSON.stringify({ file_id: 2 }))
    expect(a).not.toBe(b)
  })
})

describe('makeReplayFetch resolution', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'replay-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function record(sig: string, body: unknown, status = 200, headers: Record<string, string> = {}) {
    const name = requestSignature.hash(sig)
    const bodyBase64 = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64')
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ signature: sig, status, headers, bodyBase64 }))
  }

  it('serves an exact-signature match as a real Response', async () => {
    const sig = requestSignature('GET', 'https://api.assrt.net/v1/sub/search?q=hi', undefined)
    record(sig, { status: 0, sub: { subs: [] } })
    const fetchImpl = makeReplayFetch(dir)
    const res = await fetchImpl('https://api.assrt.net/v1/sub/search?token=T&q=hi')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 0, sub: { subs: [] } })
  })

  it('falls back to the unique response for the same method+path when query differs', async () => {
    // Recorded under q=進撃の巨人; model searches q=Attack on Titan -> different exact sig,
    // but there is exactly ONE recorded response for GET /v1/sub/search, so serve it.
    const recordedSig = requestSignature('GET', 'https://api.assrt.net/v1/sub/search?q=%E9%80%B2%E6%92%83', undefined)
    record(recordedSig, { status: 0, sub: { subs: [{ id: 1 }] } })
    const fetchImpl = makeReplayFetch(dir)
    const res = await fetchImpl('https://api.assrt.net/v1/sub/search?token=T&q=Attack%20on%20Titan')
    expect((await res.json()).sub.subs[0].id).toBe(1)
  })

  it('throws a loud miss when a path+method is ambiguous (2 recorded, no exact)', async () => {
    record(requestSignature('GET', 'https://api.assrt.net/v1/sub/detail?id=1', undefined), { status: 0, a: 1 })
    record(requestSignature('GET', 'https://api.assrt.net/v1/sub/detail?id=2', undefined), { status: 0, a: 2 })
    const fetchImpl = makeReplayFetch(dir)
    await expect(fetchImpl('https://api.assrt.net/v1/sub/detail?token=T&id=999'))
      .rejects.toThrow(/no recorded response/i)
  })
})
