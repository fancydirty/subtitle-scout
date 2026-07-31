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
): string {
  const scope = seasonScope(seasons, lang)
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
