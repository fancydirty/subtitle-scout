// src/v2/identifyScheduler.ts：识别调度器（新架构阶段 2/3 交界面）。
// 职责：纯 SQL 挑出待识别 work_dir → 组装 WorkDirFacts → 调 runIdentify → 写库。
//
// 写库门（防幻觉）：agent 报的 tmdbId 必须通过 verifyEvidence 机械核验才落库。
// 404 终态：getDetails 返回 null → last_error='tmdb-404'，永不重试（spec-gap B2）。
import type { ScoutDb } from './db.js'
import { verifyEvidence, type TmdbEvidence } from './identify.js'
import type { IdentifyWorkerDeps, IdentifyReport, WorkDirFacts } from '../agent/identifyWorker.js'

export interface IdentifySchedulerDeps {
  db: ScoutDb
  worker: IdentifyWorkerDeps
  /** runIdentify 函数本身（从 agent/identifyWorker.js 传入——deps 不含它，避免循环） */
  runIdentify: (deps: IdentifyWorkerDeps, facts: WorkDirFacts, runKey: string) => Promise<IdentifyReport>
  now?: () => number
  runKey?: (workDir: string) => string
}

export interface IdentifyQueueItem {
  workDir: string
  dirName: string
  fileCount: number
  seasons: number[]
  hasSeasonDirs: boolean
}

/** 识别队列：work_id IS NULL 且（退避窗已过）且（非 404 终态）。
 *  一次一个 work_dir（串行，TMDB 配额敏感）。 */
export function listIdentifyQueue(db: ScoutDb, now: number): IdentifyQueueItem[] {
  const rows = db.prepare(`
    SELECT work_dir,
           COUNT(*) AS file_count,
           SUM(CASE WHEN season IS NOT NULL THEN 1 ELSE 0 END) AS with_season
    FROM files
    WHERE work_id IS NULL
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
      AND (last_error IS NULL OR last_error != 'tmdb-404')
    GROUP BY work_dir
    ORDER BY MIN(attempt), MIN(id)
  `).all(now) as Array<{ work_dir: string; file_count: number; with_season: number }>

  return rows.map(r => {
    const dirName = r.work_dir.slice(r.work_dir.lastIndexOf('/') + 1)
    return {
      workDir: r.work_dir,
      dirName,
      fileCount: r.file_count,
      seasons: [],
      hasSeasonDirs: r.with_season > 0,
    }
  })
}

export function buildFacts(db: ScoutDb, item: IdentifyQueueItem): WorkDirFacts {
  const files = db.prepare(`
    SELECT filename, season, episode, parse_confidence AS confidence
    FROM files WHERE work_dir = ?
  `).all(item.workDir) as Array<{ filename: string; season: number | null; episode: number | null; confidence: string | null }>
  const seasons = new Set<number>()
  for (const f of files) if (f.season != null) seasons.add(f.season)
  return {
    workDir: item.workDir,
    dirName: item.dirName,
    fileCount: files.length,
    seasons: [...seasons],
    hasSeasonDirs: item.hasSeasonDirs,
    files: files.map(f => ({
      filename: f.filename,
      season: f.season,
      episode: f.episode,
      confidence: f.confidence ?? 'none',
    })),
  }
}

/** 执行识别：跑 worker → 写库。返回报告。 */
export async function runIdentifyWorkDir(
  deps: IdentifySchedulerDeps,
  item: IdentifyQueueItem,
): Promise<IdentifyReport> {
  const now = deps.now?.() ?? Date.now()
  const runKey = deps.runKey?.(item.workDir) ?? `identify:${item.workDir}`
  const facts = buildFacts(deps.db, item)

  // writeIdentified 执行体：verifyEvidence 机械核验 + 事务写库
  const writeIdentified = async (input: { tmdbId: string; isTv: boolean; title: string; files: Array<{ filename: string; season: number | null; episode: number | null }> }) => {
    // 先查 TMDB 详情做核验
    const mediaType = input.isTv ? 'tv' : 'movie'
    const details = await deps.worker.tmdb.getDetails(mediaType, input.tmdbId)
    if (!details) {
      // 404 终态：作品真不在 TMDB
      return { ok: false as const, error: 'tmdb-404' }
    }
    const evidence: TmdbEvidence = {
      id: input.tmdbId,
      title: details.title,
      year: details.year,
      mediaType,
    }
    const check = verifyEvidence(evidence, {
      dirName: facts.dirName,
      fileCount: facts.fileCount,
      seasons: facts.seasons,
      hasSeasonDirs: facts.hasSeasonDirs,
    }, facts.dirName, details.chineseTitles)
    if (!check.ok) {
      return { ok: false as const, error: `evidence-fail: ${check.reason}` }
    }

    // 写库：works 行 + files.work_id 批量更新（同一事务）
    const tx = deps.db.transaction(() => {
      deps.db.prepare(`
        INSERT OR REPLACE INTO works (id, title, original_title, year, media_type, origin_lang, overview, poster_path, chinese_titles, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `tmdb:${input.tmdbId}`,
        details.title,
        details.originalTitle,
        details.year,
        mediaType,
        details.originLanguage,
        details.overview,
        details.posterPath,
        JSON.stringify(details.chineseTitles ?? []),
        now, now,
      )
      // 按文件名匹配绑定（同一 work_dir 下的文件）
      const byFilename = new Map(facts.files.map(f => [f.filename, f]))
      const stmt = deps.db.prepare(`
        UPDATE files SET work_id = ?, season = ?, episode = ?, attempt = 0, next_retry_at = NULL, last_error = NULL, updated_at = ?
        WHERE work_dir = ? AND filename = ?
      `)
      let written = 0
      for (const f of input.files) {
        const target = byFilename.get(f.filename)
        if (!target) continue
        stmt.run(`tmdb:${input.tmdbId}`, f.season, f.episode, now, facts.workDir, f.filename)
        written++
      }
      return written
    })
    const written = tx()
    return { ok: true as const, written }
  }

  const report = await deps.runIdentify(
    { ...deps.worker, writeIdentified },
    facts,
    runKey,
  )

  // 写库结果落回 files（成功/失败/404）
  if (report.tmdbId === null) {
    // 识别失败：退避（spec-gap B2）
    const attempt = (deps.db.prepare('SELECT MAX(attempt) a FROM files WHERE work_dir = ?').get(facts.workDir) as { a: number }).a
    deps.db.prepare(`
      UPDATE files SET attempt = ?, next_retry_at = ?, last_error = ?, updated_at = ?
      WHERE work_dir = ?
    `).run(attempt + 1, now + retryDelayMs(attempt + 1), 'identify-failed', now, facts.workDir)
  }
  return report
}

/** 退避阶梯（spec-gap B2）：1h → 4h → 24h。 */
function retryDelayMs(attempt: number): number {
  if (attempt <= 0) return 60 * 60 * 1000
  if (attempt === 1) return 4 * 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}
