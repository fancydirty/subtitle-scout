// web/src/media/mediaHooks.test.tsx：两个 hook 的**运行时探针**测试。
//
// ── 为什么是探针而不是源码级断言（Task ⑤ 的教训）─────────────────────────────
// Task ⑤ 写过"源码级接线断言"（读源码字符串核对 import/调用），**一行行尾注释就让 4 条
// 全部假绿**，最后整个文件被删。改用的手法是：给真实对象包计数器，断言它**真的被调用了**。
// 这里落地成 stub 掉 global fetch 并数请求——URL 与次数是真实发生的行为，注释改不动它。
//
// 这里要钉的三条契约，每条都是"改坏了不报错"的形态：
//  ① 打的是新端点 /api/v2/mediaLibrary（不是旧的 /api/v2/library）；
//  ② workId=null 时**一个请求都不发**（Shell 每次渲染都调这个 hook，null 也照打的话
//     另外三个 tab 各白白 404 一次）；
//  ③ **不轮询**（挂个 15s 定时器不会有任何测试变红，但它是真实的持续负载）。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, renderHook, waitFor, cleanup, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useMediaLibrary, useMediaLibraryDetail } from '../api/hooks.js'
import { EventsProvider } from '../events/EventsProvider.js'
import { __resetEventsBusForTests } from '../events/eventsBus.js'
import type { ScoutEvent } from '../events/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

/** 真实计数探针：每次 fetch 都记下 URL。 */
function probe(body: unknown = [], ok = true) {
  const urls: string[] = []
  const f = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response
  })
  vi.stubGlobal('fetch', f)
  return { urls, f }
}

describe('useMediaLibrary', () => {
  it('打 /api/v2/mediaLibrary，**不打**旧的 /api/v2/library', async () => {
    const { urls } = probe([])
    const { result } = renderHook(() => useMediaLibrary())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(urls.some((u) => u.includes('/api/v2/mediaLibrary'))).toBe(true)
    expect(urls.some((u) => /\/api\/v2\/library(\?|$)/.test(u))).toBe(false)
  })

  it('成功 → data 是后端数组原文，error 为 null', async () => {
    // ⚠️ 这一行必须是**契约完整**的行（六个必填键齐备）。原先这里写的是
    // `[{ workId: 'tmdb:1' }]`——一个只有一个键的占位。API 边界上了
    // MEDIA_LIBRARY_LIST_SHAPE 之后那个占位会被判违约（它确实少五个键），
    // 用例随之变红。
    //
    // 🔴 正确的处置是**补全 fixture，不是放宽契约**：本用例的意图是"原文透传、
    // 不做任何变形"，那个意图完全不要求行是残缺的。放宽契约去迁就一个偷懒的
    // 占位，等于让线上少五个键的响应照样通过——那才是假修复。
    // 补全之后这条用例的意图不变，还顺带多守了一条：透传的是**完整的**行。
    const rows = [{
      workId: 'tmdb:1', title: 'Breaking Bad', chineseTitle: null, year: 2008,
      posterPath: null, mediaType: 'tv',
      expectedEpisodeCount: 62, onDiskEpisodeCount: 62,
      missingEpisodeCount: 0, subtitledEpisodeCount: 62, embeddedEpisodeCount: 0, uncoveredEpisodeCount: 0,
    }]
    probe(rows)
    const { result } = renderHook(() => useMediaLibrary())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual(rows)
    expect(result.current.error).toBeNull()
  })

  it('失败 → error 有值、data 保持 null（不吞异常、不给假空数组）', async () => {
    probe({ error: 'db locked' }, false)
    const { result } = renderHook(() => useMediaLibrary())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toContain('db locked')
    // 🔴 失败时给 [] 会让页面显示"库里没有东西"——把"我没能问到"说成事实（§4.4 谎报）。
    expect(result.current.data).toBeNull()
  })

  it('reload() 真的重发（探针计数 +1）', async () => {
    const { urls } = probe([])
    const { result } = renderHook(() => useMediaLibrary())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = urls.length
    act(() => result.current.reload())
    await waitFor(() => expect(urls.length).toBe(before + 1))
  })

  it('**不轮询**：60 秒过去仍然只有首载那一次请求', async () => {
    vi.useFakeTimers()
    const { urls } = probe([])
    // 首载的 promise 在 act 里 flush 掉——否则它的 setState 落在 act 之外，React 会警告，
    // 而那条警告会把本用例真正要看的东西（轮询计数）淹掉。
    const { result } = renderHook(() => useMediaLibrary())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.loading).toBe(false)
    const after = urls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(urls.length, '出现了轮询——全库聚合每 15s 打一次是纯负载').toBe(after)
  })
})

describe('useMediaLibraryDetail', () => {
  it('workId=null → **一个请求都不发**，loading 立刻为 false', async () => {
    const { urls } = probe()
    const { result } = renderHook(() => useMediaLibraryDetail(null))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(urls, 'null 也照打 → 另外三个 tab 各白白 404 一次').toHaveLength(0)
    expect(result.current.data).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('workId 非 null → 打 /api/v2/mediaLibrary/:workId，冒号已编码', async () => {
    const { urls } = probe({ work: {} })
    const { result } = renderHook(() => useMediaLibraryDetail('tmdb:1396'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/api/v2/mediaLibrary/tmdb%3A1396')
  })

  it('workId 变化 → 重取（切换作品时不残留上一部的数据）', async () => {
    const { urls } = probe({ work: {} })
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useMediaLibraryDetail(id), {
      initialProps: { id: 'tmdb:1' as string | null },
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ id: 'tmdb:2' })
    await waitFor(() => expect(urls.length).toBe(2))
    expect(urls[1]).toContain('tmdb%3A2')
  })

  it('**不轮询**：60 秒过去仍然只有首载那一次', async () => {
    vi.useFakeTimers()
    const { urls } = probe({ work: {} })
    const { result } = renderHook(() => useMediaLibraryDetail('tmdb:1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.loading).toBe(false)
    const after = urls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(urls.length).toBe(after)
  })
})

/** 假 EventSource——同 notifications/sseSeparation.test.tsx。 */
class FakeES {
  static instances: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  private listeners = new Map<string, ((e: { data: string }) => void)[]>()
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener() {}
  close() { this.readyState = 2 }
  emit(e: ScoutEvent) {
    for (const fn of this.listeners.get(e.type) ?? []) fn({ data: JSON.stringify(e) })
  }
  /** 进程重启后的 hello 帧：换 bootId 才能把 lastSeenId 清零，否则 id 从 1 再起会被去重门丢掉。 */
  hello(bootId: string) {
    for (const fn of this.listeners.get('hello') ?? []) fn({ data: JSON.stringify({ bootId }) })
  }
  open() { this.readyState = 1; this.onopen?.() }
  fail(readyState: number) { this.readyState = readyState; this.onerror?.() }
}

function EventsWrap({ children }: { children: ReactNode }) {
  return <EventsProvider>{children}</EventsProvider>
}

describe('found 事件后重拉（不轮询、不另开 SSE）', () => {
  beforeEach(() => {
    FakeES.instances = []
    __resetEventsBusForTests()
    vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
  })
  afterEach(() => { __resetEventsBusForTests() })

  let seq = 0
  const foundEvent = (): ScoutEvent => ({
    id: ++seq, at: Date.now(), type: 'found',
    message: 'Phantom：装上了 2 条字幕', title: 'Phantom',
    workbench: 'subtitle', data: { installed: 2 },
  })

  it('found 事件后 useMediaLibrary 再请求一次', async () => {
    seq = 0
    const { urls } = probe([])
    const { result } = renderHook(() => useMediaLibrary(), { wrapper: EventsWrap })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    const before = urls.filter((u) => u.includes('/api/v2/mediaLibrary')).length
    expect(before).toBeGreaterThanOrEqual(1)
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.emit(foundEvent())
    })
    await waitFor(() =>
      expect(urls.filter((u) => u.includes('/api/v2/mediaLibrary')).length).toBeGreaterThan(before),
    )
  })

  it('found 事件后 useMediaLibraryDetail 再请求一次', async () => {
    seq = 0
    const { urls } = probe({ work: {} })
    const { result } = renderHook(() => useMediaLibraryDetail('tmdb:1'), { wrapper: EventsWrap })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    const before = urls.length
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.emit(foundEvent())
    })
    await waitFor(() => expect(urls.length).toBeGreaterThan(before))
  })
})

describe('SSE current 从有变无后再拉（不看冻结的 health GET）', () => {
  beforeEach(() => {
    FakeES.instances = []
    __resetEventsBusForTests()
    vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
  })
  afterEach(() => { __resetEventsBusForTests() })

  let seq = 0
  const activity = (over: Partial<ScoutEvent> = {}): ScoutEvent => ({
    id: ++seq, at: Date.now(), type: 'activity', message: 'm', ...over,
  })

  it('workbench activity 之后再发无 workbench 的巡检 → useMediaLibrary 再请求一次', async () => {
    seq = 0
    const { urls } = probe([])
    const { result } = renderHook(() => useMediaLibrary(), { wrapper: EventsWrap })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    const libraryGets = () => urls.filter((u) => {
      const path = u.split('?')[0] ?? ''
      return /\/api\/v2\/mediaLibrary$/.test(path)
    }).length
    const before = libraryGets()
    expect(before).toBeGreaterThanOrEqual(1)
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.emit(activity({ workbench: 'subtitle', message: '正在找字幕：A', title: 'A' }))
    })
    act(() => {
      FakeES.instances[0]!.emit(activity({ message: '巡检完成' }))
    })
    await waitFor(() => expect(libraryGets()).toBeGreaterThan(before))
  })

  it('workbench activity 之后再发无 workbench 的巡检 → useMediaLibraryDetail 再请求一次', async () => {
    seq = 0
    const { urls } = probe({ work: {} })
    const { result } = renderHook(() => useMediaLibraryDetail('tmdb:1'), { wrapper: EventsWrap })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    const detailGets = () => urls.filter((u) => u.includes('/api/v2/mediaLibrary/')).length
    const before = detailGets()
    expect(before).toBeGreaterThanOrEqual(1)
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.emit(activity({ workbench: 'subtitle', message: '正在找字幕：A', title: 'A' }))
    })
    act(() => {
      FakeES.instances[0]!.emit(activity({ message: '巡检完成' }))
    })
    await waitFor(() => expect(detailGets()).toBeGreaterThan(before))
  })

  it('progress 带 workbench 之后再发巡检 activity → useMediaLibrary 再请求一次', async () => {
    seq = 0
    const { urls } = probe([])
    const { result } = renderHook(() => useMediaLibrary(), { wrapper: EventsWrap })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    const libraryGets = () => urls.filter((u) => /\/api\/v2\/mediaLibrary$/.test(u.split('?')[0] ?? '')).length
    const before = libraryGets()
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.emit({
        id: ++seq, at: Date.now(), type: 'progress',
        message: 'p', workbench: 'subtitle', data: { done: 1, total: 6 },
      })
    })
    act(() => {
      FakeES.instances[0]!.emit(activity({ message: '巡检完成' }))
    })
    await waitFor(() => expect(libraryGets()).toBeGreaterThan(before))
  })

  it('全程巡检（从未有 current）不重拉', async () => {
    seq = 0
    const { urls } = probe([])
    const { result } = renderHook(() => useMediaLibrary(), { wrapper: EventsWrap })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    const before = urls.filter((u) => /\/api\/v2\/mediaLibrary$/.test(u.split('?')[0] ?? '')).length
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.emit(activity({ message: '巡检完成' }))
    })
    await act(async () => { await Promise.resolve() })
    expect(urls.filter((u) => /\/api\/v2\/mediaLibrary$/.test(u.split('?')[0] ?? '')).length).toBe(before)
  })

  it('identify activity 不重拉；identify 之后无 workbench 的巡检才重拉', async () => {
    seq = 0
    const { urls } = probe([])
    const { result } = renderHook(() => useMediaLibrary(), { wrapper: EventsWrap })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    const libraryGets = () => urls.filter((u) => /\/api\/v2\/mediaLibrary$/.test(u.split('?')[0] ?? '')).length
    const before = libraryGets()
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.emit(activity({ workbench: 'identify', message: '正在识别：A', title: 'A' }))
    })
    await act(async () => { await Promise.resolve() })
    expect(libraryGets(), 'identify 是当前态，不该当巡检清空去重拉').toBe(before)
    act(() => {
      FakeES.instances[0]!.emit(activity({ message: '巡检完成' }))
    })
    await waitFor(() => expect(libraryGets()).toBeGreaterThan(before))
  })
})

const libraryListGets = (urls: string[]) =>
  urls.filter((u) => /\/api\/v2\/mediaLibrary$/.test(u.split('?')[0] ?? '')).length

/** 同一棵 EventsProvider 上先灌 Context，再挂 useMediaLibrary——模拟从活动页切到 #/media。 */
function PresenceShell({ probe }: { probe: boolean }) {
  return <EventsProvider>{probe ? <MediaLibraryProbe /> : null}</EventsProvider>
}
function MediaLibraryProbe() {
  useMediaLibrary()
  return null
}

describe('挂载时不把 Context 里已有的 last progress+patrol 当 live 清空', () => {
  beforeEach(() => {
    FakeES.instances = []
    __resetEventsBusForTests()
    vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
  })
  afterEach(() => { __resetEventsBusForTests() })

  it('进页前 Context 已有 workbench progress + 巡检 activity → 只有首载 1 次 GET；之后新的清空才再拉', async () => {
    const { urls } = probe([])
    const view = render(<PresenceShell probe={false} />)
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.emit({
        id: 10, at: Date.now(), type: 'progress',
        message: 'p', workbench: 'subtitle', data: { done: 1, total: 6 },
      })
      FakeES.instances[0]!.emit({
        id: 11, at: Date.now(), type: 'activity', message: '巡检完成',
      })
    })
    expect(libraryListGets(urls)).toBe(0)

    view.rerender(<PresenceShell probe={true} />)
    await waitFor(() => expect(libraryListGets(urls)).toBeGreaterThanOrEqual(1))
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(libraryListGets(urls), '把进页前的 progress(有)+patrol(无) 重放成 live 清空 → 多打了一次 GET')
      .toBe(1)

    act(() => {
      FakeES.instances[0]!.emit({
        id: 20, at: Date.now(), type: 'activity',
        message: '正在找字幕：B', title: 'B', workbench: 'subtitle',
      })
    })
    act(() => {
      FakeES.instances[0]!.emit({
        id: 21, at: Date.now(), type: 'activity', message: '巡检完成',
      })
    })
    await waitFor(() => expect(libraryListGets(urls)).toBe(2))
  })
})

describe('SSE 恢复后 id 从 1 重数仍能重拉（bootId 换 epoch）', () => {
  beforeEach(() => {
    FakeES.instances = []
    __resetEventsBusForTests()
    vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
  })
  afterEach(() => { __resetEventsBusForTests() })

  it('高 id found 之后 resume + hello 新 bootId → found id=1 再 GET', async () => {
    const { urls } = probe([])
    const { result } = renderHook(() => useMediaLibrary(), { wrapper: EventsWrap })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0))
    act(() => {
      FakeES.instances[0]!.open()
      FakeES.instances[0]!.hello('boot-A')
      FakeES.instances[0]!.emit({
        id: 50, at: Date.now(), type: 'found',
        message: 'Phantom：装上了 2 条字幕', title: 'Phantom',
        workbench: 'subtitle', data: { installed: 2 },
      })
    })
    await waitFor(() => expect(libraryListGets(urls)).toBeGreaterThanOrEqual(2))
    const afterHighFound = libraryListGets(urls)

    act(() => { FakeES.instances[0]!.fail(2) })
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1))
    const reconnected = FakeES.instances[FakeES.instances.length - 1]!
    act(() => { reconnected.open() })
    await waitFor(() =>
      expect(libraryListGets(urls), 'resume 没有补拉').toBeGreaterThan(afterHighFound),
    )
    const afterResume = libraryListGets(urls)

    act(() => {
      reconnected.hello('boot-restart')
      reconnected.emit({
        id: 1, at: Date.now(), type: 'found',
        message: 'Other：装上了 1 条字幕', title: 'Other',
        workbench: 'subtitle', data: { installed: 1 },
      })
    })
    await waitFor(() =>
      expect(libraryListGets(urls), 'seenFoundId 没清零 → 重启后的 found id=1 被丢掉')
        .toBeGreaterThan(afterResume),
    )
  })
})

