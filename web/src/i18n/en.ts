// web/src/i18n/en.ts：扁平 key 表，英文基准。workflow_* 键是"真源"——zh.ts 反向引用这里的值
// （DESIGN.md §7：Workflow 区永不本地化，用户裁决），改 Workflow 文案只许改这个文件。
export const en = {
  // 侧栏导航项标签。三个分区 eyebrow（LIBRARY/AGENTS/SYSTEM）按 DESIGN.md 铁律固定英文大写，
  // 不进这张表——见 web/src/shell/tabs.ts 顶部注释。
  nav_library: 'Library',
  nav_workflow: 'Workflow',
  nav_triage: 'Triage',
  nav_settings: 'Settings',

  // ⌘K 命令面板：F2 只做四 tab 导航，不做搜索。
  cmdk_trigger: 'Find anything',
  cmdk_label: 'Command palette',
  cmdk_placeholder: 'Jump to a page…',
  cmdk_empty: 'No matches',

  // Library tab 占位（F3 填肉前的 Empty 态）。
  library_empty_title: 'No library yet',
  library_empty_desc: 'Once media roots are scanned, series and movies will appear here.',

  // Workflow 区永不本地化——本文件是这两个键的唯一真源，zh.ts 直接引用，不重复翻译。
  workflow_empty_title: 'No active work',
  workflow_empty_desc: 'Pending passes and worker traces will show up here once the orchestrator has something to do.',

  // Triage tab 占位。
  triage_empty_title: 'Nothing parked',
  triage_empty_desc: 'Files the recognizer could not place with confidence will wait here for a manual claim.',

  // Settings tab 占位。
  settings_empty_title: 'Settings coming soon',
  settings_empty_desc: 'Media roots, target languages, and deploy info will live here.',
} as const
