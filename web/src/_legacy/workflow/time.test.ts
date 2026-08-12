import { describe, it, expect } from 'vitest'
import { relativeAgo, formatNextRecheck, formatTookMs, formatResetsIn } from './time.js'

describe('relativeAgo', () => {
  it('< 5s → "just now"', () => {
    expect(relativeAgo(0)).toBe('just now')
    expect(relativeAgo(4_000)).toBe('just now')
  })
  it('秒/分/时/天各档', () => {
    expect(relativeAgo(30_000)).toBe('30s ago')
    expect(relativeAgo(90_000)).toBe('1m ago')
    expect(relativeAgo(2 * 60 * 60_000)).toBe('2h ago')
    expect(relativeAgo(3 * 24 * 60 * 60_000)).toBe('3d ago')
  })
  it('负数 clamp 到 0', () => {
    expect(relativeAgo(-100)).toBe('just now')
  })
})

describe('formatNextRecheck', () => {
  it('前缀恒为 "next recheck in "（跟 Library 区 library_detail_next_recheck_prefix 措辞一致）', () => {
    expect(formatNextRecheck(30_000)).toBe('next recheck in 30s')
    expect(formatNextRecheck(90_000)).toBe('next recheck in 1m')
    expect(formatNextRecheck(2 * 60 * 60_000)).toBe('next recheck in 2h')
    expect(formatNextRecheck(3 * 24 * 60 * 60_000)).toBe('next recheck in 3d')
  })
  it('负数（理论上不该发生）clamp 到 0', () => {
    expect(formatNextRecheck(-1000)).toBe('next recheck in 0s')
  })
})

describe('formatResetsIn', () => {
  it('秒/分/时/天各档', () => {
    expect(formatResetsIn(30_000)).toBe('resets in 30s')
    expect(formatResetsIn(90_000)).toBe('resets in 1m')
    expect(formatResetsIn(2 * 60 * 60_000)).toBe('resets in 2h')
    expect(formatResetsIn(3 * 24 * 60 * 60_000)).toBe('resets in 3d')
  })
  it('负数（理论上不该发生）clamp 到 0', () => {
    expect(formatResetsIn(-1000)).toBe('resets in 0s')
  })
})

describe('formatTookMs', () => {
  it('< 1000ms → 整数毫秒', () => {
    expect(formatTookMs(840)).toBe('840ms')
    expect(formatTookMs(4)).toBe('4ms')
  })
  it('>= 1000ms → 秒，一位小数', () => {
    expect(formatTookMs(1200)).toBe('1.2s')
    expect(formatTookMs(5000)).toBe('5.0s')
  })
})
