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

/** 单个字幕文件的最大可信时长——超出即视为损坏/恶意输入，该 cue 被跳过。
 *
 *  依据：最长商业电影约 5 小时（《浩劫》566 分钟），留足余量取 12 小时。
 *
 *  为什么必须有这道闸（两个后果都实测过）：
 *  - SRT 时间戳格式**合法**接受 `99:59:59,999` = 359,999,999ms = 360 万 bins。
 *    实测跑一遍 ±60s 互相关阻塞事件循环 **6.5 秒**——Node 单线程，这几秒整个服务
 *    不响应任何请求。而触发它只需一个 **2KB 文件**：文件大小闸
 *    （subtitleInspect 的 MAX_INSPECT_BYTES = 16MB）对此完全无效，文件很小，
 *    只是时间戳很大。
 *  - 更极端的值（`endMs = 1e15`，仍是有限数、能通过 isFinite 检查）要求分配 10TB，
 *    实测 V8 直接 abort（`Check failed: change_in_bytes < kMaxReasonableBytes`），
 *    **不是可捕获的 RangeError**：进程当场死亡，try/catch 抓不住，绕过所有 finally
 *    （正是 f38f88b 修的"DB 迁移连接句柄泄露"那类场景会被重新打开）。
 *
 *  刻意**跳过**而非钳位到上界：钳位会把一条坏 cue 的影响抹到整条时间轴末尾，
 *  凭空造出几小时的"有人说话"，静默污染分数；跳过则是如实丢弃不可信的一条。 */
export const MAX_TIMELINE_MS = 12 * 60 * 60 * 1000

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
 * 一条 cue 是否可用于对齐。**唯一的合法性判据**——toSpeechBins 与 requiredBinCount
 * 必须共用它，否则"算长度时认得的 cue"与"烧 bin 时认得的 cue"不一致，会烧出越界写入
 * （静默被 Uint8Array 丢弃）或凭空多出的空白尾巴。
 *
 * 字幕文件是外部输入，手写/工具生成的垃圾条目很常见，为一条坏 cue 让整次检测抛错不值得，
 * 故一律静默跳过而非报错。四类被拒：
 * - 非有限数（NaN/Infinity）：算不出 bin 下标
 * - end <= start：零长或倒挂，没有时段可言
 * - 负时间：SRT/ASS 格式都无法合法表达负时间戳，出现即为损坏。**跳过而非钳到 0**——
 *   钳位会把这条 cue 的时段抹到时间轴开头，在 bin 0 附近凭空造出"有人说话"而污染分数
 *   （实测：给一条 -3000→500 的 cue，分数从 1.0 掉到 0.8）。
 * - 超过 MAX_TIMELINE_MS：见该常量注释（性能与进程存活）
 */
function isUsableSpan(span: SpeechSpan): boolean {
  const { startMs, endMs } = span
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false
  if (endMs <= startMs) return false
  if (startMs < 0) return false
  if (endMs > MAX_TIMELINE_MS) return false
  return true
}

/**
 * 把 cue 序列烧成布尔占位序列：覆盖到的 bin 置 1。
 *
 * start 向下取整、end 向上取整（宁可把边界 bin 算作"有人说话"）：
 * 两边用同一套取整规则，系统性偏差会互相抵消，而向内取整则会在短 cue 上
 * 直接丢掉整条（时长 < 100ms 的 cue 会烧不出任何 bin）。
 *
 * 不合法的 cue 静默跳过，判据见 isUsableSpan。
 */
function toSpeechBins(spans: readonly SpeechSpan[], binCount: number): Uint8Array {
  const bins = new Uint8Array(binCount)
  for (const span of spans) {
    if (!isUsableSpan(span)) continue
    const from = Math.max(0, Math.floor(span.startMs / BIN_MS))
    const to = Math.min(binCount, Math.ceil(span.endMs / BIN_MS))
    for (let i = from; i < to; i++) bins[i] = 1
  }
  return bins
}

/** 序列需要多少个 bin 才装得下（跳过不合法 cue，与 toSpeechBins 共用 isUsableSpan）。
 *  返回值直接当 Uint8Array 长度用，所以上界由 isUsableSpan 的 MAX_TIMELINE_MS 保证。 */
function requiredBinCount(spans: readonly SpeechSpan[]): number {
  let maxEndMs = 0
  for (const span of spans) {
    if (!isUsableSpan(span)) continue
    if (span.endMs > maxEndMs) maxEndMs = span.endMs
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
    // 并列时保留**绝对值更小**的位移：证据一样强时，更小的校正是更保守的主张
    // （断言"字幕晚了 2 秒"比断言"晚了 60 秒"需要更少的额外假设）。
    //
    // 不能只用 `score > bestScore` 靠扫描顺序定平手：shift 从 -maxShiftBins 向正扫，
    // 那样平手时留下的是**最负**的位移（实测会得 -5000 而非 +2000 这样更小的候选），
    // 与上述意图相反。故平手时显式比 |shift|。
    // |shift| 也相同时（如 -5000 vs +5000）保留先到的负位移，纯为确定性——
    // 两个方向的证据完全对称，无从取舍，但结果必须可复现。
    if (score > bestScore
      || (score === bestScore && Math.abs(shift) < Math.abs(bestShiftBins))) {
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
