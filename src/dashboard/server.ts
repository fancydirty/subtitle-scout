// src/dashboard/server.ts
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { URL } from 'node:url'
import { Ledger } from '../core/ledger.js'
import { PrefetchQueue } from '../daemon/queue.js'
import { buildSummary, buildRuns } from './api.js'
import { buildRunStory } from './story.js'
import { handleApiRoute, type RouterDeps } from './router.js'
import { queueStatusLabel } from './labels.js'
import type { InFlightItemDTO, QueueDTO } from './types.js'

export interface DashboardOpts {
  cacheRoot: string
  port: number
  token?: string
  distDir: string
  getInFlight: () => InFlightItemDTO[]
}

const WINDOW_MS = 168 * 3600_000
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
}

function readStory(cacheRoot: string, id: string, now: number) {
  const path = join(cacheRoot, 'journals', id, 'decision.json')
  if (!existsSync(path)) return null
  let journal: any
  try { journal = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  // 用 ledger 补 name/ts;缺失则回退
  const { events } = new Ledger(join(cacheRoot, 'ledger.jsonl')).read(now - WINDOW_MS)
  const ev = events.find(e => e.type === 'run' && e.journalPath.includes(`/journals/${id}/`)) as any
  const ledger = ev ? { name: ev.name, decision: ev.decision, ts: ev.ts } : { name: '（较早记录）', decision: journal?.decision?.decision ?? 'error', ts: 0 }
  try { return buildRunStory(journal, ledger) } catch { return null }
}

function buildQueue(cacheRoot: string): QueueDTO {
  // PrefetchQueue 无导出 entries 的公开访问器;经 queue.json 直读
  const file = join(cacheRoot, 'queue.json')
  let entries: any[] = []
  try { entries = JSON.parse(readFileSync(file, 'utf8')).entries ?? [] } catch { return { pending: [], dormant: [] } }
  const map = (e: any) => ({ itemId: e.itemId, name: e.name, statusLabel: queueStatusLabel(e.state), nextRetryAt: e.nextRetryAt ?? null })
  return {
    pending: entries.filter(e => e.state === 'pending').map(map),
    dormant: entries.filter(e => e.state === 'dormant').map(map),
  }
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
  const { cacheRoot, port, token, distDir, getInFlight } = opts
  const deps: RouterDeps = {
    summary: () => {
      const now = Date.now()
      const { events } = new Ledger(join(cacheRoot, 'ledger.jsonl')).read(now - WINDOW_MS)
      let qsize = { pending: 0, dormant: 0 }
      try { qsize = new PrefetchQueue(join(cacheRoot, 'queue.json')).size() } catch { /* 无队列 */ }
      return buildSummary(events, qsize, now)
    },
    runs: (limit) => {
      const now = Date.now()
      const { events } = new Ledger(join(cacheRoot, 'ledger.jsonl')).read(now - WINDOW_MS)
      return { inFlight: getInFlight(), runs: buildRuns(events, limit) }
    },
    story: (id) => readStory(cacheRoot, id, Date.now()),
    queue: () => buildQueue(cacheRoot),
  }

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rawPath = url.pathname   // 未解码
      if (rawPath.startsWith('/api/')) {
        const reqToken = url.searchParams.get('token') ?? (req.headers['x-dashboard-token'] as string | undefined)
        const query: Record<string, string> = {}
        url.searchParams.forEach((v, k) => { query[k] = v })
        // runs/:id 的 id 单独解码后检查合法性（%2f→/ 等路径穿越字符拒为 400）
        const m = rawPath.match(/^\/api\/runs\/(.+)$/)
        if (m) {
          const decodedId = decodeURIComponent(m[1])
          // 解码后包含 / 或 .. 视为路径穿越尝试，直接拒绝
          if (decodedId.includes('/') || decodedId.includes('\\')) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'bad id' }))
            return
          }
        }
        const pathname = m ? `/api/runs/${decodeURIComponent(m[1])}` : rawPath
        const result = handleApiRoute({ pathname, query, token: reqToken ?? undefined }, deps, token)
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
