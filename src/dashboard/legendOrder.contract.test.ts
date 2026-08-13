// src/dashboard/legendOrder.contract.test.ts —— T2-b：前端图例顺序 ≡ 后端聚合优先级顺序。
//
// ── 钉的是哪条约定 ────────────────────────────────────────────────────────────
// `web/src/media/episodeStateMeta.ts` 的 `LEGEND_STATES` 顺序必须与后端
// `src/dashboard/mediaLibraryApi.ts` 的 `STATE_RANK` **逐位相同**。
// 语义：图例顺序 = 聚合优先级顺序——用户在图例里看到的先后，就是同一格多份文件时
// 谁代表这一格的先后。两边分叉时，图例会把一个"其实垫底"的态画在"最优先"的位置，
// 用户据此形成的心智模型与系统实际行为相反，且界面上没有任何异常可见。
//
// ── 🔴 这条约定里最硬的一位：`extra` 必须垫底 ──────────────────────────────────
// 2026-08-13 审计抓到的真故障：`extra` 曾排在 STATE_RANK 第 4 档（"已解决"段）。
// 后果是「一个 Trailer 让正片从界面消失」——同一格里一份 PV（skip_reason='extra'）
// 加一份真需要字幕的正片（needs_subtitle=1），聚合报 'extra'，界面说「特典 · 不找字幕」，
// 而那份正在排队的正片被完全盖掉；电影分支尤其危险（aggregateDot 把一部电影的全部文件
// 聚成一格，一个 Trailer.mkv 就能让正片从界面上消失）。
// 后端侧那条已由 mediaLibraryApi.test.ts 的四条用例钉死（造真数据验聚合结论）。
// **前端图例这一侧此前没有任何东西钉着**——实测（2026-08-14，本条收敛前）：
// 把 LEGEND_STATES 里的 extra 挪回第 4 档，`cd web && npx tsc --noEmit` 退出码 0、
// 前端 975 条用例全绿。也就是说那个已修的 🔴 可以在图例上原样复发而无人察觉。
//
// ── 为什么这条测试在**后端**套件里 ────────────────────────────────────────────
// 它要同时读两侧的**值**。前端 vitest 跑在 jsdom + web/tsconfig 的 types 白名单下
// （只放 vitest/globals 与 jest-dom，node:fs 会破白名单，见 web/vitest.config.ts 的记载），
// 而后端套件本来就能 import 到 `web/src/...`（实测可用）。
//
// ── 它与编译期契约是**两条腿**，不是重复 ─────────────────────────────────────
// `web/src/api/typeContract.ts` 的 `C_LegendOrder` 在 `cd web && npx tsc --noEmit` 里
// 对拍同一件事。两者抓的漏网形态不同，缺一条都留洞：
//   · 编译期那条依赖两侧都是 `as const` 定长元组。有人把任一侧的 `as const` 删掉、
//     或加一个 `as readonly EpisodeState[]` 断言，位置信息就没了，契约**静默变成恒真**
//     ——本仓抓到过三种同型假守卫（`as` 断言 / `Object.fromEntries` / `_Missing[] = []`）。
//     下面 §2 专门盯这个退化。
//   · 运行时这条（§1）不依赖类型，读的是真实的数组值，`as const` 被删也照样说话。
//     但它管不到"两侧类型面漂移"，那是编译期那条的活。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LEGEND_STATES } from '../../web/src/media/episodeStateMeta.js'
import { EPISODE_STATE_LABEL } from '../../web/src/media/episodeStateMeta.js'
import { STATE_RANK_FOR_CONTRACT } from './mediaLibraryApi.js'

const META_PATH = fileURLToPath(new URL('../../web/src/media/episodeStateMeta.ts', import.meta.url))
const API_PATH = fileURLToPath(new URL('./mediaLibraryApi.ts', import.meta.url))
const CONTRACT_PATH = fileURLToPath(new URL('../../web/src/api/typeContract.ts', import.meta.url))

// ══════════════════════════════════════════════════════════════════════════════
// §1 值层面：逐位相同
// ══════════════════════════════════════════════════════════════════════════════
describe('T2-b 图例顺序 ≡ 聚合优先级顺序（值层面）', () => {
  it('🔴 LEGEND_STATES 与 STATE_RANK 逐位相同（不是"集合相等"）', () => {
    // toEqual 在数组上是**有序**比较——这正是这条要的。既有的
    // legacyIsolation.test.ts 那条用的是 `[...LEGEND_STATES].sort()`，
    // 它锁的是集合相等，对重排完全免疫（那条有它自己的用途：图例覆盖了所有染色态）。
    expect(LEGEND_STATES).toEqual([...STATE_RANK_FOR_CONTRACT])
  })

  it("🔴 `extra` 在两侧都**垫底**（2026-08-13 那个 🔴 的专项锁）", () => {
    // 与上一条不是重复：上一条锁"两侧一致"，两侧**同时**把 extra 挪到第 4 档时它照样绿。
    // 这一条锁的是那个绝对位置本身——它有独立的产品理由（extra 说的是"这一份不算数"，
    // 不是"这一格不用管"，故只有全部文件都是 extra 时才报 extra；把它排进已解决段
    // 会让一个 Trailer 盖掉同格里真正在排队的正片）。
    expect(STATE_RANK_FOR_CONTRACT[STATE_RANK_FOR_CONTRACT.length - 1]).toBe('extra')
    expect(LEGEND_STATES[LEGEND_STATES.length - 1]).toBe('extra')
    // 正面钉死「已解决段」的三个成员，防"把 extra 留在末位但把别的态挪进已解决段"。
    expect([...STATE_RANK_FOR_CONTRACT].slice(0, 3)).toEqual(['covered', 'origin-skip', 'embedded'])
  })

  it('🔴 自检：两个常量都不是空数组 / 都是八个染色态（防空转假绿）', () => {
    // 没有这一条，①在"两侧都被清空"时会以 [] === [] 的方式假绿。
    expect(STATE_RANK_FOR_CONTRACT).toHaveLength(8)
    expect(LEGEND_STATES).toHaveLength(8)
    // absent 不在图例里（它是边框维度不是颜色维度），也不在聚合序里（零文件才有它）。
    expect(LEGEND_STATES as readonly string[]).not.toContain('absent')
    expect(STATE_RANK_FOR_CONTRACT as readonly string[]).not.toContain('absent')
    // 每一个都有文案键——顺序对上了但态本身是错的，这里会红。
    for (const s of LEGEND_STATES) expect(EPISODE_STATE_LABEL[s]).toBeTruthy()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// §2 编译期契约的**防退化**守卫
// ══════════════════════════════════════════════════════════════════════════════
//
// 本仓铁律：vitest 不查类型。所以编译期那条契约（typeContract.ts 的 C_LegendOrder）
// 有没有真的在说话，测试是看不见的——它只有在 `cd web && npx tsc --noEmit` 里才生效。
// 而它生效的**前提**是两侧都保留 `as const`（定长元组）。前提被无声拆掉时，
// tsc 依然退出 0，契约从此不保护任何东西。
//
// 这三条断言盯着那个前提本身。它们是文本断言——比对类型系统更弱，但这正是
// "钉住一个编译期机制的存在"唯一能在运行时做的事。
describe('T2-b 编译期契约没有被静默拆掉', () => {
  it('🔴 后端 STATE_RANK 仍是 `as const`（丢了它，元组退化成数组，位置信息消失）', () => {
    const src = readFileSync(API_PATH, 'utf8')
    expect(src).toMatch(/\]\s*as const satisfies readonly Exclude<EpisodeState, 'absent'>\[\]/)
    // 元组类型确实被导出（契约的后端一侧凭据）
    expect(src).toMatch(/export type StateRankOrder = typeof STATE_RANK/)
  })

  it('🔴 前端 LEGEND_STATES 仍是 `as const`（此前它是 `readonly Exclude<...>[]`——位置信息全丢）', () => {
    const src = readFileSync(META_PATH, 'utf8')
    // 收敛前的写法：`export const LEGEND_STATES: readonly Exclude<EpisodeState, 'absent'>[] = [`
    // 那个**类型标注**会把 as const 推出来的元组当场拓宽回数组，契约必然恒真。
    // 所以这里不仅要求有 as const，还要求**没有**那条会压掉它的标注。
    expect(src).toMatch(/export const LEGEND_STATES = \[/)
    expect(src).toMatch(/\]\s*as const satisfies readonly Exclude<EpisodeState, 'absent'>\[\]/)
    expect(src).not.toMatch(/export const LEGEND_STATES\s*:/)
  })

  it('🔴 typeContract.ts 里那条对拍还在（删了它，两侧就只剩 §1 一条腿）', () => {
    const src = readFileSync(CONTRACT_PATH, 'utf8')
    expect(src).toContain('C_LegendOrder')
    // 断言它用的是**双向逐位**的 SameOrder，不是 Satisfies——后者对重排免疫
    // （两个同成员不同序的元组，联合层面互相 assignable）。
    expect(src).toMatch(/type SameOrder</)
    expect(src).toMatch(/Assert<SameOrder<[^>]*BeMediaLibrary\.StateRankOrder/)
  })
})
