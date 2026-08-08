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
import { isDirWritable } from '../core/mediaContext.js'

export interface DispatcherDeps {
  db: ScoutDb
  identify: IdentifySchedulerDeps
  subtitleWorker: (task: import('../agent/findSubtitleWorker.schemas.js').FindSubtitleTask) => Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport>
  targetLanguage: string
  /** 守备目录白名单——字幕队列只处理这些根内的文件（排除已移除根的残留数据）。 */
  roots: string[]
  /** 只读根缓存（115 测试目录是只读的——字幕派发会 ENOENT，识别照常）。
   *  🔴 检测一次缓存，不每 tick 探测（网络挂载上试写慢且有最终一致性残留）。 */
  writableRoots?: Map<string, boolean>
  now?: () => number
}

export interface DispatchResult {
  identifyDispatched: boolean
  subtitleDispatched: boolean
  identifyWorkDir: string | null
  subtitleTitle: string | null
}

/** 一拍：识别/字幕各最多一项。轮转（奇偶 tick 交替）——识别长跑不阻塞字幕（M-4）。 */
export async function dispatchOnce(deps: DispatcherDeps, tick: number): Promise<DispatchResult> {
  const now = deps.now?.() ?? Date.now()
  const result: DispatchResult = { identifyDispatched: false, subtitleDispatched: false, identifyWorkDir: null, subtitleTitle: null }

  // 只读根检测（缓存）：字幕派发只在可写根内进行（115 只读 → 跳过字幕，识别照常）
  const writableCache = deps.writableRoots ?? new Map<string, boolean>()
  const writableRoots = () => {
    const out: string[] = []
    for (const root of deps.roots) {
      if (!writableCache.has(root)) {
        writableCache.set(root, isDirWritable(root))
      }
      if (writableCache.get(root)) out.push(root)
    }
    return out
  }

  // 轮转：奇数 tick 先识别，偶数 tick 先字幕（M-4——识别 30min 长跑不阻塞字幕）
  const identifyFirst = tick % 2 === 1
  const wRoots = writableRoots()

  if (identifyFirst) {
    const identifyQueue = listIdentifyQueue(deps.db, now)
    if (identifyQueue.length > 0) {
      const report = await runIdentifyWorkDir(deps.identify, identifyQueue[0])
      result.identifyDispatched = true
      result.identifyWorkDir = identifyQueue[0].workDir
      console.error(`[dispatcher] identify: ${identifyQueue[0].workDir} → tmdbId=${report.tmdbId}`)
    }
    if (wRoots.length > 0) {
      const subtitleQueue = listSubtitleQueue(deps.db, wRoots)
      if (subtitleQueue.length > 0) {
        const item = subtitleQueue[0]
        await runSubtitleWorkDir(deps.db, deps.subtitleWorker, item, deps.targetLanguage)
        result.subtitleDispatched = true
        result.subtitleTitle = item.title
        console.error(`[dispatcher] subtitle: ${item.title} (${item.files.length} files)`)
      }
    }
  } else {
    if (wRoots.length > 0) {
      const subtitleQueue = listSubtitleQueue(deps.db, wRoots)
      if (subtitleQueue.length > 0) {
        const item = subtitleQueue[0]
        await runSubtitleWorkDir(deps.db, deps.subtitleWorker, item, deps.targetLanguage)
        result.subtitleDispatched = true
        result.subtitleTitle = item.title
        console.error(`[dispatcher] subtitle: ${item.title} (${item.files.length} files)`)
      }
    }
    const identifyQueue = listIdentifyQueue(deps.db, now)
    if (identifyQueue.length > 0) {
      const report = await runIdentifyWorkDir(deps.identify, identifyQueue[0])
      result.identifyDispatched = true
      result.identifyWorkDir = identifyQueue[0].workDir
      console.error(`[dispatcher] identify: ${identifyQueue[0].workDir} → tmdbId=${report.tmdbId}`)
    }
  }

  return result
}
