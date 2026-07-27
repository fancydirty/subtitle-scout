import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from './probeConcurrency.js'

describe('mapWithConcurrency', () => {
  it('并发上限被遵守（峰值不超过 limit）', async () => {
    let inFlight = 0
    let peak = 0
    const items = [1, 2, 3, 4, 5, 6, 7, 8]
    await mapWithConcurrency(items, 3, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return n * 2
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('结果按输入顺序归属，不按完成顺序', async () => {
    const items = [50, 10, 30]
    const out = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(out).toEqual([
      { status: 'fulfilled', value: 50 },
      { status: 'fulfilled', value: 10 },
      { status: 'fulfilled', value: 30 },
    ])
  })

  it('一个失败不影响其余（allSettled 语义，不是 all）', async () => {
    const items = ['ok1', 'boom', 'ok2']
    const out = await mapWithConcurrency(items, 2, async (s) => {
      if (s === 'boom') throw new Error('probe exploded')
      return s.toUpperCase()
    })
    expect(out[0]).toEqual({ status: 'fulfilled', value: 'OK1' })
    expect(out[1].status).toBe('rejected')
    expect(out[2]).toEqual({ status: 'fulfilled', value: 'OK2' })
  })

  it('limit=1 等价串行', async () => {
    let peak = 0
    let inFlight = 0
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--; return n
    })
    expect(peak).toBe(1)
  })

  it('空输入返回空数组，不抛', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([])
  })
})
