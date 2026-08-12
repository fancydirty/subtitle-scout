// web/src/notifications/sseSeparation.test.tsx：🔴 **SSE 与列表分工**的运行时守卫。
//
// ── 这个文件守的是什么（设计文档 §3.4 的裁决）─────────────────────────────
// > 列表**只**由端点出，SSE **不直接插列表**——SSE 只做"有新字幕 · 点击刷新"的提示。
//
// 后端理由（server.ts:814 + notificationsRepo 头注释）：`recordFound` 是**幂等刷新**
// （同一 work+season+episode 撞键时 ON CONFLICT DO UPDATE），而 SSE 每次装盘都发一条。
// 于是「这一小时发了 N 条 found 事件」与「端点这一小时多了几组」**没有等式关系**。
// 任何把事件塞进列表的写法，都会以重复条目的形态摆在用户眼前。
//
// ── 判据必须是**运行时**的，且必须可证伪 ────────────────────────────────
// Task ⑤ 的教训：源码级断言（grep 页面里有没有 setList(found)）一行行尾注释就能喂饱。
// Task ⑧ 的教训：断言"两个集合不相交"这类**恒真命题**，改坏实现也不会红。
//
// 所以这里的四条判据全部是"发事件之后 DOM / 网络里真实发生了什么"：
//   ① 列表**行数**一条没变（事件带的剧名是端点从没返回过的）
//   ② 那个剧名**一个字都没进 DOM**（它只存在于事件里）
//   ③ 提示条**出现了**（SSE 确实被接上了——否则①②会因为"根本没订阅"而恒真假绿）
//   ④ 期间**没有自动重发请求**（自动刷新 = SSE 间接插列表，用户脚下的行会突然重排）
//
// ③ 是这份守卫的**防空转桩**：把 useFoundEvent 整个删掉的话①②照样绿，只有③会红。
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
    latestAt: NOW - 3600_000, via: 'fetch' },
  { workId: 'tmdb:1399', title: 'Game of Thrones', season: 2, episodes: [1],
    latestAt: NOW - 7200_000, via: 'translate' },
]

/** 🔴 **只存在于 SSE 事件里**的剧名——端点一次都没返回过它。
 *  它进了 DOM = 有人把事件塞进了列表。 */
const SSE_ONLY_TITLE = 'Zzz Phantom Show From The Event Stream'

let notifUrls: string[] = []

function mockFetch(rows: FoundGroupDTO[] = ENDPOINT_ROWS) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/v2/notifications')) notifUrls.push(url)
    return { ok: true, status: 200, json: async () => rows } as unknown as Response
  })
}

beforeEach(() => {
  FakeES.instances = []
  notifUrls = []
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

describe('🔴 SSE 不进列表（设计文档 §3.4）', () => {
  it('发 3 条 found 事件后：**列表行数一条没变**', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    const before = rowCount()
    expect(before).toBe(2)

    seq = 0
    act(() => {
      bus().open()
      for (let i = 0; i < 3; i++) bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    // 等提示条出现（证明事件确实被消费了），再看行数
    await screen.findByText(en.notif_new_found)
    expect(rowCount(), 'SSE 事件被插进了列表').toBe(before)
  })

  it('事件里的剧名**一个字都没进 DOM**（它只存在于事件里）', async () => {
    const { container } = renderPage()
    await screen.findByText('Breaking Bad')

    seq = 0
    act(() => {
      bus().open()
      bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    await screen.findByText(en.notif_new_found)

    // 三重判据：文本节点、整棵子树的 textContent、以及事件 message 的片段
    expect(screen.queryByText(SSE_ONLY_TITLE)).toBeNull()
    expect(container.textContent ?? '').not.toContain(SSE_ONLY_TITLE)
    expect(container.textContent ?? '', '事件 message 被当成列表行渲染了').not.toContain('装上了 2 条字幕')
  })

  it('🔴 防空转桩：提示条**真的出现了**（SSE 确实被订阅——否则上两条是假绿）', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    // 事件到达之前不该有提示条（否则它是个恒显示的装饰，证明不了任何事）
    expect(screen.queryByText(en.notif_new_found)).toBeNull()

    seq = 0
    act(() => {
      bus().open()
      bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    expect(await screen.findByText(en.notif_new_found)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.notif_refresh })).toBeInTheDocument()
  })

  it('提示条**不报条数**（事件条数 ≠ 端点组数，报数就是撒谎）', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    seq = 0
    act(() => {
      bus().open()
      for (let i = 0; i < 5; i++) bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    const banner = (await screen.findByText(en.notif_new_found)).closest('[role="status"]')!
    // 提示条整段文本里不许出现事件条数（5）或任何数字
    expect(banner.textContent ?? '').not.toMatch(/\d/)
  })

  it('事件到达**不自动重发请求**（自动刷新 = SSE 间接插列表，脚下的行会突然重排）', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    const before = notifUrls.length
    expect(before).toBe(1)

    seq = 0
    act(() => {
      bus().open()
      for (let i = 0; i < 3; i++) bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    await screen.findByText(en.notif_new_found)
    // 给微任务/effect 一点时间跑完，确认真的没有第二次请求
    await act(async () => { await Promise.resolve() })
    expect(notifUrls.length, '收到事件就自动重拉——刷新时机该交给用户').toBe(before)
  })

  it('点「刷新」才重发端点请求，且提示条随之消失', async () => {
    renderPage()
    await screen.findByText('Breaking Bad')
    seq = 0
    act(() => {
      bus().open()
      bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    const btn = await screen.findByRole('button', { name: en.notif_refresh })
    act(() => btn.click())
    await waitFor(() => expect(notifUrls.length).toBe(2))
    await waitFor(() => expect(screen.queryByText(en.notif_new_found)).toBeNull())
    // 🔴 刷新之后列表内容仍来自端点（端点 mock 没变 → 还是那两条），
    // 幽灵剧名依然不在
    expect(screen.queryByText(SSE_ONLY_TITLE)).toBeNull()
    expect(rowCount()).toBe(2)
  })

  it('空态下提示条**照样出**（一周内什么都没有、刚刚找到了一条，正是最该提示的时刻）', async () => {
    vi.stubGlobal('fetch', mockFetch([]))
    renderPage()
    await screen.findByText(en.notif_empty_title)
    seq = 0
    act(() => {
      bus().open()
      bus().emit(foundEvent(SSE_ONLY_TITLE))
    })
    expect(await screen.findByText(en.notif_new_found)).toBeInTheDocument()
    // 但列表仍然是空的——事件不许把空态变成有一条
    expect(screen.getByText(en.notif_empty_title)).toBeInTheDocument()
    expect(screen.queryByText(SSE_ONLY_TITLE)).toBeNull()
  })

  it('挂载前就躺在 Context 里的旧事件**不点亮**提示条（否则一进页面就有个刷不出变化的提示）', async () => {
    // 先挂一个只订阅的空壳，让 Provider 收下一条事件
    const Probe = () => null
    render(
      <I18nProvider initialLang="en">
        <EventsProvider>
          <NotificationsPage />
          <Probe />
        </EventsProvider>
      </I18nProvider>,
    )
    await screen.findByText('Breaking Bad')
    seq = 0
    act(() => { bus().open(); bus().emit(foundEvent(SSE_ONLY_TITLE)) })
    await screen.findByText(en.notif_new_found)
    cleanup()

    // 重新挂载：eventsBus 的 lastSeenId 还在，但 Provider 是新的（slot 回到 null），
    // 所以这里真正验证的是"重挂后不会因为残留事件立刻亮灯"。
    notifUrls = []
    renderPage()
    await screen.findByText('Breaking Bad')
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText(en.notif_new_found)).toBeNull()
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
      latestAt: NOW - i * 600_000, via: 'fetch' as const,
    }))
    vi.stubGlobal('fetch', mockFetch(many))
    renderPage()
    await screen.findByText('Show 0')
    expect(rowCount()).toBe(7)
  })
})
