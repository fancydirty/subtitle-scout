import { describe, it, expect } from 'vitest'
import { en } from './en.js'
import { zh } from './zh.js'

describe('i18n 完整性', () => {
  it('zh/en 键集合完全一致', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('zh 的 Workflow 区键值 === en 对应值（DESIGN.md §7：Workflow 区永不本地化）', () => {
    const workflowKeys = Object.keys(en).filter((k) => k.startsWith('workflow_')) as (keyof typeof en)[]
    expect(workflowKeys.length).toBeGreaterThan(0)
    for (const key of workflowKeys) {
      expect(zh[key]).toBe(en[key])
    }
  })
})
