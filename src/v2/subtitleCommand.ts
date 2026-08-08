// src/v2/subtitleCommand.ts：字幕 CLI（新架构阶段 4）
// 用法：node dist/v2/subtitleCommand.js [workId] — 不传则处理字幕队列第一个作品
// 对一个作品（一簇）跑字幕 agent：搜索→验证→装盘。
import { openDb } from './db.js'
import { listSubtitleQueue, runSubtitleWorkDir } from './subtitleScheduler.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { makeModel } from '../agent/llm.js'
import { buildAdapters } from '../adapters/buildAdapters.js'

async function main() {
  const db = openDb('/cache/scout.db')
  const model = makeModel({
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model: process.env.LLM_MODEL!,
  })
  const adapters = await buildAdapters((e) => {})
  const worker = makeFindSubtitleWorker({
    model,
    adapters,
    cacheRoot: '/cache',
    tmdb: null, // 字幕 worker 不需要识别工具
  })

  const queue = listSubtitleQueue(db)
  if (queue.length === 0) { console.log('字幕队列为空'); db.close(); return }
  console.log(`字幕队列 ${queue.length} 个作品，处理第一个：`)
  console.log(`  ${queue[0].title} (${queue[0].workId}) ${queue[0].files.length} 文件`)

  const report = await runSubtitleWorkDir(worker, queue[0], 'zh')
  console.log(`结果: installed=${report.installed.length} no_safe_match=${report.no_safe_match.length} retry_later=${report.retry_later.length}`)
  for (const i of report.installed.slice(0, 5)) {
    console.log(`  装盘: ${i.installedPath}`)
  }
  db.close()
}

main().catch(e => { console.error(e); process.exit(1) })
