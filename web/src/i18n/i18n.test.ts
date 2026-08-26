import { describe, it, expect } from 'vitest'
import { en } from './en.js'
import { zh } from './zh.js'

describe('i18n 完整性', () => {
  it('zh/en 键集合完全一致', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  // 2026-08-26（用户裁决）：产品名不翻译。中文界面沿用英文 wordmark，与同类自托管工具
  // （Bazarr / Sonarr / Emby）的惯例一致，也与官网中文文案保持同一个名字。此前的
  // '字幕助手' 是品类标签而非品牌名，且与官网写法冲突，已撤销。
  it('brand_name 不本地化（用户裁决：中文界面沿用英文 wordmark）', () => {
    expect(zh.brand_name).toBe(en.brand_name)
    expect(en.brand_name).toBe('Subtitle Scout')
  })

  it('zh 的 Workflow 区键值 === en 对应值（DESIGN.md §7：Workflow 区永不本地化）', () => {
    const workflowKeys = Object.keys(en).filter((k) => k.startsWith('workflow_')) as (keyof typeof en)[]
    expect(workflowKeys.length).toBeGreaterThan(0)
    for (const key of workflowKeys) {
      expect(zh[key]).toBe(en[key])
    }
  })
})
