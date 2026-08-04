// web/src/App.test.tsx：新外壳冒烟测试。覆盖：外壳渲染（四 tab 项在场）、tab 切换、fetch mock
// 下新鲜度行渲染、fetch 失败降级不白屏、⌘K 开合。
// i18n 完整性测试在 web/src/i18n/i18n.test.ts（不需要挂组件树，纯表对比更快更直接）。
// Library tab 自己的三层格阵/筛选/详情板测试在 web/src/library/SeriesGrid.test.tsx 与
// SeriesPage.test.tsx（dashboard-F3）——这里只保证外壳级别的路由/新鲜度行/⌘K 没被 F3 带崩。
//
// 查询手法说明：侧栏 tab 项渲染成 <a href="#/xxx">（SideNavItem 传了 href），跟顶栏面包屑
// 的同名当前项文字（纯 <span>）会重名——统一用 getByRole('link', {name}) 定位侧栏项，
// 避免 getByText 因为"多处同名"报错。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { App } from './App.js'
import type { WorkflowPendingDTO, LibraryItemDTO } from './api/types.js'

function requestPath(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  return raw.split('?')[0]
}

/** 按 URL 路由的 fetch mock——Shell 现在并发打好几个端点（workflow/pending、library，
 *  路由到剧集详情页时还有 library/series/:id），SeriesGrid 需要 /api/v2/library 真给一个
 *  数组，不能再像 F2 时那样"随便什么 URL 都回同一个 body"（那样 SeriesGrid 拿到非数组会炸）。 */
function mockFetchRouted(handlers: { path: string; body: unknown; prefix?: boolean }[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = requestPath(input)
    const hit = handlers.find((h) => (h.prefix ? path.startsWith(h.path) : path === h.path))
    if (!hit) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) } as unknown as Response
    return { ok: true, status: 200, json: async () => hit.body } as unknown as Response
  })
}

const WORKFLOW: WorkflowPendingDTO = {
  series: [],
  movies: [],
  parked: 3,
  meta: { roots: ['/media'], lastScanAt: Date.now() - 2 * 60_000, files: 568 , lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0},
}
const EMPTY_LIBRARY: LibraryItemDTO[] = []

function standardHandlers() {
  return [
    // 鉴权 A2 Task 11：App 门先探 auth/status；已登录才渲染 Shell。外壳冒烟测试关注 Shell 内部，
    // 统一给一个"已初始化已登录"的 status，让门放行到 Shell。
    { path: '/api/v2/auth/status', body: { initialized: true, authenticated: true } },
    { path: '/api/v2/workflow/pending', body: WORKFLOW },
    { path: '/api/v2/library', body: EMPTY_LIBRARY },
    // Workflow tab 真页面额外发的端点。活动页只用 workers（passes 是旧 Lanes 的中泳道），
    // 但两个都留着：RunDetail 仍被活动页复用，且多给一个 handler 无害。不给 workers 会 404
    // → data 恒 null → 空态判定永远凑不齐（ActivityPage 首载两源皆 null 时渲染 null）。
    { path: '/api/v2/workflow/passes', body: [] },
    { path: '/api/v2/workflow/workers', body: { running: [], recent: [] } },
    // dashboard-F5：TriagePage（Triage tab 真页面）挂载即打 /api/v2/triage——同上面 passes/
    // workers 的既有理由：F4 及以前 Triage 还是占位态不发请求，现在不给会 404 → error 态，
    // 下面"切到 Triage tab 看空态"的断言永远等不到。
    { path: '/api/v2/triage', body: { pending: [] } },
    // dashboard-F6：SettingsPage（Settings tab 真页面）挂载即打三个端点——同上面历次先例，
    // 不给会让三个 section 各自落进 error 态（各自独立降级，不会白屏，但下面"切到 Settings
    // tab"的断言需要真数据才能命中）。
    {
      path: '/api/v2/settings',
      body: { target_languages: null, hardsub_mode: null, exclude_extras: null, trace_retention_days: null, scan_interval_ms: null },
    },
    { path: '/api/v2/settings/deploy', body: { secrets: {}, nonSecrets: {} } },
    { path: '/api/v2/settings/roots', body: [] },
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
  it('渲染四个 tab 项', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)

    expect(await screen.findByRole('link', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Workflow' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Triage/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
  })

  it('点击侧栏 tab 切换 hash 路由，对应内容跟着换（Library 落地页是空库态）', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)

    await screen.findByRole('link', { name: 'Library' })
    expect(await screen.findByText('No library yet')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: 'Workflow' }))
    // 2026-07-31：这个 tab 从旧的 Lanes 三泳道换成了活动页（ActivityPage）。空态文案随之
    // 从 'No active work'（账目视角：没有活）变成 'No subtitles in progress'（运行态视角：
    // 现在没有在处理的字幕）——后者是这一页新的定位，见 AppShell.tsx 的那段注释。
    await waitFor(() => expect(screen.getByText('No subtitles in progress')).toBeInTheDocument())
    expect(location.hash).toBe('#/workflow')
    expect(screen.queryByText('No library yet')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: /^Triage/ }))
    // dashboard-F5：Triage 真页面的待甄别箱空态（好事文案，见 i18n triage_empty_title）。
    await waitFor(() => expect(screen.getByText('Every file found its identifier')).toBeInTheDocument())
    expect(location.hash).toBe('#/triage')
  })

  it('fetch 成功时顶栏渲染 mono 新鲜度行（watching/scanned/files 三段）', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)

    expect(
      await screen.findByText('watching /media · scanned 2m ago · 568 files'),
    ).toBeInTheDocument()
    // 甄别角标：parked=3 时应该出现在侧栏 Triage 项旁边。
    expect(screen.getByText('3')).toBeInTheDocument()
  })

  it('已登录但后端端点失败时外壳骨架仍在，不白屏——新鲜度行降级显示，甄别角标不渲染', async () => {
    // 鉴权 A2 后：只给 auth/status（放行到 Shell），其余端点一律 404（mockFetchRouted 未列即 404）
    // → workflow/pending 失败 → 新鲜度行降级 offline。验证"已登录时后端抖动不白屏"仍成立。
    vi.stubGlobal('fetch', mockFetchRouted([
      { path: '/api/v2/auth/status', body: { initialized: true, authenticated: true } },
    ]))
    render(<App />)

    // 外壳本身（四 tab 项）必须完整渲染，不能因为后端请求失败就整屏空白。
    expect(await screen.findByRole('link', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Workflow' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Triage/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    // 新鲜度行降级为冷静的 mono 灰字，不是报错弹窗。
    await waitFor(() => expect(screen.getByText('offline')).toBeInTheDocument())
    // 无数据时不显示甄别角标。
    expect(screen.queryByText('3')).not.toBeInTheDocument()
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
    expect(screen.queryByRole('link', { name: 'Library' })).not.toBeInTheDocument()
  })

  it('authenticated:true → 渲染 Shell', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)
    expect(await screen.findByRole('link', { name: 'Library' })).toBeInTheDocument()
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

  it('⌘K：点击触发器打开，Escape 关闭', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)
    await screen.findByRole('link', { name: 'Library' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Find anything'))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    // 四个 tab 都是 bootstrap 结果，导航面板里应该能看到（跟侧栏重复渲染的同名文字互不冲突，
    // getAllByText 至少命中一个即可）。
    expect(screen.getAllByText('Workflow').length).toBeGreaterThan(0)

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('⌘K：选中一项后跳转对应 tab 并关闭面板', async () => {
    vi.stubGlobal('fetch', mockFetchRouted(standardHandlers()))
    render(<App />)
    await screen.findByRole('link', { name: 'Library' })

    fireEvent.click(screen.getByText('Find anything'))
    await screen.findByRole('dialog')

    const items = screen.getAllByText('Settings')
    // 最后一个是面板内的 CommandPaletteItem（第一个是侧栏项，是 <a>；CommandK 作为 Shell 的
    // 最后一个子树渲染在 DOM 更靠后的位置）。
    fireEvent.click(items[items.length - 1])

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(location.hash).toBe('#/settings')
    // dashboard-F6：Settings 真页面落地——行为区标题是稳定、不重名的锚点。
    await waitFor(() => expect(screen.getByText('Behavior')).toBeInTheDocument())
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
    // 等 Shell 落地（侧栏链接出现）再断言，避开 auth/status 探测的空拍。
    await screen.findByRole('link', { name: 'Library' })
    expect(screen.getByRole('link', { name: /skip to content/i })).toHaveAttribute(
      'href',
      '#scout-app-main',
    )
    expect(screen.getByRole('main')).toHaveAttribute('id', 'scout-app-main')
  })
})
