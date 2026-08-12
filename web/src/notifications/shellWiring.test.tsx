// web/src/notifications/shellWiring.test.tsx：**Shell 层**的通知页接线守卫。
//
// ── 这个文件为什么存在（Task ⑧ 的 M22 变异抓到的同型洞）─────────────────────
// 组件级测试全在测组件自己（给它 mock 的端点它就渲染），路由测试全在测 parseShellHash
// （hash 解析对了），**中间那条"Shell 拿解析结果去选组件"的接线**没有任何人钉着。
// Task ⑧ 实测过：把 AppShell 的二级路由三元改成恒渲染列表页，162 条测试 0 红。
//
// 本 task 的同型形态更简单也更致命：AppShell 里 `route.tab === 'notifications' &&`
// 那一行如果还指着**已经删掉的占位组件**，或干脆被删掉，结果是：
//   · 指着占位 → 页面渲染"施工中"，端点一次都不打，但没有任何测试会红
//     （AppShell.nav.test.tsx 只断言"主区有 EngineBanner 之外的实质内容"——占位页有）
//   · 被删掉 → 主区一片空白，侧栏还高亮着（tabs.ts 头注释点名的那个静默失效）
//
// 判据必须是**运行时**的，且要能区分"真页面"与"占位页"：
//   ① 渲染整个 Shell、真的把 hash 切到 #/notifications
//   ② 数**真实发出的请求**——真页面会打 /api/v2/notifications，占位页不会
//   ③ 端点返回的数据**真的上了屏**（打了请求但不渲染 = 另一种半接线）
//   ④ 占位页的标志物（施工中）**不在场**
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { Shell } from '../shell/AppShell.js'
import { __resetEventsBusForTests } from '../events/eventsBus.js'
import { en } from '../i18n/en.js'
import type { FoundGroupDTO } from '../api/types.js'

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

const NOW = Date.now()
const ROWS: FoundGroupDTO[] = [
  { workId: 'tmdb:1396', title: 'Breaking Bad', season: 1, episodes: [3, 5, 7],
    latestAt: NOW - 3600_000, via: 'fetch' },
]

let urls: string[] = []

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const path = url.split('?')[0] ?? ''
    const body: unknown =
      url.includes('/api/v2/setup/status')
        ? { initialized: true, engineEnabled: true,
            providers: { subhd: { enabled: false }, zimuku: { enabled: false },
                         opensubtitles: { enabled: false }, jimaku: { enabled: false } },
            secrets: {} }
      : /\/api\/v2\/notifications$/.test(path) ? ROWS
      : /\/api\/v2\/mediaLibrary$/.test(path) ? []
      : path.includes('/api/v2/mediaLibrary/')
        ? { work: { workId: 'tmdb:1', title: 'W', chineseTitle: null, year: null,
                    posterPath: null, mediaType: 'tv' },
            seasons: [], movie: null, unplacedFileCount: 0 }
      : url.includes('/workflow/pending')
        ? { meta: { roots: [], lastScanAt: null, files: 0, lastVerifySweepAt: null,
                    verifiedItems: 0, verifiableItems: 0 }, parked: 0 }
      : {}
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
}

beforeEach(() => {
  urls = []
  FakeES.instances = []
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
  vi.stubGlobal('fetch', mockFetch())
  location.hash = ''
})
afterEach(() => {
  cleanup()
  __resetEventsBusForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  location.hash = ''
})

const renderShell = () => render(<I18nProvider initialLang="en"><Shell /></I18nProvider>)

const notifCalls = () => urls.filter((u) => /\/api\/v2\/notifications$/.test(u.split('?')[0] ?? ''))

describe('Shell 接线：#/notifications 渲染的是真页面（不是占位、不是空白）', () => {
  // 🔴 这一条是 M22 同型洞的正面判据：分支指回占位组件 / 被删掉，它必红。
  it('#/notifications → **真的打了** /api/v2/notifications，且数据上了屏', async () => {
    location.hash = '#/notifications'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByRole('link', { name: 'Breaking Bad' })).toBeInTheDocument()
    })
    expect(notifCalls(), '通知端点一次都没被打——分支没接到真页面上').toHaveLength(1)
    // 端点数据逐字段上屏（打了请求却不渲染 = 另一种半接线）
    const row = within(main).getByRole('link', { name: 'Breaking Bad' })
    expect(row.textContent).toContain('S01')
    expect(row.textContent).toContain('3 / 5 / 7')
  })

  it('占位页的标志物（施工中）**不在场**', async () => {
    location.hash = '#/notifications'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => expect(within(main).getByRole('link', { name: 'Breaking Bad' })).toBeInTheDocument())
    expect(within(main).queryByText(en.placeholder_under_construction)).toBeNull()
  })

  it('别的 tab **不打**通知端点（Shell 每次渲染都跑全部 hook 的话会白打）', async () => {
    location.hash = '#/media'
    renderShell()
    await screen.findByRole('main')
    await waitFor(() => expect(urls.some((u) => u.includes('/api/v2/mediaLibrary'))).toBe(true))
    expect(notifCalls(), '不在通知页却打了通知端点').toHaveLength(0)
  })

  it('侧栏高亮的是 notifications', async () => {
    location.hash = '#/notifications'
    renderShell()
    const link = await screen.findByRole('link', { name: en.nav_notifications })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  it('通知页与媒体库页的主区内容互不相同（渲染成同一个组件时红）', async () => {
    const texts: string[] = []
    for (const hash of ['#/notifications', '#/media']) {
      location.hash = hash
      renderShell()
      const main = await screen.findByRole('main')
      await waitFor(() => expect((main.textContent ?? '').trim().length).toBeGreaterThan(0))
      texts.push((main.textContent ?? '').trim())
      cleanup()
      __resetEventsBusForTests()
    }
    expect(new Set(texts).size).toBe(2)
  })

  it('行的链接真的能进媒体库详情（href 与路由解析闭环）', async () => {
    location.hash = '#/notifications'
    renderShell()
    const main = await screen.findByRole('main')
    const row = await within(main).findByRole('link', { name: 'Breaking Bad' })
    expect(row).toHaveAttribute('href', '#/media/tmdb%3A1396')
  })

  it('#/notifications **没有二级路由**——带一段的 hash 仍落在通知页本体', async () => {
    location.hash = '#/notifications/whatever'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByRole('link', { name: 'Breaking Bad' })).toBeInTheDocument()
    })
    expect(notifCalls()).toHaveLength(1)
  })
})

describe('SSE 连接：通知页订阅 found → 整个 app 仍然只有一条连接', () => {
  it('打开通知页会建立 SSE 连接（惰性连接被真的触发了）', async () => {
    location.hash = '#/notifications'
    renderShell()
    await screen.findByRole('main')
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
  })

  it('**只有一条**（R-F10 约束 3：HTTP/1.1 每源 6 连接上限）', async () => {
    location.hash = '#/notifications'
    renderShell()
    await screen.findByRole('main')
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    // 等页面完全稳定后再确认没有第二条被开出来
    await waitFor(() => expect(screen.getAllByRole('link').length).toBeGreaterThan(0))
    expect(FakeES.instances).toHaveLength(1)
  })
})
