// src/dashboard/router.ts
import type { SummaryDTO, RunsDTO, StoryDTO, QueueDTO } from './types.js'

export interface RouterDeps {
  summary: () => SummaryDTO
  runs: (limit: number) => RunsDTO
  story: (id: string) => StoryDTO | null
  queue: () => QueueDTO
}
export interface ApiResult { status: number; json: unknown }

const JOURNAL_ID = /^[A-Za-z0-9._-]+$/   // 允许字符集；额外禁止 '..' 片段
const isSafeId = (id: string) => JOURNAL_ID.test(id) && !id.includes('..')

/** 纯 API 路由。token 未配置则不校验;配置了则需精确匹配。id 非法 400,未命中 404。 */
export function handleApiRoute(
  req: { pathname: string; query: Record<string, string>; token?: string },
  deps: RouterDeps,
  configuredToken?: string,
): ApiResult {
  if (configuredToken && req.token !== configuredToken) return { status: 401, json: { error: 'unauthorized' } }

  const { pathname } = req
  if (pathname === '/api/summary') return { status: 200, json: deps.summary() }
  if (pathname === '/api/queue') return { status: 200, json: deps.queue() }
  if (pathname === '/api/runs') {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200)
    return { status: 200, json: deps.runs(limit) }
  }
  const m = pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (m) {
    const id = m[1]
    if (!isSafeId(id)) return { status: 400, json: { error: 'bad id' } }
    const story = deps.story(id)
    return story ? { status: 200, json: story } : { status: 404, json: { error: 'not found' } }
  }
  return { status: 404, json: { error: 'not found' } }
}
