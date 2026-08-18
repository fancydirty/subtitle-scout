// humanLabels.test.tsx：审计 P0-5/P0-6 的契约锁——设置页给人看的是人话标签和分钟，
// 不是 env 变量名与毫秒内部存储单位。存储格式只在提交边界转换。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { ProviderCard } from './ProviderCard.js'
import { TranslateCard } from './TranslateCard.js'
import type { ProviderRowDTO, SettingsDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ProviderCard 密钥人话标签', () => {
  it('zh：显示 TMDB API 密钥而不是 TMDB_API_KEY', () => {
    const row: ProviderRowDTO = { id: 'tmdb', secrets: [{ name: 'TMDB_API_KEY', set: true, source: 'env', masked: 'abc••••xyz' }], lastTest: null, quota: null }
    render(<I18nProvider initialLang="zh"><ProviderCard row={row} reload={vi.fn()} /></I18nProvider>)
    const card = within(screen.getByTestId('providers-tmdb'))
    expect(card.getByText('TMDB API 密钥')).toBeInTheDocument()
    expect(card.queryByText('TMDB_API_KEY')).not.toBeInTheDocument()
  })

  it('zh：编辑 db 源时输入框可及名也是人话标签', () => {
    const row: ProviderRowDTO = { id: 'assrt', secrets: [{ name: 'ASSRT_TOKEN', set: true, source: 'db', masked: 'ass••••123' }], lastTest: null, quota: null }
    render(<I18nProvider initialLang="zh"><ProviderCard row={row} reload={vi.fn()} /></I18nProvider>)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: '编辑凭据' }))
    expect(card.getByLabelText('ASSRT token')).toBeInTheDocument()
  })
})

describe('TranslateCard 专用模型字段人话标签', () => {
  const translate: ProviderRowDTO = { id: 'translate', secrets: [
    { name: 'TRANSLATE_BASE_URL', set: false, source: 'none', masked: null },
    { name: 'TRANSLATE_API_KEY', set: false, source: 'none', masked: null },
    { name: 'TRANSLATE_MODEL', set: false, source: 'none', masked: null },
  ], lastTest: null, quota: null }

  it('zh：三个字段的可见标签与可及名都不再是 env 键', () => {
    render(
      <I18nProvider initialLang="zh">
        <TranslateCard
          translate={translate}
          settings={{ ai_translate_enabled: 'true' } as SettingsDTO}
          onUpdated={vi.fn()}
          reload={vi.fn()}
        />
      </I18nProvider>,
    )
    expect(screen.getByLabelText('接口地址')).toBeInTheDocument()
    expect(screen.getByLabelText('API 密钥')).toBeInTheDocument()
    expect(screen.getAllByLabelText('模型').length).toBeGreaterThan(0)
    expect(screen.queryByText('TRANSLATE_BASE_URL')).not.toBeInTheDocument()
    expect(screen.queryByText('TRANSLATE_API_KEY')).not.toBeInTheDocument()
    expect(screen.queryByText('TRANSLATE_MODEL')).not.toBeInTheDocument()
  })
})
