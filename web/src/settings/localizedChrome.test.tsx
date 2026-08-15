// localizedChrome.test.tsx：设置页 chrome 的语言契约锁。
// 审计 P0-1/P0-3/P0-4：中文界面里不准再出现 General/Providers/Cancel/loading… 这类
// 硬编码英文——每个曾经硬编码的 chrome 字符串在这里至少有一条 zh 断言。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SettingsCard } from './SettingsCard.js'
import { SettingsTabsPage } from './SettingsTabsPage.js'
import { ProviderToggleCard } from './ProviderToggleCard.js'
import { TranslateCard } from './TranslateCard.js'
import { ZimukuVisionCard } from './ZimukuVisionCard.js'
import { RemoveRootDialog } from './RemoveRootDialog.js'
import type { ProviderRowDTO, SettingsDTO } from '../api/types.js'
import * as hooks from '../api/hooks.js'
import { api } from '../api/client.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SettingsCard 状态徽标', () => {
  it.each([
    ['configured', '✓ 已配置'],
    ['unconfigured', '⚠ 未配置'],
  ] as const)('%s → zh 徽标', (status, label) => {
    render(<I18nProvider initialLang="zh"><SettingsCard title="X" status={status}>b</SettingsCard></I18nProvider>)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})

describe('SettingsTabsPage 四 tab chrome', () => {
  function mockHooks(roots: number) {
    vi.spyOn(hooks, 'useSettings').mockReturnValue({ data: { ai_translate_enabled: 'false' } as never, loading: false, error: null, reload: vi.fn() })
    vi.spyOn(hooks, 'useRoots').mockReturnValue({ data: Array(roots).fill({ path: '/x' }), loading: false, error: null, reload: vi.fn() })
    vi.spyOn(hooks, 'useSetupProviders').mockReturnValue({ data: { providers: [] }, loading: false, error: null, reload: vi.fn() })
    vi.spyOn(hooks, 'useSetupStatus').mockReturnValue({ data: null, loading: false, error: null, reload: vi.fn() })
  }

  it('zh：四个 tab 与未配置徽标全中文，不出现旧英文 chrome', () => {
    mockHooks(0)
    render(<I18nProvider initialLang="zh"><SettingsTabsPage /></I18nProvider>)
    for (const name of ['通用', '字幕源', '媒体目录', '安全']) {
      expect(screen.getByRole('tab', { name: new RegExp(name) })).toBeInTheDocument()
    }
    expect(screen.getByText('⚠ 未配置')).toBeInTheDocument()
    expect(screen.queryByText('⚠ Not configured')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'General' })).not.toBeInTheDocument()
  })
})

describe('ProviderToggleCard zh', () => {
  it('描述/开关文案/免 key 说明是中文', () => {
    render(
      <I18nProvider initialLang="zh">
        <ProviderToggleCard id="subhd" state={{ enabled: false, source: 'none' }} reload={vi.fn()} />
      </I18nProvider>,
    )
    expect(screen.getByText('中文源')).toBeInTheDocument()
    expect(screen.getByText('启用 subhd')).toBeInTheDocument()
    expect(screen.getByText('无需 API key，开箱即用')).toBeInTheDocument()
  })
})

const TRANSLATE_ROW: ProviderRowDTO = { id: 'translate', secrets: [
  { name: 'TRANSLATE_BASE_URL', set: false, source: 'none', masked: null },
  { name: 'TRANSLATE_API_KEY', set: false, source: 'none', masked: null },
  { name: 'TRANSLATE_MODEL', set: false, source: 'none', masked: null },
], lastTest: null, quota: null }
const LLM_ROW: ProviderRowDTO = { id: 'llm', secrets: [
  { name: 'LLM_MODEL', set: true, source: 'db', masked: 'mimo-v2.5' },
], lastTest: null, quota: null }

function renderTranslate(settings: SettingsDTO) {
  render(
    <I18nProvider initialLang="zh">
      <TranslateCard
        translate={TRANSLATE_ROW}
        llm={LLM_ROW}
        settings={settings}
        onUpdated={vi.fn()}
        reload={vi.fn()}
      />
    </I18nProvider>,
  )
}

describe('TranslateCard zh', () => {
  it('开启前的主文案是中文', () => {
    renderTranslate({ ai_translate_enabled: 'false' } as SettingsDTO)
    expect(screen.getByText('AI 字幕翻译')).toBeInTheDocument()
    expect(screen.getByText('找不到字幕时自动翻译')).toBeInTheDocument()
    expect(screen.getByText('启用 AI 字幕翻译')).toBeInTheDocument()
    expect(screen.getByText('会消耗 LLM 配额')).toBeInTheDocument()
  })

  it('开启后分段选项与当前模型行是中文', () => {
    renderTranslate({ ai_translate_enabled: 'true' } as SettingsDTO)
    expect(screen.getByRole('radio', { name: '跟随默认 LLM' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '专用模型' })).toBeInTheDocument()
    expect(screen.getAllByText((_, el) => (el?.textContent ?? '').replace(/\s+/g, ' ').includes('当前： mimo-v2.5 · 与 agent 共用')).length).toBeGreaterThan(0)
  })
})

describe('ZimukuVisionCard zh 按钮', () => {
  it('测试/保存/清除按钮与取消键是中文', async () => {
    // 先让配置加载完成，按钮组才会出现（配置来自 setupProviders）
    vi.spyOn(api, 'setupProviders').mockResolvedValue({ providers: [
      { id: 'zimuku', lastTest: null, secrets: [
        { name: 'ZIMUKU_VISION_MODEL', set: true, source: 'db', masked: '••••' },
        { name: 'ZIMUKU_VISION_BASE_URL', set: true, source: 'db', masked: '••••' },
        { name: 'ZIMUKU_VISION_API_KEY', set: true, source: 'db', masked: '••••' },
      ] },
    ] } as never)
    render(<I18nProvider initialLang="zh"><ZimukuVisionCard reload={vi.fn()} /></I18nProvider>)
    expect(await screen.findByRole('button', { name: '测试视觉能力' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '清除' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除' }))
    expect(await screen.findByRole('button', { name: '取消' })).toBeInTheDocument()
  })
})


describe('RemoveRootDialog zh Cancel', () => {
  it('破坏性确认的取消键是中文', () => {
    render(
      <I18nProvider initialLang="zh">
        <RemoveRootDialog path="/media" onClose={vi.fn()} onRemoved={vi.fn()} />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument()
  })
})
