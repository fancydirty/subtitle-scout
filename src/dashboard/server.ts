// src/dashboard/server.ts
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, normalize, extname, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { URL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ScoutDb } from '../v2/db.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { refreshSeriesCatalog } from '../v2/tmdbCatalog.js'
import {
  buildLibrary, buildSeriesDetail, buildRuns, buildParked, unexclude,
  buildSettings, buildDeploySettings, listMediaSubdirs, updateSettings, addMediaRoot,
  buildWorkflowPending, buildWorkflowPasses, buildWorkflowWorkers, buildLibrarySeriesDetail,
  buildTriage, redispatch, buildRunTrace, buildDormantTasks, buildLibraryMovieDetail,
  type ReconcileAllResultDTO,
} from './apiV2.js'
// R-F2 / R-F5：媒体库页数据层（新架构 files/works/tmdb_seasons）。刻意与 apiV2.js 分开
// import —— 两套 builder 读的是完全不同的表，混在一行会让"哪个长在旧表上"不可见。
import { buildMediaLibrary, buildMediaLibraryDetail } from './mediaLibraryApi.js'
// R-F3：通知页列表的读函数。**复用**，不在 dashboard 层重写查询——一周窗与倒序都长在
// 那边（读窗常量还与 dbMaintenance 的 pruneFound 共用），另写一份必然静默漂移。
import { listRecentFoundGrouped } from '../v2/notificationsRepo.js'
import { handleApiRoute, type RouterDeps } from './router.js'
import { traceBus } from '../core/traceBus.js'
import type { ScoutEventBus, ScoutCurrent } from '../core/scoutEvents.js'
// Task ⑤：GET /api/v2/health 的 `roots[].ok` 陈旧门以巡检周期为单位（见
// ROOT_HEALTH_STALE_AFTER_MS 的论证——不在这里写死 48h）。**只引常量、不引 daemon 类**：
// daemonV2 的模块图（48 个模块，已核）不含 dashboard/*，故无环。
import { INSPECT_INTERVAL_MS } from '../v2/daemonV2.js'
import { AuthService, AUTH_KEYS, safeStrEqual } from './auth.js'
import {
  buildVerifyDTOs, correctSubtitle, revertSubtitle, parseItemIds, parseItemIdBody,
  buildShiftedDTOs,
  type SubtitleWriteDeps,
} from './subtitleVerifyApi.js'
import {
  buildCompareDTO, type SubtitleCompareDeps, extractWaveformPeaks, type ExtractPeaksDeps,
  resolveDurationMs,
} from './subtitleCompareApi.js'
import { findReferenceSource } from '../subtitleVerify/referenceSource.js'
import { readSubtitleText, parseCues, hashSubtitleContent } from '../subtitleVerify/subtitleSpans.js'
import { probeDurationSec } from '../files/streamProbe.js'
import { classifyPath, canRenderWaveform } from '../core/mountKind.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { SubtitleVerifyRepo } from '../v2/subtitleVerifyRepo.js'
import {
  shiftSubtitleTiming, revertSubtitleTiming, BACKUP_SUFFIX,
} from '../subtitleVerify/shiftTiming.js'
import { verifyAndRecord } from '../subtitleVerify/verifySubtitle.js'
import type { SetupDeps } from './setupApi.js'
import { buildSetupStatus, buildProviders, putSecret, validateSetupTarget } from './setupApi.js'
// Task ⑤：/api/v2/health 的 engineEnabled 判据。**复用**而不是第三次手写 `!== 'false'`
// ——同一件事在健康横幅 / setup 页 / daemon 派活三条路上给出不同答案是 D7/C30 的既有形态。
import { engineEnabled } from '../cli/watchClients.js'

export interface DashboardOpts {
  db: ScoutDb
  port: number
  /** 监听网卡。缺省（生产/Docker）＝不传 host 给 listen()，即通配 `::`，容器外才能连进来。
   *
   *  ── 为什么需要这个字段（测试 flake 的根因，2026-08-12 实测定位）──────────────
   *  `listen(0)` 不带 host 时 Node 绑的是 **IPv6 通配 `::`**，OS 只保证这个端口在 `::` 的
   *  ephemeral 空间里没被占；而测试拿 `server.address().port` 拼出的 base 一律是
   *  **`http://127.0.0.1:<port>`**（IPv4）。两个地址族的端口空间在 macOS/Linux 上**不互斥**：
   *  同一个号完全可能同时被本机另一个进程的 IPv4 socket 持有——那个进程可以是并行的另一个
   *  vitest worker，也可以是开发机上任何一个监听 0.0.0.0 的服务。于是请求根本没到本用例的
   *  server 上，而是打给了陌生人。
   *
   *  实测证据（十进程 × 600 轮的复现脚本，无 host）：
   *   · `SyntaxError: Unexpected end of JSON input` ← 拿到别人的 `401`/`404` 空体；
   *   · `<!DOCTYPE html>…` ← 拿到开发机上另一个前端 dev server 的首页。
   *  两条都带同一个指纹：`server.on('request')` 计数为 **0**——本用例的 server 一个请求都没收到。
   *  这正是 server.test.ts 头注释描述的症状，但**归因错了**：前人认为是"`port: 0` 端口回收 +
   *  undici 按 host:port 缓存连接、复用到已关闭 server"。该机制在 Node 19+ 上不成立
   *  （`close()` 会主动回收空闲 keep-alive socket；单进程 300 轮"关旧 server→新 server 抢同一
   *  端口→再请求"实测 0/300 串台），所以他们那两层缓解（closeAllConnections + 换 dispatcher）
   *  修的是一个不存在的通道——真正的串台发生在**跨进程、跨地址族**，客户端连接池清得再干净
   *  也拦不住，因为那条连接从一开始就是新建的、且它连对了 IPv4 端口，只是那个端口不是我们的。
   *
   *  绑死 `127.0.0.1` 后，端口的分配与拨号处在同一个地址族，OS 的 ephemeral 端口保证重新生效；
   *  真撞上了也会变成显式 `EADDRINUSE`（可观测），而不是静默拿到陌生人的响应体。 */
  host?: string
  /** legacy DASHBOARD_TOKEN 兼容输入——唯一角色是喂下方统一前置门的 legacy token 通道
   *  （A1 起鉴权只有前置门一处；旧部署带 ?token=/x-dashboard-token 头照常通行）。 */
  token?: string
  distDir: string
  // reconcileAll 已删（第 5.5 步，orchestrator 及其依赖的旧架构全删）
  /** dashboard G4：GET /api/v2/settings/deploy 脱敏展示的 env 来源——默认 process.env，测试
   *  注入固定值以避免依赖跑测试的机器/CI 实际配了什么。 */
  env?: Record<string, string | undefined>
  /** dashboard G5：POST /api/v2/workflow/redispatch（人类扳手：手动重派）依赖——undefined（纯
   *  只读测试场景）时该端点返回 503。 */
  jobs?: Pick<JobsRepo, 'upsertWorkerTask'>
  /** dashboard G5：GET /api/v2/library/series/:id 命中时的惰性 TMDB 应有集缓存刷新（G2 遗留的
   *  触发点）——undefined（TMDB_API_KEY 未配置）时跳过，端点本身照常返回磁盘现状，不因为缺
   *  TMDB 而报错。
   *  dashboard-F5：'search' 供 GET /api/v2/tmdb/search（只读搜索代理；原为 ClaimDialog 而设，
   *  认领退役后前端不再调用，端点保留为无害的只读代理）转调——
   *  同一个 tmdb 依赖，缺席时两个消费点各自独立降级（这里 503，series/:id 那边跳过刷新）。 */
  /** spec A §4.2：tmdb 改 getter 注入（holder 覆盖 dashboard 注入面）——消费处现取现判空,
   *  缺席语义不变（series 详情惰性刷新跳过、tmdb/search 503）。 */
  tmdb?: () => Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes' | 'search'> | null
  /** spec A：setupApi 的默认实现需要 cacheRoot（assrt 探测的缓存目录）；测试可注入临时目录。 */
  cacheRoot?: string
  /** spec A：setup 三端点的依赖注入（缺席→接真实实现，同 subtitleWriteDeps 的既有注入口惯例）。 */
  setupDeps?: Partial<SetupDeps>
  /** 验收修复轮一 Task V2（原为甄别台认领后踢扫描；认领已随两证据红线退役——见 triageOps.ts
   *  头注释——本回调保留给 unexclude 翻案分支：翻案写库后立即请求一次扫描，让用户体感"翻案后
   *  文件很快重回识别流"而不是等下一个自然扫描周期）。undefined（watch 进程未接线，或纯只读
   *  测试场景）＝无事发生，同 jobs/tmdb 既有可选依赖的缺席降级先例——不强制
   *  startDashboard 的调用方必须提供这个回调。 */
  requestIngest?: () => void
  /** 字幕校验三端点（GET verify / POST correct / POST revert）的依赖注入口。
   *
   *  与 jobs/tmdb 那几个"缺席就 503"的可选依赖**不同**：这三个端点的默认实现
   *  完全由 db + 真实模块拼出来（下方 wiring），生产环境无需任何额外接线就能用，所以缺席
   *  不降级。这个字段**只为测试而存在**：`shift`/`revert` 会真的改写磁盘上的字幕文件、
   *  `reverify` 会真的 spawn ffmpeg 找参考源，ESM 又无法 spy 模块导出——不给注入口就没法测
   *  "校正后重新检测并覆盖落库"这条主路径（同 shiftTiming.ShiftOptions /
   *  referenceSource opts 的既有注入惯例）。
   *
   *  部分覆盖：给出的字段替换默认实现，未给出的沿用默认（测试通常只想换掉 shift 与 reverify
   *  两个真会产生副作用的，repo/lib/now 让它照常打真库）。 */
  subtitleWriteDeps?: Partial<SubtitleWriteDeps>
  /** GET /api/v2/subtitle/compare（字幕对照图数据）的依赖注入。与 subtitleWriteDeps 同一
   *  性质：默认实现由 db + 真实模块拼出（下方 wiring），缺席不降级，**只为测试而存在**。
   *
   *  这里的副作用比写扳手更隐蔽但同样真实：`findReference` 会 spawn ffmpeg 抽内嵌轨、
   *  `probeDuration` 会 spawn ffprobe、`classify` 会读 /proc/self/mountinfo（macOS 开发机上
   *  恒读不到 → 恒判 cloud，那样"lan 不被误禁"这条回归锁在开发机上压根跑不起来）。 */
  subtitleCompareDeps?: Partial<SubtitleCompareDeps>
  /** R-F10：全站唯一那条 SSE 通道（GET /api/v2/events）的事件源。
   *
   *  为什么是**注入**而不是模块级单例（与隔壁 traceBus 刻意不同）：单例会让并行跑的用例
   *  互相串事件，而这条通道的每一条用例都在数"收到几条"。生产接线在 cmdWatch——同一个
   *  ScoutEventBus 实例一头给 daemonV2 的 emit、一头给这里。
   *
   *  缺席 → 该端点 503（照 jobs/tmdb 那批可选依赖的既有降级先例）。**不做成 200 空流**：
   *  那种失败是静默的（前端对着一条永远没数据的流干等，界面看起来只是"很安静"），正是
   *  本仓栽过 6 次的"有能力但没人触发"那一类。 */
  events?: ScoutEventBus
  /** SSE 保活注释帧的周期。默认 15s；**测试注入小值**，否则每条心跳用例要真等 15 秒。 */
  eventsHeartbeatMs?: number
}

/** SSE 保活注释帧周期（R-F10 约束 1：保活不许占事件通道，故用注释帧而不是数据帧）。
 *  15s 沿用隔壁 trace-stream 的既有值——反代（nginx 默认 60s proxy_read_timeout）掐断
 *  空闲连接前必须有东西流过。 */
const EVENTS_HEARTBEAT_MS = 15_000

/**
 * Task ⑤：`roots[].ok` 判"这条判决还新鲜吗"的容差 = **2 个巡检周期**。
 *
 * ── 为什么必须有这个门（Task ③ 审计留下的债务）────────────────────────────────
 * `media_roots.last_error` / `last_checked_at` 的唯一写入点是 daemonV2.scanOnce 的 finally，
 * 而它只遍历**本轮 scanRoots**。库里有、本轮没扫到的根（rootsProvider 与 media_roots 表
 * 漂移、或 daemon 压根没在跑）的两列会**永久停在上一轮的值**：last_error 粘住、
 * last_checked_at 停在旧时刻。此时 `ok = (last_error === null)` 是一句**主动的假话**——
 * 它把一个几周没人碰过的根报成绿的（或把一个早就修好的根报成红的）。
 *
 * ── 为什么是 2× 而不是 1× ──────────────────────────────────────────────────
 * 1× 会**每天误报**：巡检自身要跑（大库在 115 FUSE 上实测能跑数小时，daemonV2.ts:527
 * 的时间闸记的是**开始**时刻），失败还走 INSPECT_FAILURE_BACKOFF_MS 的独立退避。于是
 * "上次检查 24.5 小时前"是完全正常的稳态，1× 门下每天都会有一段时间把健康的根刷成未知。
 * 2× = 完整错过一个巡检周期，那才是真的有事（daemon 死了 / 这个根从 scanRoots 里掉出去了）。
 *
 * ── 为什么复用 INSPECT_INTERVAL_MS 而不是就地写 48h ─────────────────────────
 * 这个门的语义是"几个巡检周期"，不是"几小时"。写死 48h 之后谁改了巡检周期（daemonV2 的
 * `inspectEveryMs` 就是为此存在的注入口），这里会静默漂移成一个与巡检节奏无关的魔数——
 * 本仓 D7/C30「留两份实现必漂移」的既有形态。
 */
const ROOT_HEALTH_STALE_AFTER_MS = 2 * INSPECT_INTERVAL_MS

/** GET /api/v2/health 的 `roots[]` 元素。字段一律非可选（`| null` 而不是 `?`）：
 *  这东西要 JSON.stringify 给前端，undefined 会让字段**整个消失**，前端就分不清
 *  "没有这个事实"和"这版后端还没这个字段"（同 ScoutCurrent 的既有论证）。 */
export interface HealthRootDTO {
  path: string
  /**
   * 这个根现在健不健康。**三态，不是布尔**——`null` = 不知道，见下方 buildRootHealth
   * 的完整论证。前端渲染纪律：`null` 必须画成灰的（"未知"），**绝不许 `?? true` 兜底**
   * ——那正好把这个三态设计要防的那句假话原地复活。
   */
  ok: boolean | null
  /** 上一轮扫描对这个根的判决原文（人话，含 root 路径与实测数字）。健康/从没扫过时 null。
   *  ⚠️ `ok === null`（陈旧）时**这一条仍可能非 null**：它是那次陈旧扫描留下的原文，
   *  对排障有用，但它**不是当前结论**——当前结论只看 `ok`。 */
  lastError: string | null
  /** 上一轮扫描**处理完这个根**的时刻（毫秒）。从没扫过 → null（有意义的第三态，
   *  见 db.ts v41 那条迁移 entry 里"刻意可空且无 DEFAULT"的论证）。 */
  lastCheckedAt: number | null
}

/** GET /api/v2/health 的响应。 */
export interface HealthDTO {
  lastInspectAt: number | null
  engineEnabled: boolean
  roots: HealthRootDTO[]
  current: ScoutCurrent | null
}

/**
 * 把 media_roots 的两列折成 `ok` 三态。**不是 `last_error === null`**。
 *
 * ── 三种情况（这是本函数存在的全部理由）─────────────────────────────────────
 *
 *  ① `last_checked_at IS NULL` → **`ok: null`（未知）**，不是 true。
 *     语义：这个根从没被扫过（用户刚在 dashboard 里加完，下一轮巡检才会碰它）。
 *     报 true 就是在替一个从未被验证过的根打包票——而"刚加的根路径写错了/挂载没起来"
 *     恰恰是这个字段最该抓到的场景之一。db.ts v41 那条 entry 已经预言了这个坑：
 *     「折叠成 NOT NULL DEFAULT 0 会让『刚加的根』与『扫过且健康的根』不可区分，
 *     未来的读取方会把前者当成绿的」——本函数就是那个"未来的读取方"，它不上这个当。
 *
 *  ② `now - last_checked_at > ROOT_HEALTH_STALE_AFTER_MS` → **`ok: null`（未知）**。
 *     语义：判决陈旧。见 ROOT_HEALTH_STALE_AFTER_MS 的论证（写入点只覆盖本轮 scanRoots，
 *     落选的根两列会永久粘住）。**陈旧的红也一样归 null**，不是 false：一个两周前失败、
 *     此后再没被扫过的根，说它"现在是坏的"与说它"现在是好的"同样没有依据——
 *     两个方向都是拿中间量当结论量（病 B）。lastError 原文照给，让用户自己看那次发生了什么。
 *
 *  ③ 新鲜（`last_checked_at` 在容差内）→ `ok = (last_error === null)`。
 *     只有在这一支里，`last_error` 才是一句**关于现在**的话。
 *
 * ── 为什么 `ok` 是 `boolean | null` 而不是拆一个 `status: 'ok'|'error'|'unknown'` ──
 * 设计文档 §3.5 钉的字段名就是 `ok`，前端横幅的判据是"要不要亮红灯"。三态用 null 表达
 * 在 JSON 里是无歧义的（`false !== null`），而换字段名等于让 §3.5 与实现对不上，
 * 下一个人得再考古一遍。
 *
 * ── 时钟从参数进 ──
 * `now` 注入而不是就地 Date.now()：陈旧判定是本函数唯一的时间依赖，不注入就没法测
 * "刚好卡在容差边界"这条线（同本仓各处 `now: () => number` 的既有惯例）。
 */
export function buildRootHealth(
  rows: ReadonlyArray<{ path: string; last_error: string | null; last_checked_at: number | null }>,
  now: number,
): HealthRootDTO[] {
  return rows.map((r) => {
    const lastCheckedAt = r.last_checked_at
    // ① 从没扫过 / ② 判决陈旧 —— 两者都是"不知道"，不许折成 true 也不许折成 false。
    const ok: boolean | null =
      lastCheckedAt === null || now - lastCheckedAt > ROOT_HEALTH_STALE_AFTER_MS
        ? null
        : r.last_error === null
    return { path: r.path, ok, lastError: r.last_error, lastCheckedAt }
  })
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
  const { db, port, host, token, distDir, env = process.env, jobs, tmdb, requestIngest, subtitleWriteDeps, subtitleCompareDeps, cacheRoot, setupDeps: setupDepsOverride, events, eventsHeartbeatMs } = opts
  const settingsRepo = new SettingsRepo(db)
  // spec A §4.4：setup 面依赖——默认接真实实现（cfg 的 dbGet 惰性读库，wizard 落库后下一次
  // status/validate 调用自然反映），测试经 opts.setupDeps 部分覆盖（同 subDeps 先例）。
  const setupDeps: SetupDeps = {
    env,
    settingsRepo,
    cacheRoot: cacheRoot ?? (env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')),
    // SettingsRepo 上的方法名是 listRoots（不是 listMediaRoots）——见 src/v2/settingsRepo.ts:59。
    // 每次调用现取，守备目录增删后 status 立刻反映，不缓存。
    rootsCount: () => settingsRepo.listRoots().length,
    now: () => Date.now(),
    ...setupDepsOverride,
  }
  const auth = new AuthService(settingsRepo)
  // 字幕校验三端点的依赖：默认全部接真实模块，测试可通过 opts.subtitleWriteDeps 部分覆盖
  // （见 DashboardOpts.subtitleWriteDeps 注释——这是"为可测性而设"的注入口，不是降级开关）。
  const verifyRepo = new SubtitleVerifyRepo(db)
  const libRepo = new LibraryRepo(db)
  const subDeps: SubtitleWriteDeps = {
    repo: verifyRepo,
    lib: libRepo,
    shift: (p, off) => shiftSubtitleTiming(p, off),
    revert: (p) => revertSubtitleTiming(p),
    exists: (p) => existsSync(p),
    // 审计 C-A1：判"库里这行结论还说的是磁盘上这个文件吗"。同名 re-download 之后
    // 路径不变、巡检又永不重查已有记录，所以没有这一句两个写扳手都会拿一份作废的结论
    // 去动用户的文件（撤销尤其会用旧备份覆盖新字幕）。
    hashSubtitle: (p) => hashSubtitleContent(p),
    // 重新检测走 verifyAndRecord（而不是裸 verifySubtitleAlignment）：落库是这一步的**目的**，
    // 不是副作用——UI 只读 DB，不覆盖那行结论用户就会一直看到旧的红芯片。
    reverify: (itemId, videoPath, subtitlePath) =>
      verifyAndRecord(verifyRepo, itemId, videoPath, subtitlePath, Date.now()),
    now: () => Date.now(),
    ...subtitleWriteDeps,
  }
  // 字幕对照图的依赖：同上，默认全接真实模块。
  const compareDeps: SubtitleCompareDeps = {
    repo: verifyRepo,
    lib: libRepo,
    // 刻意走 readSubtitleText + parseCues 而**不是** loadSpans：后者会剥掉 text
    // （见 subtitleSpans.toSpans），而带文本给前端画在块上正是这个端点的全部意义。
    loadCues: async (p) => {
      const text = await readSubtitleText(p)
      if (text === null) return null
      return parseCues(text)
    },
    findReference: (videoPath, subtitlePath) => findReferenceSource(videoPath, subtitlePath),
    probeDuration: (videoPath) => probeDurationSec(videoPath),
    classify: (p) => classifyPath(p),
    canWaveform: (kind) => canRenderWaveform(kind),
    ...subtitleCompareDeps,
  }
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
      const tmdbClient = tmdb?.()
      if (detail && tmdbClient) void refreshSeriesCatalog(db, tmdbClient, id, Date.now()).catch(() => {})
      return detail
    },
    triage: () => buildTriage(db),
    runTrace: (id) => buildRunTrace(db, id),
    // Plan C：两个只读 GET。shifted 复用 subDeps 的 repo + exists（同一份 existsSync 实现，
    // 见上方 subDeps 的 wiring），backupSuffix 用与两个写扳手同一个常量——三处必须同源，
    // 否则 UI 上"可撤销"与后端"撤销会成功"会错位。
    shiftedSubtitles: () => buildShiftedDTOs(
      { repo: verifyRepo, exists: subDeps.exists },
      { backupSuffix: BACKUP_SUFFIX },
    ),
    dormantTasks: () => buildDormantTasks(db),
    setupStatus: () => buildSetupStatus(setupDeps),
    providers: () => buildProviders(setupDeps),
    movieDetail: (id) => buildLibraryMovieDetail(db, settingsRepo, id),
    // R-F2 / R-F5：媒体库页两个新端点。**纯同步只读**，无惰性 TMDB 刷新副作用 ——
    // 应有集（tmdb_seasons）的回填由 daemonV2 的 boot pass 负责（R-F5 已落地，生产 2144 行），
    // 不在读路径上再挂一次网络触发：librarySeriesDetail 那条的 fire-and-forget 是 G2 遗留，
    // 新端点不继承它（海报墙是全量列表，逐个作品踢 TMDB 会在一次页面加载里打爆配额）。
    mediaLibrary: () => buildMediaLibrary(db),
    mediaLibraryDetail: (workId) => buildMediaLibraryDetail(db, workId),
  }

  // v3 phase ⑦ review fix: reconcile-all runs a full mechanical scan + orchestrator LLM pass —
  // expensive, and with no guard, repeated POSTs (e.g. an impatient user double-clicking, or a
  // hostile actor when DASHBOARD_TOKEN is unset) each launch a fresh overlapping pass, multiplying
  // scan/LLM cost with every extra request (a cheap DoS lever). A single boolean flag scoped to
  // this server instance is enough — startDashboard runs once per daemon process, so this is
  // effectively the "module-level flag" the review asked for, just closure-scoped instead of
  // truly global (avoids leaking state across independent startDashboard calls in tests).
  // reconcileInFlight 已删（第 5.5 步，orchestrator 及其依赖的旧架构全删）

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
      // POST /api/v2/reconcile-all 已删（第 5.5 步，orchestrator 及其依赖的旧架构全删）

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

      // spec A §4.4：PUT /api/v2/settings/secrets——wizard/Providers 区的密钥写入通道。
      // 白名单/空值删除/审计日志（只记 name）/版本自增全部收在 setupApi.putSecret 内。
      if (rawPath === '/api/v2/settings/secrets') {
        if (req.method !== 'PUT') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
        // putSecret 是同步函数（不用 await），签名 (deps, body, log) → { status, body }：
        // log 是第三个形参，不是 deps 的字段。审计日志只记 name/action，永不记 value。
        const out = putSecret(setupDeps, body, (msg) => console.error(`[setup] ${msg}`))
        res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(out.body))
        return
      }

      // spec A §4.4：POST /api/v2/setup/validate——先测后存。未知 target → 400；
      // 测试真的跑了（含失败/未配置）→ 200，结果分类在 body。
      if (rawPath === '/api/v2/setup/validate') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
        const outcome = await validateSetupTarget(setupDeps, body)
        res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(outcome.body))
        return
      }

      // zimuku vision 能力测试：POST /api/v2/test-vision——Settings → Providers 区的
      // ZimukuVisionCard 测试按钮调用。发送测试图片给模型，验证其是否具备视觉能力（能识别图片中数字）。
      // 成功 → 200 { success: true, digits: string }；失败 → 200 { success: false, error: string }。
      if (rawPath === '/api/v2/test-vision') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
        const { testVision } = await import('./testVision.js')
        const outcome = await testVision(body)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(outcome))
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
        // R6：添加根成功后自动触发一次扫描（研究结论：Sonarr/Radarr 模式，无需等下一轮轮询）
        if (result.ok && requestIngest) requestIngest()
        return
      }

      // POST /api/v2/library/scan：手动触发扫描端点（用户添加目录后前端防抖触发，或
      // Settings 页"立即扫描"按钮直接调）。同 requestIngest 可选依赖先例（watch 未接线
      // 或纯只读测试 → 503），method 门在前。研究结论（DIRBROWSER_RESEARCH.md）：
      // Plex/Sonarr/Radarr 成熟方案是 webhook 触发部分扫描，我们的 ingest 是全库扫但有
      // 增量逻辑，防抖 2 秒累积多次请求避免"猴子动作"（快速增删目录）重复触发。
      if (rawPath === '/api/v2/library/scan') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        if (!requestIngest) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'scan trigger not configured (watch daemon not running)' }))
          return
        }
        requestIngest()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
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

      // ── R-F3：GET /api/v2/notifications —— 通知页的**唯一**列表数据源 ──────────
      //
      // 本仓第 7 次同型缺陷的收口：notifications 表（db.ts v39）、生产数据、读函数
      // （notificationsRepo.listRecentFoundGrouped）三样俱全，**就是没有 HTTP 端点**，
      // 前端拿不到。这里只补那条缺失的接线，不重写任何查询逻辑。
      //
      // 三个业务约束全部**长在 listRecentFoundGrouped 里**，这一层一个都不重新实现：
      //   · 保留一周 → 读窗（NOTIFICATION_RETENTION_MS，与 pruneFound 共用同一常量）
      //   · 倒序     → SQL 的 `ORDER BY found_at DESC, id DESC` + Map 插入序
      //   · 不做已读 → 没有任何写路径（本端点 GET only，无 PATCH/POST 兄弟）
      // 返回的是**按 work+season 聚合的 FoundGroup[]**（不是逐集行）：R-F3 的展示形态是
      // 「XX 剧找到了 S01 的第 3/5/7 集」一条，不是三条。想要逐集行的话 listRecentFound
      // 也在同一个模块里——刻意不暴露它：两个口径同时开着，前端迟早会挑错那个。
      //
      // 为什么是 server.ts 的独立分支而不是 router.ts 的 RouterDeps 条目（它确实是纯同步
      // 只读，够格进那张纯函数路由表）：同 GET /api/v2/subtitle/verify 的既有先例——那条
      // 也是纯读却留在这里。`now` 是这个端点唯一的外部输入，放在这里它与隔壁 events/
      // workflowPending 的 `Date.now()` 取值口径显式同源，不必再穿一层闭包。
      //
      // 与隔壁 SSE `found` 事件的分工（notificationsRepo 头注释已论证，此处只记结论）：
      // SSE 只是「有新内容」的提示，**列表永远只由本端点出**。SSE 每次装盘都发，而
      // recordFound 是幂等刷新（ON CONFLICT DO UPDATE），两边条目数天然不等——只要前端
      // 敢拿 SSE 事件往列表里插，那个差值就会摆在用户眼前。
      //
      // 读失败不在这一层兜：listRecentFound 内部已经 try/catch 返回空数组（通知页挂掉
      // 不许把整个 dashboard 带走），这里再包一层 try 只会把真实异常吞得更深。
      // 鉴权已由上方统一前置门完成（cookie / x-api-key / legacy token 三通道）。
      if (rawPath === '/api/v2/notifications') {
        if (req.method !== 'GET') {
          res.writeHead(405, JSON_CT)
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        res.writeHead(200, JSON_CT)
        res.end(JSON.stringify(listRecentFoundGrouped(db, Date.now())))
        return
      }

      // ── Task ⑤：GET /api/v2/health —— 健康横幅与活动页状态条的**基线快照** ──────
      //
      // 存在理由（设计文档 §3.5 / 审计 F-5）：SSE 的 `health` 事件**只发不撤**——daemonV2
      // 里没有任何"恢复"事件的发射点，横幅一旦亮起在当前实现下永远不灭。前端在首次加载与
      // SSE 重连后各拉一次这个端点，作为横幅的真实基线：SSE 只负责"立刻亮起"，**灭灯靠这里**。
      // §3.6 追加 `current`（同理：activity 是变化不是快照，断线期间巡检跑完、缓冲又被
      // progress 冲掉的话，前端会永远停在"正在处理 X"）。
      //
      // ⚠️⚠️ **刻意不返回 `queue` 字段**（IMPL-PLAN 审计 🔴-1 的裁决，落地在此）。
      // 设计文档自相矛盾：§3.6 说 health 要返回 `current` **和 `queue`**，而 §3.5:578 说
      // 「queue 砍掉，活动页的 total 只信 SSE」、:568 对 `listSubtitleQueue` 明令「**不许用它**」
      // ——它返回的是"现在重查会捞到什么"，而 R4 的设计是**冻结快照**（daemonV2.ts:660 有
      // 大段论证）。用它会让活动页 total 与 SSE 的 total 对不上，且越跑越飘。
      // **裁决：依 §3.5 砍掉 queue。** R-F4「排队」那半边后端确实无数据源——`subtitleQueue`
      // 是 `runInspection` 的局部变量，出不来。这条注释就是那个裁决的落点：
      // 下一个人读 §3.6 会以为端点残缺，或照它把 listSubtitleQueue 接上去，正好踩中 :568。
      //
      // ── 四个字段的数据源（谁写 / 谁读 / 谁触发，本仓已栽 11 次「加了能力没定接线」）──
      //  · lastInspectAt —— meta 表 `last_inspect_at`。写：daemonV2.writeLastInspectAt
      //    （**只在整轮巡检成功后**写，D4 ②）。全新部署为 null（前端必须保留冷启动分支，
      //    不许显示成 1970-01-01）；生产已有值（2026-08-11 那轮巡检写入）。
      //    键名与 apiV2.buildWorkflowPending 的 lastScanAt 同源——两处读同一个键，
      //    刻意不抽公共函数：那边是"顶栏新鲜度行"的一个字段，这边是健康基线，
      //    合并会让两个页面的降级策略互相绑架（那边 null 显示"还没扫过"，这边 null 要触发
      //    冷启动分支）。**只读不写**，本端点零写路径。
      //  · engineEnabled —— settings 表 `engine_enabled`，fail-open（只有精确 'false' 才算关，
      //    脏值/缺省一律开，spec §4.6）。判据与 watchClients.engineEnabled（daemon 的
      //    workPermitted）、setupApi.buildSetupStatus 同源。这里复用 watchClients 那份实现
      //    而不是第三次手写 `!== 'false'`：三处各写一份，用户眼里"引擎开着"这一件事会在
      //    健康横幅、setup 页、daemon 派活三条路上给出可能不同的答案（D7/C30 的既有形态）。
      //  · roots —— media_roots 的 path/last_error/last_checked_at（Task ③ / db.ts v41 加的两列）。
      //    写：daemonV2.scanOnce 的 finally 单点收敛。**本端点是这两列的第一个读取方**
      //    （db.ts v41 那条 entry 写着"目前没有读取方……Task ⑤ 的 /api/v2/health 将据它判
      //    roots.ok，那个端点今天还不存在"——就是这里）。ok 的三态折叠见 buildRootHealth。
      //  · current —— ScoutEventBus.getCurrent()（Task ④ 挂的内存快照）。写：publish
      //    （= daemonV2 已有的 13 个 emit 点）。**本端点是 getCurrent() 的唯一生产读取点**，
      //    故那条接线由 healthWiring.test.ts 的源码级断言守卫（照 watchWiring.test.ts 的形态）。
      //
      // ── events 缺席（不跑 watch 时）为什么**不整体 503** ─────────────────────
      // 隔壁 /api/v2/events 缺席即 503，那是对的：它整个端点就是那条流，没有总线就没有
      // 任何东西可给。**本端点不同**：四个字段里有三个（lastInspectAt / engineEnabled /
      // roots）与总线毫无关系，它们全部长在库上。整体 503 会让"守备目录健康度"这个纯 DB
      // 事实在没跑 watch 时也查不到——而那恰恰是最需要它的时候（用户开着 dashboard 排查
      // "为什么什么都没发生"，得到的却是一个 503）。
      // 故：**events 缺席 → `current: null`，其余三个字段照给**。
      // 这不会制造歧义：`current: null` 的语义本来就是"没有任何工作台在跑"（见 ScoutCurrent
      // 头注释），而 watch 没跑时确实没有任何工作台在跑——两条路径给出的是**同一句真话**，
      // 不是拿 null 掩盖缺席。
      //
      // 读失败不在这一层兜（同隔壁 notifications 的既有口径）：三条查询都是本进程刚开的库，
      // 真抛错说明库坏了，包一层 try 只会把它吞得更深；最外层那个 catch 会转 500。
      // 鉴权已由上方统一前置门完成（cookie / x-api-key / legacy token 三通道）。
      if (rawPath === '/api/v2/health') {
        if (req.method !== 'GET') {
          res.writeHead(405, JSON_CT)
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const inspectRow = db
          .prepare(`SELECT value FROM meta WHERE key = 'last_inspect_at'`)
          .get() as { value: string } | undefined
        // 脏值（非数字）按"没有"处理，**不报一个 NaN 出去**：NaN 经 JSON.stringify 变
        // null，与"从没巡检过"撞车但过程不可见；显式判一次让两者走同一条诚实的 null。
        const lastInspectNum = inspectRow ? Number(inspectRow.value) : NaN
        const rootRows = db
          .prepare('SELECT path, last_error, last_checked_at FROM media_roots ORDER BY path')
          .all() as Array<{ path: string; last_error: string | null; last_checked_at: number | null }>
        const body: HealthDTO = {
          lastInspectAt: Number.isFinite(lastInspectNum) ? lastInspectNum : null,
          engineEnabled: engineEnabled((k) => settingsRepo.get(k)),
          roots: buildRootHealth(rootRows, Date.now()),
          // events 缺席 → null（见上方论证：不整体 503）。
          current: events ? events.getCurrent() : null,
        }
        res.writeHead(200, JSON_CT)
        res.end(JSON.stringify(body))
        return
      }

      // ── R-F10：GET /api/v2/events —— 全站唯一那条 SSE 通道 ─────────────────────
      //
      // 为什么只有**一个**端点、四类事件全走同一条流（用户裁决 R-F10 约束 3）：HTTP/1.1
      // 每源只有 6 个连接上限，三个页面（活动/通知/媒体库）各开一条会吃掉一半，剩下的要
      // 分给全站的图片与 API 请求。类型区分靠 SSE 的 `event:` 字段，前端在 shell 层分发。
      //
      // 鉴权已由上方统一前置门完成（与其余 22 个 /api/v2/* 端点同一道门，三通道齐全）。
      // ⚠️ 浏览器原生 EventSource **不能带自定义请求头**，所以 apiKey 必须走 `?apikey=`
      // query 通道——那条通道在前置门里已经存在（`url.searchParams.get('apikey')`），
      // 这里不新开任何旁路。
      //
      // 与隔壁 trace-stream（痕迹通道 C）的分工：那条是给排障看的 agent 工具调用流水，
      // 事无巨细；这条只推"对用户有必要"的 4 类（R-F10）。两条通道刻意不合并——合并就等于
      // 把"我跑了多少次 ffprobe"重新推到用户脸上，而那正是本裁决要消灭的东西。
      if (rawPath === '/api/v2/events') {
        if (req.method !== 'GET') {
          res.writeHead(405, JSON_CT)
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        if (!events) {
          // 缺席 → 可诊断的 503（见 DashboardOpts.events 的论证：绝不做成静默的 200 空流）。
          res.writeHead(503, JSON_CT)
          res.end(JSON.stringify({ error: 'event stream not configured (bus missing)' }))
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          // 反代（nginx）默认会缓冲上游响应，SSE 于是卡住直到缓冲满——这个头让它关掉。
          'x-accel-buffering': 'no',
        })
        // 显式冲刷响应头：Node 默认等到第一次 write() 才冲，而 SSE 客户端要在第一条数据/
        // 心跳到达之前就看到连接已建立（论证与实测复现见隔壁 trace-stream 分支）。
        res.flushHeaders()
        // socket 猝死（客户端断网/杀进程）到 'close' 事件触发之间有窗口——窗口内的写入打在
        // 已毁的流上，ServerResponse 无 'error' 监听器时是 uncaughtException，**整个守护
        // 进程（产品本体）直接崩**。两道防线照抄 trace-stream 的既有形态：no-op 'error'
        // 兜底 + 每次写入前的 destroyed/writableEnded 守卫。
        res.on('error', () => {})

        const write = (chunk: string): void => {
          if (res.destroyed || res.writableEnded) return
          try { res.write(chunk) } catch { /* 在途 EPIPE：见上方两道防线的论证 */ }
        }
        const frame = (e: { id: number; type: string }): string =>
          // `id:` 必须发——浏览器 EventSource 靠它维护 Last-Event-ID，断线重连时自动带回来。
          `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`

        // 断线续传：浏览器 EventSource 重连时自动带 `Last-Event-ID` 头（手机锁屏再打开必然
        // 走这条路）。不补发的话活动页在重连后会短暂空白，且断线期间"找到了字幕"这类
        // 通知页数据源会**永久丢失**（前端没有别的地方能补到它）。
        // 非法/缺席的头按 0 处理（= 补发缓冲里全部，最多 50 条，不会失控）。
        const lastIdRaw = req.headers['last-event-id']
        const lastId = Number(Array.isArray(lastIdRaw) ? lastIdRaw[0] : lastIdRaw)
        for (const e of events.replay(Number.isFinite(lastId) && lastId > 0 ? lastId : 0)) {
          write(frame(e))
        }

        const unsubscribe = events.subscribe((e) => { write(frame(e)) })
        // 保活只发 SSE **注释帧**（`: ping`），不发数据帧（R-F10 约束 1：只推变化不推心跳）。
        // 日巡检模型下大部分时间确实没有变化——发心跳数据帧会让前端每 15 秒收到一条"什么
        // 也没发生"，活动页得自己把它过滤掉，而注释帧连 EventSource 的 message 事件都不触发。
        const heartbeat = setInterval(() => { write(': ping\n\n') }, eventsHeartbeatMs ?? EVENTS_HEARTBEAT_MS)
        req.on('close', () => {
          clearInterval(heartbeat)
          // 必须退订：不退就是长跑 daemon 上的真实内存泄漏——每次浏览器重连留一个死回调，
          // 而回调闭包里还攥着整个 ServerResponse。守卫在 eventStream.test.ts 的
          // subscriberCount 断言（只测"退订后收不到"证明不了内部集合已经放手）。
          unsubscribe()
        })
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
        const tmdbClient = tmdb?.()
        if (!tmdbClient) {
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
          const hits = await tmdbClient.search(mediaType, q)
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

      // ---- 字幕时间轴校验三端点（spec §3.4）----
      // GET verify 是**纯读**（只查 repo，不碰文件系统、不触发检测），本可以塞进下方同步的
      // handleApiRoute；但它与两个 POST 扳手是同一族语义、共用同一份 DTO 映射与参数解析，
      // 拆在两处会让"三值→两色"的映射离它的两个兄弟很远。放在一起，且刻意保持纯读。
      //
      // 铁律②的执行点在 subtitleVerifyApi.toVerifyDTO：响应体只含 itemId/state/checked，
      // offsetMs/score/referenceTier/detail 一律不出这一层。别在这里 `{...row}`。
      if (rawPath === '/api/v2/subtitle/verify') {
        if (req.method !== 'GET') {
          res.writeHead(405, JSON_CT)
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const result = buildVerifyDTOs(subDeps.repo, parseItemIds({
          itemId: url.searchParams.get('itemId') ?? undefined,
          itemIds: url.searchParams.get('itemIds') ?? undefined,
        }))
        res.writeHead(result.ok ? 200 : 400, JSON_CT)
        res.end(JSON.stringify(result.ok ? result.dto : { error: result.error }))
        return
      }

      // POST correct / revert：**唯二的写扳手**（铁律④⑤ + web/DESIGN.md §8——写操作必须是
      // 显式 POST）。异步（真的跑 ffmpeg + 改写用户文件）故走这里而非同步的 handleApiRoute，
      // 形状照 /api/v2/workflow/redispatch 先例：method 门 → body 解析 → 判断层 → 写响应。
      // 无依赖缺席门：subDeps 恒有默认实现（见上方 wiring），不存在"未配置"这一态。
      if (rawPath === '/api/v2/subtitle/correct' || rawPath === '/api/v2/subtitle/revert') {
        if (req.method !== 'POST') {
          res.writeHead(405, JSON_CT)
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const body = await readJsonBodyOrFail(req, res)
        if (body === BODY_FAILED) return
        const itemId = parseItemIdBody(body)
        if (itemId === null) {
          res.writeHead(400, JSON_CT)
          res.end(JSON.stringify({ ok: false, error: 'itemId is required' }))
          return
        }
        const run = rawPath === '/api/v2/subtitle/correct' ? correctSubtitle : revertSubtitle
        const result = await run(subDeps, itemId, { backupSuffix: BACKUP_SUFFIX })
        res.writeHead(result.ok ? 200 : result.status, JSON_CT)
        // 成功体零数字（铁律②）：只有 ok + state。失败体是 ok:false + 人话 error
        // （不是 shiftTiming 的内部 detail——那里带路径与毫秒数）。
        res.end(JSON.stringify(
          result.ok ? { ok: true, state: result.state } : { ok: false, error: result.error },
        ))
        return
      }

      // GET /api/v2/subtitle/compare——字幕对照图的数据供给。**异步**（读字幕文件、可能
      // spawn ffmpeg 抽内嵌轨、spawn ffprobe 探时长）故走这里而非下方同步的 handleApiRoute，
      // 形状照上面 correct/revert 的先例：method 门 → 参数门 → 判断层 → 写响应。鉴权在统一前置门。
      //
      // 铁律②的执行点在 subtitleCompareApi.buildCompareDTO：响应体只含
      // itemId/reference/ours/durationMs/waveformAvailable/mountKind。时间戳是**定位坐标**
      // （画图必需、用户可自行按播放键验证）而 offsetMs/score 是**质量评分**（禁止）——
      // 这个区别在那边的文件头有完整论证。别在这里 `{...row}`。
      if (rawPath === '/api/v2/subtitle/compare') {
        if (req.method !== 'GET') {
          res.writeHead(405, JSON_CT)
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        // 单条 itemId，刻意不做 verify 那种批量：一张对照图对应一集，批量拉整季的台词文本
        // 是几 MB 的响应，而前端一次只画一张图。
        const itemId = (url.searchParams.get('itemId') ?? '').trim()
        if (itemId === '') {
          res.writeHead(400, JSON_CT)
          res.end(JSON.stringify({ error: 'itemId query param is required' }))
          return
        }
        const result = await buildCompareDTO(compareDeps, itemId)
        res.writeHead(result.ok ? 200 : result.status, JSON_CT)
        res.end(JSON.stringify(result.ok ? result.dto : { error: result.error }))
        return
      }

      // GET /api/v2/subtitle/waveform-peaks——对照图第三轨（音频波形）的实际数据。
      // 拆开的理由见 subtitleCompareApi.ts 文件尾注释：峰值数组大（23.7 分钟 → 284KB），
      // 跟元数据混在一起会让画图请求的体积随视频长度线性膨胀、且无法单独缓存/单独失败。
      // **异步**（spawn ffmpeg 抽音频，局域网实测 8 秒）故走这里。形状同 compare。
      if (rawPath === '/api/v2/subtitle/waveform-peaks') {
        if (req.method !== 'GET') {
          res.writeHead(405, JSON_CT)
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        const itemId = (url.searchParams.get('itemId') ?? '').trim()
        if (itemId === '') {
          res.writeHead(400, JSON_CT)
          res.end(JSON.stringify({ error: 'itemId query param is required' }))
          return
        }
        // 查找 item（episodes / movies 两表共用 item_id 空间）
        const item = libRepo.getEpisode(itemId) ?? libRepo.getMovie(itemId)
        if (item === null) {
          res.writeHead(404, JSON_CT)
          res.end(JSON.stringify({ error: 'item not found' }))
          return
        }
        // extractWaveformPeaks 的依赖注入：spawn 用 promisify(execFile) + encoding: 'buffer'
        const execFileAsync = promisify(execFile)
        const peaksDeps: ExtractPeaksDeps = {
          spawn: async (args) => {
            try {
              const { stdout } = await execFileAsync('ffmpeg', [...args], {
                timeout: 60_000,
                maxBuffer: 50 * 1024 * 1024,
                encoding: 'buffer',
              })
              return stdout as Buffer
            } catch {
              return null
            }
          },
          classifyPath,
          resolveDurationMs: async (videoPath) => resolveDurationMs(
            { probeDuration: probeDurationSec },
            videoPath,
            [],
          ),
        }
        try {
          const result = await extractWaveformPeaks(peaksDeps, itemId, item.path)
          res.writeHead(200, JSON_CT)
          res.end(JSON.stringify(result))
        } catch (err) {
          // cloud 路径 → 'waveform is not available for cloud-mounted media'
          if (err instanceof Error && err.message.includes('not available for cloud')) {
            res.writeHead(403, JSON_CT)
            res.end(JSON.stringify({ error: err.message }))
            return
          }
          // ffmpeg 失败或其他错误 → 502
          res.writeHead(502, JSON_CT)
          res.end(JSON.stringify({ error: 'failed to extract waveform' }))
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
    // host 缺省时**不传**（而不是传 '0.0.0.0'）：保持生产既有的 `::` 通配语义原样不动，
    // 只让显式传 host 的调用方（测试）落到单一地址族。见 DashboardOpts.host 的长注释。
    if (host) server.listen(port, host, () => resolve(server))
    else server.listen(port, () => resolve(server))
  })
}
