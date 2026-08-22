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
})
