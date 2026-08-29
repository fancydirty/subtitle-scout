// web/src/setup/steps/StepFreeSources.test.tsx：步 5 开关制——source none 出厂 ON；
// 可达性只展示不拦截；Continue 只写非 env 锁定家的 flag；zimuku captcha 状态行。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepFreeSources } from './StepFreeSources.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: false, source: 'none' },
    zimuku: { enabled: false, source: 'none', captchaReady: true }, r3sub: { satisfied: false, source: 'none', masked: null }, subdl: { satisfied: false, source: 'none', masked: null },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, targetLanguages: null, providerRows: null, setTargetLanguages: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepFreeSources {...props(over)} /></I18nProvider>)
}

describe('StepFreeSources', () => {
  it('source none 出厂双 ON；可达性从 checking 翻到 ok', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    expect(screen.getByRole('switch', { name: 'subhd' })).toHaveAttribute('data-state', 'checked')
    expect(screen.getByRole('switch', { name: 'zimuku' })).toHaveAttribute('data-state', 'checked')
    await waitFor(() => expect(screen.getAllByText('Reachable')).toHaveLength(2))
    expect(validate).toHaveBeenCalledWith('subhd')
    expect(validate).toHaveBeenCalledWith('zimuku')
  })

  it('关掉 subhd → Continue 写两个 flag（subhd false / zimuku true）并前进', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    fireEvent.click(screen.getByRole('switch', { name: 'subhd' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({
      'provider:SUBHD_ENABLED': 'false',
      'provider:ZIMUKU_ENABLED': 'true',
    })
    // 同 Task 19：patchStatus 拿到的是整只 providers（`{ ...status.providers, ...statusPatch }`），
    // 裸断言两家会因缺 providers 包装 + 缺另外三家而红。captchaReady 取自 BASE（true），
    // 实现只是把它原样搬过去，不自己判定。
    expect(patchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          subhd: { enabled: false, source: 'db' },
          zimuku: { enabled: true, source: 'db', captchaReady: true }, r3sub: { satisfied: false, source: 'none', masked: null }, subdl: { satisfied: false, source: 'none', masked: null },
        }),
      }),
    )
  })

  it('env 锁定家：开关禁用、不写库，只写另一家', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onAdvance = vi.fn()
    renderStep({
      onAdvance,
      status: { ...BASE, providers: { ...BASE.providers, subhd: { enabled: true, source: 'env' } } },
    })
    expect(screen.getByRole('switch', { name: 'subhd' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ 'provider:ZIMUKU_ENABLED': 'true' })
  })

  it('zimuku captcha 状态行：captchaReady true → ready 文案；false → not ready', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    renderStep()
    expect(screen.getByText('Captcha solver: ready (LLM configured)')).toBeInTheDocument()
    cleanup()
    renderStep({
      status: { ...BASE, providers: { ...BASE.providers, zimuku: { enabled: false, source: 'none', captchaReady: false } } },
    })
    // 未就绪文案是 `wizard_zimuku_captcha_not_ready` = 'Captcha solver needs the LLM from step 3.'
    // ——里面**没有** "not ready" 这三个字，别照着 ready 那句取反造正则。
    expect(screen.getByText(/Captcha solver needs the LLM/)).toBeInTheDocument()
  })

  it('可达性失败 → 失败行展示但开关保持 ON（不拦截）', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: false, error: 'unreachable' })
    renderStep()
    await waitFor(() =>
      expect(screen.getAllByText('Unreachable — stays on, retried at runtime.')).toHaveLength(2),
    )
    expect(screen.getByRole('switch', { name: 'subhd' })).toHaveAttribute('data-state', 'checked')
  })

  it('可达性探针直接抛异常（网络断）→ 失败行展示但开关保持 ON（不拦截）', async () => {
    vi.spyOn(api, 'validateSetup').mockRejectedValue(new Error('network down'))
    renderStep()
    await waitFor(() =>
      expect(screen.getAllByText('Unreachable — stays on, retried at runtime.')).toHaveLength(2),
    )
    expect(screen.getByRole('switch', { name: 'subhd' })).toHaveAttribute('data-state', 'checked')
  })

  it('双 env 锁定 → Continue 零写库，直接前进', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onAdvance = vi.fn()
    renderStep({
      onAdvance,
      status: {
        ...BASE,
        providers: {
          ...BASE.providers,
          subhd: { enabled: true, source: 'env' },
          zimuku: { enabled: true, source: 'env', captchaReady: true }, r3sub: { satisfied: false, source: 'none', masked: null }, subdl: { satisfied: false, source: 'none', masked: null },
        },
      },
    })
    expect(screen.getByRole('switch', { name: 'subhd' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'zimuku' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(update).not.toHaveBeenCalled()
  })
})
