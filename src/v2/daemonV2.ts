// src/v2/daemonV2.ts：新架构 daemon（巡检模型）。
// spec: docs/design/2026-08-08-daemon-inspection-model.md
//
// 用户裁决：工作台语义是"有活就一直跑，跑完歇，明天再巡检"（对齐 Jellyfin 库扫描频率），
// **不是 30s tick 轮询**（旧架构 orchestrator 残留思维）。
//
// 每天一次巡检（距上次满 24h）：
//   阶段 1：机械扫描守备目录 → files 表（新文件入库，指纹跳过）
//   阶段 2：识别工作流（上游）——识别工作台有活就一直跑，跑空才进下一步
//   阶段 2.5：judge（B-1 补齐）——识别绑定后判 needs_subtitle
//   阶段 3：字幕工作流（下游）——字幕工作台有活就一直跑，跑空才结束
//   阶段 4：停，歇着，等明天
import { walkVideoFiles } from '../daemon/selfScan.js'
import { statSync } from 'node:fs'
import { toMediaFileRow, isScannable } from './scanner.js'
import type { ScoutDb } from './db.js'
import { listIdentifyQueue, runIdentifyWorkDir, type IdentifySchedulerDeps } from './identifyScheduler.js'
import { listSubtitleQueue, runSubtitleWorkDir, type SubtitleQueueItem } from './subtitleScheduler.js'
import { judgeSubtitle } from './subtitleJudge.js'
import { langOf } from '../agent/languages.js'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, basename } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'

export const INSPECT_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface DaemonV2Deps {
  db: ScoutDb
  roots: string[]
  identify: IdentifySchedulerDeps
  subtitleWorker: (task: import('../agent/findSubtitleWorker.schemas.js').FindSubtitleTask) => Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport>
  targetLanguage: string
  /** 只读根缓存（115 测试目录——字幕派发会 ENOENT，识别照常）。检测一次缓存。 */
  writableRoots?: Map<string, boolean>
  log: (msg: string) => void
  /** 测试注入：距上次巡检满这个时间才算到点。默认 INSPECT_INTERVAL_MS。 */
  inspectEveryMs?: number
  now?: () => number
}

export class ScoutDaemonV2 {
  private stopping = false
  private writableCache: Map<string, boolean>

  constructor(private deps: DaemonV2Deps) {
    this.writableCache = deps.writableRoots ?? new Map<string, boolean>()
  }

  async run(signal: AbortSignal): Promise<void> {
    signal.addEventListener('abort', () => { this.stopping = true }, { once: true })

    while (!this.stopping) {
      const now = this.deps.now?.() ?? Date.now()
      const lastInspectAt = this.readLastInspectAt()
      const everyMs = this.deps.inspectEveryMs ?? INSPECT_INTERVAL_MS

      if (now - lastInspectAt >= everyMs) {
        this.deps.log(`巡检开始 (距上次 ${lastInspectAt === 0 ? '(冷启动)' : `${Math.round((now - lastInspectAt) / 3600000)}h`})`)
        try {
          await this.runInspection(signal)
        } catch (e) {
          this.deps.log(`巡检失败（隔离，下轮重试）: ${String(e)}`)
        }
        this.writeLastInspectAt(this.deps.now?.() ?? Date.now())
        this.deps.log('巡检完成，歇着等明天')
      }

      if (this.stopping) break
      // "歇着"：每 5min 检查一次是否到 24h（不是轮询工作台，是轮询时间闸）
      await sleep(5 * 60 * 1000, signal)
    }
  }

  /** 一轮完整巡检：扫描 → 识别跑空 → judge → 字幕跑空。 */
  private async runInspection(signal: AbortSignal): Promise<void> {
    // 阶段 1：机械扫描
    await this.scanOnce()

    // 阶段 2：识别工作流（上游）——有活跑到空
    let identifyRounds = 0
    while (!this.stopping) {
      const queue = listIdentifyQueue(this.deps.db, this.deps.now?.() ?? Date.now())
      if (queue.length === 0) break
      identifyRounds++
      const item = queue[0]
      this.deps.log(`识别 ${item.workDir} (${item.fileCount} 文件, 第 ${identifyRounds} 个)`)
      await runIdentifyWorkDir(this.deps.identify, item)
    }

    // 阶段 2.5：judge（B-1）——识别绑定后判 needs_subtitle
    await this.judgeOnce()

    // 阶段 3：字幕工作流（下游）——有活跑到空
    let subtitleRounds = 0
    while (!this.stopping) {
      const wRoots = this.writableRoots()
      const queue = listSubtitleQueue(this.deps.db, wRoots, this.deps.now?.() ?? Date.now())
      if (queue.length === 0) break
      subtitleRounds++
      const item = queue[0]
      this.deps.log(`字幕 ${item.title} (${item.files.length} 文件, 第 ${subtitleRounds} 个)`)
      await runSubtitleWorkDir(this.deps.db, this.deps.subtitleWorker, item, this.deps.targetLanguage)
    }
  }

  /** 只读根过滤：字幕只在可写根内派发（115 只读跳过）。 */
  private writableRoots(): string[] {
    const out: string[] = []
    for (const root of this.deps.roots) {
      if (!this.writableCache.has(root)) {
        this.writableCache.set(root, isDirWritable(root))
      }
      if (this.writableCache.get(root)) out.push(root)
    }
    return out
  }

  /** judge 阶段：对已识别但未判定的文件跑 judgeSubtitle（国产/内嵌/sidecar 跳过）。 */
  private async judgeOnce(): Promise<void> {
    const db = this.deps.db
    const now = this.deps.now?.() ?? Date.now()
    const rows = db.prepare(`
      SELECT f.path, f.filename, f.embedded_langs, f.work_id, w.origin_lang
      FROM files f LEFT JOIN works w ON f.work_id = w.id
      WHERE f.work_id IS NOT NULL AND f.needs_subtitle IS NULL
    `).all() as Array<{ path: string; filename: string; embedded_langs: string | null; work_id: string; origin_lang: string | null }>

    if (rows.length === 0) return
    const update = db.prepare('UPDATE files SET needs_subtitle = ?, updated_at = ? WHERE path = ?')
    let judged = 0

    for (const r of rows) {
      let embedded: string[] | null = null
      if (r.embedded_langs) { try { embedded = JSON.parse(r.embedded_langs) } catch { embedded = null } }
      const dir = dirname(r.path)
      const stem = basename(r.filename).replace(/\.[^.]+$/, '')
      const dirEntries = (() => { try { return readdirSync(dir) } catch { return [] } })()
      const sidecar = dirEntries.some((e) =>
        e !== r.filename && e.startsWith(stem + '.') &&
        /\.(srt|ass|ssa|vtt)$/i.test(e) && /[.-](zh|chs|chi|zho)([.-]|$)/i.test(e))

      const verdict = judgeSubtitle(
        { originLang: r.origin_lang, embeddedLangs: embedded, hasSidecarSubtitle: sidecar },
        { targetLanguages: [this.deps.targetLanguage] },
      )
      update.run(verdict.needs ? 1 : 0, now, r.path)
      judged++
    }
    if (judged > 0) {
      this.deps.log(`judge: ${judged} 个文件判定需字幕`)
    }
  }

  private async scanOnce(): Promise<void> {
    const db = this.deps.db
    const upsert = db.prepare(`
      INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, parse_confidence, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        dir=excluded.dir, filename=excluded.filename, size=excluded.size, mtime=excluded.mtime,
        work_dir=excluded.work_dir, season=excluded.season, episode=excluded.episode,
        parse_confidence=excluded.parse_confidence, updated_at=excluded.updated_at
    `)
    const findExisting = db.prepare('SELECT mtime, size FROM files WHERE path = ?')
    let scanned = 0, upserted = 0, skipped = 0

    for (const root of this.deps.roots) {
      const files = walkVideoFiles(root)
      for (const f of files) {
        scanned++
        let st
        try { st = statSync(f) } catch { skipped++; continue }
        const sc = isScannable(f, st.size)
        if (!sc.ok) { skipped++; continue }
        const existing = findExisting.get(f) as { mtime: number; size: number } | undefined
        if (existing && existing.mtime === Math.round(st.mtimeMs) && existing.size === st.size) continue
        const row = toMediaFileRow(f, st, this.deps.roots)
        upsert.run(row.path, row.dir, row.filename, row.size, row.mtime,
          row.workDir, row.season, row.episode, row.parseConfidence, Date.now())
        upserted++
      }
    }
    if (upserted > 0) {
      this.deps.log(`scan: scanned=${scanned} upserted=${upserted} skipped=${skipped}`)
    }
  }

  /** last_inspect_at 持久化到 meta（M-3：重启读它判 24h，冷启动立即跑）。 */
  private readLastInspectAt(): number {
    try {
      const row = this.deps.db.prepare(`SELECT value FROM meta WHERE key = 'last_inspect_at'`).get() as { value: string } | undefined
      const v = row ? Number(row.value) : 0
      return Number.isFinite(v) ? v : 0
    } catch { return 0 }
  }

  private writeLastInspectAt(now: number): void {
    this.deps.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)
                          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(now))
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); resolve() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
