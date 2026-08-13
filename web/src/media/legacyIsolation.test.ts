// web/src/media/legacyIsolation.test.ts：任务书点名的债务①——**两套同名异义的状态枚举
// 必须隔离**的执行守卫。
//
// ── 背景 ────────────────────────────────────────────────────────────────
// `web/src/_legacy/library/episodeState.ts` 有一套七态 `EpisodeCellState`：
//   covered / hardsub / missing / throttled / error / dashed / partial
// 长在**旧** `episodes` 表上（经 LibraryOnDiskEpisodeDTO.subStatus）。
// 本目录用的是后端 mediaLibraryApi.ts 的八态 `EpisodeState`：
//   covered / translating / unsolvable / origin-skip / embedded / pending / unjudged / absent
// 长在**新** `files` 表的 sub_status/needs_subtitle/skip_reason 三列上。
//
// 裁决（完整论证见 episodeStateMeta.ts 头注释）：**新页面绝不复用旧的，一行都不 import**。
//
// ── 2026-08-12（Task ⑪）：旧页面移入 `_legacy/`，本守卫的路径断言跟着改 ──────────
// 旧 `library/` `workflow/` `activity/` 三个目录已 git mv 到 `web/src/_legacy/` 下。
// 本文件里所有写死的 `library/...` 路径**必须跟着改成 `_legacy/library/...`**，否则：
//  · 两条自检（VFS 里有旧模块 / 阳性对照走得到旧模块）会**变红** —— 这两条是好的，
//    它们吵闹地失败，等于提醒"该改路径了"。实测确实红了，本次就是被它们叫住的。
//  · 但最后那条目录级禁令 `m.startsWith('library/')` 会**静默变绿** —— 移走之后再没有
//    任何模块以 `library/` 开头，禁令恒真。这才是真正危险的一条：它不报错，只是从此
//    不再保护任何东西。任务书点名的"别让守卫静默失效"就是指它。
// 现在禁令改为 `_legacy/` 前缀，且**覆盖面反而变大**（原先只禁 library/ 一个目录，
// 现在把 workflow/ activity/ 一并禁掉——它们同样是下架页面，新页面在其上建依赖
// 会同样把 `_legacy` 删除卡死）。
//
// ── 这个文件的前身是装饰品，以下是它被推翻的经过 ────────────────────────────
// 旧版本花 18 行头注释论证自己"走 import 图 + 值层面集合运算"。**两句都是假的**：
// 它的 6 条断言全是 `NEW_STATES`（派生自 EPISODE_STATE_LABEL）与 `LEGACY_STATES`
// （**手抄的字符串字面量**）两个常量数组的集合运算——比对的是"两套枚举值域不同"这个
// **恒真的静态事实**，与"新页面有没有 import 旧文件"零相关。变异审计实测：让
// MediaDetailPage.tsx 真的 import 并调用 buildGridCells、把旧七态的值渲染进 DOM，
// **1045 条用例无一变红**。更讽刺的是那个文件**自己 import 了 buildGridCells**——
// 它连"import 图里不该出现旧模块"都做不了，因为它自己就在图里。
//
// ── 现在这个文件怎么做（真·import 图）──────────────────────────────────────
// `import.meta.glob(..., { query: '?raw', eager: true })` 把 src 下全部 .ts/.tsx 的
// **源文本**取进来（实测可用：episodeStateMeta.ts 取到 2329 字符真内容；⚠️ 注意 CSS 的
// `?raw` 在 vitest 里恒空串，那是 css:false 处理链的问题，.ts/.tsx 不受影响，见
// vitest.config.ts:11 记的那个坑），然后从两个入口出发**跟着相对路径 import 递归走闭包**，
// 断言闭包里不出现 `_legacy/`。
//
// 🔴 **本文件自己不在被检查的图里**：它只把源码当数据读，不 import 任何被测模块的实现。
// 这正是旧版本做不到的那件事。
//
// 🔴 **防空转**（这份守卫最容易退化成的样子：解析器坏掉 → 闭包为空 → 恒绿）：
//   · 断言闭包规模与已知成员（入口自身、EpisodeMark、episodeStateMeta、api/types 都得在）
//   · 断言**未解析的相对 specifier 数为 0**（解析器漏掉一条边 = 那条边后面的子树全逃检）
//   · **阳性对照**：从 _legacy/library/SeriesPage.tsx 出发走同一套解析器，必须**能**抓到
//     _legacy/library/episodeState.ts。抓不到就说明解析器根本不工作，此时禁令那条的"绿"无意义。
import { describe, it, expect } from 'vitest'
import { EPISODE_STATE_LABEL, LEGEND_STATES } from './episodeStateMeta.js'
import { en } from '../i18n/en.js'
import { zh } from '../i18n/zh.js'
import type { EpisodeState } from '../api/types.js'

// ── 2026-08-13：`web/src/_legacy/` 已整体删除，本文件的 import 图守卫随之退役 ──────
// 原先这里有一套「源码 VFS + 相对 import 递归闭包」的机器（约 100 行）和 6 条断言，
// 靶子是 `_legacy/` 目录。目录删干净后：
//   · 两条自检（VFS 里有旧模块 / 阳性对照走得到 _legacy/library/SeasonAccordion.tsx）
//     会**变红**——它们的断言对象已不存在。
//   · 那条目录级禁令 `m.startsWith('_legacy/')` 会**静默变绿**——再没有任何模块以
//     `_legacy/` 开头，禁令恒真，从此不保护任何东西。
// 这正是本文件头注释第 165-168 行**预先裁决过**的情形：「它哪天真被删干净了，该做的是
// 删掉整份守卫（使命完成），不是把断言改软」。故整套 import 图机器与 6 条断言一并删除，
// 而不是留一个恒真的壳。
//
// ⚠️ 保留下面的**语义**断言：它们测的是**活代码**（episodeStateMeta 的八态表、i18n 的
// media_state_* 文案），与 `_legacy` 无关，不该跟着走。
// ═══════════════════════════════════════════════════════════════════════════
// 以下是**语义**层面的隔离佐证：两套枚举即便被人接上也对不齐。
// ⚠️ 这些是常量集合运算，**不是** import 图检查——它们证明"两套不同"，
// 证明不了"没被 import"。后者由上面那组负责。此处不再声称它们有隔离效力。
// ═══════════════════════════════════════════════════════════════════════════

/** 新九态的**值**全集（从 EPISODE_STATE_LABEL 的键派生——那张表是穷尽 Record，
 *  少一个键 tsc 就红，所以它的键集合就是类型联合本身）。 */
const NEW_STATES = Object.keys(EPISODE_STATE_LABEL) as EpisodeState[]

describe('新九态 vs 旧七态：值域对不齐（语义佐证，非隔离守卫）', () => {
  it('新九态恰好九个，且就是后端 mediaLibraryApi.ts 的那九个', () => {
    // 'extra' 是 2026-08-13 用户裁决「特典都完全不算在找字幕的范围」加的第九态
    // （后端 skip_reason='extra'）。
    expect([...NEW_STATES].sort()).toEqual(
      ['absent', 'covered', 'embedded', 'extra', 'origin-skip', 'pending', 'translating', 'unjudged', 'unsolvable'],
    )
  })

  it('旧七态的 "missing" 在新九态里没有对应——它对应两个**语义相反**的态', () => {
    expect(NEW_STATES).not.toContain('missing')
    // 排队等找（还会来结果）与 判定无解（现在没辙）—— 设计文档 §4.3 点名要求两者视觉可分。
    expect(NEW_STATES).toContain('pending')
    expect(NEW_STATES).toContain('unsolvable')
  })

  it('文案键前缀分开（media_state_* vs library_legend_*）——改一个不会误改另一个', () => {
    for (const key of Object.values(EPISODE_STATE_LABEL)) {
      expect(key.startsWith('media_state_'), `${key} 不在 media_state_ 命名空间里`).toBe(true)
    }
    // 旧图例键还活着且不重名（它随 `_legacy` 最终删除时才走——那是独立裁决，见
    // 设计文档 §2.2「跑稳一个巡检周期后删」）
    expect(en.library_legend_covered).toBeTruthy()
    expect(en.library_legend_covered).not.toBe(en.media_state_covered)
  })
})

describe('九态文案表（穷尽 Record，漏一态 tsc 红）', () => {
  it('九个态在 en/zh 两侧都有真文案，且同侧内两两不同', () => {
    for (const [name, table] of [['en', en], ['zh', zh]] as const) {
      const values = NEW_STATES.map((s) => (table as Record<string, string>)[EPISODE_STATE_LABEL[s]])
      for (const [i, v] of values.entries()) {
        expect(v, `${name}.${EPISODE_STATE_LABEL[NEW_STATES[i]!]} 缺失`).toBeTruthy()
      }
      // 两个态共用一句文案 = 用户读到的信息里两者不可分（Carbon 双通道在文本通道上的同型失效）
      expect(new Set(values).size, `${name} 有两个态共用同一句文案`).toBe(NEW_STATES.length)
    }
  })

  it('unsolvable 的文案**不说"失败/放弃"**——它不是永久终态（复查闸每周放回一次）', () => {
    expect(en.media_state_unsolvable.toLowerCase()).not.toMatch(/fail|gave up|giving up|error/)
    expect(zh.media_state_unsolvable).not.toMatch(/失败|放弃|错误/)
    // 正面：必须传达"还会再试"
    expect(en.media_state_unsolvable.toLowerCase()).toContain('retry')
    expect(zh.media_state_unsolvable).toContain('再试')
  })

  it('图例列八个染色态，absent 不在其中（它是边框维度，不是颜色维度）', () => {
    expect(LEGEND_STATES).toHaveLength(8)
    expect(LEGEND_STATES as readonly string[]).not.toContain('absent')
    // 图例覆盖了除 absent 外的全部态——漏一个就是有格子的颜色无处可查
    expect([...LEGEND_STATES].sort()).toEqual(NEW_STATES.filter((s) => s !== 'absent').sort())
  })
})
