// src/v2/identifyCommand.ts：识别 CLI（新架构阶段 2，容器内跑）
// 用法：node dist/v2/identifyCommand.js [workDir] — 不传则处理识别队列第一项
// 把识别队列里未识别的 work_dir 交给识别 agent，写库。
import { openDb } from './db.js'
import { listIdentifyQueue, runIdentifyWorkDir, type IdentifySchedulerDeps } from './identifyScheduler.js'
import { runIdentify } from '../agent/identifyWorker.js'
import { makeModel } from '../agent/llm.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'

async function main() {
  const db = openDb('/cache/scout.db')
  const now = Date.now()

  const tmdb = new TmdbClient({ apiKey: process.env.TMDB_API_KEY! })
  const model = makeModel({
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model: process.env.LLM_MODEL!,
  })

  const deps: IdentifySchedulerDeps = {
    db,
    runIdentify,
    worker: {
      model,
      tmdb: {
        search: (mediaType, query, year) => tmdb.search(mediaType, query, year),
        getDetails: async (mediaType, tmdbId) => {
          const d = await tmdb.getDetails(mediaType, tmdbId)
          if (!d) return null
          const chinese = await tmdb.getChineseTitles(mediaType, tmdbId).catch(() => [])
          const originLang = await tmdb.getOriginLanguage(mediaType, tmdbId).catch(() => null)
          return {
            id: Number(tmdbId), title: d.originalTitle ?? String(tmdbId), originalTitle: d.originalTitle ?? null,
            year: d.year, overview: d.overview, posterPath: d.posterPath,
            genreIds: d.genreIds, originLanguage: originLang, chineseTitles: chinese,
          }
        },
      },
    },
  }

  const queue = listIdentifyQueue(db, now)
  if (queue.length === 0) {
    console.log('识别队列为空')
    db.close()
    return
  }
  console.log(`识别队列 ${queue.length} 个 work_dir，处理第一个：`)
  console.log(`  ${queue[0].workDir} (${queue[0].fileCount} 文件)`)

  const report = await runIdentifyWorkDir(deps, queue[0])
  console.log(`结果: tmdbId=${report.tmdbId} title=${report.title} reason=${report.reason.slice(0, 100)}`)

  // 落库状态
  const count = db.prepare("SELECT COUNT(*) c FROM files WHERE work_id IS NOT NULL").get() as { c: number }
  const works = db.prepare('SELECT COUNT(*) c FROM works').get() as { c: number }
  console.log(`已识别文件: ${count.c}  作品数: ${works.c}`)
  db.close()
}

main().catch(e => { console.error(e); process.exit(1) })
