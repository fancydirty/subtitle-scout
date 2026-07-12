import 'dotenv/config'
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { ZimukuClient } from '../adapters/providers/zimuku.js'
import { ZimukuSessionStore } from '../adapters/providers/zimukuSession.js'
import { runSearch, runResolve, type FetchAdapter, type FetchArgs, type FetchEvent } from './fetchLib.js'
import { makeAssrtAdapter } from './adapters/assrtAdapter.js'
import { makeOpenSubtitlesAdapter } from './adapters/opensubtitlesAdapter.js'
import { makeZimukuAdapter } from './adapters/zimukuAdapter.js'
import { parseCandidateKey, type CandidateRef } from '../core/schemas.js'
import { createLlmRuntime } from '../agent/runtime.js'
import { ProfileStore } from '../agent/profile.js'
import { solveNumericCaptcha } from '../agent/solveNumericCaptcha.js'

const emit = (e: FetchEvent) => process.stderr.write(JSON.stringify(e) + '\n')

function requireEnvForZimuku(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`ZIMUKU_ENABLED=true requires ${name} (captcha solving needs a multimodal LLM) — set it alongside your other LLM_* vars`)
  return v
}

async function buildAdapters(): Promise<FetchAdapter[]> {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const adapters: FetchAdapter[] = []

  if (process.env.ASSRT_TOKEN) {
    const client = new AssrtClient({
      token: process.env.ASSRT_TOKEN,
      cacheDir: join(cacheRoot, 'assrt-responses'),
      onApiCall: r => emit({ event: 'api_call', provider: 'assrt', ...r }),
    })
    adapters.push(makeAssrtAdapter(client))
  }

  if (process.env.OPENSUBTITLES_API_KEY) {
    const client = new OpenSubtitlesClient({
      apiKey: process.env.OPENSUBTITLES_API_KEY,
      appUserAgent: 'subtitlescout v0.2.0',
      username: process.env.OPENSUBTITLES_USERNAME,
      password: process.env.OPENSUBTITLES_PASSWORD,
      onApiCall: r => emit({ event: 'api_call', provider: 'opensubtitles', ...r }),
    })
    adapters.push(makeOpenSubtitlesAdapter(client))
  }

  if (process.env.ZIMUKU_ENABLED === 'true') {
    // 验证码破解需要多模态 LLM——子进程独立构建一份 LlmRuntime(继承父进程 env,含 LLM_* 变量;
    // ProfileStore 磁盘缓存,冷启动只探测一次)。只在真的撞见挑战页时才会被调用,不是每次
    // search/resolve 都要打一次 LLM。
    const llm = await createLlmRuntime({
      baseUrl: requireEnvForZimuku('LLM_BASE_URL'),
      apiKey: requireEnvForZimuku('LLM_API_KEY'),
      model: requireEnvForZimuku('LLM_MODEL'),
    }, new ProfileStore(join(cacheRoot, 'llm-profiles')))
    const client = new ZimukuClient({
      sessionStore: new ZimukuSessionStore(join(cacheRoot, 'zimuku-session')),
      solve: async png => (await solveNumericCaptcha(llm, png)).parsed,
      onApiCall: r => emit({ event: 'api_call', provider: 'zimuku', ...r }),
    })
    adapters.push(makeZimukuAdapter(client))
  }
  return adapters
}

async function main() {
  const isResolve = process.argv[2] === 'resolve'
  const rawArgs = isResolve ? process.argv.slice(3) : process.argv.slice(2)
  if (isResolve) {
    const { values } = parseArgs({ args: rawArgs, options: {
      provider: { type: 'string' }, id: { type: 'string' }, 'file-index': { type: 'string' },
    } })
    const parsed = parseCandidateKey(`${values.provider}:${values.id}`)
    if (!parsed) {
      process.stderr.write(JSON.stringify({ error: `unknown provider ${values.provider}` }) + '\n')
      process.exitCode = 1
      return
    }
    const ref: CandidateRef = { ...parsed, fileIndex: values['file-index'] != null ? Number(values['file-index']) : null }
    const out = await runResolve(ref, await buildAdapters(), emit)
    process.stdout.write(JSON.stringify(out) + '\n')
    return
  }
  const { values } = parseArgs({ args: rawArgs, options: {
    query: { type: 'string', multiple: true }, imdb: { type: 'string' }, year: { type: 'string' },
    season: { type: 'string' }, episode: { type: 'string' }, filename: { type: 'string' },
    languages: { type: 'string' }, deep: { type: 'boolean', default: false }, format: { type: 'string', default: 'json' },
  } })
  const args: FetchArgs = {
    queries: values.query ?? [],
    imdb: values.imdb, year: values.year ? Number(values.year) : undefined,
    season: values.season ? Number(values.season) : undefined,
    episode: values.episode ? Number(values.episode) : undefined,
    filename: values.filename,
    languages: values.languages?.split(',').map(s => s.trim().toLowerCase()),
    deep: values.deep!,
  }
  const candidates = await runSearch(args, await buildAdapters(), emit)
  process.stdout.write(JSON.stringify(candidates) + '\n')
}

main().catch(e => {
  process.stderr.write(JSON.stringify({ error: String(e) }) + '\n')
  process.exitCode = 1
})
