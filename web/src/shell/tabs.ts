// web/src/shell/tabs.ts：四 tab 常量表——顺序/文案 key，Sidebar 与 CommandK 共用同一份，
// 避免两处各写一份映射、漂移出两套顺序。
//
// 2026-08-06 重设计：去掉分区（LIBRARY / AGENTS / SYSTEM），改为扁平四条 + 图标。
// 旧分区 eyebrow（按 DESIGN.md §6 铁律固定英文大写 mono 小标）已退役——扁平结构下
// 单条目分组冗余消失，四项一目了然无需额外层级。
import type { Tab } from './route.js'

export type NavLabelKey = 'nav_library' | 'nav_workflow' | 'nav_triage' | 'nav_settings'

export interface TabMeta {
  id: Tab
  labelKey: NavLabelKey
}

/** 四项：Library（媒体库）、Workflow（工作流）、Triage（甄别，角标=甄别站待认领计数）、
 *  Settings（设置）——顺序即侧栏渲染顺序。 */
export const TABS: TabMeta[] = [
  { id: 'library', labelKey: 'nav_library' },
  { id: 'workflow', labelKey: 'nav_workflow' },
  { id: 'triage', labelKey: 'nav_triage' },
  { id: 'settings', labelKey: 'nav_settings' },
]
