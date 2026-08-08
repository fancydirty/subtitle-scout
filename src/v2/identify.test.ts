import { describe, it, expect } from 'vitest'
import { titleFromDir, searchCandidates, verifyEvidence, yearFromDir } from './identify.js'

describe('titleFromDir（目录名 → 标题）', () => {
  it('标准电影：Pulp Fiction (1994) → Pulp Fiction', () => {
    expect(titleFromDir('Pulp Fiction (1994)')).toBe('Pulp Fiction')
  })
  it('带 tmdb 标签：后室 (2026) {tmdb-1083381} → 后室', () => {
    expect(titleFromDir('后室 (2026) {tmdb-1083381}')).toBe('后室')
  })
  it('无年份：SPY x FAMILY → SPY x FAMILY', () => {
    expect(titleFromDir('SPY x FAMILY')).toBe('SPY x FAMILY')
  })
  it('中文剧：绝命毒师 (2008) → 绝命毒师', () => {
    expect(titleFromDir('绝命毒师 (2008)')).toBe('绝命毒师')
  })
})

describe('verifyEvidence（双证据核验）', () => {
  it('名字 + 年份吻合 → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:680', title: 'Pulp Fiction', year: 1994, mediaType: 'movie' },
      { dirName: 'Pulp Fiction (1994)', fileCount: 1, seasons: [], hasSeasonDirs: false },
      'Pulp Fiction',
    )).toEqual({ ok: true })
  })
  it('名字 + 类型（TV 目录 + 季目录）→ 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:1396', title: 'Breaking Bad', year: 2008, mediaType: 'tv' },
      { dirName: 'Breaking Bad (2008)', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      'Breaking Bad',
    )).toEqual({ ok: true })
  })
  it('中文目录名配 TMDB 中文别名 → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:1396', title: 'Breaking Bad', year: 2008, mediaType: 'tv' },
      { dirName: '绝命毒师 (2008)', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      '绝命毒师',
      ['绝命毒师', '绝命毒师 第一季'],
    )).toEqual({ ok: true })
  })
  it('名字不匹配 → 拒绝', () => {
    expect(verifyEvidence(
      { id: 'tmdb:999', title: 'Wrong Show', year: 2008, mediaType: 'tv' },
      { dirName: '绝命毒师 (2008)', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      '绝命毒师',
    )).toEqual({ ok: false, reason: expect.stringContaining('title mismatch') })
  })
  it('名字匹配但无独立证据 → 拒绝', () => {
    expect(verifyEvidence(
      { id: 'tmdb:680', title: 'Pulp Fiction', year: null, mediaType: 'movie' },
      { dirName: 'Pulp Fiction', fileCount: 50, seasons: [], hasSeasonDirs: false },
      'Pulp Fiction',
    )).toEqual({ ok: false, reason: expect.stringContaining('no independent') })
  })
})

describe('yearFromDir', () => {
  it('标准年份', () => {
    expect(yearFromDir('Pulp Fiction (1994)')).toBe(1994)
    expect(yearFromDir('后室 (2026) {tmdb-1083381}')).toBe(2026)
  })
  it('无年份 → null', () => {
    expect(yearFromDir('SPY x FAMILY')).toBeNull()
  })
})
