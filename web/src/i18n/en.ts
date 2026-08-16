// web/src/i18n/en.ts：扁平 key 表，英文基准。workflow_* 键是"真源"——zh.ts 反向引用这里的值
// （DESIGN.md §7：Workflow 区永不本地化，用户裁决），改 Workflow 文案只许改这个文件。
export const en = {
  // 侧栏导航项标签。三个分区 eyebrow（LIBRARY/AGENTS/SYSTEM）按 DESIGN.md 铁律固定英文大写，
  // 不进这张表——见 web/src/shell/tabs.ts 顶部注释。
  //
  // 2026-08-12（Task ⑦）：新导航四项 = 活动/通知/媒体库/设置。nav_library / nav_workflow
  // **保留**——那两个路由还活着（只是不在侧栏里），Topbar 的面包屑仍按 route.tab 查 TABS…
  // 查不到时回落空串，但 #/library 的二级面包屑（剧名那条）还要用 nav_library。
  // 两个键随 Task ⑪ 删旧页面时一起走。
  brand_name: 'Subtitle Scout',
  nav_activity: 'Activity',
  nav_notifications: 'Notifications',
  nav_media: 'Media',
  nav_library: 'Library',
  nav_workflow: 'Workflow',
  // nav_triage（'Triage'）随甄别页下架移除（spec §5，2026-08-07）——留着就是孤儿死代码。
  //   重启用时把这个键加回本文件与 zh.ts（i18n.test.ts 只测两侧键集一致）。
  nav_settings: 'Settings',
  nav_logout: 'Log out',

  // 通用 chrome（审计 P0-4）：Cancel/Save/Clear/loading 在四个破坏性确认框与五个加载态里
  // 曾是字面量，中文界面因此出现英文按钮。这里统一收进词表。
  common_cancel: 'Cancel',
  common_save: 'Save',
  common_clear: 'Clear',
  common_confirm: 'Confirm',
  common_loading: 'loading…',

  // 外壳无障碍名与状态词（审计 P0-4/P1-0）。
  a11y_side_nav: 'Side navigation',
  a11y_breadcrumb: 'Breadcrumb',
  a11y_dialog_close: 'Close',
  a11y_skip_to_content: 'Skip to content',
  a11y_loading_media_library: 'loading media library',
  a11y_loading_media_detail: 'loading media detail',
  a11y_loading_notifications: 'loading notifications',

  // Task ⑦ 占位页（Task ⑧⑩ 填肉后**只剩活动一个**）：说明"这页将来回答什么问题"。
  // **不描述还不存在的功能细节**——一句人话，等 Task ⑨ 填肉时这个键随之删除。
  placeholder_under_construction: 'Under construction',

  // 页级错误边界（PageBoundary）的降级文案。措辞纪律同 verify_inspect_failed：
  // 说清"坏的是这一页"+"没动你的东西"+"下一步能做什么"，**不吐技术细节**
  // （堆栈里全是模块名和字段名，对用户毫无意义，走 console.error）。
  // 不写"请联系管理员"——这是自托管应用，用户就是管理员。
  page_failed_title: 'This page ran into a problem',
  page_failed_desc: 'Something in this page could not be displayed. Nothing was changed, and the rest of the app still works — try reloading, or switch to another page from the sidebar.',
  page_failed_retry: 'Reload this page',

  // ⌘K 命令面板：F2 只做 tab 导航，不做搜索。

  // Library tab：真正的空库态（F2 占位期借用过这两个键，F3 填肉后原样留作"库确实空"的事实）。
  library_empty_title: 'No library yet',
  library_empty_desc: 'Once media roots are scanned, series and movies will appear here.',

  // 筛选 chip 排（SeriesGrid 顶部）。
  library_filter_all: 'All',
  library_filter_gap: 'Has gaps',
  library_filter_throttled: 'Throttled',
  library_filter_full: 'Fully covered',

  // 分区标题（后端零配置派生的四个已知桶——sectionLabel.ts 认得的原文见该文件注释）。

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
  library_detail_not_on_disk: 'not on disk',
  library_detail_no_subtitles: 'No subtitles found for this episode.',
  library_detail_close_label: 'Close episode details',
  library_detail_file_heading: 'File',
  library_detail_files_heading: 'Files',
  library_detail_subtitles_heading: 'Subtitles',
  library_detail_hardsub_assumed: 'covered (hardsub assumed)',
  library_detail_embedded: 'covered · embedded subtitles (in video)',
  library_detail_main_file: 'main',
  // 详情页重设计 item B（Phase 5）：hero + FactsRail + 季手风琴 + 逐集行内展开。
  // 字幕校验（2026-07-30）：绿态只给 aria-label（视觉上是个点，见 VerifyChip.tsx）；
  // 红态是芯片上的可见文字。两句都不提机械（不说内嵌轨/比对/参考源）。
  // library_verify_inspect（'Show subtitle timeline'）随字幕校验渲染点下架移除（spec §5，
  //   2026-08-07）；上面两句仍被 VerifyChip.tsx 引用（组件本身保留，只是暂时无人挂载）。
  // 对照时间轴（2026-07-30）：轨道名与操作提示。措辞不提机械——说"画面里说话"而不是
  // "内嵌字幕轨"，说"这份字幕"而不是"待检 sidecar"。
  verify_track_reference: 'spoken in the video',
  verify_track_reference_sub: 'reference',
  verify_track_ours: 'this subtitle',
  verify_track_ours_sub: 'to fix',
  verify_track_audio: 'sound',
  verify_timeline_hint: 'scroll to zoom · drag to pan',
  // 检视面板（2026-07-30 spec §4.2）。结论文案的三档对应 diagnose() 的三个返回值。
  // 措辞纪律：说"画面"不说"参考轨"，说"这份字幕"不说"sidecar"，不提帧率/互相关/agent。
  verify_inspect_failed: "Something went wrong showing this comparison. Nothing on disk was changed.",
  verify_inspect_loading: 'Loading…',
  verify_verdict_behind_head: 'The subtitles run behind the picture',
  verify_verdict_behind_body: 'Everything is off by the same amount, so shifting the whole track lines it back up. Usually this means the subtitle was made for a different release of this episode.',
  verify_verdict_ahead_head: 'The subtitles run ahead of the picture',
  verify_verdict_ahead_body: 'The lines show up too early, all by the same amount, so shifting the whole track lines it back up. Usually this means the subtitle was made for a different release of this episode.',
  verify_verdict_drift_head: 'The gap grows as the episode goes on',
  verify_verdict_drift_body: 'It starts out close and drifts further apart — shifting the whole track cannot fix that. You will need a subtitle made for this particular file.',
  verify_verdict_unknown_head: 'Cannot tell what is going on here',
  verify_verdict_unknown_body: 'There is not enough to compare against, so nothing is being claimed. Have a look at the lines below to check they belong to this episode.',
  // 无参考源：说清"没东西可比"而不是"查过了没发现问题"——这个区别决定用户下一步做什么。
  verify_verdict_noref_head: 'Nothing to compare this against',
  verify_verdict_noref_body: "This release only carries picture-based subtitles (they have no readable timings), and there is no second subtitle for this episode next to it. The timeline below still shows your own subtitle — play the episode and see whether the lines land with the dialogue.",
  verify_correct_action: 'Fix the timing',
  verify_correcting: 'Fixing…',
  verify_keep_action: 'Leave it alone',
  verify_got_it: 'Got it',
  verify_cues_heading: 'Subtitle lines',
  verify_cloud_title: 'No comparison for files on cloud storage',
  verify_cloud_body: 'Reading even a short stretch takes tens of seconds, so the timeline cannot be drawn. Everything else works as usual.',
  verify_cloud_blind_fix: 'You can still fix the timing — you just will not see the chart.',

  // 格阵图例。
  library_legend_covered: 'covered',
  library_legend_hardsub: 'hardsub assumed',
  library_legend_missing: 'missing',
  library_legend_throttled: 'throttled',
  library_legend_partial: 'partial',
  library_legend_dashed: 'not on disk',

  // Workflow 区永不本地化——本文件是这些键的唯一真源，zh.ts 直接引用，不重复翻译
  // （DESIGN.md §7）。带运行期数字/技术枚举值的动态文案（缺口计数、receipts 分布、四态回执
  // 句、trace 行的等宽工具名+耗时）故意不进这张表，走 web/src/workflow/text.ts 的纯函数——
  // 同 shell/freshness.ts 的既有先例：那些是技术读数，天生不需要翻译，也用不上 t() 不支持的
  // 插值。这里只收静态、不带运行期数据的 UI 文案（泳道头/空态/对话框/按钮）。

  // 三泳道→两列（Gaps | Activity）的重排已随活动页重建整体退役（泳道组件与 ActivityFeed
  // 在 2bb6d10 删除，workflow_lane_* 键同亡）。Rerun 一族键的现存消费方是 workflow/ 下的
  // RunDetail（发起）与 RerunDialog（确认+回执）。
  workflow_pending_rerun_label: 'Rerun',
  // Orchestrator log 折叠区（design §B）：原三泳道之一的 Passes，现降级为 Activity 列底部默认
  // 收起的 Collapsible——回执 chip 只在展开后可见，工程师内容零删除。

  // "Now working" 即原 Running 泳道小标题——改名对齐 design §B 的叙事称呼（Now working 卡）。

  workflow_rundetail_close_label: 'Close pass details',
  workflow_rundetail_detail_heading: 'Detail',
  workflow_rundetail_receipts_heading: 'Receipts',
  workflow_rundetail_replay_heading: 'Trace replay',
  workflow_rundetail_replay_empty: 'No trace events were captured for this pass.',
  workflow_rundetail_replay_error_prefix: "Couldn't load the trace replay: ",

  workflow_rerun_include_throttled_label: 'Include throttled episodes',


  // Triage tab（甄别，dashboard-F5）——正常双语区（DESIGN.md §7 只豁免 Workflow 区）。
  // 待甄别箱空态是好消息——"identifier 全部归位"方向写，不是"这里本来会显示什么"式说明
  // （triage_empty_title/desc 这两个键最早是 F2 占位期借用的，F5 填肉后原样留作真实空态用，
  // 同 library_empty_title 在 F3 落地时的既有先例）。
  triage_empty_title: 'Every file found its identifier',
  // 认领退役（2026-07-28 两证据红线裁决，见 src/v2/triageOps.ts 头注释）：空态文案不再提
  // "manual claim"——正确的用户修复动作是改文件名。
  triage_empty_desc: 'Nothing is waiting to be identified right now. (That does not mean every identity is right — the subtitle agent re-verifies each one before it works, and any corrections show up in the timeline.)',
  triage_error_prefix: "Couldn't load the triage queue: ",
  triage_retry_label: 'Retry',

  triage_pending_heading: 'Pending',
  // 页头两键（§5.5/§5.7，Task 22）——副标题定调：parked 不是错误，不挡自动流程。
  triage_page_title: 'Triage',
  triage_subtitle: 'Items the system parked instead of guessing. Nothing here blocks automatic work.',
  // 认领一族键（triage_claimed_* / triage_claim_group_label / triage_dialog_* / triage_search_* /
  // triage_tmdbid_label / triage_season_* / triage_submit/cancel/close/results/partial_failure）
  // 已随认领退役整体删除（2026-07-28 两证据红线裁决）——不留不再被引用的字符串。
  // triage_duplicates_heading 更早退役（P2 起 ingest 不再产 duplicate-content 停车行）。
  triage_excluded_heading: 'Excluded extras',
  triage_excluded_restore_label: 'Restore',
  triage_restore_error_prefix: "Couldn't restore: ",
  // Timing looks off 区两键（§5.5/§5.7，Task 23）——"checked …ago" 与行标签带运行期值，
  // 走 triage/text.ts，不进扁平表；"Fix the timing" 复用既有 verify_correct_action。
  triage_timing_heading: 'Timing looks off',
  triage_timing_undo: 'Undo',
  // Dormant tasks 区一键（§5.5/§5.7，Task 24）——"Failed N times…" 带运行期数字，走
  // triage/text.ts 的 dormantReasonLine，不进扁平表；区行零按钮（唤醒通道 §3 决策 1 不补）。
  triage_dormant_heading: 'Dormant tasks',
  // 改名指引——README 命名最佳实践同文（docs/design 的 dashboard 重建设计 §6）。路径形状本身
  // 是技术值，组件层拼接成 mono 片段，不进这条 i18n 文案（DESIGN.md §3：mono 是技术层专属声音）。
  triage_naming_hint_prefix: 'Correct naming skips manual triage — best practice: ',


  // Settings tab（dashboard-F6）——正常双语区（DESIGN.md §7 只豁免 Workflow 区）。F2 占位期的
  // settings_empty_title/desc（"coming soon"）随 F6 落地真内容一并退役——不像 triage_empty_*
  // 那样有一个"真的空"的状态可以复用这段文案，四 tab 占位就此全部清空
  // （shell/PlaceholderTab.tsx 同步删除，见该文件退役时的 git 记录）。
  settings_behavior_heading: 'Behavior',
  settings_roots_heading: 'Media folders',

  settings_error_prefix: "Couldn't load settings: ",
  settings_retry_label: 'Retry',

  // ── Settings tab chrome（审计 P0-1/P0-3）───────────────────────────────
  settings_tab_general: 'General',
  settings_tab_providers: 'Providers',
  settings_tab_media: 'Media folders',
  settings_tab_security: 'Security',
  settings_status_configured: '✓ Configured',
  settings_status_unconfigured: '⚠ Not configured',

  // 行为区（BehaviorSection）——五项，逐项改动即时单键 PUT。
  settings_target_languages_label: 'Target subtitle language',
  settings_target_languages_description: 'The subtitle language to search for and download. Unset defaults to Chinese.',
  // 债务D5：target_languages 已提供者化，每轮 ingest pass 起点新鲜读取。
  settings_target_languages_restart_note:
    'Takes effect on the next library scan.',

  settings_hardsub_mode_label: 'Hardsub assumption',
  settings_hardsub_mode_option_off: 'Off',
  settings_hardsub_mode_option_agent: 'Agent',
  settings_hardsub_mode_option_aggressive: 'Aggressive',
  settings_hardsub_mode_note: 'Takes effect on the next dispatched find-subtitle task.',
  settings_exclude_extras_label: 'Exclude extras',
  // 救援R6：exclude_extras/hardsub_mode 已各自独立生效注记（R4c/R5e）——rescue-officer 战役
  // 全线收官，这条"尚未落地"占位注记已无消费点，随手清理，不留误导性文案。
  settings_exclude_extras_restart_note: 'Takes effect on the next library scan.',

  settings_trace_retention_label: 'Trace retention (days)',
  settings_trace_retention_note: 'Takes effect at the daily trace cleanup.',
  settings_scan_interval_label: 'Scan interval (minutes)',
  settings_scan_interval_note: 'Takes effect on the next scan tick.',

  settings_save_error_prefix: "Couldn't save: ",

  // 部署区（DeploySection，只读）——env 脱敏展示，零输入控件。
  // audit R4: MEDIA_ROOTS is a first-boot seed only; the live list lives in the media_roots table

  // 守备目录管理器（RootsManager）。
  settings_roots_error_prefix: "Couldn't load media roots: ",
  settings_roots_retry_label: 'Retry',
  settings_roots_empty_hint: 'No media folders yet — enter a path below to add the first one.',
  settings_roots_remove_label: 'Remove',
  settings_roots_add_button_label: 'Add folder',
  settings_roots_add_path_label: 'Media folder path',
  settings_roots_add_path_placeholder: '/Users/me/Movies',
  settings_roots_add_error_prefix: "Couldn't add this directory: ",
  settings_roots_add_success: 'Added — the next scan will pick it up automatically.',
  // 删根 AlertDialog——destructive 才用 AlertDialog（DESIGN.md §5），文案明示后果。
  settings_roots_remove_confirm_desc:
    'This clears every indexed row under this root — episodes, movies, subtitle records, and parked entries. Files on disk are not touched.',
  settings_roots_remove_result_title: 'Media root removed',
  settings_roots_remove_failed_title: 'Could not remove this root',
  settings_roots_remove_close_label: 'Close',
  settings_roots_remove_error_prefix: "Couldn't remove this root: ",

  // 目录浏览器（DirBrowser）——加根流程。
  // 后端 roots 已动态化——加根即刻生效于下一轮巡检，这句是真的（不是"假装即时生效"）。

  // ── 鉴权 A2/A3（setup 向导 / 登录 / Security 区）。共享字段标签在此，各页复用。 ──
  auth_username_label: 'Username',
  auth_password_label: 'Password',
  auth_show_password: 'Show password',
  auth_hide_password: 'Hide password',
  // SetupWizard（首启向导，单屏建管理员）。
  setup_heading: 'Create the admin account',
  setup_intro: 'This instance is single-admin. Credentials are stored locally; recovery is via the CLI.',
  setup_confirm_label: 'Confirm password',
  setup_password_hint: 'At least 10 characters',
  setup_password_mismatch: 'Passwords do not match',
  setup_submit: 'Create account',
  setup_submitting: 'Creating…',
  // 一次性 API key 告知屏（建成即登录后立即展示，唯一一次全显）。
  setup_apikey_heading: 'Your API key',
  setup_apikey_notice: 'Shown in full only this once. From now on Settings shows the last 4 characters; you can copy or regenerate it there anytime.',
  setup_apikey_copy: 'Copy',
  setup_apikey_copied: 'Copied',
  setup_enter_label: 'Continue to dashboard',
  // LoginPage（登录页，极简）。
  login_heading: 'Sign in',
  login_submit: 'Log in',
  login_submitting: 'Signing in…',
  login_error_invalid: 'Incorrect username or password.',
  login_error_throttled: 'Too many attempts — try again in a minute.',
  login_error_transport: "Can't reach the server.",
  login_forgot_prefix: 'Locked out? Reset from the CLI: ',
  // 鉴权门探测失败的连接错误屏。
  auth_connection_error_heading: "Can't reach the server",
  auth_connection_error_desc: 'The dashboard could not reach the server. Check that it is running, then retry.',
  auth_retry: 'Retry',
  // Settings → Security 区（A3）。
  settings_security_heading: 'Security',
  settings_security_loading: 'loading…',
  settings_security_error_prefix: "Couldn't load security settings: ",
  settings_security_username_label: 'Admin username',
  settings_security_apikey_label: 'API key',
  settings_security_copy: 'Copy',
  settings_security_copied: 'Copied',
  settings_security_regenerate: 'Regenerate',
  settings_security_regen_confirm:
    'Regenerate the API key? The current key stops working immediately. Any client using it will fail until updated.',
  settings_security_current_password: 'Current password',
  settings_security_new_password: 'New password',
  settings_security_change_button: 'Change password',
  settings_security_change_success: 'Password updated.',
  settings_security_password_hint: 'At least 10 characters',
  // ---------- Spec A 启动面（wizard_* 区 + providers/engine/banner；wizard 区 en/zh 双写，§5.3） ----------
  wizard_back: 'Back',
  wizard_continue: 'Continue',
  wizard_save_continue: 'Save & continue',
  wizard_skip_step: 'Skip this step',
  wizard_test: 'Test',
  wizard_testing: 'Testing…',
  wizard_test_passed: 'Connected',
  wizard_test_failed: 'Connection failed',
  // 端点自身 5xx / 网络断（spec §7）——与"凭据不对"分开的第四态，不回显原始异常串。
  wizard_test_unavailable: 'Test unavailable, retry',
  wizard_launch: 'Launch',
  wizard_env_locked: 'Already configured',
  wizard_retest: 'Re-test',

  wizard_step_language_title: 'Subtitle language',
  wizard_step_language_desc: 'Which languages should Scout fetch subtitles in? Your first pick also sets the UI language.',
  wizard_step_tmdb_title: 'TMDB',
  wizard_step_tmdb_desc: 'Scout identifies your shows and movies with TMDB.',
  wizard_step_llm_title: 'Language model',
  wizard_step_llm_desc: 'Powers subtitle search decisions and the zimuku captcha solver.',
  wizard_step_providers_title: 'Subtitle providers',
  wizard_step_providers_desc: 'Optional — more sources, better hit rate.',
  wizard_step_free_title: 'Free sources',
  wizard_step_free_desc: 'Built in, no account needed.',
  wizard_step_roots_title: 'Media roots',
  wizard_step_roots_desc: 'The folders Scout watches.',
  wizard_step_launch_title: 'Launch',
  wizard_step_launch_desc: 'Review your setup and start the engine.',

  wizard_language_custom_placeholder: 'Add another — e.g. fr, pt-BR',
  wizard_language_add: 'Add',
  wizard_language_invalid: 'Use a BCP-47 code, like "fr" or "pt-BR".',

  wizard_tmdb_label: 'API key',
  wizard_tmdb_placeholder: 'TMDB API key or read access token',
  wizard_tmdb_hint: 'Free at themoviedb.org → Settings → API. No key, no Scout — this step has no skip.',

  wizard_llm_base_label: 'Base URL',
  wizard_llm_base_hint: 'Usually ends with /v1.',
  wizard_llm_key_label: 'API key',
  wizard_llm_model_label: 'Model',
  wizard_llm_model_placeholder: 'Model name, as your provider calls it',
  wizard_llm_required_note: 'Search decisions and the zimuku captcha solver need a working model — this step has no skip.',

  wizard_providers_banner: 'subhd and zimuku are built-in free sources and stay on as fallback.',
  wizard_assrt_label: 'ASSRT token',
  wizard_os_apikey_label: 'OpenSubtitles API key',
  wizard_os_user_label: 'OpenSubtitles username (optional)',
  wizard_os_pass_label: 'OpenSubtitles password (optional)',
  wizard_jimaku_label: 'Jimaku API key',
  wizard_consequence_assrt: 'Without ASSRT, one fewer subtitle source.',
  wizard_consequence_os: 'Without OpenSubtitles, one fewer subtitle source.',
  wizard_consequence_jimaku: 'Without Jimaku, one fewer subtitle source.',
  wizard_providers_save_note: 'Only keys that pass the test are saved.',

  wizard_subhd_label: 'subhd',
  wizard_zimuku_label: 'zimuku',
  wizard_free_reach_checking: 'Checking reachability…',
  wizard_free_reach_ok: 'Reachable',
  wizard_free_reach_fail: 'Unreachable — stays on, retried at runtime.',
  wizard_zimuku_captcha_ready: 'Captcha solver: ready (LLM configured)',
  wizard_zimuku_captcha_not_ready: 'Captcha solver needs the LLM from step 3.',

  wizard_roots_skip_note: 'Library will stay empty until you add a media folder — you can do this later in Settings.',

  wizard_launch_configured: 'Configured',
  wizard_launch_skipped: 'Skipped',
  wizard_launch_engine_label: 'Engine',
  wizard_launch_engine_desc: 'Start scanning and fetching as soon as Scout launches.',

  // ── 全局 banner（四页共用）。**两种成因分开说**（终局审计 🟡-4）────────────────
  // 此前 banner 只读 setup/status 的 `engineEnabled`，于是
  // `engineEnabled=true && setupSatisfied=false` 时它判定"引擎开着"→ 整条不渲染，
  // 媒体库/通知/设置三页完全无提示，只有活动页（读 workPermitted）说得出真话。
  //
  // 🔴 两句必须不同，因为**用户的下一步动作完全相反**：
  //  · engine-off       → 拨开关（banner 自己就有那个按钮，一步到位）
  //  · setup-incomplete → 去 setup 页填 key（**按钮必须换成去设置页**，
  //    在这一档给"开启"按钮是最坏的形态：它 PUT 成功、banner 变成另一句，
  //    而 daemon 照样一动不动——用户会以为自己已经修好了）。
  engine_banner_off: 'Engine off — polling and dispatch are paused.',
  engine_banner_turn_on: 'Turn on',
  engine_banner_setup: 'Setup incomplete — nothing will be processed until your TMDB and LLM credentials are in.',
  engine_banner_go_setup: 'Open settings',

  settings_engine_label: 'Engine',
  settings_engine_desc: 'Master switch for scanning, fetching and all automatic work.',
  settings_provider_enable_label: 'Enable {name}',
  settings_provider_no_api_key_note: 'No API key required — works out of the box',
  settings_free_source_description: 'Chinese subtitle source',
  settings_provider_not_set: 'Not set',
  settings_provider_readonly_note: 'Read-only here',
  settings_provider_edit: 'Edit',
  settings_provider_save: 'Save',
  settings_provider_cancel: 'Cancel',
  settings_provider_test: 'Test',
  settings_provider_last_test_ok: 'Last test passed',
  // 密钥的人话标签（审计 P0-5）——设置页不再直接显示 env 变量名。
  secret_tmdb_api_key: 'TMDB API key',
  secret_assrt_token: 'ASSRT token',
  secret_opensubtitles_api_key: 'OpenSubtitles API key',
  secret_opensubtitles_username: 'OpenSubtitles username',
  secret_opensubtitles_password: 'OpenSubtitles password',
  secret_jimaku_api_key: 'Jimaku API key',
  secret_translate_base_url: 'Base URL',
  secret_translate_api_key: 'API key',
  secret_translate_model: 'Model',
  settings_provider_last_test_fail: 'Last test failed',
  // Quota exhausted (settings/ProviderCard) — the answer to "why did assrt stop looking?".
  // Two channels (Carbon): the sentence says it in full, the hollow marker carries the shape.
  settings_provider_quota_exhausted: 'Quota exhausted — this source is unavailable right now',
  settings_provider_quota_resets_in: 'resets in',
  // 🔴 resetAt=null means we do NOT know when it comes back. Say so; never guess a time.
  settings_provider_quota_reset_unknown: 'reset time unknown',
  settings_provider_quota_observed: 'observed',
  settings_provider_quota_ago_suffix: 'ago',

  // zimuku vision fallback card
  settings_zimuku_vision_heading: 'zimuku vision fallback (optional)',
  settings_zimuku_vision_description: 'Template matching handles most captchas without LLM. Configure a vision-capable model here only as fallback for template misses (rare). Unset = template-only.',
  settings_zimuku_vision_model_label: 'Vision model',
  settings_zimuku_vision_base_url_label: 'Vision base URL',
  settings_zimuku_vision_api_key_label: 'Vision API key',
  settings_zimuku_vision_test_label: 'Test vision',
  settings_zimuku_vision_testing: 'Testing…',
  settings_zimuku_vision_test_ok: 'Vision capable — can recognize digits in images',
  settings_zimuku_vision_test_fail: 'Not a vision model — test image was not recognized',
  settings_zimuku_vision_clear_confirm_title: 'Clear vision fallback?',
  settings_zimuku_vision_clear_confirm_body: 'Template matching will still work. Vision LLM is only called when templates miss (rare).',
  settings_zimuku_vision_clear_action: 'Clear',

  // AI 翻译卡（TranslateCard，审计 P0-2）——本卡曾整卡英文。
  settings_translate_card_title: 'AI subtitle translation',
  settings_translate_card_description: 'Auto-translate when no subtitle is found',
  settings_translate_enable_label: 'Enable AI subtitle translation',
  settings_translate_quota_note: 'Consumes LLM quota',
  settings_translate_model_label: 'Model',
  settings_translate_model_default: 'Follow default LLM',
  settings_translate_model_dedicated: 'Dedicated model',
  settings_translate_current_model_prefix: 'Current:',
  settings_translate_shared_with_agent: 'shared with agent',
  settings_translate_all_fields_required: 'All three fields are required',
  settings_translate_badge_off: 'Off',
  settings_translate_badge_enabled: '✓ Enabled',
  settings_translate_badge_dedicated: '✓ Dedicated model',
  settings_translate_badge_incomplete: '⚠ Incomplete',
  settings_translate_dedicated_confirm_title: 'Switch to default model?',
  settings_translate_dedicated_confirm_body: 'This clears the dedicated model configuration. Are you sure?',

  settings_system_rerun_wizard: 'Re-run setup wizard',
  settings_system_rerun_wizard_desc: 'Walk through bootstrap again. Steps configured via environment stay locked.',

  // ── Task ⑧ 媒体库页（#/media）────────────────────────────────────────────
  // 键前缀 `media_*` 与旧海报墙的 `library_*` **刻意分开**：两个页面并存到 Task ⑪，
  // 共用键会让"改文案时改到另一个页面"变成可能，而且旧键随旧页面一起删。
  media_result_count_prefix: 'Titles',
  media_card_subtitled: 'subtitles downloaded',
  media_card_embedded: 'built-in subtitles',
  media_card_ondisk: 'local videos',
  
  // 🟡-3：缺集数（missingEpisodeCount 的第一个读取方）。
  // "missing N" 而不是 "N missing"：卡片上这一行要能被扫视，名字在前、数字在后，
  // 与同卡片上面那三段（`subtitled 12 · on disk 30`）的语序一致。
  media_card_missing: 'missing',
  media_card_missing_unit: 'episodes',
  // 🔴 2026-08-13: files that could not be placed into a season/episode grid.
  media_card_unplaced: '{n} file(s) not in a season',
  media_empty_title: 'Nothing in the library yet',
  media_empty_desc: 'Once media roots are scanned, titles will appear here.',
  media_error_title: 'Could not load the media library',
  media_retry: 'Retry',
  media_back: '← Media',
  media_season_prefix: 'Season',
  media_season_missing: 'missing',
  media_movie_heading: 'Movie',
  media_legend_label: 'Episode status legend',
  media_unplaced_prefix: 'Files that could not be placed into a season:',
  // R-F2「另一处那份仍要单独去配」。这一格仍然是 covered（任一份有就算），这句话补的是
  // "但另一份还是裸的"。刻意不说 "missing"——那个词在本页已经属于虚线格（磁盘上没有）。
  media_extra_unsubtitled: 'another copy still needs subtitles:',
  media_extra_unsubtitled_legend: 'superscript = copies of this episode still without subtitles',
  media_detail_not_found_title: 'No such title',
  media_detail_not_found_desc: 'This work is not in the library. It may have been removed with its media root.',
  media_detail_no_seasons_title: 'No episodes yet',
  media_detail_no_seasons_desc:
    'Nothing on disk could be placed into a season, and the expected-episode list has not been cached yet.',

  // 八态文案（R-F12）。**逐态一句人话**——不是符号的名字（"对勾"），是那一格的事实。
  // ⚠️ unsolvable 刻意不写 "failed"/"gave up"：后端注释明写它**不是永久终态**，
  // 阶段 2.6 的复查闸每周放回一次。说"失败"是把停牌说成终局。
  media_state_covered: 'Subtitle available',
  media_state_translating: 'Being translated',
  media_state_unsolvable: 'No source yet — will retry',
  media_state_origin_skip: 'Original language — no subtitles needed',
  media_state_embedded: 'Embedded track',
  media_state_extra: 'Extra — not subtitled by design',
  media_state_pending: 'Looking for subtitles',
  media_state_unjudged: 'Not judged yet',
  media_state_absent: 'Not available locally',

  // ── Task ⑩ 通知页（#/notifications）─────────────────────────────────────
  // 键前缀 `notif_*`。R-F3：保留一周 / 倒序流水 / **不做已读状态**——所以这一族里
  // 没有任何 "mark as read" / "unread" 文案，将来也不许加（加文案就是加状态的第一步）。
  notif_window_note: 'Found in the past week',
  notif_day_today: 'Today',
  notif_day_yesterday: 'Yesterday',
  notif_episodes_prefix: 'episodes',
  /** 集号后缀。英文没有量词，故为空串；中文是"集"（「第 3/5/7 集」）。
   *  ⚠️ 空串是**有意**的，不是漏填——t() 不支持插值（i18n/useT.ts 头注释），而中英两侧
   *  的量词位置不同（en 前置 "episodes 3/5/7"，zh 前后夹 "第 3/5/7 集"），只能拆成
   *  prefix/suffix 两个键。notifications 的用例里有一条钉着"两侧至少有一侧非空"。 */
  notif_episodes_suffix: '',
  notif_movie_found: 'subtitles found',
  // 🔴 2026-08-13: the two meanings of `season === null`.
  notif_found_generic: 'found subtitles for this file',
  notif_season_unplaced: 'subtitles found (episode not placed into a season)',
  notif_via_fetch: 'fetched',
  notif_via_translate: 'translated',
  // 组内两种来路都有。**必须如实报**——一季里有抓来的也有机翻的时，谎报单一来源
  // 会误导用户对字幕质量的预期（notificationsRepo 的 FoundGroup.via 注释）。
  notif_via_mixed: 'fetched + translated',
  // 🔴 SSE 提示条。**刻意不说条数**：SSE 的 found 事件条数与端点返回的组数天然不等
  // （recordFound 幂等刷新，同一组重复装盘只 UPDATE），说"3 条新字幕"然后刷新只多 1 条
  // 会让用户以为系统弄丢了两条。只说"有"这个我们确实知道得准的布尔事实。
  notif_new_found: 'New subtitles found',
  notif_refresh: 'Refresh',
  notif_empty_title: 'Nothing found this week',
  notif_empty_desc: 'Subtitles picked up in the past week show up here, newest first.',
  notif_error_title: 'Could not load notifications',
  notif_retry: 'Retry',
  // ── Task ⑨ 活动页（#/activity）────────────────────────────────────────────
  // 顶部状态条。⚠️ 巡检那几句的措辞是**语义债务的执行**，不是文案偏好：
  // `lastInspectAt` 落的是巡检的**开始**时刻不是完成时刻（Task ⑤ 审计 🟡-3，后端未修），
  // 故 idle 那句必须说「started」/「开始于」——说「completed」就是在报一个我们不知道的事实。
  wb_statusbar_label: 'Engine status',
  wb_inspect_unknown: 'Checking status…',
  wb_inspect_never: 'No automatic check has run yet',
  wb_inspect_running: 'Automatic check in progress',
  // 「daemon 可能没在跑」——陈旧门（48h）覆盖不到容器挂掉这一档，见 inspectFreshness 债务二。
  wb_inspect_stale: 'The automatic check may not be running',
  wb_inspect_idle: 'Last automatic check',
  // R-F1：识别降级到状态条，不占 tab。
  wb_identify_running: 'Identifying media',
  // 引擎不许可的两态。分开是因为可执行动作不同（打开开关 vs 去填 key）。
  wb_engine_off: 'Engine is switched off — nothing will be processed',
  wb_setup_incomplete: 'Setup incomplete — add your TMDB and LLM credentials',
  wb_tablist_label: 'Workbenches',
  wb_tab_subtitle: 'Subtitles',
  wb_tab_translate: 'Translation',
  wb_section_running: 'Processing',
  wb_section_queued: 'Waiting',
  wb_running_none: 'No tasks are being processed right now',
  wb_running_now: 'Processing now',
  wb_queue_none: 'No titles are waiting',
  wb_untitled: 'Untitled',
  wb_media_tv: 'Series',
  wb_media_movie: 'Movie',
  wb_pending_files: 'need subtitles',
  // 🔴 Backoff window (2026-08-13). Fixes the "Queued · 0 / Nothing queued" lie:
  // 33 files were waiting in production, all inside the backoff window, and none of
  // them showed up. They show up now, each saying how long the wait is.
  wb_queue_retry_in: 'waiting to retry',
  wb_queue_all_backoff: 'These are waiting to retry',
  wb_loading: 'Loading…',
  wb_error_title: 'Could not load the queue',
  wb_retry: 'Retry',
  // ── 决策历史段（RunsHistory）——decision 词本身不翻译（技术状态词，见 settings_deploy_present_word 的裁决） ──
  // ── 🟡 实时通道掉线时的「读数已经不新鲜了」（诚实性，**不是排障提示**）────────
  // R-F9/R-F10 的裁决是排障类一律不推给用户，所以这两句里**不出现** SSE / 连接 /
  // 状态码 / 端点这类词——它们说的是"你看到的数字有多新"，与上面 wb_inspect_stale
  // 那句「引擎可能没在跑」同一类判决。
  //
  // ⚠️ 两句刻意不同，因为**用户能做的事不同**：
  //  · retrying    自己会好，说一句"正在重新接上"就够，不要求用户做任何事；
  //  · unavailable 终态（没跑 watch，eventsBus 一次都不会再重连）——只有刷新页面
  //    才可能变，所以这句必须**明说刷新**，否则用户会盯着一个永远不动的界面等。
  wb_live_retrying: 'Live updates dropped — reconnecting. What you see below may be out of date.',
  wb_live_unavailable: 'Live updates are off. What you see below is a snapshot — refresh the page to update it.',
  /** 在跑卡片上那一行。卡片自己就是那句谎话本体，所以这里要短、要贴脸。 */
  wb_run_maybe_stale: 'May have finished — no live updates',

  // ── 🔴 守备目录健康度（终局审计 🔴-1）——`/health` 的 `roots[]` 的第一个读取方 ──
  // 用户视角的问题是「我的库是不是有问题」，**不是**「扫描器返回了什么 errno」。
  // 故两句都不出现 mount / FUSE / errno / 重试次数 / 状态码这类词（R-F9/R-F10：
  // 排障类不推给用户），也**不透传** `lastError` 原文（那一列是带 errno 的排障串）。
  //
  // 🔴 两句刻意不同，因为它们是**两件不同的事**，不是同一件事的两种强度：
  //  · failed（ok === false）  新鲜判决 + 读取失败 → 这是坏消息，且**有东西可修**
  //    （用户的挂载掉了）。措辞点明后果："里面的东西可能不是最新的"——这才是用户
  //    真正关心的，而不是"扫描失败了"这个过程事实。
  //  · unknown（ok === null） 从没扫过（刚加的根）/ 判决陈旧超 2 个巡检周期。
  //    **这不是故障**，措辞必须中性——说成"有问题"会让刚加完目录的用户以为自己加错了。
  //    绝不许把这一档折成绿的"一切正常"（后端 buildRootHealth 与 api/types.ts 两处
  //    头注释都点名了 `?? true` 这条禁令）。
  root_health_failed: 'Cannot read these folders — what you see may be out of date',
  root_health_unknown: 'Not checked recently',

  // ── 🔴 认不出来的目录（病 A 第 7 例的可见形态）──────────────────────────
  // 措辞纪律（与 root_health_* 同源，且多一条）：
  //  ① **说后果，不说过程**。用户关心的不是"识别流程失败了"，而是"这些东西我不会处理"
  //     ——因为后者才推得出他该干什么。
  //  ② **必须带上那句该干的事**（`title (year)`）。这是 R-F1 的下半句
  //     「未识别资源不给用户改（底线是按 title (year) 命名）」——界面上没有任何按钮，
  //     用户唯一的动作在他自己的文件管理器里。不说清格式，这条提示就只是在报忧。
  //  ③ 不出现 park / parked / work_id / TMDB / agent / 404 / 退避 这类实现词。
  unidentified_note: "Can't recognise these folders — rename them to “title (year)” and they'll be picked up",
  /** 截断时的尾巴。`dirs` 只给前 8 个，总数一律读 dirCount（绝不用 dirs.length）。 */
  unidentified_more: 'and {n} more',
  // 🔴-4: work recorded as failed that has not been retried since. States the fact only —
  // never promises a retry (untrue), never claims it will never retry (pins today's impl).
  stalled_jobs_note: '{n} task(s) recorded as failed',
  stalled_jobs_age: 'not retried for {d}',
} as const
