// 开箱体检:解析已落盘到沙盒的 .srt/.ass,产出结构信号喂给 agent 终审。不合成任何数字——
// 原始值(cue 数/时间轴跨度/检测到的文字体系)原样呈交,agent 像人一样推理,不是打分。
import { readFileSync } from 'node:fs'

export interface InspectSignals {
  decodable: boolean
  isHtml: boolean
  cueCount: number
  firstCueMs: number | null
  lastCueMs: number | null
  spanMs: number | null
  detectedScript: 'zh-Hans' | 'zh-Hant' | 'zh-yue' | 'other' | 'unknown'
  assTitle?: string | null
}

interface Cue { startMs: number; endMs: number; text: string }

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/

function srtTimeToMs(h: string, m: string, s: string, ms: string): number {
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms)
}

function parseSrtCues(text: string): Cue[] {
  const cues: Cue[] = []
  const blocks = text.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const m = SRT_TIME.exec(block)
    if (!m) continue
    const startMs = srtTimeToMs(m[1], m[2], m[3], m[4])
    const endMs = srtTimeToMs(m[5], m[6], m[7], m[8])
    const lines = block.split(/\r?\n/)
    const timeLineIdx = lines.findIndex(l => l.includes('-->'))
    const cueText = lines.slice(timeLineIdx + 1).join(' ').trim()
    cues.push({ startMs, endMs, text: cueText })
  }
  return cues
}

/** 目前只支持 .srt——ASS 解析在 Task 2.2 加入,detectedScript/decodable/isHtml 在
 *  Task 2.3/2.4 加入。这里先给一个占位判定,后续任务会替换。 */
export function inspectSubtitle(stagedPath: string): InspectSignals {
  const text = readFileSync(stagedPath, 'utf8')
  const cues = parseSrtCues(text)
  const firstCueMs = cues.length > 0 ? Math.min(...cues.map(c => c.startMs)) : null
  const lastCueMs = cues.length > 0 ? Math.max(...cues.map(c => c.endMs)) : null
  return {
    decodable: true, isHtml: false, cueCount: cues.length,
    firstCueMs, lastCueMs,
    spanMs: firstCueMs != null && lastCueMs != null ? lastCueMs - firstCueMs : null,
    detectedScript: 'unknown',
  }
}
