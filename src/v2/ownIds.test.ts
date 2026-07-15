import { describe, it, expect } from 'vitest'
import { seriesId, episodeId, tmdbIdFromOwnId } from './ownIds.js'

describe('ownIds', () => {
  describe('seriesId', () => {
    it('形状 tmdb:<id>（movies 复用同一构造器，语义相同）', () => {
      expect(seriesId('209867')).toBe('tmdb:209867')
    })
  })

  describe('episodeId', () => {
    it('形状 tmdb:<id>/s<N>e<M>，不做零填充', () => {
      expect(episodeId('209867', 1, 2)).toBe('tmdb:209867/s1e2')
    })
    it('两位数季/集同样不零填充', () => {
      expect(episodeId('209867', 12, 34)).toBe('tmdb:209867/s12e34')
    })
    it('season/episode = 0 时原样嵌入（非法值判断不是本函数的事）', () => {
      expect(episodeId('1', 0, 0)).toBe('tmdb:1/s0e0')
    })
  })

  describe('tmdbIdFromOwnId', () => {
    it('从 series/movies 形状 (tmdb:<id>) 提取 id', () => {
      expect(tmdbIdFromOwnId('tmdb:209867')).toBe('209867')
    })
    it('从 episodes 形状 (tmdb:<id>/s<N>e<M>) 提取 id（丢弃季集段）', () => {
      expect(tmdbIdFromOwnId('tmdb:209867/s1e2')).toBe('209867')
      expect(tmdbIdFromOwnId('tmdb:209867/s12e34')).toBe('209867')
    })
    it('非自有 id 形状返回 null，不抛错（如遗留合成 id self-scan-trigger）', () => {
      expect(tmdbIdFromOwnId('self-scan-trigger')).toBeNull()
    })
    it('其他不合规输入同样返回 null：空串、纯前缀、多余段、缺 tmdb: 前缀', () => {
      expect(tmdbIdFromOwnId('')).toBeNull()
      expect(tmdbIdFromOwnId('tmdb:')).toBeNull()
      expect(tmdbIdFromOwnId('tmdb:1/s1e2/extra')).toBeNull()
      expect(tmdbIdFromOwnId('jellyfin-item-id-123')).toBeNull()
    })
    it('roundtrips with seriesId/episodeId constructors', () => {
      expect(tmdbIdFromOwnId(seriesId('42'))).toBe('42')
      expect(tmdbIdFromOwnId(episodeId('42', 3, 7))).toBe('42')
    })
  })
})
