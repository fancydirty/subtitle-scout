import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO } from '../api/types.js'
import { ZimukuVisionCard } from './ZimukuVisionCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderCard(reload = vi.fn(), secrets: ProviderRowDTO['secrets'] = []) {
  // Mock setupProviders with zimuku_vision provider containing the provided secrets
  vi.spyOn(api, 'setupProviders').mockResolvedValue({
    providers: [
      { id: 'zimuku_vision' as const, secrets, lastTest: null },
    ],
  })
  render(<I18nProvider initialLang="en"><ZimukuVisionCard reload={reload} /></I18nProvider>)
  return reload
}

describe('ZimukuVisionCard', () => {
  it('渲染三个输入字段：Model、Base URL、API Key', async () => {
    renderCard()
    await waitFor(() => {
      expect(screen.getByLabelText(/Model/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/Base URL/i)).toBeInTheDocument()
      expect(screen.getByLabelText(/API Key/i)).toBeInTheDocument()
    })
  })

  it('未配置时显示 "⚠ Not configured" badge', async () => {
    renderCard()
    await waitFor(() => {
      expect(screen.getByText('⚠ Not configured')).toBeInTheDocument()
    })
  })

  it('三字段全空时 Test 按钮 disabled', async () => {
    renderCard()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Test/i })).toBeDisabled()
    })
  })

  it('三字段全填后 Test 按钮 enabled', async () => {
    renderCard()
    await waitFor(() => {
      fireEvent.change(screen.getByLabelText(/Model/i), { target: { value: 'gpt-4o' } })
      fireEvent.change(screen.getByLabelText(/Base URL/i), { target: { value: 'https://api.example.com/v1' } })
      fireEvent.change(screen.getByLabelText(/API Key/i), { target: { value: 'sk-test' } })
      expect(screen.getByRole('button', { name: /Test/i })).toBeEnabled()
    })
  })

  it('Test 成功后显示成功消息且 Save 按钮 enabled', async () => {
    const testVision = vi.spyOn(api, 'testVision').mockResolvedValue({ success: true, digits: '02998' })
    renderCard()
    await waitFor(() => {
      fireEvent.change(screen.getByLabelText(/Model/i), { target: { value: 'gpt-4o' } })
      fireEvent.change(screen.getByLabelText(/Base URL/i), { target: { value: 'https://api.example.com/v1' } })
      fireEvent.change(screen.getByLabelText(/API Key/i), { target: { value: 'sk-test' } })
    })
    fireEvent.click(screen.getByRole('button', { name: /Test/i }))
    await waitFor(() => {
      expect(testVision).toHaveBeenCalledWith({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
      })
      expect(screen.getByText(/can recognize digits in images/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    })
  })

  it('Test 失败后显示错误消息且 Save 按钮仍 disabled', async () => {
    vi.spyOn(api, 'testVision').mockResolvedValue({ success: false, error: 'Invalid API key' })
    renderCard()
    await waitFor(() => {
      fireEvent.change(screen.getByLabelText(/Model/i), { target: { value: 'gpt-4o' } })
      fireEvent.change(screen.getByLabelText(/Base URL/i), { target: { value: 'https://api.example.com/v1' } })
      fireEvent.change(screen.getByLabelText(/API Key/i), { target: { value: 'sk-bad' } })
    })
    fireEvent.click(screen.getByRole('button', { name: /Test/i }))
    await waitFor(() => {
      expect(screen.getByText(/Invalid API key/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    })
  })

  it('字段内容修改后清除测试结果，Save 按钮重新 disabled', async () => {
    vi.spyOn(api, 'testVision').mockResolvedValue({ success: true, digits: '02998' })
    renderCard()
    await waitFor(() => {
      fireEvent.change(screen.getByLabelText(/Model/i), { target: { value: 'gpt-4o' } })
      fireEvent.change(screen.getByLabelText(/Base URL/i), { target: { value: 'https://api.example.com/v1' } })
      fireEvent.change(screen.getByLabelText(/API Key/i), { target: { value: 'sk-test' } })
    })
    fireEvent.click(screen.getByRole('button', { name: /Test/i }))
    await waitFor(() => {
      expect(screen.getByText(/can recognize digits in images/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    })
    // 修改字段
    fireEvent.change(screen.getByLabelText(/Model/i), { target: { value: 'gpt-4o-mini' } })
    await waitFor(() => {
      expect(screen.queryByText(/can recognize digits in images/i)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    })
  })

  it('Save 按钮点击后调用 putSecret 三次并 reload', async () => {
    vi.spyOn(api, 'testVision').mockResolvedValue({ success: true, digits: '02998' })
    const putSecret = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const reload = renderCard()
    await waitFor(() => {
      fireEvent.change(screen.getByLabelText(/Model/i), { target: { value: 'gpt-4o' } })
      fireEvent.change(screen.getByLabelText(/Base URL/i), { target: { value: 'https://api.example.com/v1' } })
      fireEvent.change(screen.getByLabelText(/API Key/i), { target: { value: 'sk-test' } })
    })
    fireEvent.click(screen.getByRole('button', { name: /Test/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(putSecret).toHaveBeenCalledTimes(3)
      expect(putSecret).toHaveBeenCalledWith('ZIMUKU_VISION_MODEL', 'gpt-4o')
      expect(putSecret).toHaveBeenCalledWith('ZIMUKU_VISION_BASE_URL', 'https://api.example.com/v1')
      expect(putSecret).toHaveBeenCalledWith('ZIMUKU_VISION_API_KEY', 'sk-test')
      expect(reload).toHaveBeenCalled()
    })
  })

  it('已配置状态显示 "✓ Configured" badge 和 Clear 按钮', async () => {
    renderCard(vi.fn(), [
      { name: 'ZIMUKU_VISION_MODEL', set: true, source: 'db', masked: null },
      { name: 'ZIMUKU_VISION_BASE_URL', set: true, source: 'db', masked: null },
      { name: 'ZIMUKU_VISION_API_KEY', set: true, source: 'db', masked: null },
    ])
    await waitFor(() => {
      expect(screen.getByText('✓ Configured')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
    })
  })

  it('Clear 按钮点击打开确认对话框，确认后调用 putSecret 清空三个字段', async () => {
    const putSecret = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const reload = renderCard(vi.fn(), [
      { name: 'ZIMUKU_VISION_MODEL', set: true, source: 'db', masked: null },
      { name: 'ZIMUKU_VISION_BASE_URL', set: true, source: 'db', masked: null },
      { name: 'ZIMUKU_VISION_API_KEY', set: true, source: 'db', masked: null },
    ])
    const clearButton = await screen.findByRole('button', { name: 'Clear' })
    expect(clearButton).toBeInTheDocument()
    fireEvent.click(clearButton)

    // AlertDialog 的 role 是 'alertdialog' 而不是 'dialog'
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveTextContent(/vision fallback/i)

    // 找到对话框中的 Clear 按钮
    const dialogClearButton = within(dialog).getByRole('button', { name: /Clear/i })
    fireEvent.click(dialogClearButton)

    await waitFor(() => {
      expect(putSecret).toHaveBeenCalledTimes(3)
      expect(putSecret).toHaveBeenCalledWith('ZIMUKU_VISION_MODEL', '')
      expect(putSecret).toHaveBeenCalledWith('ZIMUKU_VISION_BASE_URL', '')
      expect(putSecret).toHaveBeenCalledWith('ZIMUKU_VISION_API_KEY', '')
      expect(reload).toHaveBeenCalled()
    })
  })

  it('环境变量锁定时显示 "🔒 Environment" badge 且所有输入 disabled', async () => {
    renderCard(vi.fn(), [
      { name: 'ZIMUKU_VISION_MODEL', set: true, source: 'env', masked: null },
      { name: 'ZIMUKU_VISION_BASE_URL', set: true, source: 'env', masked: null },
      { name: 'ZIMUKU_VISION_API_KEY', set: true, source: 'env', masked: null },
    ])
    await waitFor(() => {
      expect(screen.getByText('🔒 Environment')).toBeInTheDocument()
      expect(screen.getByLabelText(/Model/i)).toBeDisabled()
      expect(screen.getByLabelText(/Base URL/i)).toBeDisabled()
      expect(screen.getByLabelText(/API Key/i)).toBeDisabled()
      expect(screen.getByRole('button', { name: /Test/i })).toBeDisabled()
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
    })
  })
})
