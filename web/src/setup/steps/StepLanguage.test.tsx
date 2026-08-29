// web/src/setup/steps/StepLanguage.test.tsx：步 1 门禁与联动——空选择禁 Continue；
// 首选 zh 即时切中文 UI（spec §5.2 步 1 的现场证明）；预设全集与设置页清单对账；
// Continue PUT target_languages（选择顺序即 join 顺序）后 onAdvance；PUT 失败行内报错不前进。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepLanguage } from './StepLanguage.js'
import { SELECTABLE_TARGET_LANGUAGES } from '../../settings/text.js'
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
    zimuku: { enabled: false, source: 'none', captchaReady: false }, r3sub: { satisfied: false, source: 'none', masked: null }, subdl: { satisfied: false, source: 'none', masked: null },
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
    // 单选：先选中文切到中文 UI，再选日语切回英文 UI
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    expect(screen.getByRole('button', { name: '保存并继续' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '日本語' }))
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled()
  })

  it('十个预设即语言全集——与设置页 SELECTABLE_TARGET_LANGUAGES 逐一对应，无自由输入框', () => {
    // 2026-08-27 用户裁决：自由输入框删除（pt 静默降级实案的入口形态）。向导只给
    // 有码表落地保障的选项；预设集 = 设置页同一份清单，两处不许各自为政。
    renderStep()
    const group = screen.getByRole('group')
    const buttons = within(group).getAllByRole('button')
    expect(buttons).toHaveLength(SELECTABLE_TARGET_LANGUAGES.length)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Continue → PUT target_languages（单选）→ onAdvance', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as Awaited<ReturnType<typeof api.updateSettings>>)
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    // 单选：只能选一个，选中文后 UI 切中文
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并继续' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({ target_languages: 'zh' })
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
