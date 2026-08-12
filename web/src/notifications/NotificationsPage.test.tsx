// web/src/notifications/NotificationsPage.test.tsx：页面级用例（三态 + R-F3 三条裁决）。
//
// 与 sseSeparation.test.tsx 的分工：那份只管「SSE 不进列表」这一条；这份管页面本体
// （加载/错误/空/有内容四态、倒序在 DOM 上的呈现、不做已读、React key）。
//
// 判据一律是 **DOM 里真实渲染出了什么**，不是"源码里写了什么"（Task ⑤ 的教训）。
// 「不做已读」这条尤其容易写成装饰品——断言"没有 mark-as-read 按钮"是恒真的
// （谁也没写过那个按钮）。这里改成钉**它的四个具体形态**：
//   ① 全页没有任何写方法的请求（POST/PATCH/PUT/DELETE）
//   ② 点击一条通知之后，它的 DOM 属性/类名一个字都不变（没有 read/visited 态）
//   ③ 不往 localStorage 写任何东西（"已读"最常见的偷渡口）
//   ④ i18n 键集里没有 read/unread 一族文案（加文案是加状态的第一步）
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { EventsProvider } from '../events/EventsProvider.js'
import { __resetEventsBusForTests } from '../events/eventsBus.js'
import { NotificationsPage } from './NotificationsPage.js'
import { en } from '../i18n/en.js'
import { zh } from '../i18n/zh.js'
import type { FoundGroupDTO } from '../api/types.js'

// 四个页面文件的源文本——「不做已读」判据③用（见那条用例里对"为什么这里用源码判据"
// 的论证）。`?raw` 对 .ts/.tsx 在 vitest 里可用（.css 才恒空串，见 vitest.config.ts 的坑）。
import PAGE_SRC from './NotificationsPage.tsx?raw'
import ROW_SRC from './NotificationRow.tsx?raw'
import BANNER_SRC from './NewFoundBanner.tsx?raw'
import TEXT_SRC from './notifText.ts?raw'

class FakeES {
  static instances: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener() {}
  removeEventListener() {}
  close() { this.readyState = 2 }
}

const DAY = 86_400_000
const NOW = Date.now()

/** 每次请求记下 method——「不做已读」判据①用。 */
let methods: string[] = []

function mock(rows: FoundGroupDTO[] | 'error', delayMs = 0) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET')
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    if (rows === 'error') {
      return { ok: false, status: 500, json: async () => ({ error: 'db locked' }) } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => rows } as unknown as Response
  })
}

beforeEach(() => {
  FakeES.instances = []
  methods = []
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
})
afterEach(() => {
  cleanup()
  __resetEventsBusForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const renderPage = (lang: 'en' | 'zh' = 'en') =>
  render(
    <I18nProvider initialLang={lang}>
      <EventsProvider>
        <NotificationsPage />
      </EventsProvider>
    </I18nProvider>,
  )

describe('三态（加载 / 错误 / 空）', () => {
  it('加载中 → 骨架行，且**不**显示空态文案（那是谎报）', async () => {
    vi.stubGlobal('fetch', mock([], 500))
    renderPage()
    expect(await screen.findByLabelText('loading notifications')).toBeInTheDocument()
    expect(screen.queryByText(en.notif_empty_title)).toBeNull()
  })

  it('错误 → 错误标题 + 后端原文，**绝不**显示空态文案（§4.4：两件事）', async () => {
    vi.stubGlobal('fetch', mock('error'))
    renderPage()
    expect(await screen.findByText(en.notif_error_title)).toBeInTheDocument()
    expect(screen.getByText(/db locked/)).toBeInTheDocument()
    // 🔴 "这一周什么都没找到"与"我没能问到"是两件事
    expect(screen.queryByText(en.notif_empty_title)).toBeNull()
  })

  it('错误态的「重试」真的重发请求（探针计数 +1）', async () => {
    vi.stubGlobal('fetch', mock('error'))
    renderPage()
    const btn = await screen.findByRole('button', { name: en.notif_retry })
    const before = methods.length
    act(() => btn.click())
    await waitFor(() => expect(methods.length).toBe(before + 1))
  })

  it('空 → 空态文案，且**没有**错误文案', async () => {
    vi.stubGlobal('fetch', mock([]))
    renderPage()
    expect(await screen.findByText(en.notif_empty_title)).toBeInTheDocument()
    expect(screen.getByText(en.notif_empty_desc)).toBeInTheDocument()
    expect(screen.queryByText(en.notif_error_title)).toBeNull()
  })
})

describe('R-F3 倒序流水：DOM 顺序 = 时间倒序', () => {
  /** 故意乱序喂（端点若因任何原因没排好，前端也不许把它铺成乱的）。 */
  const rows: FoundGroupDTO[] = [
    { workId: 'w-old', title: 'Oldest', season: 1, episodes: [1], latestAt: NOW - 3 * DAY, via: 'fetch' },
    { workId: 'w-new', title: 'Newest', season: 1, episodes: [1], latestAt: NOW - 60_000, via: 'fetch' },
    { workId: 'w-mid', title: 'Middle', season: 1, episodes: [1], latestAt: NOW - 1 * DAY, via: 'fetch' },
  ]

  it('DOM 里三行的顺序是 Newest → Middle → Oldest', async () => {
    vi.stubGlobal('fetch', mock(rows))
    renderPage()
    await screen.findByText('Newest')
    const titles = screen.getAllByRole('link').map((a) => a.getAttribute('aria-label'))
    expect(titles).toEqual(['Newest', 'Middle', 'Oldest'])
  })

  it('按天分段：今天 / 昨天 / MM-DD，段落顺序同样倒序', async () => {
    vi.stubGlobal('fetch', mock(rows))
    renderPage()
    await screen.findByText('Newest')
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings[0]).toBe(en.notif_day_today)
    expect(headings[1]).toBe(en.notif_day_yesterday)
    // 第三段是 MM-DD 绝对日期（不是"3 天前"——t() 不支持插值）
    expect(headings[2]).toMatch(/^\d{2}-\d{2}$/)
  })

  it('同一天的多条也倒序（桶内顺序）', async () => {
    const sameDay: FoundGroupDTO[] = [
      { workId: 'a', title: 'A older', season: 1, episodes: [1], latestAt: NOW - 5 * 3600_000, via: 'fetch' },
      { workId: 'b', title: 'B newer', season: 1, episodes: [1], latestAt: NOW - 60_000, via: 'fetch' },
    ]
    vi.stubGlobal('fetch', mock(sameDay))
    renderPage()
    await screen.findByText('B newer')
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('aria-label')))
      .toEqual(['B newer', 'A older'])
  })
})

describe('R-F3 保留一周：窗口是**后端**的，前端如实照搬', () => {
  it('端点给什么就渲染什么——前端不做二次过滤（漂移的两份实现里，静默的那份最危险）', async () => {
    // 混入一条 400 天前的：后端读窗不该给，但若给了，前端偷偷吞掉的话
    // 「后端读窗坏了」这件事就永远没人看得见。
    const withAncient: FoundGroupDTO[] = [
      { workId: 'fresh', title: 'Fresh', season: 1, episodes: [1], latestAt: NOW - 3600_000, via: 'fetch' },
      { workId: 'ancient', title: 'Ancient', season: 1, episodes: [1], latestAt: NOW - 400 * DAY, via: 'fetch' },
    ]
    vi.stubGlobal('fetch', mock(withAncient))
    renderPage()
    await screen.findByText('Fresh')
    expect(screen.getByText('Ancient')).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('顶部计数与端点组数一致（不是集数、不是事件数）', async () => {
    const rows: FoundGroupDTO[] = [
      { workId: 'a', title: 'A', season: 1, episodes: [1, 2, 3, 4, 5], latestAt: NOW - 1000, via: 'fetch' },
      { workId: 'b', title: 'B', season: null, episodes: [], latestAt: NOW - 2000, via: 'translate' },
    ]
    vi.stubGlobal('fetch', mock(rows))
    renderPage()
    await screen.findByText('A')
    // 2 组（不是 5 集 + 1 = 6）
    expect(screen.getByText(new RegExp(`${en.notif_window_note} · 2`))).toBeInTheDocument()
  })

  it('「过去一周」这句话在页面上是明说的（用户得知道这里只有一周）', async () => {
    vi.stubGlobal('fetch', mock([{ workId: 'a', title: 'A', season: 1, episodes: [1], latestAt: NOW, via: 'fetch' }]))
    renderPage()
    await screen.findByText('A')
    expect(screen.getByText(new RegExp(en.notif_window_note))).toBeInTheDocument()
    expect(en.notif_window_note.toLowerCase()).toContain('week')
    expect(zh.notif_window_note).toContain('一周')
  })
})

describe('🔴 R-F3 不做已读状态：四个具体形态', () => {
  const rows: FoundGroupDTO[] = [
    { workId: 'tmdb:1', title: 'Show One', season: 1, episodes: [1], latestAt: NOW - 1000, via: 'fetch' },
  ]

  it('① 全页**没有任何写方法**的请求（GET only，端点本身也是 GET only）', async () => {
    vi.stubGlobal('fetch', mock(rows))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Show One' })
    act(() => row.click())
    await act(async () => { await Promise.resolve() })
    expect(methods.filter((m) => m.toUpperCase() !== 'GET'), '出现了写请求——已读状态的必经之路').toEqual([])
  })

  it('② 点击一条之后它的 DOM **一个属性都不变**（没有 read/visited 态）', async () => {
    vi.stubGlobal('fetch', mock(rows))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Show One' })
    const before = row.outerHTML
    act(() => row.click())
    await act(async () => { await Promise.resolve() })
    const after = screen.getByRole('link', { name: 'Show One' }).outerHTML
    expect(after, '点击改变了这一条的外观 —— 那就是已读状态').toBe(before)
  })

  // ⚠️ 曾经这里写的是「不往 localStorage 写任何东西」，用 spyOn(Storage.prototype,'setItem')
  // 做探针。**那条是装饰品**，变异审计当场抓到：本仓 jsdom 下 `localStorage` 是
  // **undefined**（`typeof localStorage === 'undefined'`，node 需要 --localstorage-file
  // 才提供它；i18n/useT.ts 的 try/catch 兜的就是这个），于是 Storage.prototype 上的桩
  // 永远不会被调用——生产代码里真写了 localStorage 的话，它会**抛异常然后被吞掉**，
  // 而那条断言照样绿。
  //
  // 换成**源码文本**判据（这里可以用，因为判的是"这个标识符一次都不许出现"这种
  // 全称否定，不是 Task ⑤ 那种"某处写了某个调用"的存在性断言——后者能被注释喂饱，
  // 前者反而会被注释里的举例**误报成红**，方向是安全的）。
  it('③ 三个页面文件里**一个持久化 API 都不出现**（"已读"最常见的偷渡口）', () => {
    // ⚠️ 判据是源码文本而不是运行时探针，理由见上面那段。为免被注释里的举例误伤，
    // 先剥注释（同 media/legacyIsolation.test.ts 的既有手法）。
    const strip = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
    const files = {
      'NotificationsPage.tsx': PAGE_SRC,
      'NotificationRow.tsx': ROW_SRC,
      'NewFoundBanner.tsx': BANNER_SRC,
      'notifText.ts': TEXT_SRC,
    }
    for (const [name, raw] of Object.entries(files)) {
      // 防空转：源码真的读到了（glob 坏掉时会是空串，禁令随之恒真）
      expect(raw.length, `${name} 源码没读到——这条守卫在空转`).toBeGreaterThan(400)
      const src = strip(raw)
      for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
        expect(src, `${name} 用了 ${api}——已读状态的偷渡口`).not.toContain(api)
      }
    }
  })

  it('④ i18n 键集里没有 read/unread 一族文案（加文案是加状态的第一步）', () => {
    const notifKeys = Object.keys(en).filter((k) => k.startsWith('notif_'))
    expect(notifKeys.length).toBeGreaterThan(5)
    for (const k of notifKeys) {
      expect(k, `${k} 像是已读状态的文案键`).not.toMatch(/read|unread|seen|dismiss|clear_all|mark/)
      for (const table of [en, zh] as const) {
        const v = (table as Record<string, string>)[k]!
        expect(v.toLowerCase(), `${k} 的文案提到了已读`).not.toMatch(/mark as read|unread|已读|未读/)
      }
    }
  })
})

describe('行的三种形状（电影 / 剧集 / 无集号）', () => {
  it('电影（season=null）→ 说「已找到字幕」，**绝不**显示 S null 或空的集号段', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:550', title: 'Fight Club', season: null, episodes: [], latestAt: NOW, via: 'fetch' },
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Fight Club' })
    expect(within(row).getByText(en.notif_movie_found)).toBeInTheDocument()
    expect(row.textContent ?? '').not.toContain('null')
    expect(row.textContent ?? '').not.toMatch(/S\s*$/)
    expect(row.textContent ?? '').not.toContain(en.notif_episodes_prefix)
  })

  it('剧集有集号 → S01 + 折叠后的集号', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:1', title: 'Show', season: 1, episodes: [1, 2, 3, 7], latestAt: NOW, via: 'fetch' },
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Show' })
    expect(within(row).getByText('S01')).toBeInTheDocument()
    expect(row.textContent).toContain('1–3 / 7')
  })

  it('剧集但 episodes 为空（跨进程的形状假设，不是本地不变式）→ 只报季，不渲染空的集号段', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:1', title: 'Weird', season: 3, episodes: [], latestAt: NOW, via: 'fetch' },
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Weird' })
    expect(within(row).getByText('S03')).toBeInTheDocument()
    expect(row.textContent ?? '', '渲染了一个空的「第  集」，看起来像页面坏了')
      .not.toContain(`${en.notif_episodes_prefix} `)
  })

  it('三种 via 各有各的文案，且 mixed **如实报两种来路**（谎报单一来源会误导质量预期）', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'a', title: 'A', season: 1, episodes: [1], latestAt: NOW - 1, via: 'fetch' },
      { workId: 'b', title: 'B', season: 1, episodes: [1], latestAt: NOW - 2, via: 'translate' },
      { workId: 'c', title: 'C', season: 1, episodes: [1], latestAt: NOW - 3, via: 'mixed' },
    ]))
    renderPage()
    await screen.findByText('A')
    expect(screen.getByRole('link', { name: 'A' }).textContent).toContain(en.notif_via_fetch)
    expect(screen.getByRole('link', { name: 'B' }).textContent).toContain(en.notif_via_translate)
    const c = screen.getByRole('link', { name: 'C' })
    expect(c.textContent).toContain(en.notif_via_mixed)
    // mixed 必须同时提到两种来路，不许缩写成其中一种
    expect(en.notif_via_mixed).toContain(en.notif_via_fetch)
    expect(en.notif_via_mixed).toContain(en.notif_via_translate)
    expect(zh.notif_via_mixed).toContain(zh.notif_via_fetch)
    expect(zh.notif_via_mixed).toContain(zh.notif_via_translate)
    // 三个 via 在 DOM 上可分（data 属性，给样式与测试共用）
    expect(c).toHaveAttribute('data-via', 'mixed')
  })

  it('title 是**写入时的快照**，页面如实照搬（不去 join 当前名纠正它）', async () => {
    // 同一 workId 的两条历史行，title 不同（作品一周内改过名）——两条都要如实显示。
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:1', title: 'New Name', season: 2, episodes: [1], latestAt: NOW - 1000, via: 'fetch' },
      { workId: 'tmdb:1', title: 'Old Name', season: 1, episodes: [1], latestAt: NOW - 5000, via: 'fetch' },
    ]))
    renderPage()
    expect(await screen.findByText('New Name')).toBeInTheDocument()
    expect(screen.getByText('Old Name')).toBeInTheDocument()
  })
})

describe('React key：workId/season（没有稳定行 id）', () => {
  // ⚠️ 变异审计（M7：把 groupKey 退化成只返回 workId）实测：下面这条**不会红**。
  // 原因是 React 遇到重复 key **照样渲染两个节点**，只在 console 上警告——所以
  // "两行都在" 这个判据对 key 的正确性是**不敏感**的（它此前写的理由「key 只用
  // workId 的话 React 会丢掉一条」是错的，已改）。
  // 真正对 key 敏感的判据有两个，分别落在下面两条用例上：
  //   · groupKey 的单元用例（notifText.test.ts，M7 下 4 条红）；
  //   · React 的重复 key 警告（下一条，直接监听 console.error）。
  // 这一条保留为**渲染完整性**的回归（两季都在场、内容没串台），不再声称它守 key。
  it('同一作品的两季都渲染出来且内容没串台（渲染完整性，**不是** key 守卫）', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:1', title: 'Same Show S2', season: 2, episodes: [1], latestAt: NOW - 1000, via: 'fetch' },
      { workId: 'tmdb:1', title: 'Same Show S1', season: 1, episodes: [1], latestAt: NOW - 2000, via: 'fetch' },
    ]))
    renderPage()
    await screen.findByText('Same Show S2')
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.getByText('Same Show S1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Same Show S2' }).textContent).toContain('S02')
    expect(screen.getByRole('link', { name: 'Same Show S1' }).textContent).toContain('S01')
  })

  // 🔴 这条才是 DOM 侧的 key 守卫：React 对重复 key 会在 console.error 上警告。
  // M7（key 退化成只返回 workId）下必红。
  it('🔴 同一作品两季共存时 React **没有报重复 key 警告**', async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    try {
      vi.stubGlobal('fetch', mock([
        { workId: 'tmdb:1', title: 'Same Show S2', season: 2, episodes: [1], latestAt: NOW - 1000, via: 'fetch' },
        { workId: 'tmdb:1', title: 'Same Show S1', season: 1, episodes: [1], latestAt: NOW - 2000, via: 'fetch' },
      ]))
      renderPage()
      await screen.findByText('Same Show S2')
      const dup = errors.filter((e) => /same key|duplicate key|unique "key"/i.test(e))
      expect(dup, `React 报了重复 key：${dup[0] ?? ''}`).toEqual([])
      // 防空转：探针真的装上了（React 若改成不再警告，这条守卫要重新评估而不是继续假绿）
      expect(typeof console.error).toBe('function')
    } finally {
      spy.mockRestore()
    }
  })

  it('同一作品的「电影行 + 季行」共存（-1 占位不与真实季号相撞）', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:9', title: 'Movie Row', season: null, episodes: [], latestAt: NOW - 1000, via: 'fetch' },
      { workId: 'tmdb:9', title: 'Season Row', season: 1, episodes: [1], latestAt: NOW - 2000, via: 'fetch' },
    ]))
    renderPage()
    await screen.findByText('Movie Row')
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('重排（刷新后 latestAt 变化导致顺序翻转）不留残影——index 当 key 会在这里露馅', async () => {
    const first: FoundGroupDTO[] = [
      { workId: 'a', title: 'Alpha', season: 1, episodes: [1], latestAt: NOW - 1000, via: 'fetch' },
      { workId: 'b', title: 'Beta', season: 1, episodes: [1], latestAt: NOW - 2000, via: 'translate' },
    ]
    const second: FoundGroupDTO[] = [
      { workId: 'b', title: 'Beta', season: 1, episodes: [1, 2, 3], latestAt: NOW - 100, via: 'translate' },
      { workId: 'a', title: 'Alpha', season: 1, episodes: [1], latestAt: NOW - 1000, via: 'fetch' },
    ]
    let payload = first
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => payload,
    } as unknown as Response)))
    renderPage()
    await screen.findByText('Alpha')
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('aria-label'))).toEqual(['Alpha', 'Beta'])

    payload = second
    // 借错误态之外的唯一刷新入口不可用（没有 banner），直接重挂载模拟刷新后的重排
    cleanup()
    renderPage()
    await screen.findByText('Beta')
    const links = screen.getAllByRole('link')
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Beta', 'Alpha'])
    // Beta 现在带 3 集，Alpha 仍是 1 集——两行的内容没有互相串台
    expect(links[0]!.textContent).toContain('1–3')
    expect(links[1]!.textContent).not.toContain('1–3')
  })
})

describe('行的去处：点一条落到媒体库详情（不是死链，也不是旧 #/library）', () => {
  it('href = #/media/:workId，冒号已编码', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:1396', title: 'Breaking Bad', season: 1, episodes: [1], latestAt: NOW, via: 'fetch' },
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Breaking Bad' })
    expect(row).toHaveAttribute('href', '#/media/tmdb%3A1396')
    // 旧海报墙路由已不在导航里，通知页不许把用户送过去
    expect(row.getAttribute('href')).not.toContain('#/library')
  })
})

describe('中文侧渲染的是译文不是键名', () => {
  it('zh 下空态/段落标题都是中文', async () => {
    vi.stubGlobal('fetch', mock([]))
    renderPage('zh')
    expect(await screen.findByText(zh.notif_empty_title)).toBeInTheDocument()
    expect(screen.queryByText('notif_empty_title')).toBeNull()
  })

  it('zh 下集号是「第 3/5/7 集」（前后夹量词，en 侧后缀为空）', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'a', title: '剧', season: 1, episodes: [3, 5, 7], latestAt: NOW, via: 'fetch' },
    ]))
    renderPage('zh')
    const row = await screen.findByRole('link', { name: '剧' })
    expect(row.textContent).toContain('第 3 / 5 / 7集')
    // 两侧至少一侧的后缀非空（否则 suffix 这个键是纯噪音）
    expect(zh.notif_episodes_suffix.length + en.notif_episodes_suffix.length).toBeGreaterThan(0)
  })
})
