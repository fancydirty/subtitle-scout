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

  // 验收修复轮一 Task V4（design §B）：三泳道→两列重排，Gaps | Activity。workflow_lane_pending
  // 键名不变（PendingLane 组件/测试仍叫 pending），显示文案改"Gaps"——泳道标题改名，不是重命名
  // 概念。workflow_lane_passes/workflow_lane_workers 随三泳道布局一起废弃（Passes/Workers 折进
  // ActivityFeed，不再各自有一条独立泳道标题）。
  workflow_lane_pending: 'Gaps',
  workflow_lane_activity: 'Activity',

  workflow_pending_series_heading: 'Series',
  workflow_pending_movies_heading: 'Movies',
  workflow_pending_lane_empty: 'Nothing pending — the library is fully covered.',
  workflow_pending_rerun_label: 'Rerun',

  workflow_passes_lane_empty: 'No orchestrator passes yet.',
  workflow_passes_open_label: 'Open',
  // Orchestrator log 折叠区（design §B）：原三泳道之一的 Passes，现降级为 Activity 列底部默认
  // 收起的 Collapsible——回执 chip 只在展开后可见，工程师内容零删除。
  workflow_orchestrator_log_heading: 'Orchestrator log',

  // "Now working" 即原 Running 泳道小标题——改名对齐 design §B 的叙事称呼（Now working 卡）。
  workflow_workers_running_heading: 'Now working',
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

  // Triage tab（甄别，dashboard-F5）——正常双语区（DESIGN.md §7 只豁免 Workflow 区）。
  // 待甄别箱空态是好消息——"identifier 全部归位"方向写，不是"这里本来会显示什么"式说明
  // （triage_empty_title/desc 这两个键最早是 F2 占位期借用的，F5 填肉后原样留作真实空态用，
  // 同 library_empty_title 在 F3 落地时的既有先例）。
  triage_empty_title: 'Every file found its identifier',
  triage_empty_desc: 'Nothing needs a manual claim right now — the recognizer placed every file with confidence.',
  triage_error_prefix: "Couldn't load the triage queue: ",
  triage_retry_label: 'Retry',

  triage_pending_heading: 'Pending',
  triage_claimed_heading: 'Claimed',
  triage_claimed_empty_title: 'No claims yet',
  triage_claimed_empty_desc: 'Manual claims will show up here once you resolve a parked file.',
  // 验收修复轮一 Task V2：PendingBox 从逐行 checkbox 多选改成目录组卡——这个键是每张组卡上的
  // Claim 按钮（挂在整个目录组上，见 PendingBox.tsx 文件头注释），不再是箱头的"批量认领所选"。
  triage_claim_group_label: 'Claim',
  // 认领后的置灰过渡态角标——认领只写 override，parked_paths 那一行要等下一轮 ingest pass 才
  // 真的退户口（TriagePage.tsx claimedDirs 注释），这条文案如实说明"已经点过认领，正在等扫描"，
  // 不假装文件已经消失。
  triage_claimed_badge: 'claimed · awaiting rescan',
  // duplicate-content 停车行的说明——归重复源战役本体（字幕自动同步）尚未落地，这类行不需要
  // 人工认领，用户点名要求跟"待人工认领"分开成组、别再吓人（spec §C.3）。
  triage_duplicates_heading: 'Duplicates — subtitle propagation is planned; no action needed',
  triage_excluded_heading: 'Excluded extras',
  triage_excluded_restore_label: 'Restore',
  // 改名指引——README 命名最佳实践同文（docs/design 的 dashboard 重建设计 §6）。路径形状本身
  // 是技术值，组件层拼接成 mono 片段，不进这条 i18n 文案（DESIGN.md §3：mono 是技术层专属声音）。
  triage_naming_hint_prefix: 'Correct naming skips manual triage — best practice: ',

  triage_type_tv: 'TV',
  triage_type_movie: 'Movie',

  triage_dialog_title: 'Claim this folder',
  triage_search_placeholder: 'Search TMDB…',
  triage_search_unreachable: 'TMDB unreachable — you can still paste a tmdb id',
  triage_search_no_results: 'No matches',
  triage_tmdbid_label: 'TMDB ID',
  triage_season_label: 'Season',
  triage_season_placeholder: 'auto',
  triage_submit_label: 'Claim',
  triage_cancel_label: 'Cancel',
  triage_close_label: 'Close',
  triage_results_heading: 'Results',
  triage_partial_failure_desc: 'This claim failed — see the error below.',

  // Settings tab（dashboard-F6）——正常双语区（DESIGN.md §7 只豁免 Workflow 区）。F2 占位期的
  // settings_empty_title/desc（"coming soon"）随 F6 落地真内容一并退役——不像 triage_empty_*
  // 那样有一个"真的空"的状态可以复用这段文案，四 tab 占位就此全部清空
  // （shell/PlaceholderTab.tsx 同步删除，见该文件退役时的 git 记录）。
  settings_behavior_heading: 'Behavior',
  settings_deploy_heading: 'Deploy',
  settings_roots_heading: 'Media roots',

  settings_error_prefix: "Couldn't load settings: ",
  settings_retry_label: 'Retry',

  // 行为区（BehaviorSection）——五项，逐项改动即时单键 PUT。
  settings_target_languages_label: 'Target languages',
  settings_target_languages_description: 'Comma-separated BCP-47 codes, e.g. "zh,en". Unset defaults to "zh".',
  settings_target_languages_save_label: 'Save',
  // 债务D5：target_languages 已提供者化，每轮 ingest pass 起点新鲜读取。
  settings_target_languages_restart_note:
    'Takes effect on the next library scan.',

  settings_hardsub_mode_label: 'Hardsub assumption',
  settings_hardsub_mode_option_off: 'Off',
  settings_hardsub_mode_option_agent: 'Agent',
  settings_hardsub_mode_option_aggressive: 'Aggressive',
  settings_exclude_extras_label: 'Exclude extras',
  // 救援R4c：exclude_extras 已被 ingest 消费，独立"下一轮扫描生效"注记（hardsub_mode 仍共用救援官注记）。
  settings_exclude_extras_restart_note: 'Takes effect on the next library scan.',
  // hardsub_mode 仍共用同一句诚实注记：执行逻辑尚未落地（spec §9 立项登记：救援官战役）。
  settings_rescue_officer_pending_note:
    'Saved, but the execution logic ships with the rescue-officer campaign — not consumed yet.',

  settings_trace_retention_label: 'Trace retention (days)',
  settings_trace_retention_note: 'Takes effect at the daily trace cleanup.',
  settings_scan_interval_label: 'Scan interval (ms)',
  settings_scan_interval_note: 'Takes effect on the next daemon tick.',

  settings_save_error_prefix: "Couldn't save: ",

  // 部署区（DeploySection，只读）——env 脱敏展示，零输入控件。
  settings_deploy_readonly_note: 'deploy-level, read-only — edit via environment/compose',
  settings_deploy_secrets_heading: 'Secrets',
  settings_deploy_nonsecrets_heading: 'Other',
  settings_deploy_error_prefix: "Couldn't load deploy info: ",
  settings_deploy_present_word: 'configured',
  settings_deploy_absent_word: 'not set',

  // 守备目录管理器（RootsManager）。
  settings_roots_error_prefix: "Couldn't load media roots: ",
  settings_roots_retry_label: 'Retry',
  settings_roots_empty_hint: 'No media roots yet — browse below to add the first one.',
  settings_roots_remove_label: 'Remove',
  settings_roots_add_button_label: 'Add a root',
  // 删根 AlertDialog——destructive 才用 AlertDialog（DESIGN.md §5），文案明示后果。
  settings_roots_remove_confirm_desc:
    'This clears every indexed row under this root — episodes, movies, subtitle records, and parked entries. Files on disk are not touched.',
  settings_roots_remove_result_title: 'Media root removed',
  settings_roots_remove_failed_title: 'Could not remove this root',
  settings_roots_remove_close_label: 'Close',
  settings_roots_remove_error_prefix: "Couldn't remove this root: ",

  // 目录浏览器（DirBrowser）——加根流程。
  settings_dirbrowser_description: 'Browse directories visible to the container and add the one you want scanned.',
  settings_dirbrowser_add_button: 'Add this directory',
  // 后端 roots 已动态化——加根即刻生效于下一轮巡检，这句是真的（不是"假装即时生效"）。
  settings_dirbrowser_add_success: 'Added — the next scan will pick it up automatically.',
  settings_dirbrowser_add_error_prefix: "Couldn't add this directory: ",
  settings_dirbrowser_empty: 'No subdirectories here.',
  settings_dirbrowser_error_prefix: "Couldn't list this directory: ",
} as const
