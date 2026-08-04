// web/src/settings/SystemSection.test.tsx：System 区 Re-run 入口——点击调 requestWizardRerun
// （sessionStorage 标记 + reload 的实现在 rerun.ts，这里验证接线不验证 reload 本身）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { requestWizardRerun } from '../setup/rerun.js'
import { SystemSection } from './SystemSection.js'

vi.mock('../setup/rerun.js', () => ({
  RERUN_WIZARD_KEY: 'scout-rerun-wizard',
  requestWizardRerun: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SystemSection', () => {
  it('点击 Re-run setup wizard → requestWizardRerun', () => {
    render(<I18nProvider initialLang="en"><SystemSection /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Re-run setup wizard' }))
    expect(requestWizardRerun).toHaveBeenCalledTimes(1)
  })
})

describe('SystemSection：迁移锁', () => {
  it('DOM 里不再有 astryx-* 类名', () => {
    render(<I18nProvider initialLang="en"><SystemSection /></I18nProvider>)
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
