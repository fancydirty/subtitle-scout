// src/dashboard/server.ts
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, normalize, extname, resolve, sep } from 'node:path'
import { URL } from 'node:url'
import type { ScoutDb } from '../v2/db.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { refreshSeriesCatalog } from '../v2/tmdbCatalog.js'
import {
  buildLibrary, buildSeriesDetail, buildRuns, buildParked, claimParked, unexclude,
  buildSettings, buildDeploySettings, listMediaSubdirs, updateSettings, addMediaRoot,
  buildWorkflowPending, buildWorkflowPasses, buildWorkflowWorkers, buildLibrarySeriesDetail,
  buildTriage, redispatch, buildRunTrace,
  type ReconcileAllResultDTO,
} from './apiV2.js'
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
  /** dashboard G4：GET /api/v2/settings/deploy 脱敏展示的 env 来源——默认 process.env，测试
   *  注入固定值以避免依赖跑测试的机器/CI 实际配了什么。 */
  env?: Record<string, string | undefined>
  /** dashboard G5：POST /api/v2/workflow/redispatch（人类扳手：手动重派）依赖——undefined（纯
   *  只读测试场景）时该端点返回 503，同 reconcileAll 缺席的既有先例。 */
  jobs?: Pick<JobsRepo, 'upsertWorkerTask'>
  /** dashboard G5：GET /api/v2/library/series/:id 命中时的惰性 TMDB 应有集缓存刷新（G2 遗留的
   *  触发点）——undefined（TMDB_API_KEY 未配置）时跳过，端点本身照常返回磁盘现状，不因为缺
   *  TMDB 而报错。
   *  dashboard-F5：'search' 供 GET /api/v2/tmdb/search（ClaimDialog 的只读搜索代理）转调——
   *  同一个 tmdb 依赖，缺席时两个消费点各自独立降级（这里 503，series/:id 那边跳过刷新）。 */
  tmdb?: Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes' | 'search'>
  /** 验收修复轮一 Task V2：甄别台目录组认领成功后踢一脚扫描——认领只写 override（见
   *  claimParked 注释），停车行真正退户口要等下一轮 ingest pass 命中这条 override 重新识别
   *  成功。不等 daemon 自己的时间门（ingestEveryMs），认领这一刻立即请求一次扫描，让用户体感
   *  "认领后很快消失"而不是等到下一个自然扫描周期。undefined（watch 进程未接线，或纯只读
   *  测试场景）＝无事发生，同 reconcileAll/jobs/tmdb 三个既有可选依赖的缺席降级先例——不强制
   *  startDashboard 的调用方必须提供这个回调。 */
  requestIngest?: () => void
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
}

function serveStatic(distDir: string, pathname: string): { status: number; body: Buffer; type: string } {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const base = normalize(distDir)
  const full = normalize(join(distDir, rel))
  // 必须用 base + sep 开头：否则兄弟目录 <distDir>-old 仍满足 startsWith(base)，导致 prefix 穿越。
  if (full !== base && !full.startsWith(base + sep)) return { status: 403, body: Buffer.from('forbidden'), type: 'text/plain' }
  const target = existsSync(full) && extname(full) ? full : join(distDir, 'index.html') // SPA 回退
  if (!existsSync(target)) return { status: 404, body: Buffer.from('not found'), type: 'text/plain' }
  return { status: 200, body: readFileSync(target), type: CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' }
}

/** 启动只读监控 HTTP 端点。port=0 让内核分配（测试用）。 */
export function startDashboard(opts: DashboardOpts): Promise<Server> {
  const { db, port, token, distDir, reconcileAll, env = process.env, jobs, tmdb, requestIngest } = opts
  const settingsRepo = new SettingsRepo(db)
  const deps: RouterDeps = {
    library: () => buildLibrary(db),
    series: (id) => buildSeriesDetail(db, id),
    runs: (offset, limit) => buildRuns(db, offset, limit),
    parked: () => buildParked(db),
    settings: () => buildSettings(settingsRepo),
    deploySettings: () => buildDeploySettings(env),
    roots: () => settingsRepo.listRoots(),
    fsList: (path) => listMediaSubdirs(path),
    workflowPending: () => buildWorkflowPending(db, settingsRepo, Date.now()),
    workflowPasses: (limit) => buildWorkflowPasses(db, limit),
    workflowWorkers: () => buildWorkflowWorkers(db, Date.now()),
    // G2 遗留的惰性刷新触发点：命中一个真实存在的 series 时 fire-and-forget 踢一次
    // refreshSeriesCatalog（TTL 门在函数内部，无脑调用即可）——tmdb 缺席时跳过，不影响这个端点
    // 本身的同步返回；只在 detail 非 null（series 真存在）时才触发，避免对着不存在的 series id
    // 白打一次早退调用。
    librarySeriesDetail: (id) => {
      const detail = buildLibrarySeriesDetail(db, id)
      if (detail && tmdb) void refreshSeriesCatalog(db, tmdb, id, Date.now()).catch(() => {})
      return detail
    },
    triage: () => buildTriage(db),
    runTrace: (id) => buildRunTrace(db, id),
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
      // dashboard G5：/api/v2/triage/claim 是同一个 claimParked 实现的第二个入口——两条路径
      // 并存（v2 前缀给新前端一个自洽面，旧路径不动），合并成一个分支而不是复制两份，
      // 避免两份一样的代码日后各改各的悄悄漂移。
      if (rawPath === '/api/parked/claim' || rawPath === '/api/v2/triage/claim') {
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
        // 验收修复轮一 Task V2：认领成功后踢一脚扫描（DashboardOpts.requestIngest 注释）——
        // fire-and-forget：不 await（不让扫描拖慢这个端点的响应），同步抛错也吞掉（认领这个
        // 动作本身已经写对了数据，触发扫描失败不该让它对用户显示失败；下一个自然周期还会再扫
        // 一次，不会永久错过）。
        if (result.ok && requestIngest) {
          try {
            requestIngest()
          } catch {
            // swallow — 见上方注释。
          }
        }
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
        return
      }

      // 救援R4b：POST /api/v2/triage/unexclude——甄别页「Excluded extras」箱翻案。照 claim 分支
      // 的薄转发先例：method 门 → token 门 → 解析 body → unexclude(db) 判断层 → 成功踢一脚扫描。
      if (rawPath === '/api/v2/triage/unexclude') {
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
        const b = (body ?? {}) as { path?: unknown }
        const result = unexclude(db, { path: typeof b.path === 'string' ? b.path : '' })
        // 翻案成功后踢一脚扫描——豁免已写库、park 行已退，重扫让文件立即重回识别流（同 claim
        // 先例：fire-and-forget，同步抛错吞掉，下一个自然周期还会再扫）。
        if (result.ok && requestIngest) {
          try {
            requestIngest()
          } catch {
            // swallow — 见 claim 分支同款注释。
          }
        }
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
        return
      }

      // dashboard G4：PUT /api/v2/settings——GET 同路径的展示走下面纯同步的 handleApiRoute
      // 分发（RouterDeps.settings），这里只截 method !== 'GET' 的写路径：PUT 之外一律 405
      // （同 parked/claim 先例：先 method 门再 token 门，PUT 需要解析 JSON body，不能是纯函数）。
      if (rawPath === '/api/v2/settings' && req.method !== 'GET') {
        if (req.method !== 'PUT') {
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
        const result = updateSettings(settingsRepo, body, Date.now())
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.ok ? result.settings : { error: result.error }))
        return
      }

      // dashboard G4：POST/DELETE /api/v2/settings/roots——GET（listRoots 展示）同样走下面纯
      // 同步的 handleApiRoute 分发，这里只截 method !== 'GET' 的写路径。DELETE 用 query 传参
      // （?path=...），不用 body——同 GET 端点的传参习惯一致，且删除是幂等操作不需要 JSON body。
      if (rawPath === '/api/v2/settings/roots' && req.method !== 'GET') {
        if (req.method !== 'POST' && req.method !== 'DELETE') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        if (token && reqToken !== token) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        if (req.method === 'DELETE') {
          const path = url.searchParams.get('path')
          if (!path) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'path query param is required' }))
            return
          }
          // R2D-6（R2 复审）：POST 侧 addMediaRoot 落库前先 resolve() 归一化（见 apiV2.ts 该函数
          // 注释），DELETE 侧此前直接拿 query 里的原始字符串去精确匹配——两侧口径不对称，用户
          // 加个尾斜杠（"/media/tv/" vs 库里存的 "/media/tv"）就会 404，明明是同一个根。这里
          // resolve() 一次，与 add 侧口径对称。
          // 复审修复 1：removeRoot 自带存在性守卫——不是登记在册的守备目录返回 null（含现存根
          // 的父目录），这里映射成 404，绝不对非根路径跑级联清库。
          const result = settingsRepo.removeRoot(resolve(path))
          if (!result) {
            res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'not a media root' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(result))
          return
        }
        // POST
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
        const b = (body ?? {}) as { path?: unknown }
        const result = addMediaRoot(settingsRepo, b.path, Date.now())
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.ok ? { ok: true } : { error: result.error }))
        return
      }

      // dashboard G5：POST /api/v2/workflow/redispatch——人类扳手①：手动重派。与
      // /api/v2/reconcile-all 同一先例：method 门 → token 门 → 依赖是否配置门（jobs 缺席→503，
      // 这里没有 TMDB_API_KEY 一说，纯粹是"watch 进程有没有把 JobsRepo 传进来"）→ body 解析 →
      // 转调 apiV2.redispatch 纯函数（zod 校验 + upsertWorkerTask）。
      if (rawPath === '/api/v2/workflow/redispatch') {
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
        if (!jobs) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'redispatch not configured (jobs repo missing)' }))
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
        const result = redispatch(jobs, body, Date.now())
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.ok ? result.outcome : { error: result.error }))
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
        // 复审修复（守护进程存活，两道都上）：socket 猝死（客户端断网/杀进程）到 'close' 事件
        // 触发之间有窗口——窗口内订阅回调或心跳的 res.write 打在已毁/将毁的流上，ServerResponse
        // 无 'error' 监听器时是 uncaughtException，整个守护进程（产品本体）直接崩。第一道：
        // no-op 'error' 兜底吃掉在途写入的 EPIPE/ERR_STREAM_DESTROYED；第二道：写入前置守卫，
        // 已知已毁的流连写都不写。
        res.on('error', () => {})
        const unsubscribe = traceBus.subscribe((e) => {
          if (res.destroyed || res.writableEnded) return
          res.write(`data: ${JSON.stringify(e)}\n\n`)
        })
        const heartbeat = setInterval(() => {
          if (res.destroyed || res.writableEnded) return
          res.write(': hb\n\n')
        }, 15_000)
        req.on('close', () => {
          clearInterval(heartbeat)
          unsubscribe()
        })
        return
      }

      // dashboard-F5：GET /api/v2/tmdb/search?q=…&type=tv|movie——ClaimDialog 的 TMDB 搜索代理
      // （只读）。独立分支（不是 router.ts 纯函数）：需要 await tmdb.search，同
      // reconcile-all/redispatch 先例——method 门 → token 门 → tmdb 缺席门（503，同 reconcile-all
      // 缺 TMDB_API_KEY 的既有先例）→ query 校验 → 转调真实 TmdbClient.search，结果映射成
      // {results:[{id,name,year,posterPath}]}（TmdbSearchHit.title → name，对齐 ClaimDialog
      // "海报缩略+名+年份"的呈现用词）。tmdb.search 本身失败（网络/超时/非 2xx，
      // TmdbRequestFailedError）如实报 502，不吞成空结果数组——瞬时故障要如实转告使用者
      // （DESIGN.md §8：数据诚实），不能让"TMDB 抽风"和"真的查无结果"在 UI 上长一个样。
      if (rawPath === '/api/v2/tmdb/search') {
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
        if (!tmdb) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'tmdb search not configured (TMDB_API_KEY missing?)' }))
          return
        }
        const q = url.searchParams.get('q')
        if (!q) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'q query param is required' }))
          return
        }
        const mediaType = url.searchParams.get('type')
        if (mediaType !== 'tv' && mediaType !== 'movie') {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: "type must be 'tv' or 'movie'" }))
          return
        }
        try {
          const hits = await tmdb.search(mediaType, q)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({
            results: hits.map((h) => ({ id: h.id, name: h.title, year: h.year, posterPath: h.posterPath })),
          }))
        } catch {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'tmdb search failed' }))
        }
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
