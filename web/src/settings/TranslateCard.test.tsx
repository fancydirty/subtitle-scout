import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO, SettingsDTO } from '../api/types.js'
import { TranslateCard } from './TranslateCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const TRANSLATE_ROW: ProviderRowDTO = { id: 'translate', secrets: [
  { name: 'TRANSLATE_BASE_URL', set: false, source: 'none', masked: null },
  { name: 'TRANSLATE_API_KEY', set: false, source: 'none', masked: null },
  { name: 'TRANSLATE_MODEL', set: false, source: 'none', masked: null },
], lastTest: null, quota: null }

function renderCard(over: { translate?: Partial<ProviderRowDTO>; settings?: Partial<SettingsDTO>; reload?: () => void } = {}) {
  const translate: ProviderRowDTO = { ...TRANSLATE_ROW, ...over.translate }
  const settings: SettingsDTO = { ai_translate_enabled: 'false', ...over.settings } as SettingsDTO
  const reload = over.reload ?? vi.fn()
  render(<I18nProvider initialLang="en"><TranslateCard translate={translate} settings={settings} onUpdated={vi.fn()} reload={reload} /></I18nProvider>)
  return reload
}

function fillDedicated() {
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com/v1' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-1' } })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.6-sol' } })
}

describe('TranslateCard', () => {
  it('🔴 打开开关 → PUT ai_translate_enabled=true（不能只改本地 state）', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({
      ai_translate_enabled: 'true',
    } as SettingsDTO)
    renderCard()
    fireEvent.click(screen.getByRole('switch', { name: 'AI subtitle translation' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ ai_translate_enabled: 'true' }))
  })

  it('🔴 关闭开关 → PUT ai_translate_enabled=false', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({
      ai_translate_enabled: 'false',
    } as SettingsDTO)
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fireEvent.click(screen.getByRole('switch', { name: 'AI subtitle translation' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ ai_translate_enabled: 'false' }))
  })

  it('功能关闭时专用字段不在 DOM', () => {
    renderCard()
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('开启后没有「跟随默认 LLM」分段，直接渲染三个必填字段', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'Follow default LLM' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Base URL')).toHaveAttribute('required')
    expect(screen.getByLabelText('API key')).toHaveAttribute('required')
    expect(screen.getByLabelText('Model')).toHaveAttribute('required')
  })

  it('三凭证任一为空 → 保存按钮 disabled', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    const base = screen.getByLabelText('Base URL')
    const key = screen.getByLabelText('API key')
    const model = screen.getByLabelText('Model')
    fireEvent.change(base, { target: { value: 'https://api.example.com/v1' } })
    fireEvent.change(key, { target: { value: 'sk-1' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(model, { target: { value: 'gpt-5.6-sol' } })
    fireEvent.change(base, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('🔴 三凭证全填 → Save 先 validateSetup(translate, drafts)，通了才 PUT 三次', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fillDedicated()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('translate', {
      TRANSLATE_BASE_URL: 'https://api.example.com/v1',
      TRANSLATE_API_KEY: 'sk-1',
      TRANSLATE_MODEL: 'gpt-5.6-sol',
    }))
    expect(put).toHaveBeenCalledTimes(3)
  })

  it('🔴 validate 不通 → 不 PUT、行内 alert、三个输入框原值仍在（同守备目录）', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({
      ok: false,
      error: 'Invalid credentials — check the key and try again.',
    })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fillDedicated()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(validate).toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://api.example.com/v1')
    expect(screen.getByLabelText('API key')).toHaveValue('sk-1')
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-5.6-sol')
  })

  it('空字段失焦 → 行内错误 role=alert', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    const base = screen.getByLabelText('Base URL')
    fireEvent.change(base, { target: { value: 'https://api.example.com/v1' } })
    fireEvent.blur(base)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.change(base, { target: { value: '' } })
    fireEvent.blur(base)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('env 源三凭证 → 字段 readOnly + 无保存按钮', () => {
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'env', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'env', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'env', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    const card = within(screen.getByTestId('providers-translate'))
    expect(card.getByText('✓ Dedicated model')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    expect(card.getByLabelText('Base URL')).toHaveAttribute('readOnly')
  })

  it('徽标：关闭 / 未配完整 / 专用模型（不再有「已开启=跟随默认」）', () => {
    renderCard()
    expect(screen.getByText('Off')).toBeInTheDocument()
    cleanup()
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('⚠ Incomplete')).toBeInTheDocument()
    expect(screen.queryByText('✓ Enabled')).not.toBeInTheDocument()
    cleanup()
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'db', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'db', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'db', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('✓ Dedicated model')).toBeInTheDocument()
  })
})
