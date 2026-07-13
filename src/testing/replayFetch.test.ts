import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestSignature, makeReplayFetch, makeRecordingFetch } from './replayFetch.js'

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

  it('re-encodes the rebuilt query so a value containing &/= cannot collide with two params', () => {
    // Real trigger: free-text titles like "Law & Order" — a=1%26b%3D2 is ONE param a="1&b=2",
    // which must not alias the TWO-param query a=1&b=2 after decode+rebuild.
    const single = requestSignature('GET', 'https://x/api/search?a=1%26b%3D2', undefined)
    const double = requestSignature('GET', 'https://x/api/search?a=1&b=2', undefined)
    expect(single).not.toBe(double)
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
    await expect(fetchImpl('https://api.assrt.net/v1/sub/detail?token=T&id=999'))
      .rejects.toThrow('(2 recorded for this path')
  })

  it('rejects the Request-object call form when the Request carries a body', async () => {
    // Reading a Request body is async+consuming — the signature would silently drop it and
    // degrade to path-bucket matching, so this call form must fail loud instead.
    const fetchImpl = makeReplayFetch(dir)
    await expect(fetchImpl(new Request('https://x/api/download', { method: 'POST', body: '{"file_id":1}' })))
      .rejects.toThrow(/Request-object call form with a body is unsupported/)
  })
})

describe('makeRecordingFetch round-trip', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'record-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('records a real fetch to disk and replays it identically', async () => {
    // Fake "real" fetch: returns a JSON body; recorder must persist it and hand back a
    // still-readable Response (body not consumed by the tee).
    const realFetch = (async () => new Response(JSON.stringify({ status: 0, sub: { subs: [{ id: 42 }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const recording = makeRecordingFetch(dir, realFetch)

    const live = await recording('https://api.assrt.net/v1/sub/search?token=T&q=hi')
    expect((await live.json()).sub.subs[0].id).toBe(42)   // caller still gets a usable body

    const replay = makeReplayFetch(dir)
    const played = await replay('https://api.assrt.net/v1/sub/search?token=DIFFERENT&q=hi')
    expect((await played.json()).sub.subs[0].id).toBe(42)  // persisted + token-insensitive
  })

  it('rejects the Request-object call form when the Request carries a body', async () => {
    // Same guard as replay: recording would key the fixture WITHOUT the body, silently
    // overwriting fixtures for different payloads to the same path.
    const realFetch = (async () => new Response('{}')) as typeof fetch
    const recording = makeRecordingFetch(dir, realFetch)
    await expect(recording(new Request('https://x/api/download', { method: 'POST', body: '{"file_id":1}' })))
      .rejects.toThrow(/Request-object call form with a body is unsupported/)
  })

  it('keys fixtures by URLSearchParams body — two payloads, two fixture files', async () => {
    // Real call site: yunsuo.ts submitChallenge POSTs `new URLSearchParams(...)`. Dropping it
    // from the signature would alias different captcha payloads to ONE fixture (silent overwrite).
    const realFetch = (async () => new Response('{"ok":true}')) as typeof fetch
    const recording = makeRecordingFetch(dir, realFetch)
    await recording('https://x/api/captcha', { method: 'POST', body: new URLSearchParams({ code: '1111' }) })
    await recording('https://x/api/captcha', { method: 'POST', body: new URLSearchParams({ code: '2222' }) })
    expect(readdirSync(dir).filter(f => f.endsWith('.json'))).toHaveLength(2)
  })

  it('throws on body types with no deterministic text form instead of dropping them', async () => {
    const realFetch = (async () => new Response('{}')) as typeof fetch
    const recording = makeRecordingFetch(dir, realFetch)
    await expect(recording('https://x/api/upload', { method: 'POST', body: new Blob(['x']) }))
      .rejects.toThrow(/unsupported body type/)
  })

  it('round-trips a binary body losslessly through base64', async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))  // every byte value
    const realFetch = (async () => new Response(bytes,
      { status: 200, headers: { 'content-type': 'application/octet-stream' } })) as typeof fetch
    const recording = makeRecordingFetch(dir, realFetch)
    await recording('https://x/api/download?file=1')

    const replay = makeReplayFetch(dir)
    const res = await replay('https://x/api/download?file=1')
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('strips stale transport headers before persisting, keeping content-type', async () => {
    // Node fetch auto-decompresses but leaves content-encoding: gzip + the COMPRESSED
    // content-length on the Response; persisting them next to the decoded body would
    // mislead any client that trusts those headers on replay.
    const realFetch = (async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '9999' },
    })) as typeof fetch
    const recording = makeRecordingFetch(dir, realFetch)
    await recording('https://x/api/search?q=hi')

    const [file] = readdirSync(dir).filter(f => f.endsWith('.json'))
    const persisted = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { headers: Record<string, string> }
    const keys = Object.keys(persisted.headers).map(k => k.toLowerCase())
    expect(keys).toContain('content-type')
    expect(keys).not.toContain('content-encoding')
    expect(keys).not.toContain('content-length')
    expect(keys).not.toContain('transfer-encoding')
  })
})
