import { z } from 'zod'
import { nullableTolerant } from './coerce.js'

/** Terminal decision the find-subtitle worker's ToolLoopAgent reports by calling the `finalize`
 *  tool (this schema is that tool's inputSchema — see reasoningAgent.ts's finalize-tool mode).
 *  No confidence score anywhere (north star #1) — decision + a plain-language reason.
 *
 *  The nullable fields use nullableTolerant (coerce.ts): on a retry_later / no_safe_match finalize
 *  the real model string-encodes the "no value" fields as "None"/"null"/"" instead of JSON null.
 *  installedLanguage is a nullable ENUM, so "None" would hard-fail validation of this (the finalize
 *  tool's) inputSchema — captured never gets set and readFinalized() throws, killing the whole run.
 *  Collapsing those sentinels to null fixes that AND keeps the string fields from storing "None". */
export const FindSubtitleDecisionSchema = z.object({
  decision: z.enum(['installed', 'no_safe_match', 'retry_later']),
  reason: z.string().min(1),
  installedPath: nullableTolerant(z.string()),
  installedLanguage: nullableTolerant(z.enum(['zh-Hans', 'zh-Hant'])),
  candidateProvider: nullableTolerant(z.string()),
  candidateProviderId: nullableTolerant(z.string()),
})
export type FindSubtitleDecision = z.infer<typeof FindSubtitleDecisionSchema>

/** Input to one find-subtitle worker run. Deliberately a narrow, purpose-built shape rather
 *  than the full legacy MediaContext (core/schemas.ts) — phase ③ stays decoupled from the old
 *  pipeline's types; a mapper from MediaContext → FindSubtitleTask is a phase ⑦ wiring concern,
 *  not this worker's. mediaRoot/videoPath together define the ONE sandboxed directory (see the
 *  phase ③ header's sandbox design) — both are supplied by the caller, never by the agent. */
export interface FindSubtitleTask {
  jobId: string
  mediaRoot: string
  videoPath: string
  videoFilename: string
  title: string
  originalTitle: string | null
  year: number | null
  season: number | null
  episode: number | null
  /** Whole-series absolute episode number, system-computed from TMDB (see absoluteEpisodes.ts).
   *  null for movies, or when it couldn't be reliably derived. A HINT for locating the right file
   *  inside packs whose numbering differs from TMDB's — the worker still verifies belonging. */
  absoluteEpisode: number | null
  alternativeTitles: string[]
  overview: string | null
  runtimeMinutes: number | null
  providerIds: Record<string, string>
}
