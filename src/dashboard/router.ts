// src/dashboard/router.ts
import type {
  RunHistoryDTO, SettingsDTO, DeploySettingsDTO, FsListResult,
  WorkflowPendingDTO, WorkflowPassDTO, RunTraceDTO,
  DormantTaskDTO,
} from './apiV2.js'
import type { MediaLibraryItemDTO, MediaLibraryDetailDTO } from './mediaLibraryApi.js'
import type { ActivityDTO } from './activityApi.js'
import type { MediaRoot } from '../v2/settingsRepo.js'
import { toHostPath } from '../files/hostrootPath.js'
import type { SetupStatusDTO, ProvidersDTO } from './setupApi.js'
import type { ShiftedItemDTO } from './subtitleVerifyApi.js'

export interface RouterDeps {
  runs: (offset: number, limit: number) => RunHistoryDTO[]
  // `parked` / `triage` 两个 dep 已删除（2026-08-13，parked_paths 族整体退役——
  // 唯一写入者 v2/ingest.ts 已删，表从此零写入者；完整裁决见 web/src/triage/TriagePage.tsx
  // 头注释的 parked 族段落）。对应端点 GET /api/parked、GET /api/v2/triage 一并删除。
  /** dashboard G4：settings 表白名单五键（GET /api/v2/settings，展示层——写入走 server.ts 的
   *  PUT 分支，纯函数路由这里只读）。 */
  settings: () => SettingsDTO
  /** dashboard G4：部署层 env 脱敏只读展示（GET /api/v2/settings/deploy）。 */
  deploySettings: () => DeploySettingsDTO
  /** dashboard G4：守备目录清单（GET /api/v2/settings/roots；增删走 server.ts 的 POST/DELETE 分支）。 */
  roots: () => MediaRoot[]
  /** dashboard G4：加根 UI 的目录选择器（GET /api/v2/fs/list?path=...）——纯函数路由本身不摸
   *  文件系统，实际的 existsSync/readdir 判定关在这个注入闭包里（同 library/series 那样，真实
   *  I/O 由 server.ts 的 wiring 提供，这里只决定 status code）。 */
  fsList: (path: string) => FsListResult
  /** dashboard G5：GET /api/v2/workflow/pending——缺口事实 + parked 计数 + 顶栏新鲜度行。 */
  workflowPending: () => WorkflowPendingDTO
  /** dashboard G5：GET /api/v2/workflow/passes?limit=20——orchestrate 通行记录 + receipts；
   *  limit 已在本文件里 clamp 到 [1,100] 后再传入。 */
  workflowPasses: (limit: number) => WorkflowPassDTO[]
  /** dashboard-F4：GET /api/v2/workflow/runs/:id/trace——单 run 痕迹快照回放。
   *  （曾经这里写着"区别于 workflowWorkers 的 traceBus.peek 直播补拉"——那条端点已于
   *   2026-08-13 删除，见 apiV2.ts 的墓碑注释；本端点只读收官后落库的完整快照。）
   *  id 已在本文件里做纯数字校验+转 number 后再传入。 */
  runTrace: (id: number) => RunTraceDTO | null
  /** Plan C（spec §4.1）：GET /api/v2/subtitle/shifted——Triage 第三区 + Library 详情偏移行。
   *  纯读。备份文件存在性探测（hasPriorCorrection）关在 server.ts 的注入闭包里，这一层
   *  和 fsList 一样不碰文件系统。 */
  shiftedSubtitles: () => ShiftedItemDTO[]
  /** Plan C（spec §4.2）：GET /api/v2/workflow/dormant——Triage 第四区。纯读，零按钮语义
   *  （唤醒通道本 spec 明确不补，见 spec §3 决策 1）。 */
  dormantTasks: () => DormantTaskDTO[]
  /** spec A §4.4：GET /api/v2/setup/status——bootstrap 完成度推导（wizard 入口判定）。 */
  setupStatus: () => SetupStatusDTO
  /** spec A §4.4/§5.4：GET /api/v2/setup/providers——Providers 区行数据（打码值/source/上次测试点）。 */
  providers: () => ProvidersDTO
  /** R-F2/R-F5：GET /api/v2/mediaLibrary——新前端媒体库页的海报墙列表（长在 files/works/
   *  tmdb_seasons 上）。旧的 `/api/v2/library` 一族（长在 series/episodes/movies，生产 0 行）
   *  已于 2026-08-12 删除，本端点现在是媒体库列表的**唯一**数据源。 */
  mediaLibrary: () => MediaLibraryItemDTO[]
  /** R-F2/R-F5：GET /api/v2/mediaLibrary/:workId——季集网格详情。id 空间是 works.id
   *  （'tmdb:<n>'），与 librarySeriesDetail 那条同形，故复用同一套 isSafeId/decodeIdSegment。 */
  mediaLibraryDetail: (workId: string) => MediaLibraryDetailDTO | null
  /** R-F13：GET /api/v2/activity——活动页排队段的作品身份与两张图（横版 backdrop + 竖版
   *  poster）。**不产出 total/index/当前在跑的是谁**——那三样只信 SSE 与 /health 的 current
   *  （冻结快照）。完整论证见 activityApi.ts 头注释。 */
  activity: () => ActivityDTO
}
export interface ApiResult { status: number; json: unknown }

// 允许字符集；额外禁止 '..' 片段。':' 必须在集内——自有 id 空间是 'tmdb:<n>' 形状
// （src/v2/ownIds.ts，冒号是身份的一部分不是装饰），且 ':' 在 RFC 3986 路径段里本就是合法
// 未编码字符（new URL().pathname 原样保留）；漏掉它曾让两个 series 详情端点对一切真实 id 400。
const SAFE_ID = /^[A-Za-z0-9._:-]+$/
const isSafeId = (id: string) => SAFE_ID.test(id) && !id.includes('..')

/** id 段解码：有些客户端会把 ':' 编码成 %3A——先 decodeURIComponent 再过 isSafeId。畸形
 *  百分号编码（如 '%zz'）让 decodeURIComponent 抛 URIError，收敛成 null（调用方按 bad id 400），
 *  不许炸到 server.ts 变 500。 */
function decodeIdSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

// v1 端点已随 ledger/queue 一并废弃——命中返回 410，别硬撑。
const V1_GONE = { status: 410, json: { error: 'gone', detail: 'v1 endpoint retired; use /api/v2/*' } } as const

/** 纯 API 路由。鉴权不上到这层——A1 起唯一的门是 server.ts 的统一前置门（cookie/api key/
 *  legacy token 三通道）；这里只做 method/shape/存在性判定。id 非法 400,未命中 404。 */
export function handleApiRoute(
  req: { pathname: string; query: Record<string, string> },
  deps: RouterDeps,
): ApiResult {
  const { pathname } = req

  // ---- v1 retired ----
  if (pathname === '/api/summary' || pathname === '/api/queue') return V1_GONE
  if (pathname === '/api/runs' || /^\/api\/runs\/[^/]+$/.test(pathname)) return V1_GONE

  // ---- v2 ----
  // 2026-08-12（无活 UI 端点裁决）：`/api/v2/library`、`/api/v2/series/:id`、
  // `/api/v2/library/series/:id`、`/api/v2/library/movies/:id` 四条已删除——它们长在
  // series/episodes/movies 三张**生产 0 行**的旧表上（mediaLibraryApi.ts 头注释的实测），
  // 且消费方在 Task ⑪ 后只剩 `_legacy/`（`/api/v2/series/:id` 更是连 _legacy 都没有）。
  // 媒体库的活路由是下面的 `/api/v2/mediaLibrary` 与 `/api/v2/mediaLibrary/:workId`。
  if (pathname === '/api/v2/runs') {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    return { status: 200, json: deps.runs(offset, limit) }
  }

  // ---- parked (去 Jellyfin 化 P6：最小 park 救援) ----
  // GET /api/parked 已删除（2026-08-13）——见上方 RouterDeps 里 parked/triage 两个 dep
  // 被删掉那一段的说明。落到下面的 404，与其它未知路径同一形状。

  // ---- settings / deploy / roots / fs (dashboard G4：两层设置 + 守备目录 UI 化) ----
  // 四个都是纯同步 GET，走这个纯函数路由表；写入端点（PUT settings、POST/DELETE roots）需要
  // body 解析/zod 校验，同 parked/claim 一样落在 server.ts 的独立 rawPath 分支。
  if (pathname === '/api/v2/settings') return { status: 200, json: deps.settings() }
  if (pathname === '/api/v2/settings/deploy') return { status: 200, json: deps.deploySettings() }
  if (pathname === '/api/v2/settings/roots') {
    return { status: 200, json: deps.roots().map((r) => ({ ...r, path: toHostPath(r.path) })) }
  }

  if (pathname === '/api/v2/fs/list') {
    const path = req.query.path
    if (!path) return { status: 400, json: { error: 'path query param is required' } }
    const result = deps.fsList(path)
    return result.ok ? { status: 200, json: { dirs: result.dirs } } : { status: 400, json: { error: result.error } }
  }

  // ---- workflow/library/甄别聚合 API（dashboard G5）----
  // 五个都是纯同步 GET，走这个纯函数路由表；两个写入端点（POST /api/v2/triage/claim、
  // POST /api/v2/workflow/redispatch）需要 body 解析/zod 校验，同 parked/claim 一样落在
  // server.ts 的独立 rawPath 分支。
  if (pathname === '/api/v2/workflow/pending') return { status: 200, json: deps.workflowPending() }

  // ---- Plan C 两个只读 GET（spec §4）：零写路径、零状态机改动 ----
  // 🟡 `/api/v2/subtitle/shifted` 属于字幕校验那一族（今天无活 UI：它的消费链末端
  //    TriagePage 未被任何地方渲染）。2026-08-12 裁决**保留**，理由与删除判据见
  //    `src/v2/subtitleVerifyRepo.ts` 头注释。它今天恒返回 `[]`（表永远为空）。
  if (pathname === '/api/v2/subtitle/shifted') return { status: 200, json: deps.shiftedSubtitles() }
  if (pathname === '/api/v2/workflow/dormant') return { status: 200, json: deps.dormantTasks() }

  if (pathname === '/api/v2/workflow/passes') {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
    return { status: 200, json: deps.workflowPasses(limit) }
  }

  // GET /api/v2/workflow/workers 已于 2026-08-13 删除（无活 UI + 显示位已有活的后继，
  // 论证见 apiV2.ts 的墓碑注释）。这里不留兜底分支：未知路径统一落本函数末尾的 404。

  // dashboard-F4：GET /api/v2/workflow/runs/:id/trace——纯数字 id 校验（runs.id 是
  // INTEGER PRIMARY KEY AUTOINCREMENT，跟 series/library 那两条路由的 tmdb:<n> 形状 id 不是
  // 同一个 id 空间，不能复用 isSafeId/SAFE_ID 那一套）。非数字 400；数字但行不存在 404。
  const trm = pathname.match(/^\/api\/v2\/workflow\/runs\/(\d+)\/trace$/)
  if (trm) {
    const trace = deps.runTrace(Number(trm[1]))
    return trace ? { status: 200, json: trace } : { status: 404, json: { error: 'not found' } }
  }

  // GET /api/v2/triage 已删除（2026-08-13，同 /api/parked——它的 body 就是 { pending:
  // buildParked(db) }，同一族同一批走）。

  // ---- R-F2 / R-F5：媒体库页两个新端点（长在 files/works/tmdb_seasons 上）----
  // 刻意命名 mediaLibrary 而非复用 library：旧的 `/api/v2/library` 及其 4 个 builder 长在
  // series/episodes/movies 上（生产 series 0 行），已于 2026-08-12 随"无活 UI 端点"裁决删除。
  // 精确路径必须在带 id 的正则**之前**判——否则 `/api/v2/mediaLibrary` 本身会被
  // `([^/]+)` 之外的分支漏掉（这里顺序天然正确，写明是防后人重排）。
  if (pathname === '/api/v2/mediaLibrary') return { status: 200, json: deps.mediaLibrary() }

  const mlm = pathname.match(/^\/api\/v2\/mediaLibrary\/([^/]+)$/)
  if (mlm) {
    const id = decodeIdSegment(mlm[1])
    if (id === null || !isSafeId(id)) return { status: 400, json: { error: 'bad id' } }
    const detail = deps.mediaLibraryDetail(id)
    return detail ? { status: 200, json: detail } : { status: 404, json: { error: 'not found' } }
  }

  // ---- R-F13：活动页排队段的身份与图（Task ⑨）----
  // 只读、无参数。**刻意不与 /api/v2/health 合并**：health 是"当前态快照"（含 current），
  // 本端点是"还有谁在等"，两者的刷新时机完全不同（health 在重连时拉一次，本端点随
  // activity 事件拉）。且 health 有一条明令「不返回 queue」的裁决（见 activityApi.ts 头注释
  // 对 :578 的完整论证）——把队列塞回 health 会正面违反它。
  if (pathname === '/api/v2/activity') return { status: 200, json: deps.activity() }

  // ---- setup（spec A：bootstrap wizard 与 Providers 区）----
  if (pathname === '/api/v2/setup/status') return { status: 200, json: deps.setupStatus() }
  if (pathname === '/api/v2/setup/providers') return { status: 200, json: deps.providers() }

  return { status: 404, json: { error: 'not found' } }
}
