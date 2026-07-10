// web/src/lib/hashRoute.ts：极简 hash 路由（无外部依赖）。
// #/ 海报墙 · #/series/:id 详情 · #/history 全局记录。
import { useEffect, useState } from 'react'

export type Route =
  | { name: 'library' }
  | { name: 'series'; id: string }
  | { name: 'history' }

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '')
  const sm = h.match(/^\/series\/([^/?]+)/)
  if (sm) return { name: 'series', id: decodeURIComponent(sm[1]) }
  if (h.startsWith('/history')) return { name: 'history' }
  return { name: 'library' }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

export function go(path: string): void {
  location.hash = path
}
