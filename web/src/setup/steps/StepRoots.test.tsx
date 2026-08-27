// web/src/setup/steps/StepRoots.test.tsx：步 6 可跳过——零目录 Continue 禁用、Skip 常驻；
// DirBrowser 每加一个 → Continue 解锁 + roots 计数同步进 status（Launch 汇总读它）。
// DirBrowser 打桩：本步只验证消费契约 {startPath, onAdded}，不测浏览器内部（它有主）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { BootstrapWizard } from '../BootstrapWizard.js'
import { StepRoots } from './StepRoots.js'
import type { WizardStepDef, WizardStepProps } from './types.js'

vi.mock('../../settings/RootPathInput.js', () => ({
  RootPathInput: ({ onAdded }: { onAdded: () => void }) => (
    <button data-testid="dir-add" onClick={onAdded}>add</button>
  ),
}))

afterEach(cleanup)

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: true, source: 'db', captchaReady: true },
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
  return render(<I18nProvider initialLang="en"><StepRoots {...props(over)} /></I18nProvider>)
}

describe('StepRoots', () => {
  it('零目录：Continue 禁用；Skip 常驻并带后果说明', () => {
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    expect(screen.getByText(/Library will stay empty until you add a media folder/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip this step' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  // 2026-08-27 实测：用户在这一步不知道该填宿主机路径还是容器路径（容器把宿主机根
  // 挂成 /hostroot，deployContract 钉死的契约）。加一行说明：按机器上的真实路径填，
  // 前面加 /hostroot 前缀，并给一个例子。
  it('带 /hostroot 路径说明（按宿主机真实路径 + /hostroot 前缀，含例子）', () => {
    renderStep()
    expect(screen.getByText(/\/hostroot/)).toBeInTheDocument()
    expect(screen.getByText(/\/hostroot\/mnt\/media/)).toBeInTheDocument()
  })

  it('加一个目录 → Continue 解锁 + patchStatus 同步计数', () => {
    const patchStatus = vi.fn()
    renderStep({ patchStatus })
    fireEvent.click(screen.getByTestId('dir-add'))
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(patchStatus).toHaveBeenCalledWith({ roots: { count: 1 } })
  })

  it('re-run 已有 2 个目录 → Continue 立即可用', () => {
    renderStep({ rerun: true, status: { ...BASE, roots: { count: 2 } } })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  // 壳级集成：外壳无 key 原地重渲，patchStatus 后 status 已含本次新增——计数若再叠加
  // 本地 added 会三角漂移（2 次 add → count 3）。钉死：走真 BootstrapWizard，两次 add
  // 后推进到探针步，status.roots.count 必须如实为 2（Launch 汇总读它）。
  it('外壳集成：加两个目录后 roots.count 如实为 2（无原地重挂漂移）', () => {
    function ProbeStep(p: WizardStepProps) {
      return <span data-testid="probe-count">{p.status.roots.count}</span>
    }
    const steps: WizardStepDef[] = [
      { id: 'roots', titleKey: 'wizard_step_roots_title', descKey: 'wizard_step_roots_desc', optional: true, Component: StepRoots },
      { id: 'probe', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: ProbeStep },
    ]
    render(
      <I18nProvider initialLang="en">
        <BootstrapWizard initialStatus={BASE} rerun={false} onComplete={() => {}} steps={steps} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByTestId('dir-add'))
    fireEvent.click(screen.getByTestId('dir-add'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByTestId('probe-count')).toHaveTextContent('2')
  })
})
