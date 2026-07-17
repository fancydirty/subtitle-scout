// 语义锚点钉死（同 findSubtitleSkill.test.ts 先例）：不逐字锁全文——skill 措辞归主控随时润色，
// 但下面这些判断纪律的锚点句一旦消失，说明 playbook 的骨架被误改，必须让 CI 尖叫。
import { describe, it, expect } from 'vitest'
import { rescueSkill } from './rescueSkill.js'

describe('rescueSkill 语义锚点', () => {
  it('descriptor 形状齐备（progressive disclosure 只暴露 name+description）', () => {
    expect(rescueSkill.descriptor.name).toBe('rescue-identify-playbook')
    expect(rescueSkill.descriptor.description.length).toBeGreaterThan(20)
  })

  it('双证据门槛在场', () => {
    expect(rescueSkill.content).toContain('TWO independent pieces of evidence')
    expect(rescueSkill.content).toContain('One strong match on name alone is NOT enough')
  })

  it('宁停不猜纪律在场（DxD 案教训）', () => {
    expect(rescueSkill.content).toContain('never guess')
    expect(rescueSkill.content).toContain('keep_parked')
  })

  it('特典灰区判据在场（S0 或 ≥15min；时长缺失≠短片）', () => {
    expect(rescueSkill.content).toContain('season 0')
    expect(rescueSkill.content).toContain('15 minutes')
    expect(rescueSkill.content).toContain('durations are null')
  })

  it('finalize 单一生效通道契约在场（决策工具不落库）', () => {
    expect(rescueSkill.content).toContain('VALIDATE and RECORD')
    expect(rescueSkill.content).toContain('finalize exactly')
  })

  it('一目录一认领纪律在场', () => {
    expect(rescueSkill.content).toContain('one claim covers one directory')
  })
})
