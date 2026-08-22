// web/src/workbench/stepPhrase.ts —— 工具 id → 两层映射：阶段（步骤条节点）+ 阶段内动作
// （日志行 chrome 键，spec §10.1 闭包）。未知一律 working / wb_step_working；
// 永不把 raw tool 字符串交出去（那会画上屏幕）。
import type { TKey } from '../i18n/useT.js'

/** 工作台阶段（步骤条的节点）。unknown 一律 working。 */
export type Stage = 'source' | 'glossary' | 'translate' | 'review' | 'download' | 'install' | 'wrapup' | 'working'

const STAGE: Record<string, Stage> = {
  // 搜索/选源
  search_source: 'source', search_tmdb: 'source', get_tmdb_details: 'source',
  resolve_source: 'source', fetch_tmdb_context: 'source', fetch_series_target_subs: 'source',
  fetch_wiki_context: 'source', materialize_agent_view: 'source', read_workspace_doc: 'source',
  read_doc: 'source', write_identified_media: 'source',
  // 术语表
  lookup_glossary: 'glossary', freeze_glossary: 'glossary',
  // 逐句翻译。get_window / list_rows 是这个循环内部的取窗口/读行——**必须归 translate**：
  // 归 'review' 的话，TRANSLATE_STAGES（source/glossary/translate/install）里没有 review
  // 槽位 → StageBar 的 indexOf 返回 -1 → 翻译跑到 get_window 时步骤条整个塌掉。
  // 2026-08-22 本地 e2e 视觉验收实测到这个形态（PLUTO S01E02，194 cue 那轮）。
  update_row: 'translate', update_rows: 'translate',
  get_window: 'translate', list_rows: 'translate',
  // 审核/校验（字幕流的选候选环节）
  list_candidates: 'review', get_candidate: 'review',
  run_critic: 'review', run_structural_gate: 'review',
  // 下载
  download_candidate: 'download',
  // 装盘
  install_subtitle: 'install', merge_to_srt: 'install', install_sidecar: 'install',
  // 收官
  finalize: 'wrapup',
}

export function stageOf(tool: string): Stage {
  return STAGE[tool] ?? 'working'
}

/** 阶段内动作的 i18n key（日志行文案）。 */
export function stepActionKey(tool: string): TKey {
  switch (stageOf(tool)) {
    case 'source': return 'wb_step_search'
    case 'glossary': return 'wb_step_glossary'
    case 'translate': return 'wb_step_translate'
    case 'review': return 'wb_step_review'
    case 'download': return 'wb_step_download'
    case 'install': return 'wb_step_install'
    case 'wrapup': return 'wb_step_wrapup'
    default: return 'wb_step_working'
  }
}

// 向后兼容别名：现有调用方（ActivityPage）在 Task 5 切到 stepActionKey 前继续可用。
export const stepPhraseKey = stepActionKey
