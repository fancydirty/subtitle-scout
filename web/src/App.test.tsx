// web/src/App.test.tsx：新外壳冒烟测试。覆盖：外壳渲染（三 tab 项在场）、tab 切换、fetch mock
// 下新鲜度行渲染、fetch 失败降级不白屏、⌘K 开合。
//
// 2026-08-07（spec §5）：甄别页下架——本文件里所有 Triage 链接/hash/空态断言与侧栏 parked
// 角标断言随之移除。TriagePage 源码与它自己的测试保留在 web/src/triage/ 下，将来重启用时
// 恢复这些断言即可。
// i18n 完整性测试在 web/src/i18n/i18n.test.ts（不需要挂组件树，纯表对比更快更直接）。
//
// 查询手法说明：侧栏 tab 项渲染成 <a href="#/xxx">（SideNavItem 传了 href），跟顶栏面包屑
// 的同名当前项文字（纯 <span>）会重名——统一用 getByRole('link', {name}) 定位侧栏项，
// 避免 getByText 因为"多处同名"报错。
// 2026-08-27 追加：BottomTabBar 上线后整壳里同名导航链接有**两份**（侧栏 + 底部栏；jsdom
// 无媒体查询，断点互斥由 shell/nav.contract.test.tsx 钉类名验）——涉及导航链接的断言一律
// 先按 aria-label 定位 Side navigation 再 within 查询。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'
import { App } from './App.js'

function requestPath(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  return raw.split('?')[0]
}

/** 按 URL 路由的 fetch mock——Shell 会并发打好几个端点（workflow/pending、health、
 *  activity…），不能像 F2 时那样"随便什么 URL 都回同一个 body"。
 *  （2026-08-12：旧的 /api/v2/library handler 随该端点删除一并移除。） */
function mockFetchRouted(handlers: { path: string; body: unknown; prefix?: boolean }[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = requestPath(input)
    const hit = handlers.find((h) => (h.prefix ? path.startsWith(h.path) : path === h.path))
    if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as unknown as Response
    return { ok: true, status: 200, json: async () => hit.body } as unknown as Response
  })
}

/** Task ⑨ 活动页的健康快照。`current: null` = 没有任何工作台在跑（本冒烟测试不关心
 *  在跑态，只要页面能渲染出来）。workPermitted 给 true 免得状态条上多一行不许可提示
 *  干扰别的断言。 */
const lastInspectAt = Date.now() - 60_000
const HEALTH = {
  lastInspectAt,
  nextInspectAt: lastInspectAt + 24 * 60 * 60 * 1000,
  workPermitted: true,
  engineEnabled: true,
  setupSatisfied: true,
  roots: [],
  unidentified: { dirCount: 0, dirs: [] },
  current: null,
}

function standardHandlers() {
  return [
    // 鉴权 A2 Task 11：App 门先探 auth/status；已登录才渲染 Shell。外壳冒烟测试关注 Shell 内部，
    // 统一给一个"已初始化已登录"的 status，让门放行到 Shell。
    { path: '/api/v2/auth/status', body: { initialized: true, authenticated: true } },
    // 2026-08-13：`/api/v2/workflow/workers` 的 stub 已删——那个端点连同它唯一的消费方
    // （_legacy 活动页）一起没了，活外壳一次都不会打它。留着 stub 会让这份冒烟测试
    // 继续为一条不存在的端点背书。`passes` 保留：它仍是活端点。
    { path: '/api/v2/workflow/passes', body: [] },
    // dashboard-F5：TriagePage（Triage tab 真页面）挂载即打 /api/v2/triage——同上面 passes/
    // workers 的既有理由：F4 及以前 Triage 还是占位态不发请求，现在不给会 404 → error 态，
    // 下面"切到 Triage tab 看空态"的断言永远等不到。
    { path: '/api/v2/triage', body: { pending: [] } },
    // dashboard-F6：SettingsPage（Settings tab 真页面）挂载即打三个端点——同上面历次先例，
    // 不给会让三个 section 各自落进 error 态（各自独立降级，不会白屏，但下面"切到 Settings
    // tab"的断言需要真数据才能命中）。
    {
      path: '/api/v2/settings',
      body: { target_languages: null, hardsub_mode: null, trace_retention_days: null, scan_interval_ms: null },
    },
    { path: '/api/v2/settings/deploy', body: { secrets: {}, nonSecrets: {} } },
    { path: '/api/v2/settings/roots', body: [] },
    // Task ⑨：活动页（默认落地页）挂载即打这两个端点——同上面 passes/workers/triage 的
    // 既有理由，不给会让它落进 error 态，下面"默认落地页渲染的是活动页"的断言就等不到。
    { path: '/api/v2/health', body: HEALTH },
    { path: '/api/v2/activity', body: { subtitleQueue: [], translateQueue: [] } },
  ]
}

beforeEach(() => {
  location.hash = ''
  // 部分 Node/jsdom 组合下 window.localStorage 本身就是 undefined（Node 自带的实验性全局
  // localStorage 会跟 jsdom 环境撞——这不是本任务要修的坑，i18n/useT.ts 已经对这种情况做了
  // try/catch 降级；这里只是尽力清一下，清不掉也不影响这些测试）。
  try {
    window.localStorage.clear()
  } catch {
    /* 环境不提供 localStorage 时无需清理 */
  }
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App 外壳冒烟', () => {
  // 2026-08-12（Task ⑦）：导航换成 FRONTEND-SPEC 的三个页面 + 设置。
  // 旧的 Library/Workflow **路由还在**（直达 #/library、#/workflow 照常渲染真页面），
  // 只是不再出现在侧栏——所以下面断言的是"侧栏里没有它们"，不是"它们没了"。
  it('渲染四个 tab 项（活动/通知/媒体库/设置）', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)

    const nav = await screen.findByRole('navigation', { name: 'Side navigation' })
    expect(within(nav).getByRole('link', { name: 'Activity' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Notifications' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Media' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    // 甄别项已下架（spec §5）：断言它不在场，这就是本轮的回归锁。
    expect(screen.queryByRole('link', { name: /^Triage/ })).not.toBeInTheDocument()
    // Task ⑦：旧两项已从侧栏摘掉（路由仍在，见 shell/nav.contract.test.tsx）。
    expect(screen.queryByRole('link', { name: 'Library' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Workflow' })).not.toBeInTheDocument()
  })

  it('点击侧栏 tab 切换 hash 路由，对应内容跟着换（默认落地页是活动页）', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)

    // Task ⑦：未识别 hash 的落点从 library 改成 activity（library 已不在侧栏，
    // 继续落它会让用户停在一个没有任何高亮项的页面上）。
    const nav = await screen.findByRole('navigation', { name: 'Side navigation' })
    // Task ⑨：活动页已填肉——判据从"施工中标记"换成真页面的标志物（两个 tab 的 tablist）。
    // ⚠️ 只把这一行删掉是不行的：那样默认落地页渲染成什么都不会有人管。
    expect(await screen.findByRole('tablist', { name: 'Workbenches' })).toBeInTheDocument()

    fireEvent.click(within(nav).getByRole('link', { name: 'Notifications' }))
    await waitFor(() => expect(location.hash).toBe('#/notifications'))

    fireEvent.click(within(nav).getByRole('link', { name: 'Media' }))
    await waitFor(() => expect(location.hash).toBe('#/media'))

    // 原本这里还有一段"点 Triage → hash 变 #/triage → 待甄别箱空态"，随甄别页下架移除
    // （spec §5）；重启用时按上面的手法恢复。

    fireEvent.click(within(nav).getByRole('link', { name: 'Settings' }))
    await waitFor(() => expect(location.hash).toBe('#/settings'))
    // 设置是真页面，不该出现占位标记
    await waitFor(() => expect(screen.queryByText('Under construction')).not.toBeInTheDocument())
  })

  it('已登录但后端端点失败时外壳骨架仍在，不白屏', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([
      { path: '/api/v2/auth/status', body: { initialized: true, authenticated: true } },
    ]))
    render(<App />)

    const nav = await screen.findByRole('navigation', { name: 'Side navigation' })
    expect(within(nav).getByRole('link', { name: 'Activity' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Notifications' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Media' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeInTheDocument()
  })
})

// 鉴权 A2 Task 11：App 层鉴权门三态分流 + 结构性白赚的两个 *arr bug 免疫。
describe('App 鉴权门（A2 Task 11）', () => {
  it('auth/status initialized:false → 渲染 SetupWizard（不渲染 Shell）', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([
      { path: '/api/v2/auth/status', body: { initialized: false, authenticated: false } },
    ]))
    render(<App />)
    expect(await screen.findByText('Create the admin account')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Library' })).not.toBeInTheDocument()
  })

  it('initialized:true authenticated:false → 渲染 LoginPage', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([
      { path: '/api/v2/auth/status', body: { initialized: true, authenticated: false } },
    ]))
    render(<App />)
    expect(await screen.findByRole('button', { name: /log in|登录/i })).toBeInTheDocument()
    // 未登录时整个 Shell 不该在场——用导航项之一作探针（Task ⑦ 起是 Activity）。
    expect(screen.queryByRole('link', { name: 'Activity' })).not.toBeInTheDocument()
  })

  it('authenticated:true → 渲染 Shell', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)
    const nav = await screen.findByRole('navigation', { name: 'Side navigation' })
    expect(within(nav).getByRole('link', { name: 'Activity' })).toBeInTheDocument()
  })

  it('auth/status 探测失败（服务器不可达）→ 连接错误屏 + 重试，不误导为 LoginPage、不白屏', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    render(<App />)
    // 不是 LoginPage（fresh install 上误显登录会让用户对着"用户名/密码不正确"的假象），而是诚实
    // 的连接错误 + 重试（correctness 审计 #2）。
    expect(await screen.findByText(/can't reach the server|无法连接服务器/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry|重试/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /log in|登录/i })).not.toBeInTheDocument()
  })

  it('连接错误后点重试，服务器恢复 → 进入对应界面（此处 SetupWizard）', async () => {
    let healthy = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (!healthy) throw new TypeError('Failed to fetch')
      if (url.includes('/auth/status')) return { ok: true, status: 200, json: async () => ({ initialized: false, authenticated: false }) } as unknown as Response
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response
    }))
    render(<App />)
    await screen.findByRole('button', { name: /retry|重试/i })
    healthy = true
    fireEvent.click(screen.getByRole('button', { name: /retry|重试/i }))
    expect(await screen.findByText('Create the admin account')).toBeInTheDocument()
  })
})

// spec A §5.1：AuthGate → BootstrapGate → wizard 接管接缝。上面所有用例的 setup/status 都是
// 404（mockFetchRouted 未列）→ 只练过 fail-open 那条缝；接管路径此前只有 gate 单测（wizard 是
// 打桩的）在看。这里用真 wizard 钉闭环：步组件挂载不发请求（StepLanguage 仅 Continue 时 PUT），
// 两个 handler 就够。
describe('App bootstrap 闸（spec A §5.1）', () => {
  it('已登录但 bootstrapComplete:false → 真 wizard 步 1 接管，Shell 侧栏不渲染', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([
      { path: '/api/v2/auth/status', body: { initialized: true, authenticated: true } },
      {
        path: '/api/v2/setup/status',
        body: {
          bootstrapComplete: false,
          tmdb: { satisfied: false, source: 'none', masked: null },
          llm: { satisfied: false, source: 'none', model: null },
          providers: {
            assrt: { satisfied: false, source: 'none', masked: null },
            opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
            jimaku: { satisfied: false, source: 'none', masked: null },
            subhd: { enabled: false, source: 'none' },
            zimuku: { enabled: false, source: 'none', captchaReady: false },
          },
          roots: { count: 0 },
          engineEnabled: false,
        },
      },
    ]))
    render(<App />)
    // 真 wizard 步 1（Language）的 h1——i18n 默认 en，钉字面量。
    expect(await screen.findByRole('heading', { name: 'Subtitle language' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Library' })).not.toBeInTheDocument()
  })
})

// Plan C Task 28 复审折叠：skip-to-content 的 href 与 <main> 的 id 是字符串耦合——任何一边
// 改名/打错字，键盘跳转静默失效且无任何测试变红。这一条把契约钉死（纯追加，存量断言不动）。
describe('App 外壳无障碍契约（Task 28）', () => {
  it('skip-to-content 链接指向 #scout-app-main，role=main 主区同 id 在场', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)
    // 等 Shell 落地（侧栏出现）再断言，避开 auth/status 探测的空拍。
    await screen.findByRole('navigation', { name: 'Side navigation' })
    expect(screen.getByRole('link', { name: /skip to content/i })).toHaveAttribute(
      'href',
      '#scout-app-main',
    )
    expect(screen.getByRole('main')).toHaveAttribute('id', 'scout-app-main')
  })
})
