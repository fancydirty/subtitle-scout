import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { needsChineseSubtitle, looksChineseTitle } from './triggers.js'
import { JellyfinItemsResponseSchema, type JellyfinItem } from '../adapters/players/jellyfin.js'

const base = { Id: 'x', Name: 'M', Type: 'Movie', Path: '/m/x.mkv' } as JellyfinItem
const sub = (lang: string | undefined, codec = 'subrip', ext = true) =>
  ({ Type: 'Subtitle', Language: lang, Codec: codec, IsExternal: ext })

// 去 Jellyfin 化 T4：isTriggerableType / isChineseOrigin / isChineseLang 的三个 describe 块
// 随各自唯一的生产调用方（daemon/watcher.ts、v2/scanner.ts）一起删除——见 triggers.ts 头部
// 新增的说明注释。needsChineseSubtitle / looksChineseTitle 仍有生产调用方，覆盖照旧保留。

describe('needsChineseSubtitle', () => {
  it('true when no subtitle streams at all', () => {
    expect(needsChineseSubtitle({ ...base, MediaStreams: [] }, true)).toBe(true)
  })
  it('false when Chinese text subtitle exists (all tag variants incl. recorded zh-hans)', () => {
    for (const lang of ['chi', 'zho', 'chs', 'zh-Hans', 'zh-hans', 'zh']) {
      expect(needsChineseSubtitle({ ...base, MediaStreams: [sub(lang)] }, true)).toBe(false)
    }
  })
  it('recorded after-refresh fixture is recognized as having Chinese subtitle', () => {
    const item = JellyfinItemsResponseSchema.parse(
      JSON.parse(readFileSync('fixtures/jellyfin/item-after-refresh.json', 'utf8')),
    ).Items[0]
    expect(needsChineseSubtitle(item, true)).toBe(false)
  })
  it('true when only non-Chinese subs exist', () => {
    expect(needsChineseSubtitle({ ...base, MediaStreams: [sub('eng'), sub('jpn')] }, true)).toBe(true)
  })
  it('PGS Chinese counts as missing when treatPgsAsMissing', () => {
    const pgs = { Type: 'Subtitle', Language: 'chi', Codec: 'PGSSUB', IsExternal: false }
    expect(needsChineseSubtitle({ ...base, MediaStreams: [pgs] }, true)).toBe(true)
    expect(needsChineseSubtitle({ ...base, MediaStreams: [pgs] }, false)).toBe(false)
  })
  it('undefined language does not count as Chinese', () => {
    expect(needsChineseSubtitle({ ...base, MediaStreams: [sub(undefined)] }, true)).toBe(true)
  })
})

describe('looksChineseTitle', () => {
  it('Han-only → true; kana/hangul present → false', () => {
    expect(looksChineseTitle('英雄')).toBe(true)
    expect(looksChineseTitle('流浪地球')).toBe(true)
    expect(looksChineseTitle('進撃の巨人')).toBe(false) // の is kana
    expect(looksChineseTitle('오징어 게임')).toBe(false) // hangul
    expect(looksChineseTitle('Peacemaker')).toBe(false) // no Han
    expect(looksChineseTitle(null)).toBe(false)
    expect(looksChineseTitle('')).toBe(false)
  })
})
