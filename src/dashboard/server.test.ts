// src/dashboard/server.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { startDashboard } from './server.js'

let server: Server | undefined
let db: ScoutDb
afterEach(() => server?.close())

const NOW = 1_700_000_000_000

function seed(db: ScoutDb): void {
  const lib = new LibraryRepo(db)
  lib.upsertSeries({ id: 's1', name: 'Series A', chineseTitle: '甲剧', posterPath: 'ptag', year: 2021 })
  lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/p/e1', subStatus: 'covered' })
  lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/p/e2', subStatus: 'missing' })
  const jobId = Number(
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, created_at, updated_at)
       VALUES ('series_season', 's1', 1, 'searching', 100, ?, ?)`
    ).run(NOW, NOW).lastInsertRowid
  )
  db.prepare(
    `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path)
     VALUES (?, ?, ?, 'download', '下好一集', '/j/x/decision.json')`
  ).run(jobId, NOW - 1000, NOW)
}

function distWith(html: string): string {
  const dist = mkdtempSync(join(tmpdir(), 'dash-dist-'))
  writeFileSync(join(dist, 'index.html'), html)
  return dist
}

async function start(
  distDir: string, token?: string,
  reconcileAll?: () => Promise<{ dispatchedFindSubtitle: number; dispatchedRealign: number; spawnedSiblings: number; summary: string }>,
): Promise<{ base: string }> {
  server = await startDashboard({
    db, port: 0, token, distDir,
    reconcileAll,
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}` }
}

beforeEach(() => {
  db = openDb(':memory:')
  seed(db)
})

describe('startDashboard (v2)', () => {
  it('serves /api/v2/library with coverage + job', async () => {
    const { base } = await start(distWith('<!doctype html><title>scout</title>'))
    const lib = await (await fetch(`${base}/api/v2/library`)).json()
    const series = lib.find((x: any) => x.id === 's1')
    expect(series).toMatchObject({ name: 'Series A', chineseTitle: '甲剧', posterPath: 'ptag' })
    expect(series.coverage).toEqual({ covered: 1, missing: 1, embedded: 0, unavailable: 0 })
    expect(series.job).toEqual({ state: 'searching', priority: 100 })
  })
  it('serves /api/v2/series/:id and /api/v2/runs', async () => {
    const { base } = await start(distWith('<!doctype html>'))
    const detail = await (await fetch(`${base}/api/v2/series/s1`)).json()
    expect(detail.seasons[0].episodes.map((e: any) => e.id)).toEqual(['e1', 'e2'])
    expect(detail.runs[0]).toMatchObject({ decision: 'download', detail: '下好一集' })
    const runs = await (await fetch(`${base}/api/v2/runs`)).json()
    expect(runs.length).toBe(1)
    expect(runs[0].decision).toBe('download')
  })
  it('serves static index.html at /', async () => {
    const { base } = await start(distWith('<!doctype html><title>scout</title>'))
    const res = await fetch(`${base}/`)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('scout')
  })
  it('retires v1 endpoints with 410', async () => {
    const { base } = await start(distWith('<!doctype html>'))
    expect((await fetch(`${base}/api/summary`)).status).toBe(410)
  })
  it('rejects api without token when configured (401)', async () => {
    const { base } = await start(distWith('<!doctype html>'), 's3cret')
    expect((await fetch(`${base}/api/v2/library`)).status).toBe(401)
    expect((await fetch(`${base}/api/v2/library?token=s3cret`)).status).toBe(200)
  })

  describe('park 救援页 (去 Jellyfin 化 P6)', () => {
    it('GET /api/parked lists parked_paths', async () => {
      const lib = new LibraryRepo(db)
      lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
      const { base } = await start(distWith('<!doctype html>'))
      const res = await fetch(`${base}/api/parked`)
      expect(res.status).toBe(200)
      const parked = await res.json()
      expect(parked).toEqual([
        { path: '/media/tv/Unknown Show/e1.mkv', parkReason: 'ambiguous match', firstSeen: NOW, lastAttempt: NOW },
      ])
    })

    it('POST /api/parked/claim writes an override for the parked path and returns ok', async () => {
      const lib = new LibraryRepo(db)
      lib.upsertParkedPath('/media/tv/Unknown Show/S01/e1.mkv', 'ambiguous match', NOW)
      const { base } = await start(distWith('<!doctype html>'))
      const res = await fetch(`${base}/api/parked/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/media/tv/Unknown Show/S01/e1.mkv', tmdbId: '999', isTv: true }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(lib.findOverride('/media/tv/Unknown Show/S01/e2.mkv')).toEqual({ tmdbId: '999', isTv: true, season: null })
    })

    // P7 disambiguation 补丁：可选 season 入参走完整 HTTP round-trip。
    it('POST /api/parked/claim with a season carries it through to identify_overrides.season', async () => {
      const lib = new LibraryRepo(db)
      lib.upsertParkedPath('/media/TV/High School D×D/Hero - 01.mkv', 'no-signal', NOW)
      const { base } = await start(distWith('<!doctype html>'))
      const res = await fetch(`${base}/api/parked/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/media/TV/High School D×D/Hero - 01.mkv', tmdbId: '24240', isTv: true, season: 4 }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      expect(lib.findOverride('/media/TV/High School D×D/Hero - 01.mkv')).toEqual({ tmdbId: '24240', isTv: true, season: 4 })
    })

    it('POST /api/parked/claim rejects a non-positive-integer season (400)', async () => {
      const lib = new LibraryRepo(db)
      lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
      const { base } = await start(distWith('<!doctype html>'))
      const res = await fetch(`${base}/api/parked/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: true, season: 0 }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toEqual(expect.any(String))
      expect(lib.findOverride('/media/tv/Unknown Show/e1.mkv')).toBeNull()
    })

    it('POST /api/parked/claim returns 400 on validation failure (e.g. unparked path)', async () => {
      const { base } = await start(distWith('<!doctype html>'))
      const res = await fetch(`${base}/api/parked/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/never/parked.mkv', tmdbId: '1', isTv: false }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toEqual(expect.any(String))
    })

    it('POST /api/parked/claim rejects non-POST methods with 405', async () => {
      const { base } = await start(distWith('<!doctype html>'))
      const res = await fetch(`${base}/api/parked/claim`, { method: 'GET' })
      expect(res.status).toBe(405)
    })

    it('POST /api/parked/claim requires the configured token', async () => {
      const lib = new LibraryRepo(db)
      lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
      const { base } = await start(distWith('<!doctype html>'), 's3cret')
      const unauthed = await fetch(`${base}/api/parked/claim`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: false }),
      })
      expect(unauthed.status).toBe(401)
      const authed = await fetch(`${base}/api/parked/claim?token=s3cret`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: false }),
      })
      expect(authed.status).toBe(200)
    })
  })

  describe('POST /api/v2/reconcile-all (v3 phase ⑦)', () => {
    it('invokes the injected reconcileAll callback and returns its result', async () => {
      const reconcileAll = async () => ({
        dispatchedFindSubtitle: 2, dispatchedRealign: 1, spawnedSiblings: 0, summary: 'dispatched 3 tasks',
      })
      const { base } = await start(distWith('<!doctype html>'), undefined, reconcileAll)
      const res = await fetch(`${base}/api/v2/reconcile-all`, { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        dispatchedFindSubtitle: 2, dispatchedRealign: 1, spawnedSiblings: 0, summary: 'dispatched 3 tasks',
      })
    })

    it('returns 503 when reconcileAll is not configured (e.g. TMDB_API_KEY missing)', async () => {
      const { base } = await start(distWith('<!doctype html>'))
      const res = await fetch(`${base}/api/v2/reconcile-all`, { method: 'POST' })
      expect(res.status).toBe(503)
    })

    it('rejects non-POST methods with 405', async () => {
      const reconcileAll = async () => ({ dispatchedFindSubtitle: 0, dispatchedRealign: 0, spawnedSiblings: 0, summary: '' })
      const { base } = await start(distWith('<!doctype html>'), undefined, reconcileAll)
      const res = await fetch(`${base}/api/v2/reconcile-all`, { method: 'GET' })
      expect(res.status).toBe(405)
    })

    it('requires the configured token (401 without it, 200 with it)', async () => {
      const reconcileAll = async () => ({ dispatchedFindSubtitle: 0, dispatchedRealign: 0, spawnedSiblings: 0, summary: 'ok' })
      const { base } = await start(distWith('<!doctype html>'), 's3cret', reconcileAll)
      const unauthed = await fetch(`${base}/api/v2/reconcile-all`, { method: 'POST' })
      expect(unauthed.status).toBe(401)
      const authed = await fetch(`${base}/api/v2/reconcile-all?token=s3cret`, { method: 'POST' })
      expect(authed.status).toBe(200)
    })

    it('returns 500 with the error message when reconcileAll throws', async () => {
      const reconcileAll = async () => { throw new Error('orchestrator blew up') }
      const { base } = await start(distWith('<!doctype html>'), undefined, reconcileAll)
      const res = await fetch(`${base}/api/v2/reconcile-all`, { method: 'POST' })
      expect(res.status).toBe(500)
      expect((await res.json()).error).toMatch(/orchestrator blew up/)
    })

    it('in-flight guard: a second POST while one reconcile-all pass is still running gets 409 instead of launching a second expensive scan+LLM pass — no in-flight guard means DASHBOARD_TOKEN-less deployments could be hammered into repeated full-repo scans', async () => {
      let calls = 0
      let releaseFirst: () => void = () => {}
      const gate = new Promise<void>(resolve => { releaseFirst = resolve })
      const reconcileAll = async () => {
        calls++
        await gate // blocks until the test explicitly releases it, simulating a long scan+LLM pass
        return { dispatchedFindSubtitle: 1, dispatchedRealign: 0, spawnedSiblings: 0, summary: 'ok' }
      }
      const { base } = await start(distWith('<!doctype html>'), undefined, reconcileAll)

      // Fire the first POST and let it actually enter the handler (increment `calls`, flip the
      // in-flight flag, and start blocking on `gate`) before firing the second.
      const firstReq = fetch(`${base}/api/v2/reconcile-all`, { method: 'POST' })
      await new Promise(r => setTimeout(r, 20))

      const secondRes = await fetch(`${base}/api/v2/reconcile-all`, { method: 'POST' })
      expect(secondRes.status).toBe(409)
      expect((await secondRes.json()).error).toMatch(/already running/i)
      expect(calls).toBe(1) // the second POST never invoked reconcileAll at all

      releaseFirst()
      const firstRes = await firstReq
      expect(firstRes.status).toBe(200)
      expect(calls).toBe(1)

      // Once the in-flight pass finishes, the guard releases and a later POST runs normally.
      const thirdRes = await fetch(`${base}/api/v2/reconcile-all`, { method: 'POST' })
      expect(thirdRes.status).toBe(200)
      expect(calls).toBe(2)
    })
  })
})
