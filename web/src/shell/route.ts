// web/src/shell/route.ts：新外壳的 hash 路由——三 tab（#/library #/workflow #/settings），
// 浏览器原生前进后退可用（location.hash 变化即触发 hashchange，无需自己维护历史栈）。
// 故意与旧 lib/hashRoute.ts（海报墙/详情/历史/park 那一套，dashboard-F3 已随老 components/
// 一并退役）分开设计过：新外壳的路由表只认 tab + Library 的二级路由（#/library/:id 剧集页），
// 别的 tab 目前都只有一层。
//
// 2026-08-07（spec §5）：甄别 tab 本轮雪藏，'triage' 从 Tab 联合与 TAB_IDS 移除。旧书签
// #/triage 由下面 isTab() 的兜底自动降级到 library（不白屏、不 404）。将来重启用把
// 'triage' 加回这两处即可。
import { useEffect, useState } from 'react'

export type Tab = 'library' | 'workflow' | 'settings'

const TAB_IDS: readonly Tab[] = ['library', 'workflow', 'settings']

function isTab(value: string): value is Tab {
  return (TAB_IDS as readonly string[]).includes(value)
}

export interface ShellRoute {
  tab: Tab
  /** 页面类型：library 列表、series-detail 剧集详情、movie-detail 电影详情 */
  page?: 'library' | 'series-detail' | 'movie-detail'
  /** #/library/:id 命中时的剧集 id（已 decode）；其余情况 null。侧栏/顶栏高亮只看 tab，
   *  不受 libraryId 影响——在剧集详情页时 Library 仍是当前 tab。 */
  libraryId: string | null
  /** #/library/movies/:id 命中时的电影 id（已 decode）；其余情况 null。 */
  movieId?: string | null
}

/** hash → 路由。未识别/根路径一律落到 library（第一个 tab，也是产品默认落地页）。
 *  畸形百分号编码（如 '%zz'）让 decodeURIComponent 抛 URIError 时，libraryId 降级为 null
 *  （落到 SeriesGrid 列表页，不炸整个外壳）。 */
export function parseShellHash(hash: string): ShellRoute {
  const segs = hash.replace(/^#\/?/, '').split('/')
  const raw = segs[0] ?? ''
  const tab = isTab(raw) ? raw : 'library'
  let libraryId: string | null = null
  let movieId: string | null = null
  let page: 'library' | 'series-detail' | 'movie-detail' | undefined = undefined

  if (tab === 'library') {
    if (segs[1] === 'movies' && segs[2]) {
      // /library/movies/:id → movie detail
      try {
        movieId = decodeURIComponent(segs[2])
        page = 'movie-detail'
      } catch {
        movieId = null
      }
    } else if (segs[1]) {
      // /library/:seriesId → series detail
      try {
        libraryId = decodeURIComponent(segs[1])
        page = 'series-detail'
      } catch {
        libraryId = null
      }
    } else {
      // /library → library index
      page = 'library'
    }
  }

  return { tab, page, libraryId, movieId }
}

export function useShellRoute(): ShellRoute {
  const [route, setRoute] = useState<ShellRoute>(() => parseShellHash(location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseShellHash(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

/** 程序化跳转——CommandK 选中项时用。侧栏/面包屑走 <a href="#/xxx">，交给浏览器原生处理即可，
 *  不需要这个函数。 */
export function go(tab: Tab): void {
  location.hash = `/${tab}`
}

/** #/library/:id 的 href——id 含冒号（tmdb:123），encodeURIComponent 编码后 parseShellHash
 *  的 decodeURIComponent 解回。海报卡/面包屑返回链接共用这一个拼法，避免两处各写一份。 */
export function libraryItemHref(item: { kind: 'series' | 'movie'; libraryId: string }): string {
  if (item.kind === 'movie') {
    return `#/library/movies/${encodeURIComponent(item.libraryId)}`
  }
  return `#/library/${encodeURIComponent(item.libraryId)}`
}
