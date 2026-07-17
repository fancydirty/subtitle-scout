// web/src/workflow/phrases.test.ts：Workflow 叙事化（验收修复轮一 Task V4，design §B）的静态
// 短语映射表——纯函数，全部英文（DESIGN.md §7：Workflow 区永不本地化）。toolPhrase 把工具名
// 映射成人话动词短语（直播步骤"灵魂卖点"保留，只是不再糊脸工程名）；decisionPhrase 把 decision
// 词映射成 recent 行的人话句 + 语义 tone（铁律④：失败/等待用面向下一步的中性话，红只给点不给
// 块——tone 只是数据，是否渲染红块由消费方的 CSS 决定，这里只锁定 tone 分类本身）。
import { describe, it, expect } from 'vitest'
import { toolPhrase, decisionPhrase } from './phrases.js'

describe('toolPhrase：工具名 → 人话动词短语', () => {
  it('七个静态映射', () => {
    expect(toolPhrase('read_doc')).toBe('Reading the playbook')
    expect(toolPhrase('search_source')).toBe('Searching providers')
    expect(toolPhrase('list_candidates')).toBe('Reviewing candidates')
    expect(toolPhrase('probe_candidate')).toBe('Inspecting a candidate')
    expect(toolPhrase('install_subtitle')).toBe('Installing a subtitle')
    expect(toolPhrase('finalize')).toBe('Wrapping up')
  })

  it('dispatch_ 前缀（含 dispatch_find_subtitle_task/dispatch_realign_task）→ Planning work', () => {
    expect(toolPhrase('dispatch_find_subtitle_task')).toBe('Planning work')
    expect(toolPhrase('dispatch_realign_task')).toBe('Planning work')
    expect(toolPhrase('dispatch_anything_else')).toBe('Planning work')
  })

  it('spawn_sibling_orchestrator/check_series_layout/list_missing_coverage → Planning work', () => {
    expect(toolPhrase('spawn_sibling_orchestrator')).toBe('Planning work')
    expect(toolPhrase('check_series_layout')).toBe('Planning work')
    expect(toolPhrase('list_missing_coverage')).toBe('Planning work')
  })

  it('未映射工具名原样返回（mono 兜底，诚实——不许编造一个假短语）', () => {
    expect(toolPhrase('get_candidate')).toBe('get_candidate')
    expect(toolPhrase('download_candidate')).toBe('download_candidate')
    expect(toolPhrase('some_future_tool')).toBe('some_future_tool')
  })
})

describe('decisionPhrase：decision 词 → { text, tone }', () => {
  it('find_subtitle 四态', () => {
    expect(decisionPhrase('installed')).toEqual({ text: 'subtitles installed', tone: 'ok' })
    expect(decisionPhrase('no_safe_match')).toEqual({ text: 'no safe match found', tone: 'neutral' })
    expect(decisionPhrase('retry_later')).toEqual({ text: 'will retry later', tone: 'neutral' })
    expect(decisionPhrase('error')).toEqual({ text: 'hit a problem — will retry', tone: 'bad' })
  })

  it('realign 三态（decision 存的是 realign:前缀字符串，见 src/v2/realignWorkerTask.ts）', () => {
    expect(decisionPhrase('realign:done')).toEqual({ text: 'library realigned', tone: 'ok' })
    expect(decisionPhrase('realign:parked')).toEqual({ text: 'needs a manual look', tone: 'neutral' })
    expect(decisionPhrase('realign:error')).toEqual({ text: 'realign hit a problem', tone: 'bad' })
  })

  // 铁律④：retry_later 绝不红——tone 必须是 neutral，不是 bad。
  it('retry_later 的 tone 是 neutral，不是 bad（铁律④：等待用中性话，不许染红）', () => {
    expect(decisionPhrase('retry_later').tone).toBe('neutral')
    expect(decisionPhrase('retry_later').tone).not.toBe('bad')
  })

  it('未知 decision → 原词 + neutral（诚实兜底，不编造语气）', () => {
    expect(decisionPhrase('download')).toEqual({ text: 'download', tone: 'neutral' })
    expect(decisionPhrase('some_future_decision')).toEqual({ text: 'some_future_decision', tone: 'neutral' })
  })
})
