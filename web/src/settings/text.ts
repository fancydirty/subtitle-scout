// web/src/settings/text.ts：Settings tab 的纯函数——动态文案组装 + 路径处理（同
// triage/text.ts 的既有分工：带运行期数字/路径的句子走这里而不是 useT.ts 的扁平表）。
// 双语（DESIGN.md §7 只豁免 Workflow 区，Settings 正常双语）。
import type { Lang } from '../i18n/useT.js'
import type { RemoveRootResultDTO } from '../api/types.js'

/** target_languages 未设置时的真实运行期默认值——src/cli/targetLanguages.ts 的
 *  parseTargetLanguages()：raw 为空/未设置时回退到 ['zh']（历史唯一配置，A4 之前的默认目标）。
 *  这里只抄这一个事实作占位提示，不编造任何这份代码里没有的数字（DESIGN.md §8）。 */
export const DEFAULT_TARGET_LANGUAGES = 'zh'

/** 目标语言选项集——后端 src/agent/languages.ts 的 SELECTABLE_TARGET_LANGUAGES 的 web 侧副本。
 *
 *  为什么是副本而不是 import：Dockerfile 的 web 构建阶段只 COPY web/（第 7 行），后端 src/ 不在
 *  那一阶段里，所以 web/ 的**运行时**代码跨界 import ../../../src/ 在生产构建里必然解析失败
 *  （vitest 从仓库根解析，测试全绿也照样掩盖不住——C51 首版就是这么断在 docker build 上的）。
 *  web/src/api/typeContract.ts 是被允许的跨界先例，但它清一色 `import type`，编译期擦除、不进
 *  bundle；值 import 没有这个豁免。
 *
 *  所以重复由守卫消除、不由 import 消除：BehaviorSection.test.tsx 的 C51 那条用 `import type`
 *  取后端常量做类型级对账，两侧一旦分叉就红。加语言仍然只需改后端那一处，然后被测试逼着改这里。 */
export const SELECTABLE_TARGET_LANGUAGES = [
  'zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'it',
] as const

/** hardsub_mode 未设置时的真实运行期默认值——后端 cli/index.ts 的硬事实：未设置/脏值一律
 *  降级 'off'（最保守口径）。PM 审计发现的"spec 写 agent、UI 显示 agent、后端跑 off"三方
 *  打架以**后端为准**对齐（spec 文档为过时记述）。 */
export const DEFAULT_HARDSUB_MODE = 'off'

/** trace_retention_days 未设置时的占位数字——该 settings 键已被 daemon 行为级消费
 *  （cli/index.ts: 债务D5 惰性读），此处数字是部署层兜底/缺省的真实参考
 *  （cli/index.ts 的 LOG_RETAIN_DAYS 兜底 30），只作占位参考。
 *  （scan_interval_ms 的分钟占位/换算常量已随 2026-08-28 五档分段改造删除——不再有分钟输入框。） */
export const PLACEHOLDER_TRACE_RETENTION_DAYS = '30'

/** 删根确认对话框标题——把目标路径亮出来，用户在点下确认前清楚知道删的是哪一个。 */
export function removeRootConfirmTitle(path: string, lang: Lang): string {
  return lang === 'zh' ? `删除媒体目录 "${path}"？` : `Remove "${path}"?`
}

/** 删根成功后的事实计数行——"removed 42 episodes · 3 series · 1 parked" 式，只列非零类别
 *  （同 library/text.ts seasonCoverageSentence 的既有先例：只提非零事实，零值类别不占篇幅）。
 *  四类全零时给一句诚实说明（这个根下本就没有已索引的行）。 */
export function removeRootResultLabel(result: RemoveRootResultDTO, lang: Lang): string {
  if (lang === 'zh') {
    const parts: string[] = []
    if (result.episodes > 0) parts.push(`${result.episodes} 集`)
    if (result.movies > 0) parts.push(`${result.movies} 部电影`)
    if (result.series > 0) parts.push(`${result.series} 部剧`)
    if (result.parked > 0) parts.push(`${result.parked} 条停车记录`)
    return parts.length > 0 ? `已删除 ${parts.join('·')}` : '已删除——这个目录下没有已索引的记录'
  }
  const parts: string[] = []
  if (result.episodes > 0) parts.push(`${result.episodes} episode${result.episodes === 1 ? '' : 's'}`)
  if (result.movies > 0) parts.push(`${result.movies} movie${result.movies === 1 ? '' : 's'}`)
  if (result.series > 0) parts.push(`${result.series} series`)
  if (result.parked > 0) parts.push(`${result.parked} parked`)
  return parts.length > 0 ? `removed ${parts.join(' · ')}` : 'removed nothing — this root had no indexed rows'
}
