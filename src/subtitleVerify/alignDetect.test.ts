import { describe, it, expect } from 'vitest'
import {
  detectOffset,
  BIN_MS,
  MAX_SHIFT_MS,
  CONFIDENT_THRESHOLD,
  UNCONFIDENT_THRESHOLD,
  type SpeechSpan,
} from './alignDetect.js'

/** 确定性伪随机 cue 生成器（LCG，同 seed 必出同序列）——测试必须可复现，
 *  Math.random() 会让"分数 < 0.7"这类断言变成偶发失败。file-local helper，
 *  不导出到生产代码（沿用本代码库 per-file small-helper 惯例）。 */
function mkCues(n: number, seed: number, startAt = 9000): SpeechSpan[] {
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const out: SpeechSpan[] = []
  let t = startAt
  for (let i = 0; i < n; i++) {
    const d = 1200 + Math.floor(rnd() * 2500)
    out.push({ startMs: t, endMs: t + d })
    t += d + 400 + Math.floor(rnd() * 1800)
  }
  return out
}

/** 整体平移（模拟"字幕比片源晚/早 N 毫秒"）。 */
function shiftedBy(spans: SpeechSpan[], deltaMs: number): SpeechSpan[] {
  return spans.map(s => ({ startMs: s.startMs + deltaMs, endMs: s.endMs + deltaMs }))
}

/** 按比例缩放时间轴（模拟帧率不匹配：23.976 → 25 fps 会让整轨越走越偏）。 */
function scaledBy(spans: SpeechSpan[], factor: number): SpeechSpan[] {
  return spans.map(s => ({
    startMs: Math.round(s.startMs * factor),
    endMs: Math.round(s.endMs * factor),
  }))
}

describe('alignDetect 常量', () => {
  it('bin 步长与搜索窗口是常量，不是散落的魔数', () => {
    expect(BIN_MS).toBe(100)
    expect(MAX_SHIFT_MS).toBe(60_000)
  })

  it('可信/不可信阈值按规格导出，供上层 API 复用同一份定义', () => {
    expect(CONFIDENT_THRESHOLD).toBe(0.9)
    expect(UNCONFIDENT_THRESHOLD).toBe(0.7)
    expect(CONFIDENT_THRESHOLD).toBeGreaterThan(UNCONFIDENT_THRESHOLD)
  })
})

describe('detectOffset：PoC 已验证的四场景', () => {
  it('场景 1｜整体晚 8.3s → 精确检出 +8300ms，高分可校正', () => {
    const ref = mkCues(120, 42)
    const ours = shiftedBy(ref, 8300)

    const { offsetMs, score } = detectOffset(ref, ours)

    expect(offsetMs).toBe(8300)
    expect(score).toBeGreaterThanOrEqual(CONFIDENT_THRESHOLD)
  })

  it('场景 2｜完美对齐 → 0ms，满分（绿色沉默，不打扰用户）', () => {
    const ref = mkCues(120, 42)

    const { offsetMs, score } = detectOffset(ref, ref)

    expect(offsetMs).toBe(0)
    expect(score).toBeGreaterThanOrEqual(0.99)
  })

  it('场景 3｜完全无关的字幕 → 低分，不敢报（判"无法验证"）', () => {
    const ref = mkCues(120, 42)
    const unrelated = mkCues(120, 7777, 3000)

    const { score } = detectOffset(ref, unrelated)

    // offsetMs 是噪声（PoC 记录为"乱数"），断言它等于锁死噪声——只验分数。
    expect(score).toBeLessThan(UNCONFIDENT_THRESHOLD)
  })

  it('场景 4｜帧率不匹配 23.976/25 → 低分，平移修不好，不给校正按钮', () => {
    const ref = mkCues(200, 42)
    const ours = scaledBy(ref, 25 / 23.976)

    const { score } = detectOffset(ref, ours)

    expect(score).toBeLessThan(UNCONFIDENT_THRESHOLD)
  })
})

describe('detectOffset：偏移方向语义', () => {
  it('正数 = 我们的字幕比参考「晚」（需减掉该值来对齐）', () => {
    const ref = mkCues(60, 11)
    const late = shiftedBy(ref, 4200)

    const { offsetMs } = detectOffset(ref, late)

    expect(offsetMs).toBe(4200)
    // 减掉检出的偏移应当回到完美对齐，这是"正数=晚"定义的可执行检验。
    const corrected = shiftedBy(late, -offsetMs)
    expect(detectOffset(ref, corrected).offsetMs).toBe(0)
  })

  it('负数 = 我们的字幕比参考「早」', () => {
    const ref = mkCues(60, 11)
    const early = shiftedBy(ref, -3500)

    const { offsetMs, score } = detectOffset(ref, early)

    expect(offsetMs).toBe(-3500)
    expect(score).toBeGreaterThanOrEqual(CONFIDENT_THRESHOLD)
  })

  it('偏移量永远落在 ±MAX_SHIFT_MS 搜索窗口内', () => {
    const ref = mkCues(80, 5)
    // 远超窗口的平移（5 分钟）无法被检出——只要求不越界且不误报高分。
    const wayOff = shiftedBy(ref, 300_000)

    const { offsetMs, score } = detectOffset(ref, wayOff)

    expect(Math.abs(offsetMs)).toBeLessThanOrEqual(MAX_SHIFT_MS)
    expect(score).toBeLessThan(UNCONFIDENT_THRESHOLD)
  })
})

describe('detectOffset：边界情况', () => {
  it('两边都空 → 0ms / 0 分（没有证据即无可信度，绝不返回满分）', () => {
    expect(detectOffset([], [])).toEqual({ offsetMs: 0, score: 0 })
  })

  it('参考为空 → 0 分（无从比对）', () => {
    expect(detectOffset([], mkCues(30, 3))).toEqual({ offsetMs: 0, score: 0 })
  })

  it('待检为空 → 0 分（无从比对）', () => {
    expect(detectOffset(mkCues(30, 3), [])).toEqual({ offsetMs: 0, score: 0 })
  })

  it('单条 cue 且对齐 → 满分不崩', () => {
    const one: SpeechSpan[] = [{ startMs: 5000, endMs: 8000 }]

    const { offsetMs, score } = detectOffset(one, one)

    expect(offsetMs).toBe(0)
    expect(score).toBeGreaterThanOrEqual(0.99)
  })

  it('单条 cue 且平移 → 检出该平移', () => {
    const one: SpeechSpan[] = [{ startMs: 5000, endMs: 8000 }]

    expect(detectOffset(one, shiftedBy(one, 2000)).offsetMs).toBe(2000)
  })

  it('参考只覆盖开头一小段、待检覆盖全片 → 偏移仍准，但分数按覆盖比例衰减', () => {
    // 该 200 cue 轨总长约 12.5 分钟；只留前 2 分钟作参考（约 15% 的说话时长）。
    const full = mkCues(200, 42)
    const partialRef = full.filter(s => s.endMs <= 120_000)
    expect(partialRef.length).toBeGreaterThan(0)
    expect(partialRef.length).toBeLessThan(full.length)

    const { offsetMs, score } = detectOffset(partialRef, full)

    // 重叠的那一段本身是完全对齐的，位移必须仍取 0——不能因为覆盖少就漂走。
    expect(offsetMs).toBe(0)
    // 但只有 ~15% 的时长有参考佐证，Jaccard 如实把未覆盖部分计入分母 → 不可信。
    // 这正是不用"交集/min"的意义：那样会因参考轨短而虚高到满分。
    expect(score).toBeLessThan(UNCONFIDENT_THRESHOLD)
  })

  it('分数随参考覆盖度单调上升（分数可解读为"有佐证的时长占比"）', () => {
    const full = mkCues(200, 42)
    const scoreAtCut = (cutMs: number) =>
      detectOffset(full.filter(s => s.endMs <= cutMs), full).score

    const scores = [120_000, 300_000, 600_000].map(scoreAtCut)

    expect(scores[0]).toBeLessThan(scores[1])
    expect(scores[1]).toBeLessThan(scores[2])
    // 全覆盖才配拿满分。
    expect(detectOffset(full, full).score).toBeGreaterThan(scores[2])
  })

  it('零长/倒挂 cue 被忽略，不污染打分也不崩', () => {
    const ref = mkCues(60, 11)
    const withJunk: SpeechSpan[] = [
      ...ref,
      { startMs: 1000, endMs: 1000 },
      { startMs: 9000, endMs: 4000 },
    ]

    const { offsetMs, score } = detectOffset(ref, withJunk)

    expect(offsetMs).toBe(0)
    expect(score).toBeGreaterThanOrEqual(CONFIDENT_THRESHOLD)
  })

  it('纯函数：不改动入参数组或其中的对象', () => {
    const ref = mkCues(20, 1)
    const ours = shiftedBy(ref, 1500)
    const refCopy = structuredClone(ref)
    const oursCopy = structuredClone(ours)

    detectOffset(ref, ours)

    expect(ref).toEqual(refCopy)
    expect(ours).toEqual(oursCopy)
  })

  it('相同输入必得相同输出（确定性，无隐藏状态）', () => {
    const ref = mkCues(50, 9)
    const ours = shiftedBy(ref, -2100)

    expect(detectOffset(ref, ours)).toEqual(detectOffset(ref, ours))
  })

  it('分数恒在 [0, 1] 区间（Jaccard 定义域）', () => {
    const cases: Array<[SpeechSpan[], SpeechSpan[]]> = [
      [mkCues(40, 1), mkCues(40, 2)],
      [mkCues(40, 1), shiftedBy(mkCues(40, 1), 12_000)],
      [mkCues(5, 3), mkCues(90, 4)],
    ]
    for (const [ref, ours] of cases) {
      const { score } = detectOffset(ref, ours)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})
