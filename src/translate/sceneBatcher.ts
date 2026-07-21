// E AI 翻译 · 场景分批。北极星理由(E 设计):逐行翻译=灾难(丢上下文),整集一次过=陷阱
// (长上下文迷失中段、一次坏响应毁整档无恢复粒度)。折中=按场景分批串行翻译、每批带滚动记忆。
// 本模块只做纯粹的"切分":连续对白(时轴间隔≤阈值)归一批;间隔>阈值(场景切换)起新批;批达
// 上限(防长上下文)即使无间隔也切。纯函数,零副作用,顺序无丢无重。
import type { SrtCue } from './qualityGate.js'

const TIMING = /(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d\d\d)/

function parseTiming(timing: string): { startMs: number; endMs: number } | null {
  const m = timing.match(TIMING)
  if (!m) return null
  const startMs = +m[1] * 3600000 + +m[2] * 60000 + +m[3] * 1000 + +m[4]
  const endMs = +m[5] * 3600000 + +m[6] * 60000 + +m[7] * 1000 + +m[8]
  return { startMs, endMs }
}

/**
 * 把 cue 序列切成场景批。gapSec:相邻 cue 间隔(下一条 start − 上一条 end)超过它就切新批(默认 2s)。
 * maxBatch:单批最多几条,达到就切(默认 40)。时轴解析不出的 cue 不触发间隔切分(降级为只受
 * maxBatch 约束),绝不因一条畸形时轴中断分批或丢 cue。
 */
export function batchIntoScenes(
  cues: SrtCue[],
  opts?: { gapSec?: number; maxBatch?: number },
): SrtCue[][] {
  const gapMs = (opts?.gapSec ?? 2) * 1000
  const maxBatch = opts?.maxBatch ?? 40
  const batches: SrtCue[][] = []
  let cur: SrtCue[] = []
  let prevEnd: number | null = null

  for (const c of cues) {
    if (cur.length > 0) {
      const parsed = parseTiming(c.timing)
      const gapExceeded = prevEnd !== null && parsed !== null && parsed.startMs - prevEnd > gapMs
      const full = cur.length >= maxBatch
      if (gapExceeded || full) {
        batches.push(cur)
        cur = []
      }
    }
    cur.push(c)
    const parsed = parseTiming(c.timing)
    if (parsed !== null) prevEnd = parsed.endMs // 畸形时轴保留上一条 end,不污染间隔判断
  }
  if (cur.length > 0) batches.push(cur)
  return batches
}
