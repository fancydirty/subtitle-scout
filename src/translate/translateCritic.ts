// E AI 翻译 · LLM-judge critic(真实现,ai SDK)。确定性闸(结构/术语/CJK)判不了"通顺度/语义准"
// ——真机实测暴露:弱模型(mimo)译文能过确定性闸,但中文生硬(如"打孔在地球上")。critic 用强模型
// 当判官逐条审英中对照,抓 mistranslation/awkward/omission/term,major 问题 → held。
//
// 判官输出坏/抛错时优雅降级(见 translatePipeline 的 ⑦b + parseCriticResponse):确定性闸已过,
// critic 是额外一层,不该因判官抽风阻塞可用译文。
import { generateText, type LanguageModel } from 'ai'
import { LLM_TIMEOUT_MS } from '../agent/llm.js'
import { extractJson } from './translateLm.js'
import type { GlossaryTerm, SrtCue } from './qualityGate.js'
import type { CriticIssue, CriticVerdict, TranslationCritic } from './translatePipeline.js'

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

function criticPrompt(source: SrtCue[], candidate: SrtCue[], glossary: GlossaryTerm[]): string {
  const pairs = source
    .map((s, idx) => `[${s.index}] EN: ${s.text.join(' ')} | ZH: ${candidate[idx] ? candidate[idx].text.join(' ') : '(缺)'}`)
    .join('\n')
  return [
    '你是严格的中文字幕译审。下面是英文原文与其简体中文译文的逐条对照。找出译文里的真问题:',
    '① mistranslation 意思错/反 ② awkward 生硬、翻译腔、不像人话 ③ omission 漏译/意思缺失 ④ term 专名不符术语表。',
    '只报会影响观看理解或明显别扭的问题,别报吹毛求疵的风格偏好。',
    `术语表:${JSON.stringify(glossary)}`,
    '',
    '只输出 JSON 数组,每条形如 [{"i":"序号","severity":"major"|"minor","kind":"awkward","note":"问题描述"}]。',
    'severity:major=影响理解/明显别扭、必须改;minor=可改进但可接受。没有问题就输出 []。不要任何其它文字。',
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
    async review(source, candidate, glossary) {
      const { text } = await generateText({
        model,
        prompt: criticPrompt(source, candidate, glossary),
        temperature: opts.temperature ?? 0,
        abortSignal: AbortSignal.timeout(opts.timeoutMs ?? LLM_TIMEOUT_MS),
      })
      return parseCriticResponse(text)
    },
  }
}
