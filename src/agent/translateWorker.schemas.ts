import { z } from 'zod'
import { nullableTolerant } from './coerce.js'

/** One translate workspace job (P1). Single video per run — mirrors the daemon's
 *  per-item translate worker_task payload (taskType='translate'). */
export interface TranslateTask {
  jobId: string
  /** Absolute path of the video to translate. */
  videoPath: string
  /** Own id (episodes.id / movies.id), for runs bookkeeping. */
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
  status: z.enum(['installed', 'held', 'no-source', 'extract-failed', 'probe-failed']),
  reason: nullableTolerant(z.string().min(1)),
  sourceRef: nullableTolerant(z.string().min(1)),
  sidecarPath: nullableTolerant(z.string().min(1)),
})
export type TranslateReport = z.infer<typeof TranslateReportSchema>
