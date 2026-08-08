// src/agent/identifyWorker.ts：识别 agent（新架构阶段 2）。
// spec: docs/design/2026-08-08-new-architecture-design.md §5
//
// 职责（用户裁决）：确认"这个 work_dir 是什么影视"（TMDB 身份）+ 批量绑定文件季集号。
// 输入：一个 work_dir + 它的文件列表（含 parse_confidence）。
// 输出：works 行 + files.work_id 批量更新。
//
// 工具集（只挂识别工具，字幕工具零挂载——零误触发纪律，同旧 identifyOnly）：
//  - search_tmdb(query, media_type)
//  - get_tmdb_details(tmdb_id)
//  - write_identified_media({ tmdb_id, files: [...] })  ← 批量绑定
//  - finalize
import { tool, stepCountIs, type LanguageModel } from 'ai'
import { z } from 'zod'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeRunTracer } from '../core/traceBus.js'
import { titleFromDir, searchCandidates, verifyEvidence } from '../v2/identify.js'

export interface IdentifyWorkerDeps {
  model: LanguageModel
  tmdb: {
    search: (mediaType: 'tv' | 'movie', query: string, year?: number) => Promise<Array<{ id: number; title: string; year: number | null; posterPath: string | null }>>
    getDetails: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<{
      id: number; title: string; originalTitle: string | null; year: number | null;
      overview: string | null; posterPath: string | null; genreIds: number[] | null;
      originLanguage: string | null; chineseTitles: string[]
    } | null>
  }
  /** 批量绑定工具的执行体（写库由调用方实现——可单测）。
   *  可选：scheduler 调用时注入（见 identifyScheduler.ts 的 writeIdentified 覆盖）。 */
  writeIdentified?: (input: WriteIdentifiedInput) => Promise<{ ok: true; written: number } | { ok: false; error: string }>
  stepCap?: number
}

export interface WorkDirFacts {
  workDir: string
  dirName: string       // work_dir 的最后一段
  files: Array<{ filename: string; season: number | null; episode: number | null; confidence: string }>
  fileCount: number
  seasons: number[]
  hasSeasonDirs: boolean
}

export const WriteIdentifiedInputSchema = z.object({
  tmdbId: z.string().regex(/^\d+$/),
  isTv: z.boolean(),
  title: z.string().min(1),
  files: z.array(z.object({
    filename: z.string().min(1),
    season: z.number().int().nullable(),
    episode: z.number().int().nullable(),
  })).min(1),
})
export type WriteIdentifiedInput = z.infer<typeof WriteIdentifiedInputSchema>

export interface IdentifyReport {
  tmdbId: string | null
  title: string | null
  reason: string
}

/** 跑一次识别：work_dir → TMDB 身份 + 批量绑定。返回报告。 */
export async function runIdentify(
  deps: IdentifyWorkerDeps,
  facts: WorkDirFacts,
  runKey: string,
): Promise<IdentifyReport> {
  const candidates = searchCandidates(facts.dirName)
  const title = titleFromDir(facts.dirName)

  const searchTool = tool({
    description: `Search TMDB for a title. Returns candidate hits with id/title/year. Use this to find which work a directory belongs to.`,
    inputSchema: z.object({
      query: z.string().min(1),
      mediaType: z.enum(['tv', 'movie']),
    }),
    execute: async ({ query, mediaType }) => {
      const hits = await deps.tmdb.search(mediaType, query)
      return hits.map(h => ({ id: h.id, title: h.title, year: h.year }))
    },
  })

  const detailsTool = tool({
    description: `Get full details of a TMDB candidate (id/title/originalTitle/year/originLanguage/chineseTitles). Use this to verify a candidate matches the directory before writing.`,
    inputSchema: z.object({ tmdbId: z.string().regex(/^\d+$/), mediaType: z.enum(['tv', 'movie']) }),
    execute: async ({ tmdbId, mediaType }) => {
      const d = await deps.tmdb.getDetails(mediaType, tmdbId)
      if (!d) return { found: false }
      return {
        found: true,
        title: d.title,
        originalTitle: d.originalTitle,
        year: d.year,
        originLanguage: d.originLanguage,
        chineseTitles: d.chineseTitles,
      }
    },
  })

  const writeTool = tool({
    description: `Write the identified media binding: assign this directory's files to a TMDB work. Call this once per directory after confirming identity with get_tmdb_details. files is the full list of files in this directory with their season/episode (use the mechanical parse values, correcting them where they are clearly wrong).`,
    inputSchema: WriteIdentifiedInputSchema,
    execute: async (input) => {
      if (!deps.writeIdentified) return { ok: false as const, error: 'writeIdentified not wired' }
      return deps.writeIdentified(input)
    },
  })

  const { agent, readFinalized } = makeReasoningAgent({
    model: deps.model,
    tools: { search_tmdb: searchTool, get_tmdb_details: detailsTool, write_identified_media: writeTool },
    schema: z.object({
      identity: z.object({
        tmdbId: z.string().regex(/^\d+$/),
        title: z.string(),
        reason: z.string(),
      }),
    }),
    instructions: `You are the identification agent for a media library. Your job: determine which TMDB work a media directory belongs to.

## Your task
A directory contains media files. Determine the TMDB identity (movie or TV series), then bind ALL files in the directory to that identity.

## Steps
1. Look at the directory name and files. Extract a title candidate.
2. Call search_tmdb with the candidate title. If the directory is under a TV/Anime root, search type=tv; under Movies/ root, type=movie. If unsure, try both.
3. Call get_tmdb_details on the best candidate. VERIFY it matches: title (or Chinese title) must match the directory name, AND at least one of: year, media type, episode count. This is the two-evidence bar — never skip it.
4. Call write_identified_media with the tmdbId and ALL files in the directory. For each file, use the season/episode from the task facts if present (confidence high), or determine them yourself (confidence low/none — e.g. "S2 - 07" means season 2 episode 7; bare numbers under a single Season directory belong to that season).
5. Call finalize with the identity you confirmed.

## Rules
- NEVER claim an identity without calling get_tmdb_details (two-evidence bar).
- If a directory truly cannot be identified (no TMDB match), call finalize with tmdbId=null and reason explaining why.
- Movies have no season/episode — set them null for movie files.
- Bind ALL files, not just some.`,
    stopWhen: stepCountIs(deps.stepCap ?? 200),
    reasoning: 'high',
    telemetry: { isEnabled: true },
    onStepEvent: makeRunTracer(runKey),
  })

  const fileLines = facts.files.map(f =>
    `  - ${f.filename}${f.confidence === 'high' && f.season != null ? ` (S${f.season}E${f.episode}, mechanical)` : f.confidence === 'low' ? ' (bare episode number, season uncertain)' : ' (no structure parsed)'}`,
  ).join('\n')

  const prompt = `Directory: ${facts.workDir}
Directory name: ${facts.dirName}
Type hints: ${facts.hasSeasonDirs ? 'has Season dirs (TV series)' : 'no Season dirs'}
Search candidates: ${candidates.join(' | ')}

Files (${facts.fileCount}):
${fileLines}

Determine the TMDB identity of this directory and bind all files.`

  const result = await agent.generate({ prompt })
  console.error(`[identify-worker] ${runKey} finished in ${result.steps.length} step(s)`)
  const final = readFinalized()
  return { tmdbId: final.identity?.tmdbId ?? null, title: final.identity?.title ?? null, reason: final.identity?.reason ?? '' }
}
