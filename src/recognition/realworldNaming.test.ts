// 真实世界命名压力测试——用户转存后绝不改名的那些格式。
// 每一条都标注：正确识别应该是什么（ground truth），以及当前算法实际给了什么。
// 目标：识别层在这些输入下，要么给出正确 title/tmdbId，要么诚实 park（绝不猜错）。
import { describe, it, expect } from 'vitest'
import { identifyFromPath, type PathIdentity, type Park } from './identifyFromPath.js'

function isPark(r: PathIdentity | Park): r is Park { return 'park' in r }
function id(r: PathIdentity | Park): PathIdentity {
  if (isPark(r)) throw new Error(`expected identity, got park: ${(r as Park).park}`)
  return r as PathIdentity
}

describe('真实世界命名压力测试（ground truth 来自用户实际资源）', () => {
  // ---- 版权规避乱写（用户绝不改名）----
  it('招z魂z4 → 招魂4（The Conjuring 4），不能误读 z4 为季/集', () => {
    const r = id(identifyFromPath('招z魂z4 (2025) 4K HDR/2025.HDR.2160p.Web.H265.mkv'))
    // 至少要认出这是电影、2025、标题含"招魂"或"The Conjuring"，绝不能 season=20 episode=25
    expect(r.isTv).toBe(false)
    expect(r.year).toBe(2025)
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
    expect(r.title).toBeTruthy()
    expect(r.title).not.toMatch(/20|25/)
  })

  it('H）后丨室（2026）→ 后室（Backrooms 2026），括号乱写不影响', () => {
    const r = id(identifyFromPath('H）后丨室（2026）4K DV HDR 高码率 简英特效/2026.2160p.iT.WEB-DL.DDP.5.1.Atmos.DV.HDR10+.H.265.mkv'))
    expect(r.isTv).toBe(false)
    expect(r.year).toBe(2026)
    expect(r.title).toBeTruthy()
  })

  // ---- fansub 命名（BT 站常态）----
  it('[诸神字幕组][莉可丽丝][01] → Lycoris Recoil E01', () => {
    const r = id(identifyFromPath('anime/[诸神字幕组][莉可丽丝][01][1080P][简繁内封].mkv'))
    expect(r.isTv).toBe(true)
    expect(r.episode ?? r.absoluteEpisode).toBe(1)
    expect(r.title).toMatch(/莉可丽丝|Lycoris/i)
  })

  it('[喵萌奶茶屋][莉可丽丝/Lycoris Recoil][01] → Lycoris Recoil E01', () => {
    const r = id(identifyFromPath('anime/【喵萌奶茶屋】★01月新番★[莉可丽丝/Lycoris Recoil][01][1080p][简日双语].mkv'))
    expect(r.isTv).toBe(true)
    expect(r.episode ?? r.absoluteEpisode).toBe(1)
    expect(r.title).toMatch(/莉可丽丝|Lycoris/i)
  })

  // ---- BT 站合集目录命名 ----
  it('[BT之家]铁拳教育[全10集].Teach.You.a.Lesson.S01 → Teach You a Lesson', () => {
    const r = id(identifyFromPath('[BT之家]铁拳教育[全10集][简繁英字幕].Teach.You.a.Lesson.S01.1080p.NF.WEB-DL.DDP.5.1.Atmos.H.264-BlackTV/Teach.You.a.Lesson.S01E01.1080p.NF.WEB-DL.DDP.5.1.Atmos.H.264-BlackTV.mkv'))
    expect(r.isTv).toBe(true)
    expect(r.title).toMatch(/Teach You a Lesson|铁拳教育/i)
    expect(r.season).toBe(1)
    expect(r.episode).toBe(1)
  })

  it('铁拳教育.S01.1080p/铁拳教育.S01E01 → 铁拳教育（不能截断成"铁"）', () => {
    const r = id(identifyFromPath('铁拳教育.S01.1080p.NF.WEB-DL.DDP.5.1.Atmos.H.264/铁拳教育.S01E01.1080p.mkv'))
    expect(r.isTv).toBe(true)
    expect(r.title).toBe('铁拳教育')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(1)
  })

  // ---- 合集/季包单文件 ----
  it('Teach.You.a.Lesson.S01.COMPLETE → Teach You a Lesson S01（季包）', () => {
    const r = id(identifyFromPath('tv/Teach.You.a.Lesson.S01.COMPLETE.1080p.mkv'))
    expect(r.isTv).toBe(true)
    expect(r.title).toBe('Teach You a Lesson')
    expect(r.season).toBe(1)
  })

  // ---- 极端/边缘 ----
  it('怪奇物语.S04E09 → 怪奇物语（不能截断成"怪"）', () => {
    const r = id(identifyFromPath('tv/怪奇物语.S04E09.1080p.mkv'))
    expect(r.isTv).toBe(true)
    expect(r.title).toBe('怪奇物语')
    expect(r.season).toBe(4)
    expect(r.episode).toBe(9)
  })

  it('show.S01E01.1080p.WEB-DL.x264-GROUP → show（剧名正常）', () => {
    const r = id(identifyFromPath('tv/show.S01E01.1080p.WEB-DL.x264-GROUP.mkv'))
    expect(r.isTv).toBe(true)
    expect(r.title).toBe('show')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(1)
  })

  it('招魂/招魂.The.Conjuring.2013 → The Conjuring（目录中文+文件英文，取更准的）', () => {
    const r = id(identifyFromPath('招魂/招魂.The.Conjuring.2013.2160p.mkv'))
    expect(r.isTv).toBe(false)
    expect(r.year).toBe(2013)
    expect(r.title).toMatch(/Conjuring|招魂/i)
  })
})
