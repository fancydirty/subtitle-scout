// web/src/workflow/phrases.ts：Workflow 叙事化（验收修复轮一 Task V4，design §B）的静态短语
// 映射——纯函数，全部英文（DESIGN.md §7：Workflow 区永不本地化，同 text.ts/time.ts 既有先例，
// 不进 i18n 表）。两张表：
//  - toolPhrase：直播步骤的工具名 → 人话动词短语（"灵魂卖点"保留：仍是逐步骤直播，只是工程
//    工具名换成人话，argsSummary 默认不显示——TraceRows phraseMode 消费这个函数）。
//  - decisionPhrase：一条 recent 完成行的 decision 词 → { text, tone }，tone 供调用方选圆点色
//    （铁律④：失败/等待用面向下一步的中性话，红只给点不给块——tone='bad' 只染一个 6px 圆点，
//    不许调用方拿它去铺红底色块）。
const TOOL_PHRASES: Record<string, string> = {
  read_doc: 'Reading the playbook',
  search_source: 'Searching providers',
  list_candidates: 'Reviewing candidates',
  probe_candidate: 'Inspecting a candidate',
  install_subtitle: 'Installing a subtitle',
  finalize: 'Wrapping up',
  // 编排层规划类工具——不是内容产出步骤，统一读作"在规划工作"。
  spawn_sibling_orchestrator: 'Planning work',
  check_series_layout: 'Planning work',
  list_missing_coverage: 'Planning work',
}

const PLANNING_PHRASE = 'Planning work'

/** 直播/回放痕迹行的工具名 → 人话短语。dispatch_ 前缀（dispatch_find_subtitle_task/
 *  dispatch_realign_task 等，未来新增的 dispatch_* 工具同样落入这条前缀规则，不需要逐个登记）
 *  与三个编排规划工具统一读作 "Planning work"；其余未登记的工具名原样返回（mono 兜底——诚实
 *  呈现"这个工具还没有人话翻译"，不编造一个可能文不对题的短语）。 */
export function toolPhrase(tool: string): string {
  if (tool.startsWith('dispatch_')) return PLANNING_PHRASE
  return TOOL_PHRASES[tool] ?? tool
}

export type DecisionTone = 'ok' | 'neutral' | 'bad'
export interface DecisionPhrase {
  text: string
  tone: DecisionTone
}

const DECISION_PHRASES: Record<string, DecisionPhrase> = {
  installed: { text: 'subtitles installed', tone: 'ok' },
  no_safe_match: { text: 'no safe match found', tone: 'neutral' },
  // 铁律④：等待/停牌是面向下一步的中性事实，不是失败——tone 恒 neutral（灰点），绝不 bad（红）。
  retry_later: { text: 'will retry later', tone: 'neutral' },
  error: { text: 'hit a problem — will retry', tone: 'bad' },
  'realign:done': { text: 'library realigned', tone: 'ok' },
  'realign:parked': { text: 'needs a manual look', tone: 'neutral' },
  'realign:error': { text: 'realign hit a problem', tone: 'bad' },
}

/** recent 完成行的 decision → 人话句 + 语义 tone。未登记的 decision 词（如历史遗留的
 *  'download'，或未来新增值）原样回显该词本身、tone 降级 neutral——诚实兜底，不替 agent 编造
 *  一个可能失真的语气判断（DESIGN.md §8：前端只呈现事实，不替 agent 判断）。 */
export function decisionPhrase(decision: string): DecisionPhrase {
  return DECISION_PHRASES[decision] ?? { text: decision, tone: 'neutral' }
}
