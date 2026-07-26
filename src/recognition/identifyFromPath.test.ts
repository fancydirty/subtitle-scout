import { describe, it, expect } from 'vitest'
import { identifyFromPath, isCanonicalEpisodePath, type Park, type PathIdentity } from './identifyFromPath.js'

function isPark(result: PathIdentity | Park): result is Park {
  return 'park' in result
}

describe('identifyFromPath — Show/Season NN/file layout', () => {
  it('grandparent title + season-folder parent + bare-episode file (CJK title)', () => {
    const r = identifyFromPath('间谍过家家/Season 1/ep 1.mp4')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('间谍过家家')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(1)
    expect(identity.isTv).toBe(true)
  })

  it('embedded [tmdbid-N] short-circuits search but season/episode still merge from structure', () => {
    const r = identifyFromPath('Show (2016) [tmdbid-65930]/Season 02/Show S02E03.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.embeddedTmdbId).toBe('65930')
    expect(identity.season).toBe(2)
    expect(identity.episode).toBe(3)
    expect(identity.title).toBe('Show')
    expect(identity.year).toBe(2016)
    expect(identity.isTv).toBe(true)
  })

  it('CJK bare-episode fallback via "第N话" marker inside a season folder', () => {
    const r = identifyFromPath('间谍过家家/Season 2/第3话.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('间谍过家家')
    expect(identity.season).toBe(2)
    expect(identity.episode).toBe(3)
    expect(identity.isTv).toBe(true)
  })

  it('"Specials" folder maps to season 0, bare-episode file still resolves against it', () => {
    const r = identifyFromPath('间谍过家家/Specials/ep 1.mp4')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('间谍过家家')
    expect(identity.season).toBe(0)
    expect(identity.episode).toBe(1)
    expect(identity.isTv).toBe(true)
  })
})

describe('identifyFromPath — Show/file.mkv layout (no season folder)', () => {
  it('title comes from the parent dir when the file segment has no movie-like year', () => {
    const r = identifyFromPath('Breaking Bad/Breaking.Bad.S01E05.720p.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Breaking Bad')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(5)
    expect(identity.isTv).toBe(true)
  })

  it('anime absolute numbering: title from parent dir, absoluteEpisode from the file, no season', () => {
    const r = identifyFromPath('My Hero Academia/[SubGroup] My Hero Academia - 26 [ABCD1234].mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('My Hero Academia')
    expect(identity.absoluteEpisode).toBe(26)
    expect(identity.season).toBeNull()
    expect(identity.isTv).toBe(true)
  })
})

describe('identifyFromPath — flat movie layout', () => {
  it('title+year come from the FILE segment, not the "movies" category-root parent', () => {
    const r = identifyFromPath('movies/Hero.2002.1080p.BluRay.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Hero')
    expect(identity.year).toBe(2002)
    expect(identity.isTv).toBe(false)
    expect(identity.season).toBeNull()
    expect(identity.episode).toBeNull()
  })
})

describe('identifyFromPath — 系统性 bug 暴露（这些场景此前全部识别错）', () => {
  it('分类目录 tv/ 不得当标题——文件的 S01E01 title 优先（此前识别成 "tv"）', () => {
    const r = identifyFromPath('tv/Witch Watch S01E02.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Witch Watch')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(2)
  })

  it('中文目录名被轮子截断时，文件的 title 优先（此前铁拳教育识别成 "铁."）', () => {
    const r = identifyFromPath('铁拳教育 (2026) 4K HDR10/Teach.You.a.Lesson.S01E01.2160p.WEB-DL.HDR10.H265.DDP5.1.Atmos.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Teach You a Lesson')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(1)
  })

  it('中文季目录"第N集"被 detectSeasonFolder 识别，不再当标题（此前莉可丽丝识别成"第1集"）', () => {
    const r = identifyFromPath('莉可丽丝 蓝光原盘REMUX [内封简日双字]/第1集/Lycoris.Recoil.S01E01.2022.1080p.BluRay.REMUX.AVC.DTS-HD.MA.LPCM.2.0.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Lycoris Recoil')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(1)
  })

  it('分类目录 movies/ 下的电影仍用文件 title（flat movie 原有行为不回归）', () => {
    const r = identifyFromPath('movies/Hero.2002.1080p.BluRay.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Hero')
    expect(identity.year).toBe(2002)
  })

  it('目录名是正确剧名时仍可用（fallback 保留—— Breaking Bad 原有行为）', () => {
    const r = identifyFromPath('Breaking Bad/Breaking.Bad.S01E05.720p.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Breaking Bad')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(5)
  })

  it('中文季目录"第N季"也被 detectSeasonFolder 识别', () => {
    const r = identifyFromPath('某剧/第2季/ep 3.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('某剧')
    expect(identity.season).toBe(2)
    expect(identity.episode).toBe(3)
  })
})

describe('identifyFromPath — park on no signal', () => {
  it('no embedded id, no season/episode/absoluteEpisode, no year anywhere -> parked', () => {
    const r = identifyFromPath('movies/aaa/bbb.mkv')
    expect(r).toEqual({ park: 'no-signal' })
  })
})

describe('identifyFromPath — path-string edge cases (node:path posix handling)', () => {
  it('Windows-style backslash path resolves the same as its POSIX equivalent', () => {
    const r = identifyFromPath('C:\\Media\\Breaking Bad\\Breaking.Bad.S01E05.720p.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Breaking Bad')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(5)
  })

  it('absolute POSIX path with a leading slash and a stray trailing slash both resolve fine', () => {
    const r = identifyFromPath('/mnt/media/Breaking Bad/Breaking.Bad.S01E05.720p.mkv/')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Breaking Bad')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(5)
  })
})

// 债务D1（realign 出生信号换代）：isCanonicalEpisodePath 是识别层本来就看得见的并列事实——
// 规范形 = `Show (Year) [tmdbid-N]/Season NN/<file>`（buildTargetShowDir 自产的形状）。只报
// 事实，不判断要不要 realign（那永远归 orchestrator）。
describe('isCanonicalEpisodePath', () => {
  it('Show (2020) [tmdbid-9]/Season 01/file → true', () => {
    expect(isCanonicalEpisodePath('Show (2020) [tmdbid-9]/Season 01/file.mkv')).toBe(true)
  })

  it('绝对编号平铺（无季夹层）→ false', () => {
    expect(isCanonicalEpisodePath('Show (2020) [tmdbid-9]/ep 26.mkv')).toBe(false)
  })

  it('有季夹层但 show 目录无 tmdbid 标签 → false', () => {
    expect(isCanonicalEpisodePath('Show (2020)/Season 01/file.mkv')).toBe(false)
  })

  it('Windows 反斜杠路径同样工作', () => {
    expect(isCanonicalEpisodePath('C:\\Media\\Show (2020) [tmdbid-9]\\Season 01\\file.mkv')).toBe(true)
  })
})
