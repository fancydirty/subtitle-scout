/**
 * 字幕时间轴校验的编排层——把三个纯模块接成一条可用的检测链，并把结论落库供 UI 读取。
 *
 *   待检字幕 spans（subtitleSpans.loadSpans）
 *     → findReferenceSource（referenceSource.ts，① 内嵌轨 → ② 同目录字幕）
 *     → detectOffset（alignDetect.ts，离散化 + 滑窗 Jaccard）
 *     → 按阈值判读成三值 verdict
 *     → SubtitleVerifyRepo.upsertVerifyResult
 *
 * **本层不做校正**（shiftTiming.ts 由后续的校正动作调用，不在这里自动触发）：检测与写盘
 * 必须分开，用户点了"校正"才动他的文件。
 *
 * **本层不做任何面向用户的文案格式化**（spec 铁律②/③）。score / offsetMs / referenceTier
 * 只进 DB 与 detail 字符串供排障；它们怎么变成界面上的一个红点或绿点，是 API/UI 层的事。
 * detail 里的英文技术事实是给排障的人看的，不是给终端用户看的。
 */
import {
  detectOffset as defaultDetectOffset,
  CONFIDENT_THRESHOLD,
  BIN_MS,
  type SpeechSpan,
  type AlignDetectResult,
} from './alignDetect.js'
import {
  findReferenceSource as defaultFindReferenceSource,
  type ReferenceSource,
} from './referenceSource.js'
import {
  loadSpans as defaultLoadSpans,
  hashSubtitleContent as defaultHashSubtitleContent,
} from './subtitleSpans.js'
import type { SubtitleVerdict, SubtitleVerifyRepo } from '../v2/subtitleVerifyRepo.js'

/**
 * 判"红"所需的最小偏移量。低于此值即便分数很高也判 aligned（绿、沉默）。
 *
 * 取 300ms（3 个 bin）的理由，三条约束叠出来的：
 * - **分辨率下限 100ms**：alignDetect 的 BIN_MS=100，偏移量恒是 100 的整数倍，比它细的门槛
 *   没有意义。
 * - **离散化噪声约 ±100ms**：两侧 cue 都按 floor(start)/ceil(end) 烧 bin，一条真实零偏移的
 *   字幕完全可能测出 ±100ms 的最佳位移（边界取整不对称即可）。1 个 bin 的噪声不该点亮红芯片。
 * - **人眼感知阈约 100~200ms**：低于这个量级的不同步观众根本察觉不到。测出 200ms 时，扣掉
 *   噪声后的真实偏移可能只有 ~150ms，仍在"没人看得出来"的区间——为它报红是在制造一个用户
 *   验证不了的问题。300ms 则确保**扣掉一个 bin 的噪声后仍在感知阈之上**。
 *
 * 为什么宁可保守：红色是系统在主张"这条字幕是坏的"并邀请用户改写自己的文件。误报红的代价
 * （用户不信任判断 + 可能被平移到真的错位）远高于漏报一个 200ms 偏移的代价（他压根看不出来）。
 * 真正碍事的偏移是秒级的（片头广告、不同版本发行），离这条线很远，不会被它挡住。
 */
export const SIGNIFICANT_OFFSET_MS = 300

// 门槛必须是 bin 的整数倍且严格大于 1 个 bin，否则上面第二条论证（"1 个 bin 的噪声不该
// 点亮红芯片"）就是空话。这行在模块加载时执行，改动常量而破坏该性质会立刻炸出来，
// 不会静默退化成一个凭感觉写下的数字。
if (SIGNIFICANT_OFFSET_MS % BIN_MS !== 0 || SIGNIFICANT_OFFSET_MS <= BIN_MS) {
  throw new Error(
    `SIGNIFICANT_OFFSET_MS(${SIGNIFICANT_OFFSET_MS}) 必须是 BIN_MS(${BIN_MS}) 的整数倍且大于一个 bin`,
  )
}

/** 一次检测的完整产物。字段与 subtitle_verify 表一一对应（内部字段一律如实带出，
 *  是否落库/是否上 UI 由消费方决定，本层不预先阉割诊断信息）。 */
export interface VerifyOutcome {
  verdict: SubtitleVerdict
  /** 仅 verdict='shifted' 时非 null——其余档位的偏移量是噪声，带出去会被误用。 */
  offsetMs: number | null
  /** 内部诊断。无参考源时为 null（压根没算过分，不是"算出了 0 分"）。 */
  score: number | null
  referenceTier: string | null
  /** 内部诊断字符串（单行，便于原样塞进结构化痕迹字段）。 */
  detail: string
  /** 内容哈希，落库供日后判"字幕变了需重检"。算不出为 null。 */
  subtitleHash: string | null
}

export interface VerifySubtitleOpts {
  findReference?: (
    videoPath: string,
    subtitlePath: string,
  ) => Promise<ReferenceSource | null>
  loadOurSpans?: (path: string) => Promise<SpeechSpan[] | null>
  detect?: (ref: readonly SpeechSpan[], ours: readonly SpeechSpan[]) => AlignDetectResult
  hashSubtitle?: (path: string) => Promise<string | null>
}

/** 无法验证的统一构造口。**三个内部字段一律清空**（除已知的 tier/hash）：
 *  "没能验证"的行上挂着一个偏移量或分数会自相矛盾，也会诱使 UI 层把它读出来渲染。 */
function unverifiable(detail: string, subtitleHash: string | null, referenceTier: string | null = null): VerifyOutcome {
  return { verdict: 'unverifiable', offsetMs: null, score: null, referenceTier, detail, subtitleHash }
}

/**
 * 检测一条字幕的时间轴，返回三值判读。不写盘、不写库、不 console。
 *
 * @param videoPath 片源路径（参考源 ① 层探测/抽取的对象）
 * @param subtitlePath 待检字幕路径
 */
export async function verifySubtitleAlignment(
  videoPath: string,
  subtitlePath: string,
  opts?: VerifySubtitleOpts,
): Promise<VerifyOutcome> {
  const findReference = opts?.findReference
    ?? ((v: string, s: string) => defaultFindReferenceSource(v, s))
  const loadOurSpans = opts?.loadOurSpans ?? defaultLoadSpans
  const detect = opts?.detect ?? defaultDetectOffset
  const hashSubtitle = opts?.hashSubtitle ?? defaultHashSubtitleContent

  // 哈希与 spans 都源自同一次读取失败的同一个文件，两者一起先算：哈希要落库（哪怕本次判
  // unverifiable，下次也得靠它判断文件有没有变），spans 拿不到就没得比。
  const subtitleHash = await hashSubtitle(subtitlePath)

  // **待检侧先于参考源**，刻意的顺序：自己都解析不出 cue 时，参考源那一层可能要串行 spawn
  // 数条 ffmpeg（最坏数分钟，见 referenceSource.ts 头注释）去换一个注定用不上的答案。
  const ourSpans = await loadOurSpans(subtitlePath)
  if (ourSpans === null || ourSpans.length === 0) {
    return unverifiable('our subtitle unreadable or has no cues', subtitleHash)
  }

  const reference = await findReference(videoPath, subtitlePath)
  // 无参考源 → 诚实判"无法验证"（UI 显示绿色，不是黄色：我们没发现问题，
  // 不等于我们发现了问题）。铁律②：这是最常见的一档，绝不能演化成警告色。
  if (reference === null) {
    return unverifiable('no reference source', subtitleHash)
  }

  const { offsetMs, score } = detect(reference.spans, ourSpans)
  const base = `ref=${reference.tier}: ${reference.detail}`

  // 分数不够 → 无法验证。**刻意不为"灰区"（UNCONFIDENT_THRESHOLD ~ CONFIDENT_THRESHOLD）
  // 单开一档**：0.75 分意味着我们对偏移量本身就没把握，报出来只会得到一个不敢让用户点的
  // 校正按钮。它和"分数极低"对用户是同一件事——我们没能验证——所以合并成同一档，
  // 用 detail 区分供排障。帧率不匹配也自然落在这里（时间轴线性拉伸，任何单一位移都对不齐、
  // 分数必低），不为它单开一档。
  if (score < CONFIDENT_THRESHOLD) {
    return unverifiable(`${base}; score below confident threshold`, subtitleHash, reference.tier)
  }

  // 分数够但偏移不显著 → aligned（绿、沉默）。见 SIGNIFICANT_OFFSET_MS：
  // Math.abs 是必须的，偏早（负）与偏晚（正）同样刺眼。
  if (Math.abs(offsetMs) < SIGNIFICANT_OFFSET_MS) {
    return {
      verdict: 'aligned',
      // 对齐档的 offsetMs 落 null 而非那个 ±100/±200 的残值：它是离散化噪声而非事实，
      // 存进去会让"这行有偏移量"与"这行判 aligned"打架，也给不了排障任何东西。
      offsetMs: null,
      score,
      referenceTier: reference.tier,
      detail: `${base}; aligned within ${SIGNIFICANT_OFFSET_MS}ms`,
      subtitleHash,
    }
  }

  // 分数够且偏移显著 → shifted（红，可校正）。这是唯一带出 offsetMs 的一档，
  // 因为它是唯一会被拿去真的改写用户文件的一档。
  return {
    verdict: 'shifted',
    offsetMs,
    score,
    referenceTier: reference.tier,
    detail: base,
    subtitleHash,
  }
}

/**
 * 检测并落库。已检过且字幕文件没变（哈希一致）时**跳过**，返回 null。
 *
 * @returns 本次检测的产物；null = 跳过（既有结论仍然有效，库里那一行不动）
 *
 * 跳过是硬需求而非优化：参考源 ① 层最坏要串行 spawn 数条 ffmpeg（数分钟量级），
 * 每轮巡检对全库每一集重跑一遍会把这个"顺手校验"变成拖垮巡检的主要成本。
 * 判据完全在 repo.needsRecheck 里（路径 + 内容哈希），本函数不自己发明第二套。
 */
export async function verifyAndRecord(
  repo: SubtitleVerifyRepo,
  itemId: string,
  videoPath: string,
  subtitlePath: string,
  now: number,
  opts?: VerifySubtitleOpts,
): Promise<VerifyOutcome | null> {
  const hashSubtitle = opts?.hashSubtitle ?? defaultHashSubtitleContent
  // 先只算哈希（纯读一个文本文件，恒快）问一句要不要重检——不能先跑完整检测再判断，
  // 那样"跳过"就一点成本也没省下。
  const subtitleHash = await hashSubtitle(subtitlePath)
  if (!repo.needsRecheck(itemId, subtitlePath, subtitleHash)) return null

  // 哈希已算出，复用它避免第二次读盘：注入一个直接返回该值的实现，其余 opts 原样透传。
  const outcome = await verifySubtitleAlignment(videoPath, subtitlePath, {
    ...opts,
    hashSubtitle: async () => subtitleHash,
  })

  repo.upsertVerifyResult({
    itemId,
    verdict: outcome.verdict,
    offsetMs: outcome.offsetMs,
    score: outcome.score,
    referenceTier: outcome.referenceTier,
    subtitlePath,
    subtitleHash: outcome.subtitleHash,
    checkedAt: now,
    detail: outcome.detail,
  })

  return outcome
}
