import { describe, it, expect } from 'vitest'
import { translateSubtitle, defaultRetryDelayMs, type TranslationLM, type TranslationCritic } from './translatePipeline.js'
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
  /** 第 idx 批的前 fails 次调用抛错、之后恢复(模拟瞬时网络抖动/网关 5xx)。 */
  flakyOnBatch?: { idx: number; fails: number }
  attemptsLog?: number[]
  summaryLog?: string[]
} = {}): TranslationLM {
  const glossary = opts.glossary ?? GLOSSARY
  const map: Record<string, string> = {}
  for (const t of glossary) map[t.en.toLowerCase()] = opts.termMap?.[t.en] ?? t.zh
  let batchCount = 0
  let flakyThrown = 0
  return {
    async buildGlossary() {
      return opts.glossary === undefined ? GLOSSARY : opts.glossary
    },
    async translateBatch(batch: SrtCue[], _glossary, rollingSummary) {
      const idx = batchCount
      opts.attemptsLog?.push(idx)
      if (opts.flakyOnBatch && idx === opts.flakyOnBatch.idx && flakyThrown < opts.flakyOnBatch.fails) {
        flakyThrown++
        throw new Error('mock LM transient boom')
      }
      if (opts.throwOnBatch === idx) throw new Error('mock LM boom')
      batchCount++
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
    const r = await translateSubtitle(SOURCE, {}, lm, { retryDelayMs: () => 0 })
    expect(r.verdict).toBe('held')
    expect(r.translatedSrt).toBeNull()
  })

  it('零 cue 输入 → held(审计🟡 vacuous pass:空字幕不得走 installed 成功路径)', async () => {
    const r = await translateSubtitle('not a srt at all\n\nno cues here', {}, makeMockLM())
    expect(r.verdict).toBe('held')
    expect(r.translatedSrt).toBeNull()
    expect(r.reason).toContain('0 条 cue')
  })
})

describe('translateSubtitle — 批次瞬时失败重试(一次抖动不死整档)', () => {
  it('批次首次抛错、重试后成功 → installed(真机逼出:136 批长跑,单次网关抖动曾 false-hold 整档)', async () => {
    const attemptsLog: number[] = []
    const lm = makeMockLM({ flakyOnBatch: { idx: 0, fails: 1 }, attemptsLog })
    const r = await translateSubtitle(SOURCE, {}, lm, { retryDelayMs: () => 0 })
    expect(r.verdict).toBe('installed')
    expect(r.translatedSrt).not.toBeNull()
    // batch0 被调了 2 次(1 败 1 成),之后正常
    expect(attemptsLog.filter((i) => i === 0).length).toBe(2)
  })

  it('重试次数用尽仍抛错 → held(fail-closed 不变),调用次数 = 1 + 重试上限,reason 带原始错误', async () => {
    const attemptsLog: number[] = []
    const lm = makeMockLM({ flakyOnBatch: { idx: 0, fails: 99 }, attemptsLog })
    const r = await translateSubtitle(SOURCE, {}, lm, { retryDelayMs: () => 0 })
    expect(r.verdict).toBe('held')
    expect(r.translatedSrt).toBeNull()
    expect(attemptsLog.length).toBe(3) // 默认 2 次重试 → 共 3 次尝试
    expect(r.reason).toContain('LM 翻译失败(批次抛错)')
    expect(r.reason).toContain('mock LM transient boom')
  })

  it('默认 retryDelayMs 递增(429/网关抖动需要喘息,不背靠背秒发)', async () => {
    expect(defaultRetryDelayMs(1)).toBe(3000)
    expect(defaultRetryDelayMs(2)).toBe(5000)
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

describe('translateSubtitle — F2 源语言参数化(Reality Checker:三跳管线必须有断言)', () => {
  it('ctx.sourceLangName 到达 translateBatch 第 4 参(glossary 同 ctx 语义)', async () => {
    const seen: (string | undefined)[] = []
    const lm: TranslationLM = {
      async buildGlossary(_src, ctx) { seen.push(ctx.sourceLangName); return [] },
      async translateBatch(batch, _g, _s, lang) {
        seen.push(lang)
        return { cues: batch.map((c) => ({ ...c, text: ['译' + c.text.join('')] })), summary: '' }
      },
    }
    await translateSubtitle(SOURCE, { sourceLangName: '日文' }, lm)
    expect(seen).toEqual(['日文', '日文', '日文']) // glossary + 两个 batch
  })

  it('ctx.sourceLangName 到达 critic.review 第 4 参', async () => {
    let seenLang: string | undefined
    const critic: TranslationCritic = {
      async review(_s, _c, _g, lang) { seenLang = lang; return { ok: true, issues: [] } },
    }
    await translateSubtitle(SOURCE, { sourceLangName: '日文' }, makeMockLM(), { critic })
    expect(seenLang).toBe('日文')
  })

  it('缺省不传 sourceLangName → LM/critic 收到 undefined(上游默认英文,向后兼容)', async () => {
    const seen: (string | undefined)[] = []
    const lm: TranslationLM = {
      async buildGlossary(_s, ctx) { seen.push(ctx.sourceLangName); return [] },
      async translateBatch(batch, _g, _s, lang) {
        seen.push(lang)
        return { cues: batch.map((c) => ({ ...c, text: ['x' + c.text.join('')] })), summary: '' }
      },
    }
    await translateSubtitle(SOURCE, {}, lm)
    expect(seen.every((v) => v === undefined)).toBe(true)
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

describe('translateSubtitle — ASS/SSA override 剥离(装入 SRT 前)', () => {
  const assSource = [
    '1', '00:00:01,000 --> 00:00:03,000', 'Dialogue {\\an8}Hello', '',
    '2', '00:00:04,000 --> 00:00:06,000', 'Keep {literal} braces', '',
    '3', '00:00:07,000 --> 00:00:09,000', 'Multi {\\an8\\blur4\\pos(1,2)}Line', '',
  ].join('\n')

  function passthroughLM(overrideTexts?: string[]): TranslationLM {
    return {
      async buildGlossary() { return [] },
      async translateBatch(batch) {
        if (!overrideTexts) {
          return { cues: batch.map((c) => ({ ...c, text: [...c.text] })), summary: '' }
        }
        return {
          cues: batch.map((c, i) => ({
            ...c,
            text: [overrideTexts[Number(c.index) - 1] ?? c.text.join('')],
          })),
          summary: '',
        }
      },
    }
  }

  it('Dialogue {\\an8}Hello → installed SRT 为 Dialogue Hello;条数/时轴不变', async () => {
    const r = await translateSubtitle(assSource, {}, passthroughLM())
    expect(r.verdict).toBe('installed')
    expect(r.translatedSrt).not.toBeNull()
    const cues = parseSrtCues(r.translatedSrt!)
    expect(cues).toHaveLength(3)
    expect(cues[0].text.join('\n')).toBe('Dialogue Hello')
    expect(cues[0].timing).toBe('00:00:01,000 --> 00:00:03,000')
    expect(cues[0].index).toBe('1')
    expect(cues[1].timing).toBe('00:00:04,000 --> 00:00:06,000')
    expect(cues[2].timing).toBe('00:00:07,000 --> 00:00:09,000')
  })

  it('普通 {literal} 保留(非 ASS override)', async () => {
    const r = await translateSubtitle(assSource, {}, passthroughLM())
    expect(r.verdict).toBe('installed')
    const cues = parseSrtCues(r.translatedSrt!)
    expect(cues[1].text.join('\n')).toBe('Keep {literal} braces')
  })

  it('多命令 override 块 {\\an8\\blur4\\pos(1,2)} 整块剥离', async () => {
    const r = await translateSubtitle(assSource, {}, passthroughLM())
    expect(r.verdict).toBe('installed')
    const cues = parseSrtCues(r.translatedSrt!)
    expect(cues[2].text.join('\n')).toBe('Multi Line')
    expect(cues[2].text.join('\n')).not.toMatch(/\\an8|\\blur|\\pos/)
  })

  it('仅 override / 剥离后空白的 cue → held(不装)', async () => {
    const onlyOverride = [
      '1', '00:00:01,000 --> 00:00:03,000', 'Hello world', '',
      '2', '00:00:04,000 --> 00:00:06,000', '{\\an8}', '',
    ].join('\n')
    const lm: TranslationLM = {
      async buildGlossary() { return [] },
      async translateBatch(batch) {
        return {
          cues: batch.map((c) => ({
            ...c,
            text: c.index === '2' ? ['{\\an8}'] : c.text.map((l) => l),
          })),
          summary: '',
        }
      },
    }
    const r = await translateSubtitle(onlyOverride, {}, lm)
    expect(r.verdict).toBe('held')
    expect(r.translatedSrt).toBeNull()
    expect(r.gate.verdict).toBe('fail')
  })
})
