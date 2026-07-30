/**
 * 字幕时间轴对齐检测——纯函数，零副作用，零外部依赖。
 *
 * 做法：把参考源与待检字幕各自离散成 100ms 步长的"此刻有人说话"布尔序列，
 * 在 ±60s 窗口内逐 bin 滑动，用 Jaccard（交集/并集）打分，取最高分的位移作为偏移量。
 *
 * 为什么是 Jaccard 而不是"交集/min(两边)"：后者在一方 cue 密集时会虚高——
 * 密集轨几乎处处为 1，稀疏轨的每个 1 都能蹭到重叠，min 又拿稀疏轨当分母，
 * 于是毫不相干的两轨也能刷到 0.9+ 而被误判"可校正"。Jaccard 把"对不上的部分"
 * 也计入分母，密集/稀疏失配会被如实惩罚。（PoC 实测过这个坑。）
 *
 * 本模块只做"检测"，不做"校正"，也不下"可信/不可信"的结论——
 * 阈值常量在此导出供上层判读，避免各处各写一份阈值。
 */

/** 离散化步长。100ms 足够分辨字幕对齐误差（人耳对 <100ms 的音画不同步基本无感），
 *  又把 ±60s 窗口的搜索规模压到千级位移，纯 JS 也能瞬时算完。 */
export const BIN_MS = 100

/** 单向最大搜索位移。±60s 覆盖常见成因（片头广告、不同版本发行、缺失 intro）；
 *  再放大只会增加"在噪声里捞到高分"的误报机会，收益递减。 */
export const MAX_SHIFT_MS = 60_000

/** ≥ 此分数视为可信：偏移量可以拿去校正。 */
export const CONFIDENT_THRESHOLD = 0.9

/** < 此分数视为不可信：不报偏移，判"无法验证"，也不给校正按钮。
 *  两阈值之间是灰区，由上层决定如何呈现（本模块不表态）。 */
export const UNCONFIDENT_THRESHOLD = 0.7

/**
 * 对齐检测所需的最小 cue 形状——只要说话时段，不要文本内容
 * （对齐只看"何时有人说话"，跨语言字幕文本天然对不上，看文本毫无意义）。
 *
 * 字段名 startMs/endMs 与 src/files/subtitleInspect.ts 的 Cue 保持一致，
 * 因此那边解析出的 `Cue[]`（含 text）可直接当 `SpeechSpan[]` 传进来。
 */
export interface SpeechSpan {
  startMs: number
  endMs: number
}

export interface AlignDetectResult {
  /** 正数 = 待检字幕比参考「晚」这么多毫秒（校正时需减掉此值）；负数 = 偏早。 */
  offsetMs: number
  /** 最佳位移处的 Jaccard 重叠度，[0, 1]。越高越可信。 */
  score: number
}

/** 无从比对时的返回值：偏移 0 且分数 0。
 *  分数 0 而非 1 是刻意的——空输入是"没有证据"，不是"完美吻合"；
 *  若返回高分，上层会把空字幕当成已对齐而放行。 */
const NO_EVIDENCE: AlignDetectResult = { offsetMs: 0, score: 0 }

/**
 * 把 cue 序列烧成布尔占位序列：覆盖到的 bin 置 1。
 *
 * start 向下取整、end 向上取整（宁可把边界 bin 算作"有人说话"）：
 * 两边用同一套取整规则，系统性偏差会互相抵消，而向内取整则会在短 cue 上
 * 直接丢掉整条（时长 < 100ms 的 cue 会烧不出任何 bin）。
 *
 * 非法 cue（end <= start、负时间、非有限数）静默跳过——字幕文件是外部输入，
 * 手写/工具生成的垃圾条目很常见，为一条坏 cue 让整次检测抛错不值得。
 */
function toSpeechBins(spans: readonly SpeechSpan[], binCount: number): Uint8Array {
  const bins = new Uint8Array(binCount)
  for (const span of spans) {
    const { startMs, endMs } = span
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
    if (endMs <= startMs) continue
    const from = Math.max(0, Math.floor(startMs / BIN_MS))
    const to = Math.min(binCount, Math.ceil(endMs / BIN_MS))
    for (let i = from; i < to; i++) bins[i] = 1
  }
  return bins
}

/** 序列需要多少个 bin 才装得下（忽略非法 cue，与 toSpeechBins 的判定保持一致）。 */
function requiredBinCount(spans: readonly SpeechSpan[]): number {
  let maxEndMs = 0
  for (const { startMs, endMs } of spans) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue
    if (endMs <= startMs) continue
    if (endMs > maxEndMs) maxEndMs = endMs
  }
  return Math.ceil(maxEndMs / BIN_MS)
}

/** 该序列是否存在任何"有人说话"的 bin。全 0 等同于没有证据。 */
function hasSpeech(bins: Uint8Array): boolean {
  return bins.includes(1)
}

/**
 * 在 ±maxShiftBins 内滑动，返回 Jaccard 最高的位移。
 *
 * 扫描区间刻意向两侧各外扩 maxShiftBins：只在 ourBins 的下标范围内累加的话，
 * 位移会把一部分 refBins 推出扫描窗口，那些"对不上的参考 bin"就漏出了并集分母，
 * 使分数虚高——正是 Jaccard 想避免的问题。外扩后每个 bin 在任意位移下都被计入。
 */
function findBestShift(
  refBins: Uint8Array,
  ourBins: Uint8Array,
  maxShiftBins: number,
): { shiftBins: number; score: number } {
  const scanFrom = -maxShiftBins
  const scanTo = Math.max(ourBins.length, refBins.length) + maxShiftBins

  let bestShiftBins = 0
  let bestScore = -1

  for (let shift = -maxShiftBins; shift <= maxShiftBins; shift++) {
    let intersection = 0
    let union = 0
    for (let i = scanFrom; i < scanTo; i++) {
      const ourSpeech = i >= 0 && i < ourBins.length ? ourBins[i] : 0
      const j = i - shift
      const refSpeech = j >= 0 && j < refBins.length ? refBins[j] : 0
      if (ourSpeech & refSpeech) intersection++
      if (ourSpeech | refSpeech) union++
    }
    const score = union === 0 ? 0 : intersection / union
    // 严格大于：并列时保留绝对值更小的位移（shift 从负向正扫，先到的更接近 0 侧不会被平手挤掉）。
    if (score > bestScore) {
      bestScore = score
      bestShiftBins = shift
    }
  }

  return { shiftBins: bestShiftBins, score: bestScore }
}

/**
 * 检测待检字幕相对参考源的时间轴偏移。
 *
 * @param refCues 参考源的说话时段（可信基准，通常来自片源音轨或已验证字幕）
 * @param ourCues 待检字幕的说话时段
 * @returns offsetMs（正数 = 我们偏晚，校正需减掉）与 score（[0,1] 可信度）
 *
 * 分数低于 UNCONFIDENT_THRESHOLD 时 offsetMs 是噪声，不要用它做校正。
 */
export function detectOffset(
  refCues: readonly SpeechSpan[],
  ourCues: readonly SpeechSpan[],
): AlignDetectResult {
  const binCount = Math.max(requiredBinCount(refCues), requiredBinCount(ourCues))
  if (binCount === 0) return NO_EVIDENCE

  const refBins = toSpeechBins(refCues, binCount)
  const ourBins = toSpeechBins(ourCues, binCount)
  // 任一方全无说话时段 → 交集恒为 0，滑动只会在噪声里挑位移；直接判无证据。
  if (!hasSpeech(refBins) || !hasSpeech(ourBins)) return NO_EVIDENCE

  const { shiftBins, score } = findBestShift(refBins, ourBins, Math.floor(MAX_SHIFT_MS / BIN_MS))

  return { offsetMs: shiftBins * BIN_MS, score }
}
