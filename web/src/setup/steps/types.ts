// web/src/setup/steps/types.ts：wizard 步契约。外壳与步的唯一接口面——步拿 status 读已满足态
// （re-run 直通）、落库成功后 patchStatus 同步向导级快照（Launch 步的汇总清单读它）、
// onAdvance/onBack 步进、onComplete 只有末步点火时调。
import type { ReactElement } from 'react'
import type { TKey } from '../../i18n/useT.js'
import type { SetupStatusDTO } from '../../api/types.js'

export interface WizardStepProps {
  status: SetupStatusDTO
  /** 浅合并（子对象整体替换，不做深合并）——步内保存成功后把新的满足态并进来。 */
  patchStatus: (patch: Partial<SetupStatusDTO>) => void
  /** re-run 模式（Settings "Re-run setup wizard" 重进）：已满足的硬门禁步显示绿色打码态、可直接 Continue。 */
  rerun: boolean
  onAdvance: () => void
  onBack: () => void
  onComplete: () => void
}

export interface WizardStepDef {
  id: string
  titleKey: TKey
  descKey: TKey
  /** optional=true 的步渲染 Skip 按钮的许可归步组件；此字段只供 Launch 步汇总清单标 Skipped 用。 */
  optional: boolean
  Component: (props: WizardStepProps) => ReactElement
}
