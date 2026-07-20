// E AI 翻译 · fail-closed 质量闸(确定性层)。北极星:错译比留缺口更糟——好译放行、坏译拦下,
// 拦下时最坏结局是"留英文 + 标记",绝不静默装错译。本模块只做**确定性**三层(结构 / 术语符合 /
// CJK 约束);LLM-judge(MQM 分型)与回译抽查是第 3/4 层,由 translateWorker 的 critic 角色承担,
// 不在此纯函数里(此处零网络零 LLM,可脱机单测)。
//
// 原型验证(2026-07-20 夜,The Rig S2E01 前 200 cue):强模型译文(术语表先行+分批带记忆)
// 术语符合率 100% → PASS;弱模型裸译(Pictor→"皮克特" 漂移)69.8% → FAIL。确定性层单独即足以
// 判别好坏译,是 fail-closed 的第一道也是最硬的一道闸。

/** EN→ZH 专名记录的一条(角色名/地名/世界观术语/敬称)。译文里该专名必须处处用同一 zh 形。 */
export interface GlossaryTerm {
  en: string
  zh: string
  note?: string
}

/** 解析后的单条字幕。text 是去掉序号行/时轴行后的正文行数组(保留原样,含内联标签)。 */
export interface SrtCue {
  index: string
  timing: string
  text: string[]
}

/** 单条术语违规:该专名在源文本出现、但对齐的候选译文里没有其 canonical zh 形的所有 cue 序号。 */
export interface TermViolation {
  term: string
  expectZh: string
  missAtCues: number[]
}

export interface GateResult {
  verdict: 'pass' | 'fail'
  cueCount: { source: number; candidate: number }
  structural: { indexMismatch: number; timingMismatch: number; tagMismatch: number }
  cjk: { overLongLines: number; overCpsCues: number }
  glossary: { checks: number; hits: number; conformance: number; violations: TermViolation[] }
  /** 任一非空 → verdict='fail'(fail-closed)。 */
  hardViolations: string[]
  /** 记录但不必然否决(CPS/行长这类可读性告警);由调用方决定是否触发精修。 */
  softWarnings: string[]
}

export interface GateOptions {
  /** 术语符合率低于此值判硬违规。默认 0.85(原型:强 1.00 过、弱 0.698 拦)。 */
  minTermConformance?: number
  /** 单行全角字符数上限(超出记 soft 告警)。默认 20。 */
  maxLineFullWidth?: number
  /** 阅读速度(全角字/秒)上限(超出记 soft 告警)。默认 12。 */
  maxCps?: number
}

const DEFAULTS: Required<GateOptions> = { minTermConformance: 0.85, maxLineFullWidth: 20, maxCps: 12 }

// CJK/全角区间:CJK 统一表意文字 + 全角标点/字母。全角计 1,其余(拉丁/半角)计 0.5——粗略视觉宽度。
const FULLWIDTH = /[　-〿㐀-鿿＀-￯豈-﫿]/
const TAG = /<[^>]+>/g

/** 把 SRT 文本解析成 cue 数组。以空行分块,首行=序号,含 `-->` 的行=时轴,其余=正文行。
 *  不含 `-->` 的块(残缺/头注释)跳过。对 \r\n 与多空行分隔都鲁棒。 */
export function parseSrtCues(text: string): SrtCue[] {
  const blocks = text.replace(/\r/g, '').split(/\n\n+/).map((b) => b.trim()).filter(Boolean)
  const cues: SrtCue[] = []
  for (const b of blocks) {
    const lines = b.split('\n')
    const timing = (lines[1] ?? '').trim()
    if (!timing.includes('-->')) continue
    cues.push({ index: (lines[0] ?? '').trim(), timing, text: lines.slice(2) })
  }
  return cues
}

function fullWidthLen(s: string): number {
  const stripped = s.replace(TAG, '')
  let n = 0
  for (const ch of stripped) n += FULLWIDTH.test(ch) ? 1 : 0.5
  return Math.round(n)
}

function tagCount(lines: string[]): number {
  return lines.reduce((a, l) => a + (l.match(TAG)?.length ?? 0), 0)
}

function durationSec(timing: string): number {
  const m = timing.match(/(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d\d\d)/)
  if (!m) return 0.1
  const a = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
  const b = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000
  return Math.max(0.1, b - a)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 对候选译文跑 fail-closed 确定性闸。source 与 candidate 按下标对齐(结构层已要求同条数/同时轴,
 * 故下标对齐可靠)。glossary 空 → 跳过术语层(conformance=1)。
 */
export function evaluateTranslationGate(
  source: SrtCue[],
  candidate: SrtCue[],
  glossary: GlossaryTerm[],
  options: GateOptions = {},
): GateResult {
  const opts = { ...DEFAULTS, ...options }
  const hard: string[] = []
  const soft: string[] = []

  // ---- Layer 1:结构确定性 ----
  if (source.length !== candidate.length) {
    hard.push(`条数不符: source=${source.length} candidate=${candidate.length}`)
  }
  const n = Math.min(source.length, candidate.length)
  let indexMismatch = 0
  let timingMismatch = 0
  let tagMismatch = 0
  for (let i = 0; i < n; i++) {
    if (source[i].index !== candidate[i].index) indexMismatch++
    if (source[i].timing !== candidate[i].timing) timingMismatch++
    if (tagCount(source[i].text) !== tagCount(candidate[i].text)) tagMismatch++
  }
  if (indexMismatch) hard.push(`序号行不符 ${indexMismatch}/${n} 条`)
  if (timingMismatch) hard.push(`时轴行不符 ${timingMismatch}/${n} 条(时轴须逐字节冻结)`)
  if (tagMismatch) hard.push(`样式标签数不符 ${tagMismatch}/${n} 条(标签须原位保留)`)

  // ---- Layer 3(确定性部分):CJK 约束(soft) ----
  let overLongLines = 0
  let overCpsCues = 0
  for (let i = 0; i < n; i++) {
    const totalFw = candidate[i].text.reduce((a, l) => a + fullWidthLen(l), 0)
    for (const l of candidate[i].text) {
      if (fullWidthLen(l) > opts.maxLineFullWidth) overLongLines++
    }
    if (totalFw / durationSec(candidate[i].timing) > opts.maxCps) overCpsCues++
  }
  if (overLongLines) soft.push(`单行过长(>${opts.maxLineFullWidth}全角)${overLongLines} 处`)
  if (overCpsCues) soft.push(`读速超标(>${opts.maxCps}字/秒)${overCpsCues} 处`)

  // ---- Layer 2:术语符合性 ----
  const violations: TermViolation[] = []
  let checks = 0
  let hits = 0
  for (const t of glossary) {
    const en = t.en.trim()
    if (!en || !t.zh) continue
    const re = new RegExp(`\\b${escapeRegExp(en)}\\b`, 'i')
    const miss: number[] = []
    for (let i = 0; i < n; i++) {
      if (!re.test(source[i].text.join(' '))) continue
      checks++
      if (candidate[i].text.join(' ').includes(t.zh)) hits++
      else miss.push(Number(candidate[i].index) || i + 1)
    }
    if (miss.length) violations.push({ term: en, expectZh: t.zh, missAtCues: miss })
  }
  const conformance = checks > 0 ? hits / checks : 1
  if (conformance < opts.minTermConformance) {
    hard.push(`术语符合率 ${(conformance * 100).toFixed(1)}% < ${(opts.minTermConformance * 100).toFixed(0)}%(专名漂移/破术语)`)
  }

  return {
    verdict: hard.length === 0 ? 'pass' : 'fail',
    cueCount: { source: source.length, candidate: candidate.length },
    structural: { indexMismatch, timingMismatch, tagMismatch },
    cjk: { overLongLines, overCpsCues },
    glossary: { checks, hits, conformance: +(conformance * 100).toFixed(1), violations },
    hardViolations: hard,
    softWarnings: soft,
  }
}
