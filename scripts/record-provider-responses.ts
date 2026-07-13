// Out-of-band recorder — NOT part of `npm test`. Hits real providers ONCE per invocation to mint
// a matrix cell's recorded responses. Rate limiting is the assrt client's own MinIntervalLimiter.
//
// Usage:
//   npx tsx scripts/record-provider-responses.ts --type anime --form only-pack \
//     --title "Attack on Titan" [--original 進撃の巨人] [--season 1 --episode 1 --year 2013]
//
// Requires ASSRT_TOKEN in .env. Writes fixtures/v3-live/<type>/<form>/responses/*.json.
// Re-running REPLACES the cell's responses/ wholesale (one invocation = one clean mint) — stale
// recordings from earlier runs never survive, so re-record freely until the cell looks right.
// You still hand-author cell.json's `expected` (the correct answer) — the recorder only captures
// what the source returned; deciding which candidate is CORRECT is the human's job.
import { parseArgs } from 'node:util'
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import 'dotenv/config'
import { AssrtClient } from '../src/adapters/providers/assrt.js'
import { makeAssrtAdapter } from '../src/cli/adapters/assrtAdapter.js'
import type { FetchAdapter, FetchArgs } from '../src/cli/fetchLib.js'
import { runSearch, runResolve } from '../src/cli/fetchLib.js'
import { makeRecordingFetch } from '../src/testing/replayFetch.js'
import { cellDir, RESOURCE_TYPES, SOURCE_FORMS, type ResourceType, type SourceForm } from '../src/testing/liveMatrix.js'

if (process.env.VITEST) throw new Error('recorder must not run under vitest — it hits real providers')

const { values } = parseArgs({ options: {
  type: { type: 'string' }, form: { type: 'string' }, title: { type: 'string' },
  original: { type: 'string' }, season: { type: 'string' }, episode: { type: 'string' }, year: { type: 'string' },
} })
const rawType = values.type as ResourceType | undefined
const rawForm = values.form as SourceForm | undefined
if (!rawType || !RESOURCE_TYPES.includes(rawType) || !rawForm || !SOURCE_FORMS.includes(rawForm) || !values.title) {
  console.error(`usage: npx tsx scripts/record-provider-responses.ts --type <${RESOURCE_TYPES.join('|')}> --form <${SOURCE_FORMS.join('|')}> --title <title> [--original --season --episode --year]`)
  process.exit(1)
}
// Re-bind to freshly-annotated consts: narrowing above only holds within this synchronous scope —
// TS does not carry the narrowed (non-undefined) type into main(), a separately-declared closure.
const type: ResourceType = rawType
const form: SourceForm = rawForm
const title: string = values.title

/** At replay, an ambiguous path bucket (>=2 recordings for one method+path, none exact-matching
 *  the model's query) makes makeReplayFetch throw — but that error does NOT surface as THREW in
 *  the matrix runner: runSearch catches per-adapter errors into a provider_error event that
 *  makeSearchSourceTool discards, so the model just sees zero candidates and honestly finalizes
 *  no_safe_match. A fixture problem masquerading as a model-judgment failure — poison for the
 *  auto-research loop. Warn LOUDLY at mint time instead, when the human can still fix it. */
function warnAmbiguousPaths(responsesDir: string): void {
  const byPath = new Map<string, string[]>()
  for (const f of readdirSync(responsesDir).filter(f => f.endsWith('.json'))) {
    const { signature } = JSON.parse(readFileSync(join(responsesDir, f), 'utf8')) as { signature: string }
    // signature is "METHOD origin/path[?query][#bodytag]" — path bucket = up to the '?' or '#'
    // (same rule makeReplayFetch uses to build its fallback buckets).
    const path = signature.replace(/[?#].*$/, '')
    const list = byPath.get(path) ?? []
    list.push(f)
    byPath.set(path, list)
  }
  for (const [path, files] of byPath) {
    if (files.length > 1) {
      console.error(`WARNING: AMBIGUOUS AT REPLAY: ${files.length} recordings share path ${path} — a model query that doesn't exactly match any recorded signature will throw (and surface as a silent zero-candidate no_safe_match in the matrix runner, not as THREW). Consider deleting all but one: ${files.join(', ')}`)
    }
  }
}

async function main() {
  const responsesDir = join(cellDir(type, form), 'responses')
  // One invocation = one clean mint: wipe any previous recordings first, so a rerun never mixes
  // fresh responses with stale residue (e.g. a detail/download recorded for a DIFFERENT top
  // candidate on an earlier run, or partial files left behind by a mid-run crash).
  rmSync(responsesDir, { recursive: true, force: true })
  mkdirSync(responsesDir, { recursive: true })
  const recording = makeRecordingFetch(responsesDir)

  // Throwaway cache dir — deliberately OUTSIDE responsesDir (a prior draft put it at
  // `responsesDir/.throwaway-cache`, which would have polluted the fixture dir the recorder
  // just minted). AssrtClient's own cache is irrelevant here: every call must actually hit the
  // network so the recording fetch tees it, so the cache dir just needs to be fresh and elsewhere.
  const throwawayCacheDir = join(tmpdir(), `scout-record-cache-${Date.now()}`)

  const adapters: FetchAdapter[] = []
  if (process.env.ASSRT_TOKEN) {
    const client = new AssrtClient({
      token: process.env.ASSRT_TOKEN, cacheDir: throwawayCacheDir, fetchImpl: recording,
    })
    adapters.push(makeAssrtAdapter(client))
  }
  if (adapters.length === 0) throw new Error('set ASSRT_TOKEN in .env to record')

  try {
    const queries = [title, values.original].filter((v): v is string => Boolean(v))
    const args: FetchArgs = {
      queries, year: values.year ? Number(values.year) : undefined,
      season: values.season ? Number(values.season) : undefined,
      episode: values.episode ? Number(values.episode) : undefined,
      filename: undefined, languages: ['zh-cn', 'zh-tw'], deep: true,
    }
    const emit = (e: unknown) => console.error('[event]', JSON.stringify(e))
    const candidates = await runSearch(args, adapters, emit)
    console.error(`recorded search → ${candidates.length} candidate(s)`)
    candidates.forEach((c, i) => console.error(`  [${i}] ${c.provider}:${c.providerId} "${c.videoName ?? c.nativeName}" files=${c.fileList.length}`))

    // Also record detail/download for the top candidate so the download path is replayable. Pick
    // fileIndex 0 (or the pack entry you intend as the answer — re-run with the right one noted).
    if (candidates.length > 0) {
      const top = candidates[0]
      const fileIndex = top.fileList.length > 0 ? 0 : null
      const resolved = await runResolve({ provider: top.provider, providerId: top.providerId, fileIndex }, adapters, emit)
      console.error(`recorded detail+resolve → ${resolved.url}`)
      // Fetch the actual subtitle bytes THROUGH the recording fetch so the download lands too.
      const res = await recording(resolved.url, resolved.headers ? { headers: resolved.headers } : undefined)
      console.error(`recorded download → ${res.status}, ${res.headers.get('content-type')}`)
    }
    warnAmbiguousPaths(responsesDir)
    console.error(`\nresponses written to ${responsesDir}`)
    console.error(`Next: hand-author ${cellDir(type, form)}/cell.json (task + the CORRECT expected answer), set the catalog entry seeded:true, run vitest.`)
  } finally {
    rmSync(throwawayCacheDir, { recursive: true, force: true })
  }
}
main().catch(e => { console.error(e); process.exit(1) })
