// E AI 翻译 · 真 LM 实现(ai SDK)。给 translatePipeline 注入 TranslationLM:buildGlossary +
// translateBatch。用 generateText + 容错 JSON 解析,不走 generateObject/response_format:json_object
// ——后者会毒 openai-compatible 端点的部分模型(见 findSubtitleWorker.ts 的 finalize-tool 注释)。
//
// fail-closed 结构保真核心:模型永不返回时轴/序号,只返回每 cue 的译文;reconstructBatch 用原
// batch 的 index/timing 重建 cue,只填模型译文——时轴/序号从构造上不可能漂;模型漏译的 cue 保留
// 原英文(诚实,不丢结构),交由上层质量闸拦。
import { generateText, type LanguageModel } from 'ai'
import { LLM_TIMEOUT_MS } from '../agent/llm.js'
import type { GlossaryTerm, SrtCue } from './qualityGate.js'
import type { TranslationContext, TranslationLM } from './translatePipeline.js'

/** 从模型自由文本里容错提取一段 JSON(裸 JSON / ```json 围栏 / 前后夹散文都能拿到)。解析不出返回 null。
 *  导出供 translateCritic 复用(同类"从 LLM 自由文本抠 JSON"需求)。 */
export function extractJson(raw: string): unknown {
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

/** 解析术语表响应 → GlossaryTerm[]。缺 en/zh 的坏条目过滤;解析不出返回 [](降级不抛)。 */
export function parseGlossaryResponse(raw: string): GlossaryTerm[] {
  const parsed = extractJson(raw)
  if (!Array.isArray(parsed)) return []
  const out: GlossaryTerm[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (typeof rec.en !== 'string' || typeof rec.zh !== 'string') continue
    const en = rec.en.trim()
    const zh = rec.zh.trim()
    if (!en || !zh) continue
    const note = typeof rec.note === 'string' && rec.note.trim() ? rec.note.trim() : undefined
    out.push(note ? { en, zh, note } : { en, zh })
  }
  return out
}

/** 用模型译文 + 原 batch 重建 cue 序列。见文件头 fail-closed 结构保真。 */
export function reconstructBatch(modelText: string, batch: SrtCue[]): SrtCue[] {
  const parsed = extractJson(modelText)
  const map = new Map<string, string>()
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>
      if (rec.i == null || typeof rec.zh !== 'string') continue
      map.set(String(rec.i), rec.zh)
    }
  }
  return batch.map((c) => {
    const zh = map.get(c.index)
    if (zh === undefined) return c // 漏译 → 保留原英文(诚实,不丢结构)
    return { index: c.index, timing: c.timing, text: zh.split('\n') }
  })
}

function glossaryPrompt(sourceText: string, ctx: TranslationContext): string {
  const parts: string[] = [
    '你是资深英译简中字幕译者。通读下面的英文字幕(及上下文),产出 EN→ZH 专名术语表:覆盖角色名、',
    '地名/组织名、世界观与技术术语、敬称。每个术语给唯一固定的简体中文译法。',
    '只输出 JSON 数组,形如 [{"en":"Rose","zh":"罗斯","note":"角色名"}],不要任何其它文字。',
    '',
  ]
  if (ctx.tmdbSynopsis) parts.push(`【剧情简介】${ctx.tmdbSynopsis}`, '')
  if (ctx.seriesExistingSubs?.length) {
    parts.push('【同剧既有中字片段(参照已有译名保持一致)】', ctx.seriesExistingSubs.join('\n---\n').slice(0, 4000), '')
  }
  if (ctx.priorGlossary?.length) {
    parts.push(`【已有术语表(沿用,勿改译名)】${JSON.stringify(ctx.priorGlossary)}`, '')
  }
  parts.push('【英文字幕】', sourceText.slice(0, 12000))
  return parts.join('\n')
}

function batchPrompt(batch: SrtCue[], glossary: GlossaryTerm[], rollingSummary: string): string {
  const cuesBlock = batch.map((c) => `[${c.index}] ${c.text.join(' ⏎ ')}`).join('\n')
  return [
    '把下面每条英文字幕译成简体中文。硬规则:',
    '① 所有专名严格钉死术语表的中文译法,全批一致;',
    '② CJK 排版:每行≤16个全角字符,过长自然断成多行(多行用 \\n 连接);口语自然通顺;',
    '③ 只译文本,保留 <i></i> 等内联标签原位;',
    '④ 若某条是纯音效/说话人标注([tense music]/[Rose]),音效译出、说话人按术语表。',
    rollingSummary ? `\n前文摘要(保持代词/称呼连贯):${rollingSummary}` : '',
    `\n术语表:${JSON.stringify(glossary)}`,
    '',
    '只输出 JSON 数组,每条对应下面一个 cue,形如 [{"i":"1","zh":"译文(多行用\\n)"}],不要任何其它文字。',
    '',
    'cues:',
    cuesBlock,
  ].join('\n')
}

/** 用译好的 cue 生成给下一批的滚动摘要:取本批最后 2 条译文文本,给下批即时上文(v1 轻量;
 *  语义摘要留 phase-2)。 */
function rollingSummaryOf(cues: SrtCue[]): string {
  return cues.slice(-2).map((c) => c.text.join(' ')).join(' ').slice(0, 200)
}

export interface TranslationLmOptions {
  temperature?: number
  timeoutMs?: number
}

/** 用注入的 ai SDK LanguageModel 造 TranslationLM(供 translateSubtitle)。真机调用点;单测走 MockLM。 */
export function makeTranslationLM(model: LanguageModel, opts: TranslationLmOptions = {}): TranslationLM {
  const temperature = opts.temperature ?? 0
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS
  return {
    async buildGlossary(sourceText, ctx) {
      const { text } = await generateText({
        model,
        prompt: glossaryPrompt(sourceText, ctx),
        temperature,
        abortSignal: AbortSignal.timeout(timeoutMs),
      })
      return parseGlossaryResponse(text)
    },
    async translateBatch(batch, glossary, rollingSummary) {
      const { text } = await generateText({
        model,
        prompt: batchPrompt(batch, glossary, rollingSummary),
        temperature,
        abortSignal: AbortSignal.timeout(timeoutMs),
      })
      const cues = reconstructBatch(text, batch)
      return { cues, summary: rollingSummaryOf(cues) }
    },
  }
}
