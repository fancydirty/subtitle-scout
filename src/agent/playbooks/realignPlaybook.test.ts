import { describe, it, expect } from 'vitest'
import { REALIGN_PLAYBOOK } from './realignPlaybook.js'

describe('REALIGN_PLAYBOOK', () => {
  it('是非空字符串常量', () => {
    expect(typeof REALIGN_PLAYBOOK).toBe('string')
    expect(REALIGN_PLAYBOOK.length).toBeGreaterThan(200)
  })
  it('包含症状→检查→分类→处方四段结构', () => {
    expect(REALIGN_PLAYBOOK).toContain('症状')
    expect(REALIGN_PLAYBOOK).toContain('检查')
    expect(REALIGN_PLAYBOOK).toContain('分类')
    expect(REALIGN_PLAYBOOK).toContain('处方')
  })
  it('提到判决枚举 absolute_flat / unknown', () => {
    expect(REALIGN_PLAYBOOK).toContain('absolute_flat')
    expect(REALIGN_PLAYBOOK).toContain('unknown')
  })
  it('明示 LLM 无权推翻确定性闸门', () => {
    expect(REALIGN_PLAYBOOK).toMatch(/闸门|gate/)
  })
})
