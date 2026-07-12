import { describe, it, expect, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { makeCliProviderPort, ProviderQuotaExhaustedError, resolveSubtitleFetchCommand } from './providerPort.js'

const stub = ['node', 'fixtures/fetch-stub.mjs']

describe('resolveSubtitleFetchCommand', () => {
  it('dev mode (.ts module, e.g. tsx running src/core/providerPort.ts): spawns via npx tsx against the sibling .ts entry', () => {
    const url = pathToFileURL('/repo/src/core/providerPort.ts').href
    expect(resolveSubtitleFetchCommand(url)).toEqual(['npx', 'tsx', '/repo/src/cli/subtitle-fetch.ts'])
  })
  it('compiled mode (.js module, e.g. node running dist/core/providerPort.js): spawns plain node against the sibling .js entry', () => {
    const url = pathToFileURL('/repo/dist/core/providerPort.js').href
    expect(resolveSubtitleFetchCommand(url)).toEqual(['node', '/repo/dist/cli/subtitle-fetch.js'])
  })
  it('resolves the sibling relative to the module dir, not cwd — works regardless of where the process was launched from', () => {
    const devUrl = pathToFileURL('/somewhere/else/src/core/providerPort.ts').href
    expect(resolveSubtitleFetchCommand(devUrl)).toEqual(['npx', 'tsx', '/somewhere/else/src/cli/subtitle-fetch.ts'])
    const distUrl = pathToFileURL('/somewhere/else/dist/core/providerPort.js').href
    expect(resolveSubtitleFetchCommand(distUrl)).toEqual(['node', '/somewhere/else/dist/cli/subtitle-fetch.js'])
  })
})

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
    //
    // 确定性说明：本用例要证明的是"事件先到、超时后到"这个顺序下的行为，不能靠指望真实 50ms
    // 挂钟时间比子进程 spawn+echo+stderr 解析更慢来赌赢——满载并行跑全量测试时这个赌注偶尔会输
    // （spawn/调度抖动可能反超 50ms），导致 quotaExhausted 还没落地超时就先触发，退化成泛型 Error。
    // 改用显式同步点：用 onEvent 回调等到事件真正被 run() 内部观测到之后，再用 fake timer 精确
    // 推进 timeoutMs——这样"事件先于超时"从概率赌注变成结构性保证，而不是放宽或跳过原本要证明的行为。
    const resetAt = '2026-07-13T00:00:00.000Z'
    let onQuotaEvent!: () => void
    const quotaEventObserved = new Promise<void>(resolve => { onQuotaEvent = resolve })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const port = makeCliProviderPort({
        command: ['sh', '-c',
          `echo '{"event":"provider_error","provider":"opensubtitles","message":"quota exhausted","code":"quota_exhausted","resetAt":"${resetAt}"}' >&2; sleep 30`],
        timeoutMs: 50,
        onEvent: e => { if ((e as { event?: string }).event === 'provider_error') onQuotaEvent() },
      })
      const result = port.search({ queries: ['q'], deep: false })
      // 断言（即 rejects 内部挂的 catch handler）必须在推进定时器、真正触发 reject 之前就挂上去——
      // 否则 reject() 和 expect().rejects 之间存在几个 microtask 的窗口，Node 会先判定 result
      // "unhandled"（PromiseRejectionHandledWarning），即使随后确实被处理也已经污染了测试输出。
      const assertion = expect(result).rejects.toMatchObject({ code: 'quota_exhausted', resetAt })
      // run() 里 quotaExhausted 在调用 onEvent 之前就已经赋值（见 providerPort.ts），所以此刻
      // resolve 时内部状态必然已经就绪——推进定时器前不存在"事件还没被记录"的窗口。
      await quotaEventObserved
      await vi.advanceTimersByTimeAsync(50)
      await assertion
    } finally {
      vi.useRealTimers()
    }
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
  it('resolveDownload: parses an optional headers field through from the CLI subprocess stdout JSON (zimuku archive download needs browser headers)', async () => {
    const port = makeCliProviderPort({
      command: ['sh', '-c', 'echo \'{"url":"https://dl.example/x.zip","filename":"x.zip","headers":{"User-Agent":"test-ua"}}\''],
    })
    const r = await port.resolveDownload({ provider: 'zimuku', providerId: '1', fileIndex: null })
    expect(r.headers).toEqual({ 'User-Agent': 'test-ua' })
  })
  it('resolveDownload: headers stays undefined when the CLI does not emit it (assrt/opensubtitles unaffected)', async () => {
    const port = makeCliProviderPort({ command: stub })
    const r = await port.resolveDownload({ provider: 'assrt', providerId: '1', fileIndex: 2 })
    expect(r.headers).toBeUndefined()
  })
})
