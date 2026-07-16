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

  // Library tab：真正的空库态（F2 占位期借用过这两个键，F3 填肉后原样留作"库确实空"的事实）。
  library_empty_title: 'No library yet',
  library_empty_desc: 'Once media roots are scanned, series and movies will appear here.',

  // 筛选 chip 排（SeriesGrid 顶部）。
  library_filter_all: 'All',
  library_filter_gap: 'Has gaps',
  library_filter_throttled: 'Throttled',
  library_filter_full: 'Fully covered',

  // 分区标题（后端零配置派生的四个已知桶——sectionLabel.ts 认得的原文见该文件注释）。
  library_section_series: 'Series',
  library_section_anime: 'Anime',
  library_section_movie: 'Movies',
  library_section_other: 'Other',

  // 海报卡副行的媒体类型词。
  library_kind_series: 'series',
  library_kind_movie: 'movie',

  // 筛选后零结果（区别于"库本身是空的"）。
  library_filtered_empty_title: 'Nothing matches this filter',
  library_filtered_empty_desc: 'Try a different filter to see more of the library.',

  // 海报墙加载失败。
  library_error_prefix: "Couldn't load the library: ",
  library_retry: 'Retry',

  // 剧集页（SeriesPage）。
  library_detail_error_prefix: "Couldn't load this series: ",
  library_detail_not_found_title: 'Series not found',
  library_detail_not_found_desc: 'This series may have been removed from the library.',
  library_detail_layout_nonstandard: 'layout differs from TMDB canonical order',
  library_detail_canonical_pending: 'canonical catalog pending',
  library_detail_not_on_disk: 'not on disk',
  library_detail_no_subtitles: 'No subtitles found for this episode.',
  library_detail_next_recheck_prefix: 'next recheck in',
  library_detail_close_label: 'Close episode details',
  library_detail_file_heading: 'File',
  library_detail_subtitles_heading: 'Subtitles',

  // 格阵图例。
  library_legend_covered: 'covered',
  library_legend_missing: 'missing',
  library_legend_throttled: 'throttled',
  library_legend_dashed: 'not on disk',

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
