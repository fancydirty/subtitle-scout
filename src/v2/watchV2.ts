// src/v2/watchV2.ts：新架构 watch 入口（阶段 5）。
// 用法：node dist/v2/watchV2.js
// 组装 daemonV2 的全部依赖：扫描器 + 识别 agent + 字幕 worker + 调度器。
import { openDb } from './db.js'
import { ScoutDaemonV2 } from './daemonV2.js'
import { runIdentify } from '../agent/identifyWorker.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { makeModel } from '../agent/llm.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import { buildAdapters } from '../adapters/buildAdapters.js'
import type { IdentifySchedulerDeps } from './identifyScheduler.js'
import { makeFileLogger } from '../core/fileLogger.js'
import { probeEmbeddedSubtitles, probeDurationSec } from '../files/streamProbe.js'

async function main() {
  const cacheRoot = '/cache'
  const db = openDb(`${cacheRoot}/scout.db`)
  const fileLog = makeFileLogger(`${cacheRoot}/logs`, 30)
  const log = (msg: string) => {
    const line = `[watchV2 ${new Date().toISOString()}] ${msg}`
    console.log(line)
    fileLog(msg)
  }

  // 守备目录（从 media_roots 表读）
  const roots = (db.prepare('SELECT path FROM media_roots ORDER BY path').all() as { path: string }[])
    .map(r => r.path)
  log(`media roots: ${roots.join(', ')}`)

  const tmdb = new TmdbClient({ apiKey: process.env.TMDB_API_KEY! })
  const model = makeModel({
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model: process.env.LLM_MODEL!,
  })

  const identifyDeps: IdentifySchedulerDeps = {
    db,
    runIdentify,
    worker: {
      model,
      tmdb: {
        search: (mt, q, y) => tmdb.search(mt, q, y),
        getDetails: async (mt, id) => {
          const d = await tmdb.getDetails(mt, id)
          if (!d) return null
          const chinese = await tmdb.getChineseTitles(mt, id).catch(() => [])
          const ol = await tmdb.getOriginLanguage(mt, id).catch(() => null)
          return { id: Number(id), title: d.title || d.originalTitle || String(id), originalTitle: d.originalTitle ?? null, year: d.year, overview: d.overview, posterPath: d.posterPath, genreIds: d.genreIds, originLanguage: ol, chineseTitles: chinese }
        },
      },
    },
  }

  const adapters = await buildAdapters((e) => {})
  const subtitleWorker = makeFindSubtitleWorker({ model, adapters, cacheRoot, tmdb: null })

  const daemon = new ScoutDaemonV2({
    db,
    roots,
    identify: identifyDeps,
    subtitleWorker,
    targetLanguage: process.env.TARGET_LANGUAGES?.split(',')[0]?.trim() || 'zh',
    // C12：探针接线。复用 files/streamProbe.ts 的两个既有实现（cli/index.ts 给 ingest 接的是
    // 同一对函数），**不写第二份**——本仓已经因为"两份实现漂移"栽过（D7 的 findOverlappingRoot）。
    // 漏了这两行的后果是"测试绿、生产漏"：files.embedded_langs 继续全 NULL，
    // judge 规则 2 与 D9 的 translatable 照旧静默失效。
    probe: (videoPath: string) => probeEmbeddedSubtitles(videoPath),
    probeDuration: (videoPath: string) => probeDurationSec(videoPath),
    log,
  })

  log('daemonV2 starting...')
  const shutdown = new AbortController()
  process.on('SIGINT', () => shutdown.abort())
  process.on('SIGTERM', () => shutdown.abort())
  await daemon.run(shutdown.signal)
  db.close()
  process.exit(0)
}

main().catch(e => { console.error(e); process.exit(1) })
