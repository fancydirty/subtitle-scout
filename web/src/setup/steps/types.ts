// web/src/setup/steps/types.ts：wizard 步契约。外壳与步的唯一接口面——步拿 status 读已满足态
// （re-run 直通）、落库成功后 patchStatus 同步向导级快照（Launch 步的汇总清单读它）、
// onAdvance/onBack 步进、onComplete 只有末步点火时调。
import type { ReactElement } from 'react'
import type { TKey } from '../../i18n/useT.js'
import type { ProviderRowDTO, SetupStatusDTO } from '../../api/types.js'

/** 步的分流上下文（registry spec §5.2）：语言步落库后由外壳记账下发；providerRows 是
 *  /setup/providers 的行（带 kind/languages 派生字段），加载中/失败为 null——所有分流
 *  判断对 null **fail-open**（不隐藏任何源/步）。 */
export interface WizardDeriveCtx {
  /** StepLanguage 保存成功后的 CSV（'zh' / 'zh,ja'）；进语言步之前为 null。 */
  targetLanguages: string | null
  providerRows: ProviderRowDTO[] | null
}

export interface WizardStepProps extends WizardDeriveCtx {
  status: SetupStatusDTO
  /** 浅合并（子对象整体替换，不做深合并）——步内保存成功后把新的满足态并进来。 */
  patchStatus: (patch: Partial<SetupStatusDTO>) => void
  /** 语言步保存成功后回写外壳（后续源步据此分流）。 */
  setTargetLanguages: (csv: string) => void
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
  /** 分流跳步（registry spec §5.2）：true=该步对当前目标语言无内容，整步不出现在
   *  步进点与流程里（ja/en 用户没有 subhd/zimuku 开关步）。缺省=永不跳。 */
  skip?: (ctx: WizardDeriveCtx) => boolean
  Component: (props: WizardStepProps) => ReactElement
}
