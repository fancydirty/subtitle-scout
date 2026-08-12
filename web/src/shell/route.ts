// web/src/shell/route.ts：新外壳的 hash 路由，浏览器原生前进后退可用（location.hash 变化即
// 触发 hashchange，无需自己维护历史栈）。故意与旧 lib/hashRoute.ts（海报墙/详情/历史/park
// 那一套，dashboard-F3 已随老 components/ 一并退役）分开设计过：新外壳的路由表只认 tab +
// Library 的二级路由（#/library/:id 剧集页），别的 tab 目前都只有一层。
//
// 2026-08-07（spec §5）：甄别 tab 本轮雪藏，'triage' 从 Tab 联合与 TAB_IDS 移除。旧书签
// #/triage 由下面 isTab() 的兜底自动降级（不白屏、不 404）。将来重启用把 'triage' 加回
// 这两处即可。
//
// ── 2026-08-12（Task ⑦）：Tab ≠ 导航项，两个集合从这里开始分家 ──────────────────
// 新导航是 FRONTEND-SPEC 的三个页面（活动/通知/媒体库）+ 设置。但 `#/library`（旧海报墙）
// 与 `#/workflow`（**今天渲染的就是真活动页 ActivityPage**）**仍是合法路由**，只是不再出现
// 在侧栏与 ⌘K 里。
//
// 为什么不把这两个从 Tab 联合里删掉（用户裁决，2026-08-12）：
//  · `#/workflow` 今天渲染 ActivityPage，而新活动页要到 Task ⑨ 才填肉。现在删 = 把仓里
//    **唯一能用的活动视图**在两个 task 的窗口期里变成无法访问，用户书签直接降级到占位页。
//  · `activity/` 有 **7 处** import `workflow/`（RunDetail/RerunDialog/rerun/phrases×3/
//    useLiveTrail），判「删 workflow」会立刻编译失败。旧页面下架是 Task ⑪ 的独立动作。
// 故本 task 的处置是**只从导航里摘掉**（见 tabs.ts 的 TABS），路由与渲染分支原样保留。
//
// `Tab`（合法路由全集）与 `TABS`（侧栏渲染哪几项）**是两个集合**，这条分家是有意的：
// Sidebar 的 TAB_ICONS 仍是 `Record<Tab, …>` 穷尽映射（少一个键 TS 就报错），而侧栏只
// 遍历 TABS——想让某个路由"活着但不出现在导航里"，只需要把它从 TABS 拿掉，不动 Tab。
import { useEffect, useState } from 'react'

/** 合法路由全集（**不等于**导航项集合，见文件头注释）。
 *  · 前四个 = 新导航四项（活动/通知/媒体库/设置）；
 *  · 后两个 = 旧页面路由，仍可直达但已不在侧栏（Task ⑪ 下架）。 */
export type Tab = 'activity' | 'notifications' | 'media' | 'settings' | 'library' | 'workflow'

const TAB_IDS: readonly Tab[] = ['activity', 'notifications', 'media', 'settings', 'library', 'workflow']

/** 未识别 hash / 根路径的落点。
 *  2026-08-12 用户裁决：从 'library' 改为 'activity'——library 已不在导航里，继续落它会让
 *  用户刷新后停在一个**侧栏没有任何高亮项**的页面上。活动页是新导航第一项，也是产品定位
 *  （FRONTEND-SPEC §一「只有监视和折腾设置的作用」）里那个"打开就想看的一屏"。 */
const DEFAULT_TAB: Tab = 'activity'

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
  /** Task ⑧：#/media/:workId 命中时的作品 id（已 decode）；其余情况 null。
   *
   *  ⚠️ **与 libraryId 是两个不同的 id 空间，刻意不合并**：libraryId 是旧 `series.id`
   *  （旧 /api/v2/library/series/:id 的键），mediaWorkId 是 `works.id`
   *  （新 /api/v2/mediaLibrary/:workId 的键）。两者今天在生产里字面都是 'tmdb:<n>'，
   *  但 series 表 0 行、works 表 110 行——**它们不是同一张表的同一行**。共用一个字段
   *  会让"哪个页面该发哪个请求"变成靠 tab 猜，Task ⑪ 删旧页面时也分不清哪些用法要删。 */
  mediaWorkId?: string | null
}

/** hash → 路由。未识别/根路径一律落到 DEFAULT_TAB（活动页，见其注释）。
 *  畸形百分号编码（如 '%zz'）让 decodeURIComponent 抛 URIError 时，libraryId 降级为 null
 *  （落到 SeriesGrid 列表页，不炸整个外壳）。 */
export function parseShellHash(hash: string): ShellRoute {
  const segs = hash.replace(/^#\/?/, '').split('/')
  const raw = segs[0] ?? ''
  const tab = isTab(raw) ? raw : DEFAULT_TAB
  let libraryId: string | null = null
  let movieId: string | null = null
  let mediaWorkId: string | null = null
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

  // Task ⑧：#/media/:workId 二级路由（媒体库详情，季集网格）。
  // 与 library 分支的形状刻意一致（try/catch 降级到 null → 落回列表页而不是白屏），
  // 但 id 落在**另一个字段**上（mediaWorkId），理由见 ShellRoute 的字段注释。
  if (tab === 'media' && segs[1]) {
    try {
      mediaWorkId = decodeURIComponent(segs[1])
    } catch {
      mediaWorkId = null
    }
  }

  return { tab, page, libraryId, movieId, mediaWorkId }
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

/** Task ⑧：#/media/:workId 的 href——workId 含冒号（'tmdb:1396'），encodeURIComponent
 *  编码后由 parseShellHash 的 decodeURIComponent 解回。海报卡与详情页返回链接共用这一个
 *  拼法（同 libraryItemHref 的既有理由：两处各写一份必然漂移）。 */
export function mediaItemHref(workId: string): string {
  return `#/media/${encodeURIComponent(workId)}`
}
