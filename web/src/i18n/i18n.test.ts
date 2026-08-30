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

  // ── Task 7：活动卡 ticker 词表（wb_ticker_*）──────────────────────────────
  // 这四键是 tickerPhrase 带对象时的短语键。⚠️ t() 不支持插值（useT.ts 头注释），
  // 所以它们**必须是可后接对象的短语**，不许含 {obj} 占位——调用方拼 `{t(key)} {obj}`。
  // 含占位符的话界面上会原样画出 "Searching for {obj}"。
  it('wb_ticker_* 四键两侧齐备', () => {
    const tickerKeys = ['wb_ticker_search', 'wb_ticker_download', 'wb_ticker_review', 'wb_ticker_install'] as const
    for (const key of tickerKeys) {
      expect(en[key], `en 缺 ${key}`).toBeTruthy()
      expect(zh[key], `zh 缺 ${key}`).toBeTruthy()
    }
  })
  it('wb_ticker_* 不含 {obj} 占位（t() 不插值，占位符会原样上屏）', () => {
    const tickerKeys = ['wb_ticker_search', 'wb_ticker_download', 'wb_ticker_review', 'wb_ticker_install'] as const
    for (const key of tickerKeys) {
      expect(en[key]).not.toContain('{')
      expect(zh[key]).not.toContain('{')
    }
  })
})
