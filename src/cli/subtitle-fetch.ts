import 'dotenv/config'
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { runSearch, runResolve, type FetchAdapter, type FetchArgs, type FetchEvent } from './fetchLib.js'
import { makeAssrtAdapter } from './adapters/assrtAdapter.js'
import { makeOpenSubtitlesAdapter } from './adapters/opensubtitlesAdapter.js'
import { parseCandidateKey, type CandidateRef } from '../core/schemas.js'

const emit = (e: FetchEvent) => process.stderr.write(JSON.stringify(e) + '\n')

function buildAdapters(): FetchAdapter[] {
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
    if (!parsed) { process.stderr.write(JSON.stringify({ error: `unknown provider ${values.provider}` }) + '\n'); process.exit(1) }
    const ref: CandidateRef = { ...parsed, fileIndex: values['file-index'] != null ? Number(values['file-index']) : null }
    const out = await runResolve(ref, buildAdapters(), emit)
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
  const candidates = await runSearch(args, buildAdapters(), emit)
  process.stdout.write(JSON.stringify(candidates) + '\n')
}

main().catch(e => { process.stderr.write(JSON.stringify({ error: String(e) }) + '\n'); process.exit(1) })
