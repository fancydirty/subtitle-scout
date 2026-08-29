// web/src/setup/steps/registry.ts：七步登记处，全员到齐。顺序即 spec A §5.2 的步序，不许乱。
// 分流（registry spec §5.2）：开关源步（subhd/zimuku 全 zh）对 ja/en 用户整步跳过。
import type { WizardStepDef } from './types.js'
import { freeStepSkipped } from './derive.js'
import { StepLanguage } from './StepLanguage.js'
import { StepTmdb } from './StepTmdb.js'
import { StepLlm } from './StepLlm.js'
import { StepProviders } from './StepProviders.js'
import { StepFreeSources } from './StepFreeSources.js'
import { StepRoots } from './StepRoots.js'
import { StepLaunch } from './StepLaunch.js'

export const WIZARD_STEPS: WizardStepDef[] = [
  { id: 'language', titleKey: 'wizard_step_language_title', descKey: 'wizard_step_language_desc', optional: false, Component: StepLanguage },
  { id: 'tmdb', titleKey: 'wizard_step_tmdb_title', descKey: 'wizard_step_tmdb_desc', optional: false, Component: StepTmdb },
  { id: 'llm', titleKey: 'wizard_step_llm_title', descKey: 'wizard_step_llm_desc', optional: false, Component: StepLlm },
  { id: 'providers', titleKey: 'wizard_step_providers_title', descKey: 'wizard_step_providers_desc', optional: true, Component: StepProviders },
  { id: 'free', titleKey: 'wizard_step_free_title', descKey: 'wizard_step_free_desc', optional: false, skip: freeStepSkipped, Component: StepFreeSources },
  { id: 'roots', titleKey: 'wizard_step_roots_title', descKey: 'wizard_step_roots_desc', optional: true, Component: StepRoots },
  { id: 'launch', titleKey: 'wizard_step_launch_title', descKey: 'wizard_step_launch_desc', optional: false, Component: StepLaunch },
]
