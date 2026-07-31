// web/src/workflow/Lanes.test.tsx：Workflow tab 主体的集成测试——两列布局（Gaps | Activity，
// 验收修复轮一 Task V4）、throttled 行事实呈现、receipts chip 非零才显示（Orchestrator log
// 折叠区展开后）、SSE 直播流入 TraceRows（phraseMode 人话短语）、recent 行/pass 行点开→RunDetail
// 快照回放、Rerun 确认流四态回执各断言一条。Lanes 自己发请求（不像 SeriesPage 那样吃 prop），
// 所以这里 mock 全局 fetch，同 App.test.tsx 的既有手法（按 URL 路由不同响应体）。
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
  series: [], movies: [], parked: 0, meta: { roots: [], lastScanAt: null, files: 0 , lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0},
}
const EMPTY_WORKERS: WorkflowWorkersDTO = { running: [], recent: [], installedLast24h: 0, translatedLast24h: 0, held: [], providerQuota: [] }

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

async function openOrchestratorLog() {
  const trigger = await screen.findByRole('button', { name: 'Orchestrator log' })
  expect(trigger).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(trigger)
  expect(trigger).toHaveAttribute('aria-expanded', 'true')
  return trigger
}

describe('Lanes：两列皆空 → 整页 empty 态', () => {
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

describe('Lanes：Gaps 列（PendingLane 原样）——throttled 行事实呈现（灰、含 next recheck）', () => {
  it('throttled>0 的行显示 "{n} throttled · next recheck {相对}"，missing 计数也在场', async () => {
    // nextRecheckAt 用真实 Date.now()（不是本文件的 NOW 假常量）——Lanes.tsx 内部用真实
    // Date.now() 算 next recheck 倒计时（同 SeriesPage/EpisodeDetail 的既有先例，"now" 不是
    // 从测试注入的），拿假 NOW 算出来的 delta 会是好几年，倒计时会被 formatNextRecheck 的
    // clamp 成 0s，断言就对不上了。刻意加 1 小时余量消除边界抖动（同既有先例）。
    const pending: WorkflowPendingDTO = {
      series: [
        {
          seriesId: 's1', seriesName: 'Silo', season: 1, missing: 5, throttled: 2,
          nextRecheckAt: Date.now() + 3 * 24 * 60 * 60_000 + 60 * 60_000, sampleReason: 'no candidates found',
        },
      ],
      movies: [], parked: 0, meta: { roots: [], lastScanAt: null, files: 0 , lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0},
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
    // 两列泳道标题——窄列改名 "Gaps"（design §B），宽列新增 "Activity"（原 Passes/Workers
    // 两条独立标题折叠成一条）。
    expect(screen.getByText('Gaps')).toBeInTheDocument()
    expect(screen.getByText('Activity')).toBeInTheDocument()
  })

  it('throttled=0 → 不渲染 throttled 行', async () => {
    const pending: WorkflowPendingDTO = {
      series: [
        { seriesId: 's1', seriesName: 'Silo', season: 1, missing: 3, throttled: 0, nextRecheckAt: null, sampleReason: null },
      ],
      movies: [], parked: 0, meta: { roots: [], lastScanAt: null, files: 0 , lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0},
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

describe('Lanes：Orchestrator log 折叠区——默认收起，展开后 receipts chip 非零才显示', () => {
  it('默认折叠', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
      ]),
    )
    renderLanes()
    const trigger = await screen.findByRole('button', { name: 'Orchestrator log' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('全零 receipts → 展开后不渲染 chip 排', async () => {
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
    await openOrchestratorLog()
    expect(await screen.findByText('no dispatches')).toBeInTheDocument()
    expect(screen.queryByText(/created|coalesced|revived|blocked|unparsed/)).not.toBeInTheDocument()
  })

  it('非零 receipts → 展开后只显示非零的 chip', async () => {
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
    await openOrchestratorLog()
    expect(await screen.findByText('3 created')).toBeInTheDocument()
    expect(screen.getByText('1 coalesced')).toBeInTheDocument()
    expect(screen.queryByText(/revived/)).not.toBeInTheDocument()
    expect(screen.queryByText(/blocked/)).not.toBeInTheDocument()
  })
})

describe('Lanes：Now working 卡 + SSE 直播流入 TraceRows（phraseMode 人话短语）', () => {
  function workersWithRunning(): WorkflowWorkersDTO {
    return {
      running: [
        {
          jobId: 42, seriesId: 's1', movieId: null, taskType: 'find_subtitle', seasons: [1],
          seriesName: null, movieName: null, posterPath: null, backdropPath: null,
          startedAtLease: NOW,
          trail: [{ runKey: 'job-42', seq: 0, tool: 'search_source', argsSummary: '"x"', resultSummary: '41 candidates', tookMs: 1200, at: NOW }],
        },
      ],
      recent: [],
      installedLast24h: 0,
      translatedLast24h: 0,
      held: [],
      providerQuota: [],
    }
  }

  it('初始 trail 来自 workers 端点，工具名经 phraseMode 映射，渲染在跑行（蓝点）', async () => {
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

    expect(await screen.findByText('Searching providers')).toBeInTheDocument() // toolPhrase('search_source')
    expect(screen.getByText('Searching subtitles for s1')).toBeInTheDocument() // 人话卡头
    expect(screen.getByTestId('wf-trace-active')).toBeInTheDocument()
  })

  // 2026-07-30：这条原先拿 download_candidate 当"未映射工具名"的样本，断言它渲染成裸蛇形词。
  // 那其实是在锁一个 bug——download_candidate 是真实注册的高频工具（src/agent/findSubtitleWorker.ts:181），
  // 只是漏登记在 phrases.ts 里。补上译文后这里改断言人话短语；"未映射兜底"这条语义仍然要验，
  // 换成一个真正不存在的工具名（some_future_tool）来验，与 TraceRows.test.tsx 的口径一致。
  it('SSE 事件流入后新增一行痕迹（未映射工具名原样 mono 兜底，按 seq 追加不重复）', async () => {
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
    await screen.findByText('Searching providers')
    expect(FakeEventSource.instances).toHaveLength(1)

    FakeEventSource.instances[0].emit({
      runKey: 'job-42', seq: 1, tool: 'download_candidate', argsSummary: 'E07 · unpacking…', resultSummary: 'ok', tookMs: 4000, at: NOW + 1,
    })
    FakeEventSource.instances[0].emit({
      runKey: 'job-42', seq: 2, tool: 'some_future_tool', argsSummary: 'x', resultSummary: 'ok', tookMs: 100, at: NOW + 2,
    })

    // 已登记工具 → 人话短语（不再是裸 download_candidate）。
    expect(await screen.findByText('Downloading a subtitle')).toBeInTheDocument()
    expect(screen.queryByText('download_candidate')).not.toBeInTheDocument()
    expect(screen.getByText('4.0s')).toBeInTheDocument()
    // 未登记工具 → 原样 mono 兜底（诚实降级，不编造短语）。
    expect(await screen.findByText('some_future_tool')).toBeInTheDocument()
    // 原有那条痕迹还在——是追加不是替换。
    expect(screen.getByText('Searching providers')).toBeInTheDocument()
  })
})

describe('Lanes：Orchestrator log 展开后点开一条 pass → RunDetail 快照回放（回放≠直播，无蓝点）', () => {
  it('点开渲染 detail/receipts + 静态 TraceRows（原始工具名）', async () => {
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
    await openOrchestratorLog()

    const card = await screen.findByText('dispatched 2 find / 0 realign')
    fireEvent.click(card)

    const panel = await screen.findByRole('dialog', { name: 'pass 7' })
    // RunDetail 回放零改动——原始工具名（不经 phraseMode 映射）在场。
    expect(within(panel).getByText('dispatch_find_subtitle_task')).toBeInTheDocument()
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
    await openOrchestratorLog()
    fireEvent.click(await screen.findByText('no dispatches'))
    expect(await screen.findByText('No trace events were captured for this pass.')).toBeInTheDocument()
  })
})

describe('Lanes：PendingLane series 行 Rerun includeThrottled 开关按事实预开', () => {
  function pendingSeries(missing: number, throttled: number): WorkflowPendingDTO {
    return {
      series: [{ seriesId: 's1', seriesName: 'Silo', season: 1, missing, throttled, nextRecheckAt: null, sampleReason: null }],
      movies: [], parked: 0, meta: { roots: [], lastScanAt: null, files: 0 , lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0},
    }
  }

  it('missing:0 + throttled:6 → Include throttled 开关初始 checked', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: pendingSeries(0, 6) },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
      ]),
    )
    renderLanes()
    await screen.findByText('Silo · S1')
    const toggle = screen.getByRole('switch', { name: 'Include throttled episodes' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)
  })

  it('missing:2 + throttled:0 → Include throttled 开关初始 unchecked', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: pendingSeries(2, 0) },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: EMPTY_WORKERS },
      ]),
    )
    renderLanes()
    await screen.findByText('Silo · S1')
    const toggle = screen.getByRole('switch', { name: 'Include throttled episodes' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
  })
})

// R2D-1+9（R2 复审，验收修复轮一 Task V4 沿用）：worker run 详情入口——recent 行现在渲染成人话
// 句子（主语=剧名/片名 + decisionPhrase），点开一条仍打开同一块 RunDetail 右侧板；React key
// 仍用 runs.id（同一个 job 可能有多行 runs）。
describe('Lanes：recent 人话句子行点开 → RunDetail（worker run 详情入口）', () => {
  function workersWithRecent(recent: WorkflowWorkersDTO['recent']): WorkflowWorkersDTO {
    return { running: [], recent, installedLast24h: 0, translatedLast24h: 0, held: [], providerQuota: [] }
  }

  it('点开渲染 decision 语义点 + detail + 静态 TraceRows；seriesId 非空时显示 Rerun 按钮', async () => {
    const recentRow = {
      id: 5, jobId: 10, decision: 'installed', detail: '3 集入账: e1, e2, e3', finishedAt: NOW,
      seriesId: 's9', movieId: null, seriesName: 'Silo', movieName: null,
      posterPath: null, backdropPath: null,
      llmCalls: null,
    }
    const trace: RunTraceDTO = {
      events: [{ runKey: 'job-10', seq: 0, tool: 'download_candidate', argsSummary: 'E01', resultSummary: 'ok', tookMs: 800, at: NOW }],
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: workersWithRecent([recentRow]) },
        { path: '/api/v2/workflow/runs/5/trace', body: trace },
      ]),
    )
    renderLanes()

    // recent 行主语=剧名（Silo），不再是裸 tmdb id 或截断 detail 文本。
    const row = await screen.findByText('Silo')
    fireEvent.click(row)

    const panel = await screen.findByRole('dialog', { name: 'run 5' })
    expect(within(panel).getByText('installed')).toBeInTheDocument()
    expect(within(panel).getByText('3 集入账: e1, e2, e3')).toBeInTheDocument()
    expect(within(panel).getByText('download_candidate')).toBeInTheDocument()
    expect(within(panel).queryByTestId('wf-trace-active')).not.toBeInTheDocument() // 回放不是直播
    expect(within(panel).getByRole('button', { name: 'Rerun' })).toBeInTheDocument()
  })

  it('seriesId 为 null（如 movie 目标的 find_subtitle worker run）→ 不显示 Rerun 按钮；剧名缺失降级片名', async () => {
    const recentRow = {
      id: 6, jobId: 11, decision: 'installed', detail: 'movie 装好了', finishedAt: NOW,
      seriesId: null, movieId: 'm1', seriesName: null, movieName: 'Movie Z',
      posterPath: null, backdropPath: null,
      llmCalls: null,
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: workersWithRecent([recentRow]) },
        { path: '/api/v2/workflow/runs/6/trace', body: { events: [] } },
      ]),
    )
    renderLanes()
    fireEvent.click(await screen.findByText('Movie Z'))
    const panel = await screen.findByRole('dialog', { name: 'run 6' })
    expect(within(panel).queryByRole('button', { name: 'Rerun' })).not.toBeInTheDocument()
  })

  it('剧名/片名皆缺失 → 主语降级显示 id（诚实兜底）', async () => {
    const recentRow = {
      id: 9, jobId: 12, decision: 'no_safe_match', detail: null, finishedAt: NOW,
      seriesId: 's-empty', movieId: null, seriesName: null, movieName: null,
      posterPath: null, backdropPath: null,
      llmCalls: null,
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: workersWithRecent([recentRow]) },
      ]),
    )
    renderLanes()
    expect(await screen.findByText('s-empty')).toBeInTheDocument()
    expect(screen.getByText('no safe match found')).toBeInTheDocument()
  })

  it('同一 job 两行 runs（jobId 相同、id 不同）各自独立可点开——不因 key 撞车而错配', async () => {
    const rowA = {
      id: 21, jobId: 30, decision: 'installed', detail: 'first row', finishedAt: NOW - 100,
      seriesId: 's1', movieId: null, seriesName: 'Silo', movieName: null,
      posterPath: null, backdropPath: null,
      llmCalls: null,
    }
    const rowB = {
      id: 22, jobId: 30, decision: 'error', detail: 'second row', finishedAt: NOW,
      seriesId: 's1', movieId: null, seriesName: 'Silo', movieName: null,
      posterPath: null, backdropPath: null,
      llmCalls: null,
    }
    vi.stubGlobal(
      'fetch',
      mockFetchRouted([
        { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
        { path: '/api/v2/workflow/passes', body: [] },
        { path: '/api/v2/workflow/workers', body: workersWithRecent([rowB, rowA]) },
        { path: '/api/v2/workflow/runs/21/trace', body: { events: [] } },
        { path: '/api/v2/workflow/runs/22/trace', body: { events: [] } },
      ]),
    )
    renderLanes()
    // 两个短语都各自渲染（同一主语 "Silo" 出现两次，靠短语区分——decisionPhrase 各不相同）。
    await screen.findByText('subtitles installed')
    expect(screen.getByText('hit a problem — will retry')).toBeInTheDocument()

    fireEvent.click(screen.getByText('subtitles installed'))
    expect(await screen.findByRole('dialog', { name: 'run 21' })).toBeInTheDocument()
  })

  it('Rerun 按钮走现有 RerunDialog 流，POST 请求体不带 seasons 键（全剧缺口）', async () => {
    const recentRow = {
      id: 5, jobId: 10, decision: 'installed', detail: '3 集入账', finishedAt: NOW,
      seriesId: 's9', movieId: null, seriesName: 'Silo', movieName: null,
      posterPath: null, backdropPath: null,
      llmCalls: null,
    }
    const fetchMock = mockFetchRouted([
      { path: '/api/v2/workflow/pending', body: EMPTY_PENDING },
      { path: '/api/v2/workflow/passes', body: [] },
      { path: '/api/v2/workflow/workers', body: workersWithRecent([recentRow]) },
      { path: '/api/v2/workflow/runs/5/trace', body: { events: [] } },
      { path: '/api/v2/workflow/redispatch', method: 'POST', body: { outcome: 'created' } },
    ])
    vi.stubGlobal('fetch', fetchMock)
    renderLanes()
    fireEvent.click(await screen.findByText('Silo'))
    const panel = await screen.findByRole('dialog', { name: 'run 5' })
    fireEvent.click(within(panel).getByRole('button', { name: 'Rerun' }))

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rerun' }))
    expect(await within(dialog).findByText('created — a new task was dispatched.')).toBeInTheDocument()

    const call = fetchMock.mock.calls.find((c) => requestInfo(c[0] as RequestInfo).path.includes('redispatch'))!
    const body = JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toEqual({ seriesId: 's9', includeThrottled: false })
    expect('seasons' in body).toBe(false)
  })
})

describe('Lanes：Rerun 确认流（Gaps 列 PendingLane 发起）——AlertDialog → POST → 四态回执各断言一条', () => {
  function pendingWithSeries(): WorkflowPendingDTO {
    return {
      series: [{ seriesId: 's1', seriesName: 'Silo', season: 1, missing: 3, throttled: 0, nextRecheckAt: null, sampleReason: null }],
      movies: [], parked: 0, meta: { roots: [], lastScanAt: null, files: 0 , lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0},
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
