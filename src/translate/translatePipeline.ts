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
  /** F2:源语言显示名(如'英文'/'日文'),写入 prompt;缺省=英文(F1 回归)。 */
  sourceLangName?: string
}

/** 注入的 LM 能力:①通读源+上下文产术语表 ②按批带滚动记忆翻译(冻结时轴/标签,只译文本)。
 *  真实现用 ai SDK generateObject(见 translateLm.ts);测试注入 MockLM。 */
export interface TranslationLM {
  buildGlossary(sourceText: string, ctx: TranslationContext): Promise<GlossaryTerm[]>
  translateBatch(
    batch: SrtCue[],
    glossary: GlossaryTerm[],
    rollingSummary: string,
    /** F2:与 buildGlossary 同源语言名;缺省实现可忽略(Mock/英文路径)。 */
    sourceLangName?: string,
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
  review(
    source: SrtCue[],
    candidate: SrtCue[],
    glossary: GlossaryTerm[],
    sourceLangName?: string,
  ): Promise<CriticVerdict>
}

export interface TranslateOptions {
  gapSec?: number
  maxBatch?: number
  gate?: GateOptions
  /** 单批抛错后的重试次数(默认 2)。真机逼出:F1 fetch 腿的外挂字幕碎成上百个小批,
   *  串行长跑中单次网关抖动/超时曾把整档 false-held;重试只在抛错路径发生,绿路径零成本。
   *  重试用尽仍败 → failed → held,fail-closed 不变。 */
  batchRetries?: number
  /** 重试间隔(毫秒,按第几次重试取值)。默认递增 2s/5s——429/网关抖动需要喘息,
   *  背靠背秒发三次会把可恢复的 30s 限流打成整档 held;测试注入 () => 0 保持快。 */
  retryDelayMs?: (attempt: number) => number
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

/** 默认重试间隔:第 1 次 3s、第 2 次 5s(429/网关抖动需要喘息;背靠背秒发三次会把
 *  可恢复的限流打成整档 held)。导出供测试直测,生产由 translateSubtitle 缺省使用。 */
export const defaultRetryDelayMs = (attempt: number): number => attempt * 2000 + 1000

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

/** ASS/SSA override 块(`{\an8}` / `{\blur4\pos(1,2)}`)。要求 `{` 后紧跟 `\`,普通 `{literal}` 保留。 */
const ASS_OVERRIDE = /\{\\[^}]*\}/g

/** 译后、闸前:剥离 ASS override,保留条数/时轴/序号。 */
function stripAssOverrides(cues: SrtCue[]): SrtCue[] {
  return cues.map((c) => ({
    ...c,
    text: c.text.map((line) => line.replace(ASS_OVERRIDE, '')),
  }))
}

export async function translateSubtitle(
  sourceSrt: string,
  ctx: TranslationContext,
  lm: TranslationLM,
  opts: TranslateOptions = {},
): Promise<TranslationResult> {
  const source = parseSrtCues(sourceSrt)

  // 审计🟡:零 cue 是 vacuous pass 死角——source=candidate=[],术语符合率缺省 1、零硬违规,
  // 会被判 installed 并写出空 .zh-Hans.srt(成功路径的假安装)。fetch 腿已有 parse 闸,内嵌腿
  // (ffmpeg 异 codec 可产出非空但零 cue 文本)和这里本身都没有。空输入没有可译内容 → held。
  if (source.length === 0) {
    return {
      verdict: 'held',
      translatedSrt: null,
      glossary: [],
      gate: evaluateTranslationGate([], [], [], opts.gate),
      reason: '源字幕解析出 0 条 cue(无可译内容,拒绝安装空字幕)',
    }
  }

  // ④ 术语表先行:持久化的 prior + 新建,合并去重(prior 胜)。buildGlossary 失败降级为仅用 prior。
  let glossary: GlossaryTerm[]
  try {
    const built = await lm.buildGlossary(sourceSrt, ctx)
    glossary = mergeGlossary(ctx.priorGlossary ?? [], built)
  } catch {
    glossary = ctx.priorGlossary ?? []
  }

  // ⑤ 场景分批 → 串行逐批译带滚动记忆。单批抛错先按递增间隔重试(batchRetries,默认 2)——
  //  瞬时抖动/限流不该整档陪葬;重试用尽仍败 → 标记失败中断(下方 fail-closed 兜底),
  //  lastErr 带进 reason(daemon 日志可诊断,不再是干巴巴一句"批次抛错")。
  const batches = batchIntoScenes(source, { gapSec: opts.gapSec, maxBatch: opts.maxBatch })
  const maxAttempts = 1 + (opts.batchRetries ?? 2)
  const retryDelay = opts.retryDelayMs ?? defaultRetryDelayMs
  const translated: SrtCue[] = []
  let rollingSummary = ''
  let failed = false
  let lastErr: unknown
  for (const batch of batches) {
    let ok = false
    for (let attempt = 0; attempt < maxAttempts && !ok; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelay(attempt)))
      try {
        const { cues, summary } = await lm.translateBatch(
          batch, glossary, rollingSummary, ctx.sourceLangName,
        )
        translated.push(...cues)
        rollingSummary = summary
        ok = true
      } catch (e) {
        lastErr = e /* 瞬时失败 → 下 attempt 重试同批 */
      }
    }
    if (!ok) {
      failed = true
      break
    }
  }

  // 译后卫生:剥离 ASS/SSA override(`{\an8}` 等)再进闸/critic/序列化。普通 `{literal}` 不动。
  const sanitized = stripAssOverrides(translated)

  // ⑦ fail-closed 确定性质量闸:LM 失败 或 闸不过 → held(不落盘,且不浪费一次 critic LLM 调用)。
  const gate = evaluateTranslationGate(source, sanitized, glossary, opts.gate)
  if (failed || gate.verdict === 'fail') {
    return {
      verdict: 'held',
      translatedSrt: null,
      glossary,
      gate,
      reason: failed
        ? `LM 翻译失败(批次抛错): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
        : gate.hardViolations.join('; '),
    }
  }

  // ⑦b LLM-judge 语义/通顺层(确定性闸之外):强模型判官抓生硬译文/语义错/漏译——确定性层判不了
  //     通顺度。critic 抛错 → 优雅降级(确定性闸已过则装),不因判官抽风阻塞。
  let critic: CriticVerdict | undefined
  if (opts.critic) {
    try {
      critic = await opts.critic.review(source, sanitized, glossary, ctx.sourceLangName)
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
  return { verdict: 'installed', translatedSrt: serializeSrtCues(sanitized), glossary, gate, critic }
}
