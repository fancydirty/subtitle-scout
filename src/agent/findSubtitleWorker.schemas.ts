import { z } from 'zod'

/** Terminal decision the find-subtitle worker's ToolLoopAgent reports by calling the `finalize`
 *  tool (this schema is that tool's inputSchema — see reasoningAgent.ts's finalize-tool mode).
 *  No confidence score anywhere (north star #1) — decision + a plain-language reason. */
export const FindSubtitleDecisionSchema = z.object({
  decision: z.enum(['installed', 'no_safe_match', 'retry_later']),
  reason: z.string().min(1),
  installedPath: z.string().nullable(),
  installedLanguage: z.enum(['zh-Hans', 'zh-Hant']).nullable(),
  candidateProvider: z.string().nullable(),
  candidateProviderId: z.string().nullable(),
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
  alternativeTitles: string[]
  overview: string | null
  runtimeMinutes: number | null
  providerIds: Record<string, string>
}
