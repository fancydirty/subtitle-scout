// web/src/api/hooks.test.ts：useSetupStatus 的轮询节律与可见性暂停——spec A §5.5 承诺
// engineEnabled 翻转 ≤15s 上屏，锁的就是这个 hook 的 LIBRARY_POLL_MS 共用节律。
// jsdom + fake timers；api.setupStatus spy 替掉不走网络。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { api } from './client.js'
import type { SetupStatusDTO } from './types.js'
import { useSetupStatus } from './hooks.js'

const STATUS: SetupStatusDTO = {
  bootstrapComplete: true,
  tmdb: { satisfied: true, source: 'env', masked: 'abc••••xyz' },
  llm: { satisfied: true, source: 'env', model: 'm' },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: false },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useSetupStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(api, 'setupStatus').mockResolvedValue(STATUS)
    setVisibility('visible')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('首载返回 data，loading 翻 false', async () => {
    const { result } = renderHook(() => useSetupStatus())
    expect(result.current.loading).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.data?.engineEnabled).toBe(true)
    expect(result.current.loading).toBe(false)
  })

  it('15s 轮询（与其他数据 hook 同一 LIBRARY_POLL_MS 节律）', async () => {
    renderHook(() => useSetupStatus())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.setupStatus).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(api.setupStatus).toHaveBeenCalledTimes(2)
  })

  it('页面不可见时暂停轮询；恢复可见立即补拉一次', async () => {
    renderHook(() => useSetupStatus())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(api.setupStatus).toHaveBeenCalledTimes(1)
    act(() => setVisibility('hidden'))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(api.setupStatus).toHaveBeenCalledTimes(1)
    await act(async () => setVisibility('visible'))
    expect(api.setupStatus).toHaveBeenCalledTimes(2)
  })
})
