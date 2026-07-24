// E AI 翻译 · LLM-judge critic(真实现,ai SDK)。确定性闸(结构/术语/CJK)判不了"通顺度/语义准"
// ——真机实测暴露:弱模型(mimo)译文能过确定性闸,但中文生硬(如"打孔在地球上")。critic 用强模型
// 当判官逐条审英中对照,抓 mistranslation/awkward/omission/term,major 问题 → held。
//
// 判官输出坏/抛错时优雅降级:确定性闸已过,critic 是额外一层,不该因判官抽风阻塞可用译文。
// (审计 Wave 3 D 波:legacy translatePipeline 已退役,类型就地定义,extractJson 内联。)
import { generateText, type LanguageModel } from 'ai'
import { LLM_TIMEOUT_MS } from '../agent/llm.js'
import type { GlossaryTerm, SrtCue } from './qualityGate.js'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES(原 translatePipeline.ts 定义,legacy 退役后挪这里)
// ─────────────────────────────────────────────────────────────────────────────

export interface CriticIssue {
  cueIndex: string
  severity: 'major' | 'minor'
  kind: string
  note: string
}

export interface CriticVerdict {
  /** false → held(有 major 语义/通顺问题)。 */
  ok: boolean
  issues: CriticIssue[]
}

/** LLM-judge 语义/通顺 QA:确定性闸(结构/术语/CJK)之外的一层,强模型当判官抓生硬译文/语义错/
 *  漏译——正是确定性层判不了的"通顺度"。真实现用强模型 ai SDK;测试注入 Mock。 */
export interface TranslationCritic {
  review(
    source: SrtCue[],
    candidate: SrtCue[],
    glossary: GlossaryTerm[],
    sourceLangName?: string,
  ): Promise<CriticVerdict>
}

// ─────────────────────────────────────────────────────────────────────────────
// UTIL(原 translateLm.ts 的 extractJson,legacy 退役后内联)
// ─────────────────────────────────────────────────────────────────────────────

function extractJson(raw: string): unknown {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const firstArr = s.indexOf('[')
  const firstObj = s.indexOf('{')
  let start = -1
  let close = ''
  if (firstArr >= 0 && (firstObj < 0 || firstArr < firstObj)) { start = firstArr; close = ']' }
  else if (firstObj >= 0) { start = firstObj; close = '}' }
  if (start < 0) return null
  const end = s.lastIndexOf(close)
  if (end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRITIC IMPL
// ─────────────────────────────────────────────────────────────────────────────

/** 容错解析判官响应 → CriticVerdict。有 major 问题 → ok=false;解析不出 → 优雅降级 ok=true。 */
export function parseCriticResponse(raw: string): CriticVerdict {
  const parsed = extractJson(raw)
  if (!Array.isArray(parsed)) return { ok: true, issues: [] }
  const issues: CriticIssue[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (typeof rec.note !== 'string' || !rec.note.trim()) continue
    issues.push({
      cueIndex: rec.i != null ? String(rec.i) : '',
      severity: rec.severity === 'major' ? 'major' : 'minor', // 未知/缺失一律 minor,绝不误升级成否决
      kind: typeof rec.kind === 'string' && rec.kind ? rec.kind : 'unspecified',
      note: rec.note.trim(),
    })
  }
  return { ok: !issues.some((i) => i.severity === 'major'), issues }
}

function criticPrompt(
  source: SrtCue[], candidate: SrtCue[], glossary: GlossaryTerm[], sourceLangName = '英文',
): string {
  const lang = sourceLangName.trim() || '英文'
  const pairs = source
    .map((s, idx) => `[${s.index}] SRC: ${s.text.join(' ')} | ZH: ${candidate[idx] ? candidate[idx].text.join(' ') : '(缺)'}`)
    .join('\n')
  return [
    `你是中文字幕译审。下面是${lang}原文与其简体中文译文的逐条对照。找出译文里的真问题:`,
    '① mistranslation 意思错/反/被曲解 ② awkward 生硬到不像人话 ③ omission 关键信息漏译 ④ term 专名不符术语表。',
    '',
    '严重度极其克制,只有两档:',
    '- **major**:仅限**改变原意、丢失关键信息、或让观众看不懂**的真错。必须是硬伤。',
    '- **minor**:忠实但可以更地道/更口语/风格可改进的——一律 minor,别升 major。',
    '',
    '铁律(避免过判):',
    '① **忠实的直译不是 major**,哪怕存在"更本地化"的译法(如把某梗译得更地道)——那只是 minor 或不报。',
    '② **结合相邻上下文判断**:某句省略的信息若已由紧邻的上一句/下一句承载,就不是 omission,别孤立判它漏。',
    '③ 宁可漏报也别把"我觉得可以更好"当 major——major 只留给观众真会看错/看不懂的地方。',
    `术语表:${JSON.stringify(glossary)}`,
    '',
    '只输出 JSON 数组,每条形如 [{"i":"序号","severity":"major"|"minor","kind":"awkward","note":"问题描述"}]。',
    '没有 major 硬伤就别硬凑;完全没问题输出 []。不要任何其它文字。',
    '',
    '对照:',
    pairs,
  ].join('\n')
}

export interface TranslationCriticOptions {
  temperature?: number
  timeoutMs?: number
}

/** 用注入的强模型 LanguageModel 造 critic。真机调用点;单测走 MockCritic + parseCriticResponse 直测。 */
export function makeTranslationCritic(model: LanguageModel, opts: TranslationCriticOptions = {}): TranslationCritic {
  return {
    async review(source, candidate, glossary, sourceLangName) {
      const { text } = await generateText({
        model,
        prompt: criticPrompt(source, candidate, glossary, sourceLangName),
        temperature: opts.temperature ?? 0,
        abortSignal: AbortSignal.timeout(opts.timeoutMs ?? LLM_TIMEOUT_MS),
      })
      return parseCriticResponse(text)
    },
  }
}
