// src/v2/identifyScheduler.ts：识别调度器（新架构阶段 2/3 交界面）。
// 职责：纯 SQL 挑出待识别 work_dir → 组装 WorkDirFacts → 调 runIdentify → 写库。
//
// 写库门（防幻觉）：agent 报的 tmdbId 必须通过 verifyEvidence 机械核验才落库。
// 404 终态：getDetails 返回 null → last_error='tmdb-404'，永不重试（spec-gap B2）。
import type { ScoutDb } from './db.js'
import { verifyEvidence, titleFromDir, type TmdbEvidence } from './identify.js'
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

  // writeIdentified 执行体：verifyEvidence 机械核验 + 事务写库。
  // 🔴 2026-08-08 实测修正：agent 经常搜了 TMDB 但不调 write 工具（9 步只 search+details）。
  // 绑定不应依赖 agent 自觉——改为 scheduler 自动执行：report 确认身份后，用文件列表 + TMDB
  // 详情自动绑定（season/episode 取 confidence 值 + 单季推导）。agent 只负责"确认身份"。
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
      originalTitle: details.originalTitle ?? null,
      year: details.year,
      mediaType,
    }
    const check = verifyEvidence(evidence, {
      dirName: facts.dirName,
      fileCount: facts.fileCount,
      seasons: facts.seasons,
      hasSeasonDirs: facts.hasSeasonDirs,
      // 🔴 2026-08-08 实测：必须用 titleFromDir 清洗后的标题（去掉年份/花括号），
      // 不能传原始 dirName——带年份的目录名会让 normalize 后的字符串多出年份数字导致
      // 永不匹配（Chainsaw Man Reze Arc 的 ': ' vs '- ' 差异 + 年份 2025 实测踩中）。
    }, titleFromDir(facts.dirName), details.chineseTitles)
    if (!check.ok) {
      return { ok: false as const, error: `evidence-fail: ${check.reason}` }
    }

    // C5：顺手采 imdb 落进 works.provider_ids。位置在 verifyEvidence **之后**——
    // 身份还没核验过就去打 external_ids 是白烧配额（evidence-fail 的目录不会写 works 行）。
    //
    // 三层结果各有不同语义，不许折叠（这三态直接决定回填 pass 会不会回来重查这一行）：
    //   · 拿到 imdb        → {tmdb, imdb}，抓源腿从此走 imdb 精确定位
    //   · TMDB 确认没有    → {tmdb}，**非 NULL**：这是"查过、确实没有"的凭据，
    //                        否则回填 pass 的 `provider_ids IS NULL` 谓词每天把它捡回来重查，
    //                        永不收敛（同 3-1 那个 pass 上 `[]` 与 NULL 必须分开的坑）
    //   · 调用失败/未接线  → null，留给回填 pass 下次重试
    // 写成 '{}' 或无条件 `{tmdb}` 都会让第三种伪装成第二种 → 一次 TMDB 抖动就永久放弃这一行。
    let providerIds: string | null = null
    if (deps.worker.tmdb.getExternalIds) {
      try {
        const ext = await deps.worker.tmdb.getExternalIds(mediaType, input.tmdbId)
        const ids: Record<string, string> = { tmdb: input.tmdbId }
        if (ext.imdbId) ids.imdb = ext.imdbId
        providerIds = JSON.stringify(ids)
      } catch {
        providerIds = null   // 增益缺席不是 blocker；回填 pass 会回来补
      }
    }

    // 写库：works 行 + files.work_id 批量更新（同一事务）
    const tx = deps.db.transaction(() => {
      // `INSERT OR REPLACE` 是**整行替换**：本次采不到时若直接绑定 null，会把上一次成功采到的
      // imdb 抹掉（用户重命名目录/手动重跑识别的路径上真实可达）。故先读一次现值兜底——
      // 丢了不至于永久缺失（回填 pass 的 `IS NULL` 谓词会把它捡回来），但那是白烧一次 TMDB，
      // 且抓源腿在两轮之间退化回文本 query。读在事务内，与写同一把锁。
      const kept = providerIds ?? ((deps.db.prepare('SELECT provider_ids FROM works WHERE id = ?')
        .get(`tmdb:${input.tmdbId}`) as { provider_ids: string | null } | undefined)?.provider_ids ?? null)
      deps.db.prepare(`
        INSERT OR REPLACE INTO works (id, title, original_title, year, media_type, origin_lang, overview, poster_path, chinese_titles, provider_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        kept,
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

  let report: IdentifyReport
  try {
    report = await deps.runIdentify(
      { ...deps.worker, writeIdentified },
      facts,
      runKey,
    )
  } catch (e) {
    // 🔴 B2（对抗审计）：识别抛错（超时/步数耗尽/LLM 5xx）必须回写退避——
    // 否则 next_retry_at 不动 → 每 30s 重选 → 烧钱死循环。
    const attempt = (deps.db.prepare('SELECT MAX(attempt) a FROM files WHERE work_dir = ?').get(facts.workDir) as { a: number }).a
    const err = e instanceof Error ? e.message.slice(0, 100) : String(e)
    deps.db.prepare(`
      UPDATE files SET attempt = ?, next_retry_at = ?, last_error = ?, updated_at = ?
      WHERE work_dir = ?
    `).run(attempt + 1, now + retryDelayMs(attempt), err, now, facts.workDir)
    console.error(`[identify-scheduler] ${facts.workDir} 抛错: ${err}（已推进退避轨）`)
    return { tmdbId: null, title: null, reason: `error: ${err}` }
  }

  // 🔴 自动绑定：report 确认身份后，scheduler 用文件列表 + TMDB 详情自动绑定所有文件。
  // （agent 的 write_identified_media 工具保留供它主动修正集号，但绑定不再依赖它被调用。）
  if (report.tmdbId !== null) {
    const writeResult = await writeIdentified({
      tmdbId: report.tmdbId,
      isTv: facts.hasSeasonDirs || facts.seasons.length > 0,
      title: report.title ?? '',
      files: facts.files.map(f => ({ filename: f.filename, season: f.season, episode: f.episode })),
    })
    if (!writeResult.ok) {
      const attempt = (deps.db.prepare('SELECT MAX(attempt) a FROM files WHERE work_dir = ?').get(facts.workDir) as { a: number }).a
      deps.db.prepare(`
        UPDATE files SET attempt = ?, next_retry_at = ?, last_error = ?, updated_at = ?
        WHERE work_dir = ?
      `).run(attempt + 1, now + retryDelayMs(attempt + 1), writeResult.error, now, facts.workDir)
      return { ...report, reason: `${report.reason} [bind failed: ${writeResult.error}]` }
    }
    console.error(`[identify-scheduler] bound ${writeResult.written}/${facts.fileCount} files of ${facts.workDir} to tmdb:${report.tmdbId}`)
  }

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

/** 退避（巡检模型 spec 2026-08-08）：识别不出的统一"明天"（24h，对齐巡检周期）。
 *  不再有 1h/4h 短退避——那是旧 30s tick 思维的残留，与"每天巡检一次"矛盾。 */
function retryDelayMs(_attempt: number): number {
  return 24 * 60 * 60 * 1000
}
