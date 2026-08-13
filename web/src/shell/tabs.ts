// web/src/shell/tabs.ts：tab 常量表——顺序/文案 key，Sidebar 与 CommandK 共用同一份，
// 避免两处各写一份映射、漂移出两套顺序。
//
// 2026-08-06 重设计：去掉分区（LIBRARY / AGENTS / SYSTEM），改为扁平条目 + 图标。
// 旧分区 eyebrow（按 DESIGN.md §6 铁律固定英文大写 mono 小标）已退役——扁平结构下
// 单条目分组冗余消失，一目了然无需额外层级。
//
// 2026-08-07（spec §5）：甄别 tab 本轮雪藏——从四项减为三项。源码保留在 web/src/triage/ 下，
// 将来重启用时把 { id: 'triage', labelKey: 'nav_triage' } 加回本表即可（Sidebar 的
// TAB_ICONS/角标、route.ts 的 Tab 联合、AppShell 的分支、i18n 的 nav_triage 键需一并恢复）。
// 🟡 2026-08-13 更正：「雪藏」不等于「将来可能删」——它是**明确保留**的。为什么留、
//    什么时候才可以删（可证伪判据 + 机器载体）见 `web/src/triage/TriagePage.tsx` 头注释，
//    那里是正本；本处不重抄。
//
// ── 2026-08-12（Task ⑦→⑪）：本表 = 侧栏渲染哪几项，Task ⑪ 起它**又等于**合法路由全集 ──
// Task ⑦ 把 FRONTEND-SPEC 的三个页面（活动/通知/媒体库）+ 设置放进本表，同时把旧的
// library/workflow 只摘导航、留路由（那是等 Task ⑧⑨ 新页面填肉的窗口期权宜）。
// Task ⑪ 旧页面移入 `web/src/_legacy/`，两个旧 tab 从 `route.ts` 的 `Tab` 联合里删除，
// 它们的老 hash 由 `LEGACY_REDIRECTS` 改写到新页面。于是**两个集合重新合一**：
// `TABS.map(m => m.id)` 就是 `Tab` 的全部取值。
//
// 加一项要动的地方与文件头第一段列的完全一样（Tab 联合 → 本表 → TAB_ICONS → 图标 →
// AppShell 分支 → i18n 两侧）。**其中 AppShell 分支与 i18n 键漏了都不报错**：前者静默
// 渲染空白，后者静默显示 key 原文。nav.contract.test.tsx 就是为这两条静默失效存在的。
import type { Tab } from './route.js'

export type NavLabelKey =
  | 'nav_activity'
  | 'nav_notifications'
  | 'nav_media'
  | 'nav_settings'

export interface TabMeta {
  id: Tab
  labelKey: NavLabelKey
}

/** 四项：活动 / 通知 / 媒体库 / 设置——顺序即侧栏渲染顺序，也是 ⌘K 的列表顺序。
 *  第一项同时是 route.ts 的 DEFAULT_TAB（未识别 hash 的落点），两处刻意一致：侧栏第一项
 *  与"刷新后落在哪"不一致会让用户以为自己点错了。 */
export const TABS: TabMeta[] = [
  { id: 'activity', labelKey: 'nav_activity' },
  { id: 'notifications', labelKey: 'nav_notifications' },
  { id: 'media', labelKey: 'nav_media' },
  { id: 'settings', labelKey: 'nav_settings' },
]
