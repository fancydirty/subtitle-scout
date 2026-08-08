import { describe, it, expect } from 'vitest'
import { deriveWorkDir, parseStructure, isScannable, singleSeasonOf } from './scanner.js'

const ROOTS = ['/media/Movies', '/media/TV', '/media/anime']

describe('deriveWorkDir（作品根推导，spec-gap M1）', () => {
  it('标准剧：TV/名称/Season 01/E01.mkv → 作品根 = TV/名称', () => {
    expect(deriveWorkDir('/media/TV/Constellation/Season 01/E01.mkv', ROOTS))
      .toBe('/media/TV/Constellation')
  })
  it('扁平剧（无 Season 目录）：TV/名称/SxxEyy.mkv → 作品根 = TV/名称', () => {
    expect(deriveWorkDir('/media/TV/Constellation/Constellation.S01E01.mkv', ROOTS))
      .toBe('/media/TV/Constellation')
  })
  it('电影：Movies/名称 (年份)/movie.mkv → 作品根 = 该电影目录', () => {
    expect(deriveWorkDir('/media/Movies/Pulp Fiction (1994)/Pulp.Fiction.mkv', ROOTS))
      .toBe('/media/Movies/Pulp Fiction (1994)')
  })
  it('扁平电影：Movies/xxx.mkv → 作品根 = Movies（该根下所有扁平文件同根）', () => {
    expect(deriveWorkDir('/media/Movies/loose.movie.2024.mkv', ROOTS))
      .toBe('/media/Movies')
  })
  it('乱布局（Jellyfin 实测案例）：TV/SPY x FAMILY/根目录下的文件 → 作品根 = TV/SPY x FAMILY', () => {
    expect(deriveWorkDir('/media/TV/SPY x FAMILY/[Moozzi2] Spy x Family S2 - 07.mkv', ROOTS))
      .toBe('/media/TV/SPY x FAMILY')
  })
  it('分类桶不吞作品：TV/Show/Season 1/Part 2/ep.mkv → 作品根 = TV/Show', () => {
    expect(deriveWorkDir('/media/TV/Show/Season 1/Part 2/ep.mkv', ROOTS))
      .toBe('/media/TV/Show')
  })
  it('不在任何根内 → 退化为文件所在目录', () => {
    expect(deriveWorkDir('/etc/weird.mkv', ROOTS)).toBe('/etc')
  })
})

describe('parseStructure（Jellyfin 约定解析 + confidence，实测文件名）', () => {
  it('标准 SxxEyy → high', () => {
    const r = parseStructure('/media/TV/Constellation/Constellation.S01E06.2160p.WEB.H265.mkv', ROOTS)
    expect(r.season).toBe(1)
    expect(r.episode).toBe(6)
    expect(r.parseConfidence).toBe('high')
  })
  it('fansub S2 - 07（Jellyfin 实测猜错 S1E10 的）→ low（季可能丢，abs=7）', () => {
    const r = parseStructure('/media/TV/SPY x FAMILY/[Moozzi2] Spy x Family S2 - 07 [ 32 ].mkv', ROOTS)
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
    expect(r.parseConfidence).toBe('low')
  })
  it('fansub Season 3 - 09（Jellyfin 实测全 null 的）→ none', () => {
    const r = parseStructure('/media/TV/SPY x FAMILY/[Erai-raws] Spy x Family Season 3 - 09.mkv', ROOTS)
    expect(r.parseConfidence).toBe('none')
  })
  it('裸集号 [SubsPlease] Show - 01 → low（abs=1）', () => {
    const r = parseStructure('/media/anime/Show/[SubsPlease] Show - 01 [1080p].mkv', ROOTS)
    expect(r.parseConfidence).toBe('low')
  })
  it('电影（无季集号）→ none，但这是正常的（电影没有季集号）', () => {
    const r = parseStructure('/media/Movies/Pulp Fiction (1994)/Pulp.Fiction.1994.mkv', ROOTS)
    expect(r.parseConfidence).toBe('none')
    expect(r.season).toBeNull()
  })
})

describe('isScannable（静默跳过判据，spec-gap B1）', () => {
  it('正常媒体文件 → 可扫', () => {
    expect(isScannable('/media/TV/Show/E01.mkv', 1024 * 1024 * 100).ok).toBe(true)
  })
  it('系统目录 → 跳过', () => {
    expect(isScannable('/media/TV/Show/.subtitle-staging/E01.mkv', 1024 * 1024 * 100).ok).toBe(false)
    expect(isScannable('/media/TV/Show/@eaDir/E01.mkv', 1024 * 1024 * 100).ok).toBe(false)
  })
  it('过小（<10MB）→ 跳过', () => {
    expect(isScannable('/media/TV/Show/E01.mkv', 5 * 1024 * 1024).ok).toBe(false)
  })
})

describe('singleSeasonOf（唯一季推导，Jellyfin 对 Gachiakuta 的做法）', () => {
  it('文件在 Season 01/ 子目录下 → 直接归该季', () => {
    
    expect(singleSeasonOf('/media/TV/Show/Season 01/E05.mkv')).toBe(1)
    expect(singleSeasonOf('/media/TV/Show/Season 02/E05.mkv')).toBe(2)
  })
  it('文件在作品根下 + 唯一 Season 目录 → 归该季（115 Anime 全部单季）', () => {
    
    const listDir = (dir: string) => {
      if (dir.endsWith('Show')) return ['Season 01', 'poster.jpg']
      return []
    }
    expect(singleSeasonOf('/media/TV/Show/E05.mkv', listDir)).toBe(1)
  })
  it('多个 Season 目录 → 无法机械判，返回 null', () => {
    
    const listDir = (dir: string) => dir.endsWith('Show') ? ['Season 01', 'Season 02'] : []
    expect(singleSeasonOf('/media/TV/Show/E05.mkv', listDir)).toBeNull()
  })
  it('无 listDir 能力（纯字符串）→ null（不猜）', () => {
    
    expect(singleSeasonOf('/media/TV/Show/E05.mkv')).toBeNull()
  })
})
