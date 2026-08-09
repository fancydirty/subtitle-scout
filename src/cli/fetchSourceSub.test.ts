// F1 · makeFetchSourceSub 单测:全 mock deps(locate/search/resolve/download 皆注入,零网络)。
// 锁死设计文档的五道行为:语言门(中继防线)/3 候选截断/坏包跳过/全败 null/定位失败 null,
// 以及"绝不抛"的吞错纪律。makeDbLocate 用 :memory: 库测真 SQL(episodes JOIN series / movies)。
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import AdmZip from 'adm-zip'
import { makeFetchSourceSub, makeDbLocate, subtitleTextFromDownload, MAX_CANDIDATE_ATTEMPTS, type FetchSourceSubDeps, type LocatedItem, type ZipEntryLike } from './fetchSourceSub.js'
import { parseSrtCues } from '../translate/qualityGate.js'
import { openDb } from '../v2/db.js'
import type { SubtitleCandidate } from '../core/schemas.js'
import type { DownloadResult } from '../adapters/download/direct.js'

const SRT = ['1', '00:00:01,000 --> 00:00:03,000', 'Hello world.', ''].join('\n')

const cand = (provider: SubtitleCandidate['provider'], providerId: string): SubtitleCandidate =>
  ({ provider, providerId, fileList: [] })

const dl = (bytes: Buffer | string, filename: string | null = null): DownloadResult =>
  ({ bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'), contentType: null, filename })

function zipOf(entries: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content, 'utf8'))
  return zip.toBuffer()
}

const LOCATED: LocatedItem = { title: 'The Rig', imdb: 'tt14827638', season: 2, episode: 6, originLang: 'en' }

function baseDeps(over: Partial<FetchSourceSubDeps> = {}): FetchSourceSubDeps {
  return {
    locate: () => LOCATED,
    search: async () => [cand('opensubtitles', '123')],
    resolve: async () => ({ url: 'https://example.com/sub.srt' }),
    download: async () => dl(SRT, 'sub.srt'),
    parseSrt: parseSrtCues,
    ...over,
  }
}

describe('makeFetchSourceSub — 语言门(中继防线)与定位', () => {
  it('定位失败(locate null) → null,search 不被调', async () => {
    let searched = 0
    const fetch = makeFetchSourceSub(baseDeps({ locate: () => null, search: async () => { searched++; return [] } }))
    expect(await fetch('/media/unknown.mkv')).toBeNull()
    expect(searched).toBe(0)
  })

  it('locate 抛错 → 吞成 null(绝不抛)', async () => {
    const fetch = makeFetchSourceSub(baseDeps({ locate: () => { throw new Error('db boom') } }))
    expect(await fetch('/media/x.mkv')).toBeNull()
  })

  it('origin ja ∈ SUPPORTED_SOURCE_LANGS(F2) → 过门,search languages=[ja](单跳日→中,非英语中继)', async () => {
    let seen: unknown
    const fetch = makeFetchSourceSub(baseDeps({
      locate: () => ({ ...LOCATED, originLang: 'ja', title: 'Frieren' }),
      search: async (args) => { seen = args; return [] },
    }))
    // search 空 → 仍 null(诚实无源),但必须被调且 languages=ja
    expect(await fetch('/media/anime.mkv')).toBeNull()
    expect(seen).toMatchObject({ queries: ['Frieren'], languages: ['ja'] })
  })

  it('origin ko ∉ SUPPORTED_SOURCE_LANGS → null,search 不被调(未支持源语言宁 no-source)', async () => {
    let searched = 0
    const fetch = makeFetchSourceSub(baseDeps({
      locate: () => ({ ...LOCATED, originLang: 'ko' }),
      search: async () => { searched++; return [] },
    }))
    expect(await fetch('/media/kdrama.mkv')).toBeNull()
    expect(searched).toBe(0)
  })

  it('origin_lang null(未解析) → null,search 不被调', async () => {
    let searched = 0
    const fetch = makeFetchSourceSub(baseDeps({
      locate: () => ({ ...LOCATED, originLang: null }),
      search: async () => { searched++; return [] },
    }))
    expect(await fetch('/media/x.mkv')).toBeNull()
    expect(searched).toBe(0)
  })

  it('脏值 " EN " lower+trim 后过门;search 收到 imdb 优先 + title query + languages=[en]', async () => {
    let seen: unknown
    const fetch = makeFetchSourceSub(baseDeps({
      locate: () => ({ ...LOCATED, originLang: ' EN ' }),
      search: async (args) => { seen = args; return [cand('opensubtitles', '123')] },
    }))
    const r = await fetch('/media/x.mkv')
    expect(r).toEqual({ srtText: SRT, sourceRef: 'opensubtitles:123' })
    expect(seen).toMatchObject({ imdb: 'tt14827638', queries: ['The Rig'], season: 2, episode: 6, languages: ['en'] })
  })
})

describe('makeFetchSourceSub — 候选循环(机械按序,最多 3 个)', () => {
  it('第一候选好包 → 返回其文本与 sourceRef', async () => {
    const fetch = makeFetchSourceSub(baseDeps())
    expect(await fetch('/media/x.mkv')).toEqual({ srtText: SRT, sourceRef: 'opensubtitles:123' })
  })

  it('坏包(parse 不出 cue)跳过,试下一候选', async () => {
    const bodies: Record<string, DownloadResult> = {
      'https://a': dl('not a subtitle at all'),
      'https://b': dl(SRT, 'good.srt'),
    }
    const fetch = makeFetchSourceSub(baseDeps({
      search: async () => [cand('opensubtitles', 'bad'), cand('opensubtitles', 'good')],
      resolve: async (ref) => ({ url: ref.providerId === 'bad' ? 'https://a' : 'https://b' }),
      download: async (url) => bodies[url],
    }))
    expect(await fetch('/media/x.mkv')).toEqual({ srtText: SRT, sourceRef: 'opensubtitles:good' })
  })

  it('调用方拒绝错源后继续试下一候选', async () => {
    const wrongDuration = ['1', '00:00:00,000 --> 00:03:20,000', 'Wrong episode.', ''].join('\n')
    const fetch = makeFetchSourceSub(baseDeps({
      search: async () => [cand('opensubtitles', 'wrong'), cand('opensubtitles', 'right')],
      resolve: async (ref) => ({ url: `https://${ref.providerId}` }),
      download: async (url) => dl(url.endsWith('wrong') ? wrongDuration : SRT),
    }))
    const r = await fetch('/media/x.mkv', async (text) => parseSrtCues(text)[0]?.timing.includes('00:00:03') ?? false)
    expect(r).toEqual({ srtText: SRT, sourceRef: 'opensubtitles:right' })
  })

  it('resolve/download 抛错(配额撞顶/网络)吞成试下一候选', async () => {
    let resolves = 0
    const fetch = makeFetchSourceSub(baseDeps({
      search: async () => [cand('opensubtitles', '1'), cand('opensubtitles', '2'), cand('opensubtitles', '3')],
      resolve: async (ref) => {
        resolves++
        if (ref.providerId === '1') throw new Error('406 quota exhausted')
        return { url: 'https://ok' }
      },
      download: async () => { if (resolves === 2) throw new Error('download timed out'); return dl(SRT) },
    }))
    expect(await fetch('/media/x.mkv')).toEqual({ srtText: SRT, sourceRef: 'opensubtitles:3' })
    expect(resolves).toBe(3)
  })

  it(`最多试 ${MAX_CANDIDATE_ATTEMPTS} 个候选(OS 下载配额有限),多余的碰都不碰 → 全坏 null`, async () => {
    let resolves = 0
    const fetch = makeFetchSourceSub(baseDeps({
      search: async () => ['1', '2', '3', '4', '5'].map((id) => cand('opensubtitles', id)),
      resolve: async () => { resolves++; throw new Error('boom') },
    }))
    expect(await fetch('/media/x.mkv')).toBeNull()
    expect(resolves).toBe(MAX_CANDIDATE_ATTEMPTS)
  })

  it('search 零命中 → null;search 抛错(全 provider 失败) → 吞成 null', async () => {
    expect(await makeFetchSourceSub(baseDeps({ search: async () => [] }))('/media/x.mkv')).toBeNull()
    expect(await makeFetchSourceSub(baseDeps({ search: async () => { throw new Error('all providers failed') } }))('/media/x.mkv')).toBeNull()
  })
})

describe('makeFetchSourceSub — 下载物解包(zip/raw)', () => {
  it('zip 单 srt 条目 → 解出文本', async () => {
    const fetch = makeFetchSourceSub(baseDeps({
      download: async () => dl(zipOf({ 'The.Rig.S02E06.srt': SRT }), 'pack.zip'),
    }))
    expect(await fetch('/media/x.mkv')).toEqual({ srtText: SRT, sourceRef: 'opensubtitles:123' })
  })

  it('zip 多 srt 条目(季包)无从机械选集 → 跳过该候选(C-D1 精神:绝不静默拿 entries[0] 装错集)', async () => {
    const season = zipOf({ 'e1.srt': SRT, 'e2.srt': SRT })
    const fetch = makeFetchSourceSub(baseDeps({
      search: async () => [cand('zimuku', 'pack'), cand('opensubtitles', 'single')],
      resolve: async (ref) => ({ url: `https://${ref.providerId}` }),
      download: async (url) => url === 'https://pack' ? dl(season, 'season.zip') : dl(SRT, 'e6.srt'),
    }))
    expect(await fetch('/media/x.mkv')).toEqual({ srtText: SRT, sourceRef: 'opensubtitles:single' })
  })

  it('zip 里没有 srt(只有 ass 等) → 跳过 → 全败 null(v1 只收 parse 得过的 srt)', async () => {
    const fetch = makeFetchSourceSub(baseDeps({
      download: async () => dl(zipOf({ 'x.ass': '[Script Info]' }), 'x.zip'),
    }))
    expect(await fetch('/media/x.mkv')).toBeNull()
  })

  it('raw ass 文本 parse 不出 srt cue → 跳过 → null', async () => {
    const fetch = makeFetchSourceSub(baseDeps({ download: async () => dl('[Script Info]\nTitle: x', 'x.ass') }))
    expect(await fetch('/media/x.mkv')).toBeNull()
  })
})

// 审计四轮 R4（mutation 自查）：这道 32MB 闸最初写成端到端用例（篡改 zip 字节 → 期望跳过候选），
// 但实测拆掉闸之后用例依然全绿——因为 AdmZip 会先因 CRC 校验失败抛错，被 makeFetchSourceSub 的
// "吞错换候选"纪律吞掉，两条路径的黑盒表现完全相同。改为直接单测 subtitleTextFromDownload：
// 用 spy 把 header.size 伪造成超限（数据本身合法、CRC 正确），确保红/绿只由这道闸决定。
describe('subtitleTextFromDownload — zip 32MB 炸弹闸（与 subtitleWriter 同一防线）', () => {
  const zipDl = (entries: Record<string, string>) => dl(zipOf(entries), 'pack.zip')
  const fakeEntry = (over: Partial<ZipEntryLike> & { size: number; data?: Buffer }): ZipEntryLike => ({
    entryName: 'x.srt',
    isDirectory: false,
    header: { size: over.size },
    getData: () => over.data ?? Buffer.from(SRT, 'utf8'),
    ...(over.entryName ? { entryName: over.entryName } : {}),
  })

  it('正常 zip 能解出文本（对照组，确保下面的 null 不是因为别的原因）', () => {
    expect(subtitleTextFromDownload(zipDl({ 'ok.srt': SRT }))).toBe(SRT)
  })

  it('声明解压体积超 32MB → 返回 null（绝不 inflate 进内存）', () => {
    const getData = vi.fn(() => Buffer.from(SRT, 'utf8'))
    const entry: ZipEntryLike = {
      entryName: 'bomb.srt', isDirectory: false,
      header: { size: 64 * 1024 * 1024 }, // 声称 64MB
      getData,
    }
    expect(subtitleTextFromDownload(zipDl({ 'bomb.srt': SRT }), () => [entry])).toBeNull()
    // 关键：声明值超限时绝不调用 getData()——炸弹不进内存
    expect(getData).not.toHaveBeenCalled()
  })

  it('声明值合法但实际解压后超 32MB → 返回 null（第二道闸）', () => {
    const entry = fakeEntry({ entryName: 'sneaky.srt', size: 100, data: Buffer.alloc(33 * 1024 * 1024) })
    expect(subtitleTextFromDownload(zipDl({ 'sneaky.srt': SRT }), () => [entry])).toBeNull()
  })

  it('刚好等于上限（32MB）放行——闸是 > 不是 >=', () => {
    const entry = fakeEntry({ entryName: 'edge.srt', size: 32 * 1024 * 1024, data: Buffer.from(SRT, 'utf8') })
    expect(subtitleTextFromDownload(zipDl({ 'edge.srt': SRT }), () => [entry])).toBe(SRT)
  })

  it('两处防线的上限常量一致（32MB）——避免一处改了另一处漂移', () => {
    const fetchSrc = readFileSync('src/cli/fetchSourceSub.ts', 'utf8')
    const writerSrc = readFileSync('src/files/subtitleWriter.ts', 'utf8')
    const capOf = (src: string) => /MAX_ZIP_ENTRY_BYTES = ([^\n]+)/.exec(src)?.[1]?.replace(/\s*\/\/.*$/, '').trim()
    expect(capOf(fetchSrc)).toBe(capOf(writerSrc))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// makeDbLocate 改读 files/works（C4）。
//
// 为什么这一整个 describe 被重写而不是新增一份：C4 的实质是"这条腿接在旧表上、新架构的数据
// 在 files/works 里、按 path 查旧表查无此行返回 null → 整条腿静默失效"。旧的三条用例断言的
// 正是**旧表**契约（`FROM episodes JOIN series` / `FROM movies`），它们全绿恰恰是 C4 能潜伏
// 到今天的原因——测试忠实地锁死了一个接错表的实现。保留它们等于要求实现同时读两套表，
// 那不是"修断链"，是把断链固化成需求。故整体迁移到 files/works 口径。
//
// 旧表本身**不删**（spec C10：旧表留待第 7 步清理），但本函数从此不再看它们——
// "旧表有行、files/works 无行 → 必须 null"这条由下方专门一条用例钉住，防有人图省事
// 加个 UNION 兜底，把新架构的数据完整性问题掩盖成"总能查到点什么"。
// ─────────────────────────────────────────────────────────────────────────────
describe('makeDbLocate — 真 SQL 定位(files/works,path 精确匹配 / C4)', () => {
  /** files 行的最小播种（列清单照 daemonV2 的 upsert：机械事实 + work_id）。 */
  function seedFile(db: ReturnType<typeof openDb>, over: {
    path: string; workId: string | null; season?: number | null; episode?: number | null
  }) {
    const dir = over.path.slice(0, over.path.lastIndexOf('/'))
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, work_id, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(over.path, dir, over.path.slice(over.path.lastIndexOf('/') + 1), 100, 1000, dir,
        over.season ?? null, over.episode ?? null, over.workId, 1000)
  }

  function seedWork(db: ReturnType<typeof openDb>, over: {
    id: string; title: string; mediaType: 'tv' | 'movie'; year?: number | null
    originLang?: string | null; providerIds?: string | null
  }) {
    db.prepare(`INSERT INTO works (id, title, original_title, year, media_type, origin_lang, provider_ids, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(over.id, over.title, null, over.year ?? null, over.mediaType,
        over.originLang ?? null, over.providerIds ?? null, 1000, 1000)
  }

  it('🔴 用例 1：剧集从 files/works 查到（title/year/season/episode/originLang 全对）', () => {
    const db = openDb(':memory:')
    seedWork(db, { id: 'tmdb:1', title: 'The Rig', mediaType: 'tv', year: 2023, originLang: 'en' })
    seedFile(db, { path: '/media/tv/rig.mkv', workId: 'tmdb:1', season: 2, episode: 6 })
    // 全字段 toEqual（不是 toMatchObject）：season/episode 走 files、其余走 works，
    // 部分匹配会让"某一列忘接"这类漏接静默通过。
    expect(makeDbLocate(db)('/media/tv/rig.mkv')).toEqual({
      title: 'The Rig', imdb: undefined, year: 2023, season: 2, episode: 6, originLang: 'en',
    })
    db.close()
  })

  it('🔴 用例 2：电影从 files/works 查到，season/episode 为 undefined（files 里是 NULL）', () => {
    const db = openDb(':memory:')
    seedWork(db, { id: 'tmdb:9', title: 'Shelby Oaks', mediaType: 'movie', year: 2025, originLang: 'en' })
    seedFile(db, { path: '/media/movies/so.mkv', workId: 'tmdb:9' })   // season/episode 均 NULL
    // undefined 而不是 null 是**契约**：这两个字段直接进 FetchArgs 喂 provider 搜索，
    // OpenSubtitles 的 season=null 与"不带 season 参数"是两种查询（前者可能 400/零命中）。
    // LocatedItem 把它们声明成 optional 正是为此。
    expect(makeDbLocate(db)('/media/movies/so.mkv')).toEqual({
      title: 'Shelby Oaks', imdb: undefined, year: 2025, season: undefined, episode: undefined, originLang: 'en',
    })
    db.close()
  })

  it('🔴 用例 3：files/works 查不到该 path → null', () => {
    const db = openDb(':memory:')
    expect(makeDbLocate(db)('/media/nowhere.mkv')).toBeNull()
    db.close()
  })

  it('🔴 用例 4：imdb 从 works.provider_ids 带出（兜底搜索的命中率命门）', () => {
    const db = openDb(':memory:')
    seedWork(db, {
      id: 'tmdb:1', title: 'The Rig', mediaType: 'tv', year: 2023, originLang: 'en',
      providerIds: '{"tmdb":"1","imdb":"tt14827638"}',
    })
    seedFile(db, { path: '/media/tv/rig.mkv', workId: 'tmdb:1', season: 2, episode: 6 })
    expect(makeDbLocate(db)('/media/tv/rig.mkv')?.imdb).toBe('tt14827638')
    db.close()
  })

  it('provider_ids 缺 imdb / 坏 JSON / NULL → imdb undefined（增益缺席不是 blocker）', () => {
    const db = openDb(':memory:')
    seedWork(db, { id: 'tmdb:9', title: 'No Imdb', mediaType: 'movie', originLang: 'en', providerIds: '{"tmdb":"9"}' })
    seedWork(db, { id: 'tmdb:10', title: 'Bad JSON', mediaType: 'movie', originLang: 'en', providerIds: 'not json' })
    seedWork(db, { id: 'tmdb:11', title: 'Null Ids', mediaType: 'movie', originLang: 'en', providerIds: null })
    seedFile(db, { path: '/media/movies/a.mkv', workId: 'tmdb:9' })
    seedFile(db, { path: '/media/movies/b.mkv', workId: 'tmdb:10' })
    seedFile(db, { path: '/media/movies/c.mkv', workId: 'tmdb:11' })
    expect(makeDbLocate(db)('/media/movies/a.mkv')?.imdb).toBeUndefined()
    expect(makeDbLocate(db)('/media/movies/b.mkv')?.imdb).toBeUndefined()
    expect(makeDbLocate(db)('/media/movies/c.mkv')?.imdb).toBeUndefined()
    db.close()
  })

  it('🔴 files 行未识别（work_id IS NULL）→ null，不许拿一个没身份的行去搜', () => {
    // 没有 work_id 就没有 title/originLang，而语言门与搜索 query 全靠它们。
    // 若实现用 LEFT JOIN 又不判 NULL，title 会是 undefined → search 拿着 `queries:[undefined]`
    // 去打 provider，而语言门那一关因 originLang 为 null 恰好先挡住 → 表面无害。
    // 但语言门是 MVP 的临时形态（R20 说后续要扩语言），它一放宽这就是真实的坏查询。
    const db = openDb(':memory:')
    seedFile(db, { path: '/media/tv/unknown.mkv', workId: null, season: 1, episode: 1 })
    expect(makeDbLocate(db)('/media/tv/unknown.mkv')).toBeNull()
    db.close()
  })

  it('🔴 旧表有行、files/works 无行 → 仍是 null（不许 UNION 兜回旧表 / C10）', () => {
    // C4 的修法是"改读新表"，不是"两张表都读"。若加旧表兜底：
    //  · 新架构的数据缺失会被旧表的陈旧行掩盖（旧 episodes 行的 season/episode 可能与
    //    今天磁盘上的文件早已不符——这正是新架构另起 files 表的原因）
    //  · 第 7 步删旧表那天，这条腿会在没有任何测试变红的情况下静默退回 C4 状态
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO series (id, name, year, provider_ids, origin_lang) VALUES ('tmdb:1', 'The Rig', 2023, '{"imdb":"tt14827638"}', 'en')`).run()
    db.prepare(`INSERT INTO episodes (id, series_id, season, episode, path, sub_status, updated_at)
                VALUES ('tmdb:1/s2e6', 'tmdb:1', 2, 6, '/media/tv/rig.mkv', 'unavailable', 0)`).run()
    expect(makeDbLocate(db)('/media/tv/rig.mkv')).toBeNull()
    db.close()
  })

  it('originLang 为 NULL（TMDB 未刮到）→ 原样传 null，不臆断成 en（R18 / C17）', () => {
    // 4-1 已废止"origin 空值当英语"。locate 只做忠实搬运，判定归语言门。
    const db = openDb(':memory:')
    seedWork(db, { id: 'tmdb:5', title: 'Unknown Lang', mediaType: 'movie', originLang: null })
    seedFile(db, { path: '/media/movies/u.mkv', workId: 'tmdb:5' })
    expect(makeDbLocate(db)('/media/movies/u.mkv')?.originLang).toBeNull()
    db.close()
  })
})
