// src/dashboard/server.ts
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { URL } from 'node:url'
import type { ScoutDb } from '../v2/db.js'
import { buildLibrary, buildSeriesDetail, buildRuns, buildParked, claimParked, type ReconcileAllResultDTO } from './apiV2.js'
import { handleApiRoute, type RouterDeps } from './router.js'
import { traceBus } from './traceBus.js'

export interface DashboardOpts {
  db: ScoutDb
  port: number
  token?: string
  distDir: string
  /** v3 phase ⑦："全仓校验"触发器——POST /api/v2/reconcile-all 调它，跑一次机械预扫描
   *  +一次编排器过（src/v2/reconcileAll.ts 的 runReconcileAll，cmdReconcileAll CLI 命令共用
   *  同一个函数，不重复实现）。undefined（TMDB_API_KEY 未配置，或纯只读测试场景）时该端点
   *  返回 503，而不是让请求悬空或让 startDashboard 强制要求这个回调。 */
  reconcileAll?: () => Promise<ReconcileAllResultDTO>
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
}

function serveStatic(distDir: string, pathname: string): { status: number; body: Buffer; type: string } {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const full = normalize(join(distDir, rel))
  if (!full.startsWith(normalize(distDir))) return { status: 403, body: Buffer.from('forbidden'), type: 'text/plain' }
  const target = existsSync(full) && extname(full) ? full : join(distDir, 'index.html') // SPA 回退
  if (!existsSync(target)) return { status: 404, body: Buffer.from('not found'), type: 'text/plain' }
  return { status: 200, body: readFileSync(target), type: CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' }
}

/** 启动只读监控 HTTP 端点。port=0 让内核分配（测试用）。 */
export function startDashboard(opts: DashboardOpts): Promise<Server> {
  const { db, port, token, distDir, reconcileAll } = opts
  const deps: RouterDeps = {
    library: () => buildLibrary(db),
    series: (id) => buildSeriesDetail(db, id),
    runs: (offset, limit) => buildRuns(db, offset, limit),
    parked: () => buildParked(db),
  }

  // v3 phase ⑦ review fix: reconcile-all runs a full mechanical scan + orchestrator LLM pass —
  // expensive, and with no guard, repeated POSTs (e.g. an impatient user double-clicking, or a
  // hostile actor when DASHBOARD_TOKEN is unset) each launch a fresh overlapping pass, multiplying
  // scan/LLM cost with every extra request (a cheap DoS lever). A single boolean flag scoped to
  // this server instance is enough — startDashboard runs once per daemon process, so this is
  // effectively the "module-level flag" the review asked for, just closure-scoped instead of
  // truly global (avoids leaking state across independent startDashboard calls in tests).
  let reconcileInFlight = false

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rawPath = url.pathname   // 未解码
      const reqToken = url.searchParams.get('token') ?? (req.headers['x-dashboard-token'] as string | undefined)

      // v3 phase ⑦："全仓校验"触发器——异步 + 只接受 POST，独立于下面纯同步的 handleApiRoute
      // 分发（同 handleApiRoute 一样，token 校验放在方法/存在性检查之后没关系：两项都不泄露
      // 除"这个端点存在"外的信息）。
      if (rawPath === '/api/v2/reconcile-all') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        if (token && reqToken !== token) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        if (!reconcileAll) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'reconcile-all not configured (TMDB_API_KEY missing?)' }))
          return
        }
        // Overlap guard (no `await` between the check and the flip, so two requests racing in the
        // same event-loop turn can't both slip through — only one process runs this callback at a
        // time regardless).
        if (reconcileInFlight) {
          res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'reconcile-all already running — try again once it finishes' }))
          return
        }
        reconcileInFlight = true
        try {
          const result = await reconcileAll()
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: String(e) }))
        } finally {
          reconcileInFlight = false
        }
        return
      }

      // 去 Jellyfin 化 P6："park 救援页"认领——POST + JSON body，同 reconcile-all 一样独立于
      // 下面纯同步的 handleApiRoute 分发（body 解析需要 await，handleApiRoute 保持纯函数）。
      if (rawPath === '/api/parked/claim') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        if (token && reqToken !== token) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let body: unknown
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'invalid JSON body' }))
          return
        }
        const b = (body ?? {}) as { path?: unknown; tmdbId?: unknown; isTv?: unknown; season?: unknown }
        // P7 disambiguation 补丁：season 未传/null → undefined/null（claimParked 视作"未指定"，
        // 原有行为）；传了但不是 number（如字符串/布尔）→ NaN，claimParked 的
        // Number.isInteger 校验会诚实拒绝，而不是静默丢弃一个格式错误的输入。
        const result = claimParked(db, {
          path: typeof b.path === 'string' ? b.path : '',
          tmdbId: typeof b.tmdbId === 'string' ? b.tmdbId : String(b.tmdbId ?? ''),
          isTv: Boolean(b.isTv),
          season: typeof b.season === 'number' ? b.season : (b.season == null ? b.season as null | undefined : NaN),
        })
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
        return
      }

      // 痕迹通道 C：agent 工具调用直播——GET only + token 门（照抄上面两个先例分支的顺序：先
      // method，再 token），命中后就地把响应转成 SSE 流，独立于下面纯同步的 handleApiRoute 分
      // 发（订阅是有状态的长连接，不是一次性算完就 return 的纯函数）。
      if (rawPath === '/api/v2/workflow/trace-stream') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        if (token && reqToken !== token) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        // writeHead() 本身不保证把响应头立即冲到 socket——Node 默认等到第一次 write()/end() 才
        // 冲刷。SSE 客户端却要在第一条数据/心跳到达前就看到连接已建立（fetch() 的 headers 承诺
        // 得早于 15s 心跳 resolve），显式 flushHeaders() 补上这一刻，不然客户端会白等一个心跳
        // 周期才看到 200（真实复现过：flushHeaders 缺席时 fetch() 卡到第一次 res.write 才返回）。
        res.flushHeaders()
        const unsubscribe = traceBus.subscribe((e) => {
          res.write(`data: ${JSON.stringify(e)}\n\n`)
        })
        const heartbeat = setInterval(() => res.write(': hb\n\n'), 15_000)
        req.on('close', () => {
          clearInterval(heartbeat)
          unsubscribe()
        })
        return
      }

      if (rawPath.startsWith('/api/')) {
        const query: Record<string, string> = {}
        url.searchParams.forEach((v, k) => { query[k] = v })
        const result = handleApiRoute({ pathname: rawPath, query, token: reqToken ?? undefined }, deps, token)
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.json))
        return
      }

      const s = serveStatic(distDir, decodeURIComponent(url.pathname))
      res.writeHead(s.status, { 'content-type': s.type })
      res.end(s.body)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
  return new Promise(resolve => {
    server.on('error', e => { console.error(`dashboard server error: ${e}`); resolve(server) })
    server.listen(port, () => resolve(server))
  })
}
