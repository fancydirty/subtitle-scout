import { describe, it, expect } from 'vitest'
import { displayTitle } from './displayTitle.js'

describe('displayTitle：在跑卡/通知英雄用 scout-lang 选片名（spec §10.2）', () => {
  it('zh prefers chineseTitle', () => {
    expect(displayTitle('zh', 'Cassandra', '黑暗智宅')).toBe('黑暗智宅')
  })
  it('en uses original title', () => {
    expect(displayTitle('en', 'Cassandra', '黑暗智宅')).toBe('Cassandra')
  })
  it('zh falls back to title', () => {
    expect(displayTitle('zh', 'Cassandra', null)).toBe('Cassandra')
  })
})
