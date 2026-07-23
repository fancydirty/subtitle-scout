import { describe, it, expect } from 'vitest'
import {
  parseSrtCues,
  serializeSrtCues,
  evaluateTranslationGate,
  type GlossaryTerm,
  type SrtCue,
} from './qualityGate.js'

describe('serializeSrtCues ↔ parseSrtCues round-trip', () => {
  it('序列化后再解析得回同样的 cue(标准 SRT 形状)', () => {
    const cues: SrtCue[] = [
      { index: '1', timing: '00:00:01,000 --> 00:00:03,500', text: ['第一行', '第二行'] },
      { index: '2', timing: '00:00:04,000 --> 00:00:06,200', text: ['<i>斜体</i>'] },
    ]
    const srt = serializeSrtCues(cues)
    expect(srt).toContain('00:00:01,000 --> 00:00:03,500')
    expect(parseSrtCues(srt)).toEqual(cues)
  })
})

const SRT = [
  '1', '00:00:01,000 --> 00:00:03,500', 'David Coake,', 'Pictor Research and Expansion.', '',
  '2', '00:00:04,000 --> 00:00:06,200', '<i>Ever since Pictor found it,</i>', '',
  '3', '00:00:07,000 --> 00:00:09,000', 'Nature is a war.', '',
].join('\n')

describe('parseSrtCues', () => {
  it('parses index/timing/text and tolerates CRLF', () => {
    const cues = parseSrtCues(SRT.replace(/\n/g, '\r\n'))
    expect(cues).toHaveLength(3)
    expect(cues[0]).toEqual({
      index: '1',
      timing: '00:00:01,000 --> 00:00:03,500',
      text: ['David Coake,', 'Pictor Research and Expansion.'],
    })
    expect(cues[1].text).toEqual(['<i>Ever since Pictor found it,</i>'])
  })

  it('skips blocks without a timing line (headers/garbage)', () => {
    const cues = parseSrtCues('WEBVTT\n\n1\n00:00:01,000 --> 00:00:02,000\nhi\n')
    expect(cues).toHaveLength(1)
    expect(cues[0].text).toEqual(['hi'])
  })
})

const GLOSSARY: GlossaryTerm[] = [
  { en: 'Pictor', zh: '皮克托', note: '公司名' },
  { en: 'Pictor Research and Expansion', zh: '皮克托研究与开发部' },
  { en: 'David Coake', zh: '大卫·科克' },
]

// 一份"好译":术语全用 canonical zh 形、结构逐字节对齐、CJK 合规。
const GOOD: SrtCue[] = [
  { index: '1', timing: '00:00:01,000 --> 00:00:03,500', text: ['大卫·科克，', '皮克托研究与开发部。'] },
  { index: '2', timing: '00:00:04,000 --> 00:00:06,200', text: ['<i>自从皮克托发现了它，</i>'] },
  { index: '3', timing: '00:00:07,000 --> 00:00:09,000', text: ['自然是一场战争。'] },
]

describe('evaluateTranslationGate — 好译放行', () => {
  const source = parseSrtCues(SRT)
  it('PASS:结构完整 + 术语 100% + 标签保留', () => {
    const r = evaluateTranslationGate(source, GOOD, GLOSSARY)
    expect(r.verdict).toBe('pass')
    expect(r.hardViolations).toEqual([])
    expect(r.glossary.conformance).toBe(100)
    expect(r.structural).toEqual({ indexMismatch: 0, timingMismatch: 0, tagMismatch: 0 })
  })
})

describe('evaluateTranslationGate — 专名漂移拦下(fail-closed 命门)', () => {
  const source = parseSrtCues(SRT)
  it('FAIL:Pictor 漂成"皮克特"→ 术语符合率跌破阈值', () => {
    const drifted: SrtCue[] = [
      { index: '1', timing: '00:00:01,000 --> 00:00:03,500', text: ['大卫·科克，', '皮克特研究与扩展部。'] },
      { index: '2', timing: '00:00:04,000 --> 00:00:06,200', text: ['<i>自从皮克特发现了它，</i>'] },
      { index: '3', timing: '00:00:07,000 --> 00:00:09,000', text: ['自然是一场战争。'] },
    ]
    const r = evaluateTranslationGate(source, drifted, GLOSSARY)
    expect(r.verdict).toBe('fail')
    expect(r.glossary.conformance).toBeLessThan(85)
    const pictor = r.glossary.violations.find((v) => v.term === 'Pictor')
    expect(pictor?.missAtCues).toEqual([1, 2])
  })
})

describe('evaluateTranslationGate — 结构违规硬拦', () => {
  const source = parseSrtCues(SRT)
  it('FAIL:条数不符', () => {
    const r = evaluateTranslationGate(source, GOOD.slice(0, 2), GLOSSARY)
    expect(r.verdict).toBe('fail')
    expect(r.hardViolations.some((h) => h.includes('条数不符'))).toBe(true)
  })

  it('FAIL:时轴被改动(须逐字节冻结)', () => {
    const tampered = GOOD.map((c, i) => (i === 1 ? { ...c, timing: '00:00:04,000 --> 00:00:99,999' } : c))
    const r = evaluateTranslationGate(source, tampered, GLOSSARY)
    expect(r.verdict).toBe('fail')
    expect(r.hardViolations.some((h) => h.includes('时轴行不符'))).toBe(true)
  })

  it('样式标签丢失 → soft 告警不硬拦(斜体/粗体是装饰非 corruption;真机实测强弱模型都会偶尔丢)', () => {
    const noTag = GOOD.map((c, i) => (i === 1 ? { ...c, text: ['自从皮克托发现了它，'] } : c))
    const r = evaluateTranslationGate(source, noTag, GLOSSARY)
    expect(r.verdict).toBe('pass') // 仅标签丢失、其余都对 → 不硬拦
    expect(r.structural.tagMismatch).toBe(1)
    expect(r.softWarnings.some((h) => h.includes('样式标签'))).toBe(true)
    expect(r.hardViolations).toEqual([])
  })
})

describe('evaluateTranslationGate — CJK 约束是 soft(不否决)', () => {
  it('超长行/超读速记 soft 告警但仍可 PASS', () => {
    const src: SrtCue[] = [{ index: '1', timing: '00:00:00,000 --> 00:00:01,000', text: ['x'] }]
    const longLine = '这是一条非常非常非常非常非常非常长的中文字幕会超过二十个全角字符上限触发告警'
    const cand: SrtCue[] = [{ index: '1', timing: '00:00:00,000 --> 00:00:01,000', text: [longLine] }]
    const r = evaluateTranslationGate(src, cand, [])
    expect(r.verdict).toBe('pass') // 无硬违规
    expect(r.cjk.overLongLines).toBeGreaterThan(0)
    expect(r.cjk.overCpsCues).toBeGreaterThan(0)
    expect(r.softWarnings.length).toBeGreaterThan(0)
  })
})

describe('evaluateTranslationGate — 非 ASCII 专名也被校验(审计#3)', () => {
  it('FAIL:重音名 Zoë 漂移被抓(旧 \\b 边界会静默跳过该术语)', () => {
    const src = parseSrtCues(
      ['1', '00:00:01,000 --> 00:00:03,000', 'Zoë arrives.', '', '2', '00:00:04,000 --> 00:00:06,000', 'Zoë waves.', ''].join('\n'),
    )
    const cand: SrtCue[] = [
      { index: '1', timing: '00:00:01,000 --> 00:00:03,000', text: ['若伊到了。'] },
      { index: '2', timing: '00:00:04,000 --> 00:00:06,000', text: ['若伊挥手。'] },
    ]
    const r = evaluateTranslationGate(src, cand, [{ en: 'Zoë', zh: '佐伊' }])
    expect(r.glossary.checks).toBe(2) // 被校验(旧实现 \b 边界失效会是 0)
    expect(r.verdict).toBe('fail') // 2/2 漂移 → 系统性漂移硬拦
  })
})

describe('evaluateTranslationGate — 稀有专名系统性漂移不被聚合率稀释(审计#1)', () => {
  it('FAIL:高频名全对 + 稀有名 0/2 漂移,聚合率仍>85% 但 per-term 硬闸拦下', () => {
    const src: SrtCue[] = []
    const cand: SrtCue[] = []
    // 12 条含高频正确术语 Rose→罗斯
    for (let i = 1; i <= 12; i++) {
      const ts = `00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i).padStart(2, '0')},500`
      src.push({ index: String(i), timing: ts, text: ['Rose speaks.'] })
      cand.push({ index: String(i), timing: ts, text: ['罗斯说话。'] })
    }
    // 2 条含稀有关键术语 Pictor,译文漂成"皮克特"
    for (let i = 13; i <= 14; i++) {
      const ts = `00:00:${i},000 --> 00:00:${i},500`
      src.push({ index: String(i), timing: ts, text: ['Pictor did it.'] })
      cand.push({ index: String(i), timing: ts, text: ['皮克特干的。'] })
    }
    const glo = [
      { en: 'Rose', zh: '罗斯' },
      { en: 'Pictor', zh: '皮克托' },
    ]
    const r = evaluateTranslationGate(src, cand, glo)
    expect(r.glossary.conformance).toBeGreaterThan(85) // 聚合 12/14≈85.7% 过阈值
    expect(r.verdict).toBe('fail') // 但 Pictor 0/2 系统性漂移 → 硬拦
    expect(r.hardViolations.some((h) => h.includes('系统性漂移'))).toBe(true)
    const pictor = r.glossary.violations.find((v) => v.term === 'Pictor')
    expect(pictor).toMatchObject({ occurrences: 2, hits: 0 })
  })
})

describe('evaluateTranslationGate — 空术语表', () => {
  it('无术语表时术语层跳过(conformance=100),仅结构/CJK 生效', () => {
    const src = parseSrtCues(SRT)
    const r = evaluateTranslationGate(src, GOOD, [])
    expect(r.glossary.checks).toBe(0)
    expect(r.glossary.conformance).toBe(100)
    expect(r.verdict).toBe('pass')
  })
})

describe('evaluateTranslationGate — 空可见文本硬拦', () => {
  it('FAIL:候选 cue 可见文本为空(仅空白)→ hard violation,不可 vacuous pass', () => {
    const src: SrtCue[] = [
      { index: '1', timing: '00:00:01,000 --> 00:00:03,000', text: ['Hello'] },
    ]
    const cand: SrtCue[] = [
      { index: '1', timing: '00:00:01,000 --> 00:00:03,000', text: ['   '] },
    ]
    const r = evaluateTranslationGate(src, cand, [])
    expect(r.verdict).toBe('fail')
    expect(r.hardViolations.some((h) => h.includes('空') || h.includes('可见'))).toBe(true)
  })

  it('FAIL:候选 cue text 全空数组 → hard violation', () => {
    const src: SrtCue[] = [
      { index: '1', timing: '00:00:01,000 --> 00:00:03,000', text: ['Hello'] },
    ]
    const cand: SrtCue[] = [
      { index: '1', timing: '00:00:01,000 --> 00:00:03,000', text: [] },
    ]
    const r = evaluateTranslationGate(src, cand, [])
    expect(r.verdict).toBe('fail')
    expect(r.hardViolations.length).toBeGreaterThan(0)
  })
})
