// web/src/workflow/Lanes.test.tsx：Workflow tab 主体的集成测试——三泳道渲染、throttled 行事实
// 呈现、receipts chip 非零才显示、SSE 直播流入 TraceRows、Pass 点开→RunDetail 快照回放、
// Rerun 确认流四态回执各断言一条。Lanes 自己发请求（不像 SeriesPage 那样吃 prop），所以这里
// mock 全局 fetch，同 App.test.tsx 的既有手法（按 URL 路由不同响应体）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { Lanes } from './Lanes.js'
import { __resetTraceStreamForTests } from './traceStream.js'
import type {
  WorkflowPendingDTO, WorkflowPassDTO, WorkflowWorkersDTO, TraceEvent, RunTraceDTO,
} from '../api/types.js'

const NOW = 1_700_000_000_000

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  constructor(_url: string) {
    FakeEventSource.instances.push(this)
  }
  close(): void {}
  emit(e: TraceEvent): void {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent)
  }
}

function requestInfo(input: RequestInfo | URL): { path: string; method: string } {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  return { path: raw.split('?')[0], method: 'GET' }
}

interface Handler {
  path: string
  body: unknown
  method?: string
}

function mockFetchRouted(handlers: Handler[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const { path } = requestInfo(input)
    const method = init?.method ?? 'GET'
    const hit = handlers.find((h) => h.path === path && (h.method ?? 'GET') === method)
    if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as unknown as Response
    return { ok: true, status: 200, json: async () => hit.body } as unknown as Response
  })
}

const EMPTY_PENDING: WorkflowPendingDTO = {
  series: [], movies: [], parked: 0, meta: { roots: [], lastScanAt: null, files: 0 },
}
const EMPTY_WORKERS: WorkflowWorkersDTO = { running: [], recent: [] }

afterEach(() => {
  cleanup()
  __resetTraceStreamForTests()
  FakeEventSource.instances = []
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderLanes() {
  return render(
    <I18nProvider>
      <Lanes />
    </I18nProvider>,
  )
}

describe('Lanes：三泳道皆空 → 整页 empty 态', () => {
  it('渲染 "No active work"', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
      ]),
    )
    renderLanes()
    expect(await screen.findByText('No active work')).toBeInTheDocument()
  })
})

describe('Lanes：Pending 泳道——throttled 行事实呈现（灰、含 next recheck）', () => {
  it('throttled>0 的行显示 "{n} throttled · next recheck {相对}"，missing 计数也在场', async () => {
    // nextRecheckAt 用真实 Date.now()（不是本文件的 NOW 假常量）——Lanes.tsx 内部用真实
    // Date.now() 算 next recheck 倒计时（同 SeriesPage/EpisodeDetail 的既有先例，"now" 不是
    // 从测试注入的），拿假 NOW 算出来的 delta 会是好几年，倒计时会被 formatNextRecheck 的
    // clamp 成 0s，断言就对不上了。刻意加 1 小时余量（而不是刚好 3*24h）——formatNextRecheck
    // 是 floor 语义（同 shell/freshness.ts relAgo 的既有口径），测试固件创建到组件渲染之间的
    // 几毫秒间隙如果让 delta 刚好跌破 72h 整点，会把 "3d" floor 成 "2d"，加一点余量消除这个
    // 边界抖动。
    const pending: WorkflowPendingDTO = {
      series: [
        {
          seriesId: 's1', seriesName: 'Silo', season: 1, missing: 5, throttled: 2,
          nextRecheckAt: Date.now() + 3 * 24 * 60 * 60_000 + 60 * 60_000, sampleReason: 'no candidates found',
        },
      ],
      movies: [], parked: 0, meta: { roots: [], lastScanAt: null, files: 0 },
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: pending },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
      ]),
    )
    renderLanes()

    expect(await screen.findByText('Silo · S1')).toBeInTheDocument()
    expect(screen.getByText('5 missing')).toBeInTheDocument()
    expect(screen.getByText('2 throttled · next recheck in 3d')).toBeInTheDocument()
    expect(screen.getByText('no candidates found')).toBeInTheDocument()
  })

  it('throttled=0 → 不渲染 throttled 行', async () => {
    const pending: WorkflowPendingDTO = {
      series: [
        { seriesId: 's1', seriesName: 'Silo', season: 1, missing: 3, throttled: 0, nextRecheckAt: null, sampleReason: null },
      ],
      movies: [], parked: 0, meta: { roots: [], lastScanAt: null, files: 0 },
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: pending },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
      ]),
    )
    renderLanes()
    await screen.findByText('Silo · S1')
    // 注意：不能用裸 /throttled/ 正则——每行 hover 工具条里恒有 includeThrottled 开关的
    // label/description，两者都含 "throttled" 字样，会跟这里要断言"不存在"的计数行撞车。
    // 只锚定"数字开头 + throttled"这个计数行独有的形状。
    expect(screen.queryByText(/^\d+ throttled/)).not.toBeInTheDocument()
  })
})

describe('Lanes：Passes 泳道——receipts chip 非零才显示', () => {
  it('全零 receipts → 不渲染 chip 排', async () => {
    const pass: WorkflowPassDTO = {
      id: 1, jobId: 10, startedAt: NOW - 1000, finishedAt: NOW, detail: 'no dispatches',
      receipts: { created: 0, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 },
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [pass] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
      ]),
    )
    renderLanes()
    await screen.findByText('no dispatches')
    expect(screen.queryByText(/created|coalesced|revived|blocked|unparsed/)).not.toBeInTheDocument()
  })

  it('非零 receipts → 只显示非零的 chip', async () => {
    const pass: WorkflowPassDTO = {
      id: 2, jobId: 11, startedAt: NOW - 1000, finishedAt: NOW, detail: 'dispatched 4',
      receipts: { created: 3, revived: 0, coalesced: 1, blocked_dormant: 0, unknown: 0 },
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [pass] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
      ]),
    )
    renderLanes()
    expect(await screen.findByText('3 created')).toBeInTheDocument()
    expect(screen.getByText('1 coalesced')).toBeInTheDocument()
    expect(screen.queryByText(/revived/)).not.toBeInTheDocument()
    expect(screen.queryByText(/blocked/)).not.toBeInTheDocument()
  })
})

describe('Lanes：Workers 泳道 + SSE 直播流入 TraceRows', () => {
  function workersWithRunning(): WorkflowWorkersDTO {
    return {
      running: [
        {
          jobId: 42, seriesId: 's1', movieId: null, taskType: 'find_subtitle', seasons: [1],
          startedAtLease: NOW,
          trail: [{ runKey: 'job-42', seq: 0, tool: 'search_source', argsSummary: '"x"', resultSummary: '41 candidates', tookMs: 1200, at: NOW }],
        },
      ],
      recent: [],
    }
  }

  it('初始 trail 来自 workers 端点，渲染在跑行（蓝点）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: workersWithRunning() },
      ]),
    )
    renderLanes()

    expect(await screen.findByText('search_source')).toBeInTheDocument()
    expect(screen.getByText('find_subtitle · s1[S1]')).toBeInTheDocument()
    expect(screen.getByTestId('wf-trace-active')).toBeInTheDocument()
  })

  it('SSE 事件流入后新增一行痕迹（按 seq 追加，不重复）', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: workersWithRunning() },
      ]),
    )
    renderLanes()
    await screen.findByText('search_source')
    expect(FakeEventSource.instances).toHaveLength(1)

    FakeEventSource.instances[0].emit({
      runKey: 'job-42', seq: 1, tool: 'download_candidate', argsSummary: 'E07 · unpacking…', resultSummary: 'ok', tookMs: 4000, at: NOW + 1,
    })

    expect(await screen.findByText('download_candidate')).toBeInTheDocument()
    expect(screen.getByText('4.0s')).toBeInTheDocument()
    // 原有那条痕迹还在——是追加不是替换。
    expect(screen.getByText('search_source')).toBeInTheDocument()
  })
})

describe('Lanes：Pass 点开 → RunDetail 快照回放（回放≠直播，无蓝点）', () => {
  it('点开渲染 detail/receipts + 静态 TraceRows', async () => {
    const pass: WorkflowPassDTO = {
      id: 7, jobId: 20, startedAt: NOW - 1000, finishedAt: NOW, detail: 'dispatched 2 find / 0 realign',
      receipts: { created: 2, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 },
    }
    const trace: RunTraceDTO = {
      events: [{ runKey: 'job-20', seq: 0, tool: 'dispatch_find_subtitle_task', argsSummary: '{}', resultSummary: 'created', tookMs: 12, at: NOW }],
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [pass] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
        { path: '/api/v2/workflow/runs/7/trace', body: trace },
      ]),
    )
    renderLanes()

    const card = await screen.findByText('dispatched 2 find / 0 realign')
    fireEvent.click(card)

    const panel = await screen.findByRole('dialog', { name: 'pass 7' })
    expect(within(panel).getByText('dispatch_find_subtitle_task')).toBeInTheDocument()
    // 回放是静态渲染，不带在跑行。
    expect(within(panel).queryByTestId('wf-trace-active')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'pass 7' })).not.toBeInTheDocument())
  })

  it('该 run 没有痕迹快照（events:[]）→ 空态文案', async () => {
    const pass: WorkflowPassDTO = {
      id: 8, jobId: 21, startedAt: NOW - 1000, finishedAt: NOW, detail: 'no dispatches',
      receipts: { created: 0, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 },
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [pass] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
        { path: '/api/v2/workflow/runs/8/trace', body: { events: [] } },
      ]),
    )
    renderLanes()
    fireEvent.click(await screen.findByText('no dispatches'))
    expect(await screen.findByText('No trace events were captured for this pass.')).toBeInTheDocument()
  })
})

describe('Lanes：Rerun 确认流——AlertDialog → POST → 四态回执各断言一条', () => {
  function pendingWithSeries(): WorkflowPendingDTO {
    return {
      series: [{ seriesId: 's1', seriesName: 'Silo', season: 1, missing: 3, throttled: 0, nextRecheckAt: null, sampleReason: null }],
      movies: [], parked: 0, meta: { roots: [], lastScanAt: null, files: 0 },
    }
  }

  async function openConfirmDialog() {
    renderLanes()
    await screen.findByText('Silo · S1')
    fireEvent.click(screen.getByRole('button', { name: 'Rerun' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText('Rerun this series?')).toBeInTheDocument()
    return dialog
  }

  it('includeThrottled 开关默认关', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: pendingWithSeries() },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
      ]),
    )
    renderLanes()
    await screen.findByText('Silo · S1')
    // Astryx Switch 渲染 role="switch"（不是 "checkbox"，虽然底层 <input type="checkbox">）。
    const toggle = screen.getByRole('switch', { name: 'Include throttled episodes' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
  })

  it('outcome=created → "created — a new task was dispatched."', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: pendingWithSeries() },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
        { path: '/api/v2/workflow/redispatch', method: 'POST', body: { outcome: 'created' } },
      ]),
    )
    const dialog = await openConfirmDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rerun' }))
    expect(await within(dialog).findByText('created — a new task was dispatched.')).toBeInTheDocument()
  })

  it('outcome=revived → "revived — a dormant task was reactivated."', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: pendingWithSeries() },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
        { path: '/api/v2/workflow/redispatch', method: 'POST', body: { outcome: 'revived' } },
      ]),
    )
    const dialog = await openConfirmDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rerun' }))
    expect(await within(dialog).findByText('revived — a dormant task was reactivated.')).toBeInTheDocument()
  })

  it('outcome=coalesced → "coalesced — merged into an in-flight task."（不许显示"已派发新任务"）', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: pendingWithSeries() },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
        { path: '/api/v2/workflow/redispatch', method: 'POST', body: { outcome: 'coalesced', pendingState: 'wanted', intentRefreshed: true } },
      ]),
    )
    const dialog = await openConfirmDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rerun' }))
    expect(await within(dialog).findByText('coalesced — merged into an in-flight task.')).toBeInTheDocument()
    expect(within(dialog).queryByText(/dispatched a new/i)).not.toBeInTheDocument()
  })

  it('outcome=blocked_dormant → "blocked — this series is dormant and was not dispatched."', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: pendingWithSeries() },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
        { path: '/api/v2/workflow/redispatch', method: 'POST', body: { outcome: 'blocked_dormant', lastError: 'no candidates' } },
      ]),
    )
    const dialog = await openConfirmDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rerun' }))
    expect(await within(dialog).findByText('blocked — this series is dormant and was not dispatched.')).toBeInTheDocument()
  })

  it('取消不发请求', async () => {
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/workflow/pending', body: pendingWithSeries() },
      { path: '/api/v2/workflow/passes', body: [] },
      { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const dialog = await openConfirmDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(fetchMock.mock.calls.some((c) => requestInfo(c[0] as RequestInfo).path.includes('redispatch'))).toBe(false)
  })
})
