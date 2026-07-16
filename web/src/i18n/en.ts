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

  // Workflow 区永不本地化——本文件是这些键的唯一真源，zh.ts 直接引用，不重复翻译
  // （DESIGN.md §7）。带运行期数字/技术枚举值的动态文案（缺口计数、receipts 分布、四态回执
  // 句、trace 行的等宽工具名+耗时）故意不进这张表，走 web/src/workflow/text.ts 的纯函数——
  // 同 shell/freshness.ts 的既有先例：那些是技术读数，天生不需要翻译，也用不上 t() 不支持的
  // 插值。这里只收静态、不带运行期数据的 UI 文案（泳道头/空态/对话框/按钮）。
  workflow_empty_title: 'No active work',
  workflow_empty_desc: 'Pending passes and worker traces will show up here once the orchestrator has something to do.',

  workflow_lane_pending: 'Pending',
  workflow_lane_passes: 'Passes',
  workflow_lane_workers: 'Workers',

  workflow_pending_series_heading: 'Series',
  workflow_pending_movies_heading: 'Movies',
  workflow_pending_lane_empty: 'Nothing pending — the library is fully covered.',
  workflow_pending_rerun_label: 'Rerun',

  workflow_passes_lane_empty: 'No orchestrator passes yet.',
  workflow_passes_open_label: 'Open',

  workflow_workers_running_heading: 'Running',
  workflow_workers_recent_heading: 'Recent',
  workflow_workers_running_empty: 'No workers running right now.',
  workflow_workers_recent_empty: 'No recent completions yet.',

  workflow_rundetail_close_label: 'Close pass details',
  workflow_rundetail_detail_heading: 'Detail',
  workflow_rundetail_receipts_heading: 'Receipts',
  workflow_rundetail_replay_heading: 'Trace replay',
  workflow_rundetail_replay_empty: 'No trace events were captured for this pass.',
  workflow_rundetail_replay_error_prefix: "Couldn't load the trace replay: ",

  workflow_rerun_confirm_title: 'Rerun this series?',
  workflow_rerun_confirm_desc: 'This dispatches a find_subtitle task for the series.',
  workflow_rerun_include_throttled_label: 'Include throttled episodes',
  workflow_rerun_include_throttled_desc: 'Also include throttled episodes that would otherwise wait for their next recheck.',
  workflow_rerun_action_label: 'Rerun',
  workflow_rerun_error_prefix: "Couldn't dispatch this rerun: ",
  workflow_rerun_result_title: 'Rerun result',
  workflow_rerun_failed_title: 'Rerun failed',
  workflow_rerun_close_label: 'Close',

  workflow_outcome_created: 'created — a new task was dispatched.',
  workflow_outcome_revived: 'revived — a dormant task was reactivated.',
  workflow_outcome_coalesced: 'coalesced — merged into an in-flight task.',
  workflow_outcome_blocked_dormant: 'blocked — this series is dormant and was not dispatched.',

  workflow_mobile_feed_empty: 'No workflow activity yet.',

  // Triage tab 占位。
  triage_empty_title: 'Nothing parked',
  triage_empty_desc: 'Files the recognizer could not place with confidence will wait here for a manual claim.',

  // Settings tab 占位。
  settings_empty_title: 'Settings coming soon',
  settings_empty_desc: 'Media roots, target languages, and deploy info will live here.',
} as const
