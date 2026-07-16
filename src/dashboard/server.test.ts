// src/dashboard/server.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import type { Server } from 'node:http'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { startDashboard } from './server.js'
import { traceBus, type TraceEvent } from './traceBus.js'

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

  // 痕迹通道 C：GET /api/v2/workflow/trace-stream 是纯直播 SSE 端点，跟 reconcile-all/parked-claim
  // 一样是 handleApiRoute 纯函数分发之前的独立 rawPath 分支——同样的 method-then-token 校验顺序。
  describe('GET /api/v2/workflow/trace-stream (痕迹通道 C SSE 直播)', () => {
    it('订阅期 traceBus.publish 的事件以 data: 行到达客户端', async () => {
      const { base } = await start(distWith('<!doctype html>'))
      const controller = new AbortController()
      const res = await fetch(`${base}/api/v2/workflow/trace-stream`, { signal: controller.signal })
      try {
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/event-stream')

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        // 给 server 端 request handler 一点时间真正跑到 subscribe（handleApiRoute 之外的独立分
        // 支，同 reconcile-all 的 409 门控用例一样留一点 event-loop 余量，不依赖精确同步时序）。
        await new Promise((r) => setTimeout(r, 20))

        const event: TraceEvent = {
          runKey: 'job-sse-test', seq: 0, tool: 'search_source',
          argsSummary: '{"q":"x"}', resultSummary: '{"ok":true}', tookMs: 12, at: Date.now(),
        }
        traceBus.publish(event)

        let received = ''
        while (!received.includes('data: ')) {
          const { value, done } = await reader.read()
          if (done) break
          received += decoder.decode(value, { stream: true })
        }
        expect(received).toContain(`data: ${JSON.stringify(event)}`)
      } finally {
        controller.abort()
      }
    })

    it('GET only（非 GET 405）', async () => {
      const { base } = await start(distWith('<!doctype html>'))
      const res = await fetch(`${base}/api/v2/workflow/trace-stream`, { method: 'POST' })
      expect(res.status).toBe(405)
    })

    it('token 配置时无 token 401，带 token 200', async () => {
      const { base } = await start(distWith('<!doctype html>'), 's3cret')
      const controller = new AbortController()
      const unauthed = await fetch(`${base}/api/v2/workflow/trace-stream`, { signal: controller.signal })
      expect(unauthed.status).toBe(401)

      const authedController = new AbortController()
      const authed = await fetch(`${base}/api/v2/workflow/trace-stream?token=s3cret`, { signal: authedController.signal })
      try {
        expect(authed.status).toBe(200)
      } finally {
        authedController.abort()
      }
    })

    // 复审修复（守护进程存活）：socket 猝死到 server 侧 'close' 事件触发之间有窗口——窗口内
    // traceBus 订阅回调的 res.write 会写入已毁的流，ServerResponse 无 'error' 监听器时
    // uncaughtException 直接炸掉守护进程（守护进程就是产品本体）。这里用原生 socket 手写 HTTP
    // 请求后 destroy()（fetch+abort 走的是体面收场，模拟不了猝死），随即在同一 tick 内连发
    // 多条 publish 打进窗口期。心跳（15s setInterval）的写入走完全相同的前置守卫
    // （res.destroyed || res.writableEnded），不在测试内推进 15s 重复验证同一守卫。
    it('SSE 连接 socket 猝死后窗口期 publish 不炸守护进程，server 仍可服务后续请求', async () => {
      const { base } = await start(distWith('<!doctype html>'))
      const port = Number(new URL(base).port)

      const sock = connect(port, '127.0.0.1')
      await new Promise<void>((resolve) => sock.on('connect', resolve))
      sock.write('GET /api/v2/workflow/trace-stream HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n')
      // 等 200 头真正冲刷回来——保证 server 已进入 SSE 分支、订阅已建立。
      const head = await new Promise<string>((resolve) => sock.once('data', (d) => resolve(String(d))))
      expect(head).toContain('200')
      expect(head).toContain('text/event-stream')

      sock.destroy() // 猝死：直接拆底层句柄，不走体面 FIN 收场
      // 同一 tick 内 publish——server 侧 'close' 事件还没来得及跑，订阅者仍在册，res.write
      // 正中窗口期。
      for (let seq = 0; seq < 5; seq++) {
        traceBus.publish({ runKey: 'job-sse-destroyed', seq, tool: 't', argsSummary: '', resultSummary: '', tookMs: 0, at: seq })
      }
      // 让 close/error 事件都跑完，再补一发（此时订阅者应已退订，同样不许炸）。
      await new Promise((r) => setTimeout(r, 50))
      traceBus.publish({ runKey: 'job-sse-destroyed', seq: 5, tool: 't', argsSummary: '', resultSummary: '', tookMs: 0, at: 5 })
      await new Promise((r) => setTimeout(r, 20))

      // 守护进程活着的直接证据：同一 server 实例照常服务下一个请求。
      // （若 uncaughtException 已炸，vitest 会把它记为本测试的 unhandled error，全绿即无泄漏。）
      const res = await fetch(`${base}/api/v2/library`)
      expect(res.status).toBe(200)
    })
  })
})
