// src/v2/subtitleScheduler.ts：字幕调度器（新架构阶段 4）。
// 职责：从 files 表挑"需要字幕的一簇"（一个作品）→ 组装 FindSubtitleTask → 调字幕 worker。
//
// 字幕 agent 的输入（用户裁决）：一个作品的全部 needs_subtitle 文件。
// 它不需要看目录树、不需要判断身份、不需要管字幕放哪——系统 harness 它。
import type { ScoutDb } from './db.js'
import type { FindSubtitleTask, FindSubtitleTargetFact } from '../agent/findSubtitleWorker.schemas.js'
import type { LanguageModel } from 'ai'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { makeRunTracer } from '../core/traceBus.js'

export interface SubtitleQueueItem {
  workId: string
  title: string
  originalTitle: string | null
  year: number | null
  overview: string | null
  chineseTitles: string[]
  mediaType: string
  files: Array<{ path: string; filename: string; season: number | null; episode: number | null; dir: string }>
}

/** 字幕队列：一个作品的一簇（needs_subtitle=1 的全部文件）。 */
export function listSubtitleQueue(db: ScoutDb): SubtitleQueueItem[] {
  const rows = db.prepare(`
    SELECT w.id AS work_id, w.title, w.original_title, w.year, w.overview, w.chinese_titles, w.media_type,
           f.path, f.filename, f.season, f.episode, f.dir
    FROM files f JOIN works w ON f.work_id = w.id
    WHERE f.needs_subtitle = 1
    ORDER BY w.id, f.season, f.episode
  `).all() as Array<{
    work_id: string; title: string; original_title: string | null; year: number | null;
    overview: string | null; chinese_titles: string | null; media_type: string;
    path: string; filename: string; season: number | null; episode: number | null; dir: string
  }>

  const byWork = new Map<string, SubtitleQueueItem>()
  for (const r of rows) {
    let item = byWork.get(r.work_id)
    if (!item) {
      let chinese: string[] = []
      try { chinese = r.chinese_titles ? JSON.parse(r.chinese_titles) : [] } catch { chinese = [] }
      item = {
        workId: r.work_id, title: r.title, originalTitle: r.original_title, year: r.year,
        overview: r.overview, chineseTitles: chinese, mediaType: r.media_type, files: [],
      }
      byWork.set(r.work_id, item)
    }
    item.files.push({ path: r.path, filename: r.filename, season: r.season, episode: r.episode, dir: r.dir })
  }
  return [...byWork.values()]
}

/** 组装 FindSubtitleTask（一个作品的一簇）。 */
export function buildSubtitleTask(item: SubtitleQueueItem, targetLanguage: string): FindSubtitleTask {
  // INNER 沙盒根：所有文件所在目录的公共祖先（同一作品通常同根，安全）
  const dirs = item.files.map(f => f.dir)
  const mediaRoot = commonDir(dirs)
  const targets: FindSubtitleTargetFact[] = item.files.map(f => ({
    itemId: null,
    videoPath: f.path,
    videoFilename: f.filename,
    season: f.season,
    episode: f.episode,
    absoluteEpisode: null,
    imdbId: null,
    runtimeMinutes: null,
    dirName: f.dir,
    durationSec: null,
    embeddedLangs: null,
    embeddedTmdbId: null,
  }))
  return {
    jobId: `subtitle:${item.workId}`,
    mediaRoot,
    workUnitKind: 'work-dir',
    title: item.title,
    originalTitle: item.originalTitle,
    year: item.year,
    alternativeTitles: item.chineseTitles,
    overview: item.overview,
    runtimeMinutes: null,
    providerIds: { tmdb: item.workId.replace('tmdb:', '') },
    targetLanguage,
    hardsubMode: 'off',
    localCandidates: [],
    targets,
  }
}

function commonDir(dirs: string[]): string {
  let candidate = dirs[0]
  while (!dirs.every(d => d === candidate || d.startsWith(candidate + '/'))) {
    const idx = candidate.lastIndexOf('/')
    if (idx <= 0) break
    candidate = candidate.slice(0, idx)
  }
  return candidate
}

/** 跑一个作品的字幕任务（复用现有 findSubtitleWorker）。
 *  worker = makeFindSubtitleWorker({ model, adapters, cacheRoot, tmdb }) 的返回值
 *  （runFindSubtitleTask），直接调用，返回 batch report。 */
export async function runSubtitleWorkDir(
  worker: (task: FindSubtitleTask) => Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport>,
  item: SubtitleQueueItem,
  targetLanguage: string,
): Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport> {
  const task = buildSubtitleTask(item, targetLanguage)
  console.error(`[subtitle-worker] subtitle:${item.workId} task with ${task.targets.length} targets`)
  return worker(task)
}
