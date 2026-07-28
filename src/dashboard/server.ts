// src/dashboard/server.ts
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, normalize, extname, resolve, sep } from 'node:path'
import { URL } from 'node:url'
import type { ScoutDb } from '../v2/db.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { refreshSeriesCatalog } from '../v2/tmdbCatalog.js'
import {
  buildLibrary, buildSeriesDetail, buildRuns, buildParked, unexclude,
  buildSettings, buildDeploySettings, listMediaSubdirs, updateSettings, addMediaRoot,
  buildWorkflowPending, buildWorkflowPasses, buildWorkflowWorkers, buildLibrarySeriesDetail,
  buildTriage, redispatch, buildRunTrace,
  type ReconcileAllResultDTO,
} from './apiV2.js'
import { handleApiRoute, type RouterDeps } from './router.js'
import { traceBus } from '../core/traceBus.js'
import { AuthService, AUTH_KEYS, safeStrEqual } from './auth.js'

export interface DashboardOpts {
  db: ScoutDb
  port: number
  /** legacy DASHBOARD_TOKEN 兼容输入——唯一角色是喂下方统一前置门的 legacy token 通道
   *  （A1 起鉴权只有前置门一处；旧部署带 ?token=/x-dashboard-token 头照常通行）。 */
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
   *  dashboard-F5：'search' 供 GET /api/v2/tmdb/search（只读搜索代理；原为 ClaimDialog 而设，
   *  认领退役后前端不再调用，端点保留为无害的只读代理）转调——
   *  同一个 tmdb 依赖，缺席时两个消费点各自独立降级（这里 503，series/:id 那边跳过刷新）。 */
  tmdb?: Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes' | 'search'>
  /** 验收修复轮一 Task V2（原为甄别台认领后踢扫描；认领已随两证据红线退役——见 triageOps.ts
   *  头注释——本回调保留给 unexclude 翻案分支：翻案写库后立即请求一次扫描，让用户体感"翻案后
   *  文件很快重回识别流"而不是等下一个自然扫描周期）。undefined（watch 进程未接线，或纯只读
   *  测试场景）＝无事发生，同 reconcileAll/jobs/tmdb 三个既有可选依赖的缺席降级先例——不强制
   *  startDashboard 的调用方必须提供这个回调。 */
  requestIngest?: () => void
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
}

const JSON_CT = { 'content-type': 'application/json; charset=utf-8' }

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  }
  return out
}

function sessionCookie(token: string): string {
  // 无 HTTPS（家庭局域网形态，spec §2 安全边界如实）故无 Secure；反代加 TLS 见 README
  return `scout_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`
}

/** JSON body 读取：解析失败返回 undefined（调用方 400），空 body 视作 {}。
 *  大小上限 1MB——超限抛 'payload too large'（调用方转 413，防内存 DoS）。
 *  收 Buffer 再一次性 decode：逐 chunk `raw += chunk` 会把跨 chunk 边界的多字节 UTF-8
 *  字符切成 U+FFFD（含 CJK 的大 body 偶发 400），且 String.length 按 UTF-16 code unit
 *  计数会让实际字节上限虚高约 3 倍（防线比声称的宽）。
 *  ⚠️ 超限时**只停止累积、不 destroy socket**：req.destroy() 会连带毁掉响应通道，
 *  客户端拿到的是连接重置（fetch failed）而不是 413，反而更难排查。累积上限已经封住
 *  内存增长，剩余入站字节由 Node 在 res.end() 后自行丢弃。 */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const MAX_BODY_BYTES = 1_000_000 // 1MB（按字节，不按字符）
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      chunks.length = 0 // 立即释放已累积的内存，不再继续收
      throw new Error('payload too large')
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return undefined
  }
}

/** 哨兵：readJsonBodyOrFail 已经写完响应（400/413），调用方必须直接 return。
 *  不能用 null 表示"已失败"——`JSON.parse('null')` 是合法的 JSON body，会与失败态撞车，
 *  导致调用方 `if (body === null) return` 直接返回却没人写过响应，请求永久挂到 requestTimeout。 */
const BODY_FAILED = Symbol('body-failed')

/** 辅助：读取 JSON body，统一 400（非法 JSON）/413（超 1MB）响应。
 *  失败时**已写完响应**并返回 BODY_FAILED 哨兵；成功返回解析结果（可能是合法的 null）。 */
async function readJsonBodyOrFail(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<unknown | typeof BODY_FAILED> {
  try {
    const body = await readJsonBody(req)
    if (body === undefined) {
      res.writeHead(400, JSON_CT)
      res.end(JSON.stringify({ error: 'invalid JSON body' }))
      return BODY_FAILED
    }
    return body
  } catch (e) {
    if (e instanceof Error && e.message === 'payload too large') {
      res.writeHead(413, JSON_CT)
      res.end(JSON.stringify({ error: 'payload too large' }))
      return BODY_FAILED
    }
    throw e
  }
}

function serveStatic(distDir: string, pathname: string): { status: number; body: Buffer; type: string } {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const base = normalize(distDir)
  const full = normalize(join(distDir, rel))
  // 必须用 base + sep 开头：否则兄弟目录 <distDir>-old 仍满足 startsWith(base)，导致 prefix 穿越。
  if (full !== base && !full.startsWith(base + sep)) return { status: 403, body: Buffer.from('forbidden'), type: 'text/plain' }
  // R6-10 修复：statSync TOCTOU——existsSync(full) && statSync(full).isFile() 两步之间文件消失
  // 时 statSync 抛 ENOENT → 500。try/catch 包住 statSync，失败按"不存在"走 SPA 回退。
  let target = join(distDir, 'index.html')
  try {
    if (existsSync(full) && statSync(full).isFile() && extname(full)) {
      target = full
    }
  } catch {
    // 文件在 existsSync 和 statSync 之间消失——按不存在处理，走 SPA 回退
  }
  if (!existsSync(target)) return { status: 404, body: Buffer.from('not found'), type: 'text/plain' }
  return { status: 200, body: readFileSync(target), type: CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' }
}

/** 启动只读监控 HTTP 端点。port=0 让内核分配（测试用）。 */
export function startDashboard(opts: DashboardOpts): Promise<Server> {
  const { db, port, token, distDir, reconcileAll, env = process.env, jobs, tmdb, requestIngest } = opts
  const settingsRepo = new SettingsRepo(db)
  const auth = new AuthService(settingsRepo)
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

      // ---- 鉴权 A1：统一前置门（spec §2）。静态资源不设防（SPA 壳/login 页本身要能加载），
      // /api/* 全部先过这里。cookie/api key/legacy token 三通道；未初始化只放 setup/status。----
      if (rawPath.startsWith('/api/')) {
        const cookies = parseCookies(req.headers.cookie)
        const sessionToken = cookies['scout_session']
        const apiKeyReq = (req.headers['x-api-key'] as string | undefined) ?? url.searchParams.get('apikey') ?? undefined
        const legacyReq = url.searchParams.get('token') ?? (req.headers['x-dashboard-token'] as string | undefined)
        const authed =
          (sessionToken !== undefined && auth.sessions.verify(sessionToken, Date.now())) ||
          (apiKeyReq !== undefined && auth.verifyApiKey(apiKeyReq)) ||
          // legacy DASHBOARD_TOKEN：常量时间比较（审计 #4——与 api key 路径口径一致，不留 === 时序侧信道）。
          (token !== undefined && legacyReq !== undefined && safeStrEqual(legacyReq, token))

        // 探测端点：任何态放行（前端 app-shell 靠它决定去 /setup、/login 还是正常渲染）
        if (rawPath === '/api/v2/auth/status' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ initialized: auth.isInitialized(), authenticated: authed }))
          return
        }

        if (rawPath === '/api/v2/auth/setup') {
          if (req.method !== 'POST') { res.writeHead(405, JSON_CT); res.end(JSON.stringify({ error: 'method not allowed' })); return }
          if (auth.isInitialized()) { res.writeHead(403, JSON_CT); res.end(JSON.stringify({ error: 'already initialized' })); return }
          const body = await readJsonBodyOrFail(req, res)
          if (body === BODY_FAILED) return
          const b = (body ?? {}) as { username?: unknown; password?: unknown }
          const r = auth.setup(
            typeof b.username === 'string' ? b.username : '',
            typeof b.password === 'string' ? b.password : '', Date.now(),
          )
          if (!r.ok) { res.writeHead(400, JSON_CT); res.end(JSON.stringify({ error: r.error })); return }
          // 成功即登录（spec §3 向导语义）：直接签发 session cookie
          const t = auth.sessions.create(Date.now())
          res.writeHead(200, { ...JSON_CT, 'set-cookie': sessionCookie(t) })
          res.end(JSON.stringify({ ok: true, apiKey: r.apiKey }))
          return
        }

        if (rawPath === '/api/v2/auth/login') {
          if (req.method !== 'POST') { res.writeHead(405, JSON_CT); res.end(JSON.stringify({ error: 'method not allowed' })); return }
          const body = await readJsonBodyOrFail(req, res)
          if (body === BODY_FAILED) return
          const b = (body ?? {}) as { username?: unknown; password?: unknown }
          // 登录限流来源：反代部署下 req.socket.remoteAddress 是反代 IP（全 LAN 共享），任何人
          // 5 次失败会锁死所有管理员（自我 DoS）。TRUST_PROXY=true 时取 x-forwarded-for 最右跳
          // （自己代理追加的，不是客户端自报的——最左可被伪造）。
          // ⚠️ 取最右跳：nginx 默认 $proxy_add_x_forwarded_for 是追加而非覆盖，最左是客户端自报值，
          //    攻击者每次请求换一个伪造 XFF 即可绕过限流。最右是自己代理追加的，更稳。
          const remoteAddr = process.env.TRUST_PROXY === 'true'
            ? ((req.headers['x-forwarded-for'] as string | undefined)?.split(',').pop()?.trim() ?? req.socket.remoteAddress ?? 'unknown')
            : (req.socket.remoteAddress ?? 'unknown')
          const r = auth.login(
            typeof b.username === 'string' ? b.username : '',
            typeof b.password === 'string' ? b.password : '',
            remoteAddr, Date.now(),
          )
          if (!r.ok) { res.writeHead(r.status, JSON_CT); res.end(JSON.stringify({ error: r.error })); return }
          res.writeHead(200, { ...JSON_CT, 'set-cookie': sessionCookie(r.sessionToken) })
          res.end(JSON.stringify({ ok: true }))
          return
        }

        if (rawPath === '/api/v2/auth/logout') {
          if (req.method !== 'POST') { res.writeHead(405, JSON_CT); res.end(JSON.stringify({ error: 'method not allowed' })); return }
          if (sessionToken) auth.sessions.revoke(sessionToken)
          res.writeHead(200, { ...JSON_CT, 'set-cookie': 'scout_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' })
          res.end(JSON.stringify({ ok: true }))
          return
        }

        if (!authed) {
          res.writeHead(401, JSON_CT)
          res.end(JSON.stringify({ error: auth.isInitialized() ? 'unauthorized' : 'setup required' }))
          return
        }

        // ---- 鉴权 A3：Security 区三端点（已过前置门，此处必然 authed）----
        if (rawPath === '/api/v2/auth/security') {
          if (req.method !== 'GET') { res.writeHead(405, JSON_CT); res.end(JSON.stringify({ error: 'method not allowed' })); return }
          // 完整 apiKey 只对已鉴权管理员回显（Sonarr 同款语义）；前端脱敏展示尾 4 位、复制钮拷全量。
          res.writeHead(200, JSON_CT)
          res.end(JSON.stringify({
            username: settingsRepo.get(AUTH_KEYS.username) ?? '',
            apiKey: settingsRepo.get(AUTH_KEYS.apiKey) ?? '',
          }))
          return
        }
        if (rawPath === '/api/v2/auth/change-password') {
          if (req.method !== 'POST') { res.writeHead(405, JSON_CT); res.end(JSON.stringify({ error: 'method not allowed' })); return }
          const body = await readJsonBodyOrFail(req, res)
          if (body === BODY_FAILED) return
          const b = (body ?? {}) as { oldPassword?: unknown; newPassword?: unknown }
          const r = auth.changePassword(
            typeof b.oldPassword === 'string' ? b.oldPassword : '',
            typeof b.newPassword === 'string' ? b.newPassword : '', Date.now(),
          )
          if (!r.ok) { res.writeHead(400, JSON_CT); res.end(JSON.stringify({ error: r.error })); return }
          // 审计 MEDIUM #1：changePassword 已清空全部会话（含发起者自己的）——给当前请求补发一枚
          // 新 cookie，让改密的管理员不被自己踢下线（"sign out everywhere but me"），其它会话仍失效。
          const fresh = auth.sessions.create(Date.now())
          res.writeHead(200, { ...JSON_CT, 'set-cookie': sessionCookie(fresh) })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (rawPath === '/api/v2/auth/regenerate-api-key') {
          if (req.method !== 'POST') { res.writeHead(405, JSON_CT); res.end(JSON.stringify({ error: 'method not allowed' })); return }
          res.writeHead(200, JSON_CT)
          res.end(JSON.stringify({ apiKey: auth.regenerateApiKey(Date.now()) }))
          return
        }
      }

      // v3 phase ⑦："全仓校验"触发器——异步 + 只接受 POST，独立于下面纯同步的 handleApiRoute
      // 分发。鉴权已由上方统一前置门完成（A1 起它是唯一的门），这里只剩 method/存在性检查。
      if (rawPath === '/api/v2/reconcile-all') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
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

      // 认领端点（POST /api/parked/claim、/api/v2/triage/claim）已退役（两证据红线裁决，
      // 见 src/v2/triageOps.ts 头注释）：正确的用户动作是改文件名，不是零证据指派身份。

      // 救援R4b：POST /api/v2/triage/unexclude——甄别页「Excluded extras」箱翻案。薄转发
      // 形状：method 门 → 解析 body → unexclude(db) 判断层 → 成功踢一脚扫描（鉴权在统一前置门）。
      if (rawPath === '/api/v2/triage/unexclude') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
        const b = (body ?? {}) as { path?: unknown }
        const result = unexclude(db, { path: typeof b.path === 'string' ? b.path : '' })
        // 翻案成功后踢一脚扫描——豁免已写库、park 行已退，重扫让文件立即重回识别流
        // （fire-and-forget：不 await，同步抛错吞掉——翻案本身已经写对了数据，触发扫描失败
        // 不该让它对用户显示失败；下一个自然周期还会再扫一次，不会永久错过）。
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

      // POST /api/v2/triage/unclaim（审计 A-5 的认领撤销扳手）已随 identify_overrides 表
      // 一并退役——没有认领，就没有可撤销的认领。

      // dashboard G4：PUT /api/v2/settings——GET 同路径的展示走下面纯同步的 handleApiRoute
      // 分发（RouterDeps.settings），这里只截 method !== 'GET' 的写路径：PUT 之外一律 405
      // （PUT 需要解析 JSON body，不能是纯函数；鉴权在统一前置门）。
      if (rawPath === '/api/v2/settings' && req.method !== 'GET') {
        if (req.method !== 'PUT') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
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
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
        const b = (body ?? {}) as { path?: unknown }
        const result = addMediaRoot(settingsRepo, b.path, Date.now())
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.ok ? { ok: true } : { error: result.error }))
        return
      }

      // dashboard G5：POST /api/v2/workflow/redispatch——人类扳手①：手动重派。与
      // /api/v2/reconcile-all 同一先例：method 门 → 依赖是否配置门（jobs 缺席→503，
      // 这里没有 TMDB_API_KEY 一说，纯粹是"watch 进程有没有把 JobsRepo 传进来"）→ body 解析 →
      // 转调 apiV2.redispatch 纯函数（zod 校验 + upsertWorkerTask）。鉴权在统一前置门。
      if (rawPath === '/api/v2/workflow/redispatch') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        if (!jobs) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'redispatch not configured (jobs repo missing)' }))
          return
        }
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
        const result = redispatch(jobs, body, Date.now())
        res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.ok ? result.outcome : { error: result.error }))
        return
      }

      // 痕迹通道 C：agent 工具调用直播——GET only（鉴权已由统一前置门完成，这里只剩 method 门），
      // 命中后就地把响应转成 SSE 流，独立于下面纯同步的 handleApiRoute 分
      // 发（订阅是有状态的长连接，不是一次性算完就 return 的纯函数）。
      if (rawPath === '/api/v2/workflow/trace-stream') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
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

      // dashboard-F5：GET /api/v2/tmdb/search?q=…&type=tv|movie——TMDB 搜索代理（只读）。
      // 原为 ClaimDialog 而设；认领退役（见 triageOps.ts 头注释）后前端不再调用，保留为
      // 无害的只读代理。独立分支（不是 router.ts 纯函数）：需要 await tmdb.search，同
      // reconcile-all/redispatch 先例——method 门 → tmdb 缺席门（503，同 reconcile-all
      // 缺 TMDB_API_KEY 的既有先例）→ query 校验 → 转调真实 TmdbClient.search，结果映射成
      // {results:[{id,name,year,posterPath}]}。tmdb.search 本身失败（网络/超时/非 2xx，
      // TmdbRequestFailedError）如实报 502，不吞成空结果数组——瞬时故障要如实转告使用者
      // （DESIGN.md §8：数据诚实），不能让"TMDB 抽风"和"真的查无结果"在 UI 上长一个样。
      if (rawPath === '/api/v2/tmdb/search') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
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
        const result = handleApiRoute({ pathname: rawPath, query }, deps)
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.json))
        return
      }

      let decodedPath: string
      try {
        decodedPath = decodeURIComponent(url.pathname)
      } catch (e) {
        // URIError: 畸形百分号编码(如 %ZZ)——收敛成 400,同 router.ts:53 的 decodeIdSegment 先例
        res.writeHead(400, JSON_CT)
        res.end(JSON.stringify({ error: 'invalid URL encoding' }))
        return
      }
      const s = serveStatic(distDir, decodedPath)
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
