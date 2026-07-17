// web/src/workflow/TraceRows.test.tsx：Inngest 式痕迹行渲染——等宽工具名/截断 args/右对齐耗时
// 三段都在场；live=true 时末尾出现蓝点延展行，live=false（默认，回放）时不出现。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TraceRows } from './TraceRows.js'
import type { TraceEvent } from '../api/types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const EVENTS: TraceEvent[] = [
  { runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: 1 },
  { runKey: 'job-1', seq: 1, tool: 'get_candidate', argsSummary: '#3 · fileList 22 entries', resultSummary: 'ok', tookMs: 400, at: 2 },
]

describe('TraceRows', () => {
  it('每行渲染工具名 + args + 格式化后的耗时', () => {
    render(<TraceRows events={EVENTS} />)
    expect(screen.getByText('search_source')).toBeInTheDocument()
    expect(screen.getByText('"silo 中字"')).toBeInTheDocument()
    expect(screen.getByText('1.2s')).toBeInTheDocument()
    expect(screen.getByText('get_candidate')).toBeInTheDocument()
    expect(screen.getByText('400ms')).toBeInTheDocument()
  })

  it('live=false（默认）不渲染在跑行', () => {
    render(<TraceRows events={EVENTS} />)
    expect(screen.queryByTestId('wf-trace-active')).not.toBeInTheDocument()
  })

  it('live=true 渲染末尾在跑行（蓝点延展）', () => {
    render(<TraceRows events={EVENTS} live />)
    expect(screen.getByTestId('wf-trace-active')).toBeInTheDocument()
  })

  it('空事件列表 + live=true 仍渲染在跑行（worker 刚起、还没第一条痕迹）', () => {
    render(<TraceRows events={[]} live />)
    expect(screen.getByTestId('wf-trace-active')).toBeInTheDocument()
  })

  it('长 argsSummary 被截断', () => {
    const longEvent: TraceEvent[] = [
      { runKey: 'job-1', seq: 0, tool: 't', argsSummary: 'x'.repeat(200), resultSummary: '', tookMs: 1, at: 1 },
    ]
    render(<TraceRows events={longEvent} />)
    const rendered = screen.getByText(/x+…/)
    expect(rendered.textContent!.length).toBeLessThan(200)
  })
})

// 验收修复轮一 Task V4（design §B）：phraseMode——Now working 卡的直播步骤保留（灵魂卖点），
// 但工具名走 toolPhrase 映射成人话短语，argsSummary 默认不显示（工程细节收在点开之后的
// RunDetail）。phraseMode 默认 false 时（RunDetail 快照回放）逐字节维持原样——已有测试锁死
// 这条路径，这里只新增 true 路径的断言。
describe('TraceRows：phraseMode（人话短语，argsSummary 不渲染）', () => {
  it('phraseMode=true：已映射工具名显示人话短语，未映射原样 mono 兜底', () => {
    const events: TraceEvent[] = [
      { runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: 1 },
      { runKey: 'job-1', seq: 1, tool: 'get_candidate', argsSummary: '#3', resultSummary: 'ok', tookMs: 400, at: 2 },
    ]
    render(<TraceRows events={events} phraseMode />)
    expect(screen.getByText('Searching providers')).toBeInTheDocument()
    expect(screen.getByText('get_candidate')).toBeInTheDocument() // 未映射原样返回
    expect(screen.getByText('1.2s')).toBeInTheDocument()
    expect(screen.getByText('400ms')).toBeInTheDocument()
  })

  it('phraseMode=true：argsSummary 不在 DOM 里', () => {
    const events: TraceEvent[] = [
      { runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: 1 },
    ]
    render(<TraceRows events={events} phraseMode />)
    expect(screen.queryByText('"silo 中字"')).not.toBeInTheDocument()
  })

  it('phraseMode 默认 false：工具名原样、argsSummary 在场（RunDetail 回放逐字节不变）', () => {
    const events: TraceEvent[] = [
      { runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: 1 },
    ]
    render(<TraceRows events={events} />)
    expect(screen.getByText('search_source')).toBeInTheDocument()
    expect(screen.queryByText('Searching providers')).not.toBeInTheDocument()
    expect(screen.getByText('"silo 中字"')).toBeInTheDocument()
  })
})
