// src/dashboard/server.test.ts
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { connect } from 'node:net'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import type { Server } from 'node:http'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { startDashboard } from './server.js'
import { traceBus, type TraceEvent } from '../core/traceBus.js'

// dashboard-F5：'search' 加入 Pick——GET /api/v2/tmdb/search 的 fake tmdb 注入复用同一个类型。
type FakeTmdb = Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes' | 'search'>

let server: Server | undefined
let db: ScoutDb
// 审计三轮 R3：原来是 `afterEach(() => server?.close())`——不 await、也不断开 keep-alive
// 连接。close() 只停止接受新连接，已建立的 keep-alive 连接会让 server 迟迟不真正关闭，上一个
// 用例的残留连接与下一个用例的新 server 在全量并发下互相干扰（实测：parked/claim 两个用例在
// `npm test` 下偶发失败，单文件跑 100% 通过，`--no-file-parallelism` 也全绿）。
// 这里 await 'close' 事件并显式 closeAllConnections()，把每个用例的服务端状态彻底隔离。
//
// 2026-07-26 补第二层（服务端断连不够，客户端连接池也得清）：R3 只处理了 server 侧。fetch
// 用的 undici 全局 dispatcher 按 `host:port` 缓存连接，`port: 0` 又让 OS 在端口回收后很快把
// 同一个号分配给下一个用例/下一个 worker 的 server——池里那条指向已关闭 server 的陈旧连接
// 于是把请求送到了新 server 上。表现就是随机一条 API 用例拿到别人的响应：实测复现过
// `expected 200 to be 400`（打到另一个已喂过合法 body 的 server）和
// `SyntaxError: Unexpected token '<', "<!DOCTYPE "`（打到静态文件兜底，返回 index.html）。
// 单文件跑永远绿、全量偶发红，正是"跨 worker 端口复用"的指纹。每个用例结束时销毁全局
// dispatcher 并换一个新的，池子里不留任何跨用例的连接。
afterEach(async () => {
  const s = server
  server = undefined
  if (s) {
    s.closeAllConnections?.() // Node 18.2+：断开 keep-alive，否则 close 等到连接自然超时
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  // 客户端侧：丢弃当前 dispatcher（连同它缓存的所有 keep-alive 连接），换一个干净的。
  const prev = getGlobalDispatcher()
  setGlobalDispatcher(new Agent())
  await prev.close().catch(() => {})
})

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
  env?: Record<string, string | undefined>,
  // dashboard G5：POST /api/v2/workflow/redispatch 依赖（缺席→503，照 reconcileAll 先例）。
  jobs?: Pick<JobsRepo, 'upsertWorkerTask'>,
  // dashboard G5：GET /api/v2/library/series/:id 命中时的惰性刷新接线（缺席→跳过，不报错）。
  tmdb?: FakeTmdb,
  // 验收修复轮一 Task V2：甄别认领成功后踢一脚扫描的回调（缺席→无事发生，照 reconcileAll/jobs/
  // tmdb 三个既有可选依赖的先例）。
  requestIngest?: () => void,
): Promise<{ base: string }> {
  server = await startDashboard({
    db, port: 0, token, distDir,
    reconcileAll,
    env,
    jobs,
    tmdb,
    requestIngest,
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
    const { base } = await start(distWith('<!doctype html><title>scout</title>'), 'tok')
    const lib = await (await fetch(`${base}/api/v2/library?token=tok`)).json()
    const series = lib.find((x: any) => x.id === 's1')
    expect(series).toMatchObject({ name: 'Series A', chineseTitle: '甲剧', posterPath: 'ptag' })
    expect(series.coverage).toEqual({ covered: 1, missing: 1, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 })
    expect(series.job).toEqual({ state: 'searching', priority: 100 })
  })
  it('serves /api/v2/series/:id and /api/v2/runs', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    const detail = await (await fetch(`${base}/api/v2/series/s1?token=tok`)).json()
    expect(detail.seasons[0].episodes.map((e: any) => e.id)).toEqual(['e1', 'e2'])
    expect(detail.runs[0]).toMatchObject({ decision: 'download', detail: '下好一集' })
    const runs = await (await fetch(`${base}/api/v2/runs?token=tok`)).json()
    expect(runs.length).toBe(1)
    expect(runs[0].decision).toBe('download')
  })
  it('serves static index.html at /', async () => {
    const { base } = await start(distWith('<!doctype html><title>scout</title>'))
    const res = await fetch(`${base}/`)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('scout')
  })

  describe('兄弟目录穿越封堵 (债务 D2)', () => {
    it('阻止同前缀兄弟目录被 serveStatic 读出', async () => {
      const dist = distWith('<html>ok</html>')
      const sibling = dist + '-old'
      mkdirSync(sibling)
      writeFileSync(join(sibling, 'secret.js'), 'evil')
      const { base } = await start(dist)
      const res = await fetch(`${base}/%2e%2e%2f${basename(dist)}-old/secret.js`)
      expect([403, 404]).toContain(res.status)
      const text = await res.text()
      expect(text).not.toContain('evil')
    })

    it('正常资源不受影响', async () => {
      const dist = distWith('<html>ok</html>')
      writeFileSync(join(dist, 'app.js'), 'console.log("app")')
      const { base } = await start(dist)
      const root = await fetch(`${base}/`)
      expect(root.status).toBe(200)
      expect(await root.text()).toContain('ok')
      const app = await fetch(`${base}/app.js`)
      expect(app.status).toBe(200)
    })
  })

  it('retires v1 endpoints with 410', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    expect((await fetch(`${base}/api/summary?token=tok`)).status).toBe(410)
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
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/parked?token=tok`)
      expect(res.status).toBe(200)
      const parked = await res.json()
      expect(parked).toEqual([
        { path: '/media/tv/Unknown Show/e1.mkv', parkReason: 'ambiguous match', firstSeen: NOW, lastAttempt: NOW },
      ])
    })

    it('POST /api/parked/claim writes an override for the parked path and returns ok', async () => {
      const lib = new LibraryRepo(db)
      lib.upsertParkedPath('/media/tv/Unknown Show/S01/e1.mkv', 'ambiguous match', NOW)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/parked/claim?token=tok`, {
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
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/parked/claim?token=tok`, {
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
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/parked/claim?token=tok`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: true, season: 0 }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toEqual(expect.any(String))
      expect(lib.findOverride('/media/tv/Unknown Show/e1.mkv')).toBeNull()
    })

    it('POST /api/parked/claim returns 400 on validation failure (e.g. unparked path)', async () => {
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/parked/claim?token=tok`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/never/parked.mkv', tmdbId: '1', isTv: false }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toEqual(expect.any(String))
    })

    it('POST /api/parked/claim rejects non-POST methods with 405', async () => {
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/parked/claim?token=tok`, { method: 'GET' })
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
      const { base } = await start(distWith('<!doctype html>'), 'tok', reconcileAll)
      const res = await fetch(`${base}/api/v2/reconcile-all?token=tok`, { method: 'POST' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        dispatchedFindSubtitle: 2, dispatchedRealign: 1, spawnedSiblings: 0, summary: 'dispatched 3 tasks',
      })
    })

    it('returns 503 when reconcileAll is not configured (e.g. TMDB_API_KEY missing)', async () => {
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/reconcile-all?token=tok`, { method: 'POST' })
      expect(res.status).toBe(503)
    })

    it('rejects non-POST methods with 405', async () => {
      const reconcileAll = async () => ({ dispatchedFindSubtitle: 0, dispatchedRealign: 0, spawnedSiblings: 0, summary: '' })
      const { base } = await start(distWith('<!doctype html>'), 'tok', reconcileAll)
      const res = await fetch(`${base}/api/v2/reconcile-all?token=tok`, { method: 'GET' })
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
      const { base } = await start(distWith('<!doctype html>'), 'tok', reconcileAll)
      const res = await fetch(`${base}/api/v2/reconcile-all?token=tok`, { method: 'POST' })
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
      const { base } = await start(distWith('<!doctype html>'), 'tok', reconcileAll)

      // Fire the first POST and let it actually enter the handler (increment `calls`, flip the
      // in-flight flag, and start blocking on `gate`) before firing the second.
      const firstReq = fetch(`${base}/api/v2/reconcile-all?token=tok`, { method: 'POST' })
      await new Promise(r => setTimeout(r, 20))

      const secondRes = await fetch(`${base}/api/v2/reconcile-all?token=tok`, { method: 'POST' })
      expect(secondRes.status).toBe(409)
      expect((await secondRes.json()).error).toMatch(/already running/i)
      expect(calls).toBe(1) // the second POST never invoked reconcileAll at all

      releaseFirst()
      const firstRes = await firstReq
      expect(firstRes.status).toBe(200)
      expect(calls).toBe(1)

      // Once the in-flight pass finishes, the guard releases and a later POST runs normally.
      const thirdRes = await fetch(`${base}/api/v2/reconcile-all?token=tok`, { method: 'POST' })
      expect(thirdRes.status).toBe(200)
      expect(calls).toBe(2)
    })
  })

  // 痕迹通道 C：GET /api/v2/workflow/trace-stream 是纯直播 SSE 端点，跟 reconcile-all/parked-claim
  // 一样是 handleApiRoute 纯函数分发之前的独立 rawPath 分支——同样的 method-then-token 校验顺序。
  describe('GET /api/v2/workflow/trace-stream (痕迹通道 C SSE 直播)', () => {
    it('订阅期 traceBus.publish 的事件以 data: 行到达客户端', async () => {
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const controller = new AbortController()
      const res = await fetch(`${base}/api/v2/workflow/trace-stream?token=tok`, { signal: controller.signal })
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
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/workflow/trace-stream?token=tok`, { method: 'POST' })
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
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const port = Number(new URL(base).port)

      const sock = connect(port, '127.0.0.1')
      await new Promise<void>((resolve) => sock.on('connect', resolve))
      sock.write('GET /api/v2/workflow/trace-stream?token=tok HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\n\r\n')
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
      const res = await fetch(`${base}/api/v2/library?token=tok`)
      expect(res.status).toBe(200)
    })
  })

  // dashboard G4：settings 仓库 + 守备目录 DB 化——四个只读 GET + 三个带 body/query 的写入端点。
  describe('settings + 守备目录 (dashboard G4)', () => {
    it('GET /api/v2/settings 反映 DB 里已写入的行为键，未设置为 null', async () => {
      new SettingsRepo(db).set('target_languages', 'zh,en', NOW)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/settings?token=tok`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        target_languages: 'zh,en', hardsub_mode: null, exclude_extras: null,
        trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
      })
    })

    it('GET /api/v2/settings/deploy 反映注入的 env：secrets 脱敏，非机密原样', async () => {
      const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, {
        TMDB_API_KEY: 'sk-abcdef1234567890', LLM_BASE_URL: 'https://api.deepseek.com/v1',
      })
      const res = await fetch(`${base}/api/v2/settings/deploy?token=tok`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.secrets.TMDB_API_KEY).toEqual({ present: true, tail: '7890' })
      expect(JSON.stringify(body)).not.toContain('abcdef')
      expect(body.nonSecrets.LLM_BASE_URL).toBe('https://api.deepseek.com/v1')
    })

    it('GET /api/v2/settings/roots 反映 DB 里的守备目录', async () => {
      new SettingsRepo(db).addRoot('/media/tv', NOW)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/settings/roots?token=tok`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([{ path: '/media/tv', type: 'local', addedAt: NOW }])
    })

    it('GET /api/v2/fs/list?path=... 真走文件系统，只列子目录名', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fs-list-server-'))
      mkdirSync(join(dir, 'tv'))
      mkdirSync(join(dir, 'anime'))
      writeFileSync(join(dir, 'readme.txt'), 'x')
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/fs/list?path=${encodeURIComponent(dir)}&token=tok`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ dirs: ['anime', 'tv'] })
    })

    describe('PUT /api/v2/settings', () => {
      // 审计三轮 R3：readJsonBodyOrFail 的四条 body 边界此前零测试（413 防线从未被验证，
      // 且 `null` body 曾因与"失败哨兵"撞车导致响应永不结束、请求挂到 requestTimeout）。
      // 413 用例单独拆出并放宽超时：1MB+ 的请求体在全量并发下传输本身就慢（曾因 5s 默认超时 flaky）。
      it('body 边界：非法 JSON→400、字面 null→400、空 body→视作 {}', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const put = (body: string) => fetch(`${base}/api/v2/settings?token=tok`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body,
        })

        const bad = await put('{not json')
        expect(bad.status).toBe(400)
        expect(await bad.json()).toEqual({ error: 'invalid JSON body' })

        // 字面 null 是合法 JSON：必须落到正常校验路径（400），而不是无人应答
        const nullBody = await put('null')
        expect(nullBody.status).toBe(400)

        // 空 body 视作 {}：白名单校验通过、回显全量 settings
        const empty = await put('')
        expect(empty.status).toBe(200)
      })

      it('body 超 1MB → 413（不是 500，也绝不挂住连接）', { timeout: 20_000 }, async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const huge = await fetch(`${base}/api/v2/settings?token=tok`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target_languages: 'z'.repeat(1_000_100) }),
        })
        expect(huge.status).toBe(413)
        expect(await huge.json()).toEqual({ error: 'payload too large' })
      })

      it('写入白名单键，回显全量 settings', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings?token=tok`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target_languages: 'zh,en', hardsub_mode: 'aggressive' }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({
          target_languages: 'zh,en', hardsub_mode: 'aggressive', exclude_extras: null,
          trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
        })
        expect(new SettingsRepo(db).get('target_languages')).toBe('zh,en')
      })

      it('写入 ai_translate_enabled=true/false 合法（AI 翻译开关）', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings?token=tok`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ai_translate_enabled: 'true' }),
        })
        expect(res.status).toBe(200)
        expect(new SettingsRepo(db).get('ai_translate_enabled')).toBe('true')
        const res2 = await fetch(`${base}/api/v2/settings?token=tok`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ai_translate_enabled: 'off' }),
        })
        expect(res2.status).toBe(400)
        expect(new SettingsRepo(db).get('ai_translate_enabled')).toBe('true')
      })

      it('白名单外的 key → 400，且不写入任何行（全有或全无）', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings?token=tok`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ target_languages: 'zh', not_a_real_key: 'x' }),
        })
        expect(res.status).toBe(400)
        expect(new SettingsRepo(db).get('target_languages')).toBeNull()
      })

      it('值域校验：hardsub_mode 不在枚举内 → 400', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings?token=tok`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hardsub_mode: 'yolo' }),
        })
        expect(res.status).toBe(400)
        expect((await res.json()).error).toEqual(expect.any(String))
      })

      it('值域校验：trace_retention_days 非正整数字符串 → 400', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings?token=tok`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trace_retention_days: '-5' }),
        })
        expect(res.status).toBe(400)
      })

      it('非 PUT 方法 405', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings?token=tok`, { method: 'POST' })
        expect(res.status).toBe(405)
      })

      it('token 门', async () => {
        const { base } = await start(distWith('<!doctype html>'), 's3cret')
        const unauthed = await fetch(`${base}/api/v2/settings`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(unauthed.status).toBe(401)
      })
    })

    describe('POST /api/v2/settings/roots', () => {
      it('绝对路径 + 存在 + 是目录 → 200，DB 可见', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'add-root-'))
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?token=tok`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        })
        expect(res.status).toBe(200)
        expect(new SettingsRepo(db).listRoots().map(r => r.path)).toContain(dir)
      })

      it('重复加同一路径是幂等 200', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'add-root-idem-'))
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        await fetch(`${base}/api/v2/settings/roots?token=tok`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }),
        })
        const second = await fetch(`${base}/api/v2/settings/roots?token=tok`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }),
        })
        expect(second.status).toBe(200)
        expect(new SettingsRepo(db).listRoots().filter(r => r.path === dir)).toHaveLength(1)
      })

      it('相对路径 → 400', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?token=tok`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'relative/path' }),
        })
        expect(res.status).toBe(400)
      })

      it('不存在的路径 → 400', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?token=tok`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '/definitely/does/not/exist/anywhere' }),
        })
        expect(res.status).toBe(400)
      })

      it('路径指向文件（非目录）→ 400', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'add-root-file-'))
        const file = join(dir, 'x.txt')
        writeFileSync(file, 'x')
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?token=tok`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: file }),
        })
        expect(res.status).toBe(400)
      })

      it('非 POST/GET/DELETE 方法 405', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?token=tok`, { method: 'PUT' })
        expect(res.status).toBe(405)
      })

      it('token 门（GET 不受影响，仍走纯路由的既有 401 语义；POST 同样要求 token）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'add-root-token-'))
        const { base } = await start(distWith('<!doctype html>'), 's3cret')
        expect((await fetch(`${base}/api/v2/settings/roots`)).status).toBe(401)
        expect((await fetch(`${base}/api/v2/settings/roots?token=s3cret`)).status).toBe(200)
        const unauthedPost = await fetch(`${base}/api/v2/settings/roots`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }),
        })
        expect(unauthedPost.status).toBe(401)
        const authedPost = await fetch(`${base}/api/v2/settings/roots?token=s3cret`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: dir }),
        })
        expect(authedPost.status).toBe(200)
      })
    })

    describe('DELETE /api/v2/settings/roots', () => {
      it('级联删除并回显计数；root 本身从 listRoots 消失', async () => {
        const lib = new LibraryRepo(db)
        const settings = new SettingsRepo(db)
        settings.addRoot('/media/tv', NOW)
        lib.upsertSeries({ id: 'tmdb:99', name: 'Show' })
        lib.upsertEpisode({
          id: 'tmdb:99/s1e1', seriesId: 'tmdb:99', season: 1, episode: 1, name: 'E1',
          path: '/media/tv/Show/Season 01/e1.mkv', subStatus: 'missing',
        })
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?path=${encodeURIComponent('/media/tv')}&token=tok`, { method: 'DELETE' })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ episodes: 1, movies: 0, series: 1, parked: 0 })
        expect(settings.listRoots()).toEqual([])
        expect(lib.getSeries('tmdb:99')).toBeNull()
      })

      it('缺 path 查询参数 → 400', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?token=tok`, { method: 'DELETE' })
        expect(res.status).toBe(400)
      })

      // 复审修复 1：不是守备目录的路径（含现存根的父目录）→ 404，零删除——防"一发 API 调用
      // 把公共父前缀下全部索引行清光"的安全脚枪。
      it('非守备目录路径（现存根的父目录）→ 404，索引行分毫不动', async () => {
        const lib = new LibraryRepo(db)
        const settings = new SettingsRepo(db)
        settings.addRoot('/media/tv', NOW)
        lib.upsertSeries({ id: 'tmdb:77', name: 'Keep Me' })
        lib.upsertEpisode({
          id: 'tmdb:77/s1e1', seriesId: 'tmdb:77', season: 1, episode: 1, name: 'E1',
          path: '/media/tv/Keep Me/Season 01/e1.mkv', subStatus: 'missing',
        })
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?path=${encodeURIComponent('/media')}&token=tok`, { method: 'DELETE' })
        expect(res.status).toBe(404)
        expect((await res.json()).error).toEqual(expect.any(String))
        expect(lib.getSeries('tmdb:77')).not.toBeNull()
        expect(settings.listRoots().map(r => r.path)).toEqual(['/media/tv'])
      })

      it('token 门', async () => {
        const { base } = await start(distWith('<!doctype html>'), 's3cret')
        const res = await fetch(`${base}/api/v2/settings/roots?path=/media/tv`, { method: 'DELETE' })
        expect(res.status).toBe(401)
      })

      // R2D-6（R2 复审）：POST 侧 addMediaRoot 落库前先 resolve() 归一化（去掉冗余尾斜杠/./..
      // 片段）；DELETE 侧此前直接拿 query 里的原始字符串去 settingsRepo.removeRoot 精确匹配
      // `path = ?`，两侧口径不对称——用户在地址栏/脚本里加个尾斜杠（"/media/tv/" vs 库里存的
      // "/media/tv"）就会 404，明明是同一个根。
      it('尾斜杠路径经 resolve() 归一化后仍能命中已登记的守备目录 → 200', async () => {
        const settings = new SettingsRepo(db)
        settings.addRoot('/media/tv', NOW)
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?path=${encodeURIComponent('/media/tv/')}&token=tok`, { method: 'DELETE' })
        expect(res.status).toBe(200)
        expect(settings.listRoots()).toEqual([])
      })
    })
  })

  // dashboard G5：workflow/library/甄别聚合 API——七端点全走真实 HTTP round-trip。
  describe('workflow/library/甄别聚合 API（dashboard G5）', () => {
    it('GET /api/v2/workflow/pending 聚合缺口事实 + parked 计数 + meta 新鲜度', async () => {
      db.prepare(`INSERT INTO meta (key, value) VALUES ('last_ingest_at', ?)`).run(String(NOW))
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/workflow/pending?token=tok`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.series.some((s: { seriesId: string; season: number }) => s.seriesId === 's1' && s.season === 1)).toBe(true)
      expect(body.meta.lastScanAt).toBe(NOW)
      expect(typeof body.meta.files).toBe('number')
    })

    it('GET /api/v2/workflow/passes 返回 orchestrate runs + receipts（从 trace_json 解析）', async () => {
      const jobId = Number(
        db.prepare(
          `INSERT INTO jobs (kind, series_id, payload, state, priority, created_at, updated_at)
           VALUES ('worker_task', 'orchestrator-shard-1', ?, 'done', 0, ?, ?)`
        ).run(JSON.stringify({ taskType: 'orchestrate' }), NOW, NOW).lastInsertRowid
      )
      const events = [{
        runKey: `job-${jobId}`, seq: 0, tool: 'dispatch_find_subtitle_task',
        argsSummary: '{}', resultSummary: '{"outcome":"created"}', tookMs: 1, at: NOW,
      }]
      db.prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
         VALUES (?, ?, ?, 'orchestrate', 'ok', NULL, ?)`
      ).run(jobId, NOW - 1000, NOW, JSON.stringify(events))
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/workflow/passes?token=tok`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body[0].receipts).toEqual({ created: 1, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 })
    })

    it('GET /api/v2/workflow/workers 返回跑中 worker + 近期 runs', async () => {
      db.prepare(
        `INSERT INTO jobs (kind, series_id, payload, state, priority, created_at, updated_at)
         VALUES ('worker_task', 's1', ?, 'searching', 0, ?, ?)`
      ).run(JSON.stringify({ taskType: 'find_subtitle', seasons: [1] }), NOW, NOW)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/workflow/workers?token=tok`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.running.some((r: { seriesId: string; taskType: string }) => r.seriesId === 's1' && r.taskType === 'find_subtitle')).toBe(true)
      expect(body.recent.length).toBeGreaterThan(0)
    })

    describe('GET /api/v2/library/series/:id（三层格阵合并 + 惰性刷新接线）', () => {
      it('返回合并详情，404 未命中', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/library/series/s1?token=tok`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.series.name).toBe('Series A')
        const notFound = await fetch(`${base}/api/v2/library/series/nope?token=tok`)
        expect(notFound.status).toBe(404)
      })

      it('tmdb 未配置时端点仍正常工作（不报错，只是跳过惰性刷新）', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/library/series/s1?token=tok`)
        expect(res.status).toBe(200)
      })

      // 注：真实 seriesId 形如 'tmdb:<n>'（含冒号，src/v2/ownIds.ts）；router.ts 的 SAFE_ID
      // 字符集不含 ':'，这条路由（同既有 /api/v2/series/:id）目前无法用真实带冒号的 id 走完整
      // HTTP round-trip 触发 refreshSeriesCatalog 的真实 TMDB 分支（tmdbIdFromOwnId 对不含
      // 冒号的 id 恒早退）——这是路由层既有限制，不是本端点新引入的缺陷，这里只验证 tmdb 配置
      // 存在时命中仍是 200、不因 fire-and-forget 分支而报错/挂起。
      it('tmdb 已配置时命中不报错、不阻塞响应（早退分支：测试用 id 不合 tmdb:<n> 形状）', async () => {
        const tmdbStub: FakeTmdb = {
          getSeasonTable: async () => [{ seasonNumber: 1, episodeCount: 1, airDate: null }],
          getSeasonEpisodes: async () => [{ episode: 1, title: 'Ep1', overview: null, airDate: null, stillPath: null }],
          search: async () => [],
        }
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, tmdbStub)
        const res = await fetch(`${base}/api/v2/library/series/s1?token=tok`)
        expect(res.status).toBe(200)
      })
    })

    describe('GET /api/v2/tmdb/search（dashboard-F5：ClaimDialog 的 TMDB 搜索代理）', () => {
      it('转调 tmdb.search，结果映射成 {id,name,year,posterPath}（形状）', async () => {
        const tmdbStub: FakeTmdb = {
          getSeasonTable: async () => [],
          getSeasonEpisodes: async () => [],
          search: async (mediaType, query) => {
            expect(mediaType).toBe('tv')
            expect(query).toBe('进击的巨人')
            return [{ id: 1429, title: 'Attack on Titan', originalTitle: '進撃の巨人', year: 2013, posterPath: '/p.jpg' }]
          },
        }
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, tmdbStub)
        const res = await fetch(`${base}/api/v2/tmdb/search?q=${encodeURIComponent('进击的巨人')}&type=tv&token=tok`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ results: [{ id: 1429, name: 'Attack on Titan', year: 2013, posterPath: '/p.jpg' }] })
      })

      it('tmdb 未配置 → 503（照 reconcile-all 先例）', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/tmdb/search?q=x&type=tv&token=tok`)
        expect(res.status).toBe(503)
      })

      it('q 缺失 / type 非法 → 400', async () => {
        const tmdbStub: FakeTmdb = { getSeasonTable: async () => [], getSeasonEpisodes: async () => [], search: async () => [] }
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, tmdbStub)
        expect((await fetch(`${base}/api/v2/tmdb/search?type=tv&token=tok`)).status).toBe(400)
        expect((await fetch(`${base}/api/v2/tmdb/search?q=x&type=bogus&token=tok`)).status).toBe(400)
      })

      it('tmdb.search 抛错 → 502（瞬时故障如实转告，不吞成空结果）', async () => {
        const tmdbStub: FakeTmdb = {
          getSeasonTable: async () => [],
          getSeasonEpisodes: async () => [],
          search: async () => { throw new Error('network blew up') },
        }
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, tmdbStub)
        const res = await fetch(`${base}/api/v2/tmdb/search?q=x&type=tv&token=tok`)
        expect(res.status).toBe(502)
        expect(await res.json()).toEqual({ error: 'tmdb search failed' })
      })
    })

    describe('GET /api/v2/triage + POST /api/v2/triage/claim', () => {
      it('GET /api/v2/triage 返回 pending + claimed', async () => {
        const lib = new LibraryRepo(db)
        lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/triage?token=tok`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.pending).toEqual([
          { path: '/media/tv/Unknown Show/e1.mkv', parkReason: 'ambiguous match', firstSeen: NOW, lastAttempt: NOW },
        ])
        expect(body.claimed).toEqual([])
      })

      it('POST /api/v2/triage/claim 复用 claimParked 逻辑（与 /api/parked/claim 同一实现）', async () => {
        const lib = new LibraryRepo(db)
        lib.upsertParkedPath('/media/tv/Unknown Show/S01/e1.mkv', 'ambiguous match', NOW)
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/triage/claim?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '/media/tv/Unknown Show/S01/e1.mkv', tmdbId: '999', isTv: true }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(lib.findOverride('/media/tv/Unknown Show/S01/e2.mkv')).toEqual({ tmdbId: '999', isTv: true, season: null })
      })

      it('POST /api/v2/triage/claim 校验失败 → 400', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/triage/claim?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '/never/parked.mkv', tmdbId: '1', isTv: false }),
        })
        expect(res.status).toBe(400)
      })

      it('POST /api/v2/triage/claim 非 POST 方法 405', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/triage/claim?token=tok`, { method: 'GET' })
        expect(res.status).toBe(405)
      })

      it('POST /api/v2/triage/claim 需要配置的 token', { timeout: 20_000 }, async () => {
        const { base } = await start(distWith('<!doctype html>'), 's3cret')
        const res = await fetch(`${base}/api/v2/triage/claim`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(res.status).toBe(401)
      })
    })

    // 验收修复轮一 Task V2：认领成功后踢一脚扫描——认领只写 override（见 claimParked 注释），
    // 停车行真正退户口要等下一轮 ingest pass。requestIngest 让这一刻立即请求一次扫描，不用
    // 等 daemon 自己的时间门。
    describe('claim 成功后的 requestIngest 踢扫描（验收修复轮一 Task V2）', () => {
      it('成功（result.ok）→ requestIngest 被调用一次', async () => {
        const lib = new LibraryRepo(db)
        lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
        let calls = 0
        const { base } = await start(
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined, () => { calls++ },
        )
        const res = await fetch(`${base}/api/parked/claim?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: true }),
        })
        expect(res.status).toBe(200)
        expect(calls).toBe(1)
      })

      it('/api/v2/triage/claim 分支同样触发（两条路径共用同一个 claimParked 实现）', async () => {
        const lib = new LibraryRepo(db)
        lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
        let calls = 0
        const { base } = await start(
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined, () => { calls++ },
        )
        const res = await fetch(`${base}/api/v2/triage/claim?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: true }),
        })
        expect(res.status).toBe(200)
        expect(calls).toBe(1)
      })

      it('校验失败（400）→ requestIngest 不被调用', async () => {
        let calls = 0
        const { base } = await start(
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined, () => { calls++ },
        )
        const res = await fetch(`${base}/api/parked/claim?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '/never/parked.mkv', tmdbId: '1', isTv: false }),
        })
        expect(res.status).toBe(400)
        expect(calls).toBe(0)
      })

      it('未配置 requestIngest → claim 仍正常响应，不炸（同 reconcileAll/jobs/tmdb 三个既有可选依赖的缺席先例）', async () => {
        const lib = new LibraryRepo(db)
        lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/parked/claim?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: true }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
      })

      it('requestIngest 同步抛错 → 吞掉，不影响响应（fire-and-forget，DESIGN.md §8 数据已经写对了）', async () => {
        const lib = new LibraryRepo(db)
        lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
        const { base } = await start(
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined,
          () => { throw new Error('boom') },
        )
        const res = await fetch(`${base}/api/parked/claim?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: true }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
      })
    })

    describe('POST /api/v2/triage/unexclude（救援R4b 特典翻案）', () => {
      it('合法翻案 → 200 + 写豁免 + 退 park 户口 + 踢一脚扫描', async () => {
        const lib = new LibraryRepo(db)
        const path = '/media/tv/Show/Show - NCOP01.mkv'
        lib.upsertParkedPath(path, 'excluded-extra', NOW)
        let calls = 0
        const { base } = await start(
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined, () => { calls++ },
        )
        const res = await fetch(`${base}/api/v2/triage/unexclude?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(lib.isExtrasExempt(path)).toBe(true)
        expect(lib.listParkedPaths().some((p) => p.path === path)).toBe(false)
        expect(calls).toBe(1)
      })

      it('reason 非 excluded-extra → 400，requestIngest 不被调用', async () => {
        const lib = new LibraryRepo(db)
        const path = '/media/tv/Show/e1.mkv'
        lib.upsertParkedPath(path, 'no match', NOW)
        let calls = 0
        const { base } = await start(
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined, () => { calls++ },
        )
        const res = await fetch(`${base}/api/v2/triage/unexclude?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path }),
        })
        expect(res.status).toBe(400)
        expect(calls).toBe(0)
      })

      it('非 POST 方法 405', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/triage/unexclude?token=tok`, { method: 'GET' })
        expect(res.status).toBe(405)
      })

      it('需要配置的 token', async () => {
        const { base } = await start(distWith('<!doctype html>'), 's3cret')
        const res = await fetch(`${base}/api/v2/triage/unexclude`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
        })
        expect(res.status).toBe(401)
      })
    })

    describe('POST /api/v2/workflow/redispatch（人类扳手：手动重派）', () => {
      it('合法 body → 转调 upsertWorkerTask，原样返回四态回执', async () => {
        const jobs = new JobsRepo(db)
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, jobs)
        const res = await fetch(`${base}/api/v2/workflow/redispatch?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seriesId: 's1', seasons: [1], includeThrottled: true }),
        })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ outcome: 'created' })
      })

      it('zod 拒绝非法 body → 400', async () => {
        const jobs = new JobsRepo(db)
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, jobs)
        const res = await fetch(`${base}/api/v2/workflow/redispatch?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seriesId: '' }),
        })
        expect(res.status).toBe(400)
      })

      it('jobs 未配置 → 503（照 reconcileAll 先例）', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/workflow/redispatch?token=tok`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seriesId: 's1' }),
        })
        expect(res.status).toBe(503)
      })

      it('非 POST 方法 405，token 门', async () => {
        const jobs = new JobsRepo(db)
        const { base } = await start(distWith('<!doctype html>'), 's3cret', undefined, undefined, jobs)
        expect((await fetch(`${base}/api/v2/workflow/redispatch?token=s3cret`, { method: 'GET' })).status).toBe(405)
        const unauthed = await fetch(`${base}/api/v2/workflow/redispatch`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seriesId: 's1' }),
        })
        expect(unauthed.status).toBe(401)
      })
    })

    describe('GET /api/v2/workflow/runs/:id/trace（dashboard-F4：单 run 痕迹快照回放）', () => {
      it('数字 id 命中 → 200 + trace_json 原样解析', async () => {
        const jobId = Number(
          db.prepare(
            `INSERT INTO jobs (kind, series_id, payload, state, priority, created_at, updated_at)
             VALUES ('worker_task', 's1', ?, 'done', 0, ?, ?)`
          ).run(JSON.stringify({ taskType: 'find_subtitle' }), NOW, NOW).lastInsertRowid
        )
        const events = [{ runKey: `job-${jobId}`, seq: 0, tool: 'search_source', argsSummary: '"x"', resultSummary: '41 candidates', tookMs: 1200, at: NOW }]
        const runId = Number(
          db.prepare(
            `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
             VALUES (?, ?, ?, 'download', 'ok', NULL, ?)`
          ).run(jobId, NOW - 1000, NOW, JSON.stringify(events)).lastInsertRowid
        )
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/workflow/runs/${runId}/trace?token=tok`)
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ events })
      })

      it('行不存在 → 404', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/workflow/runs/999999/trace?token=tok`)
        expect(res.status).toBe(404)
      })

      it('非数字 id → 404', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/workflow/runs/abc/trace?token=tok`)
        expect(res.status).toBe(404)
      })
    })
  })
})

describe('auth 前置门（A1：统一门，spec §2）', () => {
  it('未初始化：/api/v2/library 401 setup required；静态资源照常 200', async () => {
    const { base } = await start(distWith('<!doctype html><title>scout</title>'))
    const api = await fetch(`${base}/api/v2/library`)
    expect(api.status).toBe(401)
    expect(await api.json()).toEqual({ error: 'setup required' })
    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
  })
  it('setup：POST 写三键返回 apiKey + 签发 session cookie；二次 setup 403', async () => {
    const { base } = await start(distWith('x'))
    const r = await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { apiKey: string }
    expect(body.apiKey).toMatch(/^[0-9a-f]{32}$/)
    expect(r.headers.get('set-cookie')).toMatch(/^scout_session=[0-9a-f]{64}; /)
    const again = await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'y'.repeat(10) }),
    })
    expect(again.status).toBe(403)
  })
  it('login/logout：对密码拿 cookie 后 API 通；logout 后同 cookie 401', async () => {
    const { base } = await start(distWith('x'))
    await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    const login = await fetch(`${base}/api/v2/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    expect(login.status).toBe(200)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const lib = await fetch(`${base}/api/v2/library`, { headers: { cookie } })
    expect(lib.status).toBe(200)
    const out = await fetch(`${base}/api/v2/auth/logout`, { method: 'POST', headers: { cookie } })
    expect(out.status).toBe(200)
    const after = await fetch(`${base}/api/v2/library`, { headers: { cookie } })
    expect(after.status).toBe(401)
  })
  it('login 错密码 401；连爆 6 次 429（节流）', async () => {
    const { base } = await start(distWith('x'))
    await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    const bad = () => fetch(`${base}/api/v2/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'nope-nope' }),
    })
    expect((await bad()).status).toBe(401)
    for (let i = 0; i < 4; i++) await bad()
    expect((await bad()).status).toBe(429)
  })
  it('X-Api-Key 头与 ?apikey= query 都走通（SSE/脚本通道）', async () => {
    const { base } = await start(distWith('x'))
    const setup = await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    const { apiKey } = await setup.json() as { apiKey: string }
    expect((await fetch(`${base}/api/v2/library`, { headers: { 'x-api-key': apiKey } })).status).toBe(200)
    expect((await fetch(`${base}/api/v2/library?apikey=${apiKey}`)).status).toBe(200)
    expect((await fetch(`${base}/api/v2/library`, { headers: { 'x-api-key': 'wrong' } })).status).toBe(401)
  })
  it('auth/status：未初始化 {initialized:false,...}；登录后 authenticated:true', async () => {
    const { base } = await start(distWith('x'))
    const s1 = await fetch(`${base}/api/v2/auth/status`)
    expect(await s1.json()).toEqual({ initialized: false, authenticated: false })
    const setup = await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]
    const s2 = await fetch(`${base}/api/v2/auth/status`, { headers: { cookie } })
    expect(await s2.json()).toEqual({ initialized: true, authenticated: true })
    const s3 = await fetch(`${base}/api/v2/auth/status`)
    expect(await s3.json()).toEqual({ initialized: true, authenticated: false })
  })
  it('legacy DASHBOARD_TOKEN：未初始化+带旧 token → API 照常通（旧部署零破坏）', async () => {
    const { base } = await start(distWith('x'), 'legacy-tok')
    expect((await fetch(`${base}/api/v2/library?token=legacy-tok`)).status).toBe(200)
    expect((await fetch(`${base}/api/v2/library`, { headers: { 'x-dashboard-token': 'legacy-tok' } })).status).toBe(200)
    expect((await fetch(`${base}/api/v2/library?token=wrong`)).status).toBe(401)
  })
  it('已初始化后 legacy token 仍等价 api key（迁移期共存）', async () => {
    const { base } = await start(distWith('x'), 'legacy-tok')
    await fetch(`${base}/api/v2/auth/setup?token=legacy-tok`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    expect((await fetch(`${base}/api/v2/library?token=legacy-tok`)).status).toBe(200)
  })
  it('SSE trace-stream 走 ?apikey=（EventSource 无法带头）', async () => {
    const { base } = await start(distWith('x'))
    const setup = await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    const { apiKey } = await setup.json() as { apiKey: string }
    const ac = new AbortController()
    const sse = await fetch(`${base}/api/v2/workflow/trace-stream?apikey=${apiKey}`, { signal: ac.signal })
    expect(sse.status).toBe(200)
    expect(sse.headers.get('content-type')).toContain('text/event-stream')
    ac.abort()
    expect((await fetch(`${base}/api/v2/workflow/trace-stream`)).status).toBe(401)
  })
})

describe('fs/list 收口（R2D-2：未鉴权全盘枚举关闭）', () => {
  it('未初始化：?path=/etc 401 setup required（向导阶段无匿名浏览）', async () => {
    const { base } = await start(distWith('x'))
    expect((await fetch(`${base}/api/v2/fs/list?path=/etc`)).status).toBe(401)
  })
  it('已初始化未登录：401；登录后可浏览（加根选择器的正常用途）', async () => {
    const { base } = await start(distWith('x'))
    const setup = await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]
    expect((await fetch(`${base}/api/v2/fs/list?path=/`)).status).toBe(401)
    expect((await fetch(`${base}/api/v2/fs/list?path=/`, { headers: { cookie } })).status).toBe(200)
  })
})

describe('auth Security 区端点（A3 Task 12）', () => {
  async function setupAndCookie(base: string) {
    const r = await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    const { apiKey } = await r.json() as { apiKey: string }
    return { cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], apiKey }
  }
  it('GET /api/v2/auth/security：authed 才给 username+完整 apiKey', async () => {
    const { base } = await start(distWith('x'))
    const { cookie, apiKey } = await setupAndCookie(base)
    expect((await fetch(`${base}/api/v2/auth/security`)).status).toBe(401)
    const r = await fetch(`${base}/api/v2/auth/security`, { headers: { cookie } })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ username: 'admin', apiKey })
  })
  it('POST change-password：旧密码错 400；对则 200 且新密码能登、旧的不能', async () => {
    const { base } = await start(distWith('x'))
    const { cookie } = await setupAndCookie(base)
    const post = (body: unknown) => fetch(`${base}/api/v2/auth/change-password`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
    })
    expect((await post({ oldPassword: 'wrong', newPassword: 'newpass888' })).status).toBe(400)
    expect((await post({ oldPassword: 'hunter2222', newPassword: 'newpass888' })).status).toBe(200)
    const login = (password: string) => fetch(`${base}/api/v2/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    })
    expect((await login('hunter2222')).status).toBe(401)
    expect((await login('newpass888')).status).toBe(200)
  })
  it('POST regenerate-api-key：返回新 key，旧 key 立即失效', async () => {
    const { base } = await start(distWith('x'))
    const { cookie, apiKey } = await setupAndCookie(base)
    const r = await fetch(`${base}/api/v2/auth/regenerate-api-key`, { method: 'POST', headers: { cookie } })
    const { apiKey: nk } = await r.json() as { apiKey: string }
    expect(nk).toMatch(/^[0-9a-f]{32}$/)
    expect((await fetch(`${base}/api/v2/library`, { headers: { 'x-api-key': apiKey } })).status).toBe(401)
    expect((await fetch(`${base}/api/v2/library`, { headers: { 'x-api-key': nk } })).status).toBe(200)
  })
})

describe('改密撤销会话 + 补发当前 cookie（审计 MEDIUM #1）', () => {
  async function setupAndCookie(base: string) {
    const r = await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    return (r.headers.get('set-cookie') ?? '').split(';')[0]
  }
  it('改密后：其它会话全失效，但发起改密的请求拿到一枚新 cookie 继续有效', async () => {
    const { base } = await start(distWith('x'))
    const cookie1 = await setupAndCookie(base)
    // 第二个独立会话
    const login = await fetch(`${base}/api/v2/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    const cookie2 = (login.headers.get('set-cookie') ?? '').split(';')[0]
    expect((await fetch(`${base}/api/v2/library`, { headers: { cookie: cookie1 } })).status).toBe(200)
    expect((await fetch(`${base}/api/v2/library`, { headers: { cookie: cookie2 } })).status).toBe(200)
    // 用 cookie1 改密
    const cp = await fetch(`${base}/api/v2/auth/change-password`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie1 },
      body: JSON.stringify({ oldPassword: 'hunter2222', newPassword: 'newpass8888' }),
    })
    expect(cp.status).toBe(200)
    const cookie3 = (cp.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie3).toMatch(/^scout_session=[0-9a-f]{64}$/)
    // 旧的两枚全失效，新的一枚有效
    expect((await fetch(`${base}/api/v2/library`, { headers: { cookie: cookie1 } })).status).toBe(401)
    expect((await fetch(`${base}/api/v2/library`, { headers: { cookie: cookie2 } })).status).toBe(401)
    expect((await fetch(`${base}/api/v2/library`, { headers: { cookie: cookie3 } })).status).toBe(200)
  })
})
