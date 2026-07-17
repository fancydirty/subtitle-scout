import { z } from 'zod'
import { nullableTolerant, tolerantArray } from './coerce.js'

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
})
export type FindSubtitleBatchReport = z.infer<typeof FindSubtitleBatchReportSchema>
export type FindSubtitleInstalledItem = z.infer<typeof FindSubtitleInstalledItemSchema>
export type FindSubtitleUnresolvedItem = z.infer<typeof FindSubtitleUnresolvedItemSchema>
