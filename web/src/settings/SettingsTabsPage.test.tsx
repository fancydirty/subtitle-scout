import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SettingsTabsPage } from './SettingsTabsPage.js'
import * as hooks from '../api/hooks.js'
import type { ProviderRowDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

// 后端 buildProviders 的真实行序与 kind/languages 派生字段（registry spec §4.1）。
const row = (id: ProviderRowDTO['id'], kind: 'infra' | 'source', languages: '*' | string[] | null): ProviderRowDTO =>
  ({ id, kind, languages, secrets: [], lastTest: null, quota: null })
const FULL_ROWS: ProviderRowDTO[] = [
  row('tmdb', 'infra', null), row('llm', 'infra', null), row('translate', 'infra', null),
  row('assrt', 'source', ['zh']), row('opensubtitles', 'source', '*'), row('jimaku', 'source', ['ja']),
  row('subhd', 'source', ['zh']), row('zimuku', 'source', ['zh']),
  row('r3sub', 'source', ['zh']), row('subdl', 'source', '*'),
]
function mockHooks(over: { providers?: number; roots?: number; rows?: ProviderRowDTO[]; settings?: Record<string, string> } = {}) {
  vi.spyOn(hooks, 'useSettings').mockReturnValue({ data: { ai_translate_enabled: 'false', translate_after_attempts: null, ...over.settings } as never, loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useRoots').mockReturnValue({ data: Array(over.roots ?? 0).fill({ path: '/x' }), loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useSetupProviders').mockReturnValue({ data: { providers: over.rows ?? [] }, loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useSetupStatus').mockReturnValue({ data: null, loading: false, error: null, reload: vi.fn() })
}

function renderPage() {
  render(<I18nProvider initialLang="en"><SettingsTabsPage /></I18nProvider>)
}

describe('SettingsTabsPage', () => {
  it('默认 general tab，渲染四个 tab 触发器', () => {
    mockHooks()
    renderPage()
    expect(screen.getByRole('tab', { name: /General/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Providers/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Media/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Security/ })).toBeInTheDocument()
  })

  it('tab 切换显示对应内容', () => {
    mockHooks()
    renderPage()
    const tab = screen.getByRole('tab', { name: /Security/ })
    // Radix Tabs 用 mouseDown(button=0, 无 ctrlKey) 触发激活
    fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
    expect(tab).toHaveAttribute('aria-selected', 'true')
  })

  it('providers badge：rows 未到 → 不渲染数字徽章（不猜 0/N）', () => {
    mockHooks()
    renderPage()
    expect(screen.queryByText(/\d+\/\d+/)).not.toBeInTheDocument()
  })

  it('providers badge：zh 用户派生 N=9（jimaku 隐身），x/N 实算', () => {
    mockHooks({ rows: FULL_ROWS })
    renderPage()
    expect(screen.getByText('0/9')).toBeInTheDocument()
  })

  it('providers badge：en 用户派生 N=5（中文/日文源全部隐身）', () => {
    mockHooks({ rows: FULL_ROWS, settings: { target_languages: 'en' } })
    renderPage()
    expect(screen.getByText('0/5')).toBeInTheDocument()
  })

  it('zh 用户 providers tab：r3sub/SubDL 卡在列，jimaku 卡不渲染', () => {
    mockHooks({ rows: FULL_ROWS })
    renderPage()
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Providers/ }), { button: 0, ctrlKey: false })
    expect(screen.getByText('r3sub')).toBeInTheDocument()
    expect(screen.getByText('SubDL')).toBeInTheDocument()
    expect(screen.queryByText('Jimaku')).not.toBeInTheDocument()
  })

  it('多目标语言（zh,ja）→ 语言自称 section 标题 + 通用组殿后', () => {
    mockHooks({ rows: FULL_ROWS, settings: { target_languages: 'zh,ja' } })
    renderPage()
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Providers/ }), { button: 0, ctrlKey: false })
    expect(screen.getByRole('heading', { name: '中文' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '日本語' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'All languages' })).toBeInTheDocument()
  })

  it('media badge 未配置（roots.length===0）', () => {
    mockHooks({ roots: 0 })
    renderPage()
    expect(screen.getByText('⚠ Not configured')).toBeInTheDocument()
  })

  it('media badge 有目录时不显示未配置', () => {
    mockHooks({ roots: 2 })
    renderPage()
    expect(screen.queryByText('⚠ Not configured')).not.toBeInTheDocument()
  })

  it('通用 tab 不含任何翻译相关控件（反向断言）', () => {
    mockHooks()
    renderPage()
    expect(screen.queryByRole('switch', { name: 'AI subtitle translation' })).not.toBeInTheDocument()
    // 通用 tab 上唯一的 radiogroup 是巡检频率五档（2026-08-28 新接线，非翻译控件）——
    // 早先这里裸断言"无 radiogroup"是拿它当"无翻译控件"的粗代理；scan-frequency 落到
    // 通用 tab 后代理失真。改为精确钉：radiogroup 恰一个且可及名是 Scan frequency，
    // 既确认翻译控件没漏进来，也确认新档位控件确实在位。
    const radiogroups = screen.queryAllByRole('radiogroup')
    expect(radiogroups).toHaveLength(1)
    expect(radiogroups[0]).toHaveAccessibleName('Scan frequency')
  })

  // ── setup/status 的 providers 契约（后端 buildSetupStatus 保证非可选） ──────────
  //
  // 这两条守的是一个**实测过的整页白屏**：原代码写 `data?.providers.subhd.enabled`，
  // 可选链只挡到 data，providers 缺席时抛 TypeError、React 卸载整棵树。
  //
  // ⚠️ 这里**刻意不**断言"缺 providers 时页面照常渲染 0/8"——那是假修复的形状。
  // 契约说 providers 必在，所以缺席是真异常，正确行为是**抛一条说得清的错**，
  // 由 AppShell 的 PageBoundary 降级这一页（见 AppShell.boundary.test.tsx）。
  it('providers 完整时正常读取（subhd/zimuku 各记一分）', () => {
    mockHooks({ rows: FULL_ROWS })
    vi.spyOn(hooks, 'useSetupStatus').mockReturnValue({
      data: {
        providers: {
          subhd: { enabled: true, source: 'db' },
          zimuku: { enabled: true, source: 'db', captchaReady: false },
        },
      } as never,
      loading: false, error: null, reload: vi.fn(),
    })
    renderPage()
    expect(screen.getByText('2/9')).toBeInTheDocument()
  })

  it('data 为 null（未加载/失败）→ 合法缺席，开关分记 0 但**不抛**', () => {
    mockHooks({ rows: FULL_ROWS }) // useSetupStatus 的 data 默认就是 null
    expect(() => renderPage()).not.toThrow()
    expect(screen.getByText('0/9')).toBeInTheDocument()
  })

  it('data 在但 providers 缺席 → 契约违例，抛出指名道姓的错（不是静默 0/8）', () => {
    mockHooks()
    vi.spyOn(hooks, 'useSetupStatus').mockReturnValue({
      data: { bootstrapComplete: true } as never, loading: false, error: null, reload: vi.fn(),
    })
    // React 会把渲染期异常往 console.error 复读一遍，静音只为输出可读。
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // 断言消息内容而不只是 toThrow()：裸 toThrow() 对旧代码的 TypeError 也会绿，
    // 分不出"崩了"和"诚实报了契约违例"。
    expect(() => renderPage()).toThrow(/setup\/status.*providers/s)
  })

  it('providers 在但 zimuku 缺席（半截形状）→ 同样判违例', () => {
    mockHooks()
    vi.spyOn(hooks, 'useSetupStatus').mockReturnValue({
      data: { providers: { subhd: { enabled: false, source: 'none' } } } as never,
      loading: false, error: null, reload: vi.fn(),
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderPage()).toThrow(/providers/)
  })

  // ── zimuku 行现在带 secrets（ZIMUKU_VISION_* 视觉兜底）───────────────────────
  //
  // keyedRows 的判据曾是纯 `secrets.length > 0`。后端把三个 ZIMUKU_VISION_* 挂到 zimuku
  // 行下之后，那个判据会把 zimuku 也当成"凭据卡"：渲染成 ProviderCard（与下面的
  // ProviderToggleCard 重复），并在 n/8 里被数第二次（→ 9/8）。这条钉住排除逻辑。
  it('zimuku 带 ZIMUKU_VISION_* 时不渲染成 keyed 凭据卡，也不在 n/8 里重复计数', () => {
    mockHooks()
    vi.spyOn(hooks, 'useSetupProviders').mockReturnValue({
      data: {
        providers: [
          { id: 'zimuku', kind: 'source', languages: ['zh'], lastTest: null, secrets: [
            { name: 'ZIMUKU_VISION_BASE_URL', set: true, source: 'db', masked: '••••' },
            { name: 'ZIMUKU_VISION_API_KEY', set: true, source: 'db', masked: '••••' },
            { name: 'ZIMUKU_VISION_MODEL', set: true, source: 'db', masked: '••••' },
          ] },
        ],
      } as never,
      loading: false, error: null, reload: vi.fn(),
    })
    vi.spyOn(hooks, 'useSetupStatus').mockReturnValue({
      data: {
        providers: {
          subhd: { enabled: false, source: 'none' },
          zimuku: { enabled: true, source: 'db', captchaReady: false },
        },
      } as never,
      loading: false, error: null, reload: vi.fn(),
    })
    renderPage()
    // 计数只来自 setup/status 的 zimuku.enabled 这一分，不因 secrets 非空再加一分
    // （rows 只有 zimuku 一行 → 派生 N=1；badge 在 tablist 上，不依赖当前 tab）。
    expect(screen.getByText('1/1')).toBeInTheDocument()
    // Radix 卸载非激活 tab 的内容，卡片断言必须先切到 providers。
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Providers/ }), { button: 0, ctrlKey: false })
    // zimuku 只出现一次（开关卡），不额外多一张 keyed 凭据卡。
    expect(screen.getAllByTestId('providers-zimuku')).toHaveLength(1)
  })
})