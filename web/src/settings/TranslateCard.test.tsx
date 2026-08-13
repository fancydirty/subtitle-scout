import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO, SettingsDTO, DeploySettingsDTO } from '../api/types.js'
import { TranslateCard } from './TranslateCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const TRANSLATE_ROW: ProviderRowDTO = { id: 'translate', secrets: [
  { name: 'TRANSLATE_BASE_URL', set: false, source: 'none', masked: null },
  { name: 'TRANSLATE_API_KEY', set: false, source: 'none', masked: null },
  { name: 'TRANSLATE_MODEL', set: false, source: 'none', masked: null },
], lastTest: null, quota: null }

const LLM_ROW: ProviderRowDTO = { id: 'llm', secrets: [
  { name: 'LLM_MODEL', set: true, source: 'db', masked: 'mimo-v2.5' },
], lastTest: null, quota: null }

function renderCard(over: { translate?: Partial<ProviderRowDTO>; llm?: Partial<ProviderRowDTO>; settings?: Partial<SettingsDTO>; deploy?: Partial<DeploySettingsDTO>; reload?: () => void } = {}) {
  const translate: ProviderRowDTO = { ...TRANSLATE_ROW, ...over.translate }
  const llm: ProviderRowDTO = { ...LLM_ROW, ...over.llm }
  const settings: SettingsDTO = { ai_translate_enabled: 'false', ...over.settings } as SettingsDTO
  const deploy: DeploySettingsDTO = (over.deploy ?? { secrets: { TRANSLATE_API_KEY: { present: false, tail: '' } }, nonSecrets: {} }) as DeploySettingsDTO
  const reload = over.reload ?? vi.fn()
  render(<I18nProvider initialLang="en"><TranslateCard translate={translate} llm={llm} settings={settings} deploy={deploy} onUpdated={vi.fn()} reload={reload} /></I18nProvider>)
  return reload
}

describe('TranslateCard', () => {
  it('功能关闭时第二层不在 DOM（用 queryByRole 断言 null）', () => {
    renderCard()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it('开启后渲染 Segmented，默认跟随默认（三凭证全无）', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByRole('radiogroup')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Follow default LLM' })).toHaveAttribute('aria-checked', 'true')
  })

  it('跟随默认显示当前默认 model 名（取自 LLM 卡片）', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText(/mimo-v2.5/)).toBeInTheDocument()
  })

  it('选专用模型渲染三个必填字段', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fireEvent.click(screen.getByRole('radio', { name: 'Dedicated model' }))
    expect(screen.getByLabelText('TRANSLATE_BASE_URL')).toHaveAttribute('required')
    expect(screen.getByLabelText('TRANSLATE_API_KEY')).toHaveAttribute('required')
    expect(screen.getByLabelText('TRANSLATE_MODEL')).toHaveAttribute('required')
  })

  it('三凭证任一为空 → 保存按钮 disabled（6 条用例合并：3 单空 + 3 双空）', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fireEvent.click(screen.getByRole('radio', { name: 'Dedicated model' }))
    const base = screen.getByLabelText('TRANSLATE_BASE_URL')
    const key = screen.getByLabelText('TRANSLATE_API_KEY')
    const model = screen.getByLabelText('TRANSLATE_MODEL')
    fireEvent.change(base, { target: { value: 'https://api.example.com/v1' } })
    fireEvent.change(key, { target: { value: 'sk-1' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(model, { target: { value: 'gpt-4o-mini' } })
    fireEvent.change(base, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('三凭证全填 → 保存 enabled，PUT 三次', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fireEvent.click(screen.getByRole('radio', { name: 'Dedicated model' }))
    fireEvent.change(screen.getByLabelText('TRANSLATE_BASE_URL'), { target: { value: 'https://api.example.com/v1' } })
    fireEvent.change(screen.getByLabelText('TRANSLATE_API_KEY'), { target: { value: 'sk-1' } })
    fireEvent.change(screen.getByLabelText('TRANSLATE_MODEL'), { target: { value: 'gpt-4o-mini' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(3))
  })

  it('空字段失焦 → 行内错误 role=alert', () => {
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    fireEvent.click(screen.getByRole('radio', { name: 'Dedicated model' }))
    const base = screen.getByLabelText('TRANSLATE_BASE_URL')
    fireEvent.change(base, { target: { value: 'https://api.example.com/v1' } })
    fireEvent.blur(base)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.change(base, { target: { value: '' } })
    fireEvent.blur(base)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('env 源三凭证 → 字段 readOnly + 🔒 徽标 + 无保存按钮', () => {
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'env', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'env', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'env', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    const card = within(screen.getByTestId('providers-translate'))
    expect(card.getByText('🔒 Environment')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('从专用切回跟随默认 → 弹破坏性确认；取消则 Segmented 回弹专用', async () => {
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'db', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'db', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'db', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByRole('radio', { name: 'Dedicated model' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Follow default LLM' }))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByRole('radio', { name: 'Dedicated model' })).toHaveAttribute('aria-checked', 'true')
  })

  it('徽标五态：关闭/已启用/专用模型/配置不完整/环境变量', () => {
    renderCard()
    expect(screen.getByText('Off')).toBeInTheDocument()
    cleanup()
    renderCard({ settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('✓ Enabled')).toBeInTheDocument()
    cleanup()
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'db', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'db', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'db', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('✓ Dedicated model')).toBeInTheDocument()
    cleanup()
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'db', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: false, source: 'none', masked: null },
      { name: 'TRANSLATE_MODEL', set: false, source: 'none', masked: null },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('⚠ Incomplete')).toBeInTheDocument()
    cleanup()
    renderCard({ translate: { secrets: [
      { name: 'TRANSLATE_BASE_URL', set: true, source: 'env', masked: 'htt••••/v1' },
      { name: 'TRANSLATE_API_KEY', set: true, source: 'env', masked: 'sk••••' },
      { name: 'TRANSLATE_MODEL', set: true, source: 'env', masked: 'gp••••' },
    ] }, settings: { ai_translate_enabled: 'true' } as SettingsDTO })
    expect(screen.getByText('🔒 Environment')).toBeInTheDocument()
  })
})