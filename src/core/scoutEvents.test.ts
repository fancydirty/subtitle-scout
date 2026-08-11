// src/core/scoutEvents.test.ts —— R-F10 事件总线的行为锁。
//
// 这个文件守的是"推什么、不推什么、怎么节流、断线怎么补"四件事。前三件是用户裁决的字面
// 内容（R-F10），第四件是它的必要条件（手机锁屏再打开必然断线重连，不补发活动页会空白）。
import { describe, it, expect, vi } from 'vitest'
import { ScoutEventBus, type ScoutEvent } from './scoutEvents.js'

/** 可注入时钟的总线（本文件一律不真的等——节流测试真睡 1 秒是把测试时长押在 wall clock 上）。 */
function mkBus(startAt = 1_000_000) {
  let now = startAt
  const bus = new ScoutEventBus({ now: () => now })
  return { bus, tick: (ms: number) => { now += ms }, at: () => now }
}

function collect(bus: ScoutEventBus): { got: ScoutEvent[]; off: () => void } {
  const got: ScoutEvent[] = []
  const off = bus.subscribe((e) => { got.push(e) })
  return { got, off }
}

describe('ScoutEventBus（R-F10 SSE 事件总线）', () => {
  describe('四类事件各自能推到订阅者', () => {
    it('activity / found / health / progress 四类都能送达', () => {
      const { bus } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'activity', message: '巡检开始' })
      bus.publish({ type: 'found', message: '装上了 3/3 条字幕', title: '甲剧' })
      bus.publish({ type: 'health', message: '守备目录读取失败' })
      bus.publish({ type: 'progress', message: '第 3/8 集' })
      expect(got.map((e) => e.type)).toEqual(['activity', 'found', 'health', 'progress'])
    })

    it('每条事件带单调递增的 id 与时间戳（Last-Event-ID 续传的地基）', () => {
      const { bus, tick } = mkBus(5_000)
      const { got } = collect(bus)
      bus.publish({ type: 'activity', message: 'a' })
      tick(10)
      bus.publish({ type: 'found', message: 'b' })
      expect(got[0].id).toBe(1)
      expect(got[1].id).toBe(2)
      expect(got[0].at).toBe(5_000)
      expect(got[1].at).toBe(5_010)
    })
  })

  describe('progress 节流（R-F10 约束 2：唯一可能高频的事件）', () => {
    it('🔴 1 秒内连发 10 条 progress → 只出 1 条（其余被折叠）', () => {
      const { bus } = mkBus()
      const { got } = collect(bus)
      for (let i = 0; i < 10; i++) bus.publish({ type: 'progress', message: `第 ${i}/10 集` })
      expect(got.filter((e) => e.type === 'progress')).toHaveLength(1)
    })

    it('跨过节流窗口后下一条 progress 放行（节流是限速不是丢弃后半生）', () => {
      const { bus, tick } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'progress', message: '1' })
      bus.publish({ type: 'progress', message: '2' })   // 被折叠
      tick(1_000)
      bus.publish({ type: 'progress', message: '3' })
      expect(got.map((e) => e.message)).toEqual(['1', '3'])
    })

    it('🔴 其余三类不被节流误伤：连发 3 条 found 收到 3 条', () => {
      const { bus } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'found', message: 'A' })
      bus.publish({ type: 'found', message: 'B' })
      bus.publish({ type: 'found', message: 'C' })
      expect(got.map((e) => e.message)).toEqual(['A', 'B', 'C'])
    })

    it('🔴 activity / health 同样不节流（同一 tick 连发全部送达）', () => {
      const { bus } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'activity', message: 'a1' })
      bus.publish({ type: 'activity', message: 'a2' })
      bus.publish({ type: 'health', message: 'h1' })
      bus.publish({ type: 'health', message: 'h2' })
      expect(got).toHaveLength(4)
    })

    it('🔴 被节流掉的 progress 不占 id（不然续传会以为漏了事件而重复补发空洞）', () => {
      const { bus, tick } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'progress', message: '1' })
      bus.publish({ type: 'progress', message: '2' })   // 折叠
      tick(1_000)
      bus.publish({ type: 'progress', message: '3' })
      expect(got.map((e) => e.id)).toEqual([1, 2])
    })
  })

  describe('多订阅者 + 清理（长跑 daemon 上的真问题）', () => {
    it('🔴 第二个订阅者不挤掉第一个，两者各自收到全量', () => {
      const { bus } = mkBus()
      const a = collect(bus)
      const b = collect(bus)
      bus.publish({ type: 'activity', message: 'x' })
      expect(a.got).toHaveLength(1)
      expect(b.got).toHaveLength(1)
    })

    it('🔴 退订后不再收到，且总线内部不再持有该回调（内存泄漏防线）', () => {
      const { bus } = mkBus()
      const a = collect(bus)
      const b = collect(bus)
      expect(bus.subscriberCount()).toBe(2)
      a.off()
      expect(bus.subscriberCount()).toBe(1)
      bus.publish({ type: 'activity', message: 'x' })
      expect(a.got).toHaveLength(0)
      expect(b.got).toHaveLength(1)
      b.off()
      expect(bus.subscriberCount()).toBe(0)
    })

    it('🔴 一个订阅者抛错不许打断 publish，也不许波及其它订阅者（同 traceBus 既有口径）', () => {
      const { bus } = mkBus()
      bus.subscribe(() => { throw new Error('boom') })
      const b = collect(bus)
      expect(() => bus.publish({ type: 'activity', message: 'x' })) .not.toThrow()
      expect(b.got).toHaveLength(1)
    })
  })

  describe('Last-Event-ID 续传（环形缓冲 50 条）', () => {
    it('补发 id 大于 lastEventId 的事件', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'activity', message: 'a' })   // id 1
      bus.publish({ type: 'found', message: 'b' })      // id 2
      bus.publish({ type: 'found', message: 'c' })      // id 3
      expect(bus.replay(1).map((e) => e.message)).toEqual(['b', 'c'])
      expect(bus.replay(3)).toEqual([])
    })

    it('缓冲上限 50 条，溢出丢最旧（长跑不许无界增长）', () => {
      const { bus } = mkBus()
      for (let i = 0; i < 60; i++) bus.publish({ type: 'found', message: `m${i}` })
      const all = bus.replay(0)
      expect(all).toHaveLength(50)
      expect(all[0].message).toBe('m10')
      expect(all[49].message).toBe('m59')
    })

    it('lastEventId 早于缓冲窗口（离线太久）→ 给出缓冲里全部，不假装没漏', () => {
      const { bus } = mkBus()
      for (let i = 0; i < 60; i++) bus.publish({ type: 'found', message: `m${i}` })
      expect(bus.replay(3)).toHaveLength(50)
    })

    it('被节流折叠掉的 progress 不进缓冲（推不出去的东西不该在重连后诈尸）', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'progress', message: '1' })
      bus.publish({ type: 'progress', message: '2' })
      expect(bus.replay(0).map((e) => e.message)).toEqual(['1'])
    })
  })

  describe('publish 失败隔离（SSE 挂了绝不能影响巡检）', () => {
    it('🔴 无订阅者时 publish 是无害的 no-op', () => {
      const { bus } = mkBus()
      expect(() => bus.publish({ type: 'activity', message: 'x' })).not.toThrow()
    })

    it('🔴 时钟函数抛错也不许把异常抛回巡检', () => {
      const bus = new ScoutEventBus({ now: () => { throw new Error('clock dead') } })
      const spy = vi.fn()
      bus.subscribe(spy)
      expect(() => bus.publish({ type: 'activity', message: 'x' })).not.toThrow()
    })
  })
})
