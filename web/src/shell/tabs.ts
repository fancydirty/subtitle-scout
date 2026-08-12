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
//
// ── 2026-08-12（Task ⑦）：本表 = **侧栏渲染哪几项**，不再等于"合法路由有哪些" ──────
// FRONTEND-SPEC 的三个页面（活动/通知/媒体库）+ 设置进表。旧的 library/workflow **路由仍在**
// （route.ts 的 Tab 联合里还有它们，直达 #/library、#/workflow 照常渲染），只是从这张表里
// 摘掉 → 侧栏与 ⌘K 不再列出。摘导航项与删路由是两件事，后者是 Task ⑪。
// 论证见 route.ts 头注释（简言之：#/workflow 今天渲染的就是唯一能用的活动页，而
// activity/ 有 7 处 import workflow/，现在删会立刻编译失败）。
//
// 加一项要动的地方与文件头第一段列的完全一样（Tab 联合 → 本表 → TAB_ICONS → 图标 →
// AppShell 分支 → i18n 两侧）。**其中 AppShell 分支与 i18n 键漏了都不报错**：前者静默
// 渲染空白，后者静默显示 key 原文。tabs.contract.test.ts 就是为这两条静默失效存在的。
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
