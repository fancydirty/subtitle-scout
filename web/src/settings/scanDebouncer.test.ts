// web/src/settings/scanDebouncer.test.ts：防抖扫描管理器测试（R6）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createScanDebouncer } from './scanDebouncer.js'

describe('scanDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('debounces scan requests for 2 seconds', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')
    expect(triggerScan).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(triggerScan).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    await vi.runAllTimersAsync()
    expect(triggerScan).toHaveBeenCalledTimes(1)
  })

  it('accumulates multiple paths and triggers scan once', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')
    debouncer.requestScan('/media/movies')
    debouncer.requestScan('/data/music')

    expect(debouncer.getPendingCount()).toBe(3)

    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    expect(triggerScan).toHaveBeenCalledTimes(1)
    expect(debouncer.getPendingCount()).toBe(0)
  })

  it('resets debounce timer on new request', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')
    vi.advanceTimersByTime(1500)

    debouncer.requestScan('/media/movies')
    vi.advanceTimersByTime(1500) // 总共 3s，但第二次请求重置了计时器

    expect(triggerScan).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500) // 从第二次请求算起满 2s
    await vi.runAllTimersAsync()

    expect(triggerScan).toHaveBeenCalledTimes(1)
  })

  it('cancels scan for deleted path', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')
    debouncer.requestScan('/media/movies')
    expect(debouncer.getPendingCount()).toBe(2)

    debouncer.cancelScan('/media/tv')
    expect(debouncer.getPendingCount()).toBe(1)

    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    // 只有 /media/movies 被扫描，/media/tv 被取消了
    expect(triggerScan).toHaveBeenCalledTimes(1)
  })

  it('cancels timer when all paths removed', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')
    debouncer.cancelScan('/media/tv')

    expect(debouncer.getPendingCount()).toBe(0)

    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    // 队列空了，定时器被取消，不触发扫描
    expect(triggerScan).not.toHaveBeenCalled()
  })

  it('triggerNow bypasses debounce and clears queue', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')
    debouncer.requestScan('/media/movies')
    expect(debouncer.getPendingCount()).toBe(2)

    await debouncer.triggerNow()

    // 立即触发，队列清空
    expect(triggerScan).toHaveBeenCalledTimes(1)
    expect(debouncer.getPendingCount()).toBe(0)

    // 原定时器被取消，2 秒后不会再触发
    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()
    expect(triggerScan).toHaveBeenCalledTimes(1) // 仍然是 1 次
  })

  it('handles API errors gracefully', async () => {
    const triggerScan = vi.fn().mockRejectedValue(new Error('network error'))
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')

    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    // 错误被静默吞掉，不应该炸掉防抖器
    expect(triggerScan).toHaveBeenCalledTimes(1)
    expect(consoleWarn).toHaveBeenCalledWith(
      '[scanDebouncer] trigger failed:',
      expect.any(Error),
    )

    // 下一次请求仍然可以正常工作
    debouncer.requestScan('/media/movies')
    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    expect(triggerScan).toHaveBeenCalledTimes(2)
  })

  it('deduplicates same path', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')
    debouncer.requestScan('/media/tv')
    debouncer.requestScan('/media/tv')

    expect(debouncer.getPendingCount()).toBe(1) // Set 自动去重

    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    expect(triggerScan).toHaveBeenCalledTimes(1)
  })
})
