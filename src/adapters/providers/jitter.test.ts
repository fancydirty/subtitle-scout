import { describe, it, expect, vi } from 'vitest'
import { jitteredDelayMs, JitteredIntervalLimiter } from './jitter.js'

describe('jitteredDelayMs', () => {
  it('returns exactly baseMs when rng() is 0 (the floor)', () => {
    expect(jitteredDelayMs(2000, 3000, () => 0)).toBe(2000)
  })

  it('approaches baseMs + jitterRangeMs as rng() approaches 1', () => {
    expect(jitteredDelayMs(2000, 3000, () => 0.999999)).toBeCloseTo(4999.997, 2)
  })

  it('varies with different rng draws instead of being a constant fixed delay', () => {
    const a = jitteredDelayMs(2000, 3000, () => 0.1)
    const b = jitteredDelayMs(2000, 3000, () => 0.9)
    expect(a).not.toBe(b)
    expect(a).toBeGreaterThanOrEqual(2000)
    expect(a).toBeLessThan(5000)
    expect(b).toBeGreaterThanOrEqual(2000)
    expect(b).toBeLessThan(5000)
  })

  it('defaults to Math.random when no rng is injected, staying within [base, base+range)', () => {
    const d = jitteredDelayMs(2000, 3000)
    expect(d).toBeGreaterThanOrEqual(2000)
    expect(d).toBeLessThan(5000)
  })
})

describe('JitteredIntervalLimiter', () => {
  it('does not wait on the first call (nothing to throttle against yet)', async () => {
    const rng = () => 0.5
    const limiter = new JitteredIntervalLimiter(2000, 3000, rng)
    const t0 = Date.now()
    await limiter.wait()
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('waits for the injected-rng-determined jittered delay, not a fixed floor', async () => {
    vi.useFakeTimers()
    try {
      const rng = () => 0.5 // target = 2000 + 0.5*3000 = 3500ms
      const limiter = new JitteredIntervalLimiter(2000, 3000, rng)
      await limiter.wait() // first call: no prior request, resolves immediately
      let resolved = false
      limiter.wait().then(() => { resolved = true })
      await vi.advanceTimersByTimeAsync(3499)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-derives a fresh random delay on every wait() call — the setTimeout duration varies with rng, not fixed', async () => {
    vi.useFakeTimers()
    try {
      // wait() always draws from rng() to compute its target, even on a no-op first call
      // (delta huge, so the draw is unused for timing) — so index 0 is "spent" by wait #1.
      const values = [0.9, 0, 1] // wait #1: unused; wait #2 -> base (1000ms); wait #3 -> base+range (3000ms)
      let call = 0
      const rng = () => values[call++]
      const limiter = new JitteredIntervalLimiter(1000, 2000, rng)
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout')

      await limiter.wait() // first call: delta huge, never schedules a timer
      expect(setTimeoutSpy).not.toHaveBeenCalled()

      const p2 = limiter.wait()
      await vi.runAllTimersAsync()
      await p2
      expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(1000)

      const p3 = limiter.wait()
      await vi.runAllTimersAsync()
      await p3
      expect(setTimeoutSpy.mock.calls.at(-1)?.[1]).toBe(3000)

      setTimeoutSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is structurally compatible with a caller that only needs wait(): Promise<void> (e.g. MinIntervalLimiter override)', () => {
    const limiter = new JitteredIntervalLimiter(1, 1)
    expect(typeof limiter.wait).toBe('function')
  })

  // R6-6 修复：并发竞态——读-睡-写无互斥会让两个并发调用算出同一个 delta、同时睡醒，突破间隔。
  // 用 promise 队列串行化：每个 wait() 都排到前一个的后面，确保 last 的更新原子性。
  // 这条测试锁住"5 个并发 wait() 的总耗时 >= 4 * baseMs"（如果无互斥，它们会同时睡醒，总耗时 ~baseMs）。
  it('并发 wait() 串行化：5 个并发调用的总耗时 >= 4 * baseMs', async () => {
    const baseMs = 100
    const limiter = new JitteredIntervalLimiter(baseMs, 0, () => 0) // 无 jitter，固定 100ms
    const start = Date.now()
    await Promise.all([
      limiter.wait(),
      limiter.wait(),
      limiter.wait(),
      limiter.wait(),
      limiter.wait(),
    ])
    const elapsed = Date.now() - start
    // 5 个并发调用串行化后：第 1 个立即执行，后 4 个各等 100ms，总耗时 >= 400ms
    expect(elapsed).toBeGreaterThanOrEqual(4 * baseMs - 50) // 留 50ms 误差（定时器不精确）
  })
})
