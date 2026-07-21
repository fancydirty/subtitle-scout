import { describe, it, expect } from 'vitest'
import { translateSubtitle, type TranslationLM, type TranslationCritic } from './translatePipeline.js'
import { parseSrtCues, type GlossaryTerm, type SrtCue } from './qualityGate.js'

const SOURCE = [
  '1', '00:00:01,000 --> 00:00:03,000', 'Rose enters Pictor HQ.', '',
  '2', '00:00:04,000 --> 00:00:06,000', '<i>Pictor knew all along.</i>', '',
  '3', '00:00:20,000 --> 00:00:22,000', 'The organism spreads.', '',
  '4', '00:00:22,500 --> 00:00:24,000', 'Rose runs.', '',
].join('\n')

const GLOSSARY: GlossaryTerm[] = [
  { en: 'Rose', zh: '罗斯' },
  { en: 'Pictor', zh: '皮克托' },
  { en: 'the organism', zh: '有机体' },
]

/** 按 EN→ZH 映射逐字替换源文本模拟翻译;保留序号/时轴/标签结构。termMap 覆写某些术语以造漂移。 */
function makeMockLM(opts: {
  glossary?: GlossaryTerm[]
  termMap?: Record<string, string> // en → zh(覆盖 glossary 的 zh,用于造漂移)
  dropLastCueOfBatch?: boolean
  throwOnBatch?: number
  summaryLog?: string[]
} = {}): TranslationLM {
  const glossary = opts.glossary ?? GLOSSARY
  const map: Record<string, string> = {}
  for (const t of glossary) map[t.en.toLowerCase()] = opts.termMap?.[t.en] ?? t.zh
  let batchCount = 0
  return {
    async buildGlossary() {
      return opts.glossary === undefined ? GLOSSARY : opts.glossary
    },
    async translateBatch(batch: SrtCue[], _glossary, rollingSummary) {
      const idx = batchCount++
      if (opts.throwOnBatch === idx) throw new Error('mock LM boom')
      opts.summaryLog?.push(rollingSummary)
      let cues = batch.map((c) => ({
        ...c,
        text: c.text.map((line) => {
          let out = line
          for (const [en, zh] of Object.entries(map)) out = out.replace(new RegExp(en, 'ig'), zh)
          return out
        }),
      }))
      if (opts.dropLastCueOfBatch) cues = cues.slice(0, -1)
      return { cues, summary: `批${idx}译毕` }
    },
  }
}

describe('translateSubtitle — 忠实译文放行(installed)', () => {
  it('术语全用 canonical zh + 结构保留 → 过闸 → installed,产出中文 SRT', async () => {
    const r = await translateSubtitle(SOURCE, {}, makeMockLM())
    expect(r.verdict).toBe('installed')
    expect(r.translatedSrt).not.toBeNull()
    expect(r.gate.verdict).toBe('pass')
    // 译文含术语 canonical zh、结构 4 条不变
    expect(parseSrtCues(r.translatedSrt!)).toHaveLength(4)
    expect(r.translatedSrt!).toContain('皮克托')
    expect(r.translatedSrt!).toContain('有机体')
  })
})

describe('translateSubtitle — fail-closed(held,绝不装错译)', () => {
  it('专名系统性漂移 → 闸拦下 → held,不产出译文(留英文+标记交上层)', async () => {
    // Pictor 漂成"皮克特"(出现在 cue1+cue2 两处 → 系统性漂移)
    const lm = makeMockLM({ termMap: { Pictor: '皮克特' } })
    const r = await translateSubtitle(SOURCE, {}, lm)
    expect(r.verdict).toBe('held')
    expect(r.translatedSrt).toBeNull()
    expect(r.gate.verdict).toBe('fail')
    expect(r.reason).toBeTruthy()
  })

  it('译文丢 cue(结构破) → held', async () => {
    const lm = makeMockLM({ dropLastCueOfBatch: true })
    const r = await translateSubtitle(SOURCE, {}, lm)
    expect(r.verdict).toBe('held')
    expect(r.translatedSrt).toBeNull()
  })

  it('LM 抛错 → held,不崩溃', async () => {
    const lm = makeMockLM({ throwOnBatch: 0 })
    const r = await translateSubtitle(SOURCE, {}, lm)
    expect(r.verdict).toBe('held')
    expect(r.translatedSrt).toBeNull()
  })
})

describe('translateSubtitle — 分批带滚动记忆', () => {
  it('前一批的 summary 传给下一批(SOURCE 因 cue2→3 有 14s 间隔切成两批)', async () => {
    const summaryLog: string[] = []
    await translateSubtitle(SOURCE, {}, makeMockLM({ summaryLog }), { gapSec: 2, maxBatch: 40 })
    expect(summaryLog.length).toBe(2) // 两批
    expect(summaryLog[0]).toBe('') // 首批无前文
    expect(summaryLog[1]).toBe('批0译毕') // 次批拿到首批摘要
  })
})

describe('translateSubtitle — LLM-judge critic 层(语义/通顺,确定性闸之外)', () => {
  it('确定性闸过、但 critic 判语义/通顺不合格 → held(抓确定性闸抓不到的生硬译文)', async () => {
    const critic: TranslationCritic = {
      async review() { return { ok: false, issues: [{ cueIndex: '1', severity: 'major', kind: 'awkward', note: '打孔在地球上 生硬' }] } }
    }
    const r = await translateSubtitle(SOURCE, {}, makeMockLM(), { critic })
    expect(r.gate.verdict).toBe('pass') // 确定性闸放行
    expect(r.verdict).toBe('held') // 但 critic 拦下
    expect(r.translatedSrt).toBeNull()
    expect(r.critic?.ok).toBe(false)
    expect(r.reason).toContain('critic')
  })

  it('critic 判合格 → installed', async () => {
    const critic: TranslationCritic = { async review() { return { ok: true, issues: [] } } }
    const r = await translateSubtitle(SOURCE, {}, makeMockLM(), { critic })
    expect(r.verdict).toBe('installed')
    expect(r.critic?.ok).toBe(true)
  })

  it('critic 抛错 → 优雅降级到确定性闸判决(不因判官抽风阻塞可用译文)', async () => {
    const critic: TranslationCritic = { async review() { throw new Error('critic LM down') } }
    const r = await translateSubtitle(SOURCE, {}, makeMockLM(), { critic })
    expect(r.verdict).toBe('installed') // 确定性闸已过 → 装
  })

  it('确定性闸已 fail 时不跑 critic(省一次 LLM 调用),仍 held', async () => {
    let criticCalled = false
    const critic: TranslationCritic = { async review() { criticCalled = true; return { ok: true, issues: [] } } }
    const r = await translateSubtitle(SOURCE, {}, makeMockLM({ termMap: { Pictor: '皮克特' } }), { critic })
    expect(r.verdict).toBe('held')
    expect(criticCalled).toBe(false)
  })
})

describe('translateSubtitle — 术语表持久化继承(priorGlossary)', () => {
  it('ctx.priorGlossary 的术语参与闸校验,即便 buildGlossary 返回空', async () => {
    // buildGlossary 返回空,但 priorGlossary 有 Pictor;LM 把 Pictor 漂成皮克特 → 应被 priorGlossary 闸抓
    const lm = makeMockLM({ glossary: [], termMap: {} })
    // 覆盖 translateBatch 的 map:强制漂移 Pictor(即便 glossary 空,LM 仍会渲染文本)
    const drift: TranslationLM = {
      async buildGlossary() { return [] },
      async translateBatch(batch) {
        return {
          cues: batch.map((c) => ({ ...c, text: c.text.map((l) => l.replace(/Pictor/ig, '皮克特').replace(/Rose/ig, '罗斯').replace(/the organism/ig, '有机体')) })),
          summary: 's',
        }
      },
    }
    const r = await translateSubtitle(SOURCE, { priorGlossary: [{ en: 'Pictor', zh: '皮克托' }] }, drift)
    expect(r.verdict).toBe('held') // priorGlossary 的 Pictor→皮克托 被漂成皮克特 → 系统性漂移
    void lm
  })
})
