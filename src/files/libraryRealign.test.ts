import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAbsoluteEpisodeNumber, scanVideoFiles } from './libraryRealign.js'

describe('parseAbsoluteEpisodeNumber', () => {
  it('CJK "第N话"', () => {
    expect(parseAbsoluteEpisodeNumber('间谍过家家 第26话.mkv')).toEqual({ absoluteEpisode: 26, matchedToken: '第26话' })
  })
  it('CJK "第N集"（简体）', () => {
    expect(parseAbsoluteEpisodeNumber('Show 第5集 1080p.mkv')).toEqual({ absoluteEpisode: 5, matchedToken: '第5集' })
  })
  it('方括号 [26]', () => {
    expect(parseAbsoluteEpisodeNumber('[SubGroup] Spy x Family [26][1080p].mkv')).toEqual({ absoluteEpisode: 26, matchedToken: '[26]' })
  })
  it('裸 E26', () => {
    expect(parseAbsoluteEpisodeNumber('Spy.x.Family.E26.1080p.mkv')).toEqual({ absoluteEpisode: 26, matchedToken: 'E26' })
  })
  it('已含 SxxExx 的文件不是绝对编号平铺——返回 null（不猜、不当绝对号处理）', () => {
    expect(parseAbsoluteEpisodeNumber('Show S02E05.mkv')).toBeNull()
  })
  it('合集文件（E01-02 范围记法）解不出单一集号——返回 null（隔离区，不猜）', () => {
    expect(parseAbsoluteEpisodeNumber('Show - 01-02.mkv')).toBeNull()
  })
  it('无任何可识别集号标记——返回 null', () => {
    expect(parseAbsoluteEpisodeNumber('random_file.mkv')).toBeNull()
  })
})

describe('scanVideoFiles', () => {
  it('只挑视频扩展名，逐个跑 parseAbsoluteEpisodeNumber', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realign-scan-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Show - 01.mkv'), '')
    writeFileSync(join(dir, 'Show - 02.mp4'), '')
    writeFileSync(join(dir, 'Show.nfo'), '') // 非视频，跳过
    writeFileSync(join(dir, 'poster.jpg'), '') // 非视频，跳过
    const files = scanVideoFiles(dir)
    expect(files.map(f => f.filename).sort()).toEqual(['Show - 01.mkv', 'Show - 02.mp4'])
    // "Show - 01.mkv" 没有字母 E，也没有 CJK/方括号标记——三种确定性模式都不命中，纯数字裸词
    // 歧义太大不收（spec 只列 CJK/bracket/E码三种），match 应为 null。
    expect(files.find(f => f.filename === 'Show - 01.mkv')!.match).toBeNull()
  })
})
