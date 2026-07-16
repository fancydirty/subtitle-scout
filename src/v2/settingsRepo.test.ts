// src/v2/settingsRepo.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import type { ScoutDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { SettingsRepo } from './settingsRepo.js'

let db: ScoutDb
let lib: LibraryRepo
let settings: SettingsRepo

const NOW = 1_700_000_000_000

beforeEach(() => {
  db = openDb(':memory:')
  lib = new LibraryRepo(db)
  settings = new SettingsRepo(db)
})

describe('SettingsRepo · get/set', () => {
  it('get 未设置的 key 返回 null', () => {
    expect(settings.get('target_languages')).toBeNull()
  })

  it('set 任意 key，get 原样取回字符串（值域校验是调用方的事，repo 只管存取）', () => {
    settings.set('target_languages', 'zh,en', NOW)
    expect(settings.get('target_languages')).toBe('zh,en')
    // 白名单外的 key repo 也照收——校验边界在调用方（server.ts 的 zod），不在这层。
    settings.set('anything_goes', 'literally-anything', NOW)
    expect(settings.get('anything_goes')).toBe('literally-anything')
  })

  it('set 二次写入同一 key 是覆盖（INSERT OR REPLACE），不是报错/追加', () => {
    settings.set('hardsub_mode', 'off', NOW)
    settings.set('hardsub_mode', 'aggressive', NOW + 1000)
    expect(settings.get('hardsub_mode')).toBe('aggressive')
    const row = db.prepare('SELECT value, updated_at FROM settings WHERE key = ?').get('hardsub_mode') as
      { value: string; updated_at: number }
    expect(row).toEqual({ value: 'aggressive', updated_at: NOW + 1000 })
  })
})

describe('SettingsRepo · listRoots/addRoot', () => {
  it('listRoots 初始为空数组', () => {
    expect(settings.listRoots()).toEqual([])
  })

  it('addRoot 写入后 listRoots 可见，type 默认 local', () => {
    settings.addRoot('/media/tv', NOW)
    expect(settings.listRoots()).toEqual([{ path: '/media/tv', type: 'local', addedAt: NOW }])
  })

  it('addRoot 重复加同一路径是幂等的（不报错，不产生第二行）', () => {
    settings.addRoot('/media/tv', NOW)
    settings.addRoot('/media/tv', NOW + 999)
    expect(settings.listRoots()).toHaveLength(1)
  })

  it('listRoots 按 path 排序，多根都可见', () => {
    settings.addRoot('/media/tv', NOW)
    settings.addRoot('/media/anime', NOW)
    expect(settings.listRoots().map(r => r.path)).toEqual(['/media/anime', '/media/tv'])
  })
})

describe('SettingsRepo · seedRootsFromEnv（首启种子）', () => {
  it('media_roots 空 + env 非空 → 逐条种子写入（逗号分隔，trim+filter，沿 mediaRoots() 同法）', () => {
    settings.seedRootsFromEnv(' /media/tv , /media/anime ,, ', NOW)
    expect(settings.listRoots().map(r => r.path)).toEqual(['/media/anime', '/media/tv'])
  })

  it('media_roots 已有行 → 空操作，不管 env 给了什么', () => {
    settings.addRoot('/media/existing', NOW)
    settings.seedRootsFromEnv('/media/tv,/media/anime', NOW + 1)
    expect(settings.listRoots().map(r => r.path)).toEqual(['/media/existing'])
  })

  it('media_roots 空 + env 也空/未定义 → 空操作', () => {
    settings.seedRootsFromEnv(undefined, NOW)
    expect(settings.listRoots()).toEqual([])
    settings.seedRootsFromEnv('  ,  ,', NOW)
    expect(settings.listRoots()).toEqual([])
  })
})

describe('SettingsRepo · removeRoot（单事务级联；磁盘文件不动，只清索引行）', () => {
  /** 复审修复 1：removeRoot 只对真守备目录动手，seed 时一并把 root 登记进 media_roots——
   *  没有这一步，级联根本不会跑（存在性守卫直接返回 null）。 */
  function seedUnderRoot(root: string, suffix: string) {
    settings.addRoot(root, NOW)
    const seriesId = `tmdb:${suffix}`
    lib.upsertSeries({ id: seriesId, name: `Series ${suffix}` })
    const epId = `${seriesId}/s1e1`
    lib.upsertEpisode({
      id: epId, seriesId, season: 1, episode: 1, name: 'E1',
      path: `${root}/Series ${suffix}/Season 01/e1.mkv`, subStatus: 'covered',
    })
    lib.markCovered(epId, `${root}/Series ${suffix}/Season 01/e1.zh.srt`, 'scout-download')
    return { seriesId, epId }
  }

  it('删该根下 episodes + 关联 subtitles 子行；返回删除计数', () => {
    const { epId } = seedUnderRoot('/media/tv', 'a')
    const before = db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id = ?').get(epId) as { c: number }
    expect(before.c).toBe(1)

    const result = settings.removeRoot('/media/tv')

    expect(result?.episodes).toBe(1)
    expect(lib.getEpisode(epId)).toBeNull()
    const after = db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id = ?').get(epId) as { c: number }
    expect(after.c).toBe(0)
  })

  it('该根下 series 因此变空壳 → series 行连带删除（+ 清 tmdb_seasons 缓存）；返回 series 计数', () => {
    const { seriesId } = seedUnderRoot('/media/tv', 'a')
    db.prepare(
      `INSERT INTO tmdb_seasons (series_id, season, episode, title, fetched_at) VALUES (?, 1, 1, 'E1', ?)`
    ).run(seriesId, NOW)

    const result = settings.removeRoot('/media/tv')

    expect(result?.series).toBe(1)
    expect(lib.getSeries(seriesId)).toBeNull()
    const catalogRows = db.prepare('SELECT COUNT(*) as c FROM tmdb_seasons WHERE series_id = ?').get(seriesId) as { c: number }
    expect(catalogRows.c).toBe(0)
  })

  it('该根下 series 仍有其余集在别处（非空壳）→ series 行保留', () => {
    const { seriesId } = seedUnderRoot('/media/tv', 'a')
    // 同一部剧的另一集躺在另一个根下（不常见但合法：用户把同剧不同季分挂两个根）。
    lib.upsertEpisode({
      id: `${seriesId}/s1e2`, seriesId, season: 1, episode: 2, name: 'E2',
      path: '/media/anime/Series a/Season 01/e2.mkv', subStatus: 'missing',
    })

    const result = settings.removeRoot('/media/tv')

    expect(result?.series).toBe(0)
    expect(lib.getSeries(seriesId)).not.toBeNull()
  })

  it('删该根下 movies + 关联 subtitles 子行', () => {
    settings.addRoot('/media/movies', NOW)
    lib.upsertMovie({ id: 'tmdb:603', name: 'Movie', path: '/media/movies/Movie (1999)/movie.mkv', subStatus: 'covered' })
    lib.markCovered('tmdb:603', '/media/movies/Movie (1999)/movie.zh.srt', 'scout-download')

    const result = settings.removeRoot('/media/movies')

    expect(result?.movies).toBe(1)
    expect(lib.getMovie('tmdb:603')).toBeNull()
  })

  it('删该根下 parked_paths', () => {
    settings.addRoot('/media/tv', NOW)
    lib.upsertParkedPath('/media/tv/Unknown/e1.mkv', 'ambiguous match', NOW)
    lib.upsertParkedPath('/media/anime/Unknown/e1.mkv', 'ambiguous match', NOW)

    const result = settings.removeRoot('/media/tv')

    expect(result?.parked).toBe(1)
    expect(lib.listParkedPaths().map(p => p.path)).toEqual(['/media/anime/Unknown/e1.mkv'])
  })

  it('移除后该 root 从 listRoots 消失', () => {
    settings.addRoot('/media/tv', NOW)
    settings.removeRoot('/media/tv')
    expect(settings.listRoots()).toEqual([])
  })

  it('前缀安全：不误伤同名前缀的兄弟根（/media/tv2 不受 /media/tv 的移除影响）', () => {
    seedUnderRoot('/media/tv', 'a')
    seedUnderRoot('/media/tv2', 'b')

    const result = settings.removeRoot('/media/tv')

    expect(result?.episodes).toBe(1)
    expect(lib.getSeries('tmdb:b')).not.toBeNull()
    expect(lib.episodePathsForSeries('tmdb:b')).toEqual(['/media/tv2/Series b/Season 01/e1.mkv'])
  })

  it('前缀安全：路径含 % 和 _ 时按字面量匹配，不当 LIKE 通配符（"100% Pascal-sensei" 场景）', () => {
    const root = '/media/tv'
    settings.addRoot(root, NOW)
    lib.upsertSeries({ id: 'tmdb:pascal', name: '100% Pascal-sensei' })
    lib.upsertEpisode({
      id: 'tmdb:pascal/s1e1', seriesId: 'tmdb:pascal', season: 1, episode: 1, name: 'E1',
      path: `${root}/100% Pascal-sensei/Season 01/e1.mkv`, subStatus: 'missing',
    })
    // 一个刻意构造的"看起来像通配符"但其实是另一部剧、不在 root 下的路径——若误用 LIKE 加通配符
    // 展开（如把 root 当成 'anymedia_tv' 之类的 pattern），这一行会被误删。
    lib.upsertSeries({ id: 'tmdb:decoy', name: 'Decoy' })
    lib.upsertEpisode({
      id: 'tmdb:decoy/s1e1', seriesId: 'tmdb:decoy', season: 1, episode: 1, name: 'E1',
      path: '/mediaXtv/Decoy/Season 01/e1.mkv', subStatus: 'missing',
    })

    const result = settings.removeRoot(root)

    expect(result?.episodes).toBe(1)
    expect(lib.getSeries('tmdb:pascal')).toBeNull()
    expect(lib.getSeries('tmdb:decoy')).not.toBeNull()
  })

  // 复审修复 1（安全脚枪）：removeRoot 对不是守备目录的路径必须整体拒绝——存在性守卫在级联
  // 之前，返回 null 且零删除。没有这道守卫，DELETE ?path=/media（现存根的公共父目录）甚至
  // ?path=/ 会把该前缀下全部索引行静默清光，而它根本不是守备目录。
  it('非守备目录路径 → 返回 null，不删任何行', () => {
    const result = settings.removeRoot('/media/never-added')
    expect(result).toBeNull()
  })

  it('现存根的父目录（本身不是守备目录）→ 返回 null，子根下的行一根毫毛都不掉', () => {
    const { seriesId, epId } = seedUnderRoot('/media/tv', 'a')
    lib.upsertParkedPath('/media/tv/Unknown/e1.mkv', 'ambiguous match', NOW)

    const result = settings.removeRoot('/media')

    expect(result).toBeNull()
    expect(lib.getSeries(seriesId)).not.toBeNull()
    expect(lib.getEpisode(epId)).not.toBeNull()
    expect(lib.listParkedPaths()).toHaveLength(1)
    expect(settings.listRoots().map(r => r.path)).toEqual(['/media/tv'])
  })
})
