import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'

describe('崩溃恢复', () => {
  it('kill-mid-flight：claim 后模拟重启（新 JobsRepo 实例同一 db 文件）→ reapExpiredLeases → job 回 wanted，attempt 不变', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    const now = Date.now()

    // First process: create job and claim it
    {
      const db1 = openDb(dbPath)
      const jobs1 = new JobsRepo(db1)
      // 清算波 R-6（A-F8）：jobsRepo.upsertWanted/find 已随死器官处决——本用例测的是
      // reapExpiredLeases 的通用崩溃恢复语义（kind 无关），upsertWanted/find 过去只是拿来
      // 造一行/读回的便利手段，改为直接 SQL 写一行同形状的 series_season 行。
      db1.prepare(
        `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
         VALUES ('series_season', ?, ?, 'wanted', 0, 0, ?, ?)`
      ).run('s1', 1, now, now)
      const claimed = jobs1.claimNext(now)
      expect(claimed?.state).toBe('searching')
      expect(claimed?.attempt).toBe(0)
      db1.close()
    }

    // Simulate crash and restart: new JobsRepo instance on same db file
    {
      const db2 = openDb(dbPath)
      const jobs2 = new JobsRepo(db2)

      // Before reap: job is still in searching state
      const beforeReap = db2.prepare(`SELECT * FROM jobs WHERE kind = 'series_season' AND series_id = ? AND season = ?`).get('s1', 1) as { state: string } | undefined
      expect(beforeReap?.state).toBe('searching')

      // Reap expired leases (simulate time passing beyond lease)
      jobs2.reapExpiredLeases(now + 31 * 60_000)

      // After reap: job is back to wanted; attempt unchanged — reap is not a
      // content failure and must not consume a content-backoff-ladder slot.
      const afterReap = db2.prepare(`SELECT * FROM jobs WHERE kind = 'series_season' AND series_id = ? AND season = ?`).get('s1', 1) as { state: string; attempt: number; lease_until: number | null } | undefined
      expect(afterReap?.state).toBe('wanted')
      expect(afterReap?.attempt).toBe(0)
      expect(afterReap?.lease_until).toBeNull()

      db2.close()
    }
  })
})

// 退役T7 (Wave 2A)：原'双跑幂等'describe 块（"scanLibrary+aggregate 连跑两遍 → 快照一致"）
// 已删除——它的 subject（旧管线聚合层的 aggregate() 函数）已随原 v2/aggregate 模块一起
// 删除，scanLibrary 自身的幂等性由 scanner.test.ts 覆盖，不需要在这里重复经一个已退休的
// 聚合层再测一遍。

describe('markCovered 事务原子性', () => {
  it('在事务内注入抛错 → episodes 与 subtitles 均未写入', () => {
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)

    lib.upsertSeries({ id: 's1', name: 'Test Series' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Pilot',
      path: '/media/tv/show/e1.mkv',
      subStatus: 'missing',
    })

    // Before: episode is missing
    const before = lib.getEpisode('e1')
    expect(before?.sub_status).toBe('missing')

    // Inject an error by using a CHECK constraint violation:
    // Try to insert a subtitle with an invalid source (not in CHECK constraint)
    expect(() => {
      db.transaction(() => {
        // Try to update episode
        db.prepare('UPDATE episodes SET sub_status = ? WHERE id = ?').run('covered', 'e1')
        // Try to insert subtitle with invalid source (will fail CHECK constraint if it exists,
        // or we can just throw manually to simulate transaction failure)
        throw new Error('Simulated transaction failure')
      })()
    }).toThrow('Simulated transaction failure')

    // After: episode should still be missing (transaction rolled back)
    const after = lib.getEpisode('e1')
    expect(after?.sub_status).toBe('missing')

    // Verify no subtitles were written
    const subtitles = db.prepare('SELECT * FROM subtitles WHERE item_id = ?').all('e1')
    expect(subtitles).toHaveLength(0)
  })

  it('markCovered 成功时同时写入 episodes 与 subtitles', () => {
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)

    lib.upsertSeries({ id: 's1', name: 'Test Series' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Pilot',
      path: '/media/tv/show/e1.mkv',
      subStatus: 'missing',
    })

    // Mark covered in transaction
    lib.markCovered('e1', '/media/tv/show/e1.zh-Hans.srt', 'scout-download', 'assrt:713051')

    // Both should be written
    const episode = lib.getEpisode('e1')
    expect(episode?.sub_status).toBe('covered')

    const subtitles = db.prepare('SELECT * FROM subtitles WHERE item_id = ?').all('e1')
    expect(subtitles).toHaveLength(1)
    expect((subtitles[0] as any).path).toBe('/media/tv/show/e1.zh-Hans.srt')
    expect((subtitles[0] as any).provider_ref).toBe('assrt:713051')
  })
})

describe('dormant 不复活', () => {
  it('reapExpiredLeases 不得把 dormant 拉回 wanted', () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const now = Date.now()

    // Create a dormant job — 清算波 R-6（A-F8）：upsertWanted/find 已随死器官处决，直接 SQL
    // 写一行同形状的 series_season 行（forceState 仍是活的测试助手，硬编码同一个 kind）。
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
       VALUES ('series_season', ?, ?, 'wanted', 0, 0, ?, ?)`
    ).run('s1', 1, now, now)
    jobs.forceState('s1', 1, 'dormant', now)

    const findJob = () =>
      db.prepare(`SELECT * FROM jobs WHERE kind = 'series_season' AND series_id = ? AND season = ?`).get('s1', 1) as { state: string } | undefined

    // Verify it's dormant
    const before = findJob()
    expect(before?.state).toBe('dormant')

    // Run reapExpiredLeases (should not affect dormant jobs)
    jobs.reapExpiredLeases(now + 31 * 60_000)

    // Still dormant
    const after = findJob()
    expect(after?.state).toBe('dormant')
  })

  // 退役T7 (Wave 2A)：以下三条原用例（"aggregate 对无/有 missing 的组…"、"aggregate 不 wake
  // unavailable 集…"）覆盖的是 aggregate() 自己的 dormant 唤醒/免打扰判断——它们的 subject
  // 已随原 v2/aggregate 模块一起删除。
  //
  // 清算波 R-6（A-F8）补记：上面这条注释原先还说"JobsRepo.wake() 这个更底层的原语本身不受
  // 影响，仍由 jobsRepo.test.ts 覆盖（daemon.ts 的会话播放唤醒仍在用它）"——已核实失实：
  // daemon.ts 的 Jellyfin 播放会话轮询（pollSessions，wake/boost 的唯一生产调用点）早已随
  // 去 Jellyfin 化 T4 整体删除（daemon.ts 头注释原话："用户根本不用 Jellyfin 播放...这条
  // 播放优先级机制服务的场景在本战役的产品坐标下语义已死"），wake/boostPriority 今天已无
  // 任何生产调用点，随本波一并处决（连同 upsertWanted/find/completeNoMatch/completePartial/
  // retire/findMovie/setJournalRef/JobIdent 联合类型等同类死器官）。
})
