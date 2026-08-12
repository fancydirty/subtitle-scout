// web/src/workbench/workbenchRouting.test.ts —— R-F1 的执行守卫（纯函数层）。
//
// ⚠️ 这个文件测的是**纯函数**，它证明不了"页面真的按这个分流渲染"。
// 那一半在 ActivityPage.test.tsx（渲染整页 + 数 DOM 里的卡片），两者缺一不可：
//  · 只有这里 → laneOf 判对了但没人调它（本仓栽过 6 次的"加了能力没定谁读"）
//  · 只有那里 → 分流逻辑散在组件里，每个组件各有一次漏判机会
import { describe, it, expect } from 'vitest'
import { laneOf, tabOf, workIdOf, ACTIVITY_TABS, type EventLane } from './workbenchRouting.js'
import type { ScoutEvent, ScoutWorkbench } from '../events/types.js'

/** 造一条最小事件。`workbench` 显式传 undefined 与不传是**同一件事**（巡检级）。 */
function ev(over: Partial<ScoutEvent> = {}): ScoutEvent {
  return { id: 1, at: 0, type: 'activity', message: 'm', ...over }
}

describe('laneOf：四条路（R-F1 的执行点）', () => {
  it('subtitle / translate → 各自的 tab', () => {
    expect(laneOf(ev({ workbench: 'subtitle' }))).toBe('subtitle')
    expect(laneOf(ev({ workbench: 'translate' }))).toBe('translate')
  })

  // 🔴 R-F1 的核心断言。
  it('🔴 identify → "identify" 那条路（顶部状态条），**绝不是** subtitle/translate', () => {
    const lane = laneOf(ev({ workbench: 'identify' }))
    expect(lane).toBe('identify')
    // 双向断言：不只是"等于 identify"，还要"不属于两个 tab 中任何一个"——
    // 前者在有人把 EventLane 改名时会红，后者才是 R-F1 的实质。
    expect(['subtitle', 'translate']).not.toContain(lane)
  })

  // 🔴 生产事实：daemonV2 有 6 个 emit 点不带 workbench（巡检开始/完成/失败 + 3 条扫描 health）。
  it('🔴 无 workbench → "patrol"（巡检级/扫描级），**不是**兜底到 identify', () => {
    expect(laneOf(ev())).toBe('patrol')
    expect(laneOf(ev({ workbench: undefined }))).toBe('patrol')
    // 后端两处头注释都单独警告过这条：写 `?? 'identify'` 会把「巡检开始」「守备目录读取
    // 失败」混进识别状态条，用户会看到「正在识别：守备目录读取失败」这种句子。
    expect(laneOf(ev({ message: '巡检开始' }))).not.toBe('identify')
    expect(laneOf(ev({ type: 'health', message: '守备目录读取失败，本轮跳过' }))).not.toBe('identify')
  })

  it('不看事件内容——只看 workbench（按 message 文案分流是把 UI 建在流沙上）', () => {
    // 同一条文案配不同 workbench → 去不同的路；同一个 workbench 配任意文案 → 同一条路。
    expect(laneOf(ev({ message: '正在识别：X', workbench: 'subtitle' }))).toBe('subtitle')
    expect(laneOf(ev({ message: '正在找字幕：X', workbench: 'identify' }))).toBe('identify')
    for (const m of ['正在找字幕：X', '巡检完成', '', '正在翻译：Y']) {
      expect(laneOf(ev({ message: m, workbench: 'subtitle' }))).toBe('subtitle')
    }
  })

  it('四类事件类型都走同一套分流（type 不参与判别）', () => {
    for (const type of ['activity', 'found', 'health', 'progress'] as const) {
      expect(laneOf(ev({ type, workbench: 'identify' }))).toBe('identify')
      expect(laneOf(ev({ type }))).toBe('patrol')
    }
  })

  it('值域封闭：三个 workbench 值 + undefined 穷尽了四条路，没有第五种结果', () => {
    const inputs: (ScoutWorkbench | undefined)[] = ['identify', 'subtitle', 'translate', undefined]
    const lanes = new Set<EventLane>(inputs.map((workbench) => laneOf(ev({ workbench }))))
    expect([...lanes].sort()).toEqual(['identify', 'patrol', 'subtitle', 'translate'])
  })
})

describe('tabOf：两个 tab 的唯一入口', () => {
  // 🔴 这一条就是 R-F1 在"要不要画进 tab"这个判断上的执行。
  it('🔴 identify 与无 workbench 都返回 null（**不属于任何 tab**）', () => {
    expect(tabOf(ev({ workbench: 'identify' }))).toBeNull()
    expect(tabOf(ev())).toBeNull()
  })

  it('subtitle / translate 返回自己那个 tab', () => {
    expect(tabOf(ev({ workbench: 'subtitle' }))).toBe('subtitle')
    expect(tabOf(ev({ workbench: 'translate' }))).toBe('translate')
  })

  it('tabOf 的返回值域 ⊆ ACTIVITY_TABS（不会给出一个不存在的 tab）', () => {
    for (const wb of ['identify', 'subtitle', 'translate', undefined] as const) {
      const tab = tabOf(ev({ workbench: wb }))
      if (tab !== null) expect(ACTIVITY_TABS).toContain(tab)
    }
  })

  it('🔴 ACTIVITY_TABS **恰好两个**，且顺序是「字幕、翻译」（R-F1 的类型级表达）', () => {
    // 有人想给识别开第三个 tab 的话，这条会红——而那正是 R-F1 禁止的。
    expect(ACTIVITY_TABS).toEqual(['subtitle', 'translate'])
    expect(ACTIVITY_TABS).not.toContain('identify')
  })
})

describe('workIdOf：取图用的作品 id', () => {
  it('data.workId 是非空字符串 → 原样给出', () => {
    expect(workIdOf(ev({ data: { workId: 'tmdb:1396' } }))).toBe('tmdb:1396')
  })

  it('缺席 / 空串 / 非字符串 → null（**不做 String() 强转**）', () => {
    expect(workIdOf(ev())).toBeNull()
    expect(workIdOf(ev({ data: {} }))).toBeNull()
    expect(workIdOf(ev({ data: { workId: '' } }))).toBeNull()
    expect(workIdOf(ev({ data: { workId: 42 } }))).toBeNull()
    expect(workIdOf(ev({ data: { workId: null } }))).toBeNull()
    // 强转的后果：拿 'undefined' 这个字符串去查图表，静默查不到再降级，
    // 而排查时那个字符串会让人以为后端发了脏值。
    expect(workIdOf(ev({ data: { workId: undefined } }))).toBeNull()
  })

  it('与 done/total 共存（progress 的三个键互不干扰）', () => {
    const e = ev({ type: 'progress', data: { done: 3, total: 8, workId: 'tmdb:1' } })
    expect(workIdOf(e)).toBe('tmdb:1')
    expect(e.data!.done).toBe(3)
    expect(e.data!.total).toBe(8)
  })
})
