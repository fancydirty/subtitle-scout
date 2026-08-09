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
    // R18（2026-08-08）：这里原本断言 prompt 必须含 `fallback` ——那是在守旧行为。
    // eng 兜底已废止，resolver 不再返回 `fallback:`；prompt 若还教模型"会有英文兜底、
    // 要靠 context 硬撑"，模型拿到 no-source 时会把终局当成工具故障去重试或绕过，
    // 而"靠 context 补偿二次转译"正是 R18 判定为"悄悄降质却假装成功"的那套心法。
    // 故改为断言**禁止中继**的措辞在场：这是 prompt 与工具行为一致的凭据。
    expect(c).toMatch(/forbidden|no-source/)
    expect(c).not.toMatch(/fallback:/)
    expect(c).toMatch(/violations/)
    expect(c).toMatch(/Repair loop|修复/)
    expect(c).toMatch(/missAtCues/)
    expect(c).toMatch(/session capacity|too long|3000/)
    // 翻译哲学锚点:术语表管怎么译不管必须译;代词/省略可以;系统性丢名不行;密度由闸裁决
    expect(c).toMatch(/how.*render|怎么译|governs/)
    expect(c).toMatch(/pronouns|ellipsis|代词|省略/)
    expect(c).toMatch(/naturalness"?\s*as an excuse/)
    expect(c).toMatch(/gate's call|闸.*裁决/)
    expect(c).toMatch(/glossary|术语/)
    expect(c).toMatch(/freeze|冻结/)
    expect(c).toMatch(/Simplified-Chinese|简中|中文译名/)
    expect(c).toMatch(/keepOriginal/)
    expect(c).toMatch(/bilingual|update_row|工作表/)
    expect(c).toMatch(/source_clean|agent_view|staging/)
    expect(c).toMatch(/merge|merge_to_srt/)
    expect(c).not.toMatch(/brave search api/i)
  })
})
