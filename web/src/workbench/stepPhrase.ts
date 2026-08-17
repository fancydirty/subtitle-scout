// web/src/workbench/stepPhrase.ts —— 工具 id → 在跑卡 chrome 键（spec §10.1 闭包）。
// 未知一律 wb_step_working；永不把 raw tool 字符串交出去（那会画上屏幕）。
import type { TKey } from '../i18n/useT.js'

type StepChrome =
  | 'wb_step_search'
  | 'wb_step_review'
  | 'wb_step_download'
  | 'wb_step_install'
  | 'wb_step_wrapup'
  | 'wb_step_working'

const STEP_PHRASE: Record<string, StepChrome> = {
  search_source: 'wb_step_search',
  search_tmdb: 'wb_step_search',
  get_tmdb_details: 'wb_step_search',
  write_identified_media: 'wb_step_search',
  resolve_source: 'wb_step_search',
  read_doc: 'wb_step_search',
  fetch_tmdb_context: 'wb_step_search',
  fetch_series_target_subs: 'wb_step_search',
  fetch_wiki_context: 'wb_step_search',
  materialize_agent_view: 'wb_step_search',
  read_workspace_doc: 'wb_step_search',
  lookup_glossary: 'wb_step_search',
  freeze_glossary: 'wb_step_search',

  list_candidates: 'wb_step_review',
  get_candidate: 'wb_step_review',
  list_rows: 'wb_step_review',
  get_window: 'wb_step_review',
  run_critic: 'wb_step_review',
  run_structural_gate: 'wb_step_review',

  download_candidate: 'wb_step_download',

  install_subtitle: 'wb_step_install',
  merge_to_srt: 'wb_step_install',
  install_sidecar: 'wb_step_install',

  finalize: 'wb_step_wrapup',
}

export function stepPhraseKey(tool: string): TKey {
  return STEP_PHRASE[tool] ?? 'wb_step_working'
}
