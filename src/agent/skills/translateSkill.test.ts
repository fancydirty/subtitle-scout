import { describe, expect, it } from 'vitest'
import { translateSkill } from './translateSkill.js'

describe('translateSkill', () => {
  it('descriptor name is translate-workspace', () => {
    expect(translateSkill.descriptor.name).toBe('translate-workspace')
    expect(translateSkill.descriptor.description.length).toBeGreaterThan(20)
  })

  it('playbook anchors: single-hop, no Brave, workspace docs, glossary freeze, rows, no hand SRT', () => {
    const c = translateSkill.content
    expect(c).toMatch(/single-hop|单跳/i)
    expect(c).toMatch(/origin_lang|源语言/)
    expect(c).toMatch(/jimaku|Japanese|日/)
    expect(c).toMatch(/must not|禁止|never/i)
    expect(c).toMatch(/English|英/)
    expect(c).toMatch(/Brave|web_search|通用搜索/)
    expect(c).toMatch(/glossary|术语/)
    expect(c).toMatch(/freeze|冻结/)
    expect(c).toMatch(/bilingual|update_row|工作表/)
    expect(c).toMatch(/source_clean|agent_view|staging/)
    expect(c).toMatch(/merge|merge_to_srt/)
    expect(c).not.toMatch(/brave search api/i)
  })
})
