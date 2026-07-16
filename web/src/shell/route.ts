// web/src/shell/route.ts：新外壳的 hash 路由——四 tab（#/library #/workflow #/triage #/settings），
// 浏览器原生前进后退可用（location.hash 变化即触发 hashchange，无需自己维护历史栈）。
// 故意与旧 lib/hashRoute.ts（海报墙/详情/历史/park 那一套，dashboard-F3 已随老 components/
// 一并退役）分开设计过：新外壳的路由表只认四 tab + Library 的二级路由（#/library/:id 剧集页），
// 别的 tab 目前都只有一层。
import { useEffect, useState } from 'react'

export type Tab = 'library' | 'workflow' | 'triage' | 'settings'

const TAB_IDS: readonly Tab[] = ['library', 'workflow', 'triage', 'settings']

function isTab(value: string): value is Tab {
  return (TAB_IDS as readonly string[]).includes(value)
}

export interface ShellRoute {
  tab: Tab
  /** #/library/:id 命中时的剧集 id（已 decode）；其余情况 null。侧栏/顶栏高亮只看 tab，
   *  不受 libraryId 影响——在剧集详情页时 Library 仍是当前 tab。 */
  libraryId: string | null
}

/** hash → 路由。未识别/根路径一律落到 library（第一个 tab，也是产品默认落地页）。
 *  畸形百分号编码（如 '%zz'）让 decodeURIComponent 抛 URIError 时，libraryId 降级为 null
 *  （落到 SeriesGrid 列表页，不炸整个外壳）。 */
export function parseShellHash(hash: string): ShellRoute {
  const segs = hash.replace(/^#\/?/, '').split('/')
  const raw = segs[0] ?? ''
  const tab = isTab(raw) ? raw : 'library'
  let libraryId: string | null = null
  if (tab === 'library' && segs[1]) {
    try {
      libraryId = decodeURIComponent(segs[1])
    } catch {
      libraryId = null
    }
  }
  return { tab, libraryId }
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
export function libraryItemHref(id: string): string {
  return `#/library/${encodeURIComponent(id)}`
}
