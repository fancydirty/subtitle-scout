import { describe, it, expect } from 'vitest'
import { stageOf, stepActionKey } from './stepPhrase.js'

describe('stepPhrase：阶段 + 动作两层', () => {
  it('字幕流：search_source → 找源阶段', () => {
    expect(stageOf('search_source')).toBe('source')
  })
  it('字幕流：download_candidate → 下载阶段', () => {
    expect(stageOf('download_candidate')).toBe('download')
  })
  it('翻译流：freeze_glossary → 术语表阶段', () => {
    expect(stageOf('freeze_glossary')).toBe('glossary')
  })
  it('翻译流：update_row → 逐句翻译阶段', () => {
    expect(stageOf('update_row')).toBe('translate')
  })
  it('未知工具 → working 兜底', () => {
    expect(stageOf('unknown_tool')).toBe('working')
  })
  it('动作 key：update_row → wb_step_translate', () => {
    expect(stepActionKey('update_row')).toBe('wb_step_translate')
  })
  it('动作 key：search_source → wb_step_search（既有）', () => {
    expect(stepActionKey('search_source')).toBe('wb_step_search')
  })

  // ── 2026-08-22 视觉验收抓到的真实缺陷 ────────────────────────────────────
  // 生产实测：翻译跑到 get_window 时步骤条**整个消失**。根因是 get_window 被归为
  // 'review'，而 TRANSLATE_STAGES = [source, glossary, translate, install] 里没有
  // review 槽位 → indexOf 返回 -1 → StageBar 提前 return null。
  // get_window / list_rows 是逐句翻译循环的取窗口/读行，本就属于 translate 阶段。
  it('🔴 翻译流：get_window → translate 阶段（不是 review，否则步骤条塌掉）', () => {
    expect(stageOf('get_window')).toBe('translate')
  })
  it('🔴 翻译流：list_rows → translate 阶段（同上，逐句循环内的读行）', () => {
    expect(stageOf('list_rows')).toBe('translate')
  })
  it('🔴 get_window 的动作文案是"逐句翻译"，不是字幕流的"正在看候选"', () => {
    expect(stepActionKey('get_window')).toBe('wb_step_translate')
  })
  it('字幕流：list_candidates 仍是 review（不受上面改动牵连）', () => {
    expect(stageOf('list_candidates')).toBe('review')
  })
})
