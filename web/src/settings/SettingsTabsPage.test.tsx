import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SettingsTabsPage } from './SettingsTabsPage.js'
import * as hooks from '../api/hooks.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mockHooks(over: { providers?: number; roots?: number } = {}) {
  vi.spyOn(hooks, 'useSettings').mockReturnValue({ data: { ai_translate_enabled: 'false' } as never, loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useDeploySettings').mockReturnValue({ data: null, loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useRoots').mockReturnValue({ data: Array(over.roots ?? 0).fill({ path: '/x' }), loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useSetupProviders').mockReturnValue({ data: { providers: [] }, loading: false, error: null, reload: vi.fn() })
  vi.spyOn(hooks, 'useSetupStatus').mockReturnValue({ data: null, loading: false, error: null, reload: vi.fn() })
}

function renderPage() {
  render(<I18nProvider initialLang="en"><SettingsTabsPage /></I18nProvider>)
}

describe('SettingsTabsPage', () => {
  it('默认 general tab，渲染五个 tab 触发器', () => {
    mockHooks()
    renderPage()
    expect(screen.getByRole('tab', { name: /General/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: /Providers/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Media/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Security/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Advanced/ })).toBeInTheDocument()
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
})