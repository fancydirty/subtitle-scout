// web/src/setup/steps/StepLaunch.test.tsx：步 7——汇总照 status 直译（Configured/Skipped）；
// 开关默认取 status.engineEnabled；Launch 显式 PUT 后 onComplete；PUT 失败不前进。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepLaunch } from './StepLaunch.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: true,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: true, source: 'db', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: true, source: 'db', captchaReady: true },
  },
  roots: { count: 1 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepLaunch {...props(over)} /></I18nProvider>)
}

describe('StepLaunch', () => {
  it('汇总照 status 直译：满足的行 Configured、缺/关的行 Skipped', () => {
    renderStep()
    const rows = screen.getAllByText(/^(Configured|Skipped)$/)
    // 八行：tmdb✓ llm✓ assrt✓ os✗ jimaku✗ subhd✓ zimuku✓ roots✓ → 6 绿 2 跳
    expect(rows).toHaveLength(8)
    expect(screen.getAllByText('Configured')).toHaveLength(6)
    expect(screen.getAllByText('Skipped')).toHaveLength(2)
  })

  it('Launch → PUT engine_enabled true（默认 ON）→ onComplete', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onComplete = vi.fn()
    renderStep({ onComplete })
    expect(screen.getByRole('switch', { name: 'Engine' })).toHaveAttribute('data-state', 'checked')
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ engine_enabled: 'true' })
  })

  it('关掉开关 → Launch PUT engine_enabled false', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onComplete = vi.fn()
    renderStep({ onComplete })
    fireEvent.click(screen.getByRole('switch', { name: 'Engine' }))
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ engine_enabled: 'false' })
  })

  it('PUT 失败 → 行内错误，onComplete 不调用', async () => {
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new Error('boom'))
    const onComplete = vi.fn()
    renderStep({ onComplete })
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('re-run：engineEnabled false 进场 → 开关初始 OFF，Launch 原样 PUT false', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onComplete = vi.fn()
    renderStep({ onComplete, status: { ...BASE, engineEnabled: false } })
    expect(screen.getByRole('switch', { name: 'Engine' })).toHaveAttribute('data-state', 'unchecked')
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }))
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ engine_enabled: 'false' })
  })

  it('连点 Launch → 只 PUT 一次', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const onComplete = vi.fn()
    renderStep({ onComplete })
    const btn = screen.getByRole('button', { name: 'Launch' })
    fireEvent.click(btn)
    fireEvent.click(btn)
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledTimes(1)
  })
})
