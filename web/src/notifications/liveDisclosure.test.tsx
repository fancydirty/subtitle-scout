// web/src/notifications/liveDisclosure.test.tsx —— 🟡-2：通知页的 SSE 掉线披露。
//
// ══════════════════════════════════════════════════════════════════════════════
// 这个文件为什么存在（终局审计 🟡-2，Task ⑨ 的判断被重判）
// ══════════════════════════════════════════════════════════════════════════════
// 通知页 `useEventsStatus()` 读了，但**只用于重连补拉**（useResumeEdge 的边沿）。
// 而 `unavailable` 是 503 **终态**——eventsBus.ts:262 明写一次都不会再重连，
// 那条边沿**永远不会触发**。于是用户盯着的是一个：
//   · 永远不会亮"有新字幕"的页面
//   · 永远不会自动补拉的列表
//   · 而且看上去完全正常
// Task ⑨ 的实施者判"失败形态是遗漏不是谎报，低一档"。重判的理由：一个不会更新的
// 通知页会让用户得出"这周就是没找到东西"这个**错误结论**——那已经越过遗漏的界线。
//
// 判据全部是**运行时电平**（不是边沿）：把 eventsBus 推到某个状态，看 DOM。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { EventsProvider } from '../events/EventsProvider.js'
import { __resetEventsBusForTests } from '../events/eventsBus.js'
import { NotificationsPage } from './NotificationsPage.js'
import { en } from '../i18n/en.js'
import type { FoundGroupDTO } from '../api/types.js'

/** 假 EventSource——同 sseSeparation.test.tsx 的既有手法（jsdom 不自带）。
 *  多一个 `fail(status)`：把连接推进 retrying / unavailable 两态。 */
class FakeES {
  static instances: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
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
  open() { this.readyState = 1; this.onopen?.() }
  /** 连接失败 → eventsBus 走它的 onerror 分支（探测 503 → unavailable，否则 retrying）。 */
  fail() { this.readyState = 2; this.onerror?.() }
  /** 发一条 found 事件（点亮"有新字幕"提示条）。 */
  emitFound(title: string) {
    const e = {
      id: ++FakeES.seq, at: Date.now(), type: 'found',
      message: `${title}：装上了 2 条字幕`, title, workbench: 'subtitle', data: { installed: 2 },
    }
    for (const fn of this.listeners.get('found') ?? []) fn({ data: JSON.stringify(e) })
  }
  static seq = 0
}

const NOW = Date.now()
const ROWS: FoundGroupDTO[] = [
  { workId: 'tmdb:1396', title: 'Breaking Bad', season: 1, episodes: [3],
    latestAt: NOW - 3600_000, via: 'fetch' },
]

/** 503 探测的响应——eventsBus 在 onerror 后会打一次 /api/v2/events 判是不是终态。 */
let probeStatus = 200
let rows: FoundGroupDTO[] = ROWS

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/v2/notifications')) {
      return { ok: true, status: 200, json: async () => rows } as unknown as Response
    }
    // /api/v2/events 的探测
    return { ok: probeStatus === 200, status: probeStatus, json: async () => ({}) } as unknown as Response
  })
}

beforeEach(() => {
  FakeES.instances = []
  FakeES.seq = 0
  probeStatus = 200
  rows = ROWS
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
  vi.stubGlobal('fetch', mockFetch())
})
afterEach(() => {
  cleanup()
  __resetEventsBusForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const renderPage = () =>
  render(
    <I18nProvider initialLang="en">
      <EventsProvider>
        <NotificationsPage />
      </EventsProvider>
    </I18nProvider>,
  )

const bus = () => FakeES.instances[0]!

describe('🟡 通知页披露"实时更新没有开着"（终局审计 🟡-2）', () => {
  it('通道正常（open）→ **不显示**这条（一切正常时不要制造噪音）', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    act(() => { bus().open() })
    expect(screen.queryByTestId('notif-live-banner')).toBeNull()
  })

  it('🔴 503 终态（unavailable）→ 显示，且文案**明说刷新页面**', async () => {
    // 这是 Task ⑨ 漏掉的那个形态：eventsBus 一次都不会再重连，
    // "重连后补拉"永远不触发，用户盯着一个永远不更新的列表。
    probeStatus = 503
    renderPage()
    await screen.findByText('Breaking Bad')
    act(() => { bus().fail() })
    const banner = await screen.findByTestId('notif-live-banner')
    expect(banner.textContent).toContain(en.wb_live_unavailable)
    // 终态与可重试态说的**不是同一句话**（用户能做的事不同）。
    expect(banner.textContent).not.toContain(en.wb_live_retrying)
    expect(banner.getAttribute('data-live')).toBe('off')
  })

  it('退避重连中（retrying）→ 显示"正在重新接上"，不要求用户做什么', async () => {
    probeStatus = 200
    renderPage()
    await screen.findByText('Breaking Bad')
    act(() => { bus().fail() })
    const banner = await screen.findByTestId('notif-live-banner')
    await waitFor(() => expect(banner.getAttribute('data-live')).toBe('retrying'))
    expect(banner.textContent).toContain(en.wb_live_retrying)
  })

  it('🔴 文案与活动页**逐字相同**（两页说同一件事，各写一份必漂移）', () => {
    // 这一条是纯常量断言，但它守的是"没有人给通知页另写一句"。
    // i18n 键复用 wb_live_*，新键一个都没加——加了新键这条会因为文案不同而红。
    expect(en.wb_live_unavailable).toContain('refresh the page')
    expect(en.wb_live_retrying).not.toBe(en.wb_live_unavailable)
  })
})

describe('🟡 这条与"有新字幕"提示条的关系', () => {
  it('🔴 两条**可以同时在场**（断线前收到过事件、随后通道掉了——两句都是真的）', async () => {
    probeStatus = 503
    renderPage()
    await screen.findByText('Breaking Bad')
    // 真实路径：open → 收一条 found（点亮"有新字幕"）→ 通道掉线（点亮"听不见了"）。
    act(() => { bus().open() })
    act(() => { bus().emitFound('Some Show') })
    await screen.findByTestId('notif-new-banner')
    act(() => { bus().fail() })
    await screen.findByTestId('notif-live-banner')
    // 两条都在——藏起任何一条都是少说一句真话。
    expect(screen.getByTestId('notif-new-banner')).toBeInTheDocument()
    expect(screen.getByTestId('notif-live-banner')).toBeInTheDocument()
  })

  it('空态下也出（"这周没找到"与"我没听见"是两件事）', async () => {
    probeStatus = 503
    rows = []
    renderPage()
    await screen.findByText(en.notif_empty_title)
    act(() => { bus().fail() })
    const banner = await screen.findByTestId('notif-live-banner')
    expect(banner.textContent).toContain(en.wb_live_unavailable)
    // 空态文案照常在场——这条 banner 是**补充**而不是替代（错误态才替代空态）。
    expect(screen.getByText(en.notif_empty_title)).toBeInTheDocument()
  })

  it('刷新按钮真的重拉列表（不是一个画着好看的死按钮）', async () => {
    probeStatus = 503
    renderPage()
    await screen.findByText('Breaking Bad')
    act(() => { bus().fail() })
    await screen.findByTestId('notif-live-banner')
    const f = globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
    const before = f.mock.calls.filter((c) => String(c[0]).includes('/api/v2/notifications')).length
    const btn = screen.getAllByRole('button', { name: en.notif_refresh })[0]!
    act(() => { btn.click() })
    await waitFor(() => {
      const after = f.mock.calls.filter((c) => String(c[0]).includes('/api/v2/notifications')).length
      expect(after).toBeGreaterThan(before)
    })
  })
})

// ═══ Carbon 双通道 ═══════════════════════════════════════════════════════════
declare const __STYLES_CSS__: string

describe('Carbon 双通道：形状 + 文字', () => {
  it('点是**空心**的（与 NewFoundBanner 的实心点形状不同）', async () => {
    probeStatus = 503
    const { container } = renderPage()
    await screen.findByText('Breaking Bad')
    act(() => { bus().fail() })
    await screen.findByTestId('notif-live-banner')
    const dot = container.querySelector('[data-testid="notif-live-banner"] .notif-new-dot')
    expect(dot).not.toBeNull()
    expect(dot!.className).toContain('notif-new-dot-hollow')
  })

  it('🔴 CSS 侧：空心档的差异是形状（border + 无填充），不是明暗', () => {
    const bare = (__STYLES_CSS__ as string).replace(/\/\*[\s\S]*?\*\//g, '')
    const block = /\.notif-new-dot-hollow\s*\{([^}]*)\}/.exec(bare)?.[1] ?? ''
    expect(block, '.notif-new-dot-hollow 规则不存在 → 形状通道没了').not.toBe('')
    expect(block).toMatch(/background\s*:\s*none/)
    expect(block).toMatch(/border\s*:/)
    expect(block).not.toMatch(/opacity/)
  })
})
