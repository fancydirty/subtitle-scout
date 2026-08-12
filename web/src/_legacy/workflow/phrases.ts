// web/src/workflow/phrases.ts：痕迹/活动区叙事化的静态短语映射——纯函数，**按用户语言返回**
// （2026-07-30 用户裁决：见 web/DESIGN.md §7。此前的旧裁决是"Workflow 区永不本地化，全部英文"，
// 那条是在这个界面还是工程排障页时定的；界面重新定义为"缓解焦虑的运行态展示"后，用户裁决改为
// 跟随 UI 语言——选中文走中文，选英文走英文）。两张表：
//  - toolPhrase：直播步骤的工具名 → 人话动词短语（"灵魂卖点"保留：仍是逐步骤直播，只是工程
//    工具名换成人话，argsSummary 默认不显示——TraceRows phraseMode 消费这个函数）。
//  - decisionPhrase：一条 recent 完成行的 decision 词 → { text, tone }，tone 供调用方选圆点色
//    （铁律④：失败/等待用面向下一步的中性话，红只给点不给块——tone='bad' 只染一个 6px 圆点，
//    不许调用方拿它去铺红底色块）。
//
// 为什么不进 i18n 表：这两张表的键是**后端技术枚举值**（工具名、decision 词），不是 UI 文案键；
// 放进 en.ts/zh.ts 会让"后端新增一个工具"变成"必须改 i18n 表否则 TKey 类型报错"。这里的兜底
// （未登记 → 原样回显）是故意的诚实降级，i18n 表做不到这件事。
import type { Lang } from '../../i18n/useT.js'

/** 工具名 → 人话短语。键必须与真实注册的工具名一致（src/agent/findSubtitleWorker.ts 的工具表
 *  与编排层 orchestratorAgent.tools.ts）——2026-07-30 校对发现两处脱节并修正：
 *   - 删 `probe_candidate`：非测试源码里根本不存在这个工具，是个永不触发的死条目。
 *   - 补 `get_candidate`/`download_candidate`/`check_episode_code_safety`：真实高频工具，此前
 *     落到兜底、在直播里糊裸蛇形命名（download_candidate 恰好是进度条最靠前的"在下载"阶段，
 *     即最该让用户安心的那一格反而显示机器词）。 */
const TOOL_PHRASES: Record<Lang, Record<string, string>> = {
  en: {
    read_doc: 'Reading the playbook',
    search_tmdb: 'Looking up the show',
    get_tmdb_details: 'Reading the episode list',
    write_identified_media: 'Filing what it is',
    search_source: 'Searching providers',
    list_candidates: 'Reviewing candidates',
    get_candidate: 'Inspecting a candidate',
    download_candidate: 'Downloading a subtitle',
    install_subtitle: 'Installing a subtitle',
    check_episode_code_safety: 'Double-checking episode numbers',
    finalize: 'Wrapping up',
    // 编排层规划类工具——不是内容产出步骤，统一读作"在规划工作"。
    spawn_sibling_orchestrator: 'Planning work',
    check_series_layout: 'Planning work',
    list_missing_coverage: 'Planning work',
  },
  zh: {
    read_doc: '正在看操作手册',
    search_tmdb: '正在查这是哪部片子',
    get_tmdb_details: '正在核对集目',
    write_identified_media: '正在记下它是什么',
    search_source: '正在搜字幕来源',
    list_candidates: '正在核对候选',
    get_candidate: '正在细看一个候选',
    download_candidate: '正在下载字幕',
    install_subtitle: '正在把字幕装到位',
    check_episode_code_safety: '正在复核集号',
    finalize: '正在收尾',
    spawn_sibling_orchestrator: '正在安排工作',
    check_series_layout: '正在安排工作',
    list_missing_coverage: '正在安排工作',
  },
}

const PLANNING_PHRASE: Record<Lang, string> = { en: 'Planning work', zh: '正在安排工作' }

/** 直播/回放痕迹行的工具名 → 人话短语。dispatch_ 前缀（dispatch_find_subtitle_task/
 *  dispatch_realign_task 等，未来新增的 dispatch_* 工具同样落入这条前缀规则，不需要逐个登记）
 *  与三个编排规划工具统一读作 "Planning work"；其余未登记的工具名原样返回（mono 兜底——诚实
 *  呈现"这个工具还没有人话翻译"，不编造一个可能文不对题的短语。注意兜底**不翻译**：裸工具名是
 *  技术值，中文语境下照样原样显示，这与 §7"技术值永不翻译"一致）。 */
export function toolPhrase(tool: string, lang: Lang = 'en'): string {
  if (tool.startsWith('dispatch_')) return PLANNING_PHRASE[lang]
  return TOOL_PHRASES[lang][tool] ?? tool
}

export type DecisionTone = 'ok' | 'neutral' | 'bad'
export interface DecisionPhrase {
  text: string
  tone: DecisionTone
}

/** decision 词 → { text, tone }。tone 与语言无关（语义分类，不是文案），故只有 text 分双语。 */
const DECISION_TONES: Record<string, DecisionTone> = {
  installed: 'ok',
  no_safe_match: 'neutral',
  // 铁律④：等待/停牌是面向下一步的中性事实，不是失败——tone 恒 neutral（灰点），绝不 bad（红）。
  retry_later: 'neutral',
  error: 'bad',
  'realign:done': 'ok',
  'realign:parked': 'neutral',
  'realign:error': 'bad',
  // 审计 UX-P0：翻译决策全家——此前全部 fallback 裸词糊脸。held/held-parked 是质量闸正确拦下
  // （等待/人工），中性灰不红；extract-failed 是真故障给 bad。
  'translate:installed': 'ok',
  'translate:held': 'neutral',
  'translate:held-parked': 'neutral',
  'translate:no-source': 'neutral',
  'translate:extract-failed': 'bad',
  'translate:probe-failed': 'bad',
  'translate:already-covered': 'ok',
  // 识别架构路 A（2026-07-26 审计 A-4）：身份纠错全家——此前两个词都不在表里，时间线上渲染
  // 成裸下划线机器词（和 UX-P0 那轮修过的翻译决策同一个坑）。identity_correction 是本系统最
  // 重要的正面事件（agent 抓到一次机械误认，正撞在北极星"绝不误认"上），给 ok（绿）不是灰；
  // skipped 是"判对了但没落地"的待办信号，按铁律④给 neutral（灰）不红，但文案要能读出
  // "这里有事没做完"，否则会和一堆中性事实一起沉底没人看（审计 D-2 的静默失效链的一环）。
  identity_correction: 'ok',
  identity_correction_skipped: 'neutral',
}

const DECISION_TEXTS: Record<Lang, Record<string, string>> = {
  en: {
    installed: 'subtitles installed',
    no_safe_match: 'no safe match found',
    retry_later: 'will retry later',
    error: 'hit a problem — will retry',
    'realign:done': 'library realigned',
    'realign:parked': 'needs a manual look',
    'realign:error': 'realign hit a problem',
    'translate:installed': 'subtitles translated',
    'translate:held': 'translation held for review',
    'translate:held-parked': 'needs a manual look',
    'translate:no-source': 'no source subtitle found',
    'translate:extract-failed': 'could not extract subtitles',
    'translate:probe-failed': 'could not probe the video',
    'translate:already-covered': 'already covered',
    identity_correction: 'corrected the media identity',
    identity_correction_skipped: 'identity correction held back — needs a look',
  },
  zh: {
    installed: '字幕已装好',
    no_safe_match: '没找到能放心用的字幕',
    retry_later: '稍后会再试一次',
    error: '遇到问题——会重试',
    'realign:done': '字幕时间轴已校正',
    'realign:parked': '需要人工看一眼',
    'realign:error': '校正时遇到问题',
    'translate:installed': '字幕已翻译好',
    'translate:held': '译文待复核',
    'translate:held-parked': '需要人工看一眼',
    'translate:no-source': '没找到可翻译的原文字幕',
    'translate:extract-failed': '取不出内嵌字幕',
    'translate:probe-failed': '读不了这个视频',
    'translate:already-covered': '已经有字幕了',
    identity_correction: '纠正了影片身份',
    identity_correction_skipped: '身份纠正没落地——需要看一眼',
  },
}

/** recent 完成行的 decision → 人话句 + 语义 tone。未登记的 decision 词（如历史遗留的
 *  'download'，或未来新增值）原样回显该词本身、tone 降级 neutral——诚实兜底，不替 agent 编造
 *  一个可能失真的语气判断（DESIGN.md §8：前端只呈现事实，不替 agent 判断）。 */
export function decisionPhrase(decision: string, lang: Lang = 'en'): DecisionPhrase {
  const text = DECISION_TEXTS[lang][decision]
  if (text === undefined) return { text: decision, tone: 'neutral' }
  return { text, tone: DECISION_TONES[decision] ?? 'neutral' }
}
