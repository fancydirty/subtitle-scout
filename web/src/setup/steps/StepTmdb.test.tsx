// web/src/setup/steps/StepTmdb.test.tsx：步 2 硬门禁——测绿才解锁 Save；改值回未测态；
// 保存才落库；env 锁定零输入；db 已配 Re-test 不带凭据（测已解析值）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepTmdb } from './StepTmdb.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: false, source: 'none', masked: null },
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
  return render(<I18nProvider initialLang="en"><StepTmdb {...props(over)} /></I18nProvider>)
}

describe('StepTmdb', () => {
  it('初始：Save 禁用；Test 绿了才解锁 Save', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    expect(api.validateSetup).toHaveBeenCalledWith('tmdb', { TMDB_API_KEY: 'tok-123' })
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled()
  })

  it('Test 失败 → 行内错误；Save 保持禁用', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: false, error: 'Invalid credentials' })
    renderStep()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('测绿后改值 → 回到未测态（Save 重新禁用）', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await screen.findByText('Connected')
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-456' } })
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('Save → putSecret 落库 + patchStatus + onAdvance', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await screen.findByText('Connected')
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put).toHaveBeenCalledWith('TMDB_API_KEY', 'tok-123')
    expect(patchStatus).toHaveBeenCalledWith({ tmdb: { satisfied: true, source: 'db', masked: null } })
  })

  it('env 已配 → 锁定绿态零输入，Continue 直接走', () => {
    const onAdvance = vi.fn()
    renderStep({ onAdvance, status: { ...BASE, tmdb: { satisfied: true, source: 'env', masked: 'abc••••xyz' } } })
    expect(screen.getByText(/Configured via environment/)).toBeInTheDocument()
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('db 已配（re-run）→ Re-test 不带凭据（测已解析值），不重测也能 Continue', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const onAdvance = vi.fn()
    renderStep({ rerun: true, onAdvance, status: { ...BASE, tmdb: { satisfied: true, source: 'db', masked: 'abc••••xyz' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Re-test' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('tmdb'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('validate 端点自身挂了（reject）→ 第四态文案，不回显异常串（spec §7/§8）', async () => {
    vi.spyOn(api, 'validateSetup').mockRejectedValue(new Error('HTTP 500 boom'))
    renderStep()
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'tok-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Test unavailable, retry')).toBeInTheDocument()
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })
})
