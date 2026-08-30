import { describe, it, expect } from 'vitest'
import { targetKey, targetLabel, isSingleFile, itemIdToKey } from './subtitleTargets.js'

describe('subtitleTargets', () => {
  it('剧集 key/label 用季集号', () => {
    expect(targetKey('tmdb:95897', 1, 2)).toBe('s1e2')
    expect(targetLabel(1, 2)).toBe('S01E02')
  })
  it('电影（无季集）key=movie、label 为空', () => {
    expect(targetKey('tmdb:603', null, null)).toBe('movie')
    expect(targetLabel(null, null)).toBe('')
  })
  it('key 与 FindSubtitleTask.itemId 尾段同构（剧集）', () => {
    const itemId = 'tmdb:95897/s1e2'
    expect(itemId.endsWith('/' + targetKey('tmdb:95897', 1, 2))).toBe(true)
  })
  it('isSingleFile：一个文件即电影形态', () => {
    expect(isSingleFile(1)).toBe(true)
    expect(isSingleFile(38)).toBe(false)
  })
  it('itemIdToKey：report 桶 itemId → 格子 key', () => {
    expect(itemIdToKey('tmdb:95897/s1e2')).toBe('s1e2')
    expect(itemIdToKey('tmdb:603')).toBe('movie')
  })
})
