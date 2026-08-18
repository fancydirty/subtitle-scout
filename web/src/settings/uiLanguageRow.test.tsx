// web/src/settings/uiLanguageRow.test.tsx —— 设置页「界面语言」切换行。
//
// ── 为什么存在 ─────────────────────────────────────────────────────────
// 2026-08-18 用户裁决：UI 语言不能只在 setup 向导里选一次——
// 「切换了 UI 语言的话，界面上语言的一切应该都是切换后语言才对」。
// 这要求**运行时**有一个切换入口。位置在 BehaviorSection 第一行
// （在 EngineRow 之前，语言影响所有其他设置的阅读）。
//
// 关键约束：
//   · 不走后端 PUT——这是浏览器本地偏好（localStorage["scout-lang"]），
//     不是服务器配置（target_languages 那类）。两台设备互不影响。
//   · SegmentedControl 两个按钮（中文 / English），不用 Select——
//     两个选项的切换不需要开下拉。
//   · 切换即时生效（useT().setLang 内部 setState + localStorage 同步写）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { BehaviorSection } from './BehaviorSection.js'
import type { Async } from '../api/hooks.js'
import type { SettingsDTO } from '../api/types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  // 部分 Node/jsdom 组合下 window.localStorage 本身是 undefined（Node 实验性全局
  // 与 jsdom 环境撞）——useT.ts 已 try/catch 降级；这里清理也走同款容错。
  try { window.localStorage.removeItem('scout-lang') } catch { /* 环境不提供 */ }
})

function settingsAsync(data: SettingsDTO | null = null): Async<SettingsDTO> {
  return {
    data: data ?? ({ engineEnabled: true } as SettingsDTO),
    loading: false,
    error: null,
    reload: () => {},
  }
}

describe('界面语言切换行', () => {
  it('渲染 SegmentedControl：两个按钮「中文」「English」，当前 lang 的那个 aria-pressed=true', () => {
    render(<I18nProvider initialLang="zh"><BehaviorSection settings={settingsAsync()} /></I18nProvider>)
    const group = screen.getByRole('group', { name: '界面语言' })
    const zhBtn = within(group).getByRole('button', { name: '中文' })
    const enBtn = within(group).getByRole('button', { name: 'English' })
    expect(zhBtn).toHaveAttribute('aria-pressed', 'true')
    expect(enBtn).toHaveAttribute('aria-pressed', 'false')
  })

  it('en → 点「中文」→ setLang("zh") 生效（同 Provider 内 aria-pressed 翻转）', () => {
    render(<I18nProvider initialLang="en"><BehaviorSection settings={settingsAsync()} /></I18nProvider>)
    const group = screen.getByRole('group', { name: 'Interface language' })
    const zhBtn = within(group).getByRole('button', { name: '中文' })
    expect(zhBtn).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(zhBtn)
    // 同一 Provider 内 setLang 即时生效——两个按钮的 aria-pressed 应该翻转
    expect(zhBtn).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('zh → 点「English」→ aria-pressed 翻转', () => {
    render(<I18nProvider initialLang="zh"><BehaviorSection settings={settingsAsync()} /></I18nProvider>)
    const group = screen.getByRole('group', { name: '界面语言' })
    const enBtn = within(group).getByRole('button', { name: 'English' })
    expect(enBtn).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(enBtn)
    expect(enBtn).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: '中文' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('🔴 切换**不走**后端 PUT——这是浏览器本地偏好，不是服务器配置', () => {
    // 形参显式声明：不声明的话 vi.fn 推出的 calls 类型是 `[]`，c[0]/c[1] 在 tsc 下报 TS2493。
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)
    render(<I18nProvider initialLang="en"><BehaviorSection settings={settingsAsync()} /></I18nProvider>)
    const group = screen.getByRole('group', { name: 'Interface language' })
    fireEvent.click(within(group).getByRole('button', { name: '中文' }))
    // 任何 PUT /api/v2/settings 都是错的——本地偏好不该惊动后端
    const settingsPut = fetchSpy.mock.calls.filter((c) => {
      const init = c[1] as RequestInit | undefined
      return init?.method === 'PUT' && String(c[0]).includes('/settings')
    })
    expect(settingsPut).toEqual([])
  })

  it('行位置在 EngineRow **之前**（语言影响所有其他设置的阅读）', () => {
    render(<I18nProvider initialLang="en"><BehaviorSection settings={settingsAsync()} /></I18nProvider>)
    const langGroup = screen.getByRole('group', { name: 'Interface language' })
    const engineSwitch = screen.getByRole('switch')
    // compareDocumentPosition: FOLLOWING 表示 engineSwitch 在 langGroup 之后
    const rel = langGroup.compareDocumentPosition(engineSwitch)
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
