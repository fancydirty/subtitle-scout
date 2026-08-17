import { describe, it, expect } from 'vitest'
import { stepPhraseKey } from './stepPhrase.js'

describe('stepPhraseKey：tool id → chrome 键（spec §10.1 闭包）', () => {
  it('maps search_source → wb_step_search', () => {
    expect(stepPhraseKey('search_source')).toBe('wb_step_search')
  })
  it('maps install_sidecar → wb_step_install', () => {
    expect(stepPhraseKey('install_sidecar')).toBe('wb_step_install')
  })
  it('unknown → wb_step_working', () => {
    expect(stepPhraseKey('update_row')).toBe('wb_step_working')
    expect(stepPhraseKey('not_a_tool')).toBe('wb_step_working')
  })

  it('字幕/识别 search 桶 → wb_step_search', () => {
    expect(stepPhraseKey('search_tmdb')).toBe('wb_step_search')
    expect(stepPhraseKey('get_tmdb_details')).toBe('wb_step_search')
    expect(stepPhraseKey('write_identified_media')).toBe('wb_step_search')
  })

  it('字幕/识别 review 桶 → wb_step_review', () => {
    expect(stepPhraseKey('list_candidates')).toBe('wb_step_review')
    expect(stepPhraseKey('get_candidate')).toBe('wb_step_review')
  })

  it('字幕 download_candidate → wb_step_download', () => {
    expect(stepPhraseKey('download_candidate')).toBe('wb_step_download')
  })

  it('字幕 install_subtitle → wb_step_install', () => {
    expect(stepPhraseKey('install_subtitle')).toBe('wb_step_install')
  })

  it('finalize → wb_step_wrapup（字幕与翻译共用）', () => {
    expect(stepPhraseKey('finalize')).toBe('wb_step_wrapup')
  })

  it('翻译 search 桶 → wb_step_search', () => {
    expect(stepPhraseKey('resolve_source')).toBe('wb_step_search')
    expect(stepPhraseKey('read_doc')).toBe('wb_step_search')
    expect(stepPhraseKey('fetch_tmdb_context')).toBe('wb_step_search')
    expect(stepPhraseKey('fetch_series_target_subs')).toBe('wb_step_search')
    expect(stepPhraseKey('fetch_wiki_context')).toBe('wb_step_search')
    expect(stepPhraseKey('materialize_agent_view')).toBe('wb_step_search')
    expect(stepPhraseKey('read_workspace_doc')).toBe('wb_step_search')
    expect(stepPhraseKey('lookup_glossary')).toBe('wb_step_search')
    expect(stepPhraseKey('freeze_glossary')).toBe('wb_step_search')
  })

  it('翻译 review 桶 → wb_step_review', () => {
    expect(stepPhraseKey('list_rows')).toBe('wb_step_review')
    expect(stepPhraseKey('get_window')).toBe('wb_step_review')
    expect(stepPhraseKey('run_critic')).toBe('wb_step_review')
    expect(stepPhraseKey('run_structural_gate')).toBe('wb_step_review')
  })

  it('翻译 install 桶 → wb_step_install', () => {
    expect(stepPhraseKey('merge_to_srt')).toBe('wb_step_install')
  })

  it('点名未知 → wb_step_working', () => {
    expect(stepPhraseKey('update_rows')).toBe('wb_step_working')
    expect(stepPhraseKey('update_summary')).toBe('wb_step_working')
  })
})
