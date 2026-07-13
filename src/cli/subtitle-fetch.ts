import 'dotenv/config'
import { parseArgs } from 'node:util'
import { runSearch, runResolve, type FetchArgs, type FetchEvent } from './fetchLib.js'
import { parseCandidateKey, type CandidateRef } from '../core/schemas.js'
import { buildAdapters } from './buildAdapters.js'

const emit = (e: FetchEvent) => process.stderr.write(JSON.stringify(e) + '\n')

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
    const out = await runResolve(ref, await buildAdapters(emit), emit)
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
  const candidates = await runSearch(args, await buildAdapters(emit), emit)
  process.stdout.write(JSON.stringify(candidates) + '\n')
}

main().catch(e => {
  process.stderr.write(JSON.stringify({ error: String(e) }) + '\n')
  process.exitCode = 1
})
