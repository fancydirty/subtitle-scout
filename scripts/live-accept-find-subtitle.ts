// Manual live-acceptance runner — NOT wired into `npm test`. Requires real env vars (LLM_*,
// provider credentials) and a real filesystem path; refuses to run under `vitest`/CI.
//
// Usage:
//   npx tsx scripts/live-accept-find-subtitle.ts --video <path> --title <title> \
//     [--year N --season N --episode N --root <mediaRoot>]
//
// See docs/design/2026-07-13-v3-live-acceptance-checklist.md for the full manual procedure this
// script implements one step of.
import { parseArgs } from 'node:util'
import { dirname, basename, join } from 'node:path'
import { homedir } from 'node:os'
import 'dotenv/config'
import { makeModel } from '../src/agent/llm.js'
import { makeFindSubtitleWorker } from '../src/agent/findSubtitleWorker.js'
import type { FindSubtitleTask } from '../src/agent/findSubtitleWorker.schemas.js'
import type { FetchAdapter } from '../src/cli/fetchLib.js'
import { makeAssrtAdapter } from '../src/cli/adapters/assrtAdapter.js'
import { makeOpenSubtitlesAdapter } from '../src/cli/adapters/opensubtitlesAdapter.js'
import { makeZimukuAdapter } from '../src/cli/adapters/zimukuAdapter.js'
import { AssrtClient } from '../src/adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../src/adapters/providers/opensubtitles.js'
import { ZimukuClient } from '../src/adapters/providers/zimuku.js'
import { ZimukuSessionStore } from '../src/adapters/providers/zimukuSession.js'
import { createLlmRuntime } from '../src/agent/runtime.js'
import { ProfileStore } from '../src/agent/profile.js'
import { solveNumericCaptcha } from '../src/agent/solveNumericCaptcha.js'

if (process.env.VITEST) {
  throw new Error('live-accept-find-subtitle.ts must not run under vitest — it hits real network and a real LLM')
}

const { values } = parseArgs({
  options: {
    video: { type: 'string' }, title: { type: 'string' }, year: { type: 'string' },
    season: { type: 'string' }, episode: { type: 'string' }, root: { type: 'string' },
  },
})
if (!values.video || !values.title) {
  console.error('usage: npx tsx scripts/live-accept-find-subtitle.ts --video <path> --title <title> [--year N --season N --episode N --root <mediaRoot>]')
  process.exit(1)
}

function requireEnvForZimuku(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`ZIMUKU_ENABLED=true requires ${name} (captcha solving needs a multimodal LLM) — set it alongside your other LLM_* vars`)
  return v
}

/**
 * Deliberately NOT imported from src/cli/subtitle-fetch.ts, even though that file already has an
 * (unexported) buildAdapters() doing the same job: subtitle-fetch.ts calls `main().catch(...)`
 * unconditionally at module scope with no import-guard (no ESM equivalent of `require.main ===
 * module` is used there) — importing anything from that module here would run its CLI `main()`
 * as a side effect of merely loading this script (parsing process.argv, hitting the network).
 * This function mirrors subtitle-fetch.ts's buildAdapters() construction (same env vars, same
 * client wiring) without that hazard.
 *
 * PLAN-BUG DISCIPLINE finding: the plan's literal Task 7 script called `new ZimukuClient()` with
 * zero arguments and `new OpenSubtitlesClient({ apiKey: ... })` with only apiKey. Neither
 * typechecks against the real constructors: ZimukuClientOpts (src/adapters/providers/zimuku.ts)
 * requires `sessionStore: ZimukuSessionStore` and `solve: (imageBytes) => Promise<{ digits:
 * string }>` with no defaults; OsClientOpts (src/adapters/providers/opensubtitles.ts) requires
 * `appUserAgent: string` with no default. Verified by reading both interfaces directly. Wired
 * here with the same real construction subtitle-fetch.ts's buildAdapters() already uses in
 * production (ZimukuSessionStore + solveNumericCaptcha via a throwaway LlmRuntime for the
 * multimodal captcha-solve step — a narrow, self-contained utility, not the old forced-tool-call
 * judgment path this whole v3 phase replaces).
 */
async function buildAdapters(cacheRoot: string): Promise<FetchAdapter[]> {
  const adapters: FetchAdapter[] = []

  if (process.env.ASSRT_TOKEN) {
    const client = new AssrtClient({ token: process.env.ASSRT_TOKEN, cacheDir: join(cacheRoot, 'assrt-responses') })
    adapters.push(makeAssrtAdapter(client))
  }

  if (process.env.OPENSUBTITLES_API_KEY) {
    const client = new OpenSubtitlesClient({
      apiKey: process.env.OPENSUBTITLES_API_KEY,
      appUserAgent: 'subtitlescout live-accept',
      username: process.env.OPENSUBTITLES_USERNAME,
      password: process.env.OPENSUBTITLES_PASSWORD,
    })
    adapters.push(makeOpenSubtitlesAdapter(client))
  }

  if (process.env.ZIMUKU_ENABLED === 'true') {
    // Captcha solving needs a multimodal LLM call — reuses solveNumericCaptcha (a clean,
    // narrow tool per the phase ③ reuse map) via a throwaway LlmRuntime, independent of the
    // find-subtitle worker's own ToolLoopAgent/reasoning:'high' model above.
    const llm = await createLlmRuntime({
      baseUrl: requireEnvForZimuku('LLM_BASE_URL'),
      apiKey: requireEnvForZimuku('LLM_API_KEY'),
      model: requireEnvForZimuku('LLM_MODEL'),
    }, new ProfileStore(join(cacheRoot, 'llm-profiles')))
    const client = new ZimukuClient({
      sessionStore: new ZimukuSessionStore(join(cacheRoot, 'zimuku-session')),
      solve: async png => (await solveNumericCaptcha(llm, png)).parsed,
    })
    adapters.push(makeZimukuAdapter(client))
  }

  return adapters
}

async function main() {
  const model = makeModel({
    baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY!, model: process.env.LLM_MODEL!,
  })
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const adapters = await buildAdapters(cacheRoot)
  if (adapters.length === 0) throw new Error('no provider credentials configured — set ASSRT_TOKEN/OPENSUBTITLES_API_KEY/ZIMUKU_ENABLED=true')

  const mediaRoot = values.root ?? dirname(values.video!)
  const runTask = makeFindSubtitleWorker({ model, adapters, cacheRoot: join(cacheRoot, 'live-accept'), stepCap: 500 })

  const task: FindSubtitleTask = {
    jobId: `live-accept-${Date.now()}`, mediaRoot, videoPath: values.video!, videoFilename: basename(values.video!),
    title: values.title!, originalTitle: null, year: values.year ? Number(values.year) : null,
    season: values.season ? Number(values.season) : null, episode: values.episode ? Number(values.episode) : null,
    absoluteEpisode: null,
    alternativeTitles: [], overview: null, runtimeMinutes: null, providerIds: {},
  }

  const decision = await runTask(task)
  console.log(JSON.stringify(decision, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
