import { z } from 'zod'
import { nullableTolerant, tolerantArray } from './coerce.js'
import type { SubtitleCandidate } from '../core/schemas.js'

/** Batch task/report shapes for the find-subtitle worker (phase ③) — see
 *  docs/design/2026-07-16-glue-layer-repair-and-semantic-audit-design.md, 第一部分第 1/3 条
 *  (glue-layer repair + batch harvest campaign). Superseded here: the old single-episode
 *  `FindSubtitleTask` (videoPath/videoFilename/season/episode/absoluteEpisode at the task's top
 *  level) and the old single-decision `FindSubtitleDecisionSchema`/`FindSubtitleDecision`
 *  (the finalize tool's old inputSchema, one decision per worker run). A worker run now takes a
 *  season-level (or single-movie) range plus the current gap fact-list and reports a batch of
 *  per-target outcomes in one finalize call — see `FindSubtitleTask`/`FindSubtitleBatchReportSchema`
 *  below.
 *
 *  The nullable/array fields use nullableTolerant / tolerantArray (coerce.ts): the real model
 *  string-encodes "no value" as "None"/"null"/"" instead of JSON null, and sometimes omits an
 *  empty bucket's key entirely rather than sending `[]`. Without that tolerance those sentinels
 *  would hard-fail validation of the finalize tool's inputSchema — captured never gets set and
 *  readFinalized() throws, killing the whole run. Collapsing those sentinels to null/[] fixes
 *  that AND keeps the string fields from storing "None".
 *
 *  installedLanguage was a zh-Hans/zh-Hant enum (locked to Chinese) — generalized (A2) to any
 *  non-empty BCP-47-ish string so the worker can install a subtitle in any target language; for
 *  Chinese targets the Hans/Hant refinement is still made by the agent from subtitleInspect's
 *  detectedScript signal, this schema just no longer enforces it. */

/** A gap target's fact row (mechanical pre-cleaning output, presented as fact, not instruction).
 *  itemId lives in own id space (episodes.id/movies.id) — the messenger carries it verbatim, and
 *  harvest ingestion (markCovered/markUnavailable) keys off it. */
export interface FindSubtitleTargetFact {
  itemId: string
  videoPath: string
  videoFilename: string
  season: number | null
  episode: number | null
  /** System-computed whole-series absolute episode number (a locating hint, not a proof of
   *  belonging); null for movies or when it couldn't be reliably derived. */
  absoluteEpisode: number | null
  /** 验收修复轮一：从 series/movies.provider_ids 解析出的真 imdb id（或 null）。这个值会被原样
   *  写进 worker prompt 的 targetsBlock，search_source 工具只许用它，禁止 LLM 自行编造。 */
  imdbId: string | null
  /** 2026-07-18 事故修复（True Detective S02E08）：该集/该片的实际时长（分钟）——per-episode
   *  fact，区别于 FindSubtitleTask 顶层的 `runtimeMinutes`（那是 TMDB `episode_run_time[0]`
   *  给出的剧级"典型"单集时长，通常是首集/众数，不代表某一集）。根因事故：True Detective
   *  S02E08 是 ~86 分钟的加长季终，agent 被喂剧级典型 ~58 分钟，把时长正确的候选字幕全部
   *  诚实拒判判无——agent 判断没错，喂的事实错了。mapper（findSubtitleWorkerTask.ts）用
   *  TmdbClient.getSeasonEpisodeRuntimes 逐季取值填充，取不到（tmdb 未配置/季端点失败）
   *  → null，绝不因此让整批任务构造失败。
   *
   *  必须可选（`?:`）——realignExecutor.ts（圣文件，不可动）的 makeRealignRunEpisode 构造
   *  target 字面量时不带这个键，字段必须允许缺席才能保持零改动兼容；缺席等价于 null。 */
  runtimeMinutes?: number | null
}

/** Input to one find-subtitle worker run: a season-level (or single-movie) range + the current
 *  gap fact-list. Glue-layer repair (2026-07-16 incident): the single-episode fields are
 *  abolished — one worker run consumes every completable target in the list. */
export interface FindSubtitleTask {
  jobId: string
  /** This task's INNER sandbox root: the common ancestor directory of every target's path (the
   *  mapper derives it and has already verified it's inside MEDIA_ROOTS). */
  mediaRoot: string
  title: string
  originalTitle: string | null
  year: number | null
  alternativeTitles: string[]
  overview: string | null
  runtimeMinutes: number | null
  providerIds: Record<string, string>
  /** BCP-47 primary language code for the subtitle to find, e.g. 'zh'/'en'. Interpolated into the
   *  worker prompt via languageName() (see languages.ts). */
  targetLanguage: string
  /** 救援R5：hardsub_mode 透传给 skill 决定是否教模型用第四桶。派发时新鲜读取（同
   *  targetLanguage 的既有先例——见 cli/index.ts handleWorkerTask find_subtitle 分支）。 */
  hardsubMode: 'off' | 'agent' | 'aggressive'
  /** 重复源 P4：本地候选——该任务目标里有副本条目（partial 覆盖）时，其已覆盖文件的现有字幕
   *  作为零成本候选前置注入 search_source 结果集（provider:'local'）。空数组=本任务没有需要
   *  传播的条目（绝大多数任务）。构造方=mapper（findSubtitleWorkerTask.ts）；search_source
   *  工具（resultHandles.ts）每次调用都把它们 prepend 进真实搜索结果——agent 用同一套
   *  list_candidates/get_candidate/download_candidate/install_subtitle 工具面对待它们，
   *  "同一套归属判断，无特殊心虚状态"（spec §4）。 */
  localCandidates: SubtitleCandidate[]
  /** ≥1. List order is fact-list order (episode ascending), not an execution-order instruction. */
  targets: FindSubtitleTargetFact[]
}

export const FindSubtitleInstalledItemSchema = z.object({
  itemId: z.string().min(1),
  installedPath: z.string().min(1),
  installedLanguage: nullableTolerant(z.string().min(1)),
  candidateProvider: nullableTolerant(z.string()),
  candidateProviderId: nullableTolerant(z.string()),
  reason: z.string().min(1),
})
export const FindSubtitleUnresolvedItemSchema = z.object({
  itemId: z.string().min(1),
  reason: z.string().min(1),
})

/** Batch harvest report (the finalize tool's inputSchema): the worker verifies belonging and
 *  installs episode-by-episode for every target in the list; an unclear single episode is
 *  skipped, not the whole batch. retry_later = transient-failure targets needing a retry (the
 *  rest of this season); no_safe_match = judged absent after genuine exhaustion. North star
 *  invariant unchanged: no confidence score anywhere — decision + plain-language reason. */
export const FindSubtitleBatchReportSchema = z.object({
  installed: tolerantArray(FindSubtitleInstalledItemSchema),
  no_safe_match: tolerantArray(FindSubtitleUnresolvedItemSchema),
  retry_later: tolerantArray(FindSubtitleUnresolvedItemSchema),
  /** 救援R5：hardsub_mode='agent' 时 skill 教模型用这桶——目标已判定"字幕烧录进画面本身，
   *  不需要外挂"。'off'/'aggressive' 模式下 skill 文字不提这个概念，模型不会主动填它，但
   *  schema 层不按模式收紧（tolerantArray 缺省即 []，零填也不炸）——校验只管形状。 */
  hardsub_assumed: tolerantArray(FindSubtitleUnresolvedItemSchema),
})
export type FindSubtitleBatchReport = z.infer<typeof FindSubtitleBatchReportSchema>
export type FindSubtitleInstalledItem = z.infer<typeof FindSubtitleInstalledItemSchema>
export type FindSubtitleUnresolvedItem = z.infer<typeof FindSubtitleUnresolvedItemSchema>
