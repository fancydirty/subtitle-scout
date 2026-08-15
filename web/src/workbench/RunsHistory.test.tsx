// web/src/workbench/RunsHistory.test.tsx —— 决策历史段的运行时行为守卫。
//
// 判据全部是可被变异推翻的运行时事实（照 ActivityPage.test.tsx 的纪律，见其头注释）：
//  · 渲染 → 数 /api/v2/runs 的请求与行 DOM
//  · 惰性 trace → 展开前**零** trace 请求、展开后恰好一次、收起再展开**不再发**
//  · 事件触发重拉 → 数请求次数（不是数 DOM——DOM 可能是缓存的旧值）
//  · 分页 → 「加载更多」发的 offset 是当前行数（数 URL 参数）
// 每条断言配阳性对照：把对应行为删掉，该断言必红。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { EventsProvider } from '../events/EventsProvider.js'
import { __resetEventsBusForTests } from '../events/eventsBus.js'
import { ActivityPage } from './ActivityPage.js'
import type { ScoutEvent } from '../events/types.js'

class FakeES {
  static instances: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  private listeners = new Map<string, ((e: { data: string }) => void)[]>()
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener() {}
  close() { this.readyState = 2 }
  emit(e: ScoutEvent) {
    for (const fn of this.listeners.get(e.type) ?? []) fn({ data: JSON.stringify(e) })
  }
  open() { this.readyState = 1; this.onopen?.() }
  fail(readyState: number) { this.readyState = readyState; this.onerror?.() }
}

let seq = 0
const ev = (over: Partial<ScoutEvent> & Pick<ScoutEvent, 'type'>): ScoutEvent => ({
  id: ++seq, at: Date.now(), message: 'm', ...over,
})

const HEALTH_IDLE = {
  lastInspectAt: Date.now() - 3_600_000,
  workPermitted: true, engineEnabled: true, setupSatisfied: true,
  roots: [], unidentified: { dirCount: 0, dirs: [] },
  stalledJobs: { count: 0, overdueMs: null as number | null }, current: null,
}
const QUEUE_ITEM = {
  workId: 'tmdb:1', title: 'Queued Show', chineseTitle: null, year: 2018,
  mediaType: 'tv' as const, posterPath: '/p.jpg', backdropPath: '/bd.jpg', pendingFileCount: 13,
  dueNow: true, retryAfter: null as number | null,
}

const RUN_1 = {
  id: 1, jobId: null, startedAt: Date.now() - 60_000, finishedAt: Date.now() - 50_000,
  decision: 'installed', detail: '2 集入账: s1e1, s1e2', journalPath: null,
}
const RUN_2 = {
  id: 2, jobId: null, startedAt: Date.now() - 30_000, finishedAt: Date.now() - 20_000,
  decision: 'no_safe_match', detail: '5 集判无: s1e3(搜遍了没有)', journalPath: null,
}
const TRACE_EVENTS = {
  events: [
    { runKey: 'job-subtitle:tmdb:42', seq: 1, tool: 'search_source', argsSummary: '{"queries":["Show"]}', resultSummary: '3 hits', tookMs: 5, at: 1 },
    { runKey: 'job-subtitle:tmdb:42', seq: 2, tool: 'download_candidate', argsSummary: '{}', resultSummary: 'ok', tookMs: 9, at: 2 },
  ],
}

let urls: string[] = []
let runsBody: unknown = [RUN_1, RUN_2]

function countOf(fragment: string): number {
  return urls.filter((u) => u.includes(fragment)).length
}

beforeEach(() => {
  FakeES.instances = []
  seq = 0
  urls = []
  runsBody = [RUN_1, RUN_2]
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/api/v2/runs?')) {
      return { ok: true, status: 200, json: async () => runsBody } as unknown as Response
    }
    if (url.includes('/api/v2/workflow/runs/')) {
      return { ok: true, status: 200, json: async () => TRACE_EVENTS } as unknown as Response
    }
    if (url.includes('/api/v2/health')) {
      return { ok: true, status: 200, json: async () => HEALTH_IDLE } as unknown as Response
    }
    if (url.includes('/api/v2/activity')) {
      return {
        ok: true, status: 200,
        json: async () => ({ subtitleQueue: [QUEUE_ITEM], translateQueue: [] }),
      } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
  }))
})
afterEach(() => { cleanup(); __resetEventsBusForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const renderPage = () =>
  render(<I18nProvider initialLang="en"><EventsProvider><ActivityPage /></EventsProvider></I18nProvider>)

const bus = () => FakeES.instances[0]!

async function ready() {
  await waitFor(() => expect(countOf('/api/v2/runs?')).toBeGreaterThan(0))
  await screen.findByText('Queued Show')
}

describe('RunsHistory（决策历史段）', () => {
  it('首载渲染 runs 行：decision 原样（不翻译）+ detail + 相对时间', async () => {
    renderPage()
    await ready()

    const rows = await screen.findAllByTestId('runs-row')
    expect(rows).toHaveLength(2)
    // 🔴 decision 是技术值不翻译——断言原文在场（翻译掉它这条就红）
    expect(rows[0].textContent).toContain('installed')
    expect(rows[1].textContent).toContain('no_safe_match')
    expect(rows[0].textContent).toContain('s1e1')
  })

  it('🔴 空态与错误态不共用一句话（错误绝不说"还没有运行记录"）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/api/v2/runs?')) {
        return { ok: false, status: 500, json: async () => ({ error: 'db locked' }) } as unknown as Response
      }
      if (url.includes('/api/v2/health')) {
        return { ok: true, status: 200, json: async () => HEALTH_IDLE } as unknown as Response
      }
      if (url.includes('/api/v2/activity')) {
        return {
          ok: true, status: 200,
          json: async () => ({ subtitleQueue: [QUEUE_ITEM], translateQueue: [] }),
        } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
    }))
    renderPage()
    await ready()

    const err = await screen.findByTestId('runs-error')
    expect(err.textContent).toContain('Could not load run history')
    expect(screen.queryByTestId('runs-empty')).toBeNull()
  })

  it('🔴 trace 惰性加载：展开前零请求，展开后恰好一次，收起再展开不再发', async () => {
    renderPage()
    await ready()
    expect(countOf('/api/v2/workflow/runs/'), '阳性对照前提：展开前零 trace 请求').toBe(0)

    const rows = await screen.findAllByTestId('runs-row')
    fireEvent.click(rows[0])
    await waitFor(() => expect(countOf('/api/v2/workflow/runs/1/trace')).toBe(1))
    const trace = await screen.findByTestId('runs-trace')
    expect(trace.textContent).toContain('search_source')
    expect(trace.textContent).toContain('3 hits')

    // 收起再展开：用的是缓存，不是第二条请求
    fireEvent.click(rows[0])
    expect(screen.queryByTestId('runs-trace')).toBeNull()
    fireEvent.click(rows[0])
    await screen.findByTestId('runs-trace')
    expect(countOf('/api/v2/workflow/runs/1/trace')).toBe(1)
  })

  it('🔴 工作台级 activity 事件 → 重拉第一页；巡检级不触发', async () => {
    renderPage()
    await ready()
    const before = countOf('/api/v2/runs?')

    // 巡检级（无 workbench）：不产生 runs 行，不重拉
    bus().emit(ev({ type: 'activity', message: '巡检开始' }))
    await new Promise(r => setTimeout(r, 30))
    expect(countOf('/api/v2/runs?')).toBe(before)

    // 工作台级（subtitle）：一个作品跑完了 → 重拉
    bus().emit(ev({ type: 'activity', message: '第 3/8 个', workbench: 'subtitle', title: 'Show' }))
    await waitFor(() => expect(countOf('/api/v2/runs?')).toBe(before + 1))
  })

  it('🔴 「加载更多」带当前行数为 offset；不满一页时不出现', async () => {
    renderPage()
    await ready()
    expect(screen.queryByTestId('runs-more')).toBeNull()   // 2 < 50：不出现

    // 造一整页（50 条）→ 按钮出现，点击后 offset=50
    runsBody = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, jobId: null, startedAt: Date.now(), finishedAt: Date.now(),
      decision: 'installed', detail: `row ${i}`, journalPath: null,
    }))
    cleanup()   // 卸掉上面那两行的旧页面（不卸的话 findAll 数到两页之和）
    renderPage()
    await waitFor(() => expect(screen.findAllByTestId('runs-row')).resolves.toHaveLength(50))
    fireEvent.click(screen.getByTestId('runs-more'))
    await waitFor(() => expect(countOf('offset=50')).toBe(1))
  })
})
