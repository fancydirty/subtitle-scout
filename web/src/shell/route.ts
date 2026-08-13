// web/src/shell/route.ts：新外壳的 hash 路由，浏览器原生前进后退可用（location.hash 变化即
// 触发 hashchange，无需自己维护历史栈）。故意与旧 lib/hashRoute.ts（海报墙/详情/历史/park
// 那一套，dashboard-F3 已随老 components/ 一并退役）分开设计过：新外壳的路由表只认 tab +
// Library 的二级路由（#/library/:id 剧集页），别的 tab 目前都只有一层。
//
// 2026-08-07（spec §5）：甄别 tab 本轮雪藏，'triage' 从 Tab 联合与 TAB_IDS 移除。旧书签
// #/triage 由下面 isTab() 的兜底自动降级（不白屏、不 404）。将来重启用把 'triage' 加回
// 这两处即可。
// 🟡 2026-08-13 更正：「雪藏」不等于「将来可能删」——它是**明确保留**的。为什么留、
//    什么时候才可以删（可证伪判据 + 机器载体）见 `web/src/triage/TriagePage.tsx` 头注释，
//    那里是正本；本处不重抄。
//
// ── 2026-08-12（Task ⑪）：旧页面下架，`Tab` 收回到导航四项 ──────────────────────
// Task ⑦ 时 `Tab`（合法路由全集）比 `TABS`（侧栏项）多出 library / workflow 两个旧路由，
// 那是**窗口期的权宜**：当时 `#/workflow` 渲染的旧 ActivityPage 是仓里唯一能用的活动视图。
// Task ⑨ 建成新活动页（`workbench/`）、Task ⑧ 建成新媒体库页（`media/`）之后这个理由消失，
// 本 task 把旧页面整体移入 `web/src/_legacy/`，两个 tab 随之从 `Tab` 联合里删除。
// 于是 `Tab` 与 `TABS` 重新合一——Sidebar 的 `Record<Tab, Icon>` 不再需要给不进导航的项
// 编图标，`AppShell` 也不再有渲染 `_legacy` 组件的分支。
//
// 🔴 **旧 hash 不是直接失效，而是显式改写到新页面**（见下面的 LEGACY_REDIRECTS）。
// 三种可能的处置里，另外两种都被实测否掉：
//  ① 「保留旧路由、让 `_legacy` 页面照常渲染」——那 `_legacy` 就不是下架而是改名，
//     设计文档 §2.2「跑稳后删」的下一步永远走不到（删了会白屏）。
//  ② 「`#/library` 重定向到 `_legacy/library`」——设计文档教训十已裁决**不许**：
//     旧 library 页读 `series` 表（生产 **0 行**），那是把老书签稳定地送进一个恒空页面。
//     "什么都没有"比 404 更难排查，因为它不报错。
// 故取第三种：**改写到功能等价的新页面**。
//  · `#/library`、`#/library/:id`、`#/library/movies/:id` → `#/media`（**丢弃 id 段**）
//    丢 id 是关键：旧 `libraryId` 是 `series.id`、新 `mediaWorkId` 是 `works.id`，
//    两者今天字面都长成 `tmdb:<n>` 但**不是同一张表的同一行**（series 0 行 / works 110 行）。
//    带着 id 转过去 = 拿旧 id 打新端点，三种结局（正常/404/**显示另一部剧**）都不报错，
//    最后一种正是本仓要躲的静默串页。落到列表页则一定是有数据的真页面。
//  · `#/workflow` → `#/activity`（旧活动页的功能后继就是新活动页，无 id 段问题）
// 改写在 `parseShellHash`（纯函数，内容立刻正确）与 `useShellRoute`（顺手把地址栏也修好，
// 老书签自愈）**两层各做一次**：只做前者地址栏会一直显示旧 hash，只做后者则改写失败时白屏。
import { useEffect, useState } from 'react'

/** 合法路由全集 —— Task ⑪ 起**等于**导航四项（`tabs.ts` 的 TABS）。
 *  旧的 library / workflow 已随页面移入 `_legacy/`，它们的 hash 由 LEGACY_REDIRECTS 接管。 */
export type Tab = 'activity' | 'notifications' | 'media' | 'settings'

const TAB_IDS: readonly Tab[] = ['activity', 'notifications', 'media', 'settings']

/** 旧 hash 首段 → 新 tab。**只认第一段，后面的 id 段一律丢弃**（理由见文件头注释）。
 *  `triage` 不在这里：它是 spec §5 雪藏的第三个页面，没有功能后继，走下面的 DEFAULT_TAB
 *  兜底即可（落到活动页）。列进来会假装"甄别 = 活动"，那是编造对应关系。 */
const LEGACY_REDIRECTS: Readonly<Record<string, Tab>> = {
  library: 'media',
  workflow: 'activity',
}


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
  /** Task ⑧：#/media/:workId 命中时的作品 id（已 decode）；其余情况 null。
   *
   *  ⚠️ Task ⑪ 起这是**唯一**的 id 段。旧的 `libraryId` / `movieId` / `page` 三个字段随
   *  旧 library 页面移入 `_legacy/` 一并删除——它们的键是 `series.id`（旧 `series` 表，
   *  生产 0 行），而这里是 `works.id`（新 `files`/`works`，110 行）。两者字面都长成
   *  `tmdb:<n>` 却不是同一张表的同一行，所以旧 hash 的 id 段在改写时被**丢弃**而不是
   *  搬到这个字段上（见文件头 LEGACY_REDIRECTS 的论证）。 */
  mediaWorkId?: string | null
}

/** hash → 路由。
 *  · 认识的 tab（导航四项）→ 原样；
 *  · 旧 tab（library/workflow）→ 按 LEGACY_REDIRECTS 改写，**id 段丢弃**；
 *  · 其余（含 `#/triage` 这类雪藏页的老书签、根路径、乱码）→ DEFAULT_TAB。
 *  畸形百分号编码（如 '%zz'）让 decodeURIComponent 抛 URIError 时，mediaWorkId 降级为
 *  null（落回媒体库列表页，不炸整个外壳）。 */
export function parseShellHash(hash: string): ShellRoute {
  const segs = hash.replace(/^#\/?/, '').split('/')
  const raw = segs[0] ?? ''
  // 顺序要紧：先认真 tab，再查旧表，最后兜底。旧表里的键与 Tab 联合无交集（library/
  // workflow 已从联合里删除），所以两条不会互相遮蔽。
  const redirected = LEGACY_REDIRECTS[raw]
  const tab: Tab = isTab(raw) ? raw : (redirected ?? DEFAULT_TAB)
  let mediaWorkId: string | null = null

  // Task ⑧：#/media/:workId 二级路由（媒体库详情，季集网格）。
  // 🔴 `isTab(raw)` 这道闸不能省：被改写过来的 `#/library/tmdb%3A123` 也满足
  // `tab === 'media'`，若不区分就会把旧 `series.id` 当成 `works.id` 塞进详情页——
  // 那正是文件头说的静默串页。只有**用户真的写了 `#/media/...`** 时才读 id 段。
  if (tab === 'media' && isTab(raw) && segs[1]) {
    try {
      mediaWorkId = decodeURIComponent(segs[1])
    } catch {
      mediaWorkId = null
    }
  }

  return { tab, mediaWorkId }
}
/** 旧 hash 是否需要地址栏改写。导出只为测试能直接钉这条判定（不必挂组件树）。
 *  判据是**首段落在 LEGACY_REDIRECTS 里**，不是"parse 出来的 tab 与首段不同"——后者会
 *  把 `#/nonsense`、`#/triage` 这类兜底也算进来，那些是**兜底**不是**改写**，把地址栏
 *  从 `#/nonsense` 改成 `#/activity` 是越权（用户没访问过一个曾经存在的页面）。 */
export function legacyRedirectTarget(hash: string): Tab | null {
  const raw = hash.replace(/^#\/?/, '').split('/')[0] ?? ''
  return LEGACY_REDIRECTS[raw] ?? null
}

export function useShellRoute(): ShellRoute {
  const [route, setRoute] = useState<ShellRoute>(() => parseShellHash(location.hash))
  useEffect(() => {
    const onHash = () => setRoute(parseShellHash(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 🔴 老书签自愈：地址栏里还写着 `#/library/tmdb:123` 时，上面的 parse 已经让**内容**
  // 落在媒体库列表上，但地址栏本身还是旧的——用户再收藏一次、或者刷新，仍然走改写路径。
  // 这里把 location.hash 就地改成新地址（replace 语义：用 location.replace 覆盖当前
  // 历史项，**不留一条回不去的历史**——若用 `location.hash =` 赋值，点后退会回到旧 hash，
  // 又被改写回来，形成用户按不动后退键的陷阱）。
  //
  // 依赖 route.tab 而不是空数组：hashchange 之后（用户手输旧地址）也要能改写一次。
  useEffect(() => {
    const target = legacyRedirectTarget(location.hash)
    if (target === null) return
    const next = `${location.pathname}${location.search}#/${target}`
    location.replace(next)
  }, [route])

  return route
}

/** 程序化跳转——CommandK 选中项时用。侧栏/面包屑走 <a href="#/xxx">，交给浏览器原生处理即可，
 *  不需要这个函数。 */
export function go(tab: Tab): void {
  location.hash = `/${tab}`
}

/** Task ⑧：#/media/:workId 的 href——workId 含冒号（'tmdb:1396'），encodeURIComponent
 *  编码后由 parseShellHash 的 decodeURIComponent 解回。海报卡与详情页返回链接共用这一个
 *  拼法（两处各写一份必然漂移）。
 *
 *  ⚠️ Task ⑪：原先这下面还有一个 `libraryItemHref`（拼 `#/library/:id` 与
 *  `#/library/movies/:id`）。它的唯一调用方是旧海报卡，已随旧页面搬到
 *  `_legacy/library/legacyHref.ts`——活的 shell 不该再持有任何指向已下架页面的拼址逻辑，
 *  否则 `_legacy` 删除那天这里会留下一个没人调用的孤儿函数（本仓病 A 的同型）。 */
export function mediaItemHref(workId: string): string {
  return `#/media/${encodeURIComponent(workId)}`
}
