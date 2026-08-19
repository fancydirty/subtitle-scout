// Live acceptance for the translate workspace agent (P1) — REAL model, REAL agent loop,
// REAL workspace on disk. Local-only: the video is a fixture stand-in (extracted real source
// subtitle + known duration), install writes next to the fixture, never to production media.
//
// Usage:
//   npx tsx scripts/live-translate-agent.ts \
//     --sample /path/to/sampleDir --origin ja --source-file source-jpn.srt \
//     --track-lang jpn --duration 1440 --title "SPY x FAMILY S3E01" \
//     --item-id tmdb:123/s3e1 --model strong [--max-cues 120] [--context-zh ctx.zh-Hans.ass]
//
// sampleDir becomes the staging root (workspace kept for audit) AND the install target dir.
import 'dotenv/config'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { makeModel } from '../src/agent/llm.js'
import { makeTranslateWorker } from '../src/agent/translateWorker.js'
import type { TranslateReport } from '../src/agent/translateWorker.schemas.js'
import { findExternalSidecar } from '../src/files/sidecar.js'
import { openDb } from '../src/v2/db.js'
import { GlossaryRepo } from '../src/v2/glossaryRepo.js'

const { values } = parseArgs({
  options: {
    sample: { type: 'string' },
    origin: { type: 'string' },
    'source-file': { type: 'string' },
    'track-lang': { type: 'string' },
    duration: { type: 'string' },
    title: { type: 'string', default: 'Fixture' },
    'item-id': { type: 'string', default: 'fixture:s1e1' },
    model: { type: 'string', default: 'strong' },
    'max-cues': { type: 'string' },
    'context-zh': { type: 'string' },
    'context-tmdb': { type: 'string' },
    'step-cap': { type: 'string' },
    'timeout-ms': { type: 'string' },
    'glossary-db': { type: 'string' },
  },
})

function required(name: string, v: string | undefined): string {
  if (!v) { console.error(`missing --${name}`); process.exit(2) }
  return v
}

const sampleDir = resolve(required('sample', values.sample))
const origin = required('origin', values.origin)
const sourceFile = join(sampleDir, required('source-file', values['source-file']))
const trackLang = required('track-lang', values['track-lang'])
const durationSec = Number(required('duration', values.duration))
const modelKind = values.model ?? 'strong'
const maxCues = values['max-cues'] ? Number(values['max-cues']) : null

const cfg = modelKind === 'weak'
  ? {
      baseUrl: process.env.LLM_BASE_URL!,
      apiKey: process.env.LLM_API_KEY!,
      model: process.env.LLM_MODEL!,
    }
  : {
      baseUrl: (process.env.TRANSLATE_BASE_URL || process.env.LLM_BASE_URL)!,
      apiKey: (process.env.TRANSLATE_API_KEY || process.env.LLM_API_KEY)!,
      model: (process.env.TRANSLATE_MODEL || process.env.LLM_MODEL)!,
    }
if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
  console.error(`model config missing for --model ${modelKind}`)
  process.exit(2)
}

let sourceText = readFileSync(sourceFile, 'utf8')
if (maxCues) {
  // Truncate by cue count for fast iteration: cut at the (N+1)-th "-->" occurrence's block start.
  const blocks = sourceText.replace(/\r/g, '').split(/\n\n+/)
  sourceText = blocks.slice(0, maxCues).join('\n\n') + '\n'
}

const videoPath = join(sampleDir, 'fixture-video.mkv')
if (!existsSync(videoPath)) writeFileSync(videoPath, 'fixture')
mkdirSync(sampleDir, { recursive: true })

const sidecarOut = join(sampleDir, `out-${modelKind}.zh-Hans.srt`)

const db = openDb(values['glossary-db'] ? resolve(values['glossary-db']) : join(sampleDir, 'live-glossary.db'))
const glossaryRepo = new GlossaryRepo(db)

const run = makeTranslateWorker({
  model: makeModel(cfg),
  resolveDeps: {
    probe: async () => [{ lang: trackLang, codec: 'subrip', isImageBased: false }],
    extract: async () => sourceText,
  },
  install: (_vp, content) => {
    writeFileSync(sidecarOut, content, 'utf8')
    return sidecarOut
  },
  videoDurationSec: async () => durationSec,
  readExistingSidecar: (v) =>
    findExternalSidecar(v, ['zh-Hans', 'zh-Hant', 'zh', 'zh-CN', 'zh-TW', 'chs', 'cht'], existsSync)?.path ?? null,
  glossaryStore: {
    load: (k) => glossaryRepo.load(k),
    save: (k, t, at) => glossaryRepo.save(k, t, at),
  },
  fetchSeriesTargetSubs: values['context-zh']
    ? async () => readFileSync(join(sampleDir, values['context-zh']), 'utf8').slice(0, 6000)
    : undefined,
  fetchTmdbContext: values['context-tmdb']
    ? async () => readFileSync(join(sampleDir, values['context-tmdb']), 'utf8').slice(0, 4000)
    : undefined,
  stepCap: values['step-cap'] ? Number(values['step-cap']) : 500,
  timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : 1_800_000,
})

const t0 = Date.now()
let report: TranslateReport
try {
  report = await run({
    jobId: `live-${modelKind}-${Date.now()}`,
    videoPath,
    itemId: values['item-id'] ?? 'fixture:s1e1',
    originLang: origin,
    targetLanguage: 'zh',
    title: values.title ?? 'Fixture',
    mediaRoot: sampleDir,
    stagingRoot: sampleDir,
  })
} catch (e) {
  console.error('WORKER THREW:', e)
  process.exit(3)
}
const elapsedMs = Date.now() - t0

const summary = {
  sample: sampleDir, origin, model: cfg.model, modelKind, maxCues,
  durationSec, elapsedMs,
  status: report.status, reason: report.reason ?? null,
  sourceRef: report.sourceRef ?? null, sidecarPath: report.sidecarPath ?? null,
  sidecarExists: report.sidecarPath ? existsSync(report.sidecarPath) : false,
}
writeFileSync(join(sampleDir, `report-${modelKind}.json`), JSON.stringify({ ...summary, report }, null, 2))
console.log(JSON.stringify(summary, null, 2))
db.close()
process.exit(report.status === 'installed' ? 0 : 1)
