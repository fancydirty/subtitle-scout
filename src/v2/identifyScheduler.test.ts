import { describe, it, expect } from 'vitest'
import { openDb } from './db.js'
import { runIdentifyWorkDir, type IdentifySchedulerDeps } from './identifyScheduler.js'
import type { IdentifyReport } from '../agent/identifyWorker.js'

function mkDeps(db: ReturnType<typeof openDb>, runIdentifyImpl: () => Promise<IdentifyReport>): IdentifySchedulerDeps {
  return {
    db,
    runIdentify: async () => runIdentifyImpl(),
    worker: {
      model: {} as any,
      tmdb: { search: async () => [], getDetails: async () => null } as any,
    },
  }
}

describe('runIdentifyWorkDir（识别轨 catch-all）', () => {
  it('🔴 识别抛错 → next_retry_at 推进（不 30s 死循环）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Show'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/E01.mkv`, workDir, 'E01.mkv', 100, 1000, workDir, 1000)

    const deps = mkDeps(db, () => { throw new Error('LLM timeout') })
    const report = await runIdentifyWorkDir(deps, {
      workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false,
    })
    const row = db.prepare('SELECT attempt, next_retry_at, last_error FROM files WHERE work_dir = ?').get(workDir) as any
    expect(row.attempt).toBe(1)
    expect(row.next_retry_at).toBeGreaterThan(Date.now() + 30 * 60 * 1000)
    expect(row.next_retry_at).toBeLessThan(Date.now() + 2 * 60 * 60 * 1000)
    expect(row.last_error).toContain('LLM timeout')
    expect(report.tmdbId).toBeNull()
    db.close()
  })

  it('🔴 连续抛错 → 退避递增（attempt 阶梯）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Show'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/E01.mkv`, workDir, 'E01.mkv', 100, 1000, workDir, 1000)
    const deps = mkDeps(db, () => { throw new Error('err') })
    await runIdentifyWorkDir(deps, { workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false })
    await runIdentifyWorkDir(deps, { workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false })
    const row = db.prepare('SELECT attempt, next_retry_at FROM files WHERE work_dir = ?').get(workDir) as any
    expect(row.attempt).toBe(2)
    // 第二次失败 → 4h 档
    expect(row.next_retry_at).toBeGreaterThan(Date.now() + 3 * 60 * 60 * 1000)
    db.close()
  })
})
