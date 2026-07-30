// web/src/workflow/TraceRows.test.tsx：Inngest 式痕迹行渲染——等宽工具名/截断 args/右对齐耗时
// 三段都在场；live=true 时末尾出现蓝点延展行，live=false（默认，回放）时不出现。
//
// 2026-07-30：phraseMode 的人话短语跟随 UI 语言（DESIGN.md §7 改版），组件因此依赖
// <I18nProvider>。renderTrace 通过 initialLang 显式把语言锁成 en——**不依赖 jsdom 的
// navigator.language**（实测是 'en-US'，恰好探测成 en，但那是隐式环境依赖：CI locale 或 jsdom
// 版本一变就会莫名其妙地开始渲染中文，断言随之崩塌）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { TraceRows } from './TraceRows.js'
import type { TraceEvent } from '../api/types.js'

/** 以显式 en 渲染 TraceRows（语言锁定见文件头注）。 */
function renderTrace(ui: React.ReactElement) {
  return render(<I18nProvider initialLang="en">{ui}</I18nProvider>)
}

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
    renderTrace(<TraceRows events={EVENTS} />)
    expect(screen.getByText('search_source')).toBeInTheDocument()
    expect(screen.getByText('"silo 中字"')).toBeInTheDocument()
    expect(screen.getByText('1.2s')).toBeInTheDocument()
    expect(screen.getByText('get_candidate')).toBeInTheDocument()
    expect(screen.getByText('400ms')).toBeInTheDocument()
  })

  it('live=false（默认）不渲染在跑行', () => {
    renderTrace(<TraceRows events={EVENTS} />)
    expect(screen.queryByTestId('wf-trace-active')).not.toBeInTheDocument()
  })

  it('live=true 渲染末尾在跑行（蓝点延展）', () => {
    renderTrace(<TraceRows events={EVENTS} live />)
    expect(screen.getByTestId('wf-trace-active')).toBeInTheDocument()
  })

  it('空事件列表 + live=true 仍渲染在跑行（worker 刚起、还没第一条痕迹）', () => {
    renderTrace(<TraceRows events={[]} live />)
    expect(screen.getByTestId('wf-trace-active')).toBeInTheDocument()
  })

  it('长 argsSummary 被截断', () => {
    const longEvent: TraceEvent[] = [
      { runKey: 'job-1', seq: 0, tool: 't', argsSummary: 'x'.repeat(200), resultSummary: '', tookMs: 1, at: 1 },
    ]
    renderTrace(<TraceRows events={longEvent} />)
    const rendered = screen.getByText(/x+…/)
    expect(rendered.textContent!.length).toBeLessThan(200)
  })
})

// 验收修复轮一 Task V4（design §B）：phraseMode——Now working 卡的直播步骤保留（灵魂卖点），
// 但工具名走 toolPhrase 映射成人话短语，argsSummary 默认不显示（工程细节收在点开之后的
// RunDetail）。phraseMode 默认 false 时（RunDetail 快照回放）逐字节维持原样——已有测试锁死
// 这条路径，这里只新增 true 路径的断言。
describe('TraceRows：phraseMode（人话短语，argsSummary 不渲染）', () => {
  it('phraseMode=true：已映射工具名显示人话短语，未映射原样 mono 兜底（回归锁：get_candidate 此前漏登记，2026-07-30 补上）', () => {
    const events: TraceEvent[] = [
      { runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: 1 },
      { runKey: 'job-1', seq: 1, tool: 'get_candidate', argsSummary: '#3', resultSummary: 'ok', tookMs: 400, at: 2 },
      { runKey: 'job-1', seq: 2, tool: 'some_future_tool', argsSummary: 'x', resultSummary: 'ok', tookMs: 100, at: 3 },
    ]
    renderTrace(<TraceRows events={events} phraseMode />)
    expect(screen.getByText('Searching providers')).toBeInTheDocument()
    expect(screen.getByText('Inspecting a candidate')).toBeInTheDocument() // 此前漏登记、现已补上
    expect(screen.getByText('some_future_tool')).toBeInTheDocument() // 未映射原样返回
  })

  // 2026-07-30 用户裁决（DESIGN.md §7 改版）：跟随 UI 语言。renderTrace 默认锁 en（见 beforeEach），
  // 这条显式切 zh 验"中文确实被渲染"。
  it('phraseMode=true + zh：渲染中文短语', () => {
    const events: TraceEvent[] = [
      { runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: 'x', resultSummary: 'y', tookMs: 1200, at: 1 },
      { runKey: 'job-1', seq: 1, tool: 'download_candidate', argsSummary: 'x', resultSummary: 'y', tookMs: 400, at: 2 },
    ]
    render(<I18nProvider initialLang="zh"><TraceRows events={events} phraseMode /></I18nProvider>)
    expect(screen.getByText('正在搜字幕来源')).toBeInTheDocument()
    expect(screen.getByText('正在下载字幕')).toBeInTheDocument()
  })

  it('phraseMode=true：argsSummary 不在 DOM 里', () => {
    const events: TraceEvent[] = [
      { runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: 1 },
    ]
    renderTrace(<TraceRows events={events} phraseMode />)
    expect(screen.queryByText('"silo 中字"')).not.toBeInTheDocument()
  })

  it('phraseMode 默认 false：工具名原样、argsSummary 在场（RunDetail 回放逐字节不变）', () => {
    const events: TraceEvent[] = [
      { runKey: 'job-1', seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: 1 },
    ]
    renderTrace(<TraceRows events={events} />)
    expect(screen.getByText('search_source')).toBeInTheDocument()
    expect(screen.queryByText('Searching providers')).not.toBeInTheDocument()
    expect(screen.getByText('"silo 中字"')).toBeInTheDocument()
  })
})
