// src/dashboard/router.ts
import type {
  LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ParkedItemDTO, SettingsDTO, DeploySettingsDTO, FsListResult,
  WorkflowPendingDTO, WorkflowPassDTO, WorkflowWorkersDTO, LibrarySeriesDetailDTO, TriageDTO, RunTraceDTO,
} from './apiV2.js'
import type { MediaRoot } from '../v2/settingsRepo.js'
import type { SetupStatusDTO, ProvidersDTO } from './setupApi.js'

export interface RouterDeps {
  library: () => LibraryItemDTO[]
  series: (id: string) => SeriesDetailDTO | null
  runs: (offset: number, limit: number) => RunHistoryDTO[]
  /** 去 Jellyfin 化 P6：park 救援页列表。 */
  parked: () => ParkedItemDTO[]
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
  /** dashboard G5：GET /api/v2/workflow/workers——跑中 worker_task + 近期非 orchestrate runs。 */
  workflowWorkers: () => WorkflowWorkersDTO
  /** dashboard G5：GET /api/v2/library/series/:id——三层格阵合并详情（canonical ∪ 磁盘 ∪
   *  覆盖）。命中时的惰性 TMDB 缓存刷新是 server.ts wiring 的副作用，这个闭包本身仍是纯查询。 */
  librarySeriesDetail: (id: string) => LibrarySeriesDetailDTO | null
  /** dashboard G5：GET /api/v2/triage——甄别台：pending（park 救援清单）+ claimed（已认领 override 清单）。 */
  triage: () => TriageDTO
  /** dashboard-F4：GET /api/v2/workflow/runs/:id/trace——单 run 痕迹快照回放（区别于
   *  workflowWorkers 的 traceBus.peek 直播补拉：这里是收官后落库的完整快照，供 RunDetail
   *  右侧板"快照回放"用）。id 已在本文件里做纯数字校验+转 number 后再传入。 */
  runTrace: (id: number) => RunTraceDTO | null
  /** spec A §4.4：GET /api/v2/setup/status——bootstrap 完成度推导（wizard 入口判定）。 */
  setupStatus: () => SetupStatusDTO
  /** spec A §4.4/§5.4：GET /api/v2/setup/providers——Providers 区行数据（打码值/source/上次测试点）。 */
  providers: () => ProvidersDTO
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
  if (pathname === '/api/v2/library') return { status: 200, json: deps.library() }

  const sm = pathname.match(/^\/api\/v2\/series\/([^/]+)$/)
  if (sm) {
    const id = decodeIdSegment(sm[1])
    if (id === null || !isSafeId(id)) return { status: 400, json: { error: 'bad id' } }
    const detail = deps.series(id)
    return detail ? { status: 200, json: detail } : { status: 404, json: { error: 'not found' } }
  }

  if (pathname === '/api/v2/runs') {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    return { status: 200, json: deps.runs(offset, limit) }
  }

  // ---- parked (去 Jellyfin 化 P6：最小 park 救援) ----
  // GET 只读列表走这里（纯同步）；POST /api/parked/claim 需要解析 JSON body + 写库校验，
  // 走 server.ts 里同 /api/v2/reconcile-all 一样的专用分支，不硬塞进这个纯函数路由表。
  if (pathname === '/api/parked') return { status: 200, json: deps.parked() }

  // ---- settings / deploy / roots / fs (dashboard G4：两层设置 + 守备目录 UI 化) ----
  // 四个都是纯同步 GET，走这个纯函数路由表；写入端点（PUT settings、POST/DELETE roots）需要
  // body 解析/zod 校验，同 parked/claim 一样落在 server.ts 的独立 rawPath 分支。
  if (pathname === '/api/v2/settings') return { status: 200, json: deps.settings() }
  if (pathname === '/api/v2/settings/deploy') return { status: 200, json: deps.deploySettings() }
  if (pathname === '/api/v2/settings/roots') return { status: 200, json: deps.roots() }

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

  if (pathname === '/api/v2/workflow/passes') {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100)
    return { status: 200, json: deps.workflowPasses(limit) }
  }

  if (pathname === '/api/v2/workflow/workers') return { status: 200, json: deps.workflowWorkers() }

  // dashboard-F4：GET /api/v2/workflow/runs/:id/trace——纯数字 id 校验（runs.id 是
  // INTEGER PRIMARY KEY AUTOINCREMENT，跟 series/library 那两条路由的 tmdb:<n> 形状 id 不是
  // 同一个 id 空间，不能复用 isSafeId/SAFE_ID 那一套）。非数字 400；数字但行不存在 404。
  const trm = pathname.match(/^\/api\/v2\/workflow\/runs\/(\d+)\/trace$/)
  if (trm) {
    const trace = deps.runTrace(Number(trm[1]))
    return trace ? { status: 200, json: trace } : { status: 404, json: { error: 'not found' } }
  }

  const lsm = pathname.match(/^\/api\/v2\/library\/series\/([^/]+)$/)
  if (lsm) {
    const id = decodeIdSegment(lsm[1])
    if (id === null || !isSafeId(id)) return { status: 400, json: { error: 'bad id' } }
    const detail = deps.librarySeriesDetail(id)
    return detail ? { status: 200, json: detail } : { status: 404, json: { error: 'not found' } }
  }

  if (pathname === '/api/v2/triage') return { status: 200, json: deps.triage() }

  // ---- setup（spec A：bootstrap wizard 与 Providers 区）----
  if (pathname === '/api/v2/setup/status') return { status: 200, json: deps.setupStatus() }
  if (pathname === '/api/v2/setup/providers') return { status: 200, json: deps.providers() }

  return { status: 404, json: { error: 'not found' } }
}
