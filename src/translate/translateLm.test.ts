import { describe, it, expect } from 'vitest'
import { parseGlossaryResponse, reconstructBatch } from './translateLm.js'
import type { SrtCue } from './qualityGate.js'

describe('parseGlossaryResponse — 容错提取术语表', () => {
  it('裸 JSON 数组', () => {
    const out = parseGlossaryResponse('[{"en":"Rose","zh":"罗斯"},{"en":"Pictor","zh":"皮克托","note":"公司"}]')
    expect(out).toEqual([
      { en: 'Rose', zh: '罗斯' },
      { en: 'Pictor', zh: '皮克托', note: '公司' },
    ])
  })

  it('```json 围栏 + 前后散文', () => {
    const raw = '这是术语表:\n```json\n[{"en":"Rose","zh":"罗斯"}]\n```\n希望有用。'
    expect(parseGlossaryResponse(raw)).toEqual([{ en: 'Rose', zh: '罗斯' }])
  })

  it('过滤缺 en/zh 的坏条目', () => {
    const out = parseGlossaryResponse('[{"en":"Rose","zh":"罗斯"},{"en":"","zh":"x"},{"zh":"缺en"},{"en":"A"}]')
    expect(out).toEqual([{ en: 'Rose', zh: '罗斯' }])
  })

  it('解析不出 JSON → 返回空数组(降级,不抛)', () => {
    expect(parseGlossaryResponse('抱歉我无法完成')).toEqual([])
  })
})

const BATCH: SrtCue[] = [
  { index: '1', timing: '00:00:01,000 --> 00:00:03,000', text: ['Rose enters.', 'She is scared.'] },
  { index: '2', timing: '00:00:04,000 --> 00:00:06,000', text: ['<i>Pictor knew.</i>'] },
]

describe('reconstructBatch — 模型只给译文,时轴/序号由原 batch 重建(fail-closed 结构保真)', () => {
  it('按 index 对齐,填模型译文,保留原 index/timing', () => {
    const modelText = '[{"i":"1","zh":"罗斯进来了。\\n她很害怕。"},{"i":"2","zh":"<i>皮克托早就知道。</i>"}]'
    const out = reconstructBatch(modelText, BATCH)
    expect(out).toEqual([
      { index: '1', timing: '00:00:01,000 --> 00:00:03,000', text: ['罗斯进来了。', '她很害怕。'] },
      { index: '2', timing: '00:00:04,000 --> 00:00:06,000', text: ['<i>皮克托早就知道。</i>'] },
    ])
  })

  it('模型漏译某 cue → 该 cue 保留原英文(诚实,不丢结构)', () => {
    const modelText = '[{"i":"1","zh":"罗斯进来了。\\n她很害怕。"}]' // 缺 cue 2
    const out = reconstructBatch(modelText, BATCH)
    expect(out[0].text).toEqual(['罗斯进来了。', '她很害怕。'])
    expect(out[1]).toEqual(BATCH[1]) // 原样保留(英文)
    expect(out).toHaveLength(2) // 结构永远等于原 batch
  })

  it('模型给多余/未知 index → 忽略,只按原 batch 重建', () => {
    const modelText = '[{"i":"1","zh":"a"},{"i":"2","zh":"b"},{"i":"99","zh":"幽灵"}]'
    const out = reconstructBatch(modelText, BATCH)
    expect(out.map((c) => c.index)).toEqual(['1', '2'])
  })

  it('模型输出彻底解析不出 → 整批保留原英文(不抛,fail-closed 上层闸会拦)', () => {
    const out = reconstructBatch('模型崩了', BATCH)
    expect(out).toEqual(BATCH)
  })

  it('```json 围栏也能解析', () => {
    const out = reconstructBatch('```json\n[{"i":"1","zh":"x"},{"i":"2","zh":"y"}]\n```', BATCH)
    expect(out[0].text).toEqual(['x'])
  })
})
