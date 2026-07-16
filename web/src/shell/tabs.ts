// web/src/shell/tabs.ts：四 tab 常量表——顺序/文案 key/所属侧栏分区，Sidebar 与 CommandK
// 共用同一份，避免两处各写一份映射、漂移出两套顺序。
//
// 分区 eyebrow（LIBRARY / AGENTS / SYSTEM）按 DESIGN.md §6 铁律固定英文大写 mono 小标，
// 不进 i18n 表——它们是外壳骨架的一部分，不是随语言变化的文案（类比 Workflow 区技术值
// 永不本地化的精神，只是这里管的是"分区名"而不是"技术词表"）。
import type { Tab } from './route.js'

export type NavLabelKey = 'nav_library' | 'nav_workflow' | 'nav_triage' | 'nav_settings'
export type Section = 'LIBRARY' | 'AGENTS' | 'SYSTEM'

export interface TabMeta {
  id: Tab
  labelKey: NavLabelKey
  section: Section
}

/** 四项：Library（LIBRARY 区）、Workflow（AGENTS 区）、Triage（AGENTS 区，角标=甄别站
 *  待认领计数）、Settings（SYSTEM 区）——顺序即侧栏渲染顺序。 */
export const TABS: TabMeta[] = [
  { id: 'library', labelKey: 'nav_library', section: 'LIBRARY' },
  { id: 'workflow', labelKey: 'nav_workflow', section: 'AGENTS' },
  { id: 'triage', labelKey: 'nav_triage', section: 'AGENTS' },
  { id: 'settings', labelKey: 'nav_settings', section: 'SYSTEM' },
]

export const SECTIONS: Section[] = ['LIBRARY', 'AGENTS', 'SYSTEM']
