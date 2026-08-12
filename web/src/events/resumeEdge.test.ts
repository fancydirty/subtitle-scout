// web/src/events/resumeEdge.test.ts —— 「恢复边沿」判据的**穷尽**表。
//
// ── 为什么是穷尽表而不是几条样例 ────────────────────────────────────────────
// EventsStatus 是四态封闭集，`(was, next)` 只有 16 种组合。挑几条测的话，
// 漏掉的那几条正是将来会出错的那几条——审计抓到的 bug 本体
// （`connecting → open` 被误判成重连）就是"没人想到要测首连"造成的。
//
// 16 条全列出来，每条附一句**为什么**。加第五态时这张表会因为 CASES 数量不够而红
// （下面有一条自检用例数它），逼人把新态的 8 条（4 进 + 4 出）想清楚。
import { describe, it, expect } from 'vitest'
import { isResumeEdge } from './resumeEdge.js'
import type { EventsStatus } from './types.js'

const ALL: readonly EventsStatus[] = ['connecting', 'open', 'unavailable', 'retrying']

/** [was, next, 该不该拉, 为什么]。**16 条一条不少**。 */
const CASES: readonly [EventsStatus, EventsStatus, boolean, string][] = [
  // ── 目标态是 open：唯一可能是"恢复"的四条 ─────────────────────────────
  ['connecting', 'open', false,
    '🔴 首连。eventsBus 的初始状态就是 connecting，页面挂载期的 fetch 已经取过快照了——' +
    '判成重连就是每次挂载多打一次请求（审计探针数出来的那个 1 -> 2）'],
  ['retrying', 'open', true,
    '退避重连成功。断线期间的事件在 50 槽环形缓冲里可能已被冲掉，必须用快照纠正'],
  ['unavailable', 'open', true,
    '503 终态被另一条连接接手。中间那段完全没有事件流，比 retrying 断得更久'],
  ['open', 'open', false,
    'effect 首跑时的自等（setStatus 自带去重，真正的 open→open 不会派发）。' +
    '这同样是"页面刚挂上"，拉第二次又是一次重复请求'],

  // ── 目标态不是 open：一律不是恢复 ────────────────────────────────────
  // 掉线的那一刻**不该**拉：那时候连接都没有，拉回来的快照下一秒就又开始过期。
  ['open', 'retrying', false, '刚掉线，不是恢复'],
  ['open', 'unavailable', false, '刚判成 503 终态，不是恢复'],
  ['open', 'connecting', false, '重新订阅中，不是恢复'],
  ['connecting', 'retrying', false, '首连就失败了，不是恢复'],
  ['connecting', 'unavailable', false, '首连撞上 503，不是恢复'],
  ['connecting', 'connecting', false, '没变'],
  ['retrying', 'connecting', false, 'ensureConnected 重置，还没连上'],
  ['retrying', 'retrying', false, '还在退避'],
  ['retrying', 'unavailable', false, '重连时探到 503，不是恢复'],
  ['unavailable', 'connecting', false, '重新挂载后重连中，还没连上'],
  ['unavailable', 'retrying', false, '还在退避'],
  ['unavailable', 'unavailable', false, '没变'],
]

describe('🔴 恢复边沿：16 种状态跃迁的穷尽表', () => {
  it.each(CASES)('%s → %s ⇒ %s（%s）', (was, next, want) => {
    expect(isResumeEdge(was, next)).toBe(want)
  })

  // 防空转：一张只有 false 的表被"永远返回 false"的实现全绿。
  it('⭐ 阳性对照：表里既有该拉的也有不该拉的（不是恒真/恒假命题）', () => {
    expect(CASES.filter((c) => c[2]).length, '表里一条"该拉"都没有——判据恒假也会全绿')
      .toBeGreaterThan(0)
    expect(CASES.filter((c) => !c[2]).length).toBeGreaterThan(0)
  })

  it('🔴 表真的穷尽了 4×4=16 种组合（加第五态时这条会红，逼人补齐新态的 8 条）', () => {
    const seen = new Set(CASES.map(([a, b]) => `${a}>${b}`))
    expect(seen.size, '表里有重复行').toBe(CASES.length)
    const missing: string[] = []
    for (const a of ALL) for (const b of ALL) {
      if (!seen.has(`${a}>${b}`)) missing.push(`${a}>${b}`)
    }
    expect(missing, `EventsStatus 变了但这张表没跟上，缺：${missing.join(', ')}`).toEqual([])
    expect(CASES.length).toBe(ALL.length * ALL.length)
  })

  // 🔴 这一条独立于上面的表，直接钉住审计报的那个缺陷形态。
  // 变异（把判据退回 `was !== 'open' && next === 'open'`）→ 上面 connecting→open 那行
  // 与这一条同时红。留着它是因为表格用例的失败信息是 "connecting → open ⇒ false"，
  // 而这一条的信息直接说出后果。
  it('🔴 首连不是重连——`connecting → open` 一次快照都不该多拉', () => {
    expect(
      isResumeEdge('connecting', 'open'),
      '把首连判成重连 → 每次挂载在首载 fetch 之外多打一次 /health 与 /activity',
    ).toBe(false)
  })
})
