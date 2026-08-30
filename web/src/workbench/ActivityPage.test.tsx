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
import { render, screen, cleanup, act, waitFor, fireEvent, within } from '@testing-library/react'
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
  /** 进程重启后的 hello 帧：换 bootId 才能把 lastSeenId 清零，否则 id 从 1 再起会被去重门丢掉。 */
  hello(bootId: string) {
    for (const fn of this.listeners.get('hello') ?? []) fn({ data: JSON.stringify({ bootId }) })
  }
  open() { this.readyState = 1; this.onopen?.() }
  fail(readyState: number) { this.readyState = readyState; this.onerror?.() }
}

let seq = 0
const ev = (over: Partial<ScoutEvent> & Pick<ScoutEvent, 'type'>): ScoutEvent => ({
  id: ++seq, at: Date.now(), message: 'm', ...over,
})

const lastInspectAtIdle = Date.now() - 3_600_000
const HEALTH_IDLE = {
  lastInspectAt: lastInspectAtIdle,
  nextInspectAt: lastInspectAtIdle + 24 * 60 * 60 * 1000,
  workPermitted: true, engineEnabled: true, setupSatisfied: true,
  roots: [], unidentified: { dirCount: 0, dirs: [] },
  stalledJobs: { count: 0, overdueMs: null as number | null }, current: null,
}

const QUEUE_ITEM = {
  workId: 'tmdb:1', title: 'Queued Show', chineseTitle: null, year: 2018,
  mediaType: 'tv' as const, posterPath: '/p.jpg', backdropPath: '/bd.jpg', pendingFileCount: 13,
  dueNow: true, retryAfter: null as number | null, awaitingRescan: false,
}
const TRANSLATE_ITEM = {
  workId: 'tmdb:9', title: 'Trans Show', chineseTitle: null, year: 2020,
  mediaType: 'tv' as const, posterPath: '/p9.jpg', backdropPath: '/bd9.jpg', pendingFileCount: 4,
  dueNow: true, retryAfter: null as number | null, awaitingRescan: false,
}

/** 每个 URL 的请求次数——重连纠正那条的**判据本体**（不是 DOM 文案）。 */
let urls: string[] = []
let fetchCalls: Array<{ url: string; method: string | undefined }> = []
let healthBody: unknown = HEALTH_IDLE
let activityBody: unknown = { subtitleQueue: [QUEUE_ITEM], translateQueue: [TRANSLATE_ITEM] }
let activityOk = true
/** POST /library/inspect 的响应覆盖；null = 默认 200 `{ok:true}`。 */
let inspectRes: { ok: boolean; status: number; json: () => Promise<unknown> } | 'network' | null = null
/** 挂起所有 inspect POST，直到测试 release——用来把两次 click 送进同一个 in-flight 窗口。 */
let inspectHold: Promise<void> | null = null
let inspectQueue: Array<{ ok: boolean; status: number; json: () => Promise<unknown> }> = []

function countOf(fragment: string): number {
  return urls.filter((u) => u.includes(fragment)).length
}

beforeEach(() => {
  FakeES.instances = []
  seq = 0
  urls = []
  fetchCalls = []
  inspectRes = null
  inspectHold = null
  inspectQueue = []
  healthBody = HEALTH_IDLE
  activityBody = { subtitleQueue: [QUEUE_ITEM], translateQueue: [TRANSLATE_ITEM] }
  activityOk = true
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    fetchCalls.push({ url, method: typeof init?.method === 'string' ? init.method : undefined })
    if (url.includes('/api/v2/library/inspect')) {
      if (inspectHold) await inspectHold
      if (inspectRes === 'network') throw new Error('failed to fetch')
      const queued = inspectQueue.shift()
      if (queued) return queued as unknown as Response
      if (inspectRes) return inspectRes as unknown as Response
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response
    }
    if (url.includes('/api/v2/runs?')) {
      // RunsHistory 段（2026-08-15）也随活动页渲染：历史是空数组（多数用例不关心它，
      // stub 给真实形状——catch-all 那档返回 {} 会被组件的形状防御判成错误态）。
      return { ok: true, status: 200, json: async () => [] } as unknown as Response
    }
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
// 🔴-4：记着失败、却再也没被重试的活
// ═══════════════════════════════════════════════════════════════════════════
// 生产实测：2 行 failed、过期 66 小时、jobs 队列已无认领者，而三页产品没有任何地方
// 读 jobs——这两条在界面上**完全不存在**。
describe('🔴-4 停摆的活在状态条上说得出来', () => {
  it('🔴 count>0 → 状态条多一行，说出条数与"多久没再重试"', async () => {
    healthBody = { ...HEALTH_IDLE, stalledJobs: { count: 2, overdueMs: 66 * 3_600_000 } }
    renderPage()
    await ready()
    const line = await screen.findByTestId('wb-stalled-jobs-line')
    expect(line.textContent).toContain('2')
    expect(within(line).getByTestId('wb-stalled-jobs-age').textContent).toContain('2d')
  })

  it('🔴 count=0 → **整段不在场**（健康的队列一个字都不占屏）', async () => {
    renderPage()
    await ready()
    expect(screen.queryByTestId('wb-stalled-jobs-line')).toBeNull()
  })

  it('🔴 字段缺席（老后端）→ 整段不在场，**不报一句"都好着呢"**', async () => {
    const { stalledJobs: _drop, ...legacy } = HEALTH_IDLE
    healthBody = legacy
    renderPage()
    await ready()
    expect(screen.queryByTestId('wb-stalled-jobs-line')).toBeNull()
    // 阳性对照：状态条本身还在（不是整页崩了才"看不到"）
    expect(screen.getByTestId('wb-inspect-line')).toBeInTheDocument()
  })

  it('🔴 overdueMs 缺席 → 只说条数，**不编一个时长**', async () => {
    healthBody = { ...HEALTH_IDLE, stalledJobs: { count: 1, overdueMs: null } }
    renderPage()
    await ready()
    const line = await screen.findByTestId('wb-stalled-jobs-line')
    expect(line.textContent).toContain('1')
    expect(within(line).queryByTestId('wb-stalled-jobs-age')).toBeNull()
  })

  it('🔴 **不给按钮**（唯一可能的那个写出来的行同样没人领 → 打不通的按钮）', async () => {
    healthBody = { ...HEALTH_IDLE, stalledJobs: { count: 2, overdueMs: 66 * 3_600_000 } }
    renderPage()
    await ready()
    const line = await screen.findByTestId('wb-stalled-jobs-line')
    expect(within(line).queryByRole('button')).toBeNull()
    expect(within(line).queryByRole('link')).toBeNull()
  })
})

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
  it('巡检级事件不再把技术日志直接搬上界面，也不进 tab', async () => {
    renderPage()
    await ready()
    act(() => { bus().emit(ev({ type: 'activity', message: '巡检开始' })) })
    expect(screen.queryByTestId('wb-patrol-line')).toBeNull()
    expect(screen.queryByTestId('wb-run-card')).toBeNull()
  })

  it('扫描级 health 日志也不直接上界面，不进 tab', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({ type: 'health', message: '守备目录读取失败，本轮跳过（2 次）: /media' }))
    })
    expect(screen.queryByTestId('wb-patrol-line')).toBeNull()
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
    // 进度也来自快照（第 2/7 个）——分数行是 `${done} / ${total} files done`
    expect(screen.getByTestId('wb-run-card').textContent).toContain(`2 / 7 ${en.wb_run_files_done_suffix}`)
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
  it('排队与在跑都用横版 backdrop（w1280），不再用竖版 poster', async () => {
    renderPage()
    await ready()
    const queued = screen.getAllByTestId('wb-queue-card')[0]!
    const qImg = queued.querySelector('img')!
    expect(qImg.getAttribute('src')).toContain('/bd.jpg')
    expect(qImg.getAttribute('src')).toContain('w1280')
    expect(qImg.getAttribute('src')).not.toContain('w400')
    expect(queued.querySelector('.wb-queue-fade')).toBeNull()

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
    expect(screen.getByTestId('wb-run-card').querySelector('.wb-run-fade')).toBeNull()
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

  it('backdropPath 为 null → 无图降级（有 poster 也不拿竖图填 16:9）', async () => {
    activityBody = {
      subtitleQueue: [{ ...QUEUE_ITEM, posterPath: '/p.jpg', backdropPath: null }],
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

  it('en 排队卡用原名（chineseTitle 不顶替；displayTitle §10.2）', async () => {
    activityBody = {
      subtitleQueue: [{ ...QUEUE_ITEM, chineseTitle: '排队中的剧' }],
      translateQueue: [],
    }
    renderPage()
    await ready()
    const card = screen.getAllByTestId('wb-queue-card')[0]!
    expect(card.textContent).toContain('Queued Show')
    expect(card.textContent).not.toContain('排队中的剧')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 两个数字来源的分工（与 health「不返回 queue」那条裁决）
// ═══════════════════════════════════════════════════════════════════════════
describe('🔴 「第 i/n 个」只信 SSE，排队列表只信 /api/v2/activity（两者不互相推导）', () => {
  it('进度读数来自 SSE 的 done/total，**不是** queue.length 算出来的', async () => {
    // 队列里有 1 项（subtitleQueue），而 SSE 说的是 3/47。若有人拿 queue.length 当 n，
    // 这里会显示 3 / 1。
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'progress', message: '第 3/47 个作品', title: 'Show A',
        workbench: 'subtitle', data: { done: 3, total: 47, workId: 'tmdb:1' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-run-card').textContent)
        .toContain(`3 / 47 ${en.wb_run_files_done_suffix}`)
    })
    expect(screen.getByTestId('wb-run-card').textContent).not.toContain('3 / 1')
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
    expect(screen.queryByRole('progressbar')).toBeNull()
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

  it('在跑的 workId 不出现在排队段', async () => {
    activityBody = {
      subtitleQueue: [
        QUEUE_ITEM,
        { ...QUEUE_ITEM, workId: 'tmdb:2', title: 'Other Show', chineseTitle: null },
      ],
      translateQueue: [TRANSLATE_ITEM],
    }
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:1' },
      }))
      bus().emit(ev({
        type: 'progress', message: '第 1/6 个', title: 'Queued Show',
        workbench: 'subtitle', data: { done: 1, total: 6, workId: 'tmdb:1' },
      }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    const queueCards = screen.queryAllByTestId('wb-queue-card')
    expect(queueCards.some((c) => (c.textContent ?? '').includes('Queued Show'))).toBe(false)
    expect(queueCards).toHaveLength(1)
    expect(queueCards[0]!.textContent).toContain('Other Show')
    expect(screen.getByText(/Waiting · 1/)).toBeInTheDocument()
    expect(screen.queryByText(/Waiting · 2/)).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: en.wb_tab_translate }))
    await waitFor(() => {
      expect(screen.getAllByTestId('wb-queue-card')[0]!.textContent).toContain('Trans Show')
    })
  })

  it('RunCard 在 index/total 有限时画出 progressbar', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'progress', message: '第 3/6 个', title: 'Show A',
        workbench: 'subtitle', data: { done: 3, total: 6 },
      }))
    })
    const bar = await screen.findByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '3')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '6')
  })

  it('en 在跑卡不出现「正在装字幕」', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Show A', title: 'Show A',
        workbench: 'subtitle',
      }))
      bus().emit(ev({
        type: 'progress', message: 'search_source 内部句', title: 'Show A',
        workbench: 'subtitle', data: { done: 1, total: 6, step: 'search_source' },
      }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    const card = screen.getByTestId('wb-run-card')
    expect(screen.queryByText('正在装字幕')).not.toBeInTheDocument()
    expect(card.textContent).toContain(en.wb_run_subtitle)
    expect(card.textContent).toContain(en.wb_step_search)
    expect(card.textContent).not.toContain('search_source')
    expect(card.textContent).not.toContain('search_source 内部句')
  })

  it('awaitingRescan 显示核对片库而不是等待重试', async () => {
    activityBody = {
      subtitleQueue: [{
        ...QUEUE_ITEM, dueNow: false, awaitingRescan: true,
        retryAfter: Date.now() + 86_400_000,
      }],
      translateQueue: [],
    }
    renderPage()
    await ready()
    const text = screen.getAllByTestId('wb-queue-card')[0]!.textContent ?? ''
    expect(text).toContain(en.wb_queue_awaiting_scan)
    expect(text).not.toContain(en.wb_queue_retry_in)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ScoutCurrent overlay：progress 省略身份、health 播种、跨 tab 同 workId、log 复位
// ═══════════════════════════════════════════════════════════════════════════
describe('ScoutCurrent overlay：身份随 tick 保留，播种与 log 跟快照走', () => {
  it('progress 省略 workId 仍保留身份（P5/P11）——简化成 data.workId ?? null 必须红', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:1', backdropPath: '/bd.jpg' },
      }))
      bus().emit(ev({
        type: 'progress', message: '第 3/6 个', title: 'Queued Show',
        workbench: 'subtitle', data: { done: 3, total: 6, step: 'search_source' },
      }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    const queueCards = screen.queryAllByTestId('wb-queue-card')
    expect(queueCards.some((c) => (c.textContent ?? '').includes('Queued Show'))).toBe(false)
    const card = screen.getByTestId('wb-run-card')
    const rImg = card.querySelector('img')!
    expect(rImg.getAttribute('src')).toContain('/bd.jpg')
    expect(rImg.getAttribute('src')).toContain('w1280')
    expect(card.textContent).toContain(en.wb_step_search)
    expect(card.textContent).not.toContain('search_source')
  })

  it('health 快照播种完整 ScoutCurrent（无 SSE activity）', async () => {
    healthBody = {
      ...HEALTH_IDLE,
      current: {
        kind: 'subtitle', title: 'Queued Show', index: 2, total: 7,
        workId: 'tmdb:1', backdropPath: '/bd.jpg', chineseTitle: null,
        startedAt: Date.now() - 60_000, lastStep: 'search_source',
      },
    }
    renderPage()
    await ready()
    const card = await screen.findByTestId('wb-run-card')
    expect(card.textContent).toContain(en.wb_step_search)
    expect(card.textContent).toContain(`2 / 7 ${en.wb_run_files_done_suffix}`)
    const rImg = card.querySelector('img')!
    expect(rImg.getAttribute('src')).toContain('/bd.jpg')
    expect(rImg.getAttribute('src')).toContain('w1280')
    const queueCards = screen.queryAllByTestId('wb-queue-card')
    expect(queueCards.some((c) => (c.textContent ?? '').includes('Queued Show'))).toBe(false)
  })

  it('同 workId 在另一条队列：翻译 tab 仍显示（没有 kind 门的 filter 必须红）', async () => {
    activityBody = {
      subtitleQueue: [QUEUE_ITEM],
      translateQueue: [{ ...TRANSLATE_ITEM, workId: 'tmdb:1', title: 'Same Id On Translate' }],
    }
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:1' },
      }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: en.wb_tab_translate }))
    await waitFor(() => {
      expect(screen.getAllByTestId('wb-queue-card')[0]!.textContent).toContain('Same Id On Translate')
    })
  })

  it('换作品 activity 清空 step log（甲的句子不许留在乙卡上）', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:1' },
      }))
      bus().emit(ev({
        type: 'progress', message: 'search', title: 'Queued Show',
        workbench: 'subtitle', data: { done: 1, total: 6, step: 'search_source' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-run-card').textContent).toContain(en.wb_step_search)
    })
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Other Show', title: 'Other Show',
        workbench: 'subtitle', data: { workId: 'tmdb:2' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-run-card').textContent).toContain('Other Show')
    })
    expect(screen.getByTestId('wb-run-card').textContent).not.toContain(en.wb_step_search)
  })

  it('SSE 重连后 step log 游标归零：重启后的小 id activity 仍能清掉旧句', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    act(() => {
      bus().emit(ev({
        type: 'activity', id: 50, message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:1' },
      }))
      bus().emit(ev({
        type: 'progress', id: 51, message: 'search', title: 'Queued Show',
        workbench: 'subtitle', data: { done: 1, total: 6, step: 'search_source' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-run-card').textContent).toContain(en.wb_step_search)
    })

    const healthBefore = countOf('/api/v2/health')
    act(() => { bus().fail(2) })
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1))
    const reconnected = FakeES.instances[FakeES.instances.length - 1]!
    act(() => { reconnected.open() })
    act(() => { reconnected.hello('boot-restart') })
    await waitFor(() => expect(countOf('/api/v2/health')).toBeGreaterThan(healthBefore))
    await act(async () => { await Promise.resolve() })

    act(() => {
      reconnected.emit(ev({
        type: 'activity', id: 1, message: '正在找字幕：Other Show', title: 'Other Show',
        workbench: 'subtitle', data: { workId: 'tmdb:2' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-run-card').textContent).toContain('Other Show')
    })
    expect(screen.getByTestId('wb-run-card').textContent).not.toContain(en.wb_step_search)
  })

  it('activity 的 startedAt 取 e.at，不是 Date.now()', async () => {
    renderPage()
    await ready()
    const at = Date.now() - 5 * 60_000
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Show A', title: 'Show A',
        workbench: 'subtitle', at,
      }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    expect(screen.getByTestId('wb-run-card').textContent).toContain('5m')
    expect(screen.getByTestId('wb-run-card').textContent).not.toMatch(/\b0s\b/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 状态条：两条债务的可见形态
// ═══════════════════════════════════════════════════════════════════════════
describe('状态条：lastInspectAt 语义与 daemon 可能没在跑', () => {
  it('idle 时说下次自动检查，并给出现在跑（不再渲染上次自动检查）', async () => {
    renderPage()
    await ready()
    const line = screen.getByTestId('wb-inspect-line')
    expect(line.textContent).toContain('Next automatic check')
    expect(line.textContent).not.toContain('Last automatic check')
    const btn = screen.getByTestId('wb-inspect-now')
    expect(btn.textContent).toContain('Run now')
    expect(btn).not.toBeDisabled()
  })

  it('🔴 空闲 + 太久没开新一轮 → 状态条报「引擎可能没在跑」（债务二：陈旧门报绿 48h）', async () => {
    const lastInspectAt = Date.now() - 3 * 24 * 3_600_000
    healthBody = {
      ...HEALTH_IDLE,
      lastInspectAt,
      nextInspectAt: lastInspectAt + 24 * 60 * 60 * 1000,
      current: null,
    }
    renderPage()
    await ready()
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-line').textContent).toContain(en.wb_inspect_stale)
    })
    // 双通道：不只靠颜色，容器上还有可断言的 data-stale（Carbon 规则）
    expect(screen.getByLabelText(en.wb_statusbar_label).getAttribute('data-stale')).toBe('true')
    // stale 仍给现在跑（救援），间隔仍是「…前」不是倒计时
    expect(screen.getByTestId('wb-inspect-now')).toBeInTheDocument()
    expect(screen.getByTestId('wb-inspect-line').textContent).not.toContain('Next automatic check')
  })

  it('⭐ 阳性对照：同样很旧但**有工作台在跑** → 报「正在巡检」，不报死', async () => {
    const lastInspectAt = Date.now() - 3 * 24 * 3_600_000
    healthBody = {
      ...HEALTH_IDLE,
      lastInspectAt,
      nextInspectAt: lastInspectAt + 24 * 60 * 60 * 1000,
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
    healthBody = { ...HEALTH_IDLE, lastInspectAt: null, nextInspectAt: null }
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
    expect(screen.queryByTestId('wb-inspect-now')).toBeNull()
  })

  it('running → 现在跑在场但 disabled', async () => {
    healthBody = {
      ...HEALTH_IDLE,
      current: { kind: 'subtitle', title: 'Big Library', index: 3, total: 400 },
    }
    renderPage()
    await ready()
    const btn = await screen.findByTestId('wb-inspect-now')
    expect(btn).toBeDisabled()
  })

  it('凭据没配 → 不出现现在跑', async () => {
    healthBody = { ...HEALTH_IDLE, workPermitted: false, engineEnabled: true, setupSatisfied: false }
    renderPage()
    await ready()
    await waitFor(() => {
      expect(screen.getByTestId('wb-perm-line').textContent).toBe(en.wb_setup_incomplete)
    })
    expect(screen.queryByTestId('wb-inspect-now')).toBeNull()
  })

  it('idle 且 nextInspectAt 已过 → due soon，仍有现在跑', async () => {
    healthBody = { ...HEALTH_IDLE, nextInspectAt: Date.now() - 1000 }
    renderPage()
    await ready()
    expect(screen.getByTestId('wb-inspect-line').textContent).toMatch(/due soon/i)
    expect(screen.getByTestId('wb-inspect-now')).toBeInTheDocument()
  })

  it('点现在跑 → POST /api/v2/library/inspect，立刻 disabled', async () => {
    renderPage()
    await ready()
    const btn = screen.getByTestId('wb-inspect-now')
    fireEvent.click(btn)
    expect(btn).toBeDisabled()
    await waitFor(() => {
      const hit = fetchCalls.find((c) => c.url.includes('/api/v2/library/inspect'))
      expect(hit).toBeTruthy()
      expect(hit!.method).toBe('POST')
    })
  })

  it('🔴 Run now 跟 SSE current：排队中禁用，开工仍禁用，巡检收工才解禁', async () => {
    // health.current 全程 null——POST 200 只是 queued。若 pending 只信 health 快照，
    // 收工后按钮会卡死到会话结束。
    renderPage()
    await ready()
    const btn = screen.getByTestId('wb-inspect-now')
    fireEvent.click(btn)
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url.includes('/api/v2/library/inspect'))).toBe(true)
    })
    expect(btn).toBeDisabled()
    expect(screen.getByTestId('wb-inspect-line').textContent).toContain('Next automatic check')
    // 200 会 one-shot 重拉 health；等它落地再取样，避免把排队重拉误判成开工重拉。
    await waitFor(() => expect(countOf('/api/v2/health')).toBeGreaterThan(1))
    const healthAfterQueue = countOf('/api/v2/health')

    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在找字幕：Show A', title: 'Show A', workbench: 'subtitle' }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-line').textContent).toContain(en.wb_inspect_running)
    })
    expect(btn).toBeDisabled()
    expect(countOf('/api/v2/health'), '开工/progress 不许重拉 health').toBe(healthAfterQueue)

    act(() => { bus().emit(ev({ type: 'activity', message: '字幕工作台跑完，处理了 1 个作品' })) })
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-now')).not.toBeDisabled()
    })
    expect(screen.getByTestId('wb-inspect-line').textContent).toContain('Next automatic check')
    await waitFor(() => {
      expect(countOf('/api/v2/health'), '收工必须重拉 nextInspectAt').toBeGreaterThan(healthAfterQueue)
    })
  })

  it('🔴 空巡检（无 workbench）跟 inspectRound：开始仍禁用，结束才解禁', async () => {
    renderPage()
    await ready()
    const btn = screen.getByTestId('wb-inspect-now')
    fireEvent.click(btn)
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url.includes('/api/v2/library/inspect'))).toBe(true)
    })
    expect(btn).toBeDisabled()

    act(() => {
      bus().emit(ev({
        type: 'activity', message: '巡检开始',
        data: { inspectRound: 'start' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-line').textContent).toContain(en.wb_inspect_running)
    })
    expect(btn).toBeDisabled()

    act(() => {
      bus().emit(ev({
        type: 'activity', message: '巡检完成，歇着等明天',
        data: { inspectRound: 'end' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-now')).not.toBeDisabled()
    })
  })

  it('🔴 SSE 重连后 inspectRound 游标归零：重启后的小 id end 仍能解禁', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    const btn = screen.getByTestId('wb-inspect-now')
    fireEvent.click(btn)
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url.includes('/api/v2/library/inspect'))).toBe(true)
    })

    act(() => {
      bus().emit(ev({
        type: 'activity', message: '巡检开始', id: 50,
        data: { inspectRound: 'start' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-line').textContent).toContain(en.wb_inspect_running)
    })
    expect(btn).toBeDisabled()

    act(() => { bus().fail(2) })
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1))
    const reconnected = FakeES.instances[FakeES.instances.length - 1]!
    act(() => { reconnected.open() })

    act(() => {
      reconnected.emit(ev({
        type: 'activity', message: '巡检完成，歇着等明天', id: 1,
        data: { inspectRound: 'end' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-now')).not.toBeDisabled()
    })
  })

  it('🔴 巡检失败（无 start / 无 workbench）也解禁，好在短退避里再点', async () => {
    renderPage()
    await ready()
    fireEvent.click(screen.getByTestId('wb-inspect-now'))
    await waitFor(() => {
      expect(fetchCalls.some((c) => c.url.includes('/api/v2/library/inspect'))).toBe(true)
    })
    expect(screen.getByTestId('wb-inspect-now')).toBeDisabled()

    act(() => {
      bus().emit(ev({
        type: 'health', message: '巡检失败，30 分钟后重试: boom',
        data: { inspectRound: 'end' },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-inspect-now')).not.toBeDisabled()
    })
  })

  it('200 之后再撞 409 不许把按钮解禁（同步 inFlight 闸）', async () => {
    let release!: () => void
    inspectHold = new Promise<void>((r) => { release = r })
    inspectQueue = [
      { ok: true, status: 200, json: async () => ({ ok: true }) },
      { ok: false, status: 409, json: async () => ({ error: 'already running' }) },
    ]
    renderPage()
    await ready()
    const btn = screen.getByTestId('wb-inspect-now')
    // 同一拍连点两次：state 还没重绘，第二次必须被 ref 闸住，不能等 409 把 pending 清掉。
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    release()
    await waitFor(() => {
      expect(fetchCalls.filter((c) => c.url.includes('/api/v2/library/inspect')).length).toBeGreaterThanOrEqual(1)
    })
    expect(btn).toBeDisabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('409 → 状态条下 alert「已经在检查了」，不弹 dialog，不露出 raw API 串', async () => {
    inspectRes = { ok: false, status: 409, json: async () => ({ error: 'already running' }) }
    renderPage()
    await ready()
    fireEvent.click(screen.getByTestId('wb-inspect-now'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('A check is already running')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('wb-inspect-now')).not.toBeDisabled()
  })

  it('503 → 同一处 alert「现在没法跑」', async () => {
    inspectRes = {
      ok: false, status: 503,
      json: async () => ({ error: 'inspect trigger not configured (watch daemon not running)' }),
    }
    renderPage()
    await ready()
    fireEvent.click(screen.getByTestId('wb-inspect-now'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe("Can't start a check right now")
    expect(alert.textContent?.toLowerCase()).not.toContain('inspect')
    expect(alert.textContent?.toLowerCase()).not.toContain('daemon')
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
    await waitFor(() => {
      expect(screen.getByTestId('wb-run-card').textContent)
        .toContain(`9 / 10 ${en.wb_run_files_done_suffix}`)
    })
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

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 2026-08-13：退避窗中的队列不许被说成"没有排队的作品"
  // ══════════════════════════════════════════════════════════════════════════
  // 生产实测：33 个文件在等、到点可取 0。后端此前整个滤掉它们 → 这一页说
  // 「已排队 · 0 / 没有排队的作品」。现在它们照常出现，只是各自说清楚还要等多久。
  describe('🔴 退避窗：空态与「都在等重试」是两句不同的话', () => {
    const HOUR = 3_600_000
    /** 16 小时 **多一点**。relAgo 向下取整，而页面的时钟基准在 fixture 之后才取——
     *  正好 16h 会因为渲染耗掉的那几毫秒被算成 "15h"（实测踩到）。多给 1 分钟余量，
     *  断言的仍是"这一行说出了正确的量级"，不是毫秒级精度。 */
    const IN_16H = () => Date.now() + 16 * HOUR + 60_000

    it('全体等待自动重试 → 卡片在场、计数非 0、说明在等待，不暴露倒计时', async () => {
      activityBody = {
        subtitleQueue: [{ ...QUEUE_ITEM, dueNow: false, retryAfter: IN_16H() }],
        translateQueue: [],
      }
      renderPage()
      await ready()
      expect(screen.queryByTestId('wb-queue-empty')).toBeNull()
      expect(screen.getByText(/Waiting · 1/)).toBeInTheDocument()
      const line = screen.getByTestId('wb-queue-all-backoff')
      expect(line.textContent).toContain('waiting to retry')
    })

    it('卡片副行对等待中的项说「等待自动重试」，到点项没有这一段', async () => {
      activityBody = {
        subtitleQueue: [{ ...QUEUE_ITEM, dueNow: false, retryAfter: IN_16H() }],
        translateQueue: [],
      }
      renderPage()
      await ready()
      const text = screen.getAllByTestId('wb-queue-card')[0]!.textContent ?? ''
      expect(text).toContain('waiting to retry')
      cleanup()
      activityBody = { subtitleQueue: [QUEUE_ITEM], translateQueue: [] }
      renderPage()
      await ready()
      expect(screen.getAllByTestId('wb-queue-card')[0]!.textContent ?? '').not.toContain('waiting to retry')
    })

    it('有一项到点 → 不说整队都在等待（正常推进的队列不许被说成停滞）', async () => {
      activityBody = {
        subtitleQueue: [
          { ...QUEUE_ITEM, dueNow: false, retryAfter: IN_16H() },
          { ...QUEUE_ITEM, workId: 'tmdb:2', title: 'Due Show' },
        ],
        translateQueue: [],
      }
      renderPage()
      await ready()
      expect(screen.queryByTestId('wb-queue-all-backoff')).toBeNull()
      expect(screen.getAllByTestId('wb-queue-card')[0]!.textContent ?? '').toContain('waiting to retry')
    })

    it('队列真空 → 仍然是空态文案，且不许冒出等待说明', async () => {
      activityBody = { subtitleQueue: [], translateQueue: [] }
      renderPage()
      await waitFor(() => expect(screen.getByTestId('wb-queue-empty')).toBeInTheDocument())
      expect(screen.queryByTestId('wb-queue-all-backoff')).toBeNull()
    })

    it('全体等待且后端没给时刻 → 仍说明正在等待自动重试', async () => {
      activityBody = {
        subtitleQueue: [{ ...QUEUE_ITEM, dueNow: false, retryAfter: null }],
        translateQueue: [],
      }
      renderPage()
      await ready()
      expect(screen.getByTestId('wb-queue-all-backoff').textContent).toContain('waiting to retry')
      expect(screen.getAllByTestId('wb-queue-card')).toHaveLength(1)
    })
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

// ═══════════════════════════════════════════════════════════════════════════
// 🔴-1 首连 ≠ 重连：`connecting → open` 一次请求都不许多打
// ═══════════════════════════════════════════════════════════════════════════
// 审计探针：`/activity 1 -> 2 | /health 1 -> 2`——每次挂载多打一次。
// 成因：eventsBus 的初始状态就是 `'connecting'`（eventsBus.ts:99），而活动页两处的
// 边沿判据都是 `was !== 'open' && status === 'open'`，于是首连的 connecting→open
// 被当成了"重连"。
//
// ⚠️ 这一段存在的理由是**既有那条用例锁不住**：
// 「首载就拉一次快照」用 `toBe(1)`，但它在 `open()` **之前**就断言完了——
// 多打的那一次发生在 open() 之后，它看不见。下面每条都**跨过 open()** 再数。
describe('🔴-1 首连不是重连（审计：每次挂载多打一次 /health 与 /activity）', () => {
  it('🔴 首连 open 之后，/health 与 /activity **各仍然只有 1 次**', async () => {
    renderPage()
    await ready()
    // 首载两个请求都已落地
    expect(countOf('/api/v2/health')).toBe(1)
    expect(countOf('/api/v2/activity')).toBe(1)

    // 🔴 首连成功——这一步是既有用例**没有走到**的那一步。
    act(() => { bus().open() })

    // 给"如果有多余请求它也该发出来了"留足时间：等到状态确实是 open 之后再数。
    // （只 await 一个 microtask 的话，一个慢一拍的 effect 会让这条假绿。）
    await waitFor(() => expect(bus().readyState).toBe(1))
    await act(async () => { await Promise.resolve() })

    expect(countOf('/api/v2/health'),
      '首连的 connecting→open 被当成重连 → 在首载 fetch 之外多打了一次 /health').toBe(1)
    expect(countOf('/api/v2/activity'),
      '首连的 connecting→open 被当成重连 → 多打了一次 /activity').toBe(1)
  })

  it('🔴 卸载重挂（refCount 归零后重新订阅）同样不多打——新一轮的首连还是首连', async () => {
    const first = renderPage()
    await ready()
    act(() => { bus().open() })
    first.unmount()

    urls = []
    renderPage()
    await ready()
    const n = FakeES.instances.length
    act(() => { FakeES.instances[n - 1]!.open() })
    await act(async () => { await Promise.resolve() })

    expect(countOf('/api/v2/health'), '重挂后的首连又被当成了重连').toBe(1)
    expect(countOf('/api/v2/activity')).toBe(1)
  })

  // ⭐ 阳性对照：**真的**掉过线再回来时，那一次拉取必须照常发生。
  // 没有这一条的话，一个"永远不拉"的实现会让上面两条全绿——而那会退回到
  // 「永远停在正在处理 X」那个更严重的缺陷。
  it('⭐ 阳性对照：retrying → open（真重连）**照常各拉一次**', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    await act(async () => { await Promise.resolve() })
    const h = countOf('/api/v2/health')
    const a = countOf('/api/v2/activity')

    act(() => { bus().fail(2) })
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1))
    act(() => { FakeES.instances[FakeES.instances.length - 1]!.open() })

    await waitFor(() => {
      expect(countOf('/api/v2/health'), '真重连时没拉快照 → 断线期间的变化永远纠正不回来')
        .toBe(h + 1)
    })
    expect(countOf('/api/v2/activity')).toBe(a + 1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 Task 9：字幕卡装配覆盖格 + ticker，四步线性条与 0/N 死进度条退役
// ═══════════════════════════════════════════════════════════════════════════
// 生产实测的那个 0/N bug：作品级 done 在整轮装盘期间恒为 0（total=N），进度条一动不动，
// 用户看到的是一根死条——而后端明明在逐集装盘。progress 帧现在带全量 targets 快照，
// 字幕卡改画覆盖格（逐格状态）+ ticker（正在做什么），四步线性条只留给翻译台。
describe('🔴 Task 9：字幕卡覆盖格 + ticker（四步条退役、0/N 死进度条终结）', () => {
  /** 三格剧集快照（key 唯一）。data 是 Record<string, unknown>，形状照后端全量帧。 */
  const targets3 = (states: Array<'pending' | 'active' | 'installed' | 'pending-source'>) =>
    states.map((state, i) => ({ key: `s01e0${i + 1}`, label: `E0${i + 1}`, state }))

  it('字幕卡渲染覆盖格而非四步条', async () => {
    const view = renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:1' },
      }))
      bus().emit(ev({
        type: 'progress', message: '第 0/3 个', title: 'Queued Show', workbench: 'subtitle',
        data: { done: 0, total: 3, step: 'search_source', workId: 'tmdb:1', targets: targets3(['active', 'pending', 'pending']) },
      }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-grid-count')).toBeInTheDocument())
    expect(screen.getAllByTestId('wb-grid-cell')).toHaveLength(3)
    // 🔴 四步线性条退役：step='search_source' 映射得进 SUBTITLE_STAGES（旧实现必画）——
    // 新形态下字幕卡上不许再有它。
    expect(view.container.querySelector('.wb-stage-bar')).toBeNull()
    // ticker 在场且是词表译文；raw 工具 id 不上屏（ActivityTicker 内部走 tickerPhrase）
    expect(screen.getByTestId('wb-ticker').textContent).toContain(en.wb_step_search)
    expect(screen.getByTestId('wb-run-card').textContent).not.toContain('search_source')
  })

  it('🔴 装盘推进：targets installed 数增长反映在计数行（0/N 死进度条回归锁）', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:1' },
      }))
      bus().emit(ev({
        type: 'progress', message: '装盘', title: 'Queued Show', workbench: 'subtitle',
        data: { done: 0, total: 3, step: 'install_subtitle', workId: 'tmdb:1', targets: targets3(['installed', 'active', 'pending']) },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-grid-count').textContent).toContain(`1 ${en.wb_grid_installed}`)
    })
    // 🔴 0/N 那根死条不在场：作品级 done 恒 0，画出来就是一根一动不动的假条。
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.getByTestId('wb-run-card').textContent).not.toContain(`0 / 3 ${en.wb_run_files_done_suffix}`)

    // 第二帧：装盘推进（done 仍是 0——正是那个 bug 的形态），计数行必须动。
    act(() => {
      bus().emit(ev({
        type: 'progress', message: '装盘', title: 'Queued Show', workbench: 'subtitle',
        data: { done: 0, total: 3, step: 'install_subtitle', workId: 'tmdb:1', targets: targets3(['installed', 'installed', 'active']) },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-grid-count').textContent).toContain(`2 ${en.wb_grid_installed}`)
    })
  })

  it('收尾态 partial success：installed 与 pending-source 并存渲染', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
        workbench: 'subtitle', data: { workId: 'tmdb:1' },
      }))
      bus().emit(ev({
        type: 'progress', message: '收尾', title: 'Queued Show', workbench: 'subtitle',
        data: { done: 0, total: 3, step: 'finalize', workId: 'tmdb:1', targets: targets3(['installed', 'pending-source', 'installed']) },
      }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('wb-grid-cell-s01e02')).toHaveAttribute('data-state', 'pending-source')
    })
    expect(screen.getByTestId('wb-grid-cell-s01e01')).toHaveAttribute('data-state', 'installed')
    const count = screen.getByTestId('wb-grid-count').textContent ?? ''
    expect(count).toContain(`2 ${en.wb_grid_installed}`)
    // pendingSource > 0 时那一段必须出现（0 时不出现——CoverageGrid.test 守）
    expect(count).toContain(`1 ${en.wb_grid_pending_source}`)
  })

  it('targets 缺席（识别台/旧后端）→ 回退旧 done/total 进度条', async () => {
    renderPage()
    await ready()
    act(() => {
      bus().emit(ev({
        type: 'progress', message: '第 2/5 个', title: 'Show A', workbench: 'subtitle',
        data: { done: 2, total: 5 },
      }))
    })
    const bar = await screen.findByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '2')
    expect(bar).toHaveAttribute('aria-valuemax', '5')
    expect(screen.getByTestId('wb-run-card').textContent).toContain(`2 / 5 ${en.wb_run_files_done_suffix}`)
    // 覆盖格没有数据就不画（不编一排全灰的假格子）
    expect(screen.queryByTestId('wb-grid-count')).toBeNull()
    expect(screen.queryByTestId('wb-grid-pill')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 🟡-2 通道掉线 → 「你看到的读数可能已经过期」必须**说出来**
// ═══════════════════════════════════════════════════════════════════════════
// 审计实测（连接进入 CLOSED 之后）：
//   ACTIVITY offline indicator ?    false
//   ACTIVITY 仍显示过期的在跑卡片 ?  true   ← 一直挂着
//
// 🔴 判据必须落在**电平**上：既有的处置是"重连后拉快照"，而 `unavailable` 是 503 终态
// （eventsBus.ts:262 一次都不会再重连），那条纠正**根本不会被触发**。故下面两条分别
// 钉 retrying 与 unavailable 两个电平，**不是**钉某一次跃迁。
describe('🟡-2 实时通道掉线 → 读数过期这件事对用户可见', () => {
  /** 让总线进入 retrying：CLOSED → probe 拿到非 503 → scheduleReconnect。 */
  async function goRetrying() {
    act(() => { bus().fail(2) })
    await screen.findByTestId('wb-live-line')
  }

  it('🔴 retrying：状态条出现过期提示，且**明说下面的内容可能不是最新的**', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    // 阳性对照的前半：连着的时候**不该**有这一行（恒显示的实现也要红）
    expect(screen.queryByTestId('wb-live-line'),
      '连接正常时也在喊"可能过期" → 这条提示是恒显示的装饰品').toBeNull()

    await goRetrying()
    expect(screen.getByTestId('wb-live-line').textContent?.trim()).toBe(en.wb_live_retrying)
  })

  it('🔴 unavailable（503 终态，永不重连）：提示**明说要刷新页面**，与 retrying 不同一句', async () => {
    // /api/v2/events 的旁路探测返回 503 → eventsBus 判 unavailable（终态）。
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('/api/v2/events')) {
        return { ok: false, status: 503, body: null, json: async () => ({}) } as unknown as Response
      }
      if (url.includes('/api/v2/health')) {
        return { ok: true, status: 200, json: async () => healthBody } as unknown as Response
      }
      if (url.includes('/api/v2/activity')) {
        return { ok: true, status: 200, json: async () => activityBody } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
    }))
    renderPage()
    await ready()
    act(() => { bus().open() })
    act(() => { bus().fail(2) })

    const line = await screen.findByTestId('wb-live-line')
    await waitFor(() => expect(line.textContent?.trim()).toBe(en.wb_live_unavailable))
    // 🔴 终态与"自己会好"必须是两句不同的话：前者只有刷新页面才可能变，
    // 说成"正在重新接上"就是在承诺一件永远不会发生的事。
    expect(en.wb_live_unavailable).not.toBe(en.wb_live_retrying)
    expect(en.wb_live_unavailable.toLowerCase()).toContain('refresh')
  })

  it('🔴 那张过期的「正在处理 X」卡片**自己身上**带标记（它才是谎话本体）', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在找字幕：Show A', title: 'Show A', workbench: 'subtitle' }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    // 阳性对照的前半：连着的时候卡片是干净的
    expect(screen.queryByTestId('wb-run-stale')).toBeNull()
    expect(screen.getByTestId('wb-run-card')).toHaveAttribute('data-stale', 'false')

    await goRetrying()

    // 🔴 卡片还在（**不许**因为断线就把它藏掉——那是另一种撒谎："这里没东西"），
    // 但它现在带着"可能已经跑完了"。
    expect(screen.getByTestId('wb-run-card').textContent).toContain('Show A')
    expect(screen.getByTestId('wb-run-stale').textContent).toBe(en.wb_run_maybe_stale)
    expect(screen.getByTestId('wb-run-card')).toHaveAttribute('data-stale', 'true')
  })

  it('⭐ 阳性对照：通道恢复 → 两处提示**都消失**（不是贴上去就撕不下来的）', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    act(() => {
      bus().emit(ev({ type: 'activity', message: '正在找字幕：Show A', title: 'Show A', workbench: 'subtitle' }))
    })
    await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
    await goRetrying()
    expect(screen.getByTestId('wb-run-stale')).toBeInTheDocument()

    // 退避重连成功
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1))
    act(() => { FakeES.instances[FakeES.instances.length - 1]!.open() })

    await waitFor(() => expect(screen.queryByTestId('wb-live-line')).toBeNull())
    expect(screen.queryByTestId('wb-run-stale')).toBeNull()
  })

  it('🔴 没有在跑卡片时**照样**提示（"这个工作台没在跑什么"同样可能是过期的谎话）', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    expect(screen.getByTestId('wb-run-empty')).toBeInTheDocument()
    await goRetrying()
    // 状态条那条是这一档唯一的载体——把提示只做在卡片上的话，这里就没人说话了。
    expect(screen.getByTestId('wb-live-line').textContent?.trim()).toBe(en.wb_live_retrying)
  })

  it('🔴 首连中（connecting）**不喊**过期——冷启动不是故障', async () => {
    // 页面刚挂上、还没 open：屏幕上根本没有"旧读数"这回事，
    // 此刻喊"可能已经不是最新的"是无中生有（同 inspectFreshness 里
    // 「never 不许算成 56 年的陈旧」那条纪律）。
    renderPage()
    await ready()
    expect(screen.queryByTestId('wb-live-line')).toBeNull()
  })

  it('🔴 提示**不是报错弹窗**：没有 alert/dialog role，也不提 SSE/连接/状态码', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    await goRetrying()

    // R-F9/R-F10：排障类一律不推给用户。这是诚实性提示，不是故障播报。
    expect(screen.queryAllByRole('alert')).toEqual([])
    expect(screen.queryAllByRole('dialog')).toEqual([])
    // 页面照常可用：tab 还在、队列还在（提示没把内容顶掉）
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByText('Queued Show')).toBeInTheDocument()

    for (const [k, v] of [
      ['wb_live_retrying', en.wb_live_retrying],
      ['wb_live_unavailable', en.wb_live_unavailable],
      ['wb_run_maybe_stale', en.wb_run_maybe_stale],
    ] as const) {
      expect(v.toLowerCase(), `${k} 里出现了排障词汇`)
        .not.toMatch(/sse|eventsource|http|503|websocket|socket|endpoint|error|failed/)
    }
  })

  it('🔴 双通道（Carbon）：文字自己把话说全，信息不靠颜色承载', async () => {
    renderPage()
    await ready()
    act(() => { bus().open() })
    await goRetrying()

    // 通道①：文字。去掉全部样式后这两句仍然把事情说清楚了。
    for (const s of [en.wb_live_retrying, en.wb_run_maybe_stale]) {
      expect(s.length, '这句话太短，撑不起"读数可能过期"这个意思').toBeGreaterThan(12)
    }
    expect(en.wb_live_retrying.toLowerCase()).toContain('out of date')
    // 通道②：形状（空心点），不是只换个颜色。
    const dot = screen.getByTestId('wb-live-line').querySelector('.wb-status-dot-hollow')
    expect(dot, '过期提示没有形状通道——只靠颜色区分违反 Carbon').not.toBeNull()
    // 读屏器拿得到，但**不打断**（polite 不是 assertive：这是背景事实不是错误）。
    expect(screen.getByTestId('wb-live-line')).toHaveAttribute('aria-live', 'polite')
  })
})
