import { describe, it, expect } from 'vitest'
import { systemPromptSkillIndex, makeReadDocTool } from './registry.js'
import type { Skill } from './types.js'

const skillA: Skill = { descriptor: { name: 'a', description: 'does a things' }, content: 'A full text' }
const skillB: Skill = { descriptor: { name: 'b', description: 'does b things' }, content: 'B full text' }

describe('systemPromptSkillIndex', () => {
  it('renders a compact name+description list, not full content', () => {
    const index = systemPromptSkillIndex([skillA, skillB])
    expect(index).toContain('a: does a things')
    expect(index).toContain('b: does b things')
    expect(index).not.toContain('A full text')
  })
})

describe('makeReadDocTool', () => {
  it('returns the full content for a known skill name', async () => {
    const readDoc = makeReadDocTool([skillA, skillB])
    const result = await readDoc.execute!({ name: 'b' }, { toolCallId: 't1', messages: [] } as any)
    expect(result).toEqual({ name: 'b', content: 'B full text' })
  })

  it('reports available names on an unknown skill name (fail-soft, not a thrown error)', async () => {
    const readDoc = makeReadDocTool([skillA, skillB])
    const result = await readDoc.execute!({ name: 'nope' }, { toolCallId: 't1', messages: [] } as any)
    expect(result).toEqual({ error: 'unknown skill: nope. Available: a, b' })
  })
})
