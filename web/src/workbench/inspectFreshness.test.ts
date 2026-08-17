// web/src/workbench/inspectFreshness.test.ts —— 两条既有债务的处理守卫。
//
// 债务一：`lastInspectAt` 落的是巡检**开始**时刻不是完成时刻（Task ⑤ 审计 🟡-3，后端未修）
// 债务二：陈旧门（48h）覆盖不到"daemon 死了"，横幅会报绿 48 小时（任务书点名）
//
// 两条都是**语义**缺陷：字段值本身没错，错的是"照字面渲染就是在说一句半真的话"。
// 故这里测的全是"在什么前提下允许说什么话"。
import { describe, it, expect } from 'vitest'
import { inspectFreshness, relAgo, relUntilLabel, msUntilNextInspect, workPermission, STALE_AFTER_MS } from './inspectFreshness.js'

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** 只给这个模块用得到的两个字段。 */
const h = (lastInspectAt: number | null, current: unknown | null = null) => ({ lastInspectAt, current })

describe('inspectFreshness：巡检的四态', () => {
  it('lastInspectAt 为 null → "never"（冷启动），msSinceStart 也是 null', () => {
    expect(inspectFreshness(h(null), NOW)).toEqual({ phase: 'never', msSinceStart: null })
  })

  // 🔴 设计文档 §3.5 点名：全新部署时这个值是空的，绝不能渲染成「上次巡检：1970-01-01」。
  it('🔴 冷启动**不许**回落成 0 再算差值（那会算出 56 年的陈旧 → 把新部署报成死了）', () => {
    const f = inspectFreshness(h(null), NOW)
    expect(f.phase).not.toBe('stale')
    expect(f.msSinceStart).toBeNull()
  })

  it('刚跑过、当前空闲 → "idle"', () => {
    expect(inspectFreshness(h(NOW - HOUR), NOW)).toEqual({ phase: 'idle', msSinceStart: HOUR })
  })

  // 🔴 债务一：正在跑 10 小时大库时，lastInspectAt 就是会很旧——它旧得有正当理由。
  it('🔴 有工作台在跑 → "running"，**即使那个时刻已经很旧**（债务一：那是开始时刻）', () => {
    const veryOld = NOW - 10 * HOUR
    // 同一个时刻：空闲时是 idle/stale，在跑时必须是 running。
    expect(inspectFreshness(h(veryOld, null), NOW).phase).toBe('idle')
    expect(inspectFreshness(h(veryOld, { kind: 'subtitle' }), NOW).phase).toBe('running')
  })

  it('🔴 在跑判定优先于陈旧判定——跑了 3 天的大库不许被报成"daemon 没在跑"', () => {
    const threeDaysAgo = NOW - 3 * DAY
    expect(inspectFreshness(h(threeDaysAgo, null), NOW).phase).toBe('stale')
    // 同样陈旧，但有工作台在跑 → 它显然活着。把最忙的时刻误判成死亡是债务一的镜像版。
    expect(inspectFreshness(h(threeDaysAgo, { kind: 'translate' }), NOW).phase).toBe('running')
  })

  // 🔴 债务二：这一档就是陈旧门（48h 报绿）覆盖不到的那个。
  it('🔴 空闲且超过 1.5 个巡检周期 → "stale"（daemon 可能没在跑）', () => {
    expect(inspectFreshness(h(NOW - STALE_AFTER_MS - 1), NOW).phase).toBe('stale')
  })

  it('阈值边界：恰好等于阈值仍是 idle，超过一毫秒才 stale（严格大于）', () => {
    expect(inspectFreshness(h(NOW - STALE_AFTER_MS), NOW).phase).toBe('idle')
    expect(inspectFreshness(h(NOW - STALE_AFTER_MS - 1), NOW).phase).toBe('stale')
  })

  it('🔴 阈值是 1.5 个周期——一整天没动是正常节奏，不许报死', () => {
    // 取 1 个周期会让"昨天 04:00 开始、今天 04:00 还没轮到下一轮"这种完全正常的节奏
    // 被误报成死亡（且巡检本身要跑几小时，lastInspectAt 记的又是开始时刻）。
    expect(inspectFreshness(h(NOW - DAY), NOW).phase).toBe('idle')
    expect(inspectFreshness(h(NOW - 25 * HOUR), NOW).phase).toBe('idle')
    // 而取 2 个周期（48h）就和那个报绿的陈旧门一样迟钝，等于没修。
    expect(STALE_AFTER_MS).toBeLessThan(2 * DAY)
    expect(inspectFreshness(h(NOW - 40 * HOUR), NOW).phase).toBe('stale')
  })

  it('msSinceStart 的语义是「距**开始**多久」——字段名不许被理解成"距完成"', () => {
    // 这条守的是语义而非行为：值就是 now - lastInspectAt，而 lastInspectAt 是开始时刻。
    expect(inspectFreshness(h(NOW - 5 * HOUR), NOW).msSinceStart).toBe(5 * HOUR)
  })

  it('时钟回拨（lastInspectAt 在未来）→ 不崩、不 stale（负差值不是陈旧）', () => {
    const f = inspectFreshness(h(NOW + HOUR), NOW)
    expect(f.phase).toBe('idle')
    expect(relAgo(f.msSinceStart!)).toBe('0s')
  })
})

describe('relUntilLabel：与 relAgoLabel 同一套粒度，方向是「后」', () => {
  it('zh 18h 含「小时后」，不含「小时前」', () => {
    expect(relUntilLabel(18 * HOUR, 'zh')).toContain('小时后')
    expect(relUntilLabel(18 * HOUR, 'zh')).not.toContain('小时前')
  })

  it('en 18h 仍是短单位 18h', () => {
    expect(relUntilLabel(18 * HOUR, 'en')).toBe('18h')
  })

  it('delta<=0 返回空串（即将开始由 StatusBar 用 wb_inspect_soon，不在这里另造一句）', () => {
    expect(relUntilLabel(0, 'zh')).toBe('')
    expect(relUntilLabel(-1, 'en')).toBe('')
  })
})

describe('msUntilNextInspect：优先后端 nextInspectAt，缺了才回落 lastInspectAt + 周期', () => {
  it('有 nextInspectAt 就用它（不手算 24h）', () => {
    expect(msUntilNextInspect({ nextInspectAt: NOW + 18 * HOUR, lastInspectAt: NOW - HOUR }, NOW))
      .toBe(18 * HOUR)
  })

  it('nextInspectAt 缺席时回落 lastInspectAt + 24h', () => {
    expect(msUntilNextInspect({ nextInspectAt: null, lastInspectAt: NOW - HOUR }, NOW))
      .toBe(23 * HOUR)
  })

  it('已过点仍 idle → 夹到 0（即将开始）', () => {
    expect(msUntilNextInspect({ nextInspectAt: NOW - HOUR, lastInspectAt: NOW - 25 * HOUR }, NOW))
      .toBe(0)
  })
})

describe('relAgo：与顶栏新鲜度行同一套粒度', () => {
  it('s / m / h / d 四档', () => {
    expect(relAgo(5_000)).toBe('5s')
    expect(relAgo(5 * 60_000)).toBe('5m')
    expect(relAgo(5 * HOUR)).toBe('5h')
    expect(relAgo(5 * DAY)).toBe('5d')
  })

  it('负数夹到 0（"-3h ago" 只会让人以为界面坏了）', () => {
    expect(relAgo(-1)).toBe('0s')
    expect(relAgo(-99 * HOUR)).toBe('0s')
  })

  it('边界：59s→"59s"、60s→"1m"、59m→"59m"、60m→"1h"、23h→"23h"、24h→"1d"', () => {
    expect(relAgo(59_000)).toBe('59s')
    expect(relAgo(60_000)).toBe('1m')
    expect(relAgo(59 * 60_000)).toBe('59m')
    expect(relAgo(60 * 60_000)).toBe('1h')
    expect(relAgo(23 * HOUR)).toBe('23h')
    expect(relAgo(DAY)).toBe('1d')
  })
})

describe('workPermission：读 workPermitted 而不是 engineEnabled', () => {
  // 🔴 任务书要我论证并执行的那条。
  it('🔴 开关开着但凭据没配 → **不是** permitted（只看 engineEnabled 会说"引擎在跑"）', () => {
    // 这正是"为什么什么都没发生"最常见的答案：daemon 整轮跳过，而开关看起来是开的。
    expect(workPermission({ workPermitted: false, engineEnabled: true, setupSatisfied: false }))
      .toBe('setup-incomplete')
  })

  it('全都满足 → permitted', () => {
    expect(workPermission({ workPermitted: true, engineEnabled: true, setupSatisfied: true }))
      .toBe('permitted')
  })

  it('凭据齐但开关关了 → engine-off（可执行动作是"去打开它"）', () => {
    expect(workPermission({ workPermitted: false, engineEnabled: false, setupSatisfied: true }))
      .toBe('engine-off')
  })

  it('两个都不满足 → 先报 setup-incomplete（先开开关而凭据仍缺会是第二次徒劳）', () => {
    expect(workPermission({ workPermitted: false, engineEnabled: false, setupSatisfied: false }))
      .toBe('setup-incomplete')
  })

  it('🔴 三态可区分——两种不许可绝不折成同一句话（可执行动作不同）', () => {
    const offs = workPermission({ workPermitted: false, engineEnabled: false, setupSatisfied: true })
    const incomplete = workPermission({ workPermitted: false, engineEnabled: true, setupSatisfied: false })
    expect(offs).not.toBe(incomplete)
  })
})
