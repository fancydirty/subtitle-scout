// web/src/setup/steps/StepLanguage.test.tsx：步 1 门禁与联动——空选择禁 Continue；
// 首选 zh 即时切中文 UI（spec §5.2 步 1 的现场证明）；自定义码 BCP-47 校验；
// Continue PUT target_languages（选择顺序即 join 顺序）后 onAdvance；PUT 失败行内报错不前进。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepLanguage } from './StepLanguage.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const STATUS: SetupStatusDTO = {
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
    status: STATUS,
    patchStatus: () => {},
    rerun: false,
    onAdvance: () => {},
    onBack: () => {},
    onComplete: () => {},
    ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(
    <I18nProvider initialLang="en">
      <StepLanguage {...props(over)} />
    </I18nProvider>,
  )
}

describe('StepLanguage', () => {
  it('空选择 → Continue 禁用（必填门禁）', () => {
    renderStep()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('首选 zh → UI 即时切中文（setLang 联动）', () => {
    renderStep()
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    expect(screen.getByRole('button', { name: '保存并继续' })).toBeEnabled()
  })

  it('首选非 zh → UI 保持/切回英文', () => {
    renderStep()
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    fireEvent.click(screen.getByRole('button', { name: '中文' })) // 取消
    fireEvent.click(screen.getByRole('button', { name: '日本語' }))
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled()
  })

  it('自定义码：非法报 BCP-47 行；合法进选中集', () => {
    renderStep()
    const input = screen.getByPlaceholderText('Add another — e.g. fr, pt-BR')
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText(/BCP-47/)).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'pt-BR' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByText(/BCP-47/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pt-BR' })).toBeInTheDocument()
  })

  it('Continue → PUT target_languages（join 顺序 = 选择顺序）→ onAdvance', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as Awaited<ReturnType<typeof api.updateSettings>>)
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    // 注意标签是英文：setLang 只看 next[0]（本例 = 'en'），所以选了中文之后 UI 仍是英文。
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ target_languages: 'en,zh' })
  })

  it('PUT 失败 → 行内错误、不前进', async () => {
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new Error('must be comma-separated BCP-47 primary codes'))
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    fireEvent.click(screen.getByRole('button', { name: 'English' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    expect(await screen.findByText(/BCP-47 primary codes/)).toBeInTheDocument()
    expect(onAdvance).not.toHaveBeenCalled()
  })
})
