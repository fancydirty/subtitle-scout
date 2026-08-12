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

  // ── dispose：卸载清理（语义 = **取消**待触发的扫描，绝不补打一枪）─────────────────
  //
  // 为什么是"取消"而不是"立即触发"：用户加根时服务端 POST /api/v2/settings/roots 处理器
  // **已经**同步踢过一次 requestIngest（src/dashboard/server.ts:745），用户真正想要的那次
  // 扫描早就跑了。这里的防抖扫描是第二脚，取消它在正常路径上什么都不丢；反过来若 dispose
  // 改成 flush，就会把"用户已经删掉这个根"变成"照样扫一遍"，正是防抖器要防的那件事。
  it('dispose 取消待触发的扫描——2 秒后不打 API', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')
    debouncer.dispose()

    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    // 关键：**一次都不许**打。若 dispose 写成 flush（立即触发），这里会是 1。
    expect(triggerScan).not.toHaveBeenCalled()
  })

  it('dispose 清空待扫队列', () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.requestScan('/media/tv')
    debouncer.requestScan('/media/movies')
    expect(debouncer.getPendingCount()).toBe(2)

    debouncer.dispose()
    expect(debouncer.getPendingCount()).toBe(0)
  })

  it('dispose 幂等：无待扫时调、连调两次都不炸也不触发', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.dispose()
    debouncer.requestScan('/media/tv')
    debouncer.dispose()
    debouncer.dispose()

    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()
    expect(triggerScan).not.toHaveBeenCalled()
  })

  // StrictMode（web/src/main.tsx 包了 StrictMode，React 19 开发期双跑挂载/卸载）会让
  // dispose 在"模拟卸载"时先跑一次，而 useRef 持有的是**同一个**实例——所以 dispose 不能
  // 把实例打成永久废品，否则开发期重挂载后防抖器就哑了。
  it('dispose 后实例仍可用（StrictMode 双跑挂载安全）', async () => {
    const triggerScan = vi.fn().mockResolvedValue(undefined)
    const debouncer = createScanDebouncer(triggerScan)

    debouncer.dispose()

    debouncer.requestScan('/media/tv')
    vi.advanceTimersByTime(2000)
    await vi.runAllTimersAsync()

    expect(triggerScan).toHaveBeenCalledTimes(1)
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
