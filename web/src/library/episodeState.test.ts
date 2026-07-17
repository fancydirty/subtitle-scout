// web/src/library/episodeState.test.ts
import { describe, it, expect } from 'vitest'
import { buildGridCells, tallyGridCells, isCanonicalPending, type EpisodeCellState } from './episodeState.js'
import type { LibrarySeasonDTO } from '../api/types.js'

const NOW = 1_700_000_000_000

function season(overrides: Partial<LibrarySeasonDTO> = {}): LibrarySeasonDTO {
  return { season: 1, canonical: [], onDisk: [], coverage: [], ...overrides }
}

describe('buildGridCells（三层合成：canonical ∪ 磁盘）', () => {
  it('canonical 8 集 / 磁盘 6 集（4 covered + 2 missing）→ 8 格，2 dashed，4 绿点，2 灰', () => {
    const s = season({
      canonical: Array.from({ length: 8 }, (_, i) => ({ episode: i + 1, title: `E${i + 1}` })),
      onDisk: [
        { episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null },
        { episode: 2, path: '/m/e2.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null },
        { episode: 3, path: '/m/e3.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null },
        { episode: 4, path: '/m/e4.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null },
        { episode: 5, path: '/m/e5.mkv', subStatus: 'missing', statusReason: null, recheckAfter: null },
        { episode: 6, path: '/m/e6.mkv', subStatus: 'missing', statusReason: null, recheckAfter: null },
      ],
      coverage: [
        { episode: 1, lang: 'zh-Hans', path: '/m/e1.zh-Hans.ass' },
        { episode: 2, lang: 'zh-Hans', path: '/m/e2.zh-Hans.ass' },
        { episode: 3, lang: 'zh-Hans', path: '/m/e3.zh-Hans.ass' },
        { episode: 4, lang: 'zh-Hans', path: '/m/e4.zh-Hans.ass' },
      ],
    })

    const cells = buildGridCells(s, NOW)
    expect(cells).toHaveLength(8)
    expect(cells.map((c) => c.episode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    const tally = tallyGridCells(cells)
    expect(tally.total).toBe(8)
    expect(tally.dashed).toBe(2)
    expect(tally.covered).toBe(4)
    expect(tally.missing).toBe(2)
    expect(tally.hardsub).toBe(0)
    expect(tally.throttled).toBe(0)
    expect(tally.error).toBe(0)

    // dashed 格是 7、8（canonical 有，磁盘无）
    const dashedEpisodes = cells.filter((c) => c.state === 'dashed').map((c) => c.episode)
    expect(dashedEpisodes).toEqual([7, 8])
  })

  it('unavailable + recheckAfter 在未来 → throttled（灰点，不是失败态）', () => {
    const s = season({
      canonical: [{ episode: 1, title: 'E1' }],
      onDisk: [
        {
          episode: 1, path: '/m/e1.mkv', subStatus: 'unavailable',
          statusReason: 'no safe match', recheckAfter: NOW + 3 * 86_400_000,
        },
      ],
    })
    const [cell] = buildGridCells(s, NOW)
    expect(cell.state).toBe('throttled')
  })

  it('unavailable + recheckAfter 已到期 → missing（可复查，不是停牌中）', () => {
    const s = season({
      canonical: [{ episode: 1, title: 'E1' }],
      onDisk: [
        {
          episode: 1, path: '/m/e1.mkv', subStatus: 'unavailable',
          statusReason: 'no safe match', recheckAfter: NOW - 1000,
        },
      ],
    })
    const [cell] = buildGridCells(s, NOW)
    expect(cell.state).toBe('missing')
  })

  it('embedded/ignored 都算 covered（策略跳过视觉等同已处理）', () => {
    const s = season({
      onDisk: [
        { episode: 1, path: '/m/e1.mkv', subStatus: 'embedded', statusReason: null, recheckAfter: null },
        { episode: 2, path: '/m/e2.mkv', subStatus: 'ignored', statusReason: null, recheckAfter: null },
      ],
    })
    const states = buildGridCells(s, NOW).map((c) => c.state)
    expect(states).toEqual<EpisodeCellState[]>(['covered', 'covered'])
  })

  it('hardsub-assumed → hardsub，且计入 covered 分子', () => {
    const s = season({
      canonical: [{ episode: 1, title: 'E1' }],
      onDisk: [
        {
          episode: 1, path: '/m/e1.mkv', subStatus: 'hardsub-assumed',
          statusReason: 'video stream has Chinese hard subtitles', recheckAfter: null,
        },
      ],
    })
    const cells = buildGridCells(s, NOW)
    expect(cells[0].state).toBe('hardsub')

    const tally = tallyGridCells(cells)
    expect(tally.hardsub).toBe(1)
    expect(tally.covered).toBe(1)
  })

  it('未知 sub_status → error（红点，谨慎兜底，不静默吞掉数据异常）', () => {
    const s = season({
      onDisk: [{ episode: 1, path: '/m/e1.mkv', subStatus: 'weird', statusReason: null, recheckAfter: null }],
    })
    const [cell] = buildGridCells(s, NOW)
    expect(cell.state).toBe('error')
  })

  it('磁盘有但 canonical 没有对应集——不是 dashed（磁盘是事实，照常按 subStatus 判定）', () => {
    const s = season({
      canonical: [{ episode: 1, title: 'E1' }],
      onDisk: [
        { episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null },
        { episode: 2, path: '/m/e2.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null },
      ],
    })
    const cells = buildGridCells(s, NOW)
    expect(cells).toHaveLength(2)
    expect(cells[1]).toMatchObject({ episode: 2, state: 'covered' })
  })
})

describe('isCanonicalPending', () => {
  it('canonical 为空 → true（缓存未建，格阵只按磁盘行渲染）', () => {
    expect(isCanonicalPending(season({ canonical: [] }))).toBe(true)
  })
  it('canonical 非空 → false', () => {
    expect(isCanonicalPending(season({ canonical: [{ episode: 1, title: null }] }))).toBe(false)
  })
})
