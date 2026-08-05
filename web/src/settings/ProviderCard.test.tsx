// web/src/settings/ProviderCard.test.tsx：字幕源 keyed 卡片（spec §3.2）迁移自
// ProvidersSection KeyedRow，外壳换 SettingsCard。env 源只读、db 源可编辑、
// 编辑/测试/lastTest。fixture 与 ProvidersSection.test.tsx 同形，保证迁移锁。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO } from '../api/types.js'
import { ProviderCard } from './ProviderCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderCard(row: ProviderRowDTO, reload = vi.fn()) {
  render(<I18nProvider initialLang="en"><ProviderCard row={row} reload={reload} /></I18nProvider>)
}

const TMDB: ProviderRowDTO = { id: 'tmdb', secrets: [{ name: 'TMDB_API_KEY' as any, set: true, source: 'env', masked: 'abc••••xyz' }], lastTest: null }
const ASSRT: ProviderRowDTO = { id: 'assrt', secrets: [{ name: 'ASSRT_TOKEN' as any, set: true, source: 'db', masked: 'ass••••123' }], lastTest: { ok: true, at: 1700000000000 } }

describe('ProviderCard', () => {
  it('env 源：只读打码 + locked badge + 无 Edit', () => {
    renderCard(TMDB)
    const card = within(screen.getByTestId('providers-tmdb'))
    expect(card.getByText('abc••••xyz')).toBeInTheDocument()
    expect(card.getByText('🔒 Environment')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('db 源：可编辑 + Edit 按钮 + configured badge', () => {
    renderCard(ASSRT)
    const card = within(screen.getByTestId('providers-assrt'))
    expect(card.getByText('✓ Configured')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('Edit → 输入 → Save → putSecret + reload', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const reload = vi.fn()
    renderCard(ASSRT, reload)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    fireEvent.change(card.getByLabelText('ASSRT_TOKEN'), { target: { value: 'new-tok' } })
    fireEvent.click(card.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('ASSRT_TOKEN', 'new-tok'))
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('空输入 = 不动该键（UI 不提供删除）', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    renderCard(ASSRT)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    fireEvent.click(card.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).not.toHaveBeenCalled())
  })

  it('Test → validateSetup(id) → reload', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true } as any)
    const reload = vi.fn()
    renderCard(ASSRT, reload)
    fireEvent.click(within(screen.getByTestId('providers-assrt')).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('assrt'))
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('lastTest ok → 绿点 + Last test passed；fail → Last test failed + 错误行', () => {
    renderCard(ASSRT)
    expect(within(screen.getByTestId('providers-assrt')).getByText(/Last test passed/)).toBeInTheDocument()
    const fail: ProviderRowDTO = { id: 'llm', secrets: [{ name: 'LLM_API_KEY' as any, set: true, source: 'db', masked: 'sk••••' }], lastTest: { ok: false, at: 1700000000000, error: 'Invalid credentials' } }
    cleanup(); renderCard(fail)
    const card = within(screen.getByTestId('providers-llm'))
    expect(card.getByText(/Last test failed/)).toBeInTheDocument()
    expect(card.getByText('Invalid credentials')).toBeInTheDocument()
  })

  it('混合源编辑：env 行只读，db 行变输入框', () => {
    const mixed: ProviderRowDTO = { id: 'llm', secrets: [
      { name: 'LLM_BASE_URL' as any, set: true, source: 'env', masked: 'htt••••/v1' },
      { name: 'LLM_API_KEY' as any, set: true, source: 'db', masked: 'sk••••ey' },
    ], lastTest: null }
    renderCard(mixed)
    const card = within(screen.getByTestId('providers-llm'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    expect(card.queryByLabelText('LLM_BASE_URL')).not.toBeInTheDocument()
    expect(card.getByText('htt••••/v1')).toBeInTheDocument()
    expect(card.getByLabelText('LLM_API_KEY')).toBeInTheDocument()
  })

  it('保存失败 → 行内错误 + 编辑态保留', async () => {
    vi.spyOn(api, 'putSecret').mockRejectedValue(new Error('boom'))
    renderCard(ASSRT)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    fireEvent.change(card.getByLabelText('ASSRT_TOKEN'), { target: { value: 'new-tok' } })
    fireEvent.click(card.getByRole('button', { name: 'Save' }))
    expect(await card.findByText(/Couldn't save: /)).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('DOM 里不再有 astryx-* 类名', () => {
    renderCard(ASSRT)
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})