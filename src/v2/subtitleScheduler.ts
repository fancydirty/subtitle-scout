// src/v2/subtitleScheduler.ts：字幕调度器（新架构阶段 4）。
// 职责：从 files 表挑"需要字幕的一簇"（一个作品）→ 组装 FindSubtitleTask → 调字幕 worker。
//
// 字幕 agent 的输入（用户裁决）：一个作品的全部 needs_subtitle 文件。
// 它不需要看目录树、不需要判断身份、不需要管字幕放哪——系统 harness 它。
import type { ScoutDb } from './db.js'
import type { FindSubtitleTask, FindSubtitleTargetFact } from '../agent/findSubtitleWorker.schemas.js'
import type { LanguageModel } from 'ai'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { traceBus } from '../core/traceBus.js'

export interface SubtitleQueueItem {
  workId: string
  title: string
  originalTitle: string | null
  year: number | null
  overview: string | null
  chineseTitles: string[]
  mediaType: string
  files: Array<{ path: string; filename: string; season: number | null; episode: number | null; dir: string; durationSec: number | null; embeddedLangs: string[] | null }>
}

/** 字幕队列：一个作品的一簇（needs_subtitle=1 的全部文件）。
 *  🔴 2026-08-08 实测：必须按守备目录过滤——files 表可能含已移除根的残留数据
 *  （如 115 测试目录），只读挂载上建 staging 沙盒会 ENOENT。 */
export function listSubtitleQueue(db: ScoutDb, roots?: string[], now = Date.now()): SubtitleQueueItem[] {
  const rows = db.prepare(`
    SELECT w.id AS work_id, w.title, w.original_title, w.year, w.overview, w.chinese_titles, w.media_type,
           f.path, f.filename, f.season, f.episode, f.dir, f.duration_sec, f.embedded_langs
    FROM files f JOIN works w ON f.work_id = w.id
    WHERE f.needs_subtitle = 1
      AND (f.recheck_after IS NULL OR f.recheck_after <= ?)
    ORDER BY w.id, f.season, f.episode
  `).all(now) as Array<{
    work_id: string; title: string; original_title: string | null; year: number | null;
    overview: string | null; chinese_titles: string | null; media_type: string;
    path: string; filename: string; season: number | null; episode: number | null; dir: string; duration_sec: number | null; embedded_langs: string | null
  }>

  const byWork = new Map<string, SubtitleQueueItem>()
  for (const r of rows) {
    if (roots && roots.length > 0) {
      const inside = roots.some((root) => r.path === root || r.path.startsWith(root + '/'))
      if (!inside) continue
    }
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
    let langs: string[] | null = null
    if (r.embedded_langs) { try { langs = JSON.parse(r.embedded_langs) } catch { langs = null } }
    item.files.push({ path: r.path, filename: r.filename, season: r.season, episode: r.episode, dir: r.dir, durationSec: r.duration_sec, embeddedLangs: langs })
  }
  return [...byWork.values()]
}

/** 组装 FindSubtitleTask（一个作品的一簇）。 */
export function buildSubtitleTask(item: SubtitleQueueItem, targetLanguage: string): FindSubtitleTask {
  // INNER 沙盒根：所有文件所在目录的公共祖先（同一作品通常同根，安全）
  const dirs = item.files.map(f => f.dir)
  const mediaRoot = commonDir(dirs)
  // 🔴 2026-08-08 实测修正：itemId 必须从 work_id 派生（tmdb:95897/s1e1），不能传 null——
  // findSubtitleWorker 的 prompt 对 itemId:null 渲染"unidentified — identify first"，worker 会
  // 直接 no_safe_match 跳过而不搜索（Overflow 2 步退出的根因）。新架构里文件已识别（work_id
  // 有值），itemId 是"已识别"的信号。
  const targets: FindSubtitleTargetFact[] = item.files.map(f => ({
    itemId: item.workId + (f.season != null && f.episode != null ? `/s${f.season}e${f.episode}` : ''),
    videoPath: f.path,
    videoFilename: f.filename,
    season: f.season,
    episode: f.episode,
    absoluteEpisode: null,
    imdbId: null,
    runtimeMinutes: null,
    dirName: f.dir,
    durationSec: f.durationSec,
    embeddedLangs: f.embeddedLangs,
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
 *  （runFindSubtitleTask），直接调用，返回 batch report。
 *
 *  🔴 死循环修复（spec docs/design/2026-08-08-deadloop-fix-v2.md）：
 *  - B-1：run 前 snapshot 清缓冲（traceBus 的 buf push 追加不重置，第二次跑同一
 *    workId 时 peek 会看到第一次的 search_source，编造被误判"有证据"）
 *  - B-2：无结局文件（不在任何桶）回写 recheck_after，不能残留 needs=1
 *  - B-3：catch-all——超时（TimeoutError）与其它抛错都回写，不能死循环
 *  - 反编造门：no_safe_match 必须有 search_source 证据才标 unavailable，
 *    零证据 = 编造 → 15min 短退避
 *  - 退避阶梯：retry_later/超时/错误轨用 attempt 阶梯 15min→1h→4h→24h
 */
export async function runSubtitleWorkDir(
  db: ScoutDb,
  worker: (task: FindSubtitleTask) => Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport>,
  item: SubtitleQueueItem,
  targetLanguage: string,
): Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport | null> {
  const task = buildSubtitleTask(item, targetLanguage)
  const runKey = `job-subtitle:${item.workId}`
  const now = Date.now()
  const backoffFor = (attempt: number) => {
    if (attempt <= 0) return 15 * 60 * 1000
    if (attempt === 1) return 60 * 60 * 1000
    if (attempt === 2) return 4 * 60 * 60 * 1000
    return 24 * 60 * 60 * 1000
  }
  // 退避回写：attempt+1 + recheck_after
  const bump = (f: SubtitleQueueItem['files'][number], reason: string) => {
    const row = db.prepare('SELECT attempt FROM files WHERE path = ?').get(f.path) as { attempt: number } | undefined
    const oldAttempt = row?.attempt ?? 0
    const attempt = oldAttempt + 1
    // 🔴 用旧 attempt 查阶梯：第一次失败（old=0）→ 15min；第二次（old=1）→ 1h；
    // 第三次（old=2）→ 4h；之后（old≥3）→ 24h。用新 attempt 会让第一次就 1h。
    db.prepare('UPDATE files SET attempt = ?, recheck_after = ?, last_error = ?, updated_at = ? WHERE path = ?')
      .run(attempt, now + backoffFor(oldAttempt), reason, now, f.path)
  }

  console.error(`[subtitle-worker] subtitle:${item.workId} task with ${task.targets.length} targets`)

  // B-1：run 前 snapshot 清缓冲（防 stale 事件污染反编造门）
  traceBus.snapshot(runKey)

  let report: import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport
  try {
    report = await worker(task)
  } catch (e) {
    // B-3：catch-all——超时 vs 其它抛错都回写（不能死循环）
    const isTimeout = (e as Error | undefined)?.name === 'TimeoutError'
    const reason = isTimeout ? 'timeout' : String(e).slice(0, 100)
    for (const f of item.files) bump(f, reason)
    console.error(`[subtitle-scheduler] ${item.title} ${isTimeout ? '超时' : '抛错'}: ${reason}`)
    return null
  }

  // 反编造门：no_safe_match 必须真有 search_source 证据
  const traceTools = traceBus.peek(runKey, 512).map(e => e.tool)
  const hasSearchEvidence = traceTools.includes('search_source')

  // 按桶回写（按文件粒度）
  const now2 = Date.now()
  const markCovered = db.prepare('UPDATE files SET needs_subtitle = 0, sub_status = ?, updated_at = ? WHERE path = ?')

  // 已装盘的：优先 itemId 精确匹配，null 时回退 installedPath 前缀（M-1）
  const coveredPaths = new Set<string>()
  for (const inst of report.installed) {
    if (inst.itemId != null) {
      // itemId 是 tmdb:X/sNeM，需要反解到 path——用 files 表按 work_id+season+episode 匹配
      const m = inst.itemId.match(/^tmdb:.*?\/s(\d+)e(\d+)$/)
      if (m) {
        const row = db.prepare(
          'SELECT path FROM files WHERE work_id = ? AND season = ? AND episode = ? LIMIT 1',
        ).get(item.workId, Number(m[1]), Number(m[2])) as { path: string } | undefined
        if (row) coveredPaths.add(row.path)
        continue
      }
    }
    // null itemId 或格式不符：回退 installedPath 前缀匹配
    const videoBase = inst.installedPath.replace(/\.[^.]+$/, '')
    for (const f of item.files) {
      if (f.path.replace(/\.[^.]+$/, '') === videoBase.replace(/\.[^.]+$/, '')) {
        coveredPaths.add(f.path)
      }
    }
  }
  for (const f of item.files) {
    if (coveredPaths.has(f.path)) {
      markCovered.run('covered', now2, f.path)
    }
  }

  // no_safe_match：有搜索证据 → unavailable + 6h；零证据（编造）→ 15min
  const noSafePaths = new Set<string>()
  for (const nsm of report.no_safe_match) {
    if (nsm.itemId != null) {
      const m = nsm.itemId.match(/^tmdb:.*?\/s(\d+)e(\d+)$/)
      if (m) {
        const row = db.prepare(
          'SELECT path FROM files WHERE work_id = ? AND season = ? AND episode = ? LIMIT 1',
        ).get(item.workId, Number(m[1]), Number(m[2])) as { path: string } | undefined
        if (row) noSafePaths.add(row.path)
      }
    }
  }
  if (report.no_safe_match.length > 0) {
    if (!hasSearchEvidence) {
      // 编造：不标 unavailable，15min 短退避 + 吼告警
      for (const f of item.files) {
        if (noSafePaths.has(f.path)) bump(f, 'fabricated-no-match')
      }
      console.error(`[subtitle-scheduler] ${item.title}: no_safe_match 但 trace 零 search_source —— 编造，15min 后重试`)
    } else {
      // 可信：unavailable + 6h
      for (const f of item.files) {
        if (noSafePaths.has(f.path)) {
          db.prepare('UPDATE files SET sub_status = ?, recheck_after = ?, updated_at = ? WHERE path = ?')
            .run('unavailable', now2 + 6 * 60 * 60 * 1000, now2, f.path)
        }
      }
    }
  }

  // retry_later：attempt 阶梯
  for (const rl of report.retry_later) {
    if (rl.itemId != null) {
      const m = rl.itemId.match(/^tmdb:.*?\/s(\d+)e(\d+)$/)
      if (m) {
        const row = db.prepare(
          'SELECT path FROM files WHERE work_id = ? AND season = ? AND episode = ? LIMIT 1',
        ).get(item.workId, Number(m[1]), Number(m[2])) as { path: string } | undefined
        if (row) {
          const f = item.files.find(x => x.path === row.path)
          if (f) bump(f, 'retry-later')
        }
      }
    }
  }

  // B-2：无结局文件（不在任何桶）→ 15min 回写，不能残留 needs=1
  const covered2 = new Set(report.installed.map(i => i.itemId).filter(Boolean))
  const noSafe2 = new Set(report.no_safe_match.map(i => i.itemId).filter(Boolean))
  const retry2 = new Set(report.retry_later.map(i => i.itemId).filter(Boolean))
  for (const f of item.files) {
    const inCovered = coveredPaths.has(f.path)
    const inNoSafe = noSafePaths.has(f.path)
    // 反解 itemId 判断是否在某桶
    const itemIdFor = f.season != null && f.episode != null ? `${item.workId}/s${f.season}e${f.episode}` : null
    const inAnyBucket = (itemIdFor != null && (covered2.has(itemIdFor) || noSafe2.has(itemIdFor) || retry2.has(itemIdFor))) || inCovered || inNoSafe
    if (!inAnyBucket && !coveredPaths.has(f.path)) {
      bump(f, 'no-outcome')
    }
  }

  const coveredCount = coveredPaths.size
  if (coveredCount > 0) {
    console.error(`[subtitle-scheduler] marked ${coveredCount}/${item.files.length} files covered for ${item.title}`)
  }
  return report
}

