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
