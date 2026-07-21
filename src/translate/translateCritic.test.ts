import { describe, it, expect } from 'vitest'
import { parseCriticResponse } from './translateCritic.js'

describe('parseCriticResponse — 容错解析 LLM-judge 判词', () => {
  it('有 major 问题 → ok=false', () => {
    const raw = '[{"i":"5","severity":"major","kind":"awkward","note":"打孔在地球上 生硬"}]'
    const v = parseCriticResponse(raw)
    expect(v.ok).toBe(false)
    expect(v.issues).toHaveLength(1)
    expect(v.issues[0]).toMatchObject({ cueIndex: '5', severity: 'major', kind: 'awkward' })
  })

  it('只有 minor 问题 → ok=true(不否决)', () => {
    const raw = '[{"i":"3","severity":"minor","kind":"style","note":"可更口语"}]'
    const v = parseCriticResponse(raw)
    expect(v.ok).toBe(true)
    expect(v.issues).toHaveLength(1)
  })

  it('空问题数组 → ok=true', () => {
    expect(parseCriticResponse('[]')).toEqual({ ok: true, issues: [] })
  })

  it('```json 围栏 + 散文', () => {
    const v = parseCriticResponse('审阅完毕:\n```json\n[{"i":"1","severity":"major","kind":"mistranslation","note":"意思反了"}]\n```')
    expect(v.ok).toBe(false)
  })

  it('解析不出 → 优雅降级 ok=true(判官输出坏不阻塞已过确定性闸的译文)', () => {
    expect(parseCriticResponse('我觉得翻译得不错')).toEqual({ ok: true, issues: [] })
  })

  it('未知 severity 归一为 minor(不误升级成否决)', () => {
    const v = parseCriticResponse('[{"i":"2","severity":"whatever","kind":"x","note":"n"}]')
    expect(v.ok).toBe(true)
    expect(v.issues[0].severity).toBe('minor')
  })
})
