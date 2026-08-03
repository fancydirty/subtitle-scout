// web/src/setup/steps/registry.ts：七步登记处。顺序即 spec A §5.2 的步序，不许乱；
// Tasks 17-22 每落地一步在此追加一行，Task 23 才接进 App——任何中间态可构建、不可达生产。
import type { WizardStepDef } from './types.js'
import { StepLanguage } from './StepLanguage.js'
import { StepTmdb } from './StepTmdb.js'

export const WIZARD_STEPS: WizardStepDef[] = [
  { id: 'language', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StepLanguage },
  { id: 'tmdb', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StepTmdb },
  // Task 18: llm / Task 19: providers / Task 20: free / Task 21: roots / Task 22: launch
]
