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
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import { useMediaLibrary, useMediaLibraryDetail } from '../api/hooks.js'

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
      missingEpisodeCount: 0, subtitledEpisodeCount: 62,
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
