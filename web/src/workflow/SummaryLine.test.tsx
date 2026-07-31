// web/src/workflow/SummaryLine.test.tsx：顶部人话总览行——三片段渲染 + 数据源未到时省略片段
// （不显示编造的 0 占位假话，验收修复轮一 Task V4，design §B）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SummaryLine } from './SummaryLine.js'
import type { Async } from '../api/hooks.js'
import type { WorkflowPendingDTO, WorkflowWorkersDTO } from '../api/types.js'

afterEach(() => cleanup())

function asyncOf<T>(data: T | null): Async<T> {
  return { data, loading: data == null, error: null, reload: () => {} }
}

function pendingWith(seriesCount: number, movieCount: number): WorkflowPendingDTO {
  return {
    series: Array.from({ length: seriesCount }, (_, i) => ({
      seriesId: `s${i}`, seriesName: `S${i}`, season: 1, missing: 1, throttled: 0, nextRecheckAt: null, sampleReason: null,
    })),
    movies: Array.from({ length: movieCount }, (_, i) => ({
      id: `m${i}`, name: `M${i}`, missing: 1 as const, throttled: 0 as const, nextRecheckAt: null, sampleReason: null,
    })),
    parked: 0,
    meta: { roots: [], lastScanAt: null, files: 0 , lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0},
  }
}

function workersWith(installedLast24h: number, runningCount: number): WorkflowWorkersDTO {
  return {
    running: Array.from({ length: runningCount }, (_, i) => ({
      jobId: i, seriesId: `s${i}`, movieId: null, taskType: 'find_subtitle', seasons: null, seriesName: null, movieName: null, posterPath: null, backdropPath: null, startedAtLease: 1, trail: [],
    })),
    recent: [],
    translatedLast24h: 0,
    held: [],
    installedLast24h,
    providerQuota: [],
  }
}

describe('SummaryLine：三片段渲染', () => {
  it('三个数据源都到位 → 完整句子（Watching N gaps · N episodes installed in the last 24h · N agent(s) working）', () => {
    render(<SummaryLine pending={asyncOf(pendingWith(10, 3))} workers={asyncOf(workersWith(37, 1))} />)
    const el = screen.getByTestId('wf-summary-line')
    expect(el.textContent).toBe('Watching 13 gaps · 37 episodes installed in the last 24h · 1 agent working')
  })

  it('running=2 → "2 agents working"（复数）', () => {
    render(<SummaryLine pending={asyncOf(pendingWith(0, 0))} workers={asyncOf(workersWith(0, 2))} />)
    expect(screen.getByTestId('wf-summary-line').textContent).toBe(
      'Watching 0 gaps · 0 episodes installed in the last 24h · 2 agents working',
    )
  })

  it('UX-P0:translatedLast24h>0 → 增加 "N translated" 片段;=0 不显示(同不编造 0 占位哲学)', () => {
    const w = workersWith(0, 0)
    render(<SummaryLine pending={asyncOf(pendingWith(0, 0))} workers={asyncOf({ ...w, translatedLast24h: 3 })} />)
    expect(screen.getByTestId('wf-summary-line').textContent).toContain('3 translated')
  })
})

describe('SummaryLine：数据源未到 → 省略对应片段（不编造 0 占位假话）', () => {
  it('pending 未到（data=null）→ 省略 gaps 片段，只剩 installed/agents 两段', () => {
    render(<SummaryLine pending={asyncOf<WorkflowPendingDTO>(null)} workers={asyncOf(workersWith(37, 1))} />)
    const text = screen.getByTestId('wf-summary-line').textContent!
    expect(text).not.toContain('gaps')
    expect(text).toBe('37 episodes installed in the last 24h · 1 agent working')
  })

  it('workers 未到（data=null）→ 省略 installed 与 agents 两段，只剩 gaps', () => {
    render(<SummaryLine pending={asyncOf(pendingWith(13, 0))} workers={asyncOf<WorkflowWorkersDTO>(null)} />)
    const text = screen.getByTestId('wf-summary-line').textContent!
    expect(text).toBe('Watching 13 gaps')
    expect(text).not.toContain('installed')
    expect(text).not.toContain('working')
  })

  it('两个数据源都未到 → 整行不渲染', () => {
    render(<SummaryLine pending={asyncOf<WorkflowPendingDTO>(null)} workers={asyncOf<WorkflowWorkersDTO>(null)} />)
    expect(screen.queryByTestId('wf-summary-line')).not.toBeInTheDocument()
  })
})

// ── 字幕校验推进度（2026-07-31）────────────────────────────────────────────
// 巡检此前只在容器日志里可见，界面上一个"全是绿点"的库有两种可能（真没问题 / 巡检没在跑），
// 用户无从分辨。这个片段让推进度可见，但只在铺量期出现。
describe('SummaryLine：字幕校验推进度', () => {
  const withVerify = (over: Partial<WorkflowPendingDTO['meta']>) =>
    asyncOf<WorkflowPendingDTO>({
      series: [], movies: [], parked: 0,
      meta: { roots: [], lastScanAt: null, files: 0,
        lastVerifySweepAt: 1_700_000_000_000, verifiedItems: 40, verifiableItems: 282, ...over },
    })

  it('铺量期显示 checked N of M', () => {
    render(<SummaryLine pending={withVerify({})} workers={asyncOf<WorkflowWorkersDTO>(null)} />)
    const t = screen.getByTestId('wf-summary-line').textContent!
    expect(t).toContain('subtitle timing checked on')
    expect(t).toContain('40')
    expect(t).toContain('282')
  })

  // 铺满之后这个片段消失——"282 / 282" 是一句没有信息的废话，而 SummaryLine 的既有哲学
  // 就是不给不携带信息的占位。
  it('全部检完（done === total）→ 片段消失', () => {
    render(<SummaryLine pending={withVerify({ verifiedItems: 282 })} workers={asyncOf<WorkflowWorkersDTO>(null)} />)
    expect(screen.queryByTestId('wf-summary-line')?.textContent ?? '').not.toContain('subtitle timing')
  })

  // 从未跑过时不显示：0/282 会被读成"这功能坏了"，而真相是还没到第一个时间门。
  it('巡检从未跑过（lastVerifySweepAt=null）→ 不显示，不谎报 0', () => {
    render(<SummaryLine
      pending={withVerify({ lastVerifySweepAt: null, verifiedItems: 0 })}
      workers={asyncOf<WorkflowWorkersDTO>(null)} />)
    expect(screen.queryByTestId('wf-summary-line')?.textContent ?? '').not.toContain('subtitle timing')
  })

  it('没有可校验条目（空库）→ 不显示', () => {
    render(<SummaryLine
      pending={withVerify({ verifiedItems: 0, verifiableItems: 0 })}
      workers={asyncOf<WorkflowWorkersDTO>(null)} />)
    expect(screen.queryByTestId('wf-summary-line')?.textContent ?? '').not.toContain('subtitle timing')
  })
})
