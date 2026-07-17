// web/src/i18n/zh.ts：扁平 key 表，中文。workflow_* 键直接引用 en 的值——这是代码层面强制的
// "Workflow 区永不本地化"裁决（DESIGN.md §7，用户裁决），不是漏翻译，不许在这里手写中文替换掉它。
import { en } from './en.js'

export const zh = {
  // Triage 的中文=甄别（用户钦定，DESIGN.md §7）。Workflow 沿用视觉基准
  // full-design-v2.html 里的"工作流"（外壳导航标签，不属于"Workflow 区"内容本身）。
  nav_library: '媒体库',
  nav_workflow: '工作流',
  nav_triage: '甄别',
  nav_settings: '设置',

  cmdk_trigger: '搜索',
  cmdk_label: '命令面板',
  cmdk_placeholder: '跳转到页面…',
  cmdk_empty: '无匹配',

  library_empty_title: '媒体库暂无内容',
  library_empty_desc: '扫描媒体根目录后，剧集与电影会出现在这里。',

  library_filter_all: '全部',
  library_filter_gap: '有缺口',
  library_filter_throttled: '停牌中',
  library_filter_full: '全覆盖',

  library_section_series: '剧集',
  library_section_anime: '动漫',
  library_section_movie: '电影',
  library_section_other: '其他',

  library_kind_series: '剧集',
  library_kind_movie: '电影',

  library_filtered_empty_title: '这个筛选下暂时没有条目',
  library_filtered_empty_desc: '换一个筛选条件看看库里的其它内容。',

  library_error_prefix: '无法加载媒体库：',
  library_retry: '重试',

  library_detail_error_prefix: '无法加载这部剧：',
  library_detail_not_found_title: '未找到该剧集',
  library_detail_not_found_desc: '这部剧可能已从库中移除。',
  library_detail_layout_nonstandard: '目录结构与 TMDB 标准顺序不同',
  library_detail_canonical_pending: '应有集目录尚未缓存',
  library_detail_not_on_disk: '磁盘无此文件',
  library_detail_no_subtitles: '这一集暂无字幕。',
  library_detail_next_recheck_prefix: '预计复查',
  library_detail_close_label: '关闭单集详情',
  library_detail_file_heading: '文件',
  library_detail_subtitles_heading: '字幕',

  library_legend_covered: '已覆盖',
  library_legend_missing: '缺字幕',
  library_legend_throttled: '停牌中',
  library_legend_dashed: '磁盘无此文件',

  // Workflow 区永不本地化（用户裁决）：直接引用 en 值，禁止改成中文。
  workflow_empty_title: en.workflow_empty_title,
  workflow_empty_desc: en.workflow_empty_desc,

  workflow_lane_pending: en.workflow_lane_pending,
  workflow_lane_passes: en.workflow_lane_passes,
  workflow_lane_workers: en.workflow_lane_workers,

  workflow_pending_series_heading: en.workflow_pending_series_heading,
  workflow_pending_movies_heading: en.workflow_pending_movies_heading,
  workflow_pending_lane_empty: en.workflow_pending_lane_empty,
  workflow_pending_rerun_label: en.workflow_pending_rerun_label,

  workflow_passes_lane_empty: en.workflow_passes_lane_empty,
  workflow_passes_open_label: en.workflow_passes_open_label,

  workflow_workers_running_heading: en.workflow_workers_running_heading,
  workflow_workers_recent_heading: en.workflow_workers_recent_heading,
  workflow_workers_running_empty: en.workflow_workers_running_empty,
  workflow_workers_recent_empty: en.workflow_workers_recent_empty,

  workflow_rundetail_close_label: en.workflow_rundetail_close_label,
  workflow_rundetail_detail_heading: en.workflow_rundetail_detail_heading,
  workflow_rundetail_receipts_heading: en.workflow_rundetail_receipts_heading,
  workflow_rundetail_replay_heading: en.workflow_rundetail_replay_heading,
  workflow_rundetail_replay_empty: en.workflow_rundetail_replay_empty,
  workflow_rundetail_replay_error_prefix: en.workflow_rundetail_replay_error_prefix,

  workflow_rerun_confirm_title: en.workflow_rerun_confirm_title,
  workflow_rerun_confirm_desc: en.workflow_rerun_confirm_desc,
  workflow_rerun_include_throttled_label: en.workflow_rerun_include_throttled_label,
  workflow_rerun_include_throttled_desc: en.workflow_rerun_include_throttled_desc,
  workflow_rerun_action_label: en.workflow_rerun_action_label,
  workflow_rerun_error_prefix: en.workflow_rerun_error_prefix,
  workflow_rerun_result_title: en.workflow_rerun_result_title,
  workflow_rerun_failed_title: en.workflow_rerun_failed_title,
  workflow_rerun_close_label: en.workflow_rerun_close_label,

  workflow_outcome_created: en.workflow_outcome_created,
  workflow_outcome_revived: en.workflow_outcome_revived,
  workflow_outcome_coalesced: en.workflow_outcome_coalesced,
  workflow_outcome_blocked_dormant: en.workflow_outcome_blocked_dormant,

  workflow_mobile_feed_empty: en.workflow_mobile_feed_empty,

  triage_empty_title: '所有文件都已找到归属',
  triage_empty_desc: '暂时没有需要人工认领的文件——识别器已经确信地归位了每一个文件。',
  triage_error_prefix: '无法加载甄别队列：',
  triage_retry_label: '重试',

  triage_pending_heading: '待甄别',
  triage_claimed_heading: '已认领',
  triage_claimed_empty_title: '暂无认领记录',
  triage_claimed_empty_desc: '手动认领一个停车文件后，记录会出现在这里。',
  triage_claim_selected_label: '认领所选',
  triage_naming_hint_prefix: '正确命名可免人工甄别——最佳实践：',

  triage_type_tv: '剧集',
  triage_type_movie: '电影',

  triage_dialog_title: '认领所选文件',
  triage_search_placeholder: '搜索 TMDB…',
  triage_search_unreachable: '无法连接 TMDB——你仍可以手动填写 tmdb id',
  triage_search_no_results: '无匹配结果',
  triage_tmdbid_label: 'TMDB ID',
  triage_season_label: '季',
  triage_season_placeholder: 'auto',
  triage_submit_label: '认领',
  triage_cancel_label: '取消',
  triage_close_label: '关闭',
  triage_results_heading: '结果',
  triage_partial_failure_desc: '部分认领失败——请查看下方结果。',

  settings_empty_title: '设置页即将上线',
  settings_empty_desc: '媒体根目录、目标语言与部署信息将会集中呈现在这里。',
} as const
