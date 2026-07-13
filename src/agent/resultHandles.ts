import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'
import { runSearch, type FetchAdapter } from '../cli/fetchLib.js'
import { candidateKey, type SubtitleCandidate } from '../core/schemas.js'

export interface ResultSetStore {
  create(items: unknown[]): string
  count(id: string): number
  list(id: string, offset: number, limit: number): unknown[]
  get(id: string, index: number): unknown | null
}

/** File-backed handle store for search_source's full result sets (design: "写 DB/文件,只返回
 *  {result_set_id,count,top-N}"). Deliberately file-backed, not a new DB table — keeps phase ②
 *  independent of any schema migration (the only migration in this plan is phase ④'s, on the
 *  jobs table). Atomic tmp+rename write mirrors the existing ProfileStore idiom
 *  (src/agent/profile.ts) already used in this codebase. */
export function makeFileResultSetStore(dir: string): ResultSetStore {
  mkdirSync(dir, { recursive: true })
  const pathFor = (id: string) => join(dir, `${id}.json`)
  const read = (id: string): unknown[] => {
    const p = pathFor(id)
    if (!existsSync(p)) throw new Error(`unknown result set: ${id}`)
    return JSON.parse(readFileSync(p, 'utf8'))
  }
  return {
    create(items) {
      const id = randomUUID()
      const finalPath = pathFor(id)
      const tmpPath = `${finalPath}.tmp`
      writeFileSync(tmpPath, JSON.stringify(items))
      renameSync(tmpPath, finalPath)
      return id
    },
    count(id) {
      return read(id).length
    },
    list(id, offset, limit) {
      return read(id).slice(offset, offset + limit)
    },
    get(id, index) {
      const items = read(id)
      return items[index] ?? null
    },
  }
}

export interface CandidateSummary {
  id: string
  provider: string
  videoName: string | null | undefined
  nativeName: string | null | undefined
  language: string | null | undefined
  subtype: string | null | undefined
  releaseSite: string | null | undefined
  fileList: { index: number; name: string }[]
}

/** Concise view of a SubtitleCandidate for a model to skim — drops nothing structurally
 *  important, just flattens candidateKey() into `id` for the model's convenience. */
export function summarizeCandidate(c: SubtitleCandidate): CandidateSummary {
  return {
    id: candidateKey(c), provider: c.provider, videoName: c.videoName, nativeName: c.nativeName,
    language: c.language, subtype: c.subtype, releaseSite: c.releaseSite, fileList: c.fileList,
  }
}

export interface SearchSourceDeps {
  adapters: FetchAdapter[]
  store: ResultSetStore
  topN?: number
}

/** search_source: runs the existing multi-provider fan-out (runSearch — fetchLib.ts, unchanged)
 *  but does NOT hand the full result list to the model. Full results go into the result-set
 *  store; the model gets a handle + count + a short preview (design: source-result
 *  handle-ization, "不内联" — Anthropic writing-tools guidance on large tool results). */
export function makeSearchSourceTool(deps: SearchSourceDeps) {
  return tool({
    description:
      'Search all configured subtitle providers for this media. Returns a result_set_id, a ' +
      'count, and a short top-N preview — call list_candidates/get_candidate to see more.',
    inputSchema: z.object({
      queries: z.array(z.string()).min(1),
      imdb: z.string().optional(),
      year: z.number().int().optional(),
      season: z.number().int().optional(),
      episode: z.number().int().optional(),
      filename: z.string().optional(),
      languages: z.array(z.string()).optional(),
    }),
    execute: async (args) => {
      const candidates = await runSearch({ ...args, deep: false }, deps.adapters, () => {})
      const resultSetId = deps.store.create(candidates)
      const topN = deps.topN ?? 5
      return {
        result_set_id: resultSetId,
        count: candidates.length,
        top: candidates.slice(0, topN).map(summarizeCandidate),
      }
    },
  })
}

export function makeListCandidatesTool(store: ResultSetStore) {
  return tool({
    description: 'Page through a result set previously returned by search_source.',
    inputSchema: z.object({
      result_set_id: z.string(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    execute: async ({ result_set_id, offset, limit }) => {
      const items = store.list(result_set_id, offset, limit) as SubtitleCandidate[]
      return { items: items.map(summarizeCandidate) }
    },
  })
}

export function makeGetCandidateTool(store: ResultSetStore) {
  return tool({
    description: 'Fetch one candidate from a result set by index — concise summary or full detail.',
    inputSchema: z.object({
      result_set_id: z.string(),
      index: z.number().int().min(0),
      detail: z.enum(['concise', 'detailed']).default('concise'),
    }),
    execute: async ({ result_set_id, index, detail }) => {
      const item = store.get(result_set_id, index) as SubtitleCandidate | null
      if (!item) return { error: `no candidate at index ${index} in result set ${result_set_id}` }
      return detail === 'detailed' ? item : summarizeCandidate(item)
    },
  })
}
