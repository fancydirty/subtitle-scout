// web/src/setup/BootstrapWizard.test.tsx：外壳步进语义——stub 步注入（steps prop），不拉真步。
// 锁四件事：首步渲染（title/desc 走 t()）、步进/onBack、patchStatus 浅合并、rerun 透传与
// 末步 onComplete。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import type { SetupStatusDTO } from '../api/types.js'
import { BootstrapWizard } from './BootstrapWizard.js'
import type { WizardStepDef, WizardStepProps } from './steps/types.js'

afterEach(cleanup)

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

function StubA(p: WizardStepProps) {
  return (
    <div>
      <button onClick={() => p.patchStatus({ engineEnabled: false })}>patch</button>
      <button onClick={p.onAdvance}>go-b</button>
    </div>
  )
}
function StubB(p: WizardStepProps) {
  return (
    <div>
      <span>{p.status.engineEnabled ? 'ee-on' : 'ee-off'}</span>
      <span>{p.rerun ? 'rerun-mode' : 'fresh-mode'}</span>
      <button onClick={p.onBack}>go-a</button>
      <button onClick={p.onComplete}>done</button>
    </div>
  )
}

const STUB_STEPS: WizardStepDef[] = [
  { id: 'a', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StubA },
  { id: 'b', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StubB },
]

function renderWizard(over: Partial<Parameters<typeof BootstrapWizard>[0]> = {}) {
  return render(
    <I18nProvider initialLang="en">
      <BootstrapWizard initialStatus={STATUS} rerun={false} onComplete={() => {}} steps={STUB_STEPS} {...over} />
    </I18nProvider>,
  )
}

describe('BootstrapWizard 外壳', () => {
  it('渲染首步 title/desc（走 t()）与步数对应的步进点', () => {
    const { container } = renderWizard()
    expect(screen.getByRole('heading', { name: 'Subtitle language' })).toBeInTheDocument()
    // 2026-08-28 用户裁决：desc 删掉「首选语言同时决定界面语言」一句（联动行为保留，只删文案）。
    expect(screen.getByText(/Which language should Scout fetch subtitles in\?/)).toBeInTheDocument()
    expect(screen.queryByText(/sets the UI language/)).toBeNull()
    expect(container.querySelectorAll('[role="img"] > span')).toHaveLength(2)
  })

  it('onAdvance 进下一步；已走过的点变绿（bg-fn-green）', () => {
    const { container } = renderWizard()
    fireEvent.click(screen.getByText('go-b'))
    expect(screen.getByRole('heading', { name: 'TMDB' })).toBeInTheDocument()
    expect(container.querySelector('[role="img"] > span')!.className).toContain('bg-fn-green')
  })

  it('patchStatus 浅合并后后续步读到新值', () => {
    renderWizard()
    fireEvent.click(screen.getByText('patch'))
    fireEvent.click(screen.getByText('go-b'))
    expect(screen.getByText('ee-off')).toBeInTheDocument()
  })

  it('onBack 回上一步；onComplete 在末步触发；rerun 透传', () => {
    const onComplete = vi.fn()
    renderWizard({ rerun: true, onComplete })
    fireEvent.click(screen.getByText('go-b'))
    expect(screen.getByText('rerun-mode')).toBeInTheDocument()
    fireEvent.click(screen.getByText('go-a'))
    expect(screen.getByRole('heading', { name: 'Subtitle language' })).toBeInTheDocument()
    fireEvent.click(screen.getByText('go-b'))
    fireEvent.click(screen.getByText('done'))
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
