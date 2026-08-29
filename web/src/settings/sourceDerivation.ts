// web/src/settings/sourceDerivation.ts：设置页 providers tab 的派生纯函数——
// 「这个用户该看见哪些源」全部由行上的 kind/languages（后端 SOURCE_REGISTRY 派生字段）
// × settings.target_languages 算出。x/N 的 N、卡片可见性、多语言分组共用这一份逻辑，
// 前端不复制注册表（registry spec §3）。
import type { ProviderRowDTO } from '../api/types.js'
import { DEFAULT_TARGET_LANGUAGES } from './text.js'

/** target_languages CSV → BCP-47 主码数组（'zh-Hant,en' → ['zh','en']）。
 *  未设/空 → ['zh']：与 daemon 的 parseTargetLanguages 运行期默认同口径
 *  （text.ts DEFAULT_TARGET_LANGUAGES 的论证）——设置页展示的是 daemon 实际会做的事，
 *  不在"还没配语言"时假装所有源都相关。 */
export function parseTargets(csv: string | null | undefined): string[] {
  const raw = (csv ?? '').trim() === '' ? DEFAULT_TARGET_LANGUAGES : csv!
  return raw
    .split(',')
    .map((t) => t.trim().split('-')[0].toLowerCase())
    .filter((t) => t !== '')
}

function sourceMatches(languages: '*' | string[] | null, targets: string[]): boolean {
  if (languages === '*') return true
  if (languages === null) return true // infra 行没有语言归属，恒展示
  return languages.some((l) => targets.includes(l))
}

/** 该用户可见的行集合（infra 恒在 + 语言命中的源），保持后端行序。 */
export function deriveVisibleRows(rows: ProviderRowDTO[], targetsCsv: string | null | undefined): ProviderRowDTO[] {
  const targets = parseTargets(targetsCsv)
  return rows.filter((r) => r.kind === 'infra' || sourceMatches(r.languages, targets))
}

export interface SourceGroup {
  /** 'all'=单语言平铺（无 section 标题）；否则是语言主码或 'universal'。 */
  lang: 'all' | 'universal' | string
  rows: ProviderRowDTO[]
}

/** 源行分组（infra 行不进组，调用方单独渲染在前）。单语言 → 一个 'all' 组；
 *  多语言 → 每语言一组语言专属源（空组剔除）+ 'universal' 通用组殿后。 */
export function groupSourceRows(rows: ProviderRowDTO[], targets: string[]): SourceGroup[] {
  const sources = rows.filter((r) => r.kind === 'source' && sourceMatches(r.languages, targets))
  if (targets.length <= 1) return [{ lang: 'all', rows: sources }]
  const groups: SourceGroup[] = []
  for (const lang of targets) {
    const own = sources.filter((r) => r.languages !== '*' && r.languages !== null && r.languages.includes(lang))
    if (own.length > 0) groups.push({ lang, rows: own })
  }
  groups.push({ lang: 'universal', rows: sources.filter((r) => r.languages === '*') })
  return groups
}
