// src/v2/dispatcher.ts：机械调度器（新架构阶段 5）。
// spec: docs/design/2026-08-08-new-architecture-design.md §7
//
// 纯 SQL 驱动，无 orchestrator agent。每个 tick：
//  ① 识别队列非空 → 派识别（一次一个 work_dir，串行）
//  ② 字幕队列非空 → 派字幕（一次一个作品的一簇，串行）
//
// 识别与字幕可并行（不同资源池：TMDB vs 字幕源），但各自内部串行（配额敏感）。
import type { ScoutDb } from './db.js'
import { listIdentifyQueue, runIdentifyWorkDir, type IdentifySchedulerDeps } from './identifyScheduler.js'
import { listSubtitleQueue, runSubtitleWorkDir, type SubtitleQueueItem } from './subtitleScheduler.js'

export interface DispatcherDeps {
  db: ScoutDb
  identify: IdentifySchedulerDeps
  subtitleWorker: (task: import('../agent/findSubtitleWorker.schemas.js').FindSubtitleTask) => Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport>
  targetLanguage: string
  /** 守备目录白名单——字幕队列只处理这些根内的文件（排除已移除根的残留数据）。 */
  roots: string[]
  now?: () => number
}

export interface DispatchResult {
  identifyDispatched: boolean
  subtitleDispatched: boolean
  identifyWorkDir: string | null
  subtitleTitle: string | null
}

/** 一拍：识别队列有活就派识别，字幕队列有活就派字幕。各自最多处理一项。 */
export async function dispatchOnce(deps: DispatcherDeps): Promise<DispatchResult> {
  const now = deps.now?.() ?? Date.now()
  const result: DispatchResult = { identifyDispatched: false, subtitleDispatched: false, identifyWorkDir: null, subtitleTitle: null }

  // ① 识别队列
  const identifyQueue = listIdentifyQueue(deps.db, now)
  if (identifyQueue.length > 0) {
    const report = await runIdentifyWorkDir(deps.identify, identifyQueue[0])
    result.identifyDispatched = true
    result.identifyWorkDir = identifyQueue[0].workDir
    console.error(`[dispatcher] identify: ${identifyQueue[0].workDir} → tmdbId=${report.tmdbId}`)
  }

  // ② 字幕队列（按守备目录过滤——排除已移除根的残留）
  const subtitleQueue = listSubtitleQueue(deps.db, deps.roots)
  if (subtitleQueue.length > 0) {
    const item = subtitleQueue[0]
    await runSubtitleWorkDir(deps.db, deps.subtitleWorker, item, deps.targetLanguage)
    result.subtitleDispatched = true
    result.subtitleTitle = item.title
    console.error(`[dispatcher] subtitle: ${item.title} (${item.files.length} files)`)
  }

  return result
}
