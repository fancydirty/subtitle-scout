// 开箱体检:解析已落盘到沙盒的 .srt/.ass,产出结构信号喂给 agent 终审。不合成任何数字——
// 原始值(cue 数/时间轴跨度/检测到的文字体系)原样呈交,agent 像人一样推理,不是打分。
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

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

function isLikelyUndecodable(text: string): boolean {
  if (text.trim().length === 0) return true
  const replacementCount = (text.match(/�/g) ?? []).length
  if (replacementCount > 0 && replacementCount / text.length > 0.01) return true
  // eslint-disable-next-line no-control-regex -- 故意扫描控制字节,这正是"解不出来"的信号
  if (/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 2000))) return true
  return false
}

function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /<title>|<body[ >]/.test(head)
}

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

const ASS_TIME = /^(\d{1,2}):(\d{2}):(\d{2})\.(\d{2})$/

function assTimeToMs(raw: string): number | null {
  const m = ASS_TIME.exec(raw.trim())
  if (!m) return null
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10
}

function parseAssCues(text: string): { cues: Cue[]; title: string | null } {
  const lines = text.split(/\r?\n/)
  const cues: Cue[] = []
  let title: string | null = null
  let inScriptInfo = false
  let inEvents = false
  let textFieldIndex = -1
  for (const raw of lines) {
    const line = raw.trim()
    if (/^\[Script Info\]/i.test(line)) { inScriptInfo = true; inEvents = false; continue }
    if (/^\[Events\]/i.test(line)) { inEvents = true; inScriptInfo = false; continue }
    if (/^\[/.test(line)) { inScriptInfo = false; inEvents = false; continue }
    if (inScriptInfo && /^Title\s*:/i.test(line)) {
      title = line.slice(line.indexOf(':') + 1).trim() || null
      continue
    }
    if (inEvents && /^Format\s*:/i.test(line)) {
      const fields = line.slice(line.indexOf(':') + 1).split(',').map(f => f.trim().toLowerCase())
      textFieldIndex = fields.indexOf('text')
      continue
    }
    if (inEvents && /^Dialogue\s*:/i.test(line)) {
      const rest = line.slice(line.indexOf(':') + 1)
      const fields = rest.split(',')
      // Text 字段允许含逗号:Format 声明的位置往后全部并回去(标准 ASS 惯例)
      const idx = textFieldIndex >= 0 ? textFieldIndex : 9
      if (fields.length <= idx) continue
      const startMs = assTimeToMs(fields[1] ?? '')
      const endMs = assTimeToMs(fields[2] ?? '')
      if (startMs == null || endMs == null) continue
      const cueText = fields.slice(idx).join(',').trim()
      cues.push({ startMs, endMs, text: cueText })
    }
  }
  return { cues, title }
}

/** detectedScript 在 Task 2.4 加入。这里先给一个占位判定,后续任务会替换。 */
export function inspectSubtitle(stagedPath: string): InspectSignals {
  const text = readFileSync(stagedPath, 'utf8')
  const decodable = !isLikelyUndecodable(text)
  const isHtml = looksLikeHtml(text)
  if (!decodable || isHtml) {
    return { decodable, isHtml, cueCount: 0, firstCueMs: null, lastCueMs: null, spanMs: null, detectedScript: 'unknown' }
  }
  const ext = extname(stagedPath).toLowerCase()
  let cues: Cue[]
  let assTitle: string | null | undefined
  if (ext === '.ass' || ext === '.ssa') {
    const parsed = parseAssCues(text)
    cues = parsed.cues
    assTitle = parsed.title
  } else {
    cues = parseSrtCues(text)
  }
  const firstCueMs = cues.length > 0 ? Math.min(...cues.map(c => c.startMs)) : null
  const lastCueMs = cues.length > 0 ? Math.max(...cues.map(c => c.endMs)) : null
  return {
    decodable, isHtml, cueCount: cues.length,
    firstCueMs, lastCueMs,
    spanMs: firstCueMs != null && lastCueMs != null ? lastCueMs - firstCueMs : null,
    detectedScript: 'unknown',
    ...(assTitle !== undefined ? { assTitle } : {}),
  }
}
