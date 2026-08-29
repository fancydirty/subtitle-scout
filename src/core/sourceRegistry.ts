// src/core/sourceRegistry.ts：源×语言注册表——「哪个字幕源为哪些目标语言服务」的唯一真相。
// 设置页分组、x/N 计数、wizard 源步分流全部从这里派生（经 /setup/providers DTO 的
// kind/languages 字段抵达前端，web 侧不复制本表——两个构建域，复制即漂移）。
//
// 注意这里管的是**展示/配置面**的服务对象，不是引擎行为：adapter 自身的语言门
//（r3subAdapter 中文门控、jimaku 日文定位等）照旧生效，两层各司其职、并不冗余——
// 注册表答"该不该让这个用户看见/配置它"，adapter 答"这个任务该不该出网"。
import type { ProviderName } from './schemas.js'

/** '*' = 全语言通用源（OpenSubtitles/SubDL 这类国际站）。 */
export type SourceLanguages = '*' | readonly string[]

/** local 是引擎内部源（用户自有字幕库），没有配置面，不进注册表。 */
export type SourceId = Exclude<ProviderName, 'local'>

export interface SourceDef {
  id: SourceId
  /** 服务语言集，BCP-47 主码（与 web 侧 SELECTABLE_TARGET_LANGUAGES 同口径）。 */
  languages: SourceLanguages
  /** keyed=有凭据卡；toggle=纯开关源。 */
  credential: 'keyed' | 'toggle'
}

/** 声明序即展示序（设置页/向导都按这个顺序渲染命中的源）。
 *  r3sub 站上虽有 ja/ko/yue 官方轨，但它是台版中文站、服务对象是中文用户，声明 zh。 */
export const SOURCE_REGISTRY: readonly SourceDef[] = [
  { id: 'assrt', languages: ['zh'], credential: 'keyed' },
  { id: 'opensubtitles', languages: '*', credential: 'keyed' },
  { id: 'jimaku', languages: ['ja'], credential: 'keyed' },
  { id: 'r3sub', languages: ['zh'], credential: 'keyed' },
  { id: 'subdl', languages: '*', credential: 'keyed' },
  { id: 'subhd', languages: ['zh'], credential: 'toggle' },
  { id: 'zimuku', languages: ['zh'], credential: 'toggle' },
]

/** target 的 BCP-47 主码（'zh-Hant' → 'zh'）。 */
function primary(tag: string): string {
  return tag.split('-')[0].toLowerCase()
}

/** 用户目标语言 → 该看见/配置的源集合 = 通用源 ∪ 语言命中源，保持声明序。
 *  targets 空（还没选语言，wizard 步 1 之前的形态）→ fail-open 返回全部：
 *  没有依据时隐藏任何源都是在替用户做决定。 */
export function sourcesForLanguages(targets: readonly string[]): SourceDef[] {
  if (targets.length === 0) return [...SOURCE_REGISTRY]
  const wanted = new Set(targets.map(primary))
  return SOURCE_REGISTRY.filter(
    (s) => s.languages === '*' || s.languages.some((l) => wanted.has(l)),
  )
}
