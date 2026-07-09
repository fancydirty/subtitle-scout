// src/dashboard/server.ts
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { URL } from 'node:url'
import type { ScoutDb } from '../v2/db.js'
import { buildLibrary, buildSeriesDetail, buildRuns, proxyPoster } from './apiV2.js'
import { handleApiRoute, type RouterDeps } from './router.js'

export interface DashboardOpts {
  db: ScoutDb
  port: number
  token?: string
  distDir: string
  /** Jellyfin 海报代理凭据——API key 只在后端持有，绝不出后端。 */
  jellyfin: { baseUrl: string; apiKey: string }
  /** 测试注入用；默认全局 fetch。 */
  fetchImpl?: typeof fetch
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
  const { db, port, token, distDir, jellyfin } = opts
  const fetchImpl = opts.fetchImpl ?? fetch
  const deps: RouterDeps = {
    library: () => buildLibrary(db),
    series: (id) => buildSeriesDetail(db, id),
    runs: (offset, limit) => buildRuns(db, offset, limit),
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rawPath = url.pathname   // 未解码
      const reqToken = url.searchParams.get('token') ?? (req.headers['x-dashboard-token'] as string | undefined)

      // 海报代理：/api/poster/:itemId?tag=——server 端取图流回，API key 不出后端。
      const pm = rawPath.match(/^\/api\/poster\/([^/]+)$/)
      if (pm) {
        if (token && reqToken !== token) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const itemId = decodeURIComponent(pm[1])
        const tag = url.searchParams.get('tag') ?? undefined
        const result = await proxyPoster(itemId, tag, { baseUrl: jellyfin.baseUrl, apiKey: jellyfin.apiKey, fetchImpl })
        res.writeHead(result.status, { 'content-type': result.contentType, 'cache-control': result.cacheControl })
        res.end(result.body ?? Buffer.from('not found'))
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
