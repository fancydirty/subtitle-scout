// web/src/api/health.hook.test.tsx：useHealth（Task ⑦ 加的那个 hook）。
//
// ⚠️ 如实记录：本 task **没有任何生产调用点**（三个页面都还是占位壳）——所以下面这些
// 用例守的是"这个 hook 自己的行为对不对"，**不是**"它被接上了"。接线由 Task ⑨ 负责，
// 那时才该有一条"活动页在 SSE 恢复时调了 reload"的断言。
// 这段话是本仓病 A（加了能力却没人读）的**如实披露**，不是免责声明：
// 本 hook 在 Task ⑨ 之前不该被算作"完成"。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act, cleanup } from '@testing-library/react'
import { useHealth } from './hooks.js'
import type { HealthDTO } from './types.js'

const HEALTH: HealthDTO = {
  lastInspectAt: 1_700_000_000_000,
  workPermitted: false,
  engineEnabled: true,
  setupSatisfied: false,
  roots: [{ path: '/media', ok: null, lastError: null, lastCheckedAt: null }],
  unidentified: { dirCount: 0, dirs: [] }, stalledJobs: { count: 0, overdueMs: null },
  current: null,
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => HEALTH }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('useHealth', () => {
  it('首载打 GET /api/v2/health 并给出三态（loading → data）', async () => {
    const { result } = renderHook(() => useHealth())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v2/health')
  })

  it('**不轮询**——挂载后等 60 秒仍然只有那一次请求（R-F6：用 SSE 不用轮询）', async () => {
    vi.useFakeTimers()
    try {
      renderHook(() => useHealth())
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchMock.mock.calls.length, 'useHealth 在轮询 → 与 SSE 重复').toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reload() 真的再打一次（Task ⑨ 要在 SSE 重连时调它纠正当前态）', async () => {
    const { result } = renderHook(() => useHealth())
    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(fetchMock.mock.calls.length).toBe(1)
    act(() => result.current.reload())
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2))
  })

  it('失败降级成 error 字符串，不抛、不白屏（同既有 hooks 的三态口径）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ error: 'boom' }),
    }) as unknown as Response))
    const { result } = renderHook(() => useHealth())
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('三个布尔如实透传——workPermitted=false 但 engineEnabled=true 必须可区分', async () => {
    const { result } = renderHook(() => useHealth())
    await waitFor(() => expect(result.current.data).not.toBeNull())
    const d = result.current.data!
    // 这正是后端拆三个字段的理由：用户要能知道是"你关了开关"还是"凭据没配好"。
    expect(d.workPermitted).toBe(false)
    expect(d.engineEnabled).toBe(true)
    expect(d.setupSatisfied).toBe(false)
  })

  it('roots[].ok 的 null 三态原样保留——**没有被 ?? true 兜底**（后端点名的渲染纪律）', async () => {
    const { result } = renderHook(() => useHealth())
    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.data!.roots[0]!.ok).toBeNull()
  })
})
