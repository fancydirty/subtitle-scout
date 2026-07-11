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
  lib.upsertSeries({ id: 's1', name: 'Series A', chineseTitle: '甲剧', posterTag: 'ptag', year: 2021 })
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

const posterFetch = (async (_url: string) =>
  new Response(Buffer.from('IMG'), { status: 200, headers: { 'content-type': 'image/png' } })) as unknown as typeof fetch

async function start(distDir: string, token?: string, fetchImpl: typeof fetch = posterFetch): Promise<{ base: string }> {
  server = await startDashboard({
    db, port: 0, token, distDir,
    jellyfin: { baseUrl: 'http://jf.local', apiKey: 'SECRET' },
    fetchImpl,
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
    expect(series).toMatchObject({ name: 'Series A', chineseTitle: '甲剧', posterTag: 'ptag' })
    expect(series.coverage).toEqual({ covered: 1, missing: 1, embedded: 0, unavailable: 0, needsReview: 0 })
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
  it('proxies poster with immutable cache header, key stays server-side', async () => {
    const { base } = await start(distWith('<!doctype html>'))
    const res = await fetch(`${base}/api/poster/item-1?tag=abc`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe('IMG')
  })
  it('poster 404 when upstream fails', async () => {
    const failFetch = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch
    const { base } = await start(distWith('<!doctype html>'), undefined, failFetch)
    expect((await fetch(`${base}/api/poster/item-1`)).status).toBe(404)
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
    // poster 也受 token 保护
    expect((await fetch(`${base}/api/poster/item-1`)).status).toBe(401)
  })
})
