// src/v2/judgePending.ts：把「语言事实已在库里」写成 needs_subtitle / skip_reason。
//
// 纯函数 judgeSubtitle 的调度入口。此前这份 SQL 只活在 daemonV2.judgeOnce 里，且只在
// 巡检阶段 2.5（scan + identify 之后）跑。软路由上扫盘要数小时，带外 scanOnce（加根 /
// 换挂载 / 手动扫描）根本不进巡检 → 前端详情页拿不到判决，看起来像「系统没记录内嵌中文」。
// 内嵌中文是 ffprobe 事实，不需要识别 agent。本模块是那条调度缺口的唯一实现，daemon 与
// dashboard 共用，禁止再抄一份。
import type { ScoutDb } from './db.js'
import { judgeSubtitle, judgeTranslatable, type TranslatableDeps } from './subtitleJudge.js'
import { FETCHABLE_SOURCE_LANGS, EXTRACTABLE_SOURCE_LANGS } from './translateWorkerTask.js'

const TRANSLATABLE_LANGS: TranslatableDeps = {
  fetchableSourceLangs: FETCHABLE_SOURCE_LANGS,
  extractableSourceLangs: EXTRACTABLE_SOURCE_LANGS,
}

export interface JudgePendingOpts {
  db: ScoutDb
  targetLanguage: string
  now: number
  log?: (msg: string) => void
}

export interface JudgePendingResult {
  judged: number
  needsCount: number
}

/** 对 `needs_subtitle IS NULL` 的行按已有语言事实落判决。不碰磁盘。
 *
 *  身份未定（work_id IS NULL）时**只落可以跳过的判决**（embedded / extra / origin-skip）。
 *  内嵌目标语言轨是 probe 已经写在 embedded_langs 里的事实，等识别 agent 是把机械结论
 *  串到付费路径后面。反过来，身份未定时不许写 missing：那会让随后识别成国产片的行
 *  needs=1 冻住（谓词是 IS NULL），origin-skip 永远轮不到。 */
export function judgePendingFiles(opts: JudgePendingOpts): JudgePendingResult {
  const { db, targetLanguage, now, log } = opts
  const rows = db.prepare(`
      SELECT f.path, f.filename, f.embedded_langs, f.work_id, w.origin_lang
      FROM files f LEFT JOIN works w ON f.work_id = w.id
      WHERE f.needs_subtitle IS NULL
    `).all() as Array<{
      path: string
      filename: string
      embedded_langs: string | null
      work_id: string | null
      origin_lang: string | null
    }>

  if (rows.length === 0) return { judged: 0, needsCount: 0 }

  const haveCols = (() => {
    try {
      return new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name))
    } catch { return new Set<string>() }
  })()
  const haveTranslatable = haveCols.has('translatable')
  const haveSkipReason = haveCols.has('skip_reason')
  // needs / translatable / skip_reason 写在同一条 UPDATE：分两条时掉电会留下半判决行，
  // 而谓词是 `needs_subtitle IS NULL` → 这一行从此永不重判。
  const update = db.prepare(
    `UPDATE files SET needs_subtitle = ?, updated_at = ?`
    + (haveTranslatable ? `, translatable = ?` : '')
    + (haveSkipReason ? `, skip_reason = ?` : '')
    + ` WHERE path = ?`,
  )
  let judged = 0
  let needsCount = 0

  for (const r of rows) {
    let embedded: string[] | null = null
    if (r.embedded_langs) { try { embedded = JSON.parse(r.embedded_langs) } catch { embedded = null } }

    const input = { originLang: r.origin_lang, embeddedLangs: embedded, filename: r.filename }
    const verdict = judgeSubtitle(input, { targetLanguages: [targetLanguage] })
    if (!r.work_id && verdict.needs) continue

    const translatable = judgeTranslatable(input, TRANSLATABLE_LANGS)
    const args: unknown[] = [verdict.needs ? 1 : 0, now]
    if (haveTranslatable) args.push(translatable)
    if (haveSkipReason) args.push(verdict.reason)
    args.push(r.path)
    update.run(...args)
    judged++
    if (verdict.needs) needsCount++
  }
  if (judged > 0) {
    log?.(`judge: 判定 ${judged} 个文件——${needsCount} 需字幕 / ${judged - needsCount} 跳过（特典、国产或已有内嵌中文轨）`)
  }
  return { judged, needsCount }
}
