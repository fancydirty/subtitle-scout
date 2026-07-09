import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrefetchQueue, RETRY_LADDER_DAYS } from './queue.js'

const file = () => join(mkdtempSync(join(tmpdir(), 'q-')), 'queue.json')
const DAY = 86_400_000

describe('PrefetchQueue', () => {
  it('persists watermark and entries across instances', () => {
    const f = file()
    let now = 1_000_000
    const q1 = new PrefetchQueue(f, () => now)
    q1.setWatermark('2026-07-06T00:00:00Z')
    q1.upsert('item1', 'Movie One')
    const q2 = new PrefetchQueue(f, () => now)
    expect(q2.watermark()).toBe('2026-07-06T00:00:00Z')
    expect(q2.due()?.itemId).toBe('item1')
  })

  it('decay ladder: 1d/2d/4d/8d retries, dormant on the 5th failure', () => {
    const f = file()
    let now = 0
    const q = new PrefetchQueue(f, () => now)
    q.upsert('x', 'X')
    for (const days of RETRY_LADDER_DAYS) {
      expect(q.due()?.itemId).toBe('x')      // 到期可消费
      q.recordFailure('x')
      expect(q.dormantFor('x')).toBe(false)  // 尚未休眠
      expect(q.due()).toBeUndefined()        // 未到期
      now += days * DAY + 1                  // 快进本级延迟
    }
    expect(q.due()?.itemId).toBe('x')        // 第 4 次失败后 +8d 依然会重试
    q.recordFailure('x')                     // 第 5 次失败
    expect(q.dormantFor('x')).toBe(true)
    now += 100 * DAY
    expect(q.due()).toBeUndefined()
  })

  it('activate resets a dormant entry to pending', () => {
    const f = file()
    let now = 0
    const q = new PrefetchQueue(f, () => now)
    q.upsert('x', 'X')
    for (let i = 0; i < 5; i++) q.recordFailure('x')
    expect(q.dormantFor('x')).toBe(true)
    q.activate('x')
    expect(q.dormantFor('x')).toBe(false)
    expect(q.due()?.itemId).toBe('x')
  })

  it('remove clears an entry on success; upsert is idempotent', () => {
    const q = new PrefetchQueue(file(), () => 0)
    q.upsert('x', 'X'); q.upsert('x', 'X')
    expect(q.size().pending).toBe(1)
    q.remove('x')
    expect(q.size().pending).toBe(0)
    expect(q.due()).toBeUndefined()
  })

  it('due returns oldest-added first', () => {
    let now = 0
    const q = new PrefetchQueue(file(), () => now)
    q.upsert('a', 'A'); now = 1; q.upsert('b', 'B')
    expect(q.due()?.itemId).toBe('a')
  })

  it('emits lifecycle events via onEvent', () => {
    const events: unknown[] = []
    let now = 0
    const q = new PrefetchQueue(file(), () => now, e => events.push(e))
    q.upsert('x', 'X')
    q.recordFailure('x')
    for (let i = 0; i < 4; i++) q.recordFailure('x')
    q.activate('x')
    q.remove('x')
    const kinds = (events as { event: string }[]).map(e => e.event)
    expect(kinds).toEqual(['enqueued', 'decayed', 'decayed', 'decayed', 'decayed', 'dormant', 'activated', 'removed'])
  })
})
