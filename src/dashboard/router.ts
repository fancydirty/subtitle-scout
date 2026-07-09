// src/dashboard/router.ts
import type { LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO } from './apiV2.js'

export interface RouterDeps {
  library: () => LibraryItemDTO[]
  series: (id: string) => SeriesDetailDTO | null
  runs: (offset: number, limit: number) => RunHistoryDTO[]
}
export interface ApiResult { status: number; json: unknown }

const SAFE_ID = /^[A-Za-z0-9._-]+$/   // 允许字符集；额外禁止 '..' 片段
const isSafeId = (id: string) => SAFE_ID.test(id) && !id.includes('..')

// v1 端点已随 ledger/queue 一并废弃——命中返回 410，别硬撑。
const V1_GONE = { status: 410, json: { error: 'gone', detail: 'v1 endpoint retired; use /api/v2/*' } } as const

/** 纯 API 路由。token 未配置则不校验;配置了则需精确匹配。id 非法 400,未命中 404。 */
export function handleApiRoute(
  req: { pathname: string; query: Record<string, string>; token?: string },
  deps: RouterDeps,
  configuredToken?: string,
): ApiResult {
  if (configuredToken && req.token !== configuredToken) return { status: 401, json: { error: 'unauthorized' } }

  const { pathname } = req

  // ---- v1 retired ----
  if (pathname === '/api/summary' || pathname === '/api/queue') return V1_GONE
  if (pathname === '/api/runs' || /^\/api\/runs\/[^/]+$/.test(pathname)) return V1_GONE

  // ---- v2 ----
  if (pathname === '/api/v2/library') return { status: 200, json: deps.library() }

  const sm = pathname.match(/^\/api\/v2\/series\/([^/]+)$/)
  if (sm) {
    const id = sm[1]
    if (!isSafeId(id)) return { status: 400, json: { error: 'bad id' } }
    const detail = deps.series(id)
    return detail ? { status: 200, json: detail } : { status: 404, json: { error: 'not found' } }
  }

  if (pathname === '/api/v2/runs') {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    return { status: 200, json: deps.runs(offset, limit) }
  }

  return { status: 404, json: { error: 'not found' } }
}
