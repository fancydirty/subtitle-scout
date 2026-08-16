// web/src/i18n/zh.ts：扁平 key 表，中文。workflow_* 键直接引用 en 的值——这是代码层面强制的
// "Workflow 区永不本地化"裁决（DESIGN.md §7，用户裁决），不是漏翻译，不许在这里手写中文替换掉它。
import { en } from './en.js'

export const zh = {
  // Workflow 沿用视觉基准
  // full-design-v2.html 里的"工作流"（外壳导航标签，不属于"Workflow 区"内容本身）。
  //
  // 2026-08-12（Task ⑦）：新导航四项。中文名取用户在 FRONTEND-SPEC §二 里的原话
  //（"活动页 / 通知页 / 媒体库页"），去掉"页"字做导航标签。
  // ⚠️ nav_media 与 nav_library 的中文都是"媒体库"——**不是笔误**：新媒体库页（#/media）
  // 就是要取代旧海报墙（#/library）的位置，只是本 task 只建占位壳。两者不会同时出现在
  // 侧栏（TABS 里只有 media），所以用户看不到重名。nav_library 随 Task ⑪ 一起删。
  brand_name: '字幕助手',
  nav_activity: '活动',
  nav_notifications: '通知',
  nav_media: '媒体库',
  nav_library: '媒体库',
  nav_workflow: '工作流',
  // nav_triage（'甄别'，中文名用户钦定 DESIGN.md §7）随甄别页下架移除（spec §5，2026-08-07）。
  nav_settings: '设置',
  nav_logout: '登出',

  // 通用 chrome（审计 P0-4）：与 en.ts 同键。
  common_cancel: '取消',
  common_save: '保存',
  common_clear: '清除',
  common_confirm: '确认',
  common_loading: '加载中…',

  // 外壳无障碍名与状态词（审计 P0-4/P1-0）。
  a11y_side_nav: '侧边导航',
  a11y_breadcrumb: '面包屑',
  a11y_dialog_close: '关闭',
  a11y_skip_to_content: '跳到主要内容',
  a11y_loading_media_library: '正在加载媒体库',
  a11y_loading_media_detail: '正在加载媒体详情',
  a11y_loading_notifications: '正在加载通知',

  // Task ⑦ 占位页（Task ⑧⑩ 填肉后**只剩活动一个**）。中文取用户在 FRONTEND-SPEC §二 里的原话口径。
  placeholder_under_construction: '施工中',

  // 页级错误边界降级文案（对应 en.ts 同名三键，措辞纪律见那边注释）。
  page_failed_title: '这一页出了点问题',
  page_failed_desc: '这一页里有内容没能显示出来。你的数据没有被改动，其他页面照常可用——可以重新加载这一页，或者从侧栏切到别的页面。',
  page_failed_retry: '重新加载这一页',


  library_empty_title: '媒体库暂无内容',
  library_empty_desc: '扫描媒体根目录后，剧集与电影会出现在这里。',

  library_filter_all: '全部',
  library_filter_gap: '有缺口',
  library_filter_throttled: '停牌中',
  library_filter_full: '全覆盖',


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
  library_detail_not_on_disk: '磁盘无此文件',
  library_detail_no_subtitles: '这一集暂无字幕。',
  library_detail_close_label: '关闭单集详情',
  library_detail_file_heading: '文件',
  library_detail_files_heading: '文件清单',
  library_detail_subtitles_heading: '字幕',
  library_detail_hardsub_assumed: '已覆盖（硬字幕假定）',
  library_detail_embedded: '已覆盖 · 内嵌字幕（视频自带）',
  library_detail_main_file: '主文件',
  // 详情页重设计 item B（Phase 5）：hero + FactsRail + 季手风琴 + 逐集行内展开。
  // library_verify_inspect（'看字幕时间轴'）随字幕校验渲染点下架移除（spec §5，2026-08-07）。
  verify_track_reference: '画面里说话',
  verify_track_reference_sub: '参考',
  verify_track_ours: '这份字幕',
  verify_track_ours_sub: '待校正',
  verify_track_audio: '声音',
  verify_timeline_hint: '滚轮缩放 · 拖拽平移',
  verify_inspect_failed: '这个对照面板没能显示出来。磁盘上的文件没有被改动。',
  verify_inspect_loading: '正在读取…',
  verify_verdict_behind_head: '字幕比画面慢了一点',
  verify_verdict_behind_body: '整段偏得一样多，把整条时间轴挪一下就能对上。通常是因为这份字幕按另一个版本的片源做的。',
  verify_verdict_ahead_head: '字幕比画面快了一点',
  verify_verdict_ahead_body: '台词都提前出来了，而且整段早得一样多，把整条时间轴挪一下就能对上。通常是因为这份字幕按另一个版本的片源做的。',
  verify_verdict_drift_head: '越往后偏得越多',
  verify_verdict_drift_body: '开头还对得上，越往后差得越远——整体挪动修不好这种。需要换一份按你这个文件做的字幕。',
  verify_verdict_unknown_head: '这里看不出问题在哪',
  verify_verdict_unknown_body: '可比对的东西不够，所以不下结论。可以看看下面的台词，确认是这一集的内容。',
  verify_verdict_noref_head: '没有可以对比的东西',
  verify_verdict_noref_body: '这个片源只带图片式字幕（读不出时间），旁边也没有这一集的第二份字幕。下面仍然显示你这份字幕的分布——放一下这集，看看台词跟画面对不对得上。',
  verify_correct_action: '校正时间轴',
  verify_correcting: '正在校正…',
  verify_keep_action: '保留原样',
  verify_got_it: '知道了',
  verify_cues_heading: '字幕内容',
  verify_cloud_title: '网盘上的文件没法做对照',
  verify_cloud_body: '读一小段都要等十几秒，画不出时间轴。其余功能照常。',
  verify_cloud_blind_fix: '仍然可以直接校正，只是没有图可看。',

  library_legend_covered: '已覆盖',
  library_legend_hardsub: '硬字幕假定',
  library_legend_missing: '缺字幕',
  library_legend_throttled: '停牌中',
  library_legend_partial: '部分覆盖',
  library_legend_dashed: '磁盘无此文件',

  // Workflow 区永不本地化（用户裁决）：直接引用 en 值，禁止改成中文。
  workflow_pending_rerun_label: en.workflow_pending_rerun_label,

  workflow_rundetail_close_label: en.workflow_rundetail_close_label,
  workflow_rundetail_detail_heading: en.workflow_rundetail_detail_heading,
  workflow_rundetail_receipts_heading: en.workflow_rundetail_receipts_heading,
  workflow_rundetail_replay_heading: en.workflow_rundetail_replay_heading,
  workflow_rundetail_replay_empty: en.workflow_rundetail_replay_empty,
  workflow_rundetail_replay_error_prefix: en.workflow_rundetail_replay_error_prefix,

  workflow_rerun_include_throttled_label: en.workflow_rerun_include_throttled_label,


  triage_empty_title: '所有文件都已找到归属',
  // 认领退役（2026-07-28 两证据红线裁决）：空态文案不再提"人工认领"——正确的修复动作是改文件名。
  triage_empty_desc: '暂时没有等待识别的文件。（这不等于识别都对了——字幕 agent 每次开工前还会核验一遍身份，纠正结果见时间线。）',
  triage_error_prefix: '无法加载甄别队列：',
  triage_retry_label: '重试',

  triage_pending_heading: '待甄别',
  // 页头两键（§5.5/§5.7，Task 22）——副标题定调：parked 不是错误，不挡自动流程。
  triage_page_title: '甄别',
  triage_subtitle: '系统拿不准、宁可停放也不瞎猜的文件。这里的东西都不挡自动流程。',
  // 认领一族键已随认领退役整体删除——见 en.ts 同位置注释。
  triage_excluded_heading: '已排除的特典',
  triage_excluded_restore_label: '恢复',
  triage_restore_error_prefix: '恢复失败：',
  // Timing looks off 区两键——见 en.ts 同位置注释。
  triage_timing_heading: '时间轴对不上',
  triage_timing_undo: '撤销',
  // Dormant tasks 区一键——见 en.ts 同位置注释。
  triage_dormant_heading: '停摆任务',
  triage_naming_hint_prefix: '正确命名可免人工甄别——最佳实践：',


  settings_behavior_heading: '行为',
  settings_roots_heading: '媒体目录',

  settings_error_prefix: '无法加载设置：',
  settings_retry_label: '重试',

  // ── Settings tab chrome（审计 P0-1/P0-3）───────────────────────────────
  settings_tab_general: '通用',
  settings_tab_providers: '字幕源',
  settings_tab_media: '媒体目录',
  settings_tab_security: '安全',
  settings_status_configured: '✓ 已配置',
  settings_status_unconfigured: '⚠ 未配置',

  settings_target_languages_label: '目标字幕语言',
  settings_target_languages_description: '要搜索和下载的字幕语言。未设置时默认为中文。',
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
  settings_scan_interval_label: '扫描间隔（分钟）',
  settings_scan_interval_note: '保存后，下一轮扫描生效。',

  settings_save_error_prefix: '保存失败：',

  // 审计四轮 R4：MEDIA_ROOTS 只是首启种子，真正生效的是 media_roots 表（本页守备目录区）
  // 技术状态词——同 Workflow 区 decision 词表的口径永不翻译（DESIGN.md §3/§4：圆点+同色词，
  // 状态词是技术值不是正文）。

  settings_roots_error_prefix: '无法加载守备目录：',
  settings_roots_retry_label: '重试',
  settings_roots_empty_hint: '还没有媒体目录——在下面输入路径添加第一个。',
  settings_roots_remove_label: '删除',
  settings_roots_add_button_label: '添加媒体目录',
  settings_roots_add_path_label: '媒体目录路径',
  settings_roots_add_path_placeholder: '输入宿主机上的媒体目录绝对路径，例如 /Users/me/Movies',
  settings_roots_add_error_prefix: '无法添加该目录：',
  settings_roots_add_success: '已加入，下一轮扫描将自动摄取。',
  settings_roots_remove_confirm_desc: '这将清除该目录下的全部索引行——剧集、电影、字幕记录与停车行。磁盘上的文件不会被改动。',
  settings_roots_remove_result_title: '守备目录已删除',
  settings_roots_remove_failed_title: '删除失败',
  settings_roots_remove_close_label: '关闭',
  settings_roots_remove_error_prefix: '无法删除该守备目录：',


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
  login_error_throttled: '尝试次数过多，请一分钟后再试。',
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
  // ---------- Spec A 启动面（wizard_* 区双写，§5.3） ----------
  wizard_back: '上一步',
  wizard_continue: '继续',
  wizard_save_continue: '保存并继续',
  wizard_skip_step: '跳过此步',
  wizard_test: '测试',
  wizard_testing: '测试中…',
  wizard_test_passed: '连接成功',
  wizard_test_failed: '连接失败',
  wizard_test_unavailable: '测试服务不可用，请重试',
  wizard_launch: '启动',
  wizard_env_locked: '已配置',
  wizard_retest: '重新测试',

  wizard_step_language_title: '字幕语言',
  wizard_step_language_desc: 'Scout 要抓哪些语言的字幕？首选语言同时决定界面语言。',
  wizard_step_tmdb_title: 'TMDB',
  wizard_step_tmdb_desc: 'Scout 用 TMDB 识别你的剧集与电影。',
  wizard_step_llm_title: '语言模型',
  wizard_step_llm_desc: '驱动字幕搜索决策与 zimuku 验证码求解。',
  wizard_step_providers_title: '字幕源',
  wizard_step_providers_desc: '可选——来源越多，命中率越高。',
  wizard_step_free_title: '免费源',
  wizard_step_free_desc: '内置，无需账号。',
  wizard_step_roots_title: '守备目录',
  wizard_step_roots_desc: 'Scout 看守的目录。',
  wizard_step_launch_title: '点火',
  wizard_step_launch_desc: '确认配置，点火发动。',

  wizard_language_custom_placeholder: '添加其他——如 fr、pt-BR',
  wizard_language_add: '添加',
  wizard_language_invalid: '请输入 BCP-47 代码，如 "fr" 或 "pt-BR"。',

  wizard_tmdb_label: 'API 密钥',
  wizard_tmdb_placeholder: 'TMDB API key 或 read access token',
  wizard_tmdb_hint: '在 themoviedb.org → Settings → API 免费申请。没有 key 就没有 Scout——此步不可跳过。',

  wizard_llm_base_label: 'Base URL',
  wizard_llm_base_hint: '通常以 /v1 结尾。',
  wizard_llm_key_label: 'API 密钥',
  wizard_llm_model_label: '模型',
  wizard_llm_model_placeholder: '模型名，按服务商的叫法',
  wizard_llm_required_note: '搜索决策与 zimuku 验证码求解需要可用的模型——此步不可跳过。',

  wizard_providers_banner: 'subhd 与 zimuku 是内置免费源，始终保持兜底。',
  wizard_assrt_label: 'ASSRT token',
  wizard_os_apikey_label: 'OpenSubtitles API key',
  wizard_os_user_label: 'OpenSubtitles 用户名（可选）',
  wizard_os_pass_label: 'OpenSubtitles 密码（可选）',
  wizard_jimaku_label: 'Jimaku API key',
  wizard_consequence_assrt: '没有 ASSRT，少一个字幕来源。',
  wizard_consequence_os: '没有 OpenSubtitles，少一个字幕来源。',
  wizard_consequence_jimaku: '没有 Jimaku，少一个字幕来源。',
  wizard_providers_save_note: '只有测试通过的密钥才会保存。',

  wizard_subhd_label: 'subhd',
  wizard_zimuku_label: 'zimuku',
  wizard_free_reach_checking: '检查可达性…',
  wizard_free_reach_ok: '可达',
  wizard_free_reach_fail: '不可达——保持开启，运行时自动重试。',
  wizard_zimuku_captcha_ready: '验证码求解：就绪（LLM 已配置）',
  wizard_zimuku_captcha_not_ready: '验证码求解需要第 3 步的 LLM。',

  wizard_roots_skip_note: '添加媒体目录前媒体库为空——之后可以在设置里加。',

  wizard_launch_configured: '已配置',
  wizard_launch_skipped: '已跳过',
  wizard_launch_engine_label: '发动机',
  wizard_launch_engine_desc: '启动后立即开始扫描与抓取。',

  // ── 全局 banner（四页共用）。两种成因分开说（终局审计 🟡-4）────────────────
  // 措辞纪律同 en 侧：两句对应的下一步动作完全相反（拨开关 / 去填 key），
  // setup 那一档的按钮必须是"去设置"而不是"开启"——后者点了会成功、banner 会变，
  // 而 daemon 照样一动不动。
  engine_banner_off: '发动机已关——轮询与派发暂停。',
  engine_banner_turn_on: '开启',
  engine_banner_setup: '还没配好——TMDB 与 LLM 的凭据填上之前，什么都不会被处理。',
  engine_banner_go_setup: '去设置',

  settings_engine_label: '发动机',
  settings_engine_desc: '扫描、抓取与一切自动工作的总开关。',
  settings_provider_enable_label: '启用 {name}',
  settings_provider_no_api_key_note: '无需 API key，开箱即用',
  settings_free_source_description: '中文源',
  settings_provider_not_set: '未设置',
  settings_provider_readonly_note: '此处不可修改',
  settings_provider_edit: '编辑',
  settings_provider_save: '保存',
  settings_provider_cancel: '取消',
  settings_provider_test: '测试',
  settings_provider_last_test_ok: '上次测试通过',
  // 密钥的人话标签（审计 P0-5）——设置页不再直接显示 env 变量名。
  secret_tmdb_api_key: 'TMDB API 密钥',
  secret_assrt_token: 'ASSRT token',
  secret_opensubtitles_api_key: 'OpenSubtitles API 密钥',
  secret_opensubtitles_username: 'OpenSubtitles 用户名',
  secret_opensubtitles_password: 'OpenSubtitles 密码',
  secret_jimaku_api_key: 'Jimaku API 密钥',
  secret_translate_base_url: '接口地址',
  secret_translate_api_key: 'API 密钥',
  secret_translate_model: '模型',
  settings_provider_last_test_fail: '上次测试失败',
  // 配额耗尽（设置页 ProviderCard）——"为什么 assrt 不找了"的答案。
  // 双通道（Carbon）：句子本身把话说全，空心标记承担形状差异，颜色只是第三重。
  settings_provider_quota_exhausted: '配额已耗尽——此源当前不可用',
  settings_provider_quota_resets_in: '恢复于',
  // 🔴 resetAt=null 表示我们**不知道**何时恢复。如实说，绝不猜一个时间。
  settings_provider_quota_reset_unknown: '恢复时间未知',
  settings_provider_quota_observed: '观测于',
  settings_provider_quota_ago_suffix: '前',

  // zimuku 视觉兜底卡片
  settings_zimuku_vision_heading: 'zimuku 视觉兜底（可选）',
  settings_zimuku_vision_description: '模板匹配已能处理绝大多数验证码，无需 LLM。这里配置的视觉模型仅在模板未命中时作为兜底（罕见）。不配置 = 纯模板模式。',
  settings_zimuku_vision_model_label: '视觉模型',
  settings_zimuku_vision_base_url_label: '视觉 API 地址',
  settings_zimuku_vision_api_key_label: '视觉 API 密钥',
  settings_zimuku_vision_test_label: '测试视觉能力',
  settings_zimuku_vision_testing: '测试中…',
  settings_zimuku_vision_test_ok: '具备视觉能力 — 能识别图片中的数字',
  settings_zimuku_vision_test_fail: '非视觉模型 — 无法识别测试图片',
  settings_zimuku_vision_clear_confirm_title: '清除视觉兜底配置？',
  settings_zimuku_vision_clear_confirm_body: '模板匹配依然有效。视觉 LLM 仅在模板未命中时调用（罕见情况）。',
  settings_zimuku_vision_clear_action: '清除',

  // AI 翻译卡（TranslateCard，审计 P0-2）——本卡曾整卡英文。
  settings_translate_card_title: 'AI 字幕翻译',
  settings_translate_card_description: '找不到字幕时自动翻译',
  settings_translate_enable_label: '启用 AI 字幕翻译',
  settings_translate_quota_note: '会消耗 LLM 配额',
  settings_translate_model_label: '模型',
  settings_translate_model_default: '跟随默认 LLM',
  settings_translate_model_dedicated: '专用模型',
  settings_translate_current_model_prefix: '当前：',
  settings_translate_shared_with_agent: '与 agent 共用',
  settings_translate_all_fields_required: '三个字段都必须填写',
  settings_translate_badge_off: '关闭',
  settings_translate_badge_enabled: '✓ 已开启',
  settings_translate_badge_dedicated: '✓ 专用模型',
  settings_translate_badge_incomplete: '⚠ 未配完整',
  settings_translate_dedicated_confirm_title: '切回默认模型？',
  settings_translate_dedicated_confirm_body: '这会清除专用模型配置。确定吗？',

  settings_system_rerun_wizard: '重跑设置向导',
  settings_system_rerun_wizard_desc: '重新走一遍启动配置。环境变量配置的步骤保持锁定。',

  // ── Task ⑧ 媒体库页（#/media）────────────────────────────────────────────
  media_result_count_prefix: '作品',
  media_card_subtitled: '已下载字幕',
  /** 🔴 2026-08-14 用户裁决③：内嵌轨与外挂字幕分列。「自带」而不是「内嵌」——
   *  用户不需要知道"内嵌轨"是什么技术概念，他要知道的是这几集**片源本来就带**、
   *  系统没为它做过事。与「已配」（我们找来装上的）构成对照。 */
  media_card_embedded: '自带字幕',
  media_card_ondisk: '本地文件',
  
  // 🟡-3：缺集数。「缺 12」——不写"集"字：电影恒 0（不渲染），剧集这一行紧挨着
  // 上面那三个同为集数的读数，量纲无歧义。
  media_card_missing: '还缺',
  media_card_missing_unit: '集',
  // 🔴 2026-08-13：进不了季集网格的文件（特典居多）。措辞与详情页的
  // media_unplaced_prefix 同族但更短（卡片一行），且不提 season/episode 这类内部词。
  media_card_unplaced: '{n} 个文件没归入季集',
  media_empty_title: '库里还什么都没有',
  media_empty_desc: '守备目录扫描完成后，作品会出现在这里。',
  media_error_title: '没能加载媒体库',
  media_retry: '重试',
  media_back: '← 媒体库',
  media_season_prefix: '第',
  media_season_missing: '缺',
  media_movie_heading: '电影',
  media_legend_label: '集号状态图例',
  media_unplaced_prefix: '有文件没能归入任何一季：',
  // R-F2「另一处那份仍要单独去配」。这一格仍然是"已配字幕"（任一份有就算），这句补的是
  // "但另一份还是裸的"。不说"缺"——那个词在本页属于虚线格（磁盘上没有）。
  media_extra_unsubtitled: '另有份数还没配上：',
  media_extra_unsubtitled_legend: '右上角数字 = 这一集还没配上字幕的份数',
  media_detail_not_found_title: '没有这部作品',
  media_detail_not_found_desc: '库里没有这个作品，可能已随守备目录一起移除。',
  media_detail_no_seasons_title: '还没有任何一集',
  media_detail_no_seasons_desc: '磁盘上没有能归入季的文件，应有集目录也还没缓存。',

  // 八态文案（R-F12）。⚠️ unsolvable 不写"失败"——它不是永久终态，复查闸每周放回一次。
  media_state_covered: '已有字幕',
  media_state_translating: '正在翻译',
  media_state_unsolvable: '暂时没辙 · 还会再试',
  media_state_origin_skip: '原生就是目标语言 · 不需要字幕',
  media_state_embedded: '自带内嵌字幕轨',
  // 特典（NCOP/NCED/PV/menu）。措辞不说"已跳过"或"已忽略"——那听着像系统偷懒或出错；
  // 说"不找字幕"是把裁决如实讲出来（用户原话：「特典都完全不算在找字幕的范围」），
  // 让用户一眼知道这是**设计如此**、不需要他做任何事。
  media_state_extra: '特典 · 不找字幕',
  media_state_pending: '正在找字幕',
  media_state_unjudged: '还没判定',
  media_state_absent: '本地没有',

  // ── Task ⑩ 通知页（#/notifications）─────────────────────────────────────
  // R-F3：保留一周 / 倒序流水 / **不做已读状态**——本族里没有"标记已读/未读"文案，
  // 将来也不许加（加文案就是加状态的第一步）。
  notif_window_note: '过去一周找到的',
  notif_day_today: '今天',
  notif_day_yesterday: '昨天',
  notif_episodes_prefix: '第',
  notif_episodes_suffix: '集',
  notif_movie_found: '已找到字幕',
  // 🔴 2026-08-13：`season === null` 二义性的两条新文案。
  // notif_found_generic —— 作品身份查不到时的那句。**两个来源**：works 行已删（用户移了
  //   守备目录，通知还在一周窗内），或 media_type 是意料外的值。措辞必须对两者都为真，
  //   故只说「这个文件」这个确实发生过的事实——既不声称电影也不声称剧集，
  //   也不断言"作品已不在库里"（那对第二个来源是假的）。
  //   🔴 与 notif_movie_found **逐字不同**：两句字面相同的话在界面上就是同一句，
  //   那正是本轮要消灭的形态（"我查不到"与一个确定结论共用一句话）。
  notif_found_generic: '找到了这个文件的字幕',
  // notif_season_unplaced —— 剧集但季没解析出来。用户能做的与「认不出的目录」同类：改文件名。
  notif_season_unplaced: '已找到字幕（这一集没能归入季集）',
  notif_via_fetch: '抓取',
  notif_via_translate: '机翻',
  // 组内两种来路都有——必须如实报，谎报单一来源会误导用户对字幕质量的预期。
  notif_via_mixed: '抓取 + 机翻',
  // 🔴 SSE 提示条。**刻意不说条数**：事件条数 ≠ 端点组数（幂等刷新），报数会撒谎。
  notif_new_found: '有新找到的字幕',
  notif_refresh: '刷新',
  notif_empty_title: '这一周还没找到什么',
  notif_empty_desc: '过去一周装上的字幕会出现在这里，最新的在最前面。',
  notif_error_title: '没能加载通知',
  notif_retry: '重试',
  // ── Task ⑨ 活动页（#/activity）────────────────────────────────────────────
  // ⚠️ 「上次巡检开始于」的「开始」二字是语义债务的执行，不是措辞偏好：
  // lastInspectAt 落的是开始时刻不是完成时刻，写「完成于」就是在报一个我们不知道的事实。
  wb_statusbar_label: '引擎状态',
  wb_inspect_unknown: '正在获取状态…',
  wb_inspect_never: '还没有自动检查过',
  wb_inspect_running: '正在自动检查',
  wb_inspect_stale: '自动检查好像没有在运行',
  wb_inspect_idle: '上次自动检查',
  wb_identify_running: '正在识别媒体信息',
  wb_engine_off: '引擎开关是关的，什么都不会处理',
  wb_setup_incomplete: '还没配好，去把 TMDB 与 LLM 的凭据填上',
  wb_tablist_label: '工作台',
  wb_tab_subtitle: '字幕',
  wb_tab_translate: '翻译',
  wb_section_running: '正在处理',
  wb_section_queued: '排队中',
  wb_running_none: '当前没有正在处理的任务',
  wb_running_now: '正在处理',
  wb_queue_none: '没有等待处理的任务',
  wb_untitled: '未命名',
  wb_media_tv: '剧集',
  wb_media_movie: '电影',
  wb_pending_files: '集需要字幕',
  // 🔴 退避窗（2026-08-13）。修的是「已排队 · 0 / 没有排队的作品」这句假话：
  // 生产上 33 个文件在等、全在退避窗，此前它们一个都不显示。现在照常显示，
  // 只是各自说清楚"还要等多久"，队列整体取不到时再加一句总的。
  // 措辞纪律同 stale 那一族：不出现"退避/backoff/next_retry_at"这类内部词。
  wb_queue_retry_in: '等待重试',
  wb_queue_all_backoff: '这些正在等待重试',
  wb_loading: '加载中…',
  wb_error_title: '没能加载队列',
  wb_retry: '重试',
  // ── 决策历史段（RunsHistory）——decision 词本身不翻译（技术状态词，同 en 侧裁决） ──
  // ── 🟡 实时通道掉线时的「读数已经不新鲜了」（诚实性，**不是排障提示**）────────
  // 措辞纪律同 en 侧：不出现 SSE / 连接 / 状态码这类词。两句分开是因为用户能做的事不同
  // （retrying 自己会好；unavailable 是终态，只有刷新才可能变，所以必须明说刷新）。
  wb_live_retrying: '实时更新断了，正在重新接上。下面看到的可能已经不是最新的了。',
  wb_live_unavailable: '实时更新没有开着。下面看到的是一份快照，刷新页面才会更新。',
  wb_run_maybe_stale: '可能已经跑完了，这里收不到实时更新',

  // ── 🔴 守备目录健康度（终局审计 🔴-1）────────────────────────────────────
  // 措辞纪律同 en 侧：不出现挂载 / errno / 重试次数这类词，不透传 lastError 原文。
  // 两句分开是因为它们是两件不同的事：failed 是坏消息且有东西可修；
  // unknown（从没扫过 / 判决陈旧）**不是故障**，措辞必须中性。
  root_health_failed: '这些目录读不到，里面的东西可能不是最新的',
  root_health_unknown: '最近没有检查过',

  // ── 🔴 认不出来的目录（病 A 第 7 例的可见形态）──────────────────────────
  // 措辞纪律同 en 侧：说后果不说过程；必须带上「按 title (year) 改名」这句
  // （R-F1 的下半句，界面上没有按钮，用户唯一的动作在他自己的文件管理器里）；
  // 不出现 park / work_id / TMDB / agent / 404 / 退避 这类实现词。
  unidentified_note: '这些目录认不出来，改成「片名 (年份)」就能处理了',
  unidentified_more: '另外还有 {n} 个',
  // 🔴-4：记着失败、却再也没被重试的活。措辞纪律同上：不出现 job/queue/claim/
  // next_retry_at 这类内部词；也**不承诺**「它会重试」（那是假的），
  // 更不断言「永远不会」（那是把当前实现钉成结论）——只陈述"记着失败了、多久没动"。
  stalled_jobs_note: '有 {n} 件活记着失败了',
  stalled_jobs_age: '已经 {d} 没有再重试',
} as const
