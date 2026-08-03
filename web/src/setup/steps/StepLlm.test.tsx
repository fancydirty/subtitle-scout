// web/src/setup/steps/StepLlm.test.tsx：步 3 硬门禁——三字段齐填才能 Test；测绿的组合才能存；
// 保存 = 三次顺序 putSecret；env 锁定展示 model 名（model 非密）；db 已配 Re-test 不带凭据。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepLlm } from './StepLlm.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: false, source: 'none', model: null },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: false },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepLlm {...props(over)} /></I18nProvider>)
}

function fillTriple() {
  fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://api.example.com/v1' } })
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-1' } })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'm-1' } })
}

describe('StepLlm', () => {
  it('三字段未齐 → Test 禁用', () => {
    renderStep()
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://x/v1' } })
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled()
  })

  it('齐填 → Test 打三件套凭据；绿了解锁 Save', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() =>
      expect(validate).toHaveBeenCalledWith('llm', {
        LLM_BASE_URL: 'https://api.example.com/v1', LLM_API_KEY: 'sk-1', LLM_MODEL: 'm-1',
      }),
    )
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled()
  })

  it('测绿后改任一字段 → Save 重新禁用', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await screen.findByText('Connected')
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'm-2' } })
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('Save → 三次顺序 putSecret + patchStatus(model 可见) + onAdvance', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await screen.findByText('Connected')
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([
      ['LLM_BASE_URL', 'https://api.example.com/v1'],
      ['LLM_API_KEY', 'sk-1'],
      ['LLM_MODEL', 'm-1'],
    ])
    expect(patchStatus).toHaveBeenCalledWith({ llm: { satisfied: true, source: 'db', model: 'm-1' } })
  })

  it('env 已配 → 锁定绿态展示 model 名（非密），零输入', () => {
    const onAdvance = vi.fn()
    renderStep({ onAdvance, status: { ...BASE, llm: { satisfied: true, source: 'env', model: 'env-model' } } })
    expect(screen.getByText(/Configured via environment/)).toBeInTheDocument()
    expect(screen.getByText(/env-model/)).toBeInTheDocument()
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('db 已配 → Re-test 不带凭据', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const onAdvance = vi.fn()
    renderStep({ rerun: true, onAdvance, status: { ...BASE, llm: { satisfied: true, source: 'db', model: 'm-1' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Re-test' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('llm'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('validate 端点自身挂了（reject）→ 第四态文案，不回显异常串（spec §7/§8）', async () => {
    vi.spyOn(api, 'validateSetup').mockRejectedValue(new Error('HTTP 500 boom'))
    renderStep()
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Test unavailable, retry')).toBeInTheDocument()
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('Test 返回 ok:false → 行内服务端分类错误；Save 保持禁用', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: false, error: 'Invalid credentials' })
    renderStep()
    fillTriple()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })
})
