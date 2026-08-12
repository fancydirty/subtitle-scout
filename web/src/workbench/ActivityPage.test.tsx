// web/src/workbench/ActivityPage.test.tsx —— 活动页的**运行时**行为守卫。
//
// ══════════════════════════════════════════════════════════════════════════════
// 为什么全部是"渲染整页 + 驱动真事件 + 数 DOM/请求"，没有一条源码级断言
// ══════════════════════════════════════════════════════════════════════════════
// Task ⑤ 的教训：源码级断言（读源码字符串核对 import/调用）被**一行行尾注释**喂饱，
// 4 条全部假绿，最后整个文件被删。Task ⑧ 的教训更进一层：一个自称"走 import 图"的
// 隔离测试，实测守的是**恒真命题**。
//
// 故本文件的每一条判据都是**可被变异推翻的运行时事实**：
//  · R-F1 剔除 → 数两个 tab 里的卡片数（把剔除删掉 → 识别的卡片冒出来 → 红）
//  · 重连纠正 → 数 /api/v2/health 的**请求次数**（把拉取删掉 → 次数不涨 → 红）
//  · 巡检级事件 → 断言它出现在状态条、且**不在**任何 tab 里
//  · R-F13 降级 → 断言 data-noimg 与 img 的存在性
//
// ⚠️ 每条断言都配了**阳性对照**（"改坏之前它确实是另一个样子"）：
// 只断言"识别的卡片不在场"的话，一个恒渲染空白的页面也会全绿。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor, within, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { EventsProvider } from '../events/EventsProvider.js'
import { __resetEventsBusForTests } from '../events/eventsBus.js'
import { ActivityPage } from './ActivityPage.js'
import { en } from '../i18n/en.js'
import type { ScoutEvent } from '../events/types.js'

// ── 假 EventSource（逐字照 EventsProvider.test.tsx 的既有手法）───────────────
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
  roots: [], current: null,
}

const QUEUE_ITEM = {
  workId: 'tmdb:1', title: 'Queued Show', chineseTitle: null, year: 2018,
  mediaType: 'tv' as const, posterPath: '/p.jpg', backdropPath: '/bd.jpg', pendingFileCount: 13,
}
const TRANSLATE_ITEM = {
  workId: 'tmdb:9', title: 'Trans Show', chineseTitle: null, year: 2020,
  mediaType: 'tv' as const, posterPath: '/p9.jpg', backdropPath: '/bd9.jpg', pendingFileCount: 4,
}

/** 每个 URL 的请求次数——重连纠正那条的**判据本体**（不是 DOM 文案）。 */
let urls: string[] = []
let healthBody: unknown = HEALTH_IDLE
let activityBody: unknown = { subtitleQueue: [QUEUE_ITEM], translateQueue: [TRANSLATE_ITEM] }
let activityOk = true

function countOf(fragment: string): number {
  return urls.filter((u) => u.includes(fragment)).length
}

beforeEach(() => {
  FakeES.instances = []
  seq = 0
  urls = []
  healthBody = HEALTH_IDLE
  activityBody = { subtitleQueue: [QUEUE_ITEM], translateQueue: [TRANSLATE_ITEM] }
  activityOk = true
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/api/v2/health')) {
      return { ok: true, status: 200, json: async () => healthBody } as unknown as Response
    }
    if (url.includes('/api/v2/activity')) {
      return {
        ok: activityOk, status: activityOk ? 200 : 500,
        json: async () => (activityOk ? activityBody : { error: 'db locked' }),
      } as unknown as Response
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
  }))
})
afterEach(() => { cleanup(); __resetEventsBusForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const renderPage = () =>
  render(<I18nProvider initialLang="en"><EventsProvider><ActivityPage /></EventsProvider></I18nProvider>)

const bus = () => FakeES.instances[0]!

/** 等页面把首载两个请求都收完（队列渲染出来 = 两段都到位）。 */
async function ready() {
  await waitFor(() => expect(countOf('/api/v2/activity')).toBeGreaterThan(0))
  await screen.findByText('Queued Show')
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 R-F1：识别不进活动页
// ═══════════════════════════════════════════════════════════════════════════
describe('🔴 R-F1：识别事件被剔出两个 tab，降级为顶部状态条', () => {
  it('识别的 activity → 状态条出现「Identifying：X」，**两个 tab 里都没有它的在跑卡片**', async () => {
    renderPage()
    await ready()

    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在识别：/media/New', title: '/media/New', workbench: 'identify' }))
    })

    // ① 它没被丢掉——出现在状态条（R-F1 的裁决是"降级"，不是"扔掉"）
    await waitFor(() => {
      expect(screen.getByTestId('wb-identify-line').textContent).toContain('/media/New')
    })

    // ② 🔴 两个 tab 都不给它画在跑卡片。逐个 tab 切过去看。
    for (const tabName of [en.wb_tab_subtitle, en.wb_tab_translate]) {
      fireEvent.click(screen.getByRole('tab', { name: tabName }))
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: tabName })).toHaveAttribute('aria-selected', 'true')
      })
      expect(screen.queryByTestId('wb-run-card'), `识别的卡片出现在 ${tabName} tab 里 → R-F1 被违反`).toBeNull()
      expect(screen.getByTestId('wb-run-empty')).toBeInTheDocument()
    }
  })

  // ⭐ 阳性对照：**同样形状**的事件配 workbench=subtitle 时，卡片必须出现。
  // 没有这一条的话，一个"永远不画在跑卡片"的坏实现会让上面那条全绿。
  it('⭐ 阳性对照：同一条事件改成 workbench=subtitle → 在跑卡片**确实出现**', async () => {
    renderPage()
    await ready()

    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在找字幕：Show A', title: 'Show A', workbench: 'subtitle' }))
    })

    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    expect(screen.getByTestId('wb-run-card').textContent).toContain('Show A')
    // 而且它**不该**同时出现在状态条的识别那一行
    expect(screen.queryByTestId('wb-identify-line')).toBeNull()
  })

  it('识别的 progress（带 done/total）同样不进 tab，只在状态条上带出进度', async () => {
    renderPage()
    await ready()

    act(() => {
      bus().emit(ev({
        type: 'progress', message: '识别第 3/47 个', title: '/media/New',
        workbench: 'identify', data: { done: 3, total: 47 },
      }))
    })

    await waitFor(() => {
      expect(screen.getByTestId('wb-identify-line').textContent).toContain('3/47')
    })
    expect(screen.queryByTestId('wb-run-card')).toBeNull()
  })

  it('🔴 tab 只有两个（字幕 / 翻译）——识别没有自己的 tab', async () => {
    renderPage()
    await ready()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs.map((t) => t.textContent)).toEqual([en.wb_tab_subtitle, en.wb_tab_translate])
  })

  it('翻译事件进翻译 tab，**不进**字幕 tab（两个台不许串味）', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在翻译：T', title: 'T', workbench: 'translate' }))
    })
    // 字幕 tab（默认）上没有在跑卡片
    await waitFor(() => expect(screen.getByTestId('wb-run-empty')).toBeInTheDocument())
    // 切到翻译 tab 才有
    fireEvent.click(screen.getByRole('tab', { name: en.wb_tab_translate }))
    await waitFor(() => expect(screen.getByTestId('wb-run-card').textContent).toContain('T'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 巡检级/扫描级事件（无 workbench）
// ═══════════════════════════════════════════════════════════════════════════
describe('巡检级/扫描级事件（无 workbench 的 6 个 emit 点）', () => {
  it('「巡检开始」出现在状态条，**不进任何 tab**', async () => {
    renderPage()
    await ready()
    act(() => { bus().emit(ev({ type: 'activity', message: '巡检开始' })) })
    await waitFor(() => {
      expect(screen.getByTestId('wb-patrol-line').textContent).toContain('巡检开始')
    })
    expect(screen.queryByTestId('wb-run-card')).toBeNull()
  })

  it('扫描级 health（守备目录读取失败）同样进状态条，不进 tab、**也不丢**', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({ type: 'health', message: '守备目录读取失败，本轮跳过（2 次）: /media' }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-patrol-line').textContent).toContain('守备目录读取失败')
    })
    expect(screen.queryByTestId('wb-run-card')).toBeNull()
  })

  it('🔴 巡检级事件**清空**当前态（"巡检完成"之后不许还挂着"正在处理 X"）', async () => {
    renderPage()
    await ready()
    // 先让一个作品在跑
    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在找字幕：Show A', title: 'Show A', workbench: 'subtitle' }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())

    // 巡检收工（daemonV2 真实会发的那条，不带 workbench）
    act(() => { bus().emit(ev({ type: 'activity', message: '字幕工作台跑完，处理了 1 个作品' })) })

    // 🔴 在跑卡片必须消失——这正是后端 ScoutEventBus.updateCurrent 的同一条口径。
    await waitFor(() => expect(screen.queryByTestId('wb-run-card')).toBeNull())
    expect(screen.getByTestId('wb-run-empty')).toBeInTheDocument()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 断线重连：靠 /api/v2/health 快照纠正
// ═══════════════════════════════════════════════════════════════════════════
describe('🔴 断线重连 → 拉 /api/v2/health 快照纠正当前态（后端 F-6）', () => {
  it('SSE 从断线恢复到 open → **真的重新打了 /api/v2/health**（判据是请求次数）', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    await waitFor(() => expect(countOf('/api/v2/health')).toBeGreaterThan(0))
    const before = countOf('/api/v2/health')

    // 断线 → 浏览器放弃（CLOSED）→ 我们退避重连 → 新连接 open
    act(() => { bus().fail(2) })
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1))
    act(() => { FakeES.instances[FakeES.instances.length - 1]!.open() })

    // 🔴 变异判据：把重连纠正那段删掉 → 这个计数不涨 → 红。
    await waitFor(() => {
      expect(countOf('/api/v2/health'), '重连后没有重新拉快照 → 断线期间的变化永远纠正不回来')
        .toBeGreaterThan(before)
    })
  })

  it('🔴 断线期间巡检跑完 → 重连后当前态被快照纠正成"空闲"（不再停在"正在处理 X"）', async () => {
    // 这就是 F-6 描述的那个真实剧本：SSE 是变化流，断线期间的"巡检完成"丢了，
    // 光靠 SSE 前端会**永远**停在上一次看到的那句"正在处理 X"。
    renderPage()
    await ready()
    act(() => { bus().open() })
    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在找字幕：Show A', title: 'Show A', workbench: 'subtitle' }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())

    // 断线期间后端跑完了整轮：快照现在说"没有任何工作台在跑"
    healthBody = { ...HEALTH_IDLE, current: null }
    act(() => { bus().fail(2) })
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1))
    act(() => { FakeES.instances[FakeES.instances.length - 1]!.open() })

    // 🔴 在跑卡片必须消失。变异（去掉快照拉取）→ 卡片留在屏幕上 → 红。
    await waitFor(() => {
      expect(screen.queryByTestId('wb-run-card'), '重连后仍停在"正在处理 X"——F-6 的那个缺陷')
        .toBeNull()
    })
  })

  // ⭐ 阳性对照：反过来——断线期间**开始**处理了一个新作品，快照要能把它纠正**进来**。
  // 只测"纠正成空"的话，一个"重连即清空"的坏实现也会绿。
  it('⭐ 阳性对照：断线期间开工 → 重连后快照把"正在处理 X"纠正**进来**', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    expect(screen.getByTestId('wb-run-empty')).toBeInTheDocument()

    healthBody = {
      ...HEALTH_IDLE,
      current: { kind: 'subtitle', title: 'Started While Offline', index: 2, total: 7 },
    }
    act(() => { bus().fail(2) })
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1))
    act(() => { FakeES.instances[FakeES.instances.length - 1]!.open() })

    await waitFor(() => {
      expect(screen.getByTestId('wb-run-card').textContent).toContain('Started While Offline')
    })
    // 进度也来自快照（第 2/7 个）
    expect(screen.getByTestId('wb-run-card').textContent).toContain('2/7')
  })

  it('重连也重拉排队段（断线期间队列的变化一次补齐）', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    const before = countOf('/api/v2/activity')
    act(() => { bus().fail(2) })
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1))
    act(() => { FakeES.instances[FakeES.instances.length - 1]!.open() })
    await waitFor(() => expect(countOf('/api/v2/activity')).toBeGreaterThan(before))
  })

  it('首载就拉一次快照（不是只在重连时才拉——冷启动同样需要当前态）', async () => {
    renderPage()
    await waitFor(() => expect(countOf('/api/v2/health')).toBe(1))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// R-F13：两种卡片与无图降级
// ═══════════════════════════════════════════════════════════════════════════
describe('R-F13：全背景式卡片与无图降级', () => {
  it('排队卡片用**竖版 poster**（w400 CDN），在跑卡片用**横版 backdrop**（w1280）', async () => {
    renderPage()
    await ready()
    // 排队：poster
    const queued = screen.getAllByTestId('wb-queue-card')[0]!
    const qImg = queued.querySelector('img')!
    expect(qImg.getAttribute('src')).toContain('/p.jpg')
    expect(qImg.getAttribute('src')).toContain('w400')

    // 在跑：backdrop（靠 data.workId 从队列表里查到同一个作品）
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:1' },
      }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    const rImg = screen.getByTestId('wb-run-card').querySelector('img')!
    expect(rImg.getAttribute('src')).toContain('/bd.jpg')
    expect(rImg.getAttribute('src')).toContain('w1280')
  })

  // 🔴 取图靠 workId 而不是标题匹配。
  it('🔴 workId 对不上 → 不配图（**不拿标题去猜**：同名翻拍会配错图）', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:OTHER' },
      }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    const card = screen.getByTestId('wb-run-card')
    // 标题一模一样，但 id 不同 → 绝不许借用那张图
    expect(card.querySelector('img')).toBeNull()
    expect(card.getAttribute('data-noimg')).toBe('true')
  })

  it('posterPath 为 null → 无图降级（data-noimg，不画 img、不画首字母块）', async () => {
    activityBody = {
      subtitleQueue: [{ ...QUEUE_ITEM, posterPath: null, backdropPath: null }],
      translateQueue: [],
    }
    renderPage()
    await ready()
    const card = screen.getAllByTestId('wb-queue-card')[0]!
    expect(card.getAttribute('data-noimg')).toBe('true')
    expect(card.querySelector('img')).toBeNull()
  })

  it('图加载失败（onError）→ 同样降级成 data-noimg', async () => {
    renderPage()
    await ready()
    const card = screen.getAllByTestId('wb-queue-card')[0]!
    expect(card.getAttribute('data-noimg')).toBe('false')
    act(() => { fireEvent.error(card.querySelector('img')!) })
    await waitFor(() => {
      expect(screen.getAllByTestId('wb-queue-card')[0]!.getAttribute('data-noimg')).toBe('true')
    })
  })

  it('副行「2018 · Series · 13 pending」——年份缺席时那一段整段不出现（不留 "· ·"）', async () => {
    activityBody = {
      subtitleQueue: [{ ...QUEUE_ITEM, year: null }],
      translateQueue: [],
    }
    renderPage()
    await ready()
    const text = screen.getAllByTestId('wb-queue-card')[0]!.textContent ?? ''
    expect(text).toContain(en.wb_media_tv)
    expect(text).toContain(`13 ${en.wb_pending_files}`)
    expect(text).not.toContain('· ·')
  })

  it('中文译名优先于原名（chineseTitle 非空时用它）', async () => {
    activityBody = {
      subtitleQueue: [{ ...QUEUE_ITEM, chineseTitle: '排队中的剧' }],
      translateQueue: [],
    }
    renderPage()
    // ⚠️ 不能用 ready()——它等的是原名 'Queued Show'，而本用例的判据恰恰是那个名字
    // **不**上屏（被译名取代）。等译名本身。
    const card = await screen.findByTestId('wb-queue-card')
    expect(card.textContent).toContain('排队中的剧')
    expect(card.textContent).not.toContain('Queued Show')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 两个数字来源的分工（与 health「不返回 queue」那条裁决）
// ═══════════════════════════════════════════════════════════════════════════
describe('🔴 「第 i/n 个」只信 SSE，排队列表只信 /api/v2/activity（两者不互相推导）', () => {
  it('进度读数来自 SSE 的 done/total，**不是** queue.length 算出来的', async () => {
    // 队列里有 1 项（subtitleQueue），而 SSE 说的是 3/47。若有人拿 queue.length 当 n，
    // 这里会显示 3/1。
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'progress', message: '第 3/47 个作品', title: 'Show A',
        workbench: 'subtitle', data: { done: 3, total: 47, workId: 'tmdb:1' },
      }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card').textContent).toContain('3/47'))
    expect(screen.getByTestId('wb-run-card').textContent).not.toContain('3/1')
  })

  it('index/total 为 null（activity 之后、progress 之前）→ **不渲染进度行**，不编 "0/0"', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在找字幕：Show A', title: 'Show A', workbench: 'subtitle' }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    // 后端注释明写那是"诚实的 null，不是缺陷"——编一个 0/0 就是把未知说成已知。
    expect(screen.getByTestId('wb-run-card').textContent).not.toContain('0/0')
  })

  it('排队段的条数就是端点给的条数（不被 SSE 的 total 截断）', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'progress', message: '第 1/1 个作品', title: 'X',
        workbench: 'subtitle', data: { done: 1, total: 1 },
      }))
    })
    // SSE 说 total=1（已经跑到最后一个），但排队端点说还有 1 项 → 照 1 项渲染。
    await waitFor(() => expect(screen.getAllByTestId('wb-queue-card')).toHaveLength(1))
  })

  it('两个 tab 各自读自己那一段队列（字幕 1 项 / 翻译 1 项，不混）', async () => {
    renderPage()
    await ready()
    expect(screen.getAllByTestId('wb-queue-card')).toHaveLength(1)
    expect(screen.getAllByTestId('wb-queue-card')[0]!.textContent).toContain('Queued Show')

    fireEvent.click(screen.getByRole('tab', { name: en.wb_tab_translate }))
    await waitFor(() => {
      expect(screen.getAllByTestId('wb-queue-card')[0]!.textContent).toContain('Trans Show')
    })
    expect(screen.getAllByTestId('wb-queue-card')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 状态条：两条债务的可见形态
// ═══════════════════════════════════════════════════════════════════════════
describe('状态条：lastInspectAt 语义与 daemon 可能没在跑', () => {
  it('🔴 idle 时说的是「上次巡检**开始于**」——不许说"完成于"（债务一）', async () => {
    renderPage()
    await ready()
    expect(screen.getByTestId('wb-inspect-line').textContent).toContain(en.wb_inspect_idle)
    // 英文文案里必须有 started、不许有 completed/finished
    expect(en.wb_inspect_idle.toLowerCase()).toContain('started')
    expect(en.wb_inspect_idle.toLowerCase()).not.toMatch(/complet|finish|ended/)
  })

  it('🔴 空闲 + 太久没开新一轮 → 状态条报「引擎可能没在跑」（债务二：陈旧门报绿 48h）', async () => {
    healthBody = { ...HEALTH_IDLE, lastInspectAt: Date.now() - 3 * 24 * 3_600_000, current: null }
    renderPage()
    await ready()
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-line').textContent).toContain(en.wb_inspect_stale)
    })
    // 双通道：不只靠颜色，容器上还有可断言的 data-stale（Carbon 规则）
    expect(screen.getByLabelText(en.wb_statusbar_label).getAttribute('data-stale')).toBe('true')
  })

  it('⭐ 阳性对照：同样很旧但**有工作台在跑** → 报「正在巡检」，不报死', async () => {
    healthBody = {
      ...HEALTH_IDLE,
      lastInspectAt: Date.now() - 3 * 24 * 3_600_000,
      current: { kind: 'subtitle', title: 'Big Library', index: 3, total: 400 },
    }
    renderPage()
    await ready()
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-line').textContent).toContain(en.wb_inspect_running)
    })
    expect(screen.getByLabelText(en.wb_statusbar_label).getAttribute('data-stale')).toBe('false')
  })

  it('lastInspectAt 为 null → 冷启动文案，**绝不出现 1970**', async () => {
    healthBody = { ...HEALTH_IDLE, lastInspectAt: null }
    renderPage()
    await ready()
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-line').textContent).toContain(en.wb_inspect_never)
    })
    expect(screen.getByLabelText(en.wb_statusbar_label).textContent).not.toContain('1970')
  })

  it('🔴 读 workPermitted 而不是 engineEnabled：开关开着但凭据没配 → 报"去配凭据"', async () => {
    healthBody = { ...HEALTH_IDLE, workPermitted: false, engineEnabled: true, setupSatisfied: false }
    renderPage()
    await ready()
    await waitFor(() => {
      expect(screen.getByTestId('wb-perm-line').textContent).toBe(en.wb_setup_incomplete)
    })
  })

  it('开关关了（凭据齐）→ 报"引擎关着"，与上一条**不同**的一句话', async () => {
    healthBody = { ...HEALTH_IDLE, workPermitted: false, engineEnabled: false, setupSatisfied: true }
    renderPage()
    await ready()
    await waitFor(() => {
      expect(screen.getByTestId('wb-perm-line').textContent).toBe(en.wb_engine_off)
    })
  })

  it('一切正常 → 不显示任何不许可提示', async () => {
    renderPage()
    await ready()
    expect(screen.queryByTestId('wb-perm-line')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 数据获取与异常态
// ═══════════════════════════════════════════════════════════════════════════
describe('数据获取：刷新触发点与异常态', () => {
  it('收到 activity 事件 → 重拉排队段（队列刚变了）', async () => {
    renderPage()
    await ready()
    const before = countOf('/api/v2/activity')
    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在找字幕：X', title: 'X', workbench: 'subtitle' }))
    })
    await waitFor(() => expect(countOf('/api/v2/activity')).toBeGreaterThan(before))
  })

  it('🔴 progress 事件**不**重拉排队段（高频，会打成请求风暴）', async () => {
    renderPage()
    await ready()
    const before = countOf('/api/v2/activity')
    for (let i = 0; i < 10; i++) {
      act(() => {
        bus().emit(ev({
          type: 'progress', message: `第 ${i}/10 个`, title: 'X',
          workbench: 'subtitle', data: { done: i, total: 10 },
        }))
      })
    }
    // 进度确实上屏了（排除"什么都没发生"的假绿）
    await waitFor(() => expect(screen.getByTestId('wb-run-card').textContent).toContain('9/10'))
    expect(countOf('/api/v2/activity'), 'progress 触发了重拉 → 10 条进度 = 10 个请求').toBe(before)
  })

  it('端点失败 → 显示错误 + 重试按钮，**绝不显示空态文案**（§4.4 谎报）', async () => {
    activityOk = false
    renderPage()
    await waitFor(() => expect(screen.getByText(en.wb_error_title)).toBeInTheDocument())
    // "没有排队"与"我没能问到"是两件事
    expect(screen.queryByTestId('wb-queue-empty')).toBeNull()
    expect(screen.getByText(/db locked/)).toBeInTheDocument()
  })

  it('错误态的重试按钮真的重发（探针计数 +1）', async () => {
    activityOk = false
    renderPage()
    await waitFor(() => expect(screen.getByText(en.wb_error_title)).toBeInTheDocument())
    const before = countOf('/api/v2/activity')
    fireEvent.click(screen.getByRole('button', { name: en.wb_retry }))
    await waitFor(() => expect(countOf('/api/v2/activity')).toBe(before + 1))
  })

  it('🔴 队列端点挂了**不影响状态条**（两条独立的路，一条挂了不许把另一条藏起来）', async () => {
    activityOk = false
    renderPage()
    await waitFor(() => expect(screen.getByText(en.wb_error_title)).toBeInTheDocument())
    expect(screen.getByTestId('wb-inspect-line')).toBeInTheDocument()
  })

  it('空队列 → 空态文案（与错误态是两句不同的话）', async () => {
    activityBody = { subtitleQueue: [], translateQueue: [] }
    renderPage()
    await waitFor(() => expect(screen.getByTestId('wb-queue-empty')).toBeInTheDocument())
    expect(screen.queryByText(en.wb_error_title)).toBeNull()
  })

  it('🔴 **不轮询**：60 秒过去两个端点都只有首载那一次', async () => {
    vi.useFakeTimers()
    try {
      renderPage()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const h = countOf('/api/v2/health')
      const a = countOf('/api/v2/activity')
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(countOf('/api/v2/health'), '/health 在轮询 → 与 SSE 重复（R-F6）').toBe(h)
      expect(countOf('/api/v2/activity'), '/activity 在轮询').toBe(a)
    } finally {
      vi.useRealTimers()
    }
  })
})
