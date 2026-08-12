// web/src/settings/text.ts：Settings tab 的纯函数——动态文案组装 + 路径处理（同
// triage/text.ts 的既有分工：带运行期数字/路径的句子走这里而不是 useT.ts 的扁平表）。
// 双语（DESIGN.md §7 只豁免 Workflow 区，Settings 正常双语）。
import type { Lang } from '../i18n/useT.js'
import { formatDuration } from '../lib/duration.js'
import type { RemoveRootResultDTO, DeploySecretDTO } from '../api/types.js'

/** target_languages 未设置时的真实运行期默认值——src/cli/targetLanguages.ts 的
 *  parseTargetLanguages()：raw 为空/未设置时回退到 ['zh']（历史唯一配置，A4 之前的默认目标）。
 *  这里只抄这一个事实作占位提示，不编造任何这份代码里没有的数字（DESIGN.md §8）。 */
export const DEFAULT_TARGET_LANGUAGES = 'zh'

/** hardsub_mode 未设置时的真实运行期默认值——后端 cli/index.ts 的硬事实：未设置/脏值一律
 *  降级 'off'（最保守口径）。PM 审计发现的"spec 写 agent、UI 显示 agent、后端跑 off"三方
 *  打架以**后端为准**对齐（spec 文档为过时记述）。 */
export const DEFAULT_HARDSUB_MODE = 'off'

/** trace_retention_days / scan_interval_ms 未设置时的占位数字——这两个 settings 键已被
 *  daemon 行为级消费（cli/index.ts: 债务D5 惰性读），此处数字是部署层兜底/缺省的真实参考
 *  （cli/index.ts 的 LOG_RETAIN_DAYS 兜底 30；src/daemon/selfScan.ts 的
 *  SELF_SCAN_DEFAULT_INTERVAL_MS=900000），只作占位参考。 */
export const PLACEHOLDER_TRACE_RETENTION_DAYS = '30'
export const PLACEHOLDER_SCAN_INTERVAL_MS = '900000'

/** 守备目录浏览器的默认起点：现有根路径的最长公共祖先目录段（零根时回退到 '/'）。
 *  posix 风格，不处理尾斜杠差异之外的形状（本项目路径恒为绝对路径）。 */
export function commonRootStart(paths: string[]): string {
  if (paths.length === 0) return '/'
  const segLists = paths.map((p) => p.split('/').filter(Boolean))
  const shortest = Math.min(...segLists.map((s) => s.length))
  const common: string[] = []
  for (let i = 0; i < shortest; i++) {
    const seg = segLists[0][i]
    if (segLists.every((s) => s[i] === seg)) common.push(seg)
    else break
  }
  return common.length > 0 ? `/${common.join('/')}` : '/'
}

export interface PathSegment {
  label: string
  path: string
}

/** 面包屑段列表：'/' 打头（恒为第一项），逐级累加。'/' 本身返回单项 [{label:'/',path:'/'}]。 */
export function breadcrumbSegments(path: string): PathSegment[] {
  const segs = path.split('/').filter(Boolean)
  const result: PathSegment[] = [{ label: '/', path: '/' }]
  let acc = ''
  for (const s of segs) {
    acc += `/${s}`
    result.push({ label: s, path: acc })
  }
  return result
}

/** 目录下钻拼路径——parent='/' 时不重复斜杠。 */
export function joinDir(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/** 守备目录"何时加入"相对时间——复用 lib/duration.ts 的 formatDuration（技术单位不翻译，同
 *  triage/text.ts 的 relativeClaimedAgo 先例），只有前后缀跟着语言走。
 *  ⚠️ Task ⑪：这个函数原在 `library/text.ts`，随旧 library 页面移入 `_legacy/` 时提到了
 *  `lib/`——设置页是活着的导航项，不能依赖已下架目录（详见 lib/duration.ts 头注释）。 */
export function addedAgoLabel(deltaMs: number, lang: Lang): string {
  const d = formatDuration(deltaMs)
  return lang === 'zh' ? `${d} 前加入` : `added ${d} ago`
}

/** 删根确认对话框标题——把目标路径亮出来，用户在点下确认前清楚知道删的是哪一个。 */
export function removeRootConfirmTitle(path: string, lang: Lang): string {
  return lang === 'zh' ? `删除守备目录 "${path}"？` : `Remove "${path}"?`
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

/** 部署区 secret 行的展示值——present 时 "····" + 尾 4 位；未配置时 em dash（DeploySection 的
 *  DEPLOY_NONSECRET_KEYS 那半边 null 也用同一个 em dash，两边视觉口径一致）。 */
export function secretDisplay(secret: DeploySecretDTO): string {
  return secret.present ? `····${secret.tail}` : '—'
}
