import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SettingsTabsPage } from './SettingsTabsPage.js'
import * as hooks from '../api/hooks.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mockHooks(over: { providers?: number; roots?: number } = {}) {
  vi.spyOn(hooks, 'useSettings').mockReturnValue({ data: { ai_translate_enabled: 'false' } as never, loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useRoots').mockReturnValue({ data: Array(over.roots ?? 0).fill({ path: '/x' }), loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useSetupProviders').mockReturnValue({ data: { providers: [] }, loading: false, error: null, reload: vi.fn() })
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

  it('providers badge 显示 n/8', () => {
    mockHooks()
    renderPage()
    expect(screen.getByText('0/8')).toBeInTheDocument()
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
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
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
    mockHooks()
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
    expect(screen.getByText('2/8')).toBeInTheDocument()
  })

  it('data 为 null（未加载/失败）→ 合法缺席，降级成 0/8，**不抛**', () => {
    mockHooks() // useSetupStatus 的 data 默认就是 null
    expect(() => renderPage()).not.toThrow()
    expect(screen.getByText('0/8')).toBeInTheDocument()
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
          { id: 'zimuku', lastTest: null, secrets: [
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
    // 计数只来自 setup/status 的 zimuku.enabled 这一分，不因 secrets 非空再加一分。
    // （badge 在 tablist 上，不依赖当前 tab。）
    expect(screen.getByText('1/8')).toBeInTheDocument()
    // Radix 卸载非激活 tab 的内容，卡片断言必须先切到 providers。
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Providers/ }), { button: 0, ctrlKey: false })
    // zimuku 只出现一次（开关卡），不额外多一张 keyed 凭据卡。
    expect(screen.getAllByTestId('providers-zimuku')).toHaveLength(1)
  })
})