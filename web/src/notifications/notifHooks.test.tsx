// web/src/notifications/notifHooks.test.tsx：`useNotifications` 的**运行时探针**测试。
//
// 手法同 media/mediaHooks.test.tsx（Task ⑧ 的既有先例）：stub 掉 global fetch 并数 URL
// 与次数——URL 与调用次数是真实发生的行为，注释与源码措辞改不动它（Task ⑤ 的教训：
// 源码级断言一行行尾注释就能喂饱）。
//
// 这里要钉的四条契约，每条都是"改坏了不报错"的形态：
//  ① 打的是 /api/v2/notifications（拼错路径会 404 → 页面永远错误态，但没有测试会红）
//  ② **不轮询**（挂个 15s 定时器不会有任何测试变红，但它是真实的持续负载，
//     而且这一页有 SSE——轮询正是 R-F6 要消灭的东西）
//  ③ 失败**不给假空数组**（给 [] 会让页面说"这周什么都没找到"，把故障说成事实）
//  ④ 是 **GET**（写方法 = 已读状态的必经之路，R-F3 明令不做）
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup, act } from '@testing-library/react'
import { useNotifications } from '../api/hooks.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function probe(body: unknown = [], ok = true) {
  const calls: { url: string; method: string }[] = []
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' })
    return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response
  })
  vi.stubGlobal('fetch', f)
  return { calls, f }
}

describe('useNotifications', () => {
  it('① 打 /api/v2/notifications（不是 mediaLibrary、不是旧 library）', async () => {
    const { calls } = probe([])
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toContain('/api/v2/notifications')
    expect(calls[0]!.url).not.toContain('mediaLibrary')
  })

  it('④ 方法是 GET（写方法 = 已读状态的必经之路）', async () => {
    const { calls } = probe([])
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(calls[0]!.method.toUpperCase()).toBe('GET')
  })

  it('成功 → data 是后端数组原文，error 为 null', async () => {
    const rows = [{ workId: 'tmdb:1', title: 'A', season: 1, episodes: [1], latestAt: 1, via: 'fetch' }]
    probe(rows)
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toEqual(rows)
    expect(result.current.error).toBeNull()
  })

  it('③ 失败 → error 有值、data 保持 null（不吞异常、不给假空数组）', async () => {
    probe({ error: 'db locked' }, false)
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toContain('db locked')
    // 🔴 失败时给 [] 会让页面显示"这一周什么都没找到"——把"我没能问到"说成事实（§4.4 谎报）
    expect(result.current.data).toBeNull()
  })

  it('reload() 真的重发（探针计数 +1）', async () => {
    const { calls } = probe([])
    const { result } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = calls.length
    act(() => result.current.reload())
    await waitFor(() => expect(calls.length).toBe(before + 1))
  })

  it('② **不轮询**：60 秒过去仍然只有首载那一次请求', async () => {
    vi.useFakeTimers()
    const { calls } = probe([])
    const { result } = renderHook(() => useNotifications())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.loading).toBe(false)
    const after = calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(calls.length, '出现了轮询——这一页有 SSE，轮询是 R-F6 点名要消灭的东西').toBe(after)
  })

  it('卸载后不再 setState（abort 生效）——不然控制台会刷 act 警告，真问题被淹掉', async () => {
    const { calls } = probe([])
    const { result, unmount } = renderHook(() => useNotifications())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const before = calls.length
    unmount()
    await act(async () => { await Promise.resolve() })
    expect(calls.length).toBe(before)
  })
})
