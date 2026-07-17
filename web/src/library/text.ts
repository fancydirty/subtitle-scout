// web/src/library/text.ts：带动态数字的人话文案——纯函数，按 Lang 分支拼句。
// useT.ts 的 t() 故意不支持插值（"整句平铺 key"），这里的句子都要嵌入运行期数字（覆盖句的
// "24 of 28"、结果计数的 "12"），没法套进那张扁平表，因此单独开一个按语言分支的模块，
// 跟 shell/freshness.ts（同样是"数字驱动的动态行"，但那行钦定永远英文）分工不同：
// 这里的句子属于 Library 区正文，两种语言都要给（DESIGN.md §7 只豁免 Workflow 区）。
import type { Lang } from '../i18n/useT.js'
import type { SeasonTally } from './episodeState.js'

/** 覆盖句的三段式：前缀 + 嵌句大数字 + 后缀，供组件把大数字渲染成 600 字重（DESIGN.md §4：
 *  "人话覆盖句嵌大数字"）。clause 是可选的事实补充（停牌/磁盘缺档计数），无内容时为 null。 */
export interface SeasonCoverageSentence {
  prefix: string
  emphasis: string
  suffix: string
  clause: string | null
}

export function seasonCoverageSentence(season: number, tally: SeasonTally, lang: Lang): SeasonCoverageSentence {
  const covered = tally.covered
  const total = tally.total
  const prefix = lang === 'zh' ? `第 ${season} 季已覆盖` : `Season ${season} has`
  const emphasis = lang === 'zh' ? `${covered} / ${total}` : `${covered} of ${total}`
  const suffix = lang === 'zh' ? '集' : 'episodes covered'

  const clauseParts: string[] = []
  if (tally.throttled > 0) {
    clauseParts.push(lang === 'zh' ? `${tally.throttled} 集停牌中` : `${tally.throttled} throttled`)
  }
  if (tally.dashed > 0) {
    clauseParts.push(lang === 'zh' ? `${tally.dashed} 集磁盘缺档` : `${tally.dashed} files missing on disk`)
  }
  if (tally.hardsub > 0) {
    clauseParts.push(lang === 'zh' ? `${tally.hardsub} 集硬字幕假定` : `${tally.hardsub} hardsub assumed`)
  }
  const clause = clauseParts.length > 0 ? clauseParts.join(lang === 'zh' ? '，' : ', ') : null

  return { prefix, emphasis, suffix, clause }
}

/** 结果计数（DESIGN.md §5："12 series"）——mono 数字 + 单位，沿用旧 PosterWall "N 部" 的中文习惯。 */
export function formatResultCount(n: number, lang: Lang): string {
  return lang === 'zh' ? `${n} 部` : `${n} title${n === 1 ? '' : 's'}`
}

/** 停牌复查倒计时——"next recheck" 前缀走 i18n key（组件层拼），这里只产出紧凑技术格式的
 *  时长本身（3d/5h/…），跟 shell/freshness.ts 的 relAgo 同一挂：时长是技术层读数，两种语言
 *  下都用同一套单位字母，不翻译（DESIGN.md §3：mono 是技术层专属声音）。 */
export function formatDuration(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
