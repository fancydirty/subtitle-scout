import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildMediaContext, parsePathMappings, mapPath, mediaDir, isUnderRoots, isDirWritable } from './mediaContext.js'
import { JellyfinItemsResponseSchema } from '../adapters/players/jellyfin.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'

const item = JellyfinItemsResponseSchema.parse(
  JSON.parse(readFileSync('fixtures/jellyfin/items-detail.json', 'utf8')),
).Items[0]

describe('parsePathMappings', () => {
  it('parses comma-separated pairs', () => {
    expect(parsePathMappings('/media=/mnt/nas,/tv=/mnt/tv')).toEqual([
      { from: '/media', to: '/mnt/nas' }, { from: '/tv', to: '/mnt/tv' },
    ])
  })
  it('empty/undefined → identity (empty list)', () => {
    expect(parsePathMappings(undefined)).toEqual([])
    expect(parsePathMappings('')).toEqual([])
  })
  it('throws on malformed pair', () => {
    expect(() => parsePathMappings('/media')).toThrow(/invalid/i)
  })
})

describe('mapPath', () => {
  it('longest prefix wins', () => {
    const m = [{ from: '/media', to: '/A' }, { from: '/media/movies', to: '/B' }]
    expect(mapPath('/media/movies/x.mkv', m)).toBe('/B/x.mkv')
    expect(mapPath('/media/tv/y.mkv', m)).toBe('/A/tv/y.mkv')
  })
})

describe('buildMediaContext', () => {
  it('maps the recorded movie item to a valid MediaContext', () => {
    const ctx = buildMediaContext(item, [])
    expect(ctx.media.title).toBe(item.Name)
    expect(ctx.media.type).toBe('movie')
    expect(ctx.media.path).toBe(item.Path)
    expect(ctx.media.filename).toBe('The.Matrix.1999.1080p.BluRay.x264.mkv')
    expect(ctx.media.year).toBe(1999)
    expect(ctx.trigger).toBe('playback_start')
    expect(ctx.request_id).toContain(item.Id)
  })
  it('applies path mapping', () => {
    const ctx = buildMediaContext(item, [{ from: '/media', to: '/mnt/nas_media' }])
    expect(ctx.media.path.startsWith('/mnt/nas_media')).toBe(true)
  })
  it('maps episode fields (series name as title)', () => {
    const ep = { ...item, Type: 'Episode', SeriesName: 'Severance', ParentIndexNumber: 2, IndexNumber: 3 }
    const ctx = buildMediaContext(ep, [])
    expect(ctx.media.type).toBe('episode')
    expect(ctx.media.season).toBe(2)
    expect(ctx.media.episode).toBe(3)
    expect(ctx.media.title).toBe('Severance')
  })
  it('lowercases provider id keys and converts runtime ticks to minutes', () => {
    const withIds = { ...item, ProviderIds: { Imdb: 'tt0133093', Tmdb: '603' }, RunTimeTicks: 81_600_000_000 }
    const ctx = buildMediaContext(withIds, [])
    expect(ctx.media.provider_ids).toEqual({ imdb: 'tt0133093', tmdb: '603' })
    expect(ctx.media.runtime_minutes).toBe(136)
  })
  it('collects existing subtitle streams with source external/embedded', () => {
    const withSub = { ...item, MediaStreams: [
      { Type: 'Subtitle', Language: 'eng', Codec: 'subrip', IsExternal: true },
      { Type: 'Subtitle', Language: 'jpn', Codec: 'ass', IsExternal: false },
      { Type: 'Audio', Language: 'eng', Codec: 'aac' },
    ] }
    const ctx = buildMediaContext(withSub, [])
    expect(ctx.media.existing_subtitles).toEqual([
      { language: 'eng', format: 'subrip', source: 'external' },
      { language: 'jpn', format: 'ass', source: 'embedded' },
    ])
  })
  it('throws on item without Path', () => {
    expect(() => buildMediaContext({ ...item, Path: null }, [])).toThrow(/path/i)
  })
})

describe('mediaDir', () => {
  it('returns the directory of the mapped media path', () => {
    const ctx = buildMediaContext(item, [])
    expect(mediaDir(ctx)).toBe('/media/movies/The Matrix (1999)')
  })
})

describe('isUnderRoots', () => {
  it('empty roots → unrestricted', () => {
    expect(isUnderRoots('/anywhere/x', [])).toBe(true)
  })
  it('accepts paths under a root, rejects outside and sibling-prefix tricks', () => {
    const roots = ['/mnt/media']
    expect(isUnderRoots('/mnt/media/Movies/x', roots)).toBe(true)
    expect(isUnderRoots('/mnt/media', roots)).toBe(true)
    expect(isUnderRoots('/etc', roots)).toBe(false)
    expect(isUnderRoots('/mnt/media-evil/x', roots)).toBe(false)
  })
})

function baseMovie(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: 'm1', Name: 'Shelby Oaks', Type: 'Movie', Path: '/media/movies/Shelby Oaks (2024)/x.mkv',
    ProductionYear: 2024, OriginalTitle: 'Shelby Oaks', Overview: 'A woman searches for her sister.',
    ...overrides,
  } as JellyfinItem
}

describe('buildMediaContext enrichment', () => {
  it('sets overview from item.Overview and defaults alternative_titles to []', () => {
    const ctx = buildMediaContext(baseMovie(), [])
    expect(ctx.media.overview).toBe('A woman searches for her sister.')
    expect(ctx.media.alternative_titles).toEqual([])
  })
  it('adds a distinct chinese title to alternative_titles', () => {
    const ctx = buildMediaContext(baseMovie(), [], { chineseTitle: '寻踪迷镇' })
    expect(ctx.media.alternative_titles).toEqual(['寻踪迷镇'])
  })
  it('drops a chinese title equal to the display or original title', () => {
    const ctx = buildMediaContext(baseMovie(), [], { chineseTitle: 'Shelby Oaks' })
    expect(ctx.media.alternative_titles).toEqual([])
  })
  it('tolerates missing Overview and null enrichment', () => {
    const ctx = buildMediaContext(baseMovie({ Overview: null }), [], { chineseTitle: null })
    expect(ctx.media.overview).toBeNull()
    expect(ctx.media.alternative_titles).toEqual([])
  })
})

describe('isDirWritable', () => {
  it('returns true for a writable directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ok-'))
    expect(isDirWritable(dir)).toBe(true)
  })
  it('leaves no probe file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-clean-'))
    isDirWritable(dir)
    expect(readdirSync(dir).some(f => f.startsWith('.subtitle-scout-writetest'))).toBe(false)
  })
  it('returns false for a non-existent directory', () => {
    expect(isDirWritable(join(tmpdir(), 'wp-does-not-exist-zzz', 'nope'))).toBe(false)
  })
  it('returns false for a read-only directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ro-'))
    chmodSync(dir, 0o555)
    // 以 root 运行时权限位被绕过,该断言不成立 → 条件跳过
    if (process.getuid && process.getuid() === 0) return
    expect(isDirWritable(dir)).toBe(false)
  })
})
