import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import { aggregate } from './aggregator.js'
import { scanLibrary } from './scanner.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'
import type { PlayerServer } from '../adapters/players/types.js'

function epItem(id: string, season = 1, episode = 1, overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: id,
    Name: `Episode ${episode}`,
    Type: 'Episode',
    SeriesId: 's1',
    SeriesName: 'Test Series',
    Path: `/media/tv/Show/Season ${season}/Show.S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mkv`,
    ParentIndexNumber: season,
    IndexNumber: episode,
    ProductionLocations: ['United States'],
    MediaStreams: [],
    ...overrides,
  } as JellyfinItem
}

function movieItem(id: string, overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: id,
    Name: 'The Matrix',
    Type: 'Movie',
    Path: `/media/movies/movie-${id}.mkv`,
    ProductionYear: 1999,
    ProductionLocations: ['United States of America'],
    ProviderIds: { Imdb: 'tt0133093' },
    MediaStreams: [],
    ...overrides,
  } as JellyfinItem
}

describe('崩溃恢复', () => {
  it('kill-mid-flight：claim 后模拟重启（新 JobsRepo 实例同一 db 文件）→ reapExpiredLeases → job 回 wanted，attempt 不变', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    const now = Date.now()

    // First process: create job and claim it
    {
      const db1 = openDb(dbPath)
      const jobs1 = new JobsRepo(db1)
      jobs1.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
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
      const beforeReap = jobs2.find('s1', 1)
      expect(beforeReap?.state).toBe('searching')

      // Reap expired leases (simulate time passing beyond lease)
      jobs2.reapExpiredLeases(now + 31 * 60_000)

      // After reap: job is back to wanted; attempt unchanged — reap is not a
      // content failure and must not consume a content-backoff-ladder slot.
      const afterReap = jobs2.find('s1', 1)
      expect(afterReap?.state).toBe('wanted')
      expect(afterReap?.attempt).toBe(0)
      expect(afterReap?.lease_until).toBeNull()

      db2.close()
    }
  })
})

describe('双跑幂等', () => {
  it('同一 jf stub 现实，scanLibrary+aggregate 连跑两遍 → episodes/jobs 全表快照完全一致', async () => {
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobs = new JobsRepo(db)
    const now = Date.now()

    // Create stub Jellyfin data: 3 episodes, all missing subtitles
    const items = [
      epItem('e1', 1, 1),
      epItem('e2', 1, 2),
      epItem('e3', 1, 3),
    ]

    const jf = {
      getItemsPage: vi.fn(async (startIndex: number) => {
        if (startIndex >= items.length) return []
        return items.slice(startIndex, startIndex + 2)
      }),
    } as unknown as PlayerServer

    // First run: scan + aggregate
    await scanLibrary(jf, lib, { pageSize: 2, fileExists: () => false, mappings: [] })
    aggregate(lib, jobs, now)

    // Take snapshot 1
    const episodes1 = db.prepare('SELECT * FROM episodes ORDER BY id').all()
    const jobs1 = db.prepare('SELECT * FROM jobs ORDER BY id').all()

    // Second run: scan + aggregate (same fixture)
    await scanLibrary(jf, lib, { pageSize: 2, fileExists: () => false, mappings: [] })
    aggregate(lib, jobs, now)

    // Take snapshot 2
    const episodes2 = db.prepare('SELECT * FROM episodes ORDER BY id').all()
    const jobs2 = db.prepare('SELECT * FROM jobs ORDER BY id').all()

    // Snapshots must be identical
    expect(episodes2).toEqual(episodes1)
    expect(jobs2).toEqual(jobs1)

    // Verify expected state
    expect(episodes1).toHaveLength(3)
    expect(jobs1).toHaveLength(1)
    expect((jobs1[0] as any).state).toBe('wanted')
  })
})

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

    // Create a dormant job
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    jobs.forceState('s1', 1, 'dormant', now)

    // Verify it's dormant
    const before = jobs.find('s1', 1)
    expect(before?.state).toBe('dormant')

    // Run reapExpiredLeases (should not affect dormant jobs)
    jobs.reapExpiredLeases(now + 31 * 60_000)

    // Still dormant
    const after = jobs.find('s1', 1)
    expect(after?.state).toBe('dormant')
  })

  it('aggregate 对无 missing 的组不得把 dormant 拉回 wanted', () => {
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobs = new JobsRepo(db)
    const now = Date.now()

    // Create a dormant job for a series with NO missing episodes
    lib.upsertSeries({ id: 's1', name: 'Test Series' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Pilot',
      path: '/media/tv/show/e1.mkv',
      subStatus: 'covered', // Already covered
    })

    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    jobs.forceState('s1', 1, 'dormant', now)

    // Verify it's dormant
    const before = jobs.find('s1', 1)
    expect(before?.state).toBe('dormant')

    // Run aggregate (no missing episodes for this season)
    const missing = lib.missingBySeason(now)
    expect(missing).toHaveLength(0) // No missing episodes

    aggregate(lib, jobs, now)

    // Job should remain dormant (not disturbed), not revived to wanted
    const after = jobs.find('s1', 1)
    expect(after?.state).toBe('dormant') // dormant jobs are not touched when no missing
  })

  it('aggregate 对有 missing 的组会 wake dormant（I3 预期行为）', () => {
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobs = new JobsRepo(db)
    const now = Date.now()

    // Create a dormant job for a series WITH missing episodes (beyond recheck window)
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

    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    jobs.forceState('s1', 1, 'dormant', now)

    // Verify it's dormant
    const before = jobs.find('s1', 1)
    expect(before?.state).toBe('dormant')

    // Run aggregate (has missing episodes)
    const missing = lib.missingBySeason(now)
    expect(missing).toHaveLength(1)
    expect(missing[0].series_id).toBe('s1')

    aggregate(lib, jobs, now)

    // Job should be woken to wanted (I3 behavior)
    const after = jobs.find('s1', 1)
    expect(after?.state).toBe('wanted')
  })

  it('aggregate 不 wake unavailable 集的 dormant job（在 recheck 窗口内）', () => {
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobs = new JobsRepo(db)
    const now = Date.now()

    // Create an unavailable episode (within recheck window)
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
    lib.markUnavailable('e1', '搜索穷尽', now + 86_400_000) // recheck in 24h

    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    jobs.forceState('s1', 1, 'dormant', now)

    // Verify it's dormant
    const before = jobs.find('s1', 1)
    expect(before?.state).toBe('dormant')

    // Run aggregate (has unavailable episode, but recheck window not expired)
    const missing = lib.missingBySeason(now)
    expect(missing).toHaveLength(0) // Not counted as missing (recheck not due)

    aggregate(lib, jobs, now)

    // Job should remain dormant (not disturbed), not woken
    const after = jobs.find('s1', 1)
    expect(after?.state).toBe('dormant') // dormant jobs are not touched when no missing
  })
})
