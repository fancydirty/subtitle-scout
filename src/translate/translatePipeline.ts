// E AI 翻译 · 核心编排(确定性,LM 可注入)。北极星:错译比留缺口更糟——质量闸 fail-closed,
// 最坏结局=held(不装、留英文+标记交上层),绝不静默装错译。
//
// 刻意做成"确定性编排 + 可注入 LM 接口"而非自由 tool-calling agent:自由 agent 的非确定性与
// fail-closed 北极星相冲,且难脱机测。本模块 zero 网络(LM 由调用方注入),MockLM 即可全量 eval。
// 流程(E 设计 §流水线的 ④⑤⑦):术语表先行(prior 持久化 + 新建合并)→ 场景分批 → 串行逐批译
// 带滚动记忆 → 组装 → fail-closed 质量闸判 installed/held。
import {
  parseSrtCues,
  serializeSrtCues,
  evaluateTranslationGate,
  type GlossaryTerm,
  type SrtCue,
  type GateResult,
  type GateOptions,
} from './qualityGate.js'
import { batchIntoScenes } from './sceneBatcher.js'

/** 上下文源(E v1):同剧既有中字(播种术语表)+ TMDB 简介 + 按剧持久化的术语表(E02 继承 E01)。 */
export interface TranslationContext {
  seriesExistingSubs?: string[]
  tmdbSynopsis?: string
  priorGlossary?: GlossaryTerm[]
}

/** 注入的 LM 能力:①通读源+上下文产术语表 ②按批带滚动记忆翻译(冻结时轴/标签,只译文本)。
 *  真实现用 ai SDK generateObject(见 translateLm.ts);测试注入 MockLM。 */
export interface TranslationLM {
  buildGlossary(sourceText: string, ctx: TranslationContext): Promise<GlossaryTerm[]>
  translateBatch(
    batch: SrtCue[],
    glossary: GlossaryTerm[],
    rollingSummary: string,
  ): Promise<{ cues: SrtCue[]; summary: string }>
}

/** critic(LLM-judge)一条问题:确定性闸抓不到的语义/通顺/漏译类。severity=major 才应否决。 */
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
 *  漏译——正是确定性层判不了的"通顺度"。真实现用强模型 ai SDK(见 translateCritic.ts);测试注入 Mock。 */
export interface TranslationCritic {
  review(source: SrtCue[], candidate: SrtCue[], glossary: GlossaryTerm[]): Promise<CriticVerdict>
}

export interface TranslateOptions {
  gapSec?: number
  maxBatch?: number
  gate?: GateOptions
  /** 可选 LLM-judge 语义层。确定性闸过后再跑;critic 判不合格 → held。critic 抛错 → 优雅降级
   *  (确定性闸已过则装),不因判官抽风阻塞可用译文。 */
  critic?: TranslationCritic
}

export interface TranslationResult {
  /** installed=过闸(含 critic)可落盘;held=fail-closed 未过,不落盘(上层留英文+标记)。 */
  verdict: 'installed' | 'held'
  translatedSrt: string | null
  glossary: GlossaryTerm[]
  gate: GateResult
  /** 跑了 critic 才有(确定性闸过 + 提供了 critic 时)。 */
  critic?: CriticVerdict
  reason?: string
}

/** prior(持久化 canonical)优先合并 fresh,按 en 去重(大小写不敏感),prior 胜——保证跨集术语稳定。 */
function mergeGlossary(prior: GlossaryTerm[], fresh: GlossaryTerm[]): GlossaryTerm[] {
  const seen = new Set<string>()
  const out: GlossaryTerm[] = []
  for (const t of [...prior, ...fresh]) {
    const k = t.en.trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

export async function translateSubtitle(
  sourceSrt: string,
  ctx: TranslationContext,
  lm: TranslationLM,
  opts: TranslateOptions = {},
): Promise<TranslationResult> {
  const source = parseSrtCues(sourceSrt)

  // ④ 术语表先行:持久化的 prior + 新建,合并去重(prior 胜)。buildGlossary 失败降级为仅用 prior。
  let glossary: GlossaryTerm[]
  try {
    const built = await lm.buildGlossary(sourceSrt, ctx)
    glossary = mergeGlossary(ctx.priorGlossary ?? [], built)
  } catch {
    glossary = ctx.priorGlossary ?? []
  }

  // ⑤ 场景分批 → 串行逐批译带滚动记忆。任一批抛错 → 标记失败中断(下方 fail-closed 兜底)。
  const batches = batchIntoScenes(source, { gapSec: opts.gapSec, maxBatch: opts.maxBatch })
  const translated: SrtCue[] = []
  let rollingSummary = ''
  let failed = false
  for (const batch of batches) {
    try {
      const { cues, summary } = await lm.translateBatch(batch, glossary, rollingSummary)
      translated.push(...cues)
      rollingSummary = summary
    } catch {
      failed = true
      break
    }
  }

  // ⑦ fail-closed 确定性质量闸:LM 失败 或 闸不过 → held(不落盘,且不浪费一次 critic LLM 调用)。
  const gate = evaluateTranslationGate(source, translated, glossary, opts.gate)
  if (failed || gate.verdict === 'fail') {
    return {
      verdict: 'held',
      translatedSrt: null,
      glossary,
      gate,
      reason: failed ? 'LM 翻译失败(批次抛错)' : gate.hardViolations.join('; '),
    }
  }

  // ⑦b LLM-judge 语义/通顺层(确定性闸之外):强模型判官抓生硬译文/语义错/漏译——确定性层判不了
  //     通顺度。critic 抛错 → 优雅降级(确定性闸已过则装),不因判官抽风阻塞。
  let critic: CriticVerdict | undefined
  if (opts.critic) {
    try {
      critic = await opts.critic.review(source, translated, glossary)
    } catch {
      critic = { ok: true, issues: [] }
    }
    if (!critic.ok) {
      return {
        verdict: 'held',
        translatedSrt: null,
        glossary,
        gate,
        critic,
        reason: 'critic 判不合格: ' + critic.issues.filter((i) => i.severity === 'major').map((i) => i.note).join('; '),
      }
    }
  }
  return { verdict: 'installed', translatedSrt: serializeSrtCues(translated), glossary, gate, critic }
}
