// web/src/notifications/NotificationsPage.test.tsx：页面级用例（三态 + R-F3 三条裁决）。
//
// 与 sseSeparation.test.tsx 的分工：那份只管「SSE 不进列表」这一条；这份管页面本体
// （加载/错误/空/有内容四态、倒序在 DOM 上的呈现、不做已读、React key）。
//
// 判据一律是 **DOM 里真实渲染出了什么**，不是"源码里写了什么"（Task ⑤ 的教训）。
// 「不做已读」这条尤其容易写成装饰品——断言"没有 mark-as-read 按钮"是恒真的
// （谁也没写过那个按钮）。这里改成钉**它的六个具体形态**：
//   ① 全页没有任何写方法的请求（POST/PATCH/PUT/DELETE）
//   ② **卸载重挂之后**整棵树的 HTML 与点击前逐字节相同（已读态藏在"下次挂载才反映"里）
//   ③ 页面**依赖闭包**（不是手写文件名单）里一个持久化 API 都不出现
//   ④ i18n 键集里没有 read/unread 一族文案（加文案是加状态的第一步）
//   ⑤ 运行时探针：装一个**能用的** localStorage/cookie 假实现，全程一次写入都没有
//   ⑥ CSS 里没有 :visited（浏览器自带的已读态也是已读态，且一个字的 JS 都不用改）
//
// ── 🔴 2026-08-12 审计推翻了 ②③ 的旧写法（第三次踩 Task ⑤ 同款坑）─────────────
// 审计构造了一个**正常写法**的已读功能（不是刁钻构造）：新开第 5 个文件
// `notifications/readState.ts` 写 localStorage，NotificationRow 用 `useState(() => isRead(k))`
// 读它、点击时 `markRead(k)`。**1219 条全绿、tsc 全绿，而 R-F3 已被违反。**
// 四道守卫逐条失守的原因：
//   ① 已读存本地，本来就不发请求（这条从设计上就管不到本地持久化）
//   ② 旧写法比的是"点击**当场**这一条的 outerHTML"。真实产品最常见的做法是
//      `useState(() => isRead(k))` —— 已读态**下次挂载才反映**，点击当场 DOM 确实不变。
//   ③ 旧写法的文件清单是**手写的 4 个字面量**。第 5 个文件不在域内 = 不在检查范围。
//      ⚠️ 更糟的是它**从头到尾一次都没开过火**：中间步骤（点击立刻变 DOM）只有 ② 报红，
//      判据③是装饰品。
//   ④ 纯 CSS 类名（notif-row-seen），不需要任何文案。
//
// 现在的修法（每条都在报告里有变异实测）：
//   ②→ **unmount → remount 后断言整棵树 HTML 与点击前逐字节相同**。"下次挂载才反映"
//      这个形态恰恰只有重挂载才看得见。⚠️ 比**整棵树**而不是那一行：已读态完全可能
//      长在别处（顶部"3 条未读"计数、段落标题、行的兄弟节点）。
//   ③→ 走**真·依赖闭包**（同 media/legacyIsolation.test.ts 的手法：`import.meta.glob`
//      读全树源码 + 跟着相对 import 递归）。第 5 个文件只要被页面（直接或间接）import
//      就在域内；不被 import 的文件根本不会执行，本来也不构成违反。
//      ⚠️ 闭包**优于**任务书建议的"目录 glob + 文件数断言"：已读功能完全可以写在
//      `shell/`、`lib/`、`api/` 里，目录 glob 一样漏；而文件数断言只会在**加文件**时报警，
//      改现有文件（比如往 notifText.ts 里塞两个函数）它一声不吭。闭包两种都盖得住。
//   ⑤→ 新增。旧注释断言"jsdom 下 localStorage 是 undefined 所以运行时探针不可能work"——
//      **那半句是对的，结论是错的**：undefined 意味着可以**自己装一个能用的**上去
//      （实测 `vi.stubGlobal('localStorage', fake)` 同时改到 `window.localStorage`，
//      i18n/useT.ts 的 `window.localStorage.getItem` 真会走进假实现）。装上之后
//      生产代码的写入不再被 try/catch 吞掉，而是**留在假实现的账本里**。
//      这条与③正交：③管源码文本（能盖住 cookie/indexedDB 这些 jsdom 里装不出来的），
//      ⑤管运行时（能盖住③的字符串禁令被 `window['local'+'Storage']` 之类拼接绕开的情形）。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { EventsProvider } from '../events/EventsProvider.js'
import { __resetEventsBusForTests } from '../events/eventsBus.js'
import { NotificationsPage } from './NotificationsPage.js'
import { notifShape } from './NotificationRow.js'
import { en } from '../i18n/en.js'
import { zh } from '../i18n/zh.js'
import type { FoundGroupDTO } from '../api/types.js'

/** styles.css 的原文（vitest.config.ts 的 define 编译期常量）——判据⑥用。
 *  ⚠️ 不能写 `import '…css?raw'`：那在 vitest 里**恒返回空字符串**（css:false 处理链），
 *  三条断言会全部变成永假。同 workbench/cards.css.test.ts 的既有手法。 */
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

class FakeES {
  static instances: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  /** 按事件类型存监听器——「重排不留残影」那条要真的发一条 found 事件把提示条点亮，
   *  才能走到产品里**唯一**的同树刷新入口（点"刷新"按钮）。同 sseSeparation.test.tsx。 */
  private listeners = new Map<string, ((e: { data: string }) => void)[]>()
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener() {}
  close() { this.readyState = 2 }
  /** 发一条 found 事件。**内容一律不参与列表渲染**（那条铁律由 sseSeparation.test.tsx 守），
   *  这里只用它把 hasNew 翻成 true。id 递增：页面按 id 与挂载基线比大小。 */
  emitFound() {
    const e = {
      id: ++FakeES.seq, at: Date.now(), type: 'found' as const,
      message: 'x', title: 'x', workbench: 'subtitle' as const, data: {},
    }
    for (const fn of this.listeners.get('found') ?? []) fn({ data: JSON.stringify(e) })
  }
  static seq = 0
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
  FakeES.seq = 0
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

// ═══════════════════════════════════════════════════════════════════════════
// 判据③的源码 VFS + import 图解析器。手法逐字照搬 media/legacyIsolation.test.ts
// （那份守的是"新页面不 import 旧 library 模块"，同一台机器换个禁令）。
// 🔴 这里读的是**源文本当数据**，本文件不 import 任何被测实现——所以本文件自己
// 不在被检查的图里，测试代码里出现 'localStorage' 这几个字不会自我误伤。
// ═══════════════════════════════════════════════════════════════════════════
const RAW = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** glob 键相对本文件所在目录（'./x.tsx' / '../api/types.ts'）→ 归一成相对 src/ 的路径。 */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [
    k.startsWith('./') ? `notifications/${k.slice(2)}` : k.slice(3),
    v,
  ]),
)

/** 剥注释。**必须先剥**：本仓头注释里大量出现 `localStorage`、`import { x } from '…'`
 *  这类举例文字（本文件上面就有好几处），不剥的话禁令会被注释误报成红、图里也会
 *  凭空多出模块。行注释那条用 `[^:]` 排除 `http://`。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const STATIC_RE = /(?:^|[\s;{}()])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*|\s*)['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function specifiersOf(src: string): string[] {
  const bare = stripComments(src)
  const out: string[] = []
  for (const m of bare.matchAll(STATIC_RE)) out.push(m[1]!)
  for (const m of bare.matchAll(DYNAMIC_RE)) out.push(m[1]!)
  return out
}

/** 'notifications/a.tsx' + '../api/types.js' → 'api/types.ts'。本仓写 NodeNext 风格的
 *  `.js` 后缀（源文件其实是 .ts/.tsx），要做后缀回译。解析不出返回 null（调用方记账）。 */
function resolveSpec(fromPath: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null // 裸包名（react 等）不进图
  const segs = fromPath.split('/').slice(0, -1)
  for (const s of spec.split('/')) {
    if (s === '.' || s === '') continue
    if (s === '..') segs.pop()
    else segs.push(s)
  }
  const base = segs.join('/')
  const cands = [base]
  if (base.endsWith('.js')) cands.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`)
  if (base.endsWith('.jsx')) cands.push(`${base.slice(0, -4)}.tsx`)
  cands.push(`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`)
  for (const c of cands) if (c in SOURCES) return c
  return null
}

/** 从入口出发的模块依赖闭包（含入口自身）。`unresolved` 记下每一条**指向相对路径却没
 *  解析出文件**的边——它必须是 0，否则闭包残缺，"闭包里没有持久化 API"这句话没有效力。 */
function importClosure(entries: string[]): { modules: Set<string>; unresolved: string[] } {
  const modules = new Set<string>()
  const unresolved: string[] = []
  const queue = [...entries]
  while (queue.length > 0) {
    const cur = queue.pop()!
    if (modules.has(cur)) continue
    modules.add(cur)
    const src = SOURCES[cur]
    if (src === undefined) {
      unresolved.push(`<入口不存在> ${cur}`)
      continue
    }
    for (const spec of specifiersOf(src)) {
      if (!spec.startsWith('.')) continue
      const next = resolveSpec(cur, spec)
      if (next === null) unresolved.push(`${cur} -> ${spec}`)
      else if (!modules.has(next)) queue.push(next)
    }
  }
  return { modules, unresolved }
}

/** 通知页的**唯一**入口：路由挂的就是它，页面上所有能执行的代码都从这里可达。 */
const NOTIF_ENTRY = 'notifications/NotificationsPage.tsx'

/** 已读状态的持久化偷渡口。cookie 写的是 `document.cookie` 与裸 `cookie =`，
 *  这里只钉前者——后者在 jsdom 里也要经过 document，运行时探针⑤会兜住。 */
const PERSIST_APIS = [
  'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie',
  'caches', 'BroadcastChannel',
]

/** 🔴 **唯一的白名单**：i18n 的语言持久化。
 *  它与已读状态毫无关系（存的是 'scout-lang'，useT.ts:13 的 STORAGE_KEY），
 *  但它在通知页的闭包里（页面用 useT 取文案）。
 *  ⚠️ 白名单是**按模块**放行的，不是按 API 放行——`i18n/useT.ts` 里将来真被人塞进
 *  已读逻辑的话这条守卫确实看不见，但那需要把通知行的 key 传进 i18n hook，
 *  已经不属于"正常写法"的范畴了（本条守卫防的是意外与顺手，不是蓄意伪装）。 */
const PERSIST_ALLOWLIST = new Set(['i18n/useT.ts'])

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
    { workId: 'w-old', title: 'Oldest', season: 1, episodes: [1], latestAt: NOW - 3 * DAY, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    { workId: 'w-new', title: 'Newest', season: 1, episodes: [1], latestAt: NOW - 60_000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    { workId: 'w-mid', title: 'Middle', season: 1, episodes: [1], latestAt: NOW - 1 * DAY, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
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
      { workId: 'a', title: 'A older', season: 1, episodes: [1], latestAt: NOW - 5 * 3600_000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
      { workId: 'b', title: 'B newer', season: 1, episodes: [1], latestAt: NOW - 60_000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
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
      { workId: 'fresh', title: 'Fresh', season: 1, episodes: [1], latestAt: NOW - 3600_000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
      { workId: 'ancient', title: 'Ancient', season: 1, episodes: [1], latestAt: NOW - 400 * DAY, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    ]
    vi.stubGlobal('fetch', mock(withAncient))
    renderPage()
    await screen.findByText('Fresh')
    expect(screen.getByText('Ancient')).toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('顶部计数与端点组数一致（不是集数、不是事件数）', async () => {
    const rows: FoundGroupDTO[] = [
      { workId: 'a', title: 'A', season: 1, episodes: [1, 2, 3, 4, 5], latestAt: NOW - 1000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
      { workId: 'b', title: 'B', season: null, episodes: [], latestAt: NOW - 2000, via: 'translate', mediaType: 'movie', chineseTitle: null, backdropPath: null },
    ]
    vi.stubGlobal('fetch', mock(rows))
    renderPage()
    await screen.findByText('A')
    // 2 组（不是 5 集 + 1 = 6）
    expect(screen.getByText(new RegExp(`${en.notif_window_note} · 2`))).toBeInTheDocument()
  })

  it('「过去一周」这句话在页面上是明说的（用户得知道这里只有一周）', async () => {
    vi.stubGlobal('fetch', mock([{ workId: 'a', title: 'A', season: 1, episodes: [1], latestAt: NOW, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null }]))
    renderPage()
    await screen.findByText('A')
    expect(screen.getByText(new RegExp(en.notif_window_note))).toBeInTheDocument()
    expect(en.notif_window_note.toLowerCase()).toContain('week')
    expect(zh.notif_window_note).toContain('一周')
  })
})

describe('🔴 R-F3 不做已读状态：六个具体形态', () => {
  const rows: FoundGroupDTO[] = [
    { workId: 'tmdb:1', title: 'Show One', season: 1, episodes: [1], latestAt: NOW - 1000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
  ]

  /** 🔴 **每条用例一个独一无二的 workId**。
   * 血的教训（E-B 自攻时被自己的守卫放过去一次）：已读状态不一定存在 localStorage 里，
   * 也可能是**模块级变量**（`const READ = new Set()`）。模块级状态在同一个测试文件里
   * **跨用例存活**（vi.restoreAllMocks / cleanup 都清不掉它，那是模块作用域）。
   * 于是判据②的"点击前基线"会被**前面那条用例**（① 也点了 'Show One'）先污染成已读态，
   * 基线与重挂后一样脏 → 两边相等 → 假绿。
   * 用例各用各的 workId 就切断了这条污染路径。
   *
   * 🔴 **两行不是一行**（第二次自攻的教训）：已读态可以完全不碰任何一行的属性，
   * 只把"读过的沉底"——单行列表里排序是恒等变换，那种写法会整条逃检。 */
  const soloRows = (tag: string, title: string): FoundGroupDTO[] => [
    { workId: `${tag}-1`, title: `${title} A`, season: 1, episodes: [1], latestAt: NOW - 1000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    { workId: `${tag}-2`, title: `${title} B`, season: 1, episodes: [2], latestAt: NOW - 2000, via: 'translate', mediaType: 'tv', chineseTitle: null, backdropPath: null },
  ]

  it('① 全页**没有任何写方法**的请求（GET only，端点本身也是 GET only）', async () => {
    vi.stubGlobal('fetch', mock(rows))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Show One' })
    act(() => row.click())
    await act(async () => { await Promise.resolve() })
    expect(methods.filter((m) => m.toUpperCase() !== 'GET'), '出现了写请求——已读状态的必经之路').toEqual([])
  })

  // 🔴 旧写法是「点击**当场**这一行的 outerHTML 不变」。审计当场攻破：
  // `const [seen] = useState(() => isRead(key))` 这种**最常见的**已读写法，点击当场
  // DOM 确实一个字不变，已读态在**下次挂载**才反映。所以判据改成跨挂载。
  // 另外比的是**整棵树**而不是那一行：已读态完全可能长在顶部计数、段落标题或兄弟节点上。
  it('② 点击一条 → 卸载 → 重挂，整棵树的 HTML 与点击前**逐字节相同**', async () => {
    // ⚠️ 独占 workId：模块级已读态跨用例存活，用共享的 'tmdb:1' 会被 ① 先污染（见上）。
    // ⚠️ 两行：只点第一行——"读过的沉底"这种不改属性只改顺序的写法，单行列表看不见。
    vi.stubGlobal('fetch', mock(soloRows('read2', 'Solo Two')))
    const first = renderPage()
    const row = await screen.findByRole('link', { name: 'Solo Two A' })
    // 点击**前**的整树快照：任何已读态都必须让重挂之后的树偏离这个基线。
    const baseline = first.container.innerHTML
    act(() => row.click())
    await act(async () => { await Promise.resolve() })
    expect(first.container.innerHTML, '点击当场就改变了外观 —— 那就是已读状态').toBe(baseline)

    // 🔴 跨挂载：`useState(() => isRead(k))` 一族只有在这里才露馅。
    cleanup()
    const second = renderPage()
    await screen.findByRole('link', { name: 'Solo Two A' })
    expect(
      second.container.innerHTML,
      '重新挂载后页面变了样 —— 有人把"读过了"记在了某处（本地存储/模块级变量都算）',
    ).toBe(baseline)

    // 防空转：基线不是空串、且两行都真的在里面（渲染失败时上面两条会双双"相等地绿"）。
    expect(baseline.length, '基线快照是空的——这条守卫在空转').toBeGreaterThan(400)
    expect(baseline).toContain('Solo Two A')
    expect(baseline).toContain('Solo Two B')
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
  //
  // 🔴 但**域**必须是"页面真正会执行到的全部代码"，不是手写的文件名单。
  // 旧写法钉死 4 个字面量文件名，审计把已读逻辑放进第 5 个文件 `readState.ts` 就整条逃检。
  // 现在走真·依赖闭包：**被页面 import 到的**就在域内，不被 import 的根本不会执行。
  it('③ 通知页的**依赖闭包**里一个持久化 API 都不出现（"已读"最常见的偷渡口）', () => {
    const { modules, unresolved } = importClosure([NOTIF_ENTRY])
    // 解析失败 = 那条边后面的整棵子树逃检（已读模块可能就藏在那后面）。
    expect(unresolved, '有相对 import 没解析出文件——闭包不完整，禁令失去效力').toEqual([])

    const offenders: string[] = []
    for (const m of [...modules].sort()) {
      if (PERSIST_ALLOWLIST.has(m)) continue
      const src = stripComments(SOURCES[m]!)
      for (const api of PERSIST_APIS) {
        if (src.includes(api)) offenders.push(`${m} 用了 ${api}`)
      }
    }
    expect(offenders, '通知页可达的代码里出现了持久化 API——已读状态的偷渡口').toEqual([])
  })

  // 🔴 判据③的防空转自检。**独立成一条用例**，理由：旧版判据③从头到尾一次都没开过火，
  // 一份从没红过的守卫与一份恒绿的装饰品在 CI 上长得一模一样。这条把"解析器还活着"
  // 变成一个会独立报红的事实。
  it('③ 自检：源码 VFS 装满 + 闭包完整 + **阳性对照**（解析器坏掉时不许静静地绿）', () => {
    // (a) VFS 真的读到了全树源码（glob 模式写错时它会是空对象，禁令随之恒真）
    //
    // ⚠️ 这个下限是**哨兵**不是断言：它只防"glob 写坏 → SOURCES 变空 → 禁令恒真"。
    // 2026-08-13 删掉 web/src/_legacy/（20 文件）后全树从 214 降到 194，这条如实变红了
    // ——**那正是它该有的行为**（删代码时哨兵吵闹地失败，而不是静默跟着缩水）。
    // 阈值随真实文件数下调到 150；下次大批量删文件时它还会红，届时同样只需下调并记一行。
    expect(Object.keys(SOURCES).length, '源码 VFS 太小——glob 模式坏了').toBeGreaterThan(150)
    expect(SOURCES[NOTIF_ENTRY], '入口不在 VFS 里').toBeTruthy()
    expect(SOURCES[NOTIF_ENTRY]!.length, '入口源码是空串——?raw 处理链坏了').toBeGreaterThan(1000)

    // (b) 闭包规模与已知成员：闭包坍缩成"只有入口自己"时禁令也会绿。
    const { modules, unresolved } = importClosure([NOTIF_ENTRY])
    expect(unresolved).toEqual([])
    expect(modules.size, '闭包太小——走图走漏了').toBeGreaterThanOrEqual(15)
    for (const m of [
      'notifications/NotificationsPage.tsx', 'notifications/NotificationRow.tsx',
      'notifications/NewFoundBanner.tsx', 'notifications/notifText.ts',
      'api/hooks.ts', 'events/EventsProvider.tsx', 'i18n/useT.ts', 'shell/route.ts',
    ]) {
      expect(modules.has(m), `闭包里缺 ${m}——走图走漏了`).toBe(true)
    }

    // (c) 🔴 **阳性对照**：禁令的字符串匹配本身还认得出违例吗？
    // i18n/useT.ts 是白名单里唯一的成员，它**真的**写了 localStorage（useT.ts:23/48）。
    // 它在闭包里、且被扫出来 = 解析器与 includes 都在工作。扫不出来说明整条禁令空转。
    expect(modules.has('i18n/useT.ts')).toBe(true)
    expect(
      stripComments(SOURCES['i18n/useT.ts']!),
      '阳性对照失效：一个**真的写了** localStorage 的模块没被扫出来——禁令在空转',
    ).toContain('localStorage')

    // (d) 阳性对照之二：解析器能跟着**相对 import** 走到别的目录去（不是只认本目录）。
    // NotificationRow.tsx 真的写着 `from '../shell/route.js'`。
    expect(importClosure(['notifications/NotificationRow.tsx']).modules.has('shell/route.ts'))
      .toBe(true)
  })

  // 🔴 与③正交的**运行时**探针。③ 管源码文本，会被 `window['local'+'Storage']` 这类
  // 拼接绕开；这条不看源码，只看"跑完一整轮之后账本上有没有字"。
  //
  // 旧注释断言"jsdom 下 localStorage 是 undefined，所以运行时探针不可能 work"——
  // 那半句是对的（实测 `typeof localStorage === 'undefined'`），但**结论下反了**：
  // undefined 意味着可以**自己装一个能用的**上去。实测 `vi.stubGlobal('localStorage', fake)`
  // 同时改到 `window.localStorage`（同一对象），i18n/useT.ts 里那句
  // `window.localStorage.getItem(STORAGE_KEY)` 真的会走进假实现。
  // 装上之后，生产代码的写入不再被 try/catch 吞掉，而是**留在账本里**。
  it('⑤ 运行时探针：装上能用的 localStorage/sessionStorage/cookie，跑完一整轮**一次写入都没有**', async () => {
    const writes: string[] = []
    const makeStore = (label: string) => {
      const map = new Map<string, string>()
      return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { writes.push(`${label}.setItem(${k})`); map.set(k, String(v)) },
        removeItem: (k: string) => { writes.push(`${label}.removeItem(${k})`); map.delete(k) },
        clear: () => { writes.push(`${label}.clear()`); map.clear() },
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() { return map.size },
        __map: map,
      }
    }
    const local = makeStore('localStorage')
    const session = makeStore('sessionStorage')
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', session)

    // cookie：jsdom 的 document.cookie 是**可用的真实现**（实测能读写），所以这里
    // 不换实现，只在跑完后断言它仍是空的。
    expect(document.cookie, 'cookie 起点就不干净——探针基线坏了').toBe('')

    vi.stubGlobal('fetch', mock(soloRows('read5', 'Solo Five')))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Solo Five A' })
    act(() => row.click())
    await act(async () => { await Promise.resolve() })
    // 跨挂载再跑一轮：写入很可能发生在卸载时（"离开页面时把已读刷盘"也是常见写法）。
    cleanup()
    renderPage()
    await screen.findByRole('link', { name: 'Solo Five A' })

    expect(writes, '有人往本地存储写了东西——已读状态的偷渡口').toEqual([])
    expect(document.cookie, '有人写了 cookie').toBe('')
    expect(local.__map.size + session.__map.size, '本地存储账本上有残留').toBe(0)

    // 🔴 防空转：假实现真的被装上了、而且**真的会记账**。
    // 探针没装上的话上面三条会因为"根本没被调用"而恒绿。
    expect(typeof window.localStorage, 'localStorage 假实现没装上——这条守卫在空转')
      .toBe('object')
    expect(window.localStorage, 'stubGlobal 没改到 window 上——探针装错地方了').toBe(local)
    window.localStorage.setItem('__selfcheck', '1')
    expect(writes, '假实现装上了但不记账——探针是聋的').toEqual(['localStorage.setItem(__selfcheck)'])
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

  // 🔴 E-B 自攻时**唯一漏网**的那一发，补上。
  // 攻法：一个字的 JS 都不改，只在 styles.css 里加 `.notif-row:visited { opacity: .55 }`。
  // 浏览器**自带**已读态（<a> 的 :visited 是原生的），于是"点过的通知看起来不一样"
  // 这个用户可见的事实成立，而 ①②③⑤ 全部看不见它：
  //   · ②：:visited 是**浏览器渲染层**的事，HTML 里一个字节都不变（jsdom 更是完全不实现）；
  //   · ③⑤：一个持久化 API 都没用（历史记录是浏览器的，不是页面的）。
  // 判据只能落在 CSS 原文上——同 workbench/cards.css.test.ts 的既有手法
  // （`__STYLES_CSS__` 编译期常量；`import '…css?raw'` 在 vitest 里恒空串，见 vitest.config.ts）。
  it('⑥ CSS 里没有 :visited 一族选择器（浏览器自带的已读态也是已读态）', () => {
    // 剥注释：本仓 CSS 里的注释块会写"不做已读"这类说明文字。
    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    // 防空转：CSS 原文真的注入进来了（define 坏掉时它会是空串/undefined，禁令随之恒真）。
    expect(typeof CSS, 'CSS 常量没注入——这条守卫在空转').toBe('string')
    expect(bare.length, 'CSS 原文太短——define 注入坏了').toBeGreaterThan(1000)
    // 阳性对照：通知页那一段 CSS 确实在这份原文里（扫错文件的话禁令也恒真）。
    expect(bare, 'CSS 原文里没有 .notif-row——扫的不是这份样式表').toContain('.notif-row')

    const visited = bare.split('\n').filter((l) => l.includes(':visited'))
    expect(visited, ':visited 让点过的通知变了样——那就是已读状态，只是让浏览器代劳了').toEqual([])
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 2026-08-13：`season === null` 有**两个含义**，不许共用一句话
// ══════════════════════════════════════════════════════════════════════════════
// 生产症状：通知页把剧集渲染成「已找到字幕」的电影行（112 个 season=NULL 的文件里
// 79 个属于 TV 作品）。判据已改成后端的 mediaType 三态。
describe('🔴 mediaType 三态：剧集不许被渲染成电影', () => {
  it('🔴 mediaType=tv + season=null（季没解析出来）→ **不说「已找到字幕」**（那是电影语）', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:1', title: 'Unplaced Show', season: null, episodes: [], latestAt: NOW, via: 'fetch', mediaType: 'tv' as const, chineseTitle: null, backdropPath: null },
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Unplaced Show' })
    // ① 修复前它走的就是这一支——这条断言是那句假话的直接判据
    expect(row.getAttribute('data-shape')).toBe('tv-unplaced')
    expect(within(row).queryByText(en.notif_movie_found)).toBeNull()
    // ② 说的是真话：找到了字幕，但这一集没能归入季集
    expect(within(row).getByTestId('notif-unplaced')).toBeInTheDocument()
    // ③ 仍然不许出现 "S null"
    expect(row.textContent ?? '').not.toContain('null')
  })

  it('🔴 阳性对照：mediaType=movie + season=null → 照旧说「已找到字幕」（一字未改）', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:550', title: 'Real Movie', season: null, episodes: [], latestAt: NOW, via: 'fetch', mediaType: 'movie' as const, chineseTitle: null, backdropPath: null },
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Real Movie' })
    expect(row.getAttribute('data-shape')).toBe('movie')
    expect(within(row).getByText(en.notif_movie_found)).toBeInTheDocument()
    expect(within(row).queryByTestId('notif-unplaced')).toBeNull()
  })

  it('🔴 mediaType=unknown（works 行已删）→ 不声称任何一边，也**不消失**', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:gone', title: 'Orphan', season: null, episodes: [], latestAt: NOW, via: 'fetch', mediaType: 'unknown' as const, chineseTitle: null, backdropPath: null },
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Orphan' })
    expect(row.getAttribute('data-shape')).toBe('unknown')
    expect(within(row).getByTestId('notif-unknown')).toBeInTheDocument()
    expect(within(row).queryByTestId('notif-unplaced')).toBeNull()
    expect(row.textContent ?? '').not.toContain('null')
  })

  it('🔴 mediaType 缺席（老后端）→ unknown，**不回落到 season 判据**', async () => {
    // 回落等于让这个 bug 在混版部署下静默续命。'unknown' 那句话在任何情况下都是真的。
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:1', title: 'Legacy', season: null, episodes: [], latestAt: NOW, via: 'fetch' } as unknown as FoundGroupDTO,
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Legacy' })
    expect(row.getAttribute('data-shape')).toBe('unknown')
    expect(within(row).queryByText(en.notif_movie_found)).toBeNull()
  })

  it('notifShape 判据表（四支各一条，含 tv+有季那一支）', () => {
    expect(notifShape({ season: null, mediaType: 'movie' })).toBe('movie')
    expect(notifShape({ season: 1, mediaType: 'movie' })).toBe('movie')
    expect(notifShape({ season: null, mediaType: 'tv' })).toBe('tv-unplaced')
    expect(notifShape({ season: 1, mediaType: 'tv' })).toBe('season')
    expect(notifShape({ season: 1, mediaType: 'unknown' })).toBe('unknown')
  })
})

describe('行的三种形状（电影 / 剧集 / 无集号）', () => {
  it('电影（season=null）→ 说「已找到字幕」，**绝不**显示 S null 或空的集号段', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:550', title: 'Fight Club', season: null, episodes: [], latestAt: NOW, via: 'fetch', mediaType: 'movie', chineseTitle: null, backdropPath: null },
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
      { workId: 'tmdb:1', title: 'Show', season: 1, episodes: [1, 2, 3, 7], latestAt: NOW, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Show' })
    expect(within(row).getByText('S01')).toBeInTheDocument()
    expect(row.textContent).toContain('1–3 / 7')
  })

  it('剧集但 episodes 为空（跨进程的形状假设，不是本地不变式）→ 只报季，不渲染空的集号段', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:1', title: 'Weird', season: 3, episodes: [], latestAt: NOW, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    ]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Weird' })
    expect(within(row).getByText('S03')).toBeInTheDocument()
    expect(row.textContent ?? '', '渲染了一个空的「第  集」，看起来像页面坏了')
      .not.toContain(`${en.notif_episodes_prefix} `)
  })

  it('三种 via 各有各的文案，且 mixed **如实报两种来路**（谎报单一来源会误导质量预期）', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'a', title: 'A', season: 1, episodes: [1], latestAt: NOW - 1, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
      { workId: 'b', title: 'B', season: 1, episodes: [1], latestAt: NOW - 2, via: 'translate', mediaType: 'tv', chineseTitle: null, backdropPath: null },
      { workId: 'c', title: 'C', season: 1, episodes: [1], latestAt: NOW - 3, via: 'mixed', mediaType: 'tv', chineseTitle: null, backdropPath: null },
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
      { workId: 'tmdb:1', title: 'New Name', season: 2, episodes: [1], latestAt: NOW - 1000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
      { workId: 'tmdb:1', title: 'Old Name', season: 1, episodes: [1], latestAt: NOW - 5000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
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
      { workId: 'tmdb:1', title: 'Same Show S2', season: 2, episodes: [1], latestAt: NOW - 1000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
      { workId: 'tmdb:1', title: 'Same Show S1', season: 1, episodes: [1], latestAt: NOW - 2000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
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
        { workId: 'tmdb:1', title: 'Same Show S2', season: 2, episodes: [1], latestAt: NOW - 1000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
        { workId: 'tmdb:1', title: 'Same Show S1', season: 1, episodes: [1], latestAt: NOW - 2000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
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
      { workId: 'tmdb:9', title: 'Movie Row', season: null, episodes: [], latestAt: NOW - 1000, via: 'fetch', mediaType: 'movie', chineseTitle: null, backdropPath: null },
      { workId: 'tmdb:9', title: 'Season Row', season: 1, episodes: [1], latestAt: NOW - 2000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    ]))
    renderPage()
    await screen.findByText('Movie Row')
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  // 🔴 2026-08-12 审计：这条**曾经名不副实**。它当时用 `cleanup(); renderPage()` 模拟
  // "刷新"——整棵树卸载重建，React 根本没有 reconcile 的机会，index 复用不可能露馅
  // （实测把 key 换成数组 index → 0 红）。这与 Task ⑩ 自曝并修掉的 M7 是同一族问题。
  //
  // 要抓 index-as-key 必须满足两个条件，缺一不可：
  //   (a) **同一棵树**里重排（这里走真实刷新入口：SSE 点亮提示条 → 点"刷新"按钮）；
  //   (b) 判据必须对**宿主节点的身份**敏感，而不只是对文本内容敏感。
  // (b) 是关键：`['Beta','Alpha']` 这个顺序断言在两种 key 下**都成立**——
  //   · 正确 key：React **移动**已有的 <a> 节点（DOM 节点身份跟着数据走）；
  //   · index key：React **原地改写**两个 <a> 的内容（节点身份跟着位置走）。
  // 两者渲染出的 HTML 逐字节相同，只有节点身份不同。所以这里钉节点身份，
  // 外加一条用户能真实感知的后果：**焦点**（节点身份的自然推论）。
  it('重排不留残影——index 当 key 会在这里露馅', async () => {
    const first: FoundGroupDTO[] = [
      { workId: 'a', title: 'Alpha', season: 1, episodes: [1], latestAt: NOW - 1000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
      { workId: 'b', title: 'Beta', season: 1, episodes: [1], latestAt: NOW - 2000, via: 'translate', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    ]
    const second: FoundGroupDTO[] = [
      { workId: 'b', title: 'Beta', season: 1, episodes: [1, 2, 3], latestAt: NOW - 100, via: 'translate', mediaType: 'tv', chineseTitle: null, backdropPath: null },
      { workId: 'a', title: 'Alpha', season: 1, episodes: [1], latestAt: NOW - 1000, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    ]
    let payload = first
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => payload,
    } as unknown as Response)))
    renderPage()
    await screen.findByText('Alpha')
    const links0 = screen.getAllByRole('link')
    expect(links0.map((a) => a.getAttribute('aria-label'))).toEqual(['Alpha', 'Beta'])
    // 🔴 抓住重排**之前**的两个宿主节点，以及一个真实的用户状态（键盘焦点）。
    const alphaNode = links0[0]!
    const betaNode = links0[1]!
    alphaNode.focus()
    expect(document.activeElement, '焦点没落到 Alpha 上——基线坏了').toBe(alphaNode)

    // 🔴 **同一棵树**里刷新（不 cleanup）。走产品里真实存在的刷新入口：
    // SSE 来一条 found → 提示条出现 → 用户点"刷新"。这正是 R-F3 说的那个重排时机。
    payload = second
    act(() => {
      FakeES.instances[0]!.emitFound()
    })
    await waitFor(() =>
      expect(screen.getAllByRole('link').map((a) => a.getAttribute('aria-label')))
        .toEqual(['Beta', 'Alpha']),
    )

    const links = screen.getAllByRole('link')
    // ⚠️ 下面这两条内容断言在 index-as-key 下**照样绿**（HTML 逐字节相同）。
    // 保留它们是为了钉"内容确实重排了"，key 的正确性由再下面两条负责。
    expect(links[0]!.textContent).toContain('1–3')
    expect(links[1]!.textContent).not.toContain('1–3')

    // 🔴 判据一：宿主节点**身份跟着数据走**。
    // index 当 key 时 React 原地改写两个 <a> 的内容，于是 links[0] 会是原来的 alphaNode。
    expect(links[0], 'Beta 这一行不是原来那个 Beta 节点——React 按位置复用了 DOM（index 当 key 的指纹）')
      .toBe(betaNode)
    expect(links[1], 'Alpha 这一行不是原来那个 Alpha 节点——同上').toBe(alphaNode)

    // 🔴 判据二：用户能感知的后果——焦点还在 **Alpha** 上（跟着那条数据走了第二位），
    // 而不是留在第一位变成 Beta。index 当 key 时焦点会"粘"在位置上，用户按 Enter
    // 打开的是另一部剧。
    expect(document.activeElement, '焦点被换了主人——重排把 A 组的状态套到了 B 组身上')
      .toBe(alphaNode)
    expect(
      (document.activeElement as HTMLElement).getAttribute('aria-label'),
      '焦点所在的行现在显示的是别的作品',
    ).toBe('Alpha')
  })
})

describe('行的去处：点一条落到媒体库详情（不是死链，也不是旧 #/library）', () => {
  it('href = #/media/:workId，冒号已编码', async () => {
    vi.stubGlobal('fetch', mock([
      { workId: 'tmdb:1396', title: 'Breaking Bad', season: 1, episodes: [1], latestAt: NOW, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
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
      { workId: 'a', title: '剧', season: 1, episodes: [3, 5, 7], latestAt: NOW, via: 'fetch', mediaType: 'tv', chineseTitle: null, backdropPath: null },
    ]))
    renderPage('zh')
    const row = await screen.findByRole('link', { name: '剧' })
    expect(row.textContent).toContain('第 3 / 5 / 7集')
    // 两侧至少一侧的后缀非空（否则 suffix 这个键是纯噪音）
    expect(zh.notif_episodes_suffix.length + en.notif_episodes_suffix.length).toBeGreaterThan(0)
  })
})

describe('英雄卡：当天 backdrop 出血 + 更早的天矮卡', () => {
  const art = (over: Partial<FoundGroupDTO> = {}): FoundGroupDTO => ({
    workId: 'tmdb:1', title: 'Cassandra', chineseTitle: '黑暗智宅',
    season: 1, episodes: [3, 5, 7], latestAt: NOW, via: 'fetch', mediaType: 'tv',
    backdropPath: '/bd.jpg', ...over,
  })

  it('today bucket（offset === 0）：hero 用 .wb-run-card / .wb-run-img，backdrop 走 w1280', async () => {
    vi.stubGlobal('fetch', mock([art()]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Cassandra' })
    expect(row.className).toMatch(/wb-run-card/)
    const img = row.querySelector('.wb-run-img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toContain('w1280')
    expect(img!.getAttribute('src')).toContain('/bd.jpg')
    expect(row.textContent).toContain(en.notif_open_library)
    expect(row.textContent).not.toContain('去片库看')
    expect(row.textContent).toContain('3 / 5 / 7')
    expect(row.textContent ?? '').not.toContain('已经齐了')
    expect(row.textContent ?? '').not.toMatch(/season complete|all episodes/i)
  })

  it('更早的天：同一出血的矮卡（notif-hero-compact），不是无图英文行', async () => {
    vi.stubGlobal('fetch', mock([art({ latestAt: NOW - 2 * DAY })]))
    renderPage()
    const row = await screen.findByRole('link', { name: 'Cassandra' })
    expect(row.className).toMatch(/wb-run-card/)
    expect(row.className).toMatch(/notif-hero-compact/)
    expect(row.querySelector('.wb-run-img')).not.toBeNull()
    expect(row.textContent).toContain(en.notif_open_library)
  })

  it('displayTitle：zh 用 chineseTitle，en 用 snapshot title', async () => {
    vi.stubGlobal('fetch', mock([art()]))
    renderPage('zh')
    expect(await screen.findByRole('link', { name: '黑暗智宅' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Cassandra' })).toBeNull()
    cleanup()
    vi.stubGlobal('fetch', mock([art()]))
    renderPage('en')
    expect(await screen.findByRole('link', { name: 'Cassandra' })).toBeInTheDocument()
    expect(screen.queryByText('黑暗智宅')).toBeNull()
  })

  it('en 页 chrome 是 Open in library，不含「去片库看」', async () => {
    vi.stubGlobal('fetch', mock([art()]))
    const { container } = renderPage('en')
    await screen.findByRole('link', { name: 'Cassandra' })
    expect(container.textContent ?? '').toContain(en.notif_open_library)
    expect(container.textContent ?? '').not.toContain('去片库看')
    expect(en.notif_open_library).not.toBe('去片库看')
  })
})
