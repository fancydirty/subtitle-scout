import { describe, it, expect } from 'vitest'
import {
  parseSrtCues,
  evaluateTranslationGate,
  type GlossaryTerm,
  type SrtCue,
} from './qualityGate.js'

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

  it('FAIL:<i> 样式标签丢失', () => {
    const noTag = GOOD.map((c, i) => (i === 1 ? { ...c, text: ['自从皮克托发现了它，'] } : c))
    const r = evaluateTranslationGate(source, noTag, GLOSSARY)
    expect(r.verdict).toBe('fail')
    expect(r.hardViolations.some((h) => h.includes('样式标签'))).toBe(true)
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

describe('evaluateTranslationGate — 空术语表', () => {
  it('无术语表时术语层跳过(conformance=100),仅结构/CJK 生效', () => {
    const src = parseSrtCues(SRT)
    const r = evaluateTranslationGate(src, GOOD, [])
    expect(r.glossary.checks).toBe(0)
    expect(r.glossary.conformance).toBe(100)
    expect(r.verdict).toBe('pass')
  })
})
