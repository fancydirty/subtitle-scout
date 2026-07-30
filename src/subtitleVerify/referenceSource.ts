/**
 * 参考源提供者——给时间轴对齐检测（alignDetect.ts）供一份可信的"说话时段序列"。
 *
 * 两层降级，都不碰音频：
 *   ① 内嵌字幕轨（ffprobe 探测 + ffmpeg 抽成 SRT）——实测 380/394 项有轨，全 subrip 文本格式
 *   ② 同目录其他字幕文件（简繁两份、旁边的 .eng.srt 之类）——补 ① 未命中的部分，纯读文件，快
 *
 * **耗时：典型亚秒级，但 ① 层最坏情况可达数分钟。** 别把"亚秒级"当成无条件的性质：
 * ② 层只是读文件解析，确实恒快；① 层要串行 spawn ffmpeg，最多试
 * MAX_EMBEDDED_TRACKS_TRIED 条轨，而 extractEmbeddedSub.ts:42 注明"4K 长片真机可超 30s
 * （Astronaut ~90s+）"、默认超时 5 分钟。理论最坏 = 轨数 × 单轨超时。实测 380/394 项是
 * subrip 文本轨、抽取很快，所以典型路径亚秒级——但"典型"不是"保证"。
 * 串行是刻意的：并行会同时 spawn 多个 ffmpeg 抢 IO，在软路由/NAS 这类弱 IO 环境更糟。
 *
 * ⚠️ 这条更正推翻了一个曾用来支撑架构决策的错误前提。原注释断言"两层皆亚秒级"，
 * 而这正是 spec 论证"不做 VAD"的依据之一（"①② 已覆盖大部分且亚秒级，故不需要 VAD"）。
 * 但实测本地音频 VAD 整轨解码只需 ~14s，比 ① 层的最坏情况**快得多**。
 * 本期仍不做 VAD（云盘那条路确实不可行，见下），但后续若重新权衡，
 * 必须基于"① 层最坏可达数分钟"这个真实数字，而不是"亚秒级"。
 *
 * **刻意不做第三层音频 VAD**：本地整轨解码 ~14s 尚可，但云盘随机读每次 seek 要付 ~12s
 * CDN 延迟（实测局部解码 20s 音频耗 223s）。云盘且 ①② 皆无时如实返回 null，
 * 让调用方判"无法验证"，而不是花几分钟换一个可能仍不可信的答案。
 *
 * **关键语义：对齐只取说话时段，不看文本内容。** 所以内嵌轨是什么语言都行——英日中皆可，
 * 跨语言字幕的文本天然对不上，对齐要的只是"何时有人在说话"这条时间轴骨架。
 * 这条不变量的执行点是 `spans` 字段（已 toSpans 剥文本）——detectOffset 只收它。
 * 返回值另带一份 `cues`（带文本）供**字幕对照图渲染台词**：那是给人看的展示用途，
 * 与对齐算法无关，两个字段刻意分开正是为了让"谁能看到文本"在类型层一目了然。
 *
 * 返回 null = 无可用参考源。调用方据此判"无法验证"（UI 显示绿色而非黄色：
 * 我们没发现问题，不等于我们发现了问题）。
 */
import { readdir as nodeReaddir } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  probeEmbeddedSubtitles as defaultProbeEmbeddedSubtitles,
  type EmbeddedSubtitleTrack,
} from '../files/streamProbe.js'
import { extractEmbeddedSubtitle as defaultExtractEmbeddedSubtitle } from '../files/extractEmbeddedSub.js'
import type { Cue } from '../files/subtitleInspect.js'
import type { SpeechSpan } from './alignDetect.js'
// 读+解码+解析+剥 spans 四件事与待检侧（verifySubtitle.ts）共用同一份实现——
// 口径分裂会直接污染分数，见 subtitleSpans.ts 头注释。
import {
  parseCues,
  toSpans,
  readSubtitleText as defaultReadSubtitleText,
} from './subtitleSpans.js'

export type ReferenceTier = 'embedded' | 'sibling'

export interface ReferenceSource {
  tier: ReferenceTier
  /** 对齐用的时间轴骨架，**已剥掉文本**（toSpans）。detectOffset 只收这个字段，
   *  所以"对齐不看内容"这条语义仍在类型层成立——见 subtitleSpans.toSpans 注释。 */
  spans: SpeechSpan[]
  /**
   * 同一批 cue 的**带文本**原始形态，供字幕对照图渲染台词（subtitleCompareApi.ts）。
   *
   * 为什么带出来而不是让对照图自己再解析一遍：① 层的文本来自 `ffmpeg` 抽内嵌轨，
   * 重新解析意味着**再 spawn 一次 ffmpeg**（本文件头注释：4K 长片单轨可 30~90s，
   * 默认超时 5 分钟）。为了拿一份我们刚刚已经握在手里的文本付这个代价是不可接受的。
   * ② 层虽然只是重读文件，但"哪个同目录文件被选中"的择优逻辑（pickRichest + 各种
   * 落选规则）只存在于本模块内部，对照图要复现它就得把那套规则抄一遍——口径分裂的
   * 老问题（见 subtitleSpans.ts 头注释）。
   *
   * **与 spans 逐项一一对应且同序**（两者由同一个 cues 数组在同一处派生，不存在漂移的
   * 可能）。spans 保留而非让调用方自己 map，是为了上面那条类型层的不变量：
   * 拿 spans 的人拿不到文本。
   */
  cues: Cue[]
  /** 内部诊断用（trace/审计），绝不上 UI——铁律②要求置信度/偏移量/参考源层级只存内部。
   *  内容是给排障的人看的技术事实（"哪条轨/哪个文件被选中、其余为何落选"），
   *  不是给终端用户看的文案。单行，便于原样塞进结构化痕迹字段。 */
  detail: string
}

/** 同目录候选的后缀白名单。与 src/files/subtitleWriter.ts:7 和 src/files/sidecar.ts:12
 *  的 SUBTITLE_EXTS 同源同值——三处必须一致，否则"能装的字幕"与"能当参考源的字幕"口径分裂。
 *
 *  刻意不含 .vtt / .sub：本仓库的解析器（parseSrtCues/parseAssCues）不认这两种格式。
 *  .sub 多为 MicroDVD，用帧号而非时间戳记时，需要知道片源帧率才能换算成毫秒——
 *  而帧率正是对齐场景下我们没有的信息（若已知帧率，帧率不匹配这类偏移根本无需检测）。 */
export const SIBLING_SUBTITLE_EXTS = ['.srt', '.ass', '.ssa'] as const

/** 参考源至少要有这么多条 cue 才被接受。
 *
 *  低于此数的轨撑不起有意义的互相关：强制字幕轨（forced subs，只翻外语对白那几句）
 *  常见只有一二十条 cue 零星散落全片，拿它当参考做 Jaccard 会得到很低的分数，
 *  从而把一条其实正常的字幕误判成"无法验证"——而旁边可能就有一条完整的轨。
 *  宁可判"无参考源"（诚实的沉默）也不要拿稀疏轨算出一个假分数。 */
export const MIN_REFERENCE_CUES = 10

/** ① 层最多实际抽取几条轨。
 *
 *  多轨很常见（一部片常带 en/ja/zh 多条），且"第一条"在实践中不可靠——它可能是强制字幕轨、
 *  SDH/注释轨，或有 stream 但抽出来没内容的空轨。所以要抽多条比 cue 数，不能选第一条。
 *  但某些容器（动画合集/多语言发行）能带几十条轨，全抽会把"亚秒级"退化成十几秒，
 *  故设上限。5 条足以在常见的 en/ja/zh/forced/SDH 组合里挑出信息量最大的那条。
 *  位图轨在探测阶段就被排掉，不占这个额度。 */
export const MAX_EMBEDDED_TRACKS_TRIED = 5

/** ① 层**所有轨加起来**的总时间预算。超预算后不再开新的抽取，拿手上已有的候选择优；
 *  一条都没拿到就降级到 ②。
 *
 *  为什么需要它：MAX_EMBEDDED_TRACKS_TRIED 只封住"试几条"，没封住"总共多久"。
 *  extractEmbeddedSub 默认单轨超时 5 分钟，5 条串行 = 理论最坏 25 分钟——
 *  对一个"顺手校验一下时间轴"的增益功能来说完全不成比例（调用方多半在等一个响应）。
 *  60s 的取法：实测典型 subrip 抽取远快于此，够跑完常见的 3~5 条轨；而真撞上
 *  4K 长片那种单轨 30~90s 的情况，也能在赔掉一两分钟前止损。
 *
 *  只在**开新抽取之前**检查，不中断已在跑的那条：中断需要传 AbortSignal 进
 *  extractEmbeddedSubtitle（它当前不收），而单轨自身已有 5 分钟超时兜底。
 *  所以这是"软预算"——最坏仍可能超出一个单轨时长，但不再是 N 倍。 */
export const EMBEDDED_TOTAL_BUDGET_MS = 60_000

export interface FindReferenceSourceOpts {
  probeEmbedded?: (
    videoPath: string,
  ) => Promise<EmbeddedSubtitleTrack[] | null>
  extractEmbedded?: (
    videoPath: string,
    subtitleStreamIndex: number,
  ) => Promise<string | null>
  readDir?: (dir: string) => Promise<string[]>
  /** 读 + 解码合成一步：调用方只关心"拿到可解析的文本"，编码探测是实现内部的事。
   *  默认实现走 readFileSync + decodeToUtf8（字幕编码五花八门：GBK/BIG5/UTF-16，
   *  朴素按 utf-8 读会把合法中文变成乱码，解析出 0 条 cue 而误判"无参考源"）。
   *  任何失败（不存在/无权限/解不出）返回 null，不抛。 */
  readSubtitleText?: (path: string) => Promise<string | null>
  /** 单调时钟，用于 ① 层总预算计时。默认 Date.now；测试注入假时钟以免依赖真实耗时
   *  （靠 sleep 把测试跑满 60s 是不可接受的）。 */
  now?: () => number
}

/** 把已解码文本解析成 cue、以及 cue → SpeechSpan 的剥离，都在 ./subtitleSpans.ts
 *  （parseCues / toSpans），与待检侧共用。此处不再各写一份。 */

function defaultReadDir(dir: string): Promise<string[]> {
  return nodeReaddir(dir)
}

/** 候选：来源标签（进 detail）+ 解析出的 cue 数（用于择优）。 */
interface Candidate {
  label: string
  cues: Cue[]
}

/** 从若干候选里挑 cue 数最多的；并列时保留先到的（稳定、可预期）。
 *  低于 MIN_REFERENCE_CUES 的一律不返回——见该常量注释。 */
function pickRichest(candidates: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null
  for (const c of candidates) {
    // 严格大于：并列时不替换，先到的胜出
    if (best === null || c.cues.length > best.cues.length) best = c
  }
  if (best === null || best.cues.length < MIN_REFERENCE_CUES) return null
  return best
}

/** ① 内嵌字幕轨。返回命中的候选，或 null（附落选原因供 detail 记录）。 */
async function tryEmbedded(
  videoPath: string,
  probeEmbedded: NonNullable<FindReferenceSourceOpts['probeEmbedded']>,
  extractEmbedded: NonNullable<FindReferenceSourceOpts['extractEmbedded']>,
  now: NonNullable<FindReferenceSourceOpts['now']>,
): Promise<{ hit: Candidate | null; note: string }> {
  let tracks: EmbeddedSubtitleTrack[] | null
  try {
    tracks = await probeEmbedded(videoPath)
  } catch {
    // probeEmbeddedSubtitles 的契约是失败返回 null 不抛，但注入实现未必守约——
    // 探测炸了不该让整次检测失败，降级到 ② 仍有机会拿到参考源
    return { hit: null, note: 'embedded probe threw' }
  }

  // null = 探测不可用（二进制缺失/超时/JSON 解不出），不等于"确认无内嵌轨"。
  // 两者对本函数的后续动作恰好相同（都降级到 ②），但 detail 要如实区分，
  // 否则事后排障无法分辨"这片子真没内嵌轨"与"这台机器的 ffprobe 坏了"。
  if (tracks === null) return { hit: null, note: 'embedded probe unavailable' }
  if (tracks.length === 0) return { hit: null, note: 'no embedded tracks' }

  const textTrackIndexes: number[] = []
  let imageBasedCount = 0
  for (const [index, track] of tracks.entries()) {
    // 位图字幕（PGS/DVD/DVB/xsub）是画面叠加，没有文本时间轴可抽——必须排除。
    if (track.isImageBased) { imageBasedCount++; continue }
    textTrackIndexes.push(index)
  }

  if (textTrackIndexes.length === 0) {
    return { hit: null, note: `all ${imageBasedCount} embedded track(s) image-based` }
  }

  const tried = textTrackIndexes.slice(0, MAX_EMBEDDED_TRACKS_TRIED)
  const candidates: Candidate[] = []
  let extractFailures = 0
  let budgetExhaustedAfter: number | null = null
  const startedAt = now()
  for (const [attempt, index] of tried.entries()) {
    // 只在开新抽取之前检查预算，不中断已在跑的那条（见 EMBEDDED_TOTAL_BUDGET_MS 注释）。
    // 第一条轨天然无条件被试：startedAt 就在循环前一行取，attempt 0 时 elapsed 恒为 0，
    // 必然小于预算。这是刻意依赖的性质——预算是防"多轨累加成几分钟"，不是防"单轨慢"，
    // 一条都不试就降级会把①层在慢盘上彻底废掉。
    if (now() - startedAt >= EMBEDDED_TOTAL_BUDGET_MS) {
      budgetExhaustedAfter = attempt
      break
    }
    let srt: string | null
    try {
      srt = await extractEmbedded(videoPath, index)
    } catch {
      // extractEmbeddedSubtitle 的契约是失败返回 null 不抛，但注入实现未必守约
      srt = null
    }
    if (srt === null) { extractFailures++; continue }
    const cues = parseCues(srt)
    if (cues.length === 0) { extractFailures++; continue }
    candidates.push({ label: `track ${index}`, cues })
  }

  const notes: string[] = []
  if (imageBasedCount > 0) notes.push(`${imageBasedCount} image-based skipped`)
  if (tried.length < textTrackIndexes.length) {
    notes.push(`${textTrackIndexes.length - tried.length} track(s) not tried (cap ${MAX_EMBEDDED_TRACKS_TRIED})`)
  }
  if (extractFailures > 0) notes.push(`${extractFailures} extraction failed`)
  if (budgetExhaustedAfter !== null) {
    notes.push(`budget ${EMBEDDED_TOTAL_BUDGET_MS}ms exhausted after ${budgetExhaustedAfter} track(s)`)
  }

  const best = pickRichest(candidates)
  if (best === null) {
    const why = candidates.length === 0
      ? 'no usable embedded track'
      : `embedded best has too few cues (<${MIN_REFERENCE_CUES})`
    return { hit: null, note: [why, ...notes].join('; ') }
  }
  return { hit: best, note: notes.join('; ') }
}

/** ② 同目录其他字幕文件。返回命中的候选，或 null。 */
async function trySibling(
  ourSubtitlePath: string,
  readDir: NonNullable<FindReferenceSourceOpts['readDir']>,
  readSubtitleText: NonNullable<FindReferenceSourceOpts['readSubtitleText']>,
): Promise<{ hit: Candidate | null; note: string }> {
  const dir = dirname(resolve(ourSubtitlePath))
  // 必须归一后比较，不能比字符串：同一个文件可能以相对/绝对路径、含 ./ 冗余段等
  // 不同形式表达，字符串相等会漏判，于是拿待检字幕自己当自己的参考——
  // 那必然算出 offset 0 / score 1.0，把任何偏移都掩盖成"完美对齐"。
  const ourResolved = resolve(ourSubtitlePath)

  let entries: string[]
  try {
    entries = await readDir(dir)
  } catch {
    return { hit: null, note: 'sibling dir unreadable' }
  }

  const candidatePaths = entries
    .filter((name) => (SIBLING_SUBTITLE_EXTS as readonly string[]).includes(extname(name).toLowerCase()))
    .map((name) => join(dir, name))
    .filter((path) => resolve(path) !== ourResolved)

  if (candidatePaths.length === 0) return { hit: null, note: 'no sibling subtitle' }

  const candidates: Candidate[] = []
  let unreadable = 0
  let unparsable = 0
  for (const path of candidatePaths) {
    let text: string | null
    try {
      text = await readSubtitleText(path)
    } catch {
      // 默认实现已把失败归一为 null；注入实现或未来改动未必守约，这里兜住
      text = null
    }
    if (text === null) { unreadable++; continue }
    const cues = parseCues(text)
    // 解不出 cue 的情形很常见且不该中断：字幕站下回来的 404 HTML 页、
    // 编码探测猜错导致全是乱码、Format 行与字段数不符的畸形 ASS。
    if (cues.length === 0) { unparsable++; continue }
    candidates.push({ label: basename(path), cues })
  }

  const notes: string[] = []
  if (unreadable > 0) notes.push(`${unreadable} unreadable`)
  if (unparsable > 0) notes.push(`${unparsable} unparsable`)

  const best = pickRichest(candidates)
  if (best === null) {
    const why = candidates.length === 0
      ? 'no usable sibling subtitle'
      : `sibling best has too few cues (<${MIN_REFERENCE_CUES})`
    return { hit: null, note: [why, ...notes].join('; ') }
  }
  return { hit: best, note: notes.join('; ') }
}

function joinNotes(parts: readonly string[]): string {
  return parts.filter((p) => p.length > 0).join('; ')
}

/**
 * 找一份可用的参考源，按 ① 内嵌轨 → ② 同目录字幕 的顺序降级。
 *
 * @param videoPath 片源路径（① 层探测/抽取的对象）
 * @param ourSubtitlePath 待检字幕路径（② 层据此定位同目录，并把自己排除在候选之外）
 * @returns 命中的参考源，或 null（无可用参考源 → 调用方判"无法验证"）
 *
 * 纯读取，不写盘、不写 trace、不 console——诊断信息只进返回值的 detail 字段
 * （本模块是纯函数层，写痕迹是上层 API 的事）。
 */
export async function findReferenceSource(
  videoPath: string,
  ourSubtitlePath: string,
  opts?: FindReferenceSourceOpts,
): Promise<ReferenceSource | null> {
  const probeEmbedded = opts?.probeEmbedded
    ?? ((path: string) => defaultProbeEmbeddedSubtitles(path))
  const extractEmbedded = opts?.extractEmbedded
    ?? ((path: string, index: number) => defaultExtractEmbeddedSubtitle(path, index))
  const readDir = opts?.readDir ?? defaultReadDir
  const readSubtitleText = opts?.readSubtitleText ?? defaultReadSubtitleText
  const now = opts?.now ?? Date.now

  const embedded = await tryEmbedded(videoPath, probeEmbedded, extractEmbedded, now)
  if (embedded.hit !== null) {
    return {
      tier: 'embedded',
      spans: toSpans(embedded.hit.cues),
      // 同一个 cues 数组派生 spans 与 cues 两个视图，故二者必然同序等长（见 ReferenceSource.cues）
      cues: embedded.hit.cues,
      detail: joinNotes([
        `embedded ${embedded.hit.label} (${embedded.hit.cues.length} cues)`,
        embedded.note,
      ]),
    }
  }

  const sibling = await trySibling(ourSubtitlePath, readDir, readSubtitleText)
  if (sibling.hit !== null) {
    return {
      tier: 'sibling',
      spans: toSpans(sibling.hit.cues),
      cues: sibling.hit.cues,
      detail: joinNotes([
        `sibling ${sibling.hit.label} (${sibling.hit.cues.length} cues)`,
        // ① 为何落选也要留痕：否则事后无法区分"没内嵌轨"与"内嵌轨全是位图/抽取失败"
        `tier1: ${embedded.note}`,
        sibling.note,
      ]),
    }
  }

  // 两层皆无：如实返回 null。刻意不做第三层音频 VAD（见文件头）。
  return null
}
