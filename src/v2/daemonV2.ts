// src/v2/daemonV2.ts：新架构 daemon（阶段 5）——机械调度主循环。
// 取代旧 ScoutDaemon 的 orchestrator 那套。每 30s 一拍：
//  1. 扫描（机械）：守备目录 → files 表
//  2. 派活（机械）：识别队列 → 识别 agent；字幕队列 → 字幕 agent
//
// 保持旧 daemon 的"DB 是状态机"铁律：每步产出立即落库，死了从库状态续跑。
import { walkVideoFiles } from '../daemon/selfScan.js'
import { statSync } from 'node:fs'
import { toMediaFileRow, isScannable } from './scanner.js'
import type { ScoutDb } from './db.js'
import { dispatchOnce, type DispatcherDeps } from './dispatcher.js'

export interface DaemonV2Deps extends DispatcherDeps {
  roots: string[]
  scanEveryMs?: number
  log: (msg: string) => void
}

export class ScoutDaemonV2 {
  private lastScanAt = 0
  private stopping = false
  private scanInFlight = false

  constructor(private deps: DaemonV2Deps) {}

  async run(signal: AbortSignal): Promise<void> {
    signal.addEventListener('abort', () => { this.stopping = true }, { once: true })
    const TICK_MS = 30_000
    const scanEveryMs = this.deps.scanEveryMs ?? 15 * 60_000

    while (!this.stopping) {
      try {
        await this.tick(scanEveryMs)
      } catch (e) {
        this.deps.log(`tick error (isolated): ${String(e)}`)
      }
      if (this.stopping) break
      await sleep(TICK_MS, signal)
    }
  }

  private async tick(scanEveryMs: number): Promise<void> {
    // 1. 周期扫描（机械）——时间门 + 指纹跳过
    const now = Date.now()
    if (!this.scanInFlight && now - this.lastScanAt >= scanEveryMs) {
      this.scanInFlight = true
      try {
        await this.scanOnce()
        this.lastScanAt = Date.now()
      } finally {
        this.scanInFlight = false
      }
    }
    // 2. 派活（机械）——识别/字幕各最多一项
    await dispatchOnce(this.deps)
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
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); resolve() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
