import 'dotenv/config'
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient, toCandidate } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient, osToCandidates } from '../adapters/providers/opensubtitles.js'
import { runSearch, runResolve, type FetchAdapter, type FetchArgs, type FetchEvent } from './fetchLib.js'
import { parseCandidateKey, type CandidateRef } from '../core/schemas.js'

const emit = (e: FetchEvent) => process.stderr.write(JSON.stringify(e) + '\n')
const imdbDigits = (s: string | undefined) => s ? Number(s.replace(/^tt/, '')) : undefined

function buildAdapters(): FetchAdapter[] {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const adapters: FetchAdapter[] = []

  if (process.env.ASSRT_TOKEN) {
    const client = new AssrtClient({
      token: process.env.ASSRT_TOKEN,
      cacheDir: join(cacheRoot, 'assrt-responses'),
      onApiCall: r => emit({ event: 'api_call', provider: 'assrt', ...r }),
    })
    adapters.push({
      name: 'assrt',
      enabled: () => true,
      search: async (args) => {
        const byId = new Map<number, ReturnType<typeof toCandidate>>()
        for (const q of args.queries.slice(0, 2)) {
          const resp = await client.search(q)
          for (const s of resp.sub.subs) if (!byId.has(s.id)) byId.set(s.id, toCandidate(s))
        }
        // gems: 有命中→similar 扩召回；零命中→整文件名兜底
        if (byId.size > 0) {
          const top = [...byId.keys()][0]
          try {
            const sim = await client.similar(top)
            for (const s of sim.sub.subs) if (!byId.has(s.id)) byId.set(s.id, toCandidate(s))
          } catch { /* gems 失败不影响主结果 */ }
        } else if (args.filename) {
          const byFile = await client.searchByFilename(args.filename)
          for (const s of byFile.sub.subs) byId.set(s.id, toCandidate(s))
        }
        return [...byId.values()]
      },
      resolve: async (ref) => {
        const detail = await client.detail(Number(ref.providerId))
        const sub = detail.sub.subs.find(s => String(s.id) === ref.providerId) ?? detail.sub.subs[0]
        if (!sub) throw new Error(`assrt detail ${ref.providerId} returned no subs`)
        const entry = ref.fileIndex != null ? sub.filelist[ref.fileIndex] : undefined
        const url = entry?.url ?? sub.url
        if (!url) throw new Error(`assrt ${ref.providerId} has no download url`)
        return { url, filename: entry?.f ?? sub.filename ?? undefined }
      },
    })
  }

  if (process.env.OPENSUBTITLES_API_KEY) {
    const client = new OpenSubtitlesClient({
      apiKey: process.env.OPENSUBTITLES_API_KEY,
      appUserAgent: 'subtitlescout v0.2.0',
      username: process.env.OPENSUBTITLES_USERNAME,
      password: process.env.OPENSUBTITLES_PASSWORD,
      onApiCall: r => emit({ event: 'api_call', provider: 'opensubtitles', ...r }),
    })
    adapters.push({
      name: 'opensubtitles',
      enabled: () => true,
      search: async (args) => {
        const languages = args.languages ?? ['zh-cn', 'zh-tw']
        const imdb = imdbDigits(args.imdb)
        const resp = await client.search(args.season != null
          ? { parentImdbId: imdb, season: args.season, episode: args.episode, query: imdb ? undefined : args.queries[0], year: args.year, languages }
          : { imdbId: imdb, query: imdb ? undefined : args.queries[0], year: args.year, languages })
        return osToCandidates(resp)
      },
      resolve: async (ref) => {
        const r = await client.resolveDownload(Number(ref.providerId))
        return { url: r.link, filename: r.file_name ?? undefined }
      },
    })
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
