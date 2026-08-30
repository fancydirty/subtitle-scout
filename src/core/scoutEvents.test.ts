// src/core/scoutEvents.test.ts —— R-F10 事件总线的行为锁。
//
// 这个文件守的是"推什么、不推什么、怎么节流、断线怎么补"四件事。前三件是用户裁决的字面
// 内容（R-F10），第四件是它的必要条件（手机锁屏再打开必然断线重连，不补发活动页会空白）。
import { describe, it, expect, vi } from 'vitest'
import { ScoutEventBus, PROGRESS_THROTTLE_MS, type ScoutEvent, type ScoutCurrent } from './scoutEvents.js'

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

function cur(p: Partial<ScoutCurrent> & Pick<ScoutCurrent, 'kind'>): ScoutCurrent {
  return {
    title: null, index: null, total: null,
    workId: null, backdropPath: null, chineseTitle: null,
    startedAt: null, lastStep: null, cueDone: null, cueTotal: null,
    ...p,
  }
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

  // ── per-workbench 节流（教训七）───────────────────────────────────────────────
  // 改动前节流窗是**全局单标量**，三个工作台共用一个 1 秒窗口。阶段切换那一秒里谁先发谁把
  // 对方挤掉：字幕台刚发完，翻译台紧接着那条就被静默折叠，前端于是看到一路"卡住不动"。
  // 下面四条锁的就是"各自独立"这件事——注意每一条都验**放行**（收到了什么），不验
  // "publish 没抛异常"（病 B：中间量当结论量）。
  describe('🔴 progress 节流按工作台各自独立（教训七：全局单标量会让阶段切换互相挤掉）', () => {
    it('🔴 两个工作台同一 tick 交替发 progress → 两条都放行，不互相吃节流窗', () => {
      const { bus } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'progress', message: '字幕 1/47', workbench: 'subtitle' })
      bus.publish({ type: 'progress', message: '翻译 1/12', workbench: 'translate' })
      // 全局单标量的实现在这里只会收到第一条。
      expect(got.map((e) => e.message)).toEqual(['字幕 1/47', '翻译 1/12'])
    })

    it('🔴 三个工作台各自仍被节流：每台同 tick 连发 5 条 → 每台只出 1 条，共 3 条', () => {
      const { bus } = mkBus()
      const { got } = collect(bus)
      for (const wb of ['identify', 'subtitle', 'translate'] as const) {
        for (let i = 0; i < 5; i++) bus.publish({ type: 'progress', message: `${wb} ${i}`, workbench: wb })
      }
      // 独立 ≠ 不节流：放开成 15 条同样是错的（那是把节流整个删了）。
      expect(got.map((e) => e.message)).toEqual(['identify 0', 'subtitle 0', 'translate 0'])
    })

    it('🔴 一个工作台的窗口不被另一个工作台的放行往后顶', () => {
      const { bus, tick } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'progress', message: '字幕 1', workbench: 'subtitle' })
      tick(900)
      // 全局窗的话这条会把窗口顶到 t=900，字幕台 t=1000 那条（本该放行）就被挤掉。
      bus.publish({ type: 'progress', message: '翻译 1', workbench: 'translate' })
      tick(100)   // 字幕台距上次放行整 1000ms → 必须放行
      bus.publish({ type: 'progress', message: '字幕 2', workbench: 'subtitle' })
      expect(got.map((e) => e.message)).toEqual(['字幕 1', '翻译 1', '字幕 2'])
    })

    it('🔴 时钟从 0 起：首条 progress 必须放行（`?? -Infinity` 不能写成 `|| -Infinity`）', () => {
      // 审计 🟡-1：源码注释郑重论证了这条决策，却零测试覆盖——把 `??` 改成 `||`
      // 全量 3229 条一条都不红。而它不是理论问题：Map 里存的 0（时钟从 0 起的注入时钟）
      // 会被 `||` 判成 falsy 退回 -Infinity，节流窗当场失效。
      const { bus } = mkBus(0)
      const { got } = collect(bus)
      bus.publish({ type: 'progress', message: 'A', workbench: 'subtitle' })
      bus.publish({ type: 'progress', message: 'B', workbench: 'subtitle' })  // 同毫秒，必须被折叠
      expect(got.map((e) => e.message)).toEqual(['A'])
    })

    it('🔴 无 workbench 的 progress 自成一路，不与任何工作台合并窗口', () => {
      const { bus } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'progress', message: '无台' })                              // 巡检/扫描级
      bus.publish({ type: 'progress', message: '字幕', workbench: 'subtitle' })
      bus.publish({ type: 'progress', message: '无台 2' })                            // 同路，被折叠
      expect(got.map((e) => e.message)).toEqual(['无台', '字幕'])
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

  describe('current 快照（设计文档审计 F-6：变化流无法自证当前态）', () => {
    it('🔴 冷启动没有任何事件时 current 是 null（不编一个"空闲"对象）', () => {
      const { bus } = mkBus()
      expect(bus.getCurrent()).toBeNull()
    })

    it('🔴 工作台级 activity 推进快照，kind 取自 workbench 字段', () => {
      const { bus, at } = mkBus()
      bus.publish({ type: 'activity', message: '正在找字幕：甲剧（8 个文件）', title: '甲剧', workbench: 'subtitle' })
      expect(bus.getCurrent()).toEqual(cur({ kind: 'subtitle', title: '甲剧', startedAt: at() }))
    })

    it('🔴 progress 的 data.done/total 落进 index/total', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'progress', message: '第 3/47 个作品', title: '甲剧', workbench: 'subtitle', data: { done: 3, total: 47 } })
      expect(bus.getCurrent()).toEqual(cur({ kind: 'subtitle', title: '甲剧', index: 3, total: 47 }))
    })

    it('🔴 三个工作台的 kind 都能落进去（后来者覆盖，快照只有一个当前态）', () => {
      const { bus, at } = mkBus()
      bus.publish({ type: 'activity', message: 'a', title: '甲', workbench: 'identify' })
      expect(bus.getCurrent()?.kind).toBe('identify')
      bus.publish({ type: 'activity', message: 'b', title: '乙', workbench: 'subtitle' })
      expect(bus.getCurrent()?.kind).toBe('subtitle')
      bus.publish({ type: 'activity', message: 'c', title: '丙', workbench: 'translate' })
      expect(bus.getCurrent()).toEqual(cur({ kind: 'translate', title: '丙', startedAt: at() }))
    })

    it('🔴 新作品的 activity 把上一个作品的 index/total 清掉（病 B：不许拿甲的进度描述乙）', () => {
      const { bus, at } = mkBus()
      bus.publish({ type: 'progress', message: 'p', title: '甲剧', workbench: 'subtitle', data: { done: 3, total: 47 } })
      bus.publish({ type: 'activity', message: '正在翻译：乙剧', title: '乙剧', workbench: 'translate' })
      expect(bus.getCurrent()).toEqual(cur({ kind: 'translate', title: '乙剧', startedAt: at() }))
    })

    it('🔴 事件没带 title → title 是 null，不编一个也不留上一条的', () => {
      const { bus, at } = mkBus()
      bus.publish({ type: 'activity', message: 'a', title: '甲剧', workbench: 'subtitle' })
      bus.publish({ type: 'activity', message: 'b', workbench: 'subtitle' })
      expect(bus.getCurrent()).toEqual(cur({ kind: 'subtitle', title: null, startedAt: at() }))
    })

    it('🔴 progress 缺 data / data 里不是数字 → index/total 记 null，不 NaN 不强转', () => {
      const { bus, tick } = mkBus()
      bus.publish({ type: 'progress', message: 'p', title: '甲', workbench: 'subtitle' })
      expect(bus.getCurrent()).toEqual(cur({ kind: 'subtitle', title: '甲' }))
      tick(PROGRESS_THROTTLE_MS)
      bus.publish({ type: 'progress', message: 'p', title: '甲', workbench: 'subtitle', data: { done: '3', total: null } })
      expect(bus.getCurrent()).toEqual(cur({ kind: 'subtitle', title: '甲' }))
    })

    it('🔴 巡检完成清空 current（F-6 本体：跑完了不许还停在"正在处理 X"）', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'activity', message: '正在找字幕：甲剧', title: '甲剧', workbench: 'subtitle' })
      expect(bus.getCurrent()).not.toBeNull()
      bus.publish({ type: 'activity', message: '巡检完成，歇着等明天' })
      expect(bus.getCurrent()).toBeNull()
    })

    it('🔴 巡检失败（无 workbench 的 health）同样清空——失败也是"没在跑了"', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'activity', message: '正在翻译：甲', title: '甲', workbench: 'translate' })
      bus.publish({ type: 'health', message: '巡检失败，30 分钟后重试: boom' })
      expect(bus.getCurrent()).toBeNull()
    })

    it('🔴 巡检开始也清空（上一轮的残留不许跨轮活到下一轮）', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'activity', message: '正在识别：/x', title: '/x', workbench: 'identify' })
      bus.publish({ type: 'activity', message: '巡检开始' })
      expect(bus.getCurrent()).toBeNull()
    })

    it('🔴 扫描级 health（无 workbench）不污染 current：清空而不是写成 identify', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'activity', message: '正在识别：/x', title: '/x', workbench: 'identify' })
      bus.publish({ type: 'health', message: '守备目录读取失败，本轮跳过（1）: /mnt/a' })
      expect(bus.getCurrent()).toBeNull()
    })

    it('🔴 found 既不推进也不清空 current（成果 ≠ 状态）', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'progress', message: 'p', title: '甲剧', workbench: 'subtitle', data: { done: 3, total: 47 } })
      const before = bus.getCurrent()
      bus.publish({ type: 'found', message: '甲剧：装上了 3 条字幕', title: '甲剧', workbench: 'subtitle', data: { installed: 3 } })
      expect(bus.getCurrent()).toEqual(before)
      expect(bus.getCurrent()).toEqual(cur({ kind: 'subtitle', title: '甲剧', index: 3, total: 47 }))
    })

    it('🔴 被节流折叠掉的 progress 仍然推进 current（快照不跟着推送带宽一起丢）', () => {
      const { bus } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'progress', message: 'p1', title: '甲', workbench: 'subtitle', data: { done: 1, total: 47 } })
      bus.publish({ type: 'progress', message: 'p2', title: '甲', workbench: 'subtitle', data: { done: 2, total: 47 } })
      bus.publish({ type: 'progress', message: 'p3', title: '甲', workbench: 'subtitle', data: { done: 3, total: 47 } })
      // 推送侧只出 1 条（节流不变）
      expect(got.map((e) => e.message)).toEqual(['p1'])
      // 快照侧是最新的第 3 个——这正是"断线期间丢事件"不再致命的那一半
      expect(bus.getCurrent()?.index).toBe(3)
    })

    it('🔴 getCurrent 返回副本：调用方改它不许改到总线内部状态', () => {
      const { bus, at } = mkBus()
      bus.publish({ type: 'activity', message: 'a', title: '甲', workbench: 'subtitle' })
      const snap = bus.getCurrent()
      expect(snap).not.toBeNull()
      snap!.title = '被篡改'
      snap!.index = 999
      expect(bus.getCurrent()).toEqual(cur({ kind: 'subtitle', title: '甲', startedAt: at() }))
    })

    it('🔴 时钟抛错（publish 整体被兜住）时 current 也不许把异常抛回巡检', () => {
      const bus = new ScoutEventBus({ now: () => { throw new Error('clock dead') } })
      expect(() => bus.publish({ type: 'activity', message: 'a', title: '甲', workbench: 'subtitle' })).not.toThrow()
      expect(() => bus.getCurrent()).not.toThrow()
    })

    it('🔴 订阅者抛错不影响 current 已经推进（快照在广播之前就定了）', () => {
      const { bus, at } = mkBus()
      bus.subscribe(() => { throw new Error('dead SSE') })
      bus.publish({ type: 'activity', message: 'a', title: '甲', workbench: 'subtitle' })
      expect(bus.getCurrent()).toEqual(cur({ kind: 'subtitle', title: '甲', startedAt: at() }))
    })

    it('🔴 activity 写入 workId/backdropPath/chineseTitle/startedAt，lastStep 为 null', () => {
      const { bus, at } = mkBus()
      bus.publish({
        type: 'activity', message: 'a', title: '甲剧', workbench: 'subtitle',
        data: { workId: 'tmdb:1', backdropPath: '/bd.jpg', chineseTitle: '黑暗智宅' },
      })
      expect(bus.getCurrent()).toEqual(cur({
        kind: 'subtitle', title: '甲剧',
        workId: 'tmdb:1', backdropPath: '/bd.jpg', chineseTitle: '黑暗智宅',
        startedAt: at(),
      }))
    })

    it('🔴 progress 更新 done/total 与 lastStep；静态字段缺席时保留', () => {
      const { bus, tick } = mkBus()
      bus.publish({
        type: 'activity', message: 'a', title: '甲剧', workbench: 'subtitle',
        data: { workId: 'tmdb:1', backdropPath: '/bd.jpg', chineseTitle: '中文' },
      })
      tick(PROGRESS_THROTTLE_MS)
      bus.publish({
        type: 'progress', message: 'p', title: '甲剧', workbench: 'subtitle',
        data: { done: 2, total: 6, step: 'search_source' },
      })
      const snap = bus.getCurrent()
      expect(snap?.index).toBe(2)
      expect(snap?.total).toBe(6)
      expect(snap?.workId).toBe('tmdb:1')
      expect(snap?.backdropPath).toBe('/bd.jpg')
      expect(snap?.chineseTitle).toBe('中文')
      expect(snap?.lastStep).toBe('search_source')
    })

    it('🔴 progress data 里的 workId/backdropPath/chineseTitle 覆盖；缺席才保留', () => {
      const { bus, tick } = mkBus()
      bus.publish({ type: 'activity', message: 'a', title: '甲', workbench: 'subtitle', data: { workId: 'tmdb:1' } })
      tick(PROGRESS_THROTTLE_MS)
      bus.publish({
        type: 'progress', message: 'p', title: '甲', workbench: 'subtitle',
        data: { done: 0, total: 6, workId: 'tmdb:1', backdropPath: '/bd.jpg', chineseTitle: '中文' },
      })
      expect(bus.getCurrent()?.backdropPath).toBe('/bd.jpg')
      expect(bus.getCurrent()?.chineseTitle).toBe('中文')
    })

    it('🔴 progress-only 无先前 activity 也从 data 写入 workId', () => {
      const { bus } = mkBus()
      bus.publish({
        type: 'progress', message: 'p', title: '甲', workbench: 'subtitle',
        data: { done: 0, total: 6, workId: 'tmdb:1' },
      })
      expect(bus.getCurrent()?.workId).toBe('tmdb:1')
    })

    it('🔴 progress 无 step 时保留 lastStep 与 startedAt', () => {
      const { bus, tick, at } = mkBus()
      bus.publish({ type: 'activity', message: 'a', title: '甲', workbench: 'subtitle', data: { workId: 'tmdb:1' } })
      const started = at()
      tick(PROGRESS_THROTTLE_MS)
      bus.publish({ type: 'progress', message: 'p', title: '甲', workbench: 'subtitle', data: { done: 0, total: 6, step: 'search_source' } })
      tick(PROGRESS_THROTTLE_MS)
      bus.publish({ type: 'progress', message: 'p', title: '甲', workbench: 'subtitle', data: { done: 1, total: 6 } })
      expect(bus.getCurrent()?.lastStep).toBe('search_source')
      expect(bus.getCurrent()?.startedAt).toBe(started)
      expect(bus.getCurrent()?.index).toBe(1)
    })

    it('🔴 被节流折叠的 progress 仍更新 lastStep（快照在节流门前）', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'progress', message: '1', workbench: 'subtitle', data: { done: 0, total: 6, step: 'search_source' } })
      bus.publish({ type: 'progress', message: '2', workbench: 'subtitle', data: { done: 0, total: 6, step: 'download_candidate' } })
      expect(bus.getCurrent()?.lastStep).toBe('download_candidate')
    })

    it('🔴 无 workbench 的 activity 清空含新字段的整个 current', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'activity', message: 'a', title: '甲', workbench: 'subtitle', data: { workId: 'tmdb:1' } })
      bus.publish({ type: 'activity', message: '巡检完成' })
      expect(bus.getCurrent()).toBeNull()
    })
  })

  // ── milestone 帧旁路节流 + 每帧带 targets 快照（修首屏中途打开覆盖格建不起来·live 实测）──
  // 里程碑帧（开工/装盘/收尾，同一毫秒的密集 tick）靠**显式 `data.milestone === true`** 旁路
  // 1s/per-workbench 节流、且不占用节流窗口；被折叠掉覆盖格就永远停在 0/N。
  //
  // ⚠️ 判据从"带 targets 是否在场"改成"带 milestone"：现在**每条** progress 帧都带 targets
  // 当前快照（含高频的 trace 桥接帧），好让 replay 缓冲里任意一条都能重建 current.targets。
  // 若仍拿"带 targets = 旁路"，每帧旁路 = 节流失效、SSE 刷屏。故带 targets 但无 milestone 的
  // 帧照旧走节流（被 1s 折叠），只是它的 targets 快照仍在节流门之前落进 current。
  describe('🔴 milestone 帧旁路节流 + 每帧带 targets 快照（修中途打开覆盖格建不起来）', () => {
    it('🔴 带 milestone 的 progress 不被节流（里程碑帧必达）', () => {
      const { bus } = mkBus()
      const { got } = collect(bus)
      // 同一时刻连发：第一条纯 ticker 放行，第二条纯 ticker 被节流吃
      bus.publish({ type: 'progress', message: 's1', workbench: 'subtitle', data: { step: 'search_source' } })
      bus.publish({ type: 'progress', message: 's2', workbench: 'subtitle', data: { step: 'get_candidate' } })
      // 第三条带 milestone（里程碑）：必达，不被节流
      bus.publish({ type: 'progress', message: 'm', workbench: 'subtitle', data: { milestone: true, targets: [{ key: 's1e1', label: 'S01E01', state: 'installed' }] } })
      expect(got.filter((e) => (e.data as any)?.milestone).length).toBe(1)
      expect(got.filter((e) => (e.data as any)?.step && !(e.data as any)?.milestone).length).toBe(1) // 只第一条纯 ticker 过
    })

    it('🔴 里程碑帧旁路节流但不占用节流窗口（不顶掉纯 ticker 的记账）', () => {
      const { bus, tick } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'progress', message: 't1', workbench: 'subtitle', data: { step: 'a' } })  // t=0 放行，窗口起点=0
      tick(500)
      // 里程碑放行，但若它（错误地）把 lastProgressAt 记到 t=500，t2 就会被误折叠
      bus.publish({ type: 'progress', message: 'm', workbench: 'subtitle', data: { milestone: true, targets: [{ key: 'k', label: 'L', state: 'installed' }] } })
      tick(700)  // 距 t1 放行整 1200ms ≥ 1000 → t2 本该放行
      bus.publish({ type: 'progress', message: 't2', workbench: 'subtitle', data: { step: 'b' } })
      expect(got.map((e) => e.message)).toEqual(['t1', 'm', 't2'])
    })

    it('🔴 带 targets 但无 milestone 的 progress 走节流（被 1s 折叠），但仍更新 current.targets 快照', () => {
      // 这正是 trace 桥接帧的形态：每条都带 targets 当前快照，却**不带 milestone**——它必须
      // 仍受 1s 节流约束（否则 trace 帧洪流刷屏），同时它的快照落进 current，让 replay 缓冲里
      // 任意一条 trace 帧都足以重建覆盖格。这一条把「带 targets ≠ 旁路节流」钉死。
      const { bus } = mkBus()
      const { got } = collect(bus)
      bus.publish({ type: 'progress', message: 'p1', workbench: 'subtitle', data: { step: 'a', targets: [{ key: 'k', label: 'L', state: 'pending' }] } })
      bus.publish({ type: 'progress', message: 'p2', workbench: 'subtitle', data: { step: 'b', targets: [{ key: 'k', label: 'L', state: 'active' }] } })  // 同毫秒 → 被折叠
      // 推送侧只出 1 条（节流未因带 targets 而失效）
      expect(got.map((e) => e.message)).toEqual(['p1'])
      // 快照侧仍是最新的第二帧 targets（快照在节流门之前推进）——这是 replay 可重建的地基
      expect(bus.getCurrent()?.targets?.[0]?.state).toBe('active')
    })

    it('🔴 updateCurrent 把 targets 落进快照（重连可恢复）', () => {
      const { bus } = mkBus()
      bus.publish({ type: 'progress', message: 'x', workbench: 'subtitle', data: { targets: [{ key: 's1e1', label: 'S01E01', state: 'installed' }] } })
      expect(bus.getCurrent()?.targets?.[0]?.state).toBe('installed')
    })

    it('🔴 targets 在同工作台缺席时保留上一条、跨台归 undefined', () => {
      const { bus, tick } = mkBus()
      bus.publish({ type: 'progress', message: 'm', workbench: 'subtitle', data: { milestone: true, targets: [{ key: 'k', label: 'L', state: 'installed' }] } })
      tick(PROGRESS_THROTTLE_MS)
      bus.publish({ type: 'progress', message: 'p', workbench: 'subtitle', data: { done: 1, total: 2 } })  // 缺 targets，同台 → 保留
      expect(bus.getCurrent()?.targets?.[0]?.state).toBe('installed')
      bus.publish({ type: 'progress', message: 'q', workbench: 'translate', data: { done: 0, total: 3 } })  // 跨台 → undefined
      expect(bus.getCurrent()?.targets).toBeUndefined()
    })
  })
})
