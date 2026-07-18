// 开箱体检:解析已落盘到沙盒的 .srt/.ass,产出结构信号喂给 agent 终审。不合成任何数字——
// 原始值(cue 数/时间轴跨度/检测到的文字体系)原样呈交,agent 像人一样推理,不是打分。
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { createHash } from 'node:crypto'
import { decodeToUtf8 } from './subtitleEncoding.js'

export interface InspectSignals {
  decodable: boolean
  isHtml: boolean
  cueCount: number
  firstCueMs: number | null
  lastCueMs: number | null
  spanMs: number | null
  detectedScript: 'zh-Hans' | 'zh-Hant' | 'zh-yue' | 'other' | 'unknown'
  assTitle?: string | null
  assHeaderComment?: string
}

// 真实字幕文件几毫字节量级；超出即视为垃圾（损坏下载/伪装成字幕的大文件），
// 在 statSync 阶段就 fail closed，绝不把整个文件读进内存。
const MAX_INSPECT_BYTES = 16 * 1024 * 1024

// 超限时诚实上报的失败形状——后续步骤据此不经 LLM 直接拒绝。
const OVERSIZE_SIGNALS: InspectSignals = {
  decodable: false, isHtml: false, cueCount: 0,
  firstCueMs: null, lastCueMs: null, spanMs: null, detectedScript: 'unknown',
}

// prompt 喂给 agent 的自由文本字段（片名/字幕组头注释）截断上限：防止畸形/恶意文件
// 塞进几 MB 的"Title"把 prompt 撑爆，也顺手掐掉可能的 prompt injection 载荷。
const MAX_SIGNAL_TEXT_LEN = 200

function truncateSignalText(s: string): string {
  return s.length > MAX_SIGNAL_TEXT_LEN ? s.slice(0, MAX_SIGNAL_TEXT_LEN) : s
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

function parseAssCues(text: string): { cues: Cue[]; title: string | null; headerComment: string | null } {
  const lines = text.split(/\r?\n/)
  const cues: Cue[] = []
  let title: string | null = null
  const headerCommentLines: string[] = []
  let inScriptInfo = false
  let inEvents = false
  let textFieldIndex = -1
  for (const raw of lines) {
    const line = raw.trim()
    if (/^\[Script Info\]/i.test(line)) { inScriptInfo = true; inEvents = false; continue }
    if (/^\[Events\]/i.test(line)) { inEvents = true; inScriptInfo = false; continue }
    if (/^\[/.test(line)) { inScriptInfo = false; inEvents = false; continue }
    // 字幕组的自我署名/免责声明常以 `;` 注释行或 Comment: 字段藏在 [Script Info] 里
    // （design L45 的"字幕组头注释原文"信号）——原文收下，交给 agent 判断，不做语义解析。
    if (inScriptInfo && (line.startsWith(';') || /^Comment\s*:/i.test(line))) {
      if (line.length > 0) headerCommentLines.push(line)
      continue
    }
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
  const headerComment = headerCommentLines.length > 0
    ? truncateSignalText(headerCommentLines.join(' '))
    : null
  return { cues, title: title != null ? truncateSignalText(title) : title, headerComment }
}

const SIMPLIFIED_ONLY = new Set('国说来时会为学过对现关开东车门问儿无与从这样后应变电动经济单卫华叶')
const TRADITIONAL_ONLY = new Set('國說來時會為學過對現關開東車門問兒無與從這樣後應變電動經濟單衛華葉')
const CANTONESE_MARKERS = new Set('嘅嘢喺咁佢哋唔冇啦喎')

function stripTags(s: string): string {
  return s.replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '')
}

/** W1（装机记账修复批·跨集内容近似去重闸,2026-07-18,DxD S3E11/S3E12 案根因修复）：给
 *  install_subtitle 装机前置校验用的规范化对白指纹——不看扩展名(输入只是已解码的文本),先按
 *  SRT 解析;解出 0 条 cue 时按 ASS 解析(两者共用的 parseSrtCues/parseAssCues 已经把时间戳从
 *  cue.text 里剔除,只需再剥一层样式标签(stripTags:ASS 的 {\...} override 标签 / SRT 的
 *  <...> HTML 风格标签)和空白(折叠连续空白+首尾 trim)),把每条对白按原顺序 join('\n') 后取
 *  sha1。目的是给"同一集内容被贴了两个集号标签"的装机开一道精确去重闸——DxD 案两个 assrt 条目
 *  装出的内容逐句相同,仅时轴偏移 1 秒,时间戳剥离后即可命中完全一致的 hash。故意不做模糊相似度
 *  匹配(YAGNI,见设计正文)：这只堵"时间戳偏移但对白逐句相同"这一种形态,不追求近似匹配任意
 *  程度的相似字幕。 */
export function subtitleDialogueFingerprint(text: string): string {
  const srtCues = parseSrtCues(text)
  const cues = srtCues.length > 0 ? srtCues : parseAssCues(text).cues
  const dialogueLines = cues
    .map((c) => stripTags(c.text).replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
  return createHash('sha1').update(dialogueLines.join('\n')).digest('hex')
}

/** 语言/简繁判定:采样多条 cue 拼接后判——单行简繁不可靠(design 明文要求)。是信号,
 *  不是硬门槛:字数不够或简繁字都没出现时诚实报 unknown,让 agent 自己看正文判断。 */
export function detectScript(cues: Cue[]): InspectSignals['detectedScript'] {
  const sample = cues.slice(0, 50).map(c => stripTags(c.text)).join('')
  const hanChars = [...sample].filter(ch => /\p{Script=Han}/u.test(ch))
  if (hanChars.length < 10) return hanChars.length === 0 ? 'other' : 'unknown'
  let simp = 0, trad = 0, yue = 0
  for (const ch of hanChars) {
    if (SIMPLIFIED_ONLY.has(ch)) simp++
    if (TRADITIONAL_ONLY.has(ch)) trad++
    if (CANTONESE_MARKERS.has(ch)) yue++
  }
  if (yue >= 3) return 'zh-yue'
  if (simp === 0 && trad === 0) return 'unknown'
  return simp >= trad ? 'zh-Hans' : 'zh-Hant'
}

export function inspectSubtitle(stagedPath: string): InspectSignals {
  // 大小护栏必须在读之前:多 GB 的垃圾/伪装文件会把整个文件读进一个字符串——
  // 小的把内存占满,大的(>512MB)直接 ERR_STRING_TOO_LONG 崩掉整个守护进程。
  if (statSync(stagedPath).size > MAX_INSPECT_BYTES) {
    return { ...OVERSIZE_SIGNALS }
  }
  const raw = readFileSync(stagedPath)
  // 与 subtitleWriter.ts 落盘时同一套 chardet+iconv 探测路径:ASSRT 等来源常见 GBK/GB18030,
  // 朴素按 utf-8 解码会把合法中文变成乱码,体检误报 decodable:false。
  const text = decodeToUtf8(raw).data.toString('utf8')
  const decodable = !isLikelyUndecodable(text)
  const isHtml = looksLikeHtml(text)
  if (!decodable || isHtml) {
    return { decodable, isHtml, cueCount: 0, firstCueMs: null, lastCueMs: null, spanMs: null, detectedScript: 'unknown' }
  }
  const ext = extname(stagedPath).toLowerCase()
  let cues: Cue[]
  let assTitle: string | null | undefined
  let assHeaderComment: string | undefined
  if (ext === '.ass' || ext === '.ssa') {
    const parsed = parseAssCues(text)
    cues = parsed.cues
    assTitle = parsed.title
    assHeaderComment = parsed.headerComment ?? undefined
  } else {
    cues = parseSrtCues(text)
  }
  // 单次遍历取 lo/hi,而不是 Math.min(...cues.map(...))——展开一个 ~13 万+元素的数组当
  // 参数列表会在 V8 上撞 RangeError(Maximum call stack size exceeded),字幕组合集/长剧
  // 全季合并的 cue 数轻松过这个坎。
  let firstCueMs: number | null = null
  let lastCueMs: number | null = null
  for (const c of cues) {
    if (firstCueMs === null || c.startMs < firstCueMs) firstCueMs = c.startMs
    if (lastCueMs === null || c.endMs > lastCueMs) lastCueMs = c.endMs
  }
  return {
    decodable, isHtml, cueCount: cues.length,
    firstCueMs, lastCueMs,
    spanMs: firstCueMs != null && lastCueMs != null ? lastCueMs - firstCueMs : null,
    detectedScript: detectScript(cues),
    ...(assTitle !== undefined ? { assTitle } : {}),
    ...(assHeaderComment !== undefined ? { assHeaderComment } : {}),
  }
}
