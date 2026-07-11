import { describe, it, expect } from 'vitest'
import { makeCliProviderPort, ProviderQuotaExhaustedError } from './providerPort.js'

const stub = ['node', 'fixtures/fetch-stub.mjs']

describe('makeCliProviderPort', () => {
  it('search: spawns CLI, parses stdout candidates, relays stderr api_call events', async () => {
    const events: unknown[] = []
    const port = makeCliProviderPort({ command: stub, onEvent: e => events.push(e) })
    const r = await port.search({ queries: ['q'], deep: false })
    expect(r.candidates.length).toBe(1)
    expect(r.candidates[0].provider).toBe('assrt')
    expect(r.providerErrors).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ event: 'api_call', provider: 'assrt' }))
  })
  it('resolveDownload: passes provider/id/file-index argv, parses url', async () => {
    const port = makeCliProviderPort({ command: stub })
    const r = await port.resolveDownload({ provider: 'assrt', providerId: '1', fileIndex: 2 })
    expect(r.url).toBe('https://dl.example/x.zip')
  })
  it('rejects with stderr error JSON when CLI exits nonzero', async () => {
    const port = makeCliProviderPort({ command: ['sh', '-c', 'echo \'{"error":"boom"}\' >&2; exit 1'] })
    await expect(port.search({ queries: [], deep: false })).rejects.toThrow(/boom/)
  })
  it('non-JSON stderr lines are ignored, JSON events still parsed', async () => {
    const events: unknown[] = []
    const port = makeCliProviderPort({
      command: ['sh', '-c', 'echo "npx noise line" >&2; echo \'{"event":"api_call","provider":"assrt","endpoint":"e","status":0,"durationMs":1}\' >&2; echo "[]"'],
      onEvent: e => events.push(e),
    })
    await port.search({ queries: [], deep: false })
    expect(events.length).toBe(1)
  })
  it('collects provider_error events into providerErrors AND relays them to onEvent', async () => {
    const events: unknown[] = []
    const port = makeCliProviderPort({
      command: ['sh', '-c', 'echo \'{"event":"provider_error","provider":"opensubtitles","message":"503 upstream"}\' >&2; echo "[]"'],
      onEvent: e => events.push(e),
    })
    const r = await port.search({ queries: ['q'], deep: false })
    expect(r.candidates).toEqual([])
    expect(r.providerErrors).toEqual([{ provider: 'opensubtitles', message: '503 upstream' }])
    expect(events).toContainEqual(expect.objectContaining({ event: 'provider_error', provider: 'opensubtitles' }))
  })
  it('relays provider_notice events to onEvent WITHOUT adding them to providerErrors (negative-cache guard must stay error-only)', async () => {
    const events: unknown[] = []
    const port = makeCliProviderPort({
      command: ['sh', '-c',
        'echo \'{"event":"provider_notice","provider":"opensubtitles","message":"quota exhausted after this call","code":"quota_exhausted","resetAt":"2026-07-13T00:00:00.000Z"}\' >&2; echo "[]"'],
      onEvent: e => events.push(e),
    })
    const r = await port.search({ queries: ['q'], deep: false })
    expect(r.candidates).toEqual([])
    // a provider_notice is informational, not a failure — it must NOT poison providerErrors
    // (callers gate "no candidates + no providerErrors" as an honest empty result / negative-cache write)
    expect(r.providerErrors).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ event: 'provider_notice', provider: 'opensubtitles' }))
  })
  it('a lone provider_notice event before nonzero exit does NOT trigger the typed ProviderQuotaExhaustedError path (that is reserved for provider_error)', async () => {
    const port = makeCliProviderPort({
      command: ['sh', '-c',
        'echo \'{"event":"provider_notice","provider":"opensubtitles","message":"quota exhausted after this call","code":"quota_exhausted","resetAt":"2026-07-13T00:00:00.000Z"}\' >&2; echo \'{"error":"boom"}\' >&2; exit 1'],
    })
    await expect(port.resolveDownload({ provider: 'opensubtitles', providerId: '1', fileIndex: null }))
      .rejects.not.toMatchObject({ code: 'quota_exhausted' })
  })
  it('resolveDownload: a quota_exhausted provider_error before nonzero exit rejects with a typed ProviderQuotaExhaustedError carrying resetAt', async () => {
    const resetAt = '2026-07-13T00:00:00.000Z'
    const port = makeCliProviderPort({
      command: ['sh', '-c',
        `echo '{"event":"provider_error","provider":"opensubtitles","message":"quota exhausted","code":"quota_exhausted","resetAt":"${resetAt}"}' >&2; echo '{"error":"OsQuotaExhaustedError: opensubtitles download quota exhausted"}' >&2; exit 1`],
    })
    await expect(port.resolveDownload({ provider: 'opensubtitles', providerId: '1', fileIndex: null }))
      .rejects.toMatchObject({ code: 'quota_exhausted', resetAt })
    // and it really is the typed class, not just a duck-typed shape
    try {
      await port.resolveDownload({ provider: 'opensubtitles', providerId: '1', fileIndex: null })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderQuotaExhaustedError)
    }
  })
  it('resolveDownload: quota_exhausted event with no resetAt still rejects typed, with resetAt null', async () => {
    const port = makeCliProviderPort({
      command: ['sh', '-c',
        'echo \'{"event":"provider_error","provider":"opensubtitles","message":"quota exhausted","code":"quota_exhausted","resetAt":null}\' >&2; exit 1'],
    })
    await expect(port.resolveDownload({ provider: 'opensubtitles', providerId: '1', fileIndex: null }))
      .rejects.toMatchObject({ code: 'quota_exhausted', resetAt: null })
  })
  it('a plain nonzero exit with no quota_exhausted event stays a generic Error (no code property)', async () => {
    const port = makeCliProviderPort({ command: ['sh', '-c', 'echo \'{"error":"boom"}\' >&2; exit 1'] })
    await expect(port.resolveDownload({ provider: 'assrt', providerId: '1', fileIndex: null }))
      .rejects.not.toMatchObject({ code: 'quota_exhausted' })
  })
  it('MINOR-1: a child that emits quota_exhausted then hangs times out with the typed ProviderQuotaExhaustedError, not a generic timeout Error', async () => {
    // 根因：超时路径原样 reject 一个泛型 Error('subtitle-fetch timeout...')，哪怕 quota_exhausted
    // provider_error 事件早已被观察到——调用方（pipeline.ts）就没法把这次超时按 resetAt 精确退避。
    const resetAt = '2026-07-13T00:00:00.000Z'
    const port = makeCliProviderPort({
      command: ['sh', '-c',
        `echo '{"event":"provider_error","provider":"opensubtitles","message":"quota exhausted","code":"quota_exhausted","resetAt":"${resetAt}"}' >&2; sleep 30`],
      timeoutMs: 50,
    })
    await expect(port.search({ queries: ['q'], deep: false }))
      .rejects.toMatchObject({ code: 'quota_exhausted', resetAt })
  })
  it('MINOR-1: a plain hang with no quota_exhausted event still times out with a generic Error', async () => {
    const port = makeCliProviderPort({ command: ['sh', '-c', 'sleep 30'], timeoutMs: 50 })
    await expect(port.search({ queries: ['q'], deep: false }))
      .rejects.not.toMatchObject({ code: 'quota_exhausted' })
  })
  it('multi-byte UTF-8 split across stdout chunks survives intact (no replacement chars)', async () => {
    const port = makeCliProviderPort({ command: ['node', 'fixtures/fetch-stub-split.mjs'] })
    const r = await port.search({ queries: ['q'], deep: false })
    expect(r.candidates.length).toBe(1)
    expect(r.candidates[0].nativeName).toBe('黑客帝国')
    expect(r.candidates[0].nativeName).not.toContain('�')
  })
})
