import { describe, it, expect } from 'vitest'
import { removeRootConfirmTitle, removeRootResultLabel } from './text.js'

describe('removeRootConfirmTitle', () => {
  it('英文亮出路径', () => {
    expect(removeRootConfirmTitle('/media/tv', 'en')).toBe('Remove "/media/tv"?')
  })
  it('中文亮出路径', () => {
    expect(removeRootConfirmTitle('/media/tv', 'zh')).toBe('删除媒体目录 "/media/tv"？')
  })
})

describe('removeRootResultLabel', () => {
  it('只列非零类别（英文，movies=0 时省略）', () => {
    expect(removeRootResultLabel({ episodes: 42, movies: 0, series: 3, parked: 1 }, 'en')).toBe(
      'removed 42 episodes · 3 series · 1 parked',
    )
  })
  it('单数不加 s', () => {
    expect(removeRootResultLabel({ episodes: 1, movies: 1, series: 1, parked: 0 }, 'en')).toBe(
      'removed 1 episode · 1 movie · 1 series',
    )
  })
  it('全零时给诚实说明而不是空字符串', () => {
    expect(removeRootResultLabel({ episodes: 0, movies: 0, series: 0, parked: 0 }, 'en')).toBe(
      'removed nothing — this root had no indexed rows',
    )
  })
  it('中文：只列非零类别', () => {
    expect(removeRootResultLabel({ episodes: 42, movies: 0, series: 3, parked: 1 }, 'zh')).toBe(
      '已删除 42 集·3 部剧·1 条停车记录',
    )
  })
})
