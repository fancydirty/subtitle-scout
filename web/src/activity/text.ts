// web/src/activity/text.ts：活动页 hero 的动态文案——纯函数，按 Lang 分支拼句，零 DOM/React。
//
// 为什么不进 i18n 表：这三句全都要嵌运行期数字（季号、分秒、集数），而 useT 的 t() 故意不支持
// 插值（"整句平铺 key"）。既有先例是 library/text.ts（同样是"数字驱动的人话句"，同样单开模块）。
//
// 语言口径：三句都走双语。活动页是"缓解焦虑的运行态展示"，2026-07-30 用户裁决（DESIGN.md §7）
// 已把运行态展示区改成**跟随 UI 语言**——让中文用户读 "Looking for season 12 subtitles" 来安心
// 不成立。注意这与"技术值永不翻译"不冲突：这里产出的是正文句子，不是工具名/ID。
import type { Lang } from '../i18n/useT.js'

/** 一次 run 的意图动词族。取自 taskType（真实取值见 stage.ts:86 的核实记录）。
 *
 *  为什么按 taskType 分支而不是统一说"正在找字幕"：realign 是校时间轴、translate 是翻译，
 *  两者都不在"找"字幕。给 translate 的 run 写"正在找字幕"是**假话**（DESIGN.md §8：前端只
 *  呈现事实）。未知 taskType 落到中性的"正在处理"——诚实降级，同 stage.ts 的兜底哲学：新
 *  taskType 必然先于 UI 到达前端，此时说一句不会错的话，而不是猜一个可能文不对题的动词。 */
type Verb = 'find' | 'realign' | 'translate' | 'generic'

function verbOf(taskType: string | null): Verb {
  switch (taskType) {
    case 'find_subtitle': return 'find'
    case 'realign': return 'realign'
    case 'translate': return 'translate'
    default: return 'generic'
  }
}

/** 目标是剧还是电影。
 *
 *  为什么这个分族与「图片走 backdrop 还是模糊海报」是**两个独立判据**（任务 5 的关键区分）：
 *   - 图片路径看 `backdropPath === null`（数据可得性）——将来给 movies 补了 backdrop 就自动切回
 *     正常出血背景，不需要改代码。
 *   - 文案分族看**目标种类**（这是不是一部电影）——电影永远没有"第 N 季"，就算某天它有了
 *     backdrop，说"有缺口的每一季"照样是假话。
 *  把两者绑在一个判据上，任一侧演化都会拖坏另一侧。 */
export type TargetKind = 'series' | 'movie'

/** 季范围的人话措辞。
 *
 *  `seasons` 的语义**不是字面全季**（orchestratorAgent.tools.ts:247 的工具描述原文：omit
 *  seasons to cover every season that currently has gaps）：
 *   - `number[]` → 就找这几季
 *   - `null` / `[]` → 当前**有缺口的每一季**
 *  所以 null 分支绝不能写成"全部季"——那会让用户以为 agent 在重扫已经装好的季。
 *  空数组按 null 处理：编排层省略该字段时 JSON 上可能落成 `[]`，语义与省略一致。 */
function seasonScope(seasons: readonly number[] | null, lang: Lang): string {
  if (!seasons || seasons.length === 0) {
    return lang === 'zh' ? '有缺口的每一季' : 'every season with gaps'
  }
  if (lang === 'zh') return `第 ${seasons.join('、')} 季`
  if (seasons.length === 1) return `season ${seasons[0]}`
  return `seasons ${seasons.join(', ')}`
}

/** hero 副标题——"当前这一件事"的一句人话。
 *
 *  ⚠️ 刻意**不写目标语言**（不说"中文字幕"）：目标语言是 target_languages 设置项（可多值、
 *  可改、默认 zh），而 WorkflowRunningWorkerDTO 里根本没有这个字段。照 spec 草图逐字写"中文
 *  字幕"就是把一个前端**看不见**的值硬编码成事实——用户把 target_languages 改成 "en" 之后
 *  这句话会当场变成假话。DESIGN.md §8：前端只呈现事实。等 DTO 真带上语言字段再补这个定语。
 *
 *  铁律③（不暴露机械）：句中不出现 agent/orchestrator/worker/pass/asset/ledger。 */
export function heroSubtitle(
  taskType: string | null,
  seasons: readonly number[] | null,
  lang: Lang,
  kind: TargetKind = 'series',
): string {
  // 电影没有季。`seasons` 对 movie 目标恒无意义（编排层给 movie 派活时不带季），说
  // "有缺口的每一季"是**假话**——所以这里换成"这部电影"，与季语义彻底分开。
  const scope = kind === 'movie'
    ? (lang === 'zh' ? '这部电影' : 'this movie')
    : seasonScope(seasons, lang)
  if (lang === 'zh') {
    switch (verbOf(taskType)) {
      case 'find': return `正在找${scope}的字幕`
      case 'realign': return `正在校正${scope}的字幕时间轴`
      case 'translate': return `正在翻译${scope}的字幕`
      case 'generic': return `正在处理${scope}的字幕`
    }
  }
  switch (verbOf(taskType)) {
    case 'find': return `Looking for subtitles for ${scope}`
    case 'realign': return `Realigning subtitle timing for ${scope}`
    case 'translate': return `Translating subtitles for ${scope}`
    case 'generic': return `Working on subtitles for ${scope}`
  }
}

/** 已进行时长——"已进行 2 分 14 秒" / "Running for 2m 14s"。
 *
 *  §4.4 **不预测剩余时间**：这里只给"已进行"，永远不给 ETA。理由：一次 run 要搜 1 个来源还是
 *  5 个取决于运气（命中哪个 provider、候选够不够干净），任何 ETA 都会在用户眼前反复跳——一个
 *  会跳的假 ETA 比不给更伤信任。所以本模块**不导出**任何剩余时间/预计完成的格式化函数。
 *
 *  为什么不复用既有的两份时长格式化：
 *   - workflow/time.ts 全族是**英文 + 带死前缀**（'3d ago' / 'resets in 4h'），且文件头写明
 *     "故意不进 i18n 表、全部英文"——那是技术层读数的口径，hero 副行是正文人话句，要双语。
 *   - library/text.ts 的 formatDuration 是**单单位紧凑技术格式**（'2m'，秒数直接丢掉），
 *     而这里要的是分+秒（run 通常只跑几分钟，丢掉秒会让读数长时间"不动"，正好破掉本组件唯一
 *     的目的：让用户看到在动）。
 *  两份都不合用，且都被别处依赖，改它们会牵动 Workflow/Library 两区的既有口径。
 *
 *  负 delta（now 早于 startedAtLease——时钟漂移/服务端时间戳）clamp 到 0，防御性口径同
 *  time.ts 的 formatNextRecheck，不炸渲染也不显示负数。 */
export function formatElapsed(deltaMs: number, lang: Lang): string {
  const total = Math.max(0, Math.floor(deltaMs / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (lang === 'zh') {
    return m > 0 ? `已进行 ${m} 分 ${s} 秒` : `已进行 ${s} 秒`
  }
  return m > 0 ? `Running for ${m}m ${s}s` : `Running for ${s}s`
}

/** 右下角的背景信息——"9 集缺字幕"。
 *
 *  铁律②允许这个数字：它是**集数事实**（背景信息），不是质量评分。但它已经**不再是进度条的
 *  分母**（用户裁决 L10：条读的是 agent 工作阶段）——所以它排在右下角、用弱色，读作"顺便一提
 *  这个条目还缺这么多"，而不是"进度 x/y"。 */
export function missingLine(count: number, lang: Lang): string {
  if (lang === 'zh') return `${count} 集缺字幕`
  return `${count} episode${count === 1 ? '' : 's'} missing subtitles`
}

/** 电影队列行的事实句——"缺字幕" / "missing subtitles"，**不带数字**。
 *
 *  为什么不复用 missingLine：`WorkflowPendingMovieDTO.missing` 是 `0 | 1`（一部电影只有一条
 *  字幕轨，要么缺要么不缺），套进 missingLine 会输出"1 集缺字幕"——**电影没有集**，那是假话
 *  （DESIGN.md §8）。这里给不带量词的事实句。
 *
 *  missing===0（该行只因停牌在队列里）时返回 null → 调用方**不渲染那句**：说"缺字幕"是假话，
 *  编一句"等待复查"又会给队列段加出第二档状态词（文件头论证过队列不该有状态列）。 */
export function movieMissingLine(missing: number, lang: Lang): string | null {
  if (missing <= 0) return null
  return lang === 'zh' ? '缺字幕' : 'missing subtitles'
}

// ── 任务 6：队列段 + 刚刚完成段的文案 ─────────────────────────────────────────
//
// 同上面三句的理由留在 text.ts 而不进 i18n 表：全部要嵌运行期数字（季号、条目数、相对时间），
// 而 useT 的 t() 故意不支持插值。

/** 单季标签——队列行的"第 N 季"。
 *
 *  与 seasonScope 分开是刻意的：那个说的是"这次 run 覆盖哪几季"（可能多季、可能是"有缺口的
 *  每一季"），这个说的是**队列里这一行对应的那一季**（pending 的 series[] 是逐季一行，
 *  `WorkflowPendingSeriesDTO.season` 是单个 number）。两个概念共用一个函数会逼其中一边
 *  接受它不需要的 null/数组语义。 */
export function seasonLabel(season: number, lang: Lang): string {
  return lang === 'zh' ? `第 ${season} 季` : `Season ${season}`
}

/** 队列段/完成段的小标题——"接下来 (3)" / "刚刚完成 (2)"。
 *
 *  括号里的计数是**条目数事实**（铁律②允许：不是分数/偏移量/百分比），且它是 Steam 下载页
 *  "Up next (n)" 的既有读法——用户看的就是"还剩几件事"。 */
export function queueHeading(count: number, lang: Lang): string {
  return lang === 'zh' ? `接下来 (${count})` : `Up next (${count})`
}
export function doneHeading(count: number, lang: Lang): string {
  return lang === 'zh' ? `刚刚完成 (${count})` : `Just finished (${count})`
}

/** 队列行右侧的状态词——**只有一档**："等待中"。
 *
 *  为什么不分档（不写"已停牌"/"稍后重试"之类）：spec §3 的裁决是 hero:队列图片尺寸比 ~5:1，
 *  **层级靠图片大小编码**，所以队列行"不需要徽章/状态列/术语"。队列里的每一行客观上都只是
 *  "还没轮到"，再细分就是把 hero 的信息密度搬到低墨排区。
 *
 *  颜色是灰（spec §6 的三档里的中性档），**不是黄**——铁律①只有绿和红，等待是中性事实。 */
export function queuedLabel(lang: Lang): string {
  return lang === 'zh' ? '等待中' : 'queued'
}

/** 完成行的"查看"动作标签。spec §3 里它对位 Steam 的 `▶ Play`——一个**有用的动作**
 *  （去看这个条目现在什么样），不是"忽略/关掉"。 */
export function openLabel(lang: Lang): string {
  return lang === 'zh' ? '查看' : 'View'
}

/** 完成行的相对时间——"2 分钟前" / "2m ago"。
 *
 *  为什么不复用 workflow/time.ts 的 relativeAgo：那份**全英文且文件头明写"故意不进 i18n 表"**
 *  ——它是 Workflow 三泳道那个工程排障页的读数口径。活动页是"缓解焦虑的运行态展示"，
 *  2026-07-30 用户裁决（DESIGN.md §7）已把它改成跟随 UI 语言。给它加 lang 参数会把 Workflow 区
 *  那一族全部拖进双语化（那些调用点的既有裁决恰恰是"永不本地化"），所以这里独立一份——同
 *  formatElapsed 的既有理由。
 *
 *  英文档位与 relativeAgo 逐字一致（just now / Ns / Nm / Nh / Nd ago），中文对应平移：
 *  同一个概念在两个区域读起来不该是两套刻度。
 *
 *  负 delta（finishedAt 晚于 now——时钟漂移）clamp 到 0，同 formatElapsed 的防御口径。 */
export function relativeFinished(deltaMs: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (s < 5) return lang === 'zh' ? '刚刚' : 'just now'
  if (s < 60) return lang === 'zh' ? `${s} 秒前` : `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return lang === 'zh' ? `${m} 分钟前` : `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return lang === 'zh' ? `${h} 小时前` : `${h}h ago`
  const d = Math.floor(h / 24)
  return lang === 'zh' ? `${d} 天前` : `${d}d ago`
}
