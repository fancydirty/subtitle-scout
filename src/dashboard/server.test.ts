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
import { TEST_HOST, baseOf } from './testServerHost.js'
import { traceBus, type TraceEvent } from '../core/traceBus.js'
import { SubtitleVerifyRepo } from '../v2/subtitleVerifyRepo.js'
import type { SubtitleWriteDeps } from './subtitleVerifyApi.js'
import type { SubtitleCompareDeps } from './subtitleCompareApi.js'
import type { SetupDeps } from './setupApi.js'

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
//
// ⚠️ 2026-08-12 更正：上面这段**归因是错的**，那两层缓解也因此没能根治（此后 flake 照旧偶发，
// 且新加的 health.test.ts 一进来就染上同型红）。实测证伪与真因：
//   · 证伪：单进程 300 轮"建 keep-alive 连接 → close() 旧 server → 新 server 抢同一端口 →
//     再请求"，串台 **0/300**。Node 19+ 的 `close()` 会主动回收空闲 keep-alive socket，
//     "池里留着指向已关闭 server 的陈旧连接"这条通道在本仓的 Node 版本上根本不成立。
//   · 真因：`startDashboard` 的 `listen(0)` **不带 host** → 绑 IPv6 通配 `::`；而 base 拼的是
//     `http://127.0.0.1:<port>` → **IPv4**。两个地址族的端口空间不互斥，同一个号可以同时被
//     本机另一个进程的 IPv4 socket 持有（并行 worker / 开发机上任何监听 0.0.0.0 的服务）。
//     请求于是压根没进本进程。决定性指纹：出错那轮 server 的 'request' 计数为 **0**。
//     前人观察到的 `<!DOCTYPE` 也不是"打到自己的静态兜底"，而是打到了机器上另一个 dev server。
//   修法见 testServerHost.ts（测试一律 `listen(port, '127.0.0.1')`）。实测 6000 次
//   start→fetch→close：不绑 host 4/6000 串台，绑 127.0.0.1 **0/6000**。
//
// 下面这两层**保留**：它们各自仍有独立价值（closeAllConnections 让 SSE 长连接用例的 server
// 立刻关干净、不拖住 afterEach；换 dispatcher 让每个用例的客户端状态互不影响），只是都不是
// 那条 flake 的解药。删掉它们等于在无关的方向上制造新变量，不划算。
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
  // reconcileAll 已删（第 5.5 步）
  env?: Record<string, string | undefined>,
  // dashboard G5：POST /api/v2/workflow/redispatch 依赖（缺席→503）。
  jobs?: Pick<JobsRepo, 'upsertWorkerTask'>,
  // dashboard-F5：GET /api/v2/tmdb/search 的搜索代理接线（缺席→503）。
  // （原先这里还承担 /api/v2/library/series/:id 的惰性 TMDB 刷新接线，该端点已于
  //  2026-08-12「无活 UI 端点」裁决删除，回填改由 daemonV2 的 boot pass 负责。）
  tmdb?: FakeTmdb,
  // 验收修复轮一 Task V2：甄别认领成功后踢一脚扫描的回调（缺席→无事发生，照 jobs/tmdb 既有可选依赖的先例）。
  requestIngest?: () => void,
  // 字幕校验三端点的依赖注入（缺席→接真实模块：真会改写磁盘字幕 + spawn ffmpeg，所以下面
  // 的用例一律注入桩；见 DashboardOpts.subtitleWriteDeps 注释）。
  subtitleWriteDeps?: Partial<SubtitleWriteDeps>,
  // 字幕对照图端点的依赖注入（缺席→接真实模块：会 spawn ffmpeg 抽内嵌轨 + spawn ffprobe
  // 探时长 + 读 /proc/self/mountinfo，后者在 macOS 开发机上恒判 cloud）。
  subtitleCompareDeps?: Partial<SubtitleCompareDeps>,
  // spec A §4.2/§4.4：新依赖统一走末尾选项对象。tmdbGetter / reconcileAllGetter 专供"点火语义"
  // 用例——同一个进程里让 getter 从 null 翻成实体，断言 503 → 200，不重启 dashboard。
  extra?: {
    setupDeps?: Partial<SetupDeps>
    cacheRoot?: string
    tmdbGetter?: () => FakeTmdb | null
    // reconcileAllGetter 已删（第 5.5 步）
  },
): Promise<{ base: string }> {
  server = await startDashboard({
    db, port: 0, host: TEST_HOST, token, distDir,
    // reconcileAll 已删（第 5.5 步）
    env,
    jobs,
    tmdb: extra?.tmdbGetter ?? (tmdb ? () => tmdb : undefined),
    requestIngest,
    subtitleWriteDeps,
    subtitleCompareDeps,
    cacheRoot: extra?.cacheRoot,
    setupDeps: extra?.setupDeps,
  })
  return { base: baseOf(server) }
}

beforeEach(() => {
  db = openDb(':memory:')
  seed(db)
})

describe('startDashboard (v2)', () => {
  it('serves /api/v2/runs', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
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
    expect((await fetch(`${base}/api/v2/mediaLibrary`)).status).toBe(401)
    expect((await fetch(`${base}/api/v2/mediaLibrary?token=s3cret`)).status).toBe(200)
  })

  it('GET /api/v2/subtitle/waveform-peaks without token → 401', async () => {
    const { base } = await start(distWith('<!doctype html>'), 's3cret')
    const res = await fetch(`${base}/api/v2/subtitle/waveform-peaks?itemId=e1`)
    expect(res.status).toBe(401)
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

  })

  // POST /api/v2/reconcile-all 测试已删（第 5.5 步，orchestrator 及其依赖的旧架构全删）


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
      const res = await fetch(`${base}/api/v2/mediaLibrary?token=tok`)
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
        engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
        engineEnabled: true,
      })
    })

    it('GET /api/v2/settings/deploy 反映注入的 env：secrets 脱敏，非机密原样', async () => {
      const { base } = await start(distWith('<!doctype html>'), 'tok', {
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
          engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
          engineEnabled: true,
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
        // D11 / C33（2026-08-08）：新架构 files 行也必须被级联清掉，且计数要如实回显。
        // 放一行进去，证明清理穿透到 HTTP 层——留下的孤儿行会让识别流永远为一个已不在
        // 任何守备目录内的文件跑 agent（C18 幽灵队列）。
        db.prepare(
          `INSERT INTO files (path, dir, filename, size, mtime, updated_at)
           VALUES (?, '/media/tv/Show', 'e1.mkv', 100, 1, ?)`,
        ).run('/media/tv/Show/e1.mkv', NOW)
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/settings/roots?path=${encodeURIComponent('/media/tv')}&token=tok`, { method: 'DELETE' })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ episodes: 1, movies: 0, series: 1, parked: 0, files: 1 })
        expect(settings.listRoots()).toEqual([])
        expect(lib.getSeries('tmdb:99')).toBeNull()
        expect(db.prepare('SELECT COUNT(*) c FROM files').get()).toEqual({ c: 0 })
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
      db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(NOW))
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

    // 2026-08-13 裁决：GET /api/v2/workflow/workers 已删除（无活 UI + 显示位已有活的后继，
    // 见 apiV2.ts 墓碑注释）。用例翻面成**端到端 404**：仍插一行 state='searching' 的
    // worker_task，坐实"即使库里真有该端点会返回的数据，端点本身也不在了"——只断言 404
    // 而不断言空 body，会漏掉"接回来但返回空壳"这种半吊子恢复。
    it('GET /api/v2/workflow/workers 已删除 → 404（即使库里有 searching 的 worker_task）', async () => {
      db.prepare(
        `INSERT INTO jobs (kind, series_id, payload, state, priority, created_at, updated_at)
         VALUES ('worker_task', 's1', ?, 'searching', 0, ?, ?)`
      ).run(JSON.stringify({ taskType: 'find_subtitle', seasons: [1] }), NOW, NOW)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/workflow/workers?token=tok`)
      expect(res.status).toBe(404)
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
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, tmdbStub)
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
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, tmdbStub)
        expect((await fetch(`${base}/api/v2/tmdb/search?type=tv&token=tok`)).status).toBe(400)
        expect((await fetch(`${base}/api/v2/tmdb/search?q=x&type=bogus&token=tok`)).status).toBe(400)
      })

      it('tmdb.search 抛错 → 502（瞬时故障如实转告，不吞成空结果）', async () => {
        const tmdbStub: FakeTmdb = {
          getSeasonTable: async () => [],
          getSeasonEpisodes: async () => [],
          search: async () => { throw new Error('network blew up') },
        }
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, tmdbStub)
        const res = await fetch(`${base}/api/v2/tmdb/search?q=x&type=tv&token=tok`)
        expect(res.status).toBe(502)
        expect(await res.json()).toEqual({ error: 'tmdb search failed' })
      })
    })

    describe('GET /api/v2/triage（认领端点已随两证据红线退役，只剩 pending 事实）', () => {
      it('GET /api/v2/triage 返回 pending', async () => {
        const lib = new LibraryRepo(db)
        lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/triage?token=tok`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual({
          pending: [
            { path: '/media/tv/Unknown Show/e1.mkv', parkReason: 'ambiguous match', firstSeen: NOW, lastAttempt: NOW },
          ],
        })
      })

      it('退役的认领端点如实 404：POST /api/parked/claim、/api/v2/triage/claim、/api/v2/triage/unclaim', async () => {
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        for (const p of ['/api/parked/claim', '/api/v2/triage/claim', '/api/v2/triage/unclaim']) {
          const res = await fetch(`${base}${p}?token=tok`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
          })
          expect(res.status).toBe(404)
        }
      })
    })

    describe('POST /api/v2/triage/unexclude（救援R4b 特典翻案）', () => {
      it('合法翻案 → 200 + 写豁免 + 退 park 户口 + 踢一脚扫描', async () => {
        const lib = new LibraryRepo(db)
        const path = '/media/tv/Show/Show - NCOP01.mkv'
        lib.upsertParkedPath(path, 'excluded-extra', NOW)
        let calls = 0
        const { base } = await start(
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, () => { calls++ },
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
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, () => { calls++ },
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

    // ── POST /api/v2/library/scan ────────────────────────────────────────────
    // 这一族的来历：端点裁决那一轮清点出 11 条"疑似无活 UI"的端点，
    // `/api/v2/library/scan` 是**唯一被判为"活"**的一条（活链路：
    // AppShell settings 分支 → SettingsTabsPage:132 → RootsManager:41 → scanDebouncer → 这里）。
    //
    // 🔴 但它当时**两端零测试覆盖**——变异实测：把这个后端分支删掉、或把前端打的 URL
    // 改成 `/api/v2/WRONG/scan`，后端 3322 + 前端 1287 条用例**无一变红**。
    // 线上后果是"用户加完守备目录后永远不会自动扫描"，且**静默无声**。
    //
    // 那是病 A 的镜像形态：不是"有端点没 UI"，而是"**有活链路却没有任何守卫**"。
    // 名字里带 library 让它更危险——同批被删的三条端点同前缀，下一轮清理的人极易顺手带走它。
    describe('POST /api/v2/library/scan（守备目录改动后踢一脚扫描）', () => {
      it('🔴 POST → 200 且 requestIngest 恰好被调用一次', async () => {
        let calls = 0
        const { base } = await start(
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, () => { calls++ },
        )
        const res = await fetch(`${base}/api/v2/library/scan?token=tok`, { method: 'POST' })
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ ok: true })
        expect(calls).toBe(1)
      })

      it('🔴 未注入 requestIngest（没跑 watch）→ 503，而不是假装成功', async () => {
        // 假装 200 会让用户以为扫描已排上队，然后永远等不到结果。
        const { base } = await start(distWith('<!doctype html>'), 'tok')
        const res = await fetch(`${base}/api/v2/library/scan?token=tok`, { method: 'POST' })
        expect(res.status).toBe(503)
      })

      it('GET 等非 POST → 405（它有副作用，不许被预取/爬虫触发）', async () => {
        let calls = 0
        const { base } = await start(
          distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, () => { calls++ },
        )
        expect((await fetch(`${base}/api/v2/library/scan?token=tok`)).status).toBe(405)
        expect(calls).toBe(0)
      })

      it('无凭据 → 401，且不许触发扫描', async () => {
        let calls = 0
        const { base } = await start(
          distWith('<!doctype html>'), 's3cret', undefined, undefined, undefined, () => { calls++ },
        )
        expect((await fetch(`${base}/api/v2/library/scan`, { method: 'POST' })).status).toBe(401)
        expect(calls).toBe(0)
      })
    })

    describe('POST /api/v2/workflow/redispatch（人类扳手：手动重派）', () => {
      it('合法 body → 转调 upsertWorkerTask，原样返回四态回执', async () => {
        const jobs = new JobsRepo(db)
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, jobs)
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
        const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, jobs)
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
        const { base } = await start(distWith('<!doctype html>'), 's3cret', undefined, jobs)
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
  it('未初始化：/api/v2/mediaLibrary 401 setup required；静态资源照常 200', async () => {
    const { base } = await start(distWith('<!doctype html><title>scout</title>'))
    const api = await fetch(`${base}/api/v2/mediaLibrary`)
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
    const lib = await fetch(`${base}/api/v2/mediaLibrary`, { headers: { cookie } })
    expect(lib.status).toBe(200)
    const out = await fetch(`${base}/api/v2/auth/logout`, { method: 'POST', headers: { cookie } })
    expect(out.status).toBe(200)
    const after = await fetch(`${base}/api/v2/mediaLibrary`, { headers: { cookie } })
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
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { 'x-api-key': apiKey } })).status).toBe(200)
    expect((await fetch(`${base}/api/v2/mediaLibrary?apikey=${apiKey}`)).status).toBe(200)
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { 'x-api-key': 'wrong' } })).status).toBe(401)
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
    expect((await fetch(`${base}/api/v2/mediaLibrary?token=legacy-tok`)).status).toBe(200)
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { 'x-dashboard-token': 'legacy-tok' } })).status).toBe(200)
    expect((await fetch(`${base}/api/v2/mediaLibrary?token=wrong`)).status).toBe(401)
  })
  it('已初始化后 legacy token 仍等价 api key（迁移期共存）', async () => {
    const { base } = await start(distWith('x'), 'legacy-tok')
    await fetch(`${base}/api/v2/auth/setup?token=legacy-tok`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    expect((await fetch(`${base}/api/v2/mediaLibrary?token=legacy-tok`)).status).toBe(200)
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
  it('两个 Plan C 只读端点：无凭据 401，带 session 200 且为空清单', async () => {
    const { base } = await start(distWith('<!doctype html>'), 's3cret')
    for (const path of ['/api/v2/subtitle/shifted', '/api/v2/workflow/dormant']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(401)
    }
    // 鉴权后 200：让锁自证路由存在于门后（未知路径过门后是 404），而非仅仅门会拒。
    // setup 成功即登录、直接签发 session（server.ts 统一前置门的 setup 分支），
    // cookie 夹取法同上文 auth/status 用例。
    const setup = await fetch(`${base}/api/v2/auth/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'hunter2222' }),
    })
    expect(setup.status).toBe(200)
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0]
    for (const path of ['/api/v2/subtitle/shifted', '/api/v2/workflow/dormant']) {
      const res = await fetch(`${base}${path}`, { headers: { cookie } })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
    }
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
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { 'x-api-key': apiKey } })).status).toBe(401)
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { 'x-api-key': nk } })).status).toBe(200)
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
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { cookie: cookie1 } })).status).toBe(200)
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { cookie: cookie2 } })).status).toBe(200)
    // 用 cookie1 改密
    const cp = await fetch(`${base}/api/v2/auth/change-password`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie1 },
      body: JSON.stringify({ oldPassword: 'hunter2222', newPassword: 'newpass8888' }),
    })
    expect(cp.status).toBe(200)
    const cookie3 = (cp.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie3).toMatch(/^scout_session=[0-9a-f]{64}$/)
    // 旧的两枚全失效，新的一枚有效
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { cookie: cookie1 } })).status).toBe(401)
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { cookie: cookie2 } })).status).toBe(401)
    expect((await fetch(`${base}/api/v2/mediaLibrary`, { headers: { cookie: cookie3 } })).status).toBe(200)
  })
})

// ---- 字幕时间轴校验三端点（spec §3.4）----
// HTTP 层用例：只钉住"路由/method/status/响应体形状"这一层。verdict→颜色的映射、写扳手的
// 前置判断等业务规则在 subtitleVerifyApi.test.ts（纯函数层）里钉，这里不重复。
// 三个端点都注入桩依赖：真实实现会改写磁盘上的字幕文件并 spawn ffmpeg 找参考源。
describe('字幕校验三端点', () => {
  const SUB = '/media/Show/s1e1.zh.srt'
  const BACKUP = `${SUB}.scout-backup`

  /** 给 e1 落一行检测结论。内部字段一律给真值——要证明它们在库里却不出响应体（铁律②）。 */
  function seedVerdict(verdict: 'aligned' | 'shifted' | 'unverifiable'): void {
    new SubtitleVerifyRepo(db).upsertVerifyResult({
      itemId: 'e1', verdict,
      offsetMs: verdict === 'shifted' ? 2400 : null,
      score: 0.93, referenceTier: 'embedded',
      subtitlePath: SUB, subtitleHash: 'hash-a', checkedAt: NOW,
      detail: 'ref=embedded: track 3 (chi)',
    })
  }

  /** 写扳手桩：shift/revert 恒成功，reverify 落一行 aligned（模仿 verifyAndRecord 的
   *  "既落库又返回"契约）。`backups` 决定 exists() 认为哪些备份存在。 */
  function stubDeps(backups: string[] = []): Partial<SubtitleWriteDeps> {
    const present = new Set(backups)
    return {
      shift: async () => ({ ok: true, detail: 'shifted' }),
      revert: async () => ({ ok: true, detail: 'reverted' }),
      exists: (p) => present.has(p),
      // 与 seedVerdict 落的 subtitle_hash 一致 = "字幕文件没被换过"（正常路径）。
      // 不打这个桩会走真实的 hashSubtitleContent 去读 /media/... 这个不存在的路径，
      // 得到 null → C-A1 守卫保守拒绝（那是对的行为，但不是本组用例想测的东西）。
      hashSubtitle: async () => 'hash-a',
      reverify: async (itemId, _v, subtitlePath) => {
        new SubtitleVerifyRepo(db).upsertVerifyResult({
          itemId, verdict: 'aligned', offsetMs: null, score: 0.99, referenceTier: 'embedded',
          subtitlePath, subtitleHash: 'hash-b', checkedAt: NOW + 1, detail: 're-checked',
        })
        return {
          verdict: 'aligned', offsetMs: null, score: 0.99,
          referenceTier: 'embedded', detail: 're-checked', subtitleHash: 'hash-b',
        }
      },
    }
  }

  async function startSub(backups: string[] = []): Promise<{ base: string }> {
    // 位置参数（reconcileAll 删除后）：distDir, token, env, jobs, tmdb, requestIngest,
    // subtitleWriteDeps, subtitleCompareDeps, extra —— stubDeps() 必须落在第 7 位。
    // 曾多给一个 undefined 让它落到第 8 位（subtitleCompareDeps），于是 subtitleWriteDeps
    // 缺席 → correct/revert 接真实模块去读真磁盘 → 409/400 而非 200。
    return start(distWith('x'), 'tok', undefined, undefined, undefined, undefined, stubDeps(backups))
  }

  describe('GET /api/v2/subtitle/verify', () => {
    it('未检测过 → checked:false', async () => {
      const { base } = await startSub()
      const res = await fetch(`${base}/api/v2/subtitle/verify?itemId=e1&token=tok`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ items: [{ itemId: 'e1', state: 'ok', checked: false }] })
    })

    it("aligned → state:'ok'", async () => {
      seedVerdict('aligned')
      const { base } = await startSub()
      const body = await (await fetch(`${base}/api/v2/subtitle/verify?itemId=e1&token=tok`)).json()
      expect(body.items[0]).toEqual({ itemId: 'e1', state: 'ok', checked: true })
    })

    // 铁律③的 HTTP 层回归锁：unverifiable 是绿，不是黄也不是红。
    it("unverifiable → state:'ok'【铁律③】", async () => {
      seedVerdict('unverifiable')
      const { base } = await startSub()
      const body = await (await fetch(`${base}/api/v2/subtitle/verify?itemId=e1&token=tok`)).json()
      expect(body.items[0]).toEqual({ itemId: 'e1', state: 'ok', checked: true })
    })

    it("shifted → state:'shifted'", async () => {
      seedVerdict('shifted')
      const { base } = await startSub()
      const body = await (await fetch(`${base}/api/v2/subtitle/verify?itemId=e1&token=tok`)).json()
      expect(body.items[0]).toEqual({ itemId: 'e1', state: 'shifted', checked: true })
    })

    // 铁律②的 HTTP 层回归锁：断言精确键集合 + 原始响应文本不含任何内部字段。
    it('响应体恰好只有三个键，且原始 JSON 不含 offset/score/tier/detail【铁律②】', async () => {
      seedVerdict('shifted')
      const { base } = await startSub()
      const raw = await (await fetch(`${base}/api/v2/subtitle/verify?itemId=e1&token=tok`)).text()
      expect(Object.keys(JSON.parse(raw).items[0]).sort()).toEqual(['checked', 'itemId', 'state'])
      for (const banned of ['offset', 'score', 'tier', 'detail', 'hash', 'embedded', '2400', '0.93']) {
        expect(raw.toLowerCase()).not.toContain(banned.toLowerCase())
      }
    })

    it('批量 ?itemIds=a,b,c 一次拿整季', async () => {
      seedVerdict('shifted')
      const { base } = await startSub()
      const body = await (await fetch(`${base}/api/v2/subtitle/verify?itemIds=e1,e2&token=tok`)).json()
      expect(body.items).toEqual([
        { itemId: 'e1', state: 'shifted', checked: true },
        { itemId: 'e2', state: 'ok', checked: false },
      ])
    })

    it('缺 itemId/itemIds → 400', async () => {
      const { base } = await startSub()
      const res = await fetch(`${base}/api/v2/subtitle/verify?token=tok`)
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('required')
    })

    it('非 GET 方法 → 405', async () => {
      const { base } = await startSub()
      for (const method of ['POST', 'PUT', 'DELETE']) {
        expect((await fetch(`${base}/api/v2/subtitle/verify?itemId=e1&token=tok`, { method })).status).toBe(405)
      }
    })

    it('未鉴权 → 401（统一前置门，不是端点自己做的）', async () => {
      const { base } = await startSub()
      expect((await fetch(`${base}/api/v2/subtitle/verify?itemId=e1`)).status).toBe(401)
    })
  })

  describe('POST /api/v2/subtitle/correct', () => {
    it('shifted → 200 + 新状态，且 DB 结论被覆盖（不再是 shifted）', async () => {
      seedVerdict('shifted')
      const { base } = await startSub()
      const res = await fetch(`${base}/api/v2/subtitle/correct?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'e1' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, state: 'ok' })
      // 重检落库回归锁：不覆盖这行，UI 会一直显示红芯片。
      expect(new SubtitleVerifyRepo(db).getVerifyResult('e1')!.verdict).toBe('aligned')
    })

    it('非 shifted 状态被拒 → 400 + 人话', async () => {
      seedVerdict('aligned')
      const { base } = await startSub()
      const res = await fetch(`${base}/api/v2/subtitle/correct?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'e1' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.error).toContain("isn't out of sync")
      // 库里那行没被动过。
      expect(new SubtitleVerifyRepo(db).getVerifyResult('e1')!.verdict).toBe('aligned')
    })

    it('已校正过一次（备份已存在）→ 409', async () => {
      seedVerdict('shifted')
      const { base } = await startSub([BACKUP])
      const res = await fetch(`${base}/api/v2/subtitle/correct?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'e1' }),
      })
      expect(res.status).toBe(409)
      expect((await res.json()).error).toContain('undo first')
    })

    it('缺 itemId → 400', async () => {
      const { base } = await startSub()
      const res = await fetch(`${base}/api/v2/subtitle/correct?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: 'itemId is required' })
    })

    it('itemId 不存在 → 404', async () => {
      const { base } = await startSub()
      const res = await fetch(`${base}/api/v2/subtitle/correct?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'nope' }),
      })
      expect(res.status).toBe(404)
    })

    it('非法 JSON body → 400（走 readJsonBodyOrFail 的既有口径）', async () => {
      const { base } = await startSub()
      const res = await fetch(`${base}/api/v2/subtitle/correct?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
      })
      expect(res.status).toBe(400)
    })

    it('非 POST 方法 → 405', async () => {
      const { base } = await startSub()
      for (const method of ['GET', 'PUT', 'DELETE']) {
        expect((await fetch(`${base}/api/v2/subtitle/correct?token=tok`, { method })).status).toBe(405)
      }
    })

    it('成功响应体恰好只有 ok/state 两个键，零数字【铁律②】', async () => {
      seedVerdict('shifted')
      const { base } = await startSub()
      const raw = await (await fetch(`${base}/api/v2/subtitle/correct?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'e1' }),
      })).text()
      expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['ok', 'state'])
      expect(raw).not.toMatch(/\d/)
    })

    it('未鉴权 → 401，且不改任何文件', async () => {
      seedVerdict('shifted')
      const { base } = await startSub()
      const res = await fetch(`${base}/api/v2/subtitle/correct`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'e1' }),
      })
      expect(res.status).toBe(401)
      expect(new SubtitleVerifyRepo(db).getVerifyResult('e1')!.verdict).toBe('shifted')
    })
  })

  describe('POST /api/v2/subtitle/revert', () => {
    it('有备份 → 200 + 新状态，且 DB 结论被覆盖', async () => {
      seedVerdict('shifted')
      const { base } = await startSub([BACKUP])
      const res = await fetch(`${base}/api/v2/subtitle/revert?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'e1' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, state: 'ok' })
      const row = new SubtitleVerifyRepo(db).getVerifyResult('e1')!
      expect(row.verdict).toBe('aligned')
      expect(row.checked_at).toBe(NOW + 1)
    })

    it('无备份 → 400', async () => {
      seedVerdict('aligned')
      const { base } = await startSub()
      const res = await fetch(`${base}/api/v2/subtitle/revert?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'e1' }),
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('nothing to undo')
    })

    it('缺 itemId → 400', async () => {
      const { base } = await startSub([BACKUP])
      const res = await fetch(`${base}/api/v2/subtitle/revert?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: 'itemId is required' })
    })

    it('itemId 不存在 → 404', async () => {
      const { base } = await startSub([BACKUP])
      const res = await fetch(`${base}/api/v2/subtitle/revert?token=tok`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'nope' }),
      })
      expect(res.status).toBe(404)
    })

    it('非 POST 方法 → 405', async () => {
      const { base } = await startSub([BACKUP])
      for (const method of ['GET', 'PUT', 'DELETE']) {
        expect((await fetch(`${base}/api/v2/subtitle/revert?token=tok`, { method })).status).toBe(405)
      }
    })

    it('未鉴权 → 401', async () => {
      seedVerdict('shifted')
      const { base } = await startSub([BACKUP])
      const res = await fetch(`${base}/api/v2/subtitle/revert`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemId: 'e1' }),
      })
      expect(res.status).toBe(401)
    })
  })

  // GET /api/v2/subtitle/compare——对照图数据供给。业务规则在 subtitleCompareApi.test.ts
  // （纯函数层）里钉，这里只钉 HTTP 层：接线是否真的通、method/参数门、以及铁律②在
  // **序列化后的字节**上仍然成立。
  describe('GET /api/v2/subtitle/compare', () => {
    /** 对照图桩：待检轨两块、参考轨两块、时长 24 分钟、挂载类型由参数定。
     *  canWaveform 接真实语义（kind !== 'cloud'）而不是写死，否则下面两条回归锁自证。 */
    function stubCompare(kind: 'local' | 'lan' | 'cloud' = 'lan'): Partial<SubtitleCompareDeps> {
      return {
        loadCues: async () => [
          { startMs: 1000, endMs: 3000, text: '这是第一句' },
          { startMs: 5000, endMs: 7000, text: '这是第二句' },
        ],
        findReference: async () => ({
          tier: 'embedded',
          spans: [{ startMs: 1400, endMs: 3400 }, { startMs: 5400, endMs: 7400 }],
          cues: [
            { startMs: 1400, endMs: 3400, text: 'the first line' },
            { startMs: 5400, endMs: 7400, text: 'the second line' },
          ],
          detail: 'embedded track 3 (500 cues)',
        }),
        probeDuration: async () => 1424,
        classify: () => kind,
        canWaveform: (k) => k !== 'cloud',
      }
    }

    async function startCompare(kind: 'local' | 'lan' | 'cloud' = 'lan'): Promise<{ base: string }> {
      return start(
        distWith('x'), 'tok', undefined, undefined, undefined, undefined,
        stubDeps(), stubCompare(kind),
      )
    }

    it('两条轨都带台词文字返回（对照图的全部意义）', async () => {
      seedVerdict('shifted')
      const { base } = await startCompare()
      const res = await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ours).toEqual([
        { startMs: 1000, endMs: 3000, text: '这是第一句' },
        { startMs: 5000, endMs: 7000, text: '这是第二句' },
      ])
      expect(body.reference).toEqual([
        { startMs: 1400, endMs: 3400, text: 'the first line' },
        { startMs: 5400, endMs: 7400, text: 'the second line' },
      ])
      expect(body.durationMs).toBe(1_424_000)
    })

    it("mountKind='cloud' → waveformAvailable:false（前端据此不渲染声音轨）", async () => {
      seedVerdict('shifted')
      const { base } = await startCompare('cloud')
      const body = await (await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)).json()
      expect(body.mountKind).toBe('cloud')
      expect(body.waveformAvailable).toBe(false)
    })

    // spec 验收判据 14 的 HTTP 层回归锁：cifs（lan）不被误禁。实测抽整轨 8 秒，
    // 而生产库 492 个条目全在 cifs 上——"网络挂载就禁用"会禁掉全部。
    it("mountKind='lan' → waveformAvailable:true【cifs 不被误禁的回归锁】", async () => {
      seedVerdict('shifted')
      const { base } = await startCompare('lan')
      const body = await (await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)).json()
      expect(body.mountKind).toBe('lan')
      expect(body.waveformAvailable).toBe(true)
    })

    it("mountKind='local' → waveformAvailable:true", async () => {
      seedVerdict('shifted')
      const { base } = await startCompare('local')
      const body = await (await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)).json()
      expect(body.waveformAvailable).toBe(true)
    })

    // 铁律②的 HTTP 层回归锁：键集合断言，将来有人加字段立刻红。
    it('响应体恰好八个键——内部诊断字段一个都不漏出去【铁律②】', async () => {
      seedVerdict('shifted')
      const { base } = await startCompare()
      const body = await (await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)).json()
      // diagnosis/fixable 是对 offset_ms/score/reference_tier 的**判读**（枚举与布尔），
      // 不是它们本身——判定挪到后端是审计 I-B1/I-B2 的修法（前端曾有第二个判定引擎）。
      // 下面那条字符串级锁仍然钉住原始数字一个都不出去。
      expect(Object.keys(body).sort()).toEqual([
        'diagnosis', 'durationMs', 'fixable', 'itemId', 'mountKind', 'ours', 'reference',
        'waveformAvailable',
      ])
      expect(body.diagnosis).toBe('behind')
      expect(body.fixable).toBe(true)
    })

    it('序列化后的字节里不含 score/offsetMs/referenceTier/detail【铁律②字符串级锁】', async () => {
      seedVerdict('shifted')
      const { base } = await startCompare()
      const raw = await (await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)).text()
      // 库里确实有这些值（seedVerdict 落了 score 0.93 / offsetMs 2400 / detail），
      // 且参考源桩也带了 tier 与 detail——这些**字段名**都不该出现在这串字节里。
      //
      // 刻意只断言字段名，不断言"2400"/"0.93"这类**数值子串**：时间戳与时长是合法的
      // 定位坐标，它们的十进制表示会天然包含任意数字子串（实测 durationMs=1424000 里
      // 就含 "2400"，让这条断言假红过一次）。数值层面的封闭由上面那条键集合断言保证——
      // DTO 只有八个键，多出来的任何字段都会被它当场抓住，不需要在字节里猜数字。
      for (const forbidden of ['score', 'offsetMs', 'offset_ms', 'referenceTier', 'reference_tier', 'detail', 'tier', 'embedded']) {
        expect(raw).not.toContain(forbidden)
      }
    })

    it('每个块恰好三个键（startMs/endMs/text）', async () => {
      seedVerdict('shifted')
      const { base } = await startCompare()
      const body = await (await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)).json()
      for (const block of [...body.reference, ...body.ours]) {
        expect(Object.keys(block).sort()).toEqual(['endMs', 'startMs', 'text'])
      }
    })

    it('无参考源 → 200 + 空 reference（不是 404：资源存在，缺的只是"拿什么比"）', async () => {
      seedVerdict('shifted')
      const { base } = await start(
        distWith('x'), 'tok', undefined, undefined, undefined, undefined,
        stubDeps(), { ...stubCompare(), findReference: async () => null },
      )
      const res = await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.reference).toEqual([])
      expect(body.ours).toHaveLength(2)
    })

    it('未检测过 → 404', async () => {
      const { base } = await startCompare()
      const res = await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)
      expect(res.status).toBe(404)
    })

    it('itemId 缺失 → 400', async () => {
      const { base } = await startCompare()
      const res = await fetch(`${base}/api/v2/subtitle/compare?token=tok`)
      expect(res.status).toBe(400)
    })

    it('itemId 是纯空白 → 400（不拿空串去查库）', async () => {
      const { base } = await startCompare()
      const res = await fetch(`${base}/api/v2/subtitle/compare?itemId=%20%20&token=tok`)
      expect(res.status).toBe(400)
    })

    it('待检字幕读不出来 → 500', async () => {
      seedVerdict('shifted')
      const { base } = await start(
        distWith('x'), 'tok', undefined, undefined, undefined, undefined,
        stubDeps(), { ...stubCompare(), loadCues: async () => null },
      )
      const res = await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`)
      expect(res.status).toBe(500)
    })

    it('非 GET 方法 → 405', async () => {
      seedVerdict('shifted')
      const { base } = await startCompare()
      for (const method of ['POST', 'PUT', 'DELETE']) {
        expect((await fetch(`${base}/api/v2/subtitle/compare?itemId=e1&token=tok`, { method })).status).toBe(405)
      }
    })

    it('未鉴权 → 401', async () => {
      seedVerdict('shifted')
      const { base } = await startCompare()
      expect((await fetch(`${base}/api/v2/subtitle/compare?itemId=e1`)).status).toBe(401)
    })
  })
})

describe('setup 面端点（spec A §4.4）', () => {
  it('GET /api/v2/setup/status：全新零配置 → bootstrapComplete=false、engineEnabled=true（fail-open）', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    const r = await fetch(`${base}/api/v2/setup/status?token=tok`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.bootstrapComplete).toBe(false)
    expect(body.engineEnabled).toBe(true)
    expect(body.tmdb.satisfied).toBe(false)
  })

  it('PUT /api/v2/settings/secrets：白名单外 400、合法写入后 status 反映 source=db + 打码、空值删除', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    const bad = await fetch(`${base}/api/v2/settings/secrets?token=tok`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'AWS_SECRET', value: 'x' }),
    })
    expect(bad.status).toBe(400)
    const put = await fetch(`${base}/api/v2/settings/secrets?token=tok`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'TMDB_API_KEY', value: 'abcdefghij' }),
    })
    expect(put.status).toBe(200)
    const status = await (await fetch(`${base}/api/v2/setup/status?token=tok`)).json()
    expect(status.tmdb.satisfied).toBe(true)
    expect(status.tmdb.source).toBe('db')
    expect(status.tmdb.masked).not.toContain('abcdefghij')   // 永不回读明文
    const del = await fetch(`${base}/api/v2/settings/secrets?token=tok`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'TMDB_API_KEY', value: '' }),
    })
    expect(del.status).toBe(200)
    const after = await (await fetch(`${base}/api/v2/setup/status?token=tok`)).json()
    expect(after.tmdb.satisfied).toBe(false)
  })

  it('POST /api/v2/setup/validate：未知 target → 400；未配置 target → 200 + ok:false', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    const unknown = await fetch(`${base}/api/v2/setup/validate?token=tok`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'github' }),
    })
    expect(unknown.status).toBe(400)
    const r = await fetch(`${base}/api/v2/setup/validate?token=tok`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'assrt' }),
    })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain('not configured')
  })

  it('两新 GET 无 token → 401（统一前置门覆盖）', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok')
    expect((await fetch(`${base}/api/v2/setup/status`)).status).toBe(401)
    expect((await fetch(`${base}/api/v2/setup/providers`)).status).toBe(401)
  })

  it('点火语义 · GET /api/v2/tmdb/search：同进程内 getter 从 null 翻成客户端 → 503 变 200', async () => {
    const tmdbStub: FakeTmdb = {
      getSeasonTable: async () => [],
      getSeasonEpisodes: async () => [],
      search: async () => [{ id: 1, title: 'X', originalTitle: 'X', year: 2020, posterPath: null }],
    }
    let ignited = false
    // 位置参数：distDir, token, env, jobs, tmdb, requestIngest,
    // subtitleWriteDeps, subtitleCompareDeps, extra —— 中间七个一律 undefined。
    const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined, undefined, undefined, {
      tmdbGetter: () => (ignited ? tmdbStub : null),
    })
    expect((await fetch(`${base}/api/v2/tmdb/search?q=x&type=tv&token=tok`)).status).toBe(503)
    ignited = true   // = wizard 落库 + holder 热重建的等价物：消费点现取现判空
    const after = await fetch(`${base}/api/v2/tmdb/search?q=x&type=tv&token=tok`)
    expect(after.status).toBe(200)
    expect(await after.json()).toEqual({ results: [{ id: 1, name: 'X', year: 2020, posterPath: null }] })
  })

  // 点火语义 reconcile-all 测试已删（第 5.5 步）

  // ── R-F2 / R-F5 媒体库页两个新端点：**走真实 HTTP** ────────────────────────────
  // 为什么必须在这里再测一遍（builder 单测已经全绿了还测）：本仓栽过 6 次「加了能力却没定
  // 谁写/谁读/谁触发」，最近一次的形态正是"函数写好了但没人叫"——builder 层 8 条用例全绿，
  // 而端点根本没挂进 router。只有真实 fetch 能证明这条线是通的。
  describe('媒体库页数据端点（R-F2 / R-F5）', () => {
    /** 直写新架构三张表（files/works/tmdb_seasons）——顶部的 seed() 喂的是旧表，两套不通用。 */
    function seedMediaLibrary(db: ScoutDb): void {
      db.prepare(
        `INSERT INTO works (id, title, year, media_type, poster_path, chinese_titles, created_at, updated_at)
         VALUES ('tmdb:1','Breaking Bad',2008,'tv','/bb.jpg','["绝命毒师"]',?,?)`,
      ).run(NOW, NOW)
      db.prepare(
        `INSERT INTO tmdb_seasons (series_id, season, episode, title, fetched_at)
         VALUES ('tmdb:1',1,3,'E3',?), ('tmdb:1',1,4,'E4',?)`,
      ).run(NOW, NOW)
      // 同一集两份文件（两个「绝命毒师」目录），只有一份有字幕 —— R-F2 防猴子用户核心用例
      const ins = db.prepare(
        `INSERT INTO files (path, dir, filename, size, mtime, work_id, season, episode, sub_status, updated_at)
         VALUES (?,?,?,1,1,'tmdb:1',1,3,?,?)`,
      )
      ins.run('/media/bb-1080p/S01E03.mkv', '/media/bb-1080p', 'S01E03.mkv', 'covered', NOW)
      ins.run('/media/bb-4k/S01E03.mkv', '/media/bb-4k', 'S01E03.mkv', null, NOW)
      // 孤儿（识别失败）——按 R-F2 不许露出
      db.prepare(
        `INSERT INTO files (path, dir, filename, size, mtime, work_id, updated_at)
         VALUES ('/media/mystery/whatever.mkv','/media/mystery','whatever.mkv',1,1,NULL,?)`,
      ).run(NOW)
    }

    it('🔴 GET /api/v2/mediaLibrary 真的挂上了（不是只写了 builder 没人叫）', async () => {
      seedMediaLibrary(db)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/mediaLibrary?token=tok`)
      expect(res.status).toBe(200)
      const list = (await res.json()) as any[]
      // 孤儿不露出 → 只有一个作品
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        workId: 'tmdb:1', title: 'Breaking Bad', chineseTitle: '绝命毒师',
        year: 2008, posterPath: '/bb.jpg', mediaType: 'tv',
        expectedEpisodeCount: 2, onDiskEpisodeCount: 1, missingEpisodeCount: 1,
        subtitledEpisodeCount: 1,
      })
    })

    it('🔴 GET /api/v2/mediaLibrary/:workId 真的挂上了，且 R-F2「任一份有字幕」经 HTTP 成立', async () => {
      seedMediaLibrary(db)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/mediaLibrary/tmdb:1?token=tok`)
      expect(res.status).toBe(200)
      const detail = (await res.json()) as any
      expect(detail.work).toMatchObject({ workId: 'tmdb:1', mediaType: 'tv' })
      expect(detail.seasons).toHaveLength(1)
      // E3 实有（两份文件、一份有字幕 → 绿点）；E4 应有但磁盘没有（虚线、无点）
      expect(detail.seasons[0].episodes).toEqual([
        expect.objectContaining({ episode: 3, onDisk: true, dot: 'green', fileCount: 2, subtitledFileCount: 1 }),
        expect.objectContaining({ episode: 4, onDisk: false, dot: 'none' }),
      ])
    })

    it('id 段 %3A 编码同样可用（前端 encodeURIComponent 后的形态）', async () => {
      seedMediaLibrary(db)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/mediaLibrary/tmdb%3A1?token=tok`)
      expect(res.status).toBe(200)
      expect((await res.json() as any).work.workId).toBe('tmdb:1')
    })

    it('不存在的 workId → 404；非法 id → 400', async () => {
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      expect((await fetch(`${base}/api/v2/mediaLibrary/tmdb:404?token=tok`)).status).toBe(404)
      expect((await fetch(`${base}/api/v2/mediaLibrary/..%2Fetc?token=tok`)).status).toBe(400)
    })

    it('🔴 鉴权：两个新端点走与其余 /api/v2/* 完全相同的那一道统一前置门', async () => {
      seedMediaLibrary(db)
      const { base } = await start(distWith('<!doctype html>'), 's3cret')
      expect((await fetch(`${base}/api/v2/mediaLibrary`)).status).toBe(401)
      expect((await fetch(`${base}/api/v2/mediaLibrary/tmdb:1`)).status).toBe(401)
      expect((await fetch(`${base}/api/v2/mediaLibrary?token=s3cret`)).status).toBe(200)
      expect((await fetch(`${base}/api/v2/mediaLibrary/tmdb:1?token=s3cret`)).status).toBe(200)
    })
  })

  // ── R-F3 通知端点：**走真实 HTTP** ──────────────────────────────────────────
  // 为什么必须在这里测（notificationsRepo 的 20 条单测已经全绿了还测）：这个 task 修的
  // 恰恰是"读函数全绿、表里有数据、就是没人把它挂上 HTTP"——repo 层的用例对这种缺陷
  // 100% 无感。只有真实 fetch 能证明这条线是通的。
  describe('通知端点（R-F3）', () => {
    /** 直写 notifications 表。不走 recordFound 是刻意的：这些用例要钉的是**端点吐出来的
     *  东西**，用 repo 的写函数喂会让"写口径错了但读口径跟着一起错"的情况照样通过。 */
    function insertFound(
      db: ScoutDb,
      row: { workId: string; title: string; season: number | null; episode: number | null; via: string; foundAt: number },
    ): void {
      db.prepare(
        `INSERT INTO notifications (work_id, title, season, episode, via, found_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(row.workId, row.title, row.season, row.episode, row.via, row.foundAt)
    }

    const DAY = 24 * 3600_000

    /** 端点用的是 `Date.now()`（同隔壁 workflowPending/events 的既有口径），所以种子数据
     *  必须挂在真实当下的相对位置上，不能用文件顶部那个固定的 NOTIFICATION_* 无关的 NOW
     *  （1_700_000_000_000 早已在一周窗外，全部会被读窗过滤掉）。 */
    function seedNotifications(db: ScoutDb): number {
      const now = Date.now()
      // 绝命毒师 S01：三集，两个来路 → 应聚成 **一组**，via='mixed'，episodes 升序
      insertFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 1, episode: 7, via: 'fetch', foundAt: now - 3 * DAY })
      insertFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 1, episode: 3, via: 'translate', foundAt: now - 2 * DAY })
      insertFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 1, episode: 5, via: 'fetch', foundAt: now - 1 * DAY })
      // 同一作品的 S02 是**另一组**（键含季）
      insertFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 2, episode: 1, via: 'fetch', foundAt: now - 4 * DAY })
      // 电影：season/episode 皆 NULL → 单独一组、episodes 为空数组
      insertFound(db, { workId: 'tmdb:9', title: '沙丘', season: null, episode: null, via: 'fetch', foundAt: now - 10 * 60_000 })
      // 超一周窗：**不许出现在响应里**（R-F3「保留一周」是读时过滤，不依赖清理跑过）
      insertFound(db, { workId: 'tmdb:77', title: '陈年老剧', season: 1, episode: 1, via: 'fetch', foundAt: now - 8 * DAY })
      return now
    }

    it('🔴 GET /api/v2/notifications 真的挂上了（第 7 次同型缺陷：表有、数据有、读函数有，就是没端点）', async () => {
      seedNotifications(db)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/notifications?token=tok`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(Array.isArray(await res.json())).toBe(true)
    })

    it('🔴 条数 == 按 work+season 聚合的组数（**不是**逐集行数——设计文档 v3 的 COUNT(*) 是错的）', async () => {
      seedNotifications(db)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const list = (await (await fetch(`${base}/api/v2/notifications?token=tok`)).json()) as any[]

      // 验收口径原样落成 SQL（一周窗与端点同源：都用 Date.now() 减 7 天）
      const cutoff = Date.now() - 7 * DAY
      const groups = (db.prepare(
        `SELECT COUNT(DISTINCT work_id || '/' || COALESCE(season, -1)) AS n
           FROM notifications WHERE found_at > ?`,
      ).get(cutoff) as { n: number }).n
      const rows = (db.prepare(
        'SELECT COUNT(*) AS n FROM notifications WHERE found_at > ?',
      ).get(cutoff) as { n: number }).n

      expect(list).toHaveLength(groups)
      // 两个口径必须真的不同，否则这条断言什么也没证明（种子里 S01 是三集聚成一组）
      expect(rows).toBeGreaterThan(groups)
    })

    it('🔴 返回 FoundGroup[] 的完整形状：季分组、episodes 升序、混合来路如实报 mixed', async () => {
      seedNotifications(db)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const list = (await (await fetch(`${base}/api/v2/notifications?token=tok`)).json()) as any[]

      const s1 = list.find((g) => g.workId === 'tmdb:1' && g.season === 1)
      expect(s1).toMatchObject({ workId: 'tmdb:1', title: '绝命毒师', season: 1, via: 'mixed' })
      // 展示用「第 3/5/7 集」——升序，不是插入序也不是 found_at 序
      expect(s1.episodes).toEqual([3, 5, 7])
      // latestAt = 组内最近一次（E5 那条，now-1d），不是最早那条
      expect(s1.latestAt).toBeGreaterThan(list.find((g) => g.season === 2).latestAt)

      // 同一作品的 S02 是独立的一组（键含季）
      expect(list.find((g) => g.workId === 'tmdb:1' && g.season === 2)).toMatchObject({
        episodes: [1], via: 'fetch',
      })
      // 电影：season NULL + episodes 空数组
      expect(list.find((g) => g.workId === 'tmdb:9')).toMatchObject({
        title: '沙丘', season: null, episodes: [], via: 'fetch',
      })
    })

    it('🔴 倒序（R-F3）：组间按 latestAt 从新到旧', async () => {
      seedNotifications(db)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const list = (await (await fetch(`${base}/api/v2/notifications?token=tok`)).json()) as any[]
      const times = list.map((g) => g.latestAt)
      expect(times).toEqual([...times].sort((a, b) => b - a))
      // 最新的是那部十分钟前的电影
      expect(list[0].workId).toBe('tmdb:9')
    })

    it('🔴 保留一周是**读时过滤**，不依赖 dbMaintenance 的清理跑过', async () => {
      seedNotifications(db) // 里面有一条 now-8d 的
      // 前提校验：那行确实还躺在表里（这条用例测的是读窗，不是清理）
      expect((db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n).toBe(6)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const list = (await (await fetch(`${base}/api/v2/notifications?token=tok`)).json()) as any[]
      expect(list.map((g) => g.workId)).not.toContain('tmdb:77')
    })

    it('空表 → 200 + 空数组（不是 404，通知页首次打开就是这一态）', async () => {
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      const res = await fetch(`${base}/api/v2/notifications?token=tok`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
    })

    it('🔴 不做已读（R-F3）：写方法一律 405，且不改动表', async () => {
      seedNotifications(db)
      const { base } = await start(distWith('<!doctype html>'), 'tok')
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}/api/v2/notifications?token=tok`, { method })
        expect(res.status).toBe(405)
        expect(await res.json()).toEqual({ error: 'method not allowed' })
      }
      // 405 之后表原样（没有任何写路径偷偷落地）
      expect((db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n).toBe(6)
    })

    it('🔴 鉴权：走与其余 /api/v2/* 完全相同的那一道统一前置门（三通道）', async () => {
      seedNotifications(db)
      const { base } = await start(distWith('<!doctype html>'), 's3cret')
      expect((await fetch(`${base}/api/v2/notifications`)).status).toBe(401)
      expect((await fetch(`${base}/api/v2/notifications?token=s3cret`)).status).toBe(200)
      // x-api-key 通道：前置门认的是 settings 里那把 key，这里只钉"错的 key 进不来"
      expect((await fetch(`${base}/api/v2/notifications`, { headers: { 'x-api-key': 'wrong' } })).status).toBe(401)
    })
  })

})
