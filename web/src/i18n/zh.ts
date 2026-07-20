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
  nav_logout: '登出',

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
  library_detail_files_heading: '文件清单',
  library_detail_subtitles_heading: '字幕',
  library_detail_hardsub_assumed: '已覆盖（硬字幕假定）',
  library_detail_embedded: '已覆盖 · 内嵌字幕（视频自带）',
  library_detail_main_file: '主文件',
  // 详情页重设计 item B（Phase 5）：hero + FactsRail + 季手风琴 + 逐集行内展开。
  library_detail_embedded_short: '内嵌',
  library_episode_no_overview: '暂无本集简介（TMDB 未提供）',
  library_facts_coverage: '覆盖',
  library_facts_embedded_unit: '集内嵌',

  library_legend_covered: '已覆盖',
  library_legend_hardsub: '硬字幕假定',
  library_legend_missing: '缺字幕',
  library_legend_throttled: '停牌中',
  library_legend_partial: '部分覆盖',
  library_legend_dashed: '磁盘无此文件',

  // Workflow 区永不本地化（用户裁决）：直接引用 en 值，禁止改成中文。
  workflow_empty_title: en.workflow_empty_title,
  workflow_empty_desc: en.workflow_empty_desc,

  workflow_lane_pending: en.workflow_lane_pending,
  workflow_lane_activity: en.workflow_lane_activity,

  workflow_pending_series_heading: en.workflow_pending_series_heading,
  workflow_pending_movies_heading: en.workflow_pending_movies_heading,
  workflow_pending_lane_empty: en.workflow_pending_lane_empty,
  workflow_pending_rerun_label: en.workflow_pending_rerun_label,

  workflow_passes_lane_empty: en.workflow_passes_lane_empty,
  workflow_passes_open_label: en.workflow_passes_open_label,
  workflow_orchestrator_log_heading: en.workflow_orchestrator_log_heading,

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

  triage_empty_title: '所有文件都已找到归属',
  triage_empty_desc: '暂时没有需要人工认领的文件——识别器已经确信地归位了每一个文件。',
  triage_error_prefix: '无法加载甄别队列：',
  triage_retry_label: '重试',

  triage_pending_heading: '待甄别',
  triage_claimed_heading: '已认领',
  triage_claimed_empty_title: '暂无认领记录',
  triage_claimed_empty_desc: '手动认领一个停车文件后，记录会出现在这里。',
  triage_claim_group_label: '认领',
  triage_claimed_badge: '已认领 · 等待重新扫描',
  // triage_duplicates_heading 已退役——见 en.ts 同位置注释。
  triage_excluded_heading: '已排除的特典',
  triage_excluded_restore_label: '恢复',
  triage_restore_error_prefix: '恢复失败：',
  triage_naming_hint_prefix: '正确命名可免人工甄别——最佳实践：',

  triage_type_tv: '剧集',
  triage_type_movie: '电影',

  triage_dialog_title: '认领此目录',
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
  triage_partial_failure_desc: '认领失败——详情见下方错误。',

  settings_behavior_heading: '行为',
  settings_deploy_heading: '部署',
  settings_roots_heading: '守备目录',

  settings_error_prefix: '无法加载设置：',
  settings_retry_label: '重试',

  settings_target_languages_label: '目标语言',
  settings_target_languages_description: '逗号分隔的 BCP-47 代码，如 "zh,en"。未设置时默认为 "zh"。',
  settings_target_languages_save_label: '保存',
  // 债务D5：target_languages 已提供者化，每轮 ingest pass 起点新鲜读取。
  settings_target_languages_restart_note: '下一轮扫描生效。',

  settings_hardsub_mode_label: '硬字幕假定',
  settings_hardsub_mode_option_off: '关闭',
  settings_hardsub_mode_option_agent: 'Agent 判断',
  settings_hardsub_mode_option_aggressive: '激进',
  settings_hardsub_mode_note: '下一次派发的字幕搜索任务生效。',
  settings_exclude_extras_label: '排除特典',
  // 救援R6：exclude_extras/hardsub_mode 已各自独立生效注记（R4c/R5e）——rescue-officer 战役
  // 全线收官，这条"尚未落地"占位注记已无消费点，随手清理，不留误导性文案。
  settings_exclude_extras_restart_note: '下一轮扫描生效。',

  settings_trace_retention_label: '痕迹保留天数',
  settings_trace_retention_note: '每日痕迹清理时生效。',
  settings_scan_interval_label: '扫描间隔（毫秒）',
  settings_scan_interval_note: '下一个守护进程心跳生效。',

  settings_save_error_prefix: '保存失败：',

  settings_deploy_readonly_note: '部署层配置，只读——如需修改请编辑环境变量或 compose 文件',
  settings_deploy_secrets_heading: '密钥',
  settings_deploy_nonsecrets_heading: '其它',
  settings_deploy_error_prefix: '无法加载部署信息：',
  // 技术状态词——同 Workflow 区 decision 词表的口径永不翻译（DESIGN.md §3/§4：圆点+同色词，
  // 状态词是技术值不是正文）。
  settings_deploy_present_word: en.settings_deploy_present_word,
  settings_deploy_absent_word: en.settings_deploy_absent_word,

  settings_roots_error_prefix: '无法加载守备目录：',
  settings_roots_retry_label: '重试',
  settings_roots_empty_hint: '尚无守备目录——请在下方浏览并添加第一个。',
  settings_roots_remove_label: '删除',
  settings_roots_add_button_label: '添加守备目录',
  settings_roots_remove_confirm_desc: '这将清除该目录下的全部索引行——剧集、电影、字幕记录与停车行。磁盘上的文件不会被改动。',
  settings_roots_remove_result_title: '守备目录已删除',
  settings_roots_remove_failed_title: '删除失败',
  settings_roots_remove_close_label: '关闭',
  settings_roots_remove_error_prefix: '无法删除该守备目录：',

  settings_dirbrowser_description: '浏览容器内可见的目录，选择要纳入扫描的那一个。',
  settings_dirbrowser_add_button: '添加此目录',
  settings_dirbrowser_add_success: '已加入，下一轮扫描将自动摄取。',
  settings_dirbrowser_add_error_prefix: '无法添加该目录：',
  settings_dirbrowser_empty: '这里没有子目录。',
  settings_dirbrowser_error_prefix: '无法列出该目录：',

  // ── 鉴权 A2/A3（setup 向导 / 登录 / Security 区）。 ──
  auth_username_label: '用户名',
  auth_password_label: '密码',
  auth_show_password: '显示密码',
  auth_hide_password: '隐藏密码',
  setup_heading: '创建管理员账号',
  setup_intro: '本实例为单管理员。凭据存储在本地；找回请走 CLI。',
  setup_confirm_label: '确认密码',
  setup_password_hint: '至少 10 个字符',
  setup_password_mismatch: '两次密码不一致',
  setup_submit: '创建账号',
  setup_submitting: '创建中…',
  setup_apikey_heading: '你的 API key',
  setup_apikey_notice: '仅此一次完整显示。此后设置页只显示末 4 位，你可以在那里随时复制或重新生成。',
  setup_apikey_copy: '复制',
  setup_apikey_copied: '已复制',
  setup_enter_label: '进入仪表盘',
  login_heading: '登录',
  login_submit: '登录',
  login_submitting: '登录中…',
  login_error_invalid: '用户名或密码不正确。',
  login_error_transport: '无法连接服务器。',
  login_forgot_prefix: '被锁在门外？用 CLI 重置：',
  auth_connection_error_heading: '无法连接服务器',
  auth_connection_error_desc: '监控页无法连接到服务器。请确认服务正在运行，然后重试。',
  auth_retry: '重试',
  settings_security_heading: '安全',
  settings_security_loading: '加载中…',
  settings_security_error_prefix: '无法加载安全设置：',
  settings_security_username_label: '管理员用户名',
  settings_security_apikey_label: 'API key',
  settings_security_copy: '复制',
  settings_security_copied: '已复制',
  settings_security_regenerate: '重新生成',
  settings_security_regen_confirm:
    '重新生成 API key？当前 key 会立即失效，任何正在使用它的客户端都将失败，直到更新为新 key。',
  settings_security_current_password: '当前密码',
  settings_security_new_password: '新密码',
  settings_security_change_button: '修改密码',
  settings_security_change_success: '密码已更新。',
  settings_security_password_hint: '至少 10 个字符',
} as const
