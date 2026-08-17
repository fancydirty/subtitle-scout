// web/src/notifications/sseSeparation.test.tsx：🔴 **SSE 与列表分工**的运行时守卫。
//
// ── 这个文件守的是什么 ─────────────────────────────────────────────────────
// 列表**只**由 GET /api/v2/notifications 出。SSE **不直接插列表**。
// found 事件的职责是**再打一次 GET**（账本刷新），不是把事件里的剧名写进 DOM。
//
// 后端理由（server.ts + notificationsRepo 头注释）：`recordFound` 是**幂等刷新**
// （同一 work+season+episode 撞键时 ON CONFLICT DO UPDATE），而 SSE 每次装盘都发一条。
// 于是「这一小时发了 N 条 found 事件」与「端点这一小时多了几组」**没有等式关系**。
// 任何把事件塞进列表的写法，都会以重复条目的形态摆在用户眼前。
//
// 判据必须是**运行时**的：
//   ① 列表**行数**一条没变（GET 仍返回原来两组时）
//   ② SSE 剧名**一个字都没进 DOM**，直到 GET 账本里有它
//   ③ 事件 `message`（装上了 2 条字幕）不渲染
//   ④ found 之后 **GET 次数上涨**（订阅的防空转桩：删掉 useFoundEvent → GET 停在 1）
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { EventsProvider } from '../events/EventsProvider.js'
import { __resetEventsBusForTests } from '../events/eventsBus.js'
import { NotificationsPage } from './NotificationsPage.js'
import { en } from '../i18n/en.js'
import type { ScoutEvent } from '../events/types.js'
import type { FoundGroupDTO } from '../api/types.js'

/** 假 EventSource——同 events/EventsProvider.test.tsx 的既有手法（jsdom 不自带）。 */
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
}

const NOW = Date.now()
/** 端点返回的两组。**这两个剧名是列表里合法存在的**。 */
const ENDPOINT_ROWS: FoundGroupDTO[] = [
  { workId: 'tmdb:1396', title: 'Breaking Bad', season: 1, episodes: [3, 5, 7],
    latestAt: NOW - 3600_000, via: 'fetch', mediaType: 'tv',
    chineseTitle: null, backdropPath: null },
  { workId: 'tmdb:1399', title: 'Game of Thrones', season: 2, episodes: [1],
    latestAt: NOW - 7200_000, via: 'translate', mediaType: 'tv',
    chineseTitle: null, backdropPath: null },
]

/** 🔴 **只存在于 SSE 事件里**的剧名——端点一次都没返回过它。
 *  它进了 DOM = 有人把事件塞进了列表。 */
const SSE_ONLY_TITLE = 'Zzz Phantom Show From The Event Stream'

let notifUrls: string[] = []
/** GET 账本：found 后换这份才能证明列表来自端点而不是事件。 */
let ledger: FoundGroupDTO[] = ENDPOINT_ROWS

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/v2/notifications')) notifUrls.push(url)
    return { ok: true, status: 200, json: async () => ledger } as unknown as Response
  })
}

beforeEach(() => {
  FakeES.instances = []
  notifUrls = []
  ledger = ENDPOINT_ROWS
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

let seq = 0
const foundEvent = (title: string): ScoutEvent => ({
  id: ++seq, at: Date.now(), type: 'found',
  message: `${title}：装上了 2 条字幕`, title, workbench: 'subtitle',
  data: { installed: 2 },
})

/** 列表里的通知行数——判据用 aria-label（NotificationRow 给每条挂了作品名）。
 *  用 role=link 数：每条通知是一个指向媒体库详情的链接。 */
const rowCount = () => screen.queryAllByRole('link').length

describe('🔴 SSE 不进列表；found 触发再 GET', () => {
  it('found 触发再 GET，但 SSE 剧名不直接进列表', async () => {
    const { container } = renderPage()
    await screen.findByText('Breaking Bad')
    const before = notifUrls.length
    expect(before).toBe(1)
    const rowsBefore = rowCount()
    expect(rowsBefore).toBe(2)

    seq = 0
    act(() => {
      bus().open()
      bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    await waitFor(() => expect(notifUrls.length).toBeGreaterThan(before))
    expect(screen.queryByText(SSE_ONLY_TITLE)).toBeNull()
    expect(container.textContent ?? '').not.toContain(SSE_ONLY_TITLE)
    expect(container.textContent ?? '', '事件 message 被当成列表行渲染了').not.toContain('装上了 2 条字幕')
    expect(rowCount(), 'GET 账本没变时行数不许因 SSE 增加').toBe(rowsBefore)
  })

  it('发 3 条 found 之后：GET 账本仍是两组 → 列表行数一条没变', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    const before = rowCount()
    expect(before).toBe(2)

    seq = 0
    act(() => {
      bus().open()
      for (let i = 0; i < 3; i++) bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    await waitFor(() => expect(notifUrls.length).toBeGreaterThan(1))
    expect(rowCount(), 'SSE 事件被插进了列表').toBe(before)
    expect(screen.queryByText(SSE_ONLY_TITLE)).toBeNull()
  })

  it('🔴 防空转桩：found 之后 GET 次数上涨（删掉订阅则停在 1）', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    expect(notifUrls.length).toBe(1)

    seq = 0
    act(() => {
      bus().open()
      bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    await waitFor(() =>
      expect(notifUrls.length, 'found 没触发再 GET——SSE 订阅空转').toBeGreaterThan(1),
    )
  })

  it('GET 才是账本：found 后换端点数据，DOM 出现新剧名，仍没有 SSE 剧名', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    expect(screen.queryByText('Ledger New Show')).toBeNull()

    ledger = [
      ...ENDPOINT_ROWS,
      { workId: 'tmdb:new', title: 'Ledger New Show', season: 1, episodes: [1],
        latestAt: NOW, via: 'fetch', mediaType: 'tv',
        chineseTitle: null, backdropPath: null },
    ]
    seq = 0
    act(() => {
      bus().open()
      bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    expect(await screen.findByText('Ledger New Show')).toBeInTheDocument()
    expect(screen.queryByText(SSE_ONLY_TITLE)).toBeNull()
    expect(rowCount()).toBe(3)
  })

  it('空态下 found 触发再 GET，事件剧名仍不进 DOM', async () => {
    ledger = []
    renderPage()
    await screen.findByText(en.notif_empty_title)
    const before = notifUrls.length
    seq = 0
    act(() => {
      bus().open()
      bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    await waitFor(() => expect(notifUrls.length).toBeGreaterThan(before))
    expect(screen.getByText(en.notif_empty_title)).toBeInTheDocument()
    expect(screen.queryByText(SSE_ONLY_TITLE)).toBeNull()
  })

  it('挂载前就躺在总线里的旧事件**不**额外 GET（基线）', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    seq = 0
    act(() => { bus().open(); bus().emit(foundEvent(SSE_ONLY_TITLE)) })
    await waitFor(() => expect(notifUrls.length).toBeGreaterThan(1))
    cleanup()

    notifUrls = []
    renderPage()
    await screen.findByText('Breaking Bad')
    await act(async () => { await Promise.resolve() })
    expect(notifUrls.length, '重挂把残留 found 又当成新成果去拉了').toBe(1)
  })
})

describe('SSE 断线重连 → 补拉一次（不是轮询）', () => {
  // 判据必须区分开这两件事，否则"补拉"与"轮询"在计数上长得一样：
  //  · 补拉：由 **status 跃迁** retrying → open 触发，一次跃迁一次请求；
  //  · 轮询：由定时器触发，时间过去就发，与状态无关。
  // 下面第二条用"什么都不发生地等 60 秒"把后者排除。
  it('retrying → open 时补拉一次（断线期间的 found 事件已永久丢失，不补就永远不更新）', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    act(() => bus().open())
    expect(notifUrls).toHaveLength(1)

    // 断线：readyState=CLOSED → eventsBus 接管 → probeUnavailable（fetch mock 返回 200，
    // 非 503）→ scheduleReconnect → status 变 retrying。
    act(() => { bus().readyState = 2; bus().onerror?.() })
    await waitFor(() => expect(FakeES.instances.length).toBe(2), { timeout: 8000 })
    // 到这里还没恢复 open，所以**还不该**有第二次请求（补拉的触发点是恢复，不是断开）
    expect(notifUrls, '断开的那一刻就重拉——那时候还连不上，纯属白打').toHaveLength(1)

    act(() => FakeES.instances[1]!.open())
    await waitFor(() => expect(notifUrls).toHaveLength(2))
  }, 20_000)

  it('**不轮询**：连接一直好着，60 秒过去仍然只有首载那一次请求', async () => {
    vi.useFakeTimers()
    try {
      renderPage()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      act(() => bus().open())
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const after = notifUrls.length
      expect(after).toBe(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(notifUrls.length, '出现了轮询——这一页有 SSE，轮询正是 R-F6 要消灭的东西').toBe(after)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('列表内容全部来自端点（DOM 逐条核对）', () => {
  it('端点两组 → DOM 两行，且字段逐个对上', async () => {
    renderPage()
    const bb = await screen.findByRole('link', { name: 'Breaking Bad' })
    // S01 + 集号 3/5/7（formatEpisodes 的离散形态）+ via=fetch
    expect(within(bb).getByText('S01')).toBeInTheDocument()
    expect(bb.textContent).toContain('3 / 5 / 7')
    expect(bb.textContent).toContain(en.notif_via_fetch)
    expect(bb).toHaveAttribute('data-via', 'fetch')

    const got = screen.getByRole('link', { name: 'Game of Thrones' })
    expect(within(got).getByText('S02')).toBeInTheDocument()
    expect(got.textContent).toContain(en.notif_via_translate)
  })

  it('端点给几组就渲染几行——不多不少', async () => {
    const many: FoundGroupDTO[] = Array.from({ length: 7 }, (_, i) => ({
      workId: `tmdb:${i}`, title: `Show ${i}`, season: 1, episodes: [1],
      latestAt: NOW - i * 600_000, via: 'fetch', mediaType: 'tv' as const,
      chineseTitle: null, backdropPath: null,
    }))
    ledger = many
    renderPage()
    await screen.findByText('Show 0')
    expect(rowCount()).toBe(7)
  })
})
