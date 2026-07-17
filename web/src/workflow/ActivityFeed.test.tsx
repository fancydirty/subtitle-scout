// web/src/workflow/ActivityFeed.test.tsx：Activity 列（宽列）主体——Now working 卡（人话卡头 +
// phraseMode 直播）、recent 完成行（人话句 + tone 圆点）、Orchestrator log 折叠区（原 PassCard
// 内容整体收纳），验收修复轮一 Task V4（design §B）逐条覆盖。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { ActivityFeed } from './ActivityFeed.js'
import { __resetTraceStreamForTests } from './traceStream.js'
import type { Async } from '../api/hooks.js'
import type {
  WorkflowWorkersDTO, WorkflowPassDTO, WorkflowRunningWorkerDTO, WorkflowRecentRunDTO,
} from '../api/types.js'

const NOW = 1_700_000_000_000

function asyncOf<T>(data: T | null): Async<T> {
  return { data, loading: data == null, error: null, reload: () => {} }
}

const EMPTY_WORKERS: WorkflowWorkersDTO = { running: [], recent: [], installedLast24h: 0 }

afterEach(() => {
  cleanup()
  __resetTraceStreamForTests()
  vi.restoreAllMocks()
})

function renderFeed(props: Partial<Parameters<typeof ActivityFeed>[0]> = {}) {
  const onOpenRun = vi.fn()
  const onOpenPass = vi.fn()
  const utils = render(
    <I18nProvider>
      <ActivityFeed
        workers={asyncOf(EMPTY_WORKERS)}
        passes={asyncOf<WorkflowPassDTO[]>([])}
        now={NOW}
        onOpenRun={onOpenRun}
        onOpenPass={onOpenPass}
        {...props}
      />
    </I18nProvider>,
  )
  return { ...utils, onOpenRun, onOpenPass }
}

describe('ActivityFeed：Now working 卡——人话卡头 + phraseMode 直播', () => {
  function runningWorker(overrides: Partial<WorkflowRunningWorkerDTO> = {}): WorkflowRunningWorkerDTO {
    return {
      jobId: 42, seriesId: 's1', movieId: null, taskType: 'find_subtitle', seasons: [1],
      seriesName: null, movieName: null,
      startedAtLease: NOW - 5 * 60_000,
      trail: [{ runKey: 'job-42', seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: NOW }],
      ...overrides,
    }
  }

  it('卡头 = "Searching subtitles for {target}" + 已跑时长', () => {
    renderFeed({ workers: asyncOf({ running: [runningWorker()], recent: [], installedLast24h: 0 }) })
    expect(screen.getByText('Searching subtitles for s1')).toBeInTheDocument()
    expect(screen.getByText('5m ago')).toBeInTheDocument()
  })

  // 收官补刀（spec §B 铁律①）：running 行带 seriesName 时卡头主语用名字不用 id。
  it('卡头有 seriesName 时用名字，不再显示 tmdb id', () => {
    renderFeed({
      workers: asyncOf({ running: [runningWorker({ seriesName: 'The Rig' })], recent: [], installedLast24h: 0 }),
    })
    expect(screen.getByText('Searching subtitles for The Rig')).toBeInTheDocument()
    expect(screen.queryByText('Searching subtitles for s1')).not.toBeInTheDocument()
  })

  it('realign 任务 → "Tidying up {target}"', () => {
    renderFeed({
      workers: asyncOf({ running: [runningWorker({ taskType: 'realign', seriesId: 's2' })], recent: [], installedLast24h: 0 }),
    })
    expect(screen.getByText('Tidying up s2')).toBeInTheDocument()
  })

  it('phraseMode：工具名已映射（Searching providers），argsSummary 不在 DOM', () => {
    renderFeed({ workers: asyncOf({ running: [runningWorker()], recent: [], installedLast24h: 0 }) })
    expect(screen.getByText('Searching providers')).toBeInTheDocument()
    expect(screen.queryByText('search_source')).not.toBeInTheDocument()
    expect(screen.queryByText('"silo 中字"')).not.toBeInTheDocument()
  })

  it('无运行中的 worker → 空态文案', () => {
    renderFeed()
    expect(screen.getByText('No workers running right now.')).toBeInTheDocument()
  })
})

describe('ActivityFeed：recent 完成行——人话句 + tone 圆点', () => {
  function recentRow(overrides: Partial<WorkflowRecentRunDTO> = {}): WorkflowRecentRunDTO {
    return {
      id: 5, jobId: 10, decision: 'installed', detail: '3 集入账', finishedAt: NOW - 60_000,
      seriesId: 's9', movieId: null, seriesName: 'Silo', movieName: null,
      ...overrides,
    }
  }

  it('installed 行：主语=剧名，短语="subtitles installed"，右对齐相对时间', () => {
    renderFeed({ workers: asyncOf({ running: [], recent: [recentRow()], installedLast24h: 0 }) })
    expect(screen.getByText('Silo')).toBeInTheDocument()
    expect(screen.getByText('subtitles installed')).toBeInTheDocument()
    expect(screen.getByText('1m ago')).toBeInTheDocument()
  })

  it('retry_later 行：灰点（tone=neutral），不是红', () => {
    renderFeed({
      workers: asyncOf({ running: [], recent: [recentRow({ id: 6, decision: 'retry_later' })], installedLast24h: 0 }),
    })
    const dot = screen.getByRole('img', { name: 'will retry later' })
    expect(dot).toHaveAttribute('data-variant', 'neutral')
  })

  it('error 行：红点（tone=bad→error variant），行本身无额外红底块 class', () => {
    renderFeed({
      workers: asyncOf({ running: [], recent: [recentRow({ id: 7, decision: 'error' })], installedLast24h: 0 }),
    })
    const dot = screen.getByRole('img', { name: 'hit a problem — will retry' })
    expect(dot).toHaveAttribute('data-variant', 'error')
    const row = screen.getByRole('button', { name: /hit a problem/ })
    // 行的 class 是恒定的静态类（不随 tone 变化拼出额外的背景色 class）——铁律④：红只给点不给块。
    expect(row.className).toBe('wf-activity-row')
  })

  it('剧名/片名皆缺失 → 降级显示 id（诚实兜底）', () => {
    renderFeed({
      workers: asyncOf({
        running: [], installedLast24h: 0,
        recent: [recentRow({ id: 8, seriesId: 's-empty', seriesName: null, movieName: null })],
      }),
    })
    expect(screen.getByText('s-empty')).toBeInTheDocument()
  })

  it('点开一行 → onOpenRun 收到该行原始对象', () => {
    const row = recentRow()
    const { onOpenRun } = renderFeed({ workers: asyncOf({ running: [], recent: [row], installedLast24h: 0 }) })
    fireEvent.click(screen.getByText('Silo'))
    expect(onOpenRun).toHaveBeenCalledWith(row)
  })

  it('无完成行 → 空态文案', () => {
    renderFeed()
    expect(screen.getByText('No recent completions yet.')).toBeInTheDocument()
  })
})

describe('ActivityFeed：Orchestrator log 折叠区——默认收起，展开后见回执 chip', () => {
  function pass(overrides: Partial<WorkflowPassDTO> = {}): WorkflowPassDTO {
    return {
      id: 1, jobId: 10, startedAt: NOW - 2000, finishedAt: NOW - 1000, detail: 'dispatched 2 find / 0 realign',
      receipts: { created: 2, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 },
      ...overrides,
    }
  }

  it('默认折叠（aria-expanded=false）；展开后回执 chip 可见', async () => {
    renderFeed({ passes: asyncOf([pass()]) })
    const trigger = screen.getByRole('button', { name: 'Orchestrator log' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('2 created')).toBeInTheDocument()
  })

  it('点开一条 pass 行 → onOpenPass 收到该行原始对象', () => {
    const p = pass()
    const { onOpenPass } = renderFeed({ passes: asyncOf([p]) })
    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator log' }))
    fireEvent.click(screen.getByText('dispatched 2 find / 0 realign'))
    expect(onOpenPass).toHaveBeenCalledWith(p)
  })

  it('无 pass → 空态文案（展开后可见）', () => {
    renderFeed({ passes: asyncOf<WorkflowPassDTO[]>([]) })
    fireEvent.click(screen.getByRole('button', { name: 'Orchestrator log' }))
    expect(screen.getByText('No orchestrator passes yet.')).toBeInTheDocument()
  })
})
