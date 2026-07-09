import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { needsChineseSubtitle, isTriggerableType, isChineseOrigin, CHINESE_LANG_TAGS } from './triggers.js'
import { JellyfinItemsResponseSchema, type JellyfinItem } from '../adapters/players/jellyfin.js'

const base = { Id: 'x', Name: 'M', Type: 'Movie', Path: '/m/x.mkv' } as JellyfinItem
const sub = (lang: string | undefined, codec = 'subrip', ext = true) =>
  ({ Type: 'Subtitle', Language: lang, Codec: codec, IsExternal: ext })

describe('isTriggerableType', () => {
  it('movie/episode yes, others no', () => {
    expect(isTriggerableType('Movie')).toBe(true)
    expect(isTriggerableType('Episode')).toBe(true)
    expect(isTriggerableType('Audio')).toBe(false)
    expect(isTriggerableType('Trailer')).toBe(false)
  })
})

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

describe('isChineseOrigin', () => {
  it('detects mainland/HK/TW in various spellings', () => {
    for (const loc of ['China', "People's Republic of China", 'Hong Kong', 'Taiwan', '中国', '中国大陆', '香港', '台湾']) {
      expect(isChineseOrigin({ ...base, ProductionLocations: [loc] })).toBe(true)
    }
  })
  it('false for foreign or missing metadata', () => {
    expect(isChineseOrigin({ ...base, ProductionLocations: ['United States of America'] })).toBe(false)
    expect(isChineseOrigin({ ...base, ProductionLocations: [] })).toBe(false)
    expect(isChineseOrigin({ ...base, ProductionLocations: undefined })).toBe(false)
  })
})
