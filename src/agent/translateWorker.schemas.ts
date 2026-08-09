import { z } from 'zod'
import { nullableTolerant } from './coerce.js'

/** One translate workspace job (P1). Single video per run — mirrors the daemon's
 *  per-item translate worker_task payload (taskType='translate'). */
export interface TranslateTask {
  jobId: string
  /** Absolute path of the video to translate. */
  videoPath: string
  /** 条目身份，兼两用：runs 记账 + **剧级术语表的 key 来源**。
   *
   *  精确形态（spec §4 第 4 步 / 缺口 C20）：`<work_id>/<稳定file标识>`，
   *  由 `v2/ownIds.ts` 的 `translateItemId(workId, videoPath)` 唯一构造——**不许手拼**。
   *  旧世界的 episodes own-id（`tmdb:1/s1e2`）在同一契约下同构，故存量 glossary 行可直接继承。
   *
   *  🔴 **绝不许把绝对路径放在第一段**：`translateWorker.tools.ts` 用
   *  `seriesKeyOf(task.itemId)` 取剧级术语表 key，而 `glossaryRepo.seriesKeyOf` 取的是第一个
   *  `/` 之前那段（`indexOf('/') > 0` 才切）。以 `/mnt/...` 开头会让 `idx === 0` → 返回整串 →
   *  每个文件一个 key → 同剧第 2 集拿不到第 1 集冻结的术语表 → 人名地名每集换译法
   *  （实案：同一模型同剧两 run 分别选出"东国 / 奥斯塔尼亚"）。
   *  这是**纯静默的质量退化**：不报错、字幕照样出，只是逐集漂移。
   *  守卫者：`ownIds.test.ts` 与 `translateWorker.tools.test.ts` 各一组 C20 红线用例。 */
  itemId: string
  /** series/movies.origin_lang (lowercased code like 'en'/'ja'), or null. Drives single-hop
   *  source selection — ja never falls back to English embedded tracks. */
  originLang: string | null
  /** Human title for prompt context only. */
  title: string
  /** The video's own directory — sandbox boundary for the final sidecar install. */
  mediaRoot: string
  /** Config-level media root that contains mediaRoot (workspace GC anchor). Falls back to
   *  mediaRoot when absent (same contract as FindSubtitleTask.stagingRoot). */
  stagingRoot?: string
}

/** finalize report for one translate run. */
export const TranslateReportSchema = z.object({
  status: z.enum(['installed', 'held', 'no-source', 'extract-failed', 'probe-failed', 'already-covered']),
  reason: nullableTolerant(z.string().min(1)),
  sourceRef: nullableTolerant(z.string().min(1)),
  sidecarPath: nullableTolerant(z.string().min(1)),
})
export type TranslateReport = z.infer<typeof TranslateReportSchema>
