// src/v2/retarget.ts：换目标语言 → 全库重判（R-F15 缺口③）。
//
// 用户原话：「关于资源的字幕情况，需要在一开始就记录下来，每个资源有哪些字幕，这样在用户
// 更换目标语言后，数据库能反应过来。」——「反应过来」这四个字就是本模块的全部职责。
//
// ── 触发者是谁（本仓栽过 6 次「加了能力却没定谁触发」，故写死在这里）──────────
// 唯一触发点是 dashboard/apiV2.ts 的 updateSettings（PUT /api/v2/settings），且**只在
// target_languages 真的变了时**才调用。幂等是硬要求：设置页的保存按钮把整个表单一起 PUT，
// 同一个值被反复提交是常态；每次都清全库判决 = 每次点保存都让全库重跑一遍 judge，
// 并把 sub_status 按同一批语言重导一遍——把一个无变化的保存变成周期性全库写。
//
// ── 清什么、不清什么（这是本模块唯一需要论证的事）────────────────────────────
//  清 needs_subtitle + skip_reason：这两列是**基于目标语言算出来的判决**，语言一换，
//    判据的前提就没了。judge 的谓词恰好是 `needs_subtitle IS NULL`，清成 NULL 就是重判通路
//    （同 D17 回填 embedded_langs）。**触发者必须当场 judge**（updateSettings 在同一事务里
//    调 judgePendingFiles）——等下一轮巡检阶段 2.5 会让详情页在扫盘的数小时里显示「还没判定」。
//    两列**同一条 UPDATE**：分两条时进程被杀（软路由掉电是本项目
//    常态）会留下"判决已清、理由还是旧语言口径"的行，而它已不在 `needs_subtitle IS NULL` 之外
//    ——下轮 judge 会重写两列，故此处的原子性要求弱于 judge 侧，但没有任何理由分两条。
//
//  **不清 sub_status**（R24 铁律，用户点名的约束）：它是**磁盘事实观察**——"磁盘上现在有没有
//    可用字幕"，唯一有权写它的是扫描（R24）。改一个配置不该让一个已经观察到的磁盘事实丢失。
//    清掉的直接代价：飞行中的翻译（handoff_translate）被掀掉 → D10 的乐观守卫
//    `WHERE sub_status='handoff_translate'` 匹配 0 行 → 退避不写 → 付费 LLM 热循环从侧门回来
//    （C14/D10 记有实案）；停牌态（unsolvable）被清成 NULL 则会让整批停牌文件一次性涌进字幕
//    工作台，正是 D12/D13 要避免的雪崩。
//
//  那 sub_status 怎么"反应过来"？——**重导，不是清空**。有了 sidecar_langs（v40，扫描独占
//    写入的磁盘事实：该视频旁边全部外挂字幕的语言集合）之后，"新目标语言的字幕在不在盘上"
//    这个问题可以**纯查库**回答，一次 stat / readdir 都不用发。这正是 R-F15 第 2 件改动存在的
//    全部价值：换语言时不需要重新扫盘。
//
// ── 重导的两个方向，各自守着一条既有红线 ──────────────────────────────────
//  ① 新目标语言的字幕**在**盘上 → 无条件 covered（含停牌态）。凭据与扫描的 observeSubtitle
//     逐字一致：停牌的解除凭据就是"磁盘上出现了目标语言的字幕"（R23），此处只是换了发现它的
//     时机（用户改配置的那一刻，而不是下一轮扫描）。
//  ② 新目标语言的字幕**不在**盘上 → **只把 covered 回退成 NULL**，其余状态一列不动。
//     这条守卫与 observeSubtitle 那条逐字同源（`WHERE sub_status='covered'`）：扫描都没有被
//     授权把停牌写回 NULL，一次配置变更更没有。
//
//  sidecar_langs IS NULL 的行（存量行 / 还没被观察过 / FUSE 抖动没读到）**判决列一列都不动**：
//    没有任何新证据可据以重导，动它就是拿信息缺失当结论。它们会在下一轮扫描被观察到
//    （A 档新增/指纹变化 + B 档 7 天轮转），届时 observeSubtitle 按新的 targetLanguage
//    写出正确的 sub_status——通路是通的，只是慢一轮，这正是"证据不全时不臆断"的正确代价。
//
// ── C51（2026-08-26 生产实锤）：判决清干净了，但退避列把整库关在门外 ─────────────
//  实案：用户把 target_languages 从 zh 改成 pt，446 个文件**零派发，且无任何错误日志**。
//  上面三段论证的判决列全部正确执行了，卡住的是本模块当时完全没碰的第四列 sub_recheck_at：
//  446 行都停在 zh 时代排的「3.5 天后」（attempt=0 streak=0 —— 是例行复查间隔，不是失败退避），
//  而 B 档轮转的取件谓词只有 `sub_recheck_at <= now`（daemonV2.ts:2086，注释明写不带
//  sub_status 过滤）。判决列再干净，行也进不了取件名单。
//
//  同一个坑在装盘路径上已踩过并修好（subtitleScheduler.ts:546-570 的 IMMEDIATE_RECHECK 血书 +
//  生产实测「sub_recheck_at 未来|61、sub_status (null)|61、磁盘实际字幕数 35」）。取值口径**照抄
//  它**：写字面 0，不写 now / now-1。理由是那段血书已论证过的时钟不同源——本模块的 now 是调用方
//  注入的，B 档谓词喂的是 deps.now()，两者可以不同源；0 在任何时钟源下都已过期、非 NULL（满足
//  D18），且被 B 档观察完就自动推回 now + SUB_RECHECK_INTERVAL_MS（daemonV2.ts:2192），自清除。
//
//  拉谁、不拉谁（范围纪律，与上面的重导方向一一对应）：
//   · 方向② covered → NULL 的行：**拉**。它刚失去覆盖，正是要重新去找字幕的那批。
//   · 方向① 判成 covered 的行：**不拉**。它已覆盖，拉它等于给自己排一次无用的全库复核——
//     换语言本就不需要重新扫盘（本模块存在的全部价值），别在退避列上把这个价值还回去。
//   · sidecar_langs IS NULL 且 sub_status 有值的行：**拉**，而这批正是生产 446 行的主体。
//     这与上一段"一列都不动"不矛盾——不动的是**判决列**（我们确实没有证据去重导它），拉的是
//     **取证时机**。这批行的处境是死锁：sub_status 带着旧语言口径的结论把它挡在字幕工作台外，
//     而唯一能推翻该结论的 observeSubtitle 只能由 B 档触发，B 档又被停在未来的 sub_recheck_at
//     挡住 → 它永远等不到那一轮观察。拉退避不是替扫描下结论，恰恰相反：是把结论权交回扫描。
//   · sidecar_langs IS NULL 且 sub_status 也是 NULL 的行：**不拉**。它身上没有任何语言相关的
//     陈旧排除项，判决列清空后就已经在 judge → 字幕工作台的正常通路上，无需 B 档介入。
import type { ScoutDb } from './db.js'
import { tagsForLanguage } from '../agent/languages.js'
import { languageForTag } from '../files/sidecar.js'

export interface RetargetResult {
  /** 判决列被清空的行数（needs_subtitle + skip_reason）。 */
  rejudged: number
  /** sub_status 被重导成 covered 的行数（新目标语言的字幕已在盘上）。 */
  covered: number
  /** sub_status 从 covered 回退成 NULL 的行数（旧目标语言的字幕不算数了）。 */
  uncovered: number
  /** sub_recheck_at 被拉回「立即到点」的行数（C51：不拉就进不了 B 档取件名单）。 */
  rechecked: number
}

/** 一组目标语言在 sidecar_langs 这一列的**记账值域**上的等价集合。
 *
 *  为什么要这一层换算而不是直接 `langs.includes(target)`：sidecar_langs 存的是
 *  languageForTag 的产物（中文精修到 zh-Hans / zh-Hant 两个值），而 target_languages 存的是
 *  BCP-47 主码（zh）。裸比较的话目标 zh 永远匹配不上盘上的 zh-Hans——**每一个已配中文字幕的
 *  文件都会被判成"没有字幕"**，换一次语言就把全库中文字幕全部作废重找。
 *
 *  复用 tagsForLanguage + languageForTag 这两份既有表串起来（zh → 15 个 tag → {zh-Hans,
 *  zh-Hant}），**不另写第二份折叠**：本仓已因"留两份漂移实现"栽过（C30 两处标签集各漏一半）。
 *  特别注意不能用 agent/languages.ts 的 langOf 反向折叠——它只认中文别名 chi/zho/cmn/cn，
 *  对 chs/cht 返回自身（实测），而 zh-Hans/zh-Hant 这两个恰恰是本列最常见的值。 */
export function coverageValuesFor(targetLanguages: string[]): Set<string> {
  const out = new Set<string>()
  for (const lang of targetLanguages) {
    out.add(lang)
    for (const tag of tagsForLanguage(lang)) out.add(languageForTag(tag))
  }
  return out
}

/** 全库重判：清判决列 + 按 sidecar_langs 重导 sub_status。**一次磁盘访问都不发**。
 *
 *  整体包在一个事务里：三条语句之间掉电会留下"判决清了、sub_status 还是旧语言口径"的库，
 *  而 sub_status 的重导没有任何"重试通路"（它不像 needs_subtitle 那样有 IS NULL 谓词兜底），
 *  一旦漏做就要等下一轮扫描的 B 档轮转（最长 7 天）才自愈。 */
export function retargetForLanguageChange(
  db: ScoutDb, targetLanguages: string[], now: number,
): RetargetResult {
  const covered = coverageValuesFor(targetLanguages)

  // 列缺席的旧库（容器滚更时新代码可能先于迁移起来）：整支退化成 no-op，不许炸掉设置页的
  // PUT。照 judgeOnce / backfill 的既有动态拼列口径。
  const cols = (() => {
    try {
      return new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name))
    } catch { return new Set<string>() }
  })()
  if (!cols.has('needs_subtitle')) return { rejudged: 0, covered: 0, uncovered: 0, rechecked: 0 }

  return db.transaction((): RetargetResult => {
    // ① 判决列清空 → 同一事务里的 judgePendingFiles 按新语言重算（谓词 `needs_subtitle IS NULL`）。
    //    skip_reason 与它同生共死：留着旧理由就是让媒体库页显示上一次语言口径下的 ◇/◆ 标记。
    const rejudged = db.prepare(
      `UPDATE files SET needs_subtitle = NULL, updated_at = ?`
      + (cols.has('skip_reason') ? `, skip_reason = NULL` : '')
      + ` WHERE needs_subtitle IS NOT NULL`
      + (cols.has('skip_reason') ? ` OR skip_reason IS NOT NULL` : ''),
    ).run(now).changes

    // 取值口径照抄 subtitleScheduler.ts:553 的 IMMEDIATE_RECHECK（含它选 0 而非 now-1 的理由，
    // 见头注释 C51 段）。写在事务内、与 sub_status 的重导同拍——两者必须同生共死：只落了
    // sub_status=NULL 却没落退避，就退回本次 bug 的原状。
    const IMMEDIATE_RECHECK = 0
    // prepare 必须懒到 canRecheck 之后：语句文本里带 sub_recheck_at，缺列的老库上 prepare
    // 本身就抛（不是 run 才抛），先建后判等于把这条早退守卫作废。
    const canRecheck = cols.has('sub_recheck_at')
    const pullRecheck = canRecheck
      ? db.prepare('UPDATE files SET sub_recheck_at = ?, updated_at = ? WHERE path = ?')
      : null
    let nowRechecked = 0
    const pull = (path: string): void => {
      if (!pullRecheck) return
      pullRecheck.run(IMMEDIATE_RECHECK, now, path)
      nowRechecked++
    }

    if (!cols.has('sidecar_langs')) return { rejudged, covered: 0, uncovered: 0, rechecked: 0 }

    // ② sub_status 重导。**只看已观察到语言的行**（sidecar_langs IS NOT NULL）——
    //    NULL 的行没有新证据，一列不动（见头注释）。
    const rows = db.prepare(
      'SELECT path, sub_status, sidecar_langs FROM files WHERE sidecar_langs IS NOT NULL',
    ).all() as Array<{ path: string; sub_status: string | null; sidecar_langs: string }>

    const setCovered = db.prepare(
      `UPDATE files SET sub_status = 'covered', updated_at = ? WHERE path = ?`)
    // 回退守卫与 observeSubtitle 逐字同源：只有 covered 会被回退，停牌态一列不动。
    const clearCovered = db.prepare(
      `UPDATE files SET sub_status = NULL, updated_at = ? WHERE path = ? AND sub_status = 'covered'`)

    let nowCovered = 0, nowUncovered = 0
    for (const r of rows) {
      let langs: string[]
      try { langs = JSON.parse(r.sidecar_langs) } catch { continue }   // 脏值不许掀翻整批
      if (!Array.isArray(langs)) continue
      const hit = langs.some((l) => covered.has(l))
      if (hit) {
        if (r.sub_status !== 'covered') { setCovered.run(now, r.path); nowCovered++ }
      } else if (r.sub_status === 'covered') {
        clearCovered.run(now, r.path); nowUncovered++
        pull(r.path)
      }
    }

    // ③ 证据缺失 + 带着旧语言口径结论的行：判决列碰不了（无证据），但必须把取证时机拉回来，
    //    否则 sub_status 挡住工作台、未来的退避挡住 B 档 → 死锁（生产 446 行的主体，见头注释）。
    if (canRecheck) {
      const stranded = db.prepare(
        'SELECT path FROM files WHERE sidecar_langs IS NULL AND sub_status IS NOT NULL',
      ).all() as Array<{ path: string }>
      for (const r of stranded) pull(r.path)
    }

    return { rejudged, covered: nowCovered, uncovered: nowUncovered, rechecked: nowRechecked }
  })()
}
