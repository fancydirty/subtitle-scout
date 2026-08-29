// web/src/setup/steps/derive.ts：wizard 源步分流的纯函数（registry spec §5.2）。
// 语言归属唯一来源是 /setup/providers 行上的 languages（后端 SOURCE_REGISTRY 派生），
// wizard 不复制注册表；rows 未到 / 语言未选一律 fail-open（不隐藏任何源/步）。
import type { ProviderRowDTO } from '../../api/types.js'
import type { WizardDeriveCtx } from './types.js'

/** wizard 里出现的 keyed 源步成员（字段定义在 StepProviders；顺序=无行数据时的兜底序）。 */
export const WIZARD_KEYED_SOURCE_IDS = ['assrt', 'opensubtitles', 'jimaku', 'r3sub', 'subdl'] as const
export type WizardKeyedSourceId = (typeof WIZARD_KEYED_SOURCE_IDS)[number]

/** 开关型源（StepFreeSources 的成员）。 */
const TOGGLE_SOURCE_IDS = ['subhd', 'zimuku'] as const

function primaryTags(csv: string): string[] {
  return csv.split(',').map((t) => t.trim().split('-')[0].toLowerCase()).filter((t) => t !== '')
}

/** 单源可见性：行缺席（rows 未到）/语言未选 → fail-open true。 */
export function wizardSourceVisible(row: ProviderRowDTO | undefined, targetLanguages: string | null): boolean {
  if (!row) return true
  if (row.languages === '*' || row.languages === null) return true
  if (targetLanguages === null) return true
  const targets = primaryTags(targetLanguages)
  if (targets.length === 0) return true
  return row.languages.some((l) => targets.includes(l))
}

/** keyed 源步的可见成员，按行序（=注册表声明序）；rows 未到 → 兜底全员。 */
export function visibleKeyedSourceIds(ctx: WizardDeriveCtx): WizardKeyedSourceId[] {
  const rows = ctx.providerRows
  if (rows === null) return [...WIZARD_KEYED_SOURCE_IDS]
  const ordered = rows
    .filter((r): r is ProviderRowDTO & { id: WizardKeyedSourceId } =>
      (WIZARD_KEYED_SOURCE_IDS as readonly string[]).includes(r.id))
    .filter((r) => wizardSourceVisible(r, ctx.targetLanguages))
    .map((r) => r.id)
  // rows 在但一个都没匹配上（异常形态）→ 兜底全员，别渲染一个空步。
  return ordered.length > 0 ? ordered : [...WIZARD_KEYED_SOURCE_IDS]
}

/** 开关源步（subhd/zimuku）整步跳过判定：**只有证据齐了才跳**——rows 与语言都在，
 *  且两家的语言都不命中（ja/en 用户）。任何一侧缺席都不跳（fail-open）。 */
export function freeStepSkipped(ctx: WizardDeriveCtx): boolean {
  if (ctx.providerRows === null || ctx.targetLanguages === null) return false
  return TOGGLE_SOURCE_IDS.every((id) => {
    const row = ctx.providerRows!.find((r) => r.id === id)
    return row !== undefined && !wizardSourceVisible(row, ctx.targetLanguages)
  })
}
