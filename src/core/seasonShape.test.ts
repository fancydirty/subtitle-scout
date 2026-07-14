import { describe, it, expect } from 'vitest'
import { mirrorExceedsSeasonTable } from './seasonShape.js'

describe('mirrorExceedsSeasonTable', () => {
  it('镜像集数 > TMDB → true', () => {
    expect(mirrorExceedsSeasonTable({ seriesId: 's1', season: 1, mirrorEpisodeCount: 40, tmdbEpisodeCount: 25 })).toBe(true)
  })
  it('镜像集数 <= TMDB → false', () => {
    expect(mirrorExceedsSeasonTable({ seriesId: 's1', season: 1, mirrorEpisodeCount: 12, tmdbEpisodeCount: 25 })).toBe(false)
  })
  it('tmdbEpisodeCount 未知（null）→ false（没有确定性信号，不猜）', () => {
    expect(mirrorExceedsSeasonTable({ seriesId: 's1', season: 1, mirrorEpisodeCount: 40, tmdbEpisodeCount: null })).toBe(false)
  })
})
