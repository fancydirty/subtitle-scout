import { describe, it, expect } from 'vitest'
import { relTime } from './time.js'

// 固定 now = 2026-07-10 12:00 本地
const now = new Date(2026, 6, 10, 12, 0, 0).getTime()

describe('relTime 中文相对时间', () => {
  it('今天带时刻', () => {
    const t = new Date(2026, 6, 10, 1, 44, 0).getTime()
    expect(relTime(t, now)).toBe('今天 01:44')
  })
  it('昨天带时刻', () => {
    const t = new Date(2026, 6, 9, 23, 5, 0).getTime()
    expect(relTime(t, now)).toBe('昨天 23:05')
  })
  it('更早给 M月D日', () => {
    const t = new Date(2026, 6, 3, 10, 0, 0).getTime()
    expect(relTime(t, now)).toBe('7月3日')
  })
  it('未来时刻（时钟漂移）按今天处理', () => {
    const t = new Date(2026, 6, 10, 13, 30, 0).getTime()
    expect(relTime(t, now)).toBe('今天 13:30')
  })
})
