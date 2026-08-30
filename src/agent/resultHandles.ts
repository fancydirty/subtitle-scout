import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tool } from 'ai'
import { z } from 'zod'
import { runSearch, type FetchAdapter } from '../adapters/fetchLib.js'
import { candidateKey, type SubtitleCandidate } from '../core/schemas.js'
import { coercibleInt, coercibleOptionalInt } from './coerce.js'

export interface ResultSetStore {
  create(items: unknown[]): string
  count(id: string): number
  list(id: string, offset: number, limit: number): unknown[]
  get(id: string, index: number): unknown | null
  /** Delete a single result set's file. Best-effort, like stagingSandbox.cleanup — a delete
   *  failure (permission/mount hiccup, or the id already being gone) must never throw and
   *  block the caller. */
  delete(id: string): void
  /** GC every result set NOT in `activeIds` — mirrors stagingSandbox.gcOrphans's shape and
   *  best-effort-per-entry semantics (one bad entry never blocks the rest). Returns the count
   *  removed. Every search_source call leaves a `<uuid>.json` behind with no other cleanup path,
   *  so a caller (a future phase ③ worker) needs this hook to reap finished jobs' result sets —
   *  not wired into anything yet, this is just the lifecycle hook. */
  gc(activeIds: Set<string>): number
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
    delete(id) {
      try {
        rmSync(pathFor(id), { force: true })
      } catch {
        // best-effort: mirrors stagingSandbox.cleanup — a delete failure must never block the caller
      }
    },
    gc(activeIds) {
      let cleaned = 0
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return 0 // best-effort: dir listing failed (permission/mount hiccup) — nothing to clean this pass
      }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue // skip stray *.json.tmp from an interrupted create()
        const id = name.slice(0, -'.json'.length)
        if (activeIds.has(id)) continue
        try {
          rmSync(join(dir, name), { force: true })
          cleaned++
        } catch {
          // best-effort: a single entry's cleanup failure must not block the rest (gcOrphans idiom)
        }
      }
      return cleaned
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
  /** A4 (spec-review fix #3): the task's target subtitle language (FindSubtitleTask.targetLanguage,
   *  threaded by makeFindSubtitleWorker). The model may simply omit the `languages` arg on a
   *  search_source call — when it does, the dispatched FetchArgs defaults to [targetLanguage] so
   *  provider language gating (assrt is Chinese-only — assrtAdapter.ts) works end-to-end for
   *  non-zh targets. Optional: legacy callers without it fall through to runSearch's own ['zh']
   *  enabled-check fallback (fetchLib.ts), preserving pre-A4 behavior. Model-passed `languages`
   *  always win over this default. */
  targetLanguage?: string
  /** 重复源 P4：本地候选——mapper 算好的 provider:'local' 候选（该任务里 partial 条目已覆盖
   *  文件的现有字幕），每次 search_source 调用都前置注入结果集（不经过 adapters 扇出、零网络
   *  开销）。省略/空数组=绝大多数任务的常态。 */
  localCandidates?: SubtitleCandidate[]
}

/** search_source: runs the existing multi-provider fan-out (runSearch — fetchLib.ts, unchanged)
 *  but does NOT hand the full result list to the model. Full results go into the result-set
 *  store; the model gets a handle + count + a short preview (design: source-result
 *  handle-ization, "不内联" — Anthropic writing-tools guidance on large tool results).
 *
 *  Task 8c（审计发现 B9，事实诚实化）：this used to pass `() => {}` as runSearch's emit callback,
 *  silently discarding every `provider_error` event a partial provider failure produces
 *  (fetchLib.ts's runSearch emits one per failed adapter, then still returns the surviving
 *  providers' results — fail-soft by design). The agent worker is asked to judge retry_later vs
 *  no_safe_match on a search_source result, but had zero input distinguishing "every provider
 *  ran clean and truly found nothing" from "one provider errored out and the rest came back
 *  empty" — a transient failure looked identical to an honest empty result. providerFailures now
 *  carries that fact through. */
export function makeSearchSourceTool(deps: SearchSourceDeps) {
  return tool({
    description:
      'Search all configured subtitle providers for this media. Returns a result_set_id, a ' +
      'count, and a short top-N preview — call list_candidates/get_candidate to see more. If ' +
      'some providers failed this call, providerFailures lists them — a transient provider ' +
      'failure is grounds for retry_later on affected targets, absence of results across ' +
      'healthy providers is not. When you omit `languages` the search defaults to this task\'s ' +
      'target language. Some providers (e.g. assrt, zimuku) only consult the first 1-2 of your ' +
      'query variants per call — plan queries accordingly. Only pass `imdb` when your task ' +
      'facts explicitly provide one — NEVER invent or derive it from a tmdb id (a wrong imdb ' +
      'makes providers query the wrong identity and silently return zero results). ' +
      'When your task itemId is of the form `tmdb:<id>`, you may pass that numeric id as ' +
      '`tmdb` — id-indexed international providers (SubDL) match it more precisely than a ' +
      'title search, which can miss under alternate titles. The same rule applies: only pass ' +
      'a `tmdb` your task facts actually contain. ' +
      'When this task has a target whose item already has another file with a subtitle (a ' +
      'duplicate/replica), that subtitle appears in your results as a provider:"local" candidate ' +
      '— treat it exactly like any other candidate (same belonging judgment, same download/install ' +
      'flow); see the playbook for how to judge it.',
    inputSchema: z.object({
      queries: z.array(z.string()).min(1),
      imdb: z.string().optional(),
      tmdb: z.string().optional(),
      // Real models string-encode these ("2020"/"1"/"12") — coerce so this first-of-every-run tool
      // call does not die on tool-arg validation; empty-string sentinels become undefined (not 0).
      year: coercibleOptionalInt,
      season: coercibleOptionalInt,
      episode: coercibleOptionalInt,
      filename: z.string().optional(),
      languages: z.array(z.string()).optional(),
    }),
    execute: async (args) => {
      // Model omitted `languages` → default to the task's target language (see SearchSourceDeps).
      const languages = args.languages?.length
        ? args.languages
        : deps.targetLanguage ? [deps.targetLanguage] : undefined
      const failures: { provider: string; message: string }[] = []
      const remoteCandidates = await runSearch({ ...args, languages }, deps.adapters, (e) => {
        if (e.event === 'provider_error') failures.push({ provider: e.provider, message: e.message })
      })
      // 重复源 P4：本地候选前置——零成本、不经过 adapters 扇出，每次 search_source 调用都带上，
      // 与查询词无关（这些是"该条目另一个文件已有的字幕"这一固定事实，不是搜出来的）。
      const candidates = [...(deps.localCandidates ?? []), ...remoteCandidates]
      const resultSetId = deps.store.create(candidates)
      const topN = deps.topN ?? 5
      // 键序即证据存活序（Shelby Oaks 案取证教训，2026-07-17）：痕迹通道 C 的 resultSummary
      // 只留前 200 字符——providerFailures 排在 top[] 长尾后面时，恰恰在"某 provider 静默失败"
      // 最需要验尸的场景里被截没。失败事实排最前、top 长尾垫底，截断永远吃不到关键证据。
      return {
        providerFailures: failures,
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
      // Coerce string-encoded paging args the model emits ("0"/"10").
      offset: coercibleInt.min(0).default(0),
      limit: coercibleInt.min(1).max(50).default(10),
    }),
    execute: async ({ result_set_id, offset, limit }) => {
      // Mirrors get_candidate's fail-soft handling below and read_doc's (registry.ts) unknown-name
      // handling: an unknown result_set_id throws inside the store (read() at the top of this
      // file), which would otherwise surface as an asymmetric "throws here, {error} there" split
      // against get_candidate's bad-index path. Catch and return the same structured shape.
      let items: SubtitleCandidate[]
      try {
        items = store.list(result_set_id, offset, limit) as SubtitleCandidate[]
      } catch (e) {
        return { error: e instanceof Error ? e.message : `unknown result set: ${result_set_id}` }
      }
      return { items: items.map(summarizeCandidate) }
    },
  })
}

export function makeGetCandidateTool(store: ResultSetStore) {
  return tool({
    description: 'Fetch one candidate from a result set by index — concise summary or full detail.',
    inputSchema: z.object({
      result_set_id: z.string(),
      // Coerce a string-encoded index the model emits ("3").
      index: coercibleInt.min(0),
      detail: z.enum(['concise', 'detailed']).default('concise'),
    }),
    execute: async ({ result_set_id, index, detail }) => {
      // Same fail-soft treatment as list_candidates above: an unknown result_set_id throws inside
      // store.get→read; catch it so both the bad-id and bad-index cases return {error}, never throw.
      let item: SubtitleCandidate | null
      try {
        item = store.get(result_set_id, index) as SubtitleCandidate | null
      } catch (e) {
        return { error: e instanceof Error ? e.message : `unknown result set: ${result_set_id}` }
      }
      if (!item) return { error: `no candidate at index ${index} in result set ${result_set_id}` }
      return detail === 'detailed' ? item : summarizeCandidate(item)
    },
  })
}
