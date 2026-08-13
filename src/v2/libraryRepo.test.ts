import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from './db.js'
import type { ScoutDb } from './db.js'
import { LibraryRepo, isParkedPathEligible, PARK_REASON } from './libraryRepo.js'

let lib: LibraryRepo
let db: ScoutDb

beforeEach(() => {
  db = openDb(':memory:')
  lib = new LibraryRepo(db)
})

describe('媒体镜像', () => {
  it('upsertEpisode 幂等且更新时间戳', () => {
    const ep = {
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 2,
      name: 'x',
      path: '/tv/a/e2.mkv',
      subStatus: 'missing' as const,
    }
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode(ep)
    lib.upsertEpisode({ ...ep, subStatus: 'covered' })
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect((lib.db.prepare('select count(*) c from episodes').get() as any).c).toBe(1)
  })

  it('missingBySeason 聚合缺字幕的 (series,season) 组', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    for (const [e, st] of [
      [1, 'missing'],
      [2, 'missing'],
      [3, 'covered'],
    ] as const)
      lib.upsertEpisode({
        id: `e${e}`,
        seriesId: 's1',
        season: 1,
        episode: e,
        name: '',
        path: `/p/${e}`,
        subStatus: st,
      })
    expect(lib.missingBySeason()).toEqual([
      { series_id: 's1', series_name: 'A', season: 1, missing: 2, throttled: 0, next_recheck_at: null, sample_reason: null },
    ])
  })

  // Task 8c（裁决 R-3 呈现面，考古定罪：谓词曾是守门人，把退避窗口内的停牌缺口整行隐藏）：
  // 停牌中的 item 不再从 missingBySeason 里消失——它作为 throttled 事实可见，带上几时复查
  // 与样本原因，"值不值得提前重派"留给 orchestrator 判断，机械层只如实呈报。
  it('missingBySeason：停牌行可见（未到期 unavailable 计入 throttled，不计入 missing）', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '', path: '/p/1', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: '', path: '/p/2', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e3', seriesId: 's1', season: 1, episode: 3, name: '', path: '/p/3', subStatus: 'missing' })
    // e3 变停牌：markUnavailable 用阶梯算出 recheck_after = NOW + 1 天，锚点 NOW 也用于查询，
    // 所以这一行必然未到期。
    const NOW = 1_000_000
    lib.markUnavailable('e3', '搜索穷尽', NOW)

    const rows = lib.missingBySeason(NOW)
    expect(rows).toEqual([
      {
        series_id: 's1', series_name: 'A', season: 1,
        missing: 2, throttled: 1,
        next_recheck_at: NOW + 86_400_000,
        sample_reason: '搜索穷尽',
      },
    ])
  })

  // 全 covered 的季没有任何缺口事实可报——HAVING missing>0 OR throttled>0 把它筛掉，这是
  // "无事实可报"，不是把已有事实藏起来。
  it('missingBySeason：全 covered 的季不出现', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '', path: '/p/1', subStatus: 'covered' })
    expect(lib.missingBySeason()).toEqual([])
  })

  // 救援R5：markHardsubAssumed——诚实标注为覆盖的一种，不进 markUnavailable 的内容退避阶梯
  // （search_attempts 不动，无 recheck_after），reason 落 status_reason 供覆盖详情面展示。
  it('markHardsubAssumed：写 sub_status=hardsub-assumed + status_reason，不触碰 search_attempts/recheck_after', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '', path: '/p/1', subStatus: 'missing' })
    const NOW = 1_000_000

    lib.markHardsubAssumed('e1', '组名标记 [Group]，无内嵌，无外挂候选', NOW)

    const row = db
      .prepare('SELECT sub_status, status_reason, recheck_after, search_attempts, updated_at FROM episodes WHERE id = ?')
      .get('e1')
    expect(row).toEqual({
      sub_status: 'hardsub-assumed',
      status_reason: '组名标记 [Group]，无内嵌，无外挂候选',
      recheck_after: null,
      search_attempts: 0,
      updated_at: NOW,
    })
    // 不进退避梯——missingBySeason 的 throttled 谓词只认 unavailable，hardsub-assumed 既不在
    // missing 也不在 throttled（它已经是"判定完的覆盖"，不该占用缺口清单的任何一格）。
    expect(lib.missingBySeason(NOW)).toEqual([])
  })

  it('markHardsubAssumed：episode 找不到时落 movie（两表尝试模式，同 markCovered/markUnavailable）', () => {
    lib.upsertMovie({ id: 'm1', name: 'M', path: '/p/m1', subStatus: 'missing' })
    lib.markHardsubAssumed('m1', 'aggressive 档机械直判', 2_000_000)
    const row = db.prepare('SELECT sub_status, status_reason FROM movies WHERE id = ?').get('m1')
    expect(row).toEqual({ sub_status: 'hardsub-assumed', status_reason: 'aggressive 档机械直判' })
  })

  it('markCovered 写 episodes.sub_status + subtitles 行，同一事务', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: '',
      path: '/p/1.mkv',
      subStatus: 'missing',
    })
    lib.markCovered('e1', '/p/1.zh-Hans.srt', 'scout-download', 'assrt:713051')
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('e1')).toMatchObject({
      path: '/p/1.zh-Hans.srt',
      provider_ref: 'assrt:713051',
    })
  })

  it('markCovered language 参数（IMPORTANT-2）：默认 zh-Hans（沿用历史行为），显式传入时按值写入', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '',
      path: '/p/1.mkv', subStatus: 'missing',
    })
    lib.markCovered('e1', '/p/1.zh-Hans.srt', 'scout-download')
    expect(lib.db.prepare('select language from subtitles where item_id=?').get('e1')).toEqual({ language: 'zh-Hans' })

    lib.upsertEpisode({
      id: 'e2', seriesId: 's1', season: 1, episode: 2, name: '',
      path: '/p/2.mkv', subStatus: 'missing',
    })
    lib.markCovered('e2', '/p/2.zh-Hant.srt', 'preexisting', undefined, 'zh-Hant')
    expect(lib.db.prepare('select language from subtitles where item_id=?').get('e2')).toEqual({ language: 'zh-Hant' })
  })

  // A2: language is a plain string, not a zh-Hans/zh-Hant enum — the find-subtitle worker's
  // target-language generalization (installedLanguage/langTag) relies on markCovered recording
  // whatever BCP-47 code it's given, e.g. 'en'.
  it('markCovered language 参数接受任意语言字符串（如 en），不限于 zh-Hans/zh-Hant', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e3', seriesId: 's1', season: 1, episode: 3, name: '',
      path: '/p/3.mkv', subStatus: 'missing',
    })
    lib.markCovered('e3', '/p/3.en.srt', 'scout-download', undefined, 'en')
    expect(lib.db.prepare('select language from subtitles where item_id=?').get('e3')).toEqual({ language: 'en' })
  })

  // W3（装机记账修复批，2026-07-18）：markCovered 的可选 reason 参数落进 status_reason——
  // 给了 reason 就写新的判词。
  it('markCovered reason 参数（W3）：给了 reason 时写进 status_reason', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '',
      path: '/p/1.mkv', subStatus: 'missing',
    })
    lib.markCovered('e1', '/p/1.zh-Hans.srt', 'scout-download', 'assrt:713051', 'zh-Hans', '文件名与集号完全吻合')
    expect(lib.getEpisode('e1')!.status_reason).toBe('文件名与集号完全吻合')
  })

  // 同 ingest.ts writeSubStatusOnly 的既有 F-B 口径：covered 是终局态之一，没给 reason 时清空
  // 可能残留的旧 unavailable/hardsub-assumed 叙事——不是"不碰该列"。
  it('markCovered reason 参数（W3）：省略 reason 时清空该行残留的旧 status_reason（同 ingest.ts F-B 口径）', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '',
      path: '/p/1.mkv', subStatus: 'missing',
    })
    lib.markUnavailable('e1', '旧的失败叙事', Date.now())
    expect(lib.getEpisode('e1')!.status_reason).toBe('旧的失败叙事')

    lib.markCovered('e1', '/p/1.zh-Hans.srt', 'scout-download')
    expect(lib.getEpisode('e1')!.status_reason).toBeNull()
  })

  it('markCovered reason 参数（W3）：movie 分支同样生效', () => {
    lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing' })
    lib.markCovered('m1', '/m.zh-Hans.srt', 'scout-download', undefined, 'zh-Hans', '判词')
    expect(lib.getMovie('m1')!.status_reason).toBe('判词')
  })

  it('markCovered 传 null 路径（M7）：只改状态，不伪造 subtitles 行', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: '',
      path: '/p/1.mkv',
      subStatus: 'missing',
    })
    lib.markCovered('e1', null, 'preexisting')
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect((lib.db.prepare('select count(*) c from subtitles where item_id=?').get('e1') as any).c).toBe(0)
  })

  it('unavailable 带复查时间，missingBySeason 不计入未到期的（原语义锁：未到期算 throttled 不算 missing）', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: '',
      path: '/p/1',
      subStatus: 'missing',
    })
    // R-3: 3rd arg is `now`（判决发生的时刻）——阶梯自己算出 recheck_after（首次 1 天后），
    // 不再由调用方直接喂 recheckAfter。
    const now = Date.now()
    lib.markUnavailable('e1', '搜索穷尽', now)
    const rows = lib.missingBySeason(now)
    expect(rows).toHaveLength(1)
    expect(rows[0].missing).toBe(0)
    expect(rows[0].throttled).toBe(1)
  })

  // 原语义锁的另一半：到期的 unavailable（recheck_after <= now）重新计入 missing，不是永久
  // 停在 throttled 里。sample_reason 仍如实带出该行的 status_reason——sub_status 本身还是
  // 'unavailable'，只是到期了，SQL 的 sample_reason 谓词不区分"到期"与"未到期"，只区分
  // "是不是 unavailable"，这是与给定 SQL 一致的既定行为，不是 bug。
  it('到期 unavailable 计入 missing（原语义锁）', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '', path: '/p/1', subStatus: 'missing' })
    const NOW = 1_000_000
    lib.markUnavailable('e1', '搜索穷尽', NOW)
    // 查询时刻已经过了 1 天的复查窗口 → 到期，重新计入 missing。
    const later = NOW + 86_400_000 + 1
    expect(lib.missingBySeason(later)).toEqual([
      { series_id: 's1', series_name: 'A', season: 1, missing: 1, throttled: 0, next_recheck_at: null, sample_reason: '搜索穷尽' },
    ])
  })

  // Movie同构用例
  it('upsertMovie 幂等且更新时间戳', () => {
    const movie = {
      id: 'm1',
      name: 'Test Movie',
      path: '/movies/test.mkv',
      subStatus: 'missing' as const,
    }
    lib.upsertMovie(movie)
    lib.upsertMovie({ ...movie, subStatus: 'covered' })
    expect(lib.getMovie('m1')!.sub_status).toBe('covered')
    expect((lib.db.prepare('select count(*) c from movies').get() as any).c).toBe(1)
  })

  it('markCovered 对 movie 也工作', () => {
    lib.upsertMovie({
      id: 'm1',
      name: 'Test Movie',
      path: '/movies/test.mkv',
      subStatus: 'missing',
    })
    lib.markCovered('m1', '/movies/test.zh-Hans.srt', 'scout-download', 'assrt:713052')
    expect(lib.getMovie('m1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('m1')).toMatchObject({
      path: '/movies/test.zh-Hans.srt',
      provider_ref: 'assrt:713052',
    })
  })

  // Task 8c（裁决 R-3 呈现面）：missingMovies 的同构升级——电影没有"季"，行形状从整 Movie 行
  // 改为 {id, name, missing, throttled, next_recheck_at, sample_reason}，missing/throttled 是
  // 逐行 0|1（不是聚合计数），语义与 missingBySeason 完全一致。
  it('missingMovies：missing 电影与停牌电影都可见，covered 的不出现', () => {
    lib.upsertMovie({ id: 'm1', name: 'Missing Movie', path: '/m1.mkv', subStatus: 'missing' })
    lib.upsertMovie({ id: 'm2', name: 'Covered Movie', path: '/m2.mkv', subStatus: 'covered' })
    lib.upsertMovie({ id: 'm3', name: 'Throttled Movie', path: '/m3.mkv', subStatus: 'missing' })
    const NOW = 1_000_000
    lib.markUnavailable('m3', '搜索穷尽', NOW)

    const rows = lib.missingMovies(NOW)
    expect(rows).toEqual([
      { id: 'm1', name: 'Missing Movie', missing: 1, throttled: 0, next_recheck_at: null, sample_reason: null },
      { id: 'm3', name: 'Throttled Movie', missing: 0, throttled: 1, next_recheck_at: NOW + 86_400_000, sample_reason: '搜索穷尽' },
    ])
  })

  it('missingMovies：到期 unavailable 计入 missing（同 missingBySeason 语义锁）', () => {
    lib.upsertMovie({ id: 'm1', name: 'M', path: '/m1.mkv', subStatus: 'missing' })
    const NOW = 1_000_000
    lib.markUnavailable('m1', '搜索穷尽', NOW)
    const later = NOW + 86_400_000 + 1
    expect(lib.missingMovies(later)).toEqual([
      { id: 'm1', name: 'M', missing: 1, throttled: 0, next_recheck_at: null, sample_reason: '搜索穷尽' },
    ])
  })

  // chinese_title 回写 + 扫描不清空（task 2 依赖）。
  // D6（去 Jellyfin 化 P3）：setSeriesChineseTitle 曾是 job 执行路径的独立写回口，grep 全仓库
  // 只有它自己的单测调用它，生产代码零调用点——判定为死代码，已删除。upsertSeries 的
  // SeriesParams 早已直接支持 chineseTitle 参数（T3 ingest 层识别命中时随 series 行一并写入，
  // 不再需要一个单独的 setter），这里改为直接验证 upsertSeries 的 chineseTitle 写入 + 幂等语义。
  it('upsertSeries chineseTitle 写入', () => {
    lib.upsertSeries({ id: 's1', name: 'A', chineseTitle: '甲剧' })
    expect(lib.getSeries('s1')!.chinese_title).toBe('甲剧')
  })

  it('upsertSeries 传 null chineseTitle 不清空已回写的中文名（scan 复扫不丢名）', () => {
    lib.upsertSeries({ id: 's1', name: 'A', chineseTitle: '甲剧' })
    // 模拟后续 scan：只带 name/posterPath，chineseTitle 缺省为 null
    lib.upsertSeries({ id: 's1', name: 'A', posterPath: 'ptag' })
    const row = lib.db.prepare('select chinese_title, poster_path from series where id=?').get('s1') as any
    expect(row.chinese_title).toBe('甲剧')
    expect(row.poster_path).toBe('ptag')
  })

  // 验收修复轮一 Task V1（design §A）：genres 落库 + 富化重试的两个新方法。
  it('upsertSeries 落 genres（JSON 数组字符串）', () => {
    lib.upsertSeries({ id: 's1', name: 'A', genres: [16, 35] })
    expect(lib.getSeries('s1')!.genres).toBe(JSON.stringify([16, 35]))
  })

  it('upsertSeries 传 undefined genres 不清空已回写的 genres（同 chineseTitle 的既有语义）', () => {
    lib.upsertSeries({ id: 's1', name: 'A', genres: [16] })
    lib.upsertSeries({ id: 's1', name: 'A', posterPath: 'ptag' }) // 不带 genres
    expect(lib.getSeries('s1')!.genres).toBe(JSON.stringify([16]))
  })

  // 详情页重设计 item B：overview/backdropPath 落库 + COALESCE 不清空既有（同 chineseTitle/poster 语义）。
  it('upsertSeries 落 overview/backdrop，COALESCE 不清空既有', () => {
    lib.upsertSeries({ id: 'tmdb:9', name: 'S', overview: 'ov', backdropPath: '/bd.jpg' })
    let row = db.prepare(`SELECT overview, backdrop_path FROM series WHERE id='tmdb:9'`).get() as { overview: string; backdrop_path: string }
    expect(row).toEqual({ overview: 'ov', backdrop_path: '/bd.jpg' })
    lib.upsertSeries({ id: 'tmdb:9', name: 'S' }) // 无新值 → 不清空
    row = db.prepare(`SELECT overview, backdrop_path FROM series WHERE id='tmdb:9'`).get() as { overview: string; backdrop_path: string }
    expect(row).toEqual({ overview: 'ov', backdrop_path: '/bd.jpg' })
  })

  it('upsertSeries: excluded.name 为空串占位时不踩既有非空 name（claim 剧来新集不得抹掉已治好的名字）', () => {
    // claim-gated 分支的 title 恒 ''：该剧每来一集新文件都会带着空名重新 upsert——空串是
    // "从未识别成功过"的占位语义（同 applyEnrichment 的 name CASE），绝不能覆盖一个真名。
    lib.upsertSeries({ id: 's1', name: 'Healed Name', genres: [16] })
    lib.upsertSeries({ id: 's1', name: '', year: 2024 }) // 空名占位再度 upsert（其余字段照常生效）
    const row = lib.getSeries('s1')!
    expect(row.name).toBe('Healed Name')
    expect(row.year).toBe(2024)
  })
})

// R-3（裁决 2026-07-16）：item 级内容退避阶梯——markUnavailable 每次判决自增 search_attempts，
// recheck_after 按阶梯拉长（1/2/4/8 天，第 5 次起 30 天封顶）；markCovered 是翻篇归零事件。
describe('markUnavailable 阶梯 (R-3: item 级内容退避下沉事实层)', () => {
  const NOW = 1_000_000
  const DAY = 86_400_000

  it('同一 item 连续 6 次 markUnavailable → recheck 间隔 1/2/4/8/30/30 天', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '', path: '/p/1', subStatus: 'missing' })

    const expectedDays = [1, 2, 4, 8, 30, 30]
    expectedDays.forEach((days, i) => {
      lib.markUnavailable('e1', '搜索穷尽', NOW)
      const ep = lib.getEpisode('e1')!
      expect(ep.search_attempts).toBe(i + 1)
      expect(ep.recheck_after).toBe(NOW + days * DAY)
    })
  })

  it('markCovered 归零后再 markUnavailable 回到 1 天（翻篇不背历史节奏）', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '', path: '/p/1', subStatus: 'missing' })

    lib.markUnavailable('e1', '搜索穷尽', NOW)
    lib.markUnavailable('e1', '搜索穷尽', NOW)
    expect(lib.getEpisode('e1')!.search_attempts).toBe(2)

    lib.markCovered('e1', null, 'preexisting')
    expect(lib.getEpisode('e1')!.search_attempts).toBe(0)

    lib.markUnavailable('e1', '搜索穷尽', NOW)
    const ep = lib.getEpisode('e1')!
    expect(ep.search_attempts).toBe(1)
    expect(ep.recheck_after).toBe(NOW + 1 * DAY)
  })

  it('两表尝试模式对 movie 同样生效（阶梯不是 episode 独有）', () => {
    lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing' })

    lib.markUnavailable('m1', '搜索穷尽', NOW)
    let movie = lib.getMovie('m1')!
    expect(movie.search_attempts).toBe(1)
    expect(movie.recheck_after).toBe(NOW + 1 * DAY)

    lib.markUnavailable('m1', '搜索穷尽', NOW)
    movie = lib.getMovie('m1')!
    expect(movie.search_attempts).toBe(2)
    expect(movie.recheck_after).toBe(NOW + 2 * DAY)
  })
})

describe('realign 支持方法', () => {
  it('getSeries 返回完整行，查无返回 null', () => {
    lib.upsertSeries({ id: 's1', name: 'Spy x Family' })
    expect(lib.getSeries('s1')?.name).toBe('Spy x Family')
    expect(lib.getSeries('nope')).toBeNull()
  })

  it('episodePathsForSeries 返回该剧全部集路径（跨季）', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/Show/Season 01/a.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/media/Show/Season 01/b.mkv', subStatus: 'missing' })
    expect(lib.episodePathsForSeries('s1').sort()).toEqual(['/media/Show/Season 01/a.mkv', '/media/Show/Season 01/b.mkv'])
  })

  it('deleteSeriesRows 删除该剧全部 episodes + subtitles + series 行', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a', subStatus: 'covered' })
    lib.markCovered('e1', '/a.zh-Hans.srt', 'scout-download')
    lib.deleteSeriesRows('s1')
    expect(lib.getEpisode('e1')).toBeNull()
    expect(lib.getSeries('s1')).toBeNull()
    expect(lib.db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id=?').get('e1')).toEqual({ c: 0 })
  })

  // 🔴 SEVERE 数据腐蚀的回归锁——**不要删**。realign 收尾:refreshLibrary→ingest 用同一稳定
  // seriesId 重识别新目录,重叠集把新文件登记成旧行的 item_files 副本;deleteSeriesRows 若漏删
  // item_files,这些副本 owner 已删成孤儿 → 下一轮 ingest B3-3 短路命中孤儿 path 却
  // ownerPath=null → continue,该 path 永不再被重识别成 episode → 集消失。
  //
  // ⚠️ 2026-08-13：本用例原先用 `lib.getItemFileByPath(...)` 做断言，而那个方法本轮作为
  // 死代码删除（生产零调用者，唯一调用点是它自己的单测）。**用例本身不能跟着删**——它锁的
  // 是 `deleteSeriesRows` 的级联行为，而 deleteSeriesRows 是活的（realignExecutor.ts 在调）。
  // 断言改为直接查表，不再经由一个被删掉的读取助手。
  it('deleteSeriesRows 同时清 item_files——否则 realign 后副本成孤儿、集永久隐形(SEVERE 腐蚀根因)', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 's1/e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/main.mkv', subStatus: 'covered' })
    lib.addItemFile('s1/e1', '/media/4k-replica.mkv', 1000) // 跨根副本
    const countReplica = () => (lib.db
      .prepare('SELECT COUNT(*) as c FROM item_files WHERE path = ?')
      .get('/media/4k-replica.mkv') as { c: number }).c
    expect(countReplica()).toBe(1)

    lib.deleteSeriesRows('s1')

    // 副本行必须一并清除,不能留成孤儿
    expect(countReplica()).toBe(0)
  })

  // 🔴 `upsertMovie` 的 ON CONFLICT 语义锁——**不要删**。锁的是
  // `origin_lang = COALESCE(excluded.origin_lang, origin_lang)`：一个已解析出的
  // origin_lang 绝不被后续不带该字段的 upsert 清空。upsertMovie 本轮保留（见其头注释），
  // 这条行为因此仍然是活的。
  //
  // ⚠️ 2026-08-13：本用例原先经 `setMovieOriginLang` 写、`getMovieOriginLang` 读，
  // 那两个 setter/getter 本轮作为死代码删除（生产零调用者）。**用例本身不能跟着删**——
  // 它的被测对象是 upsertMovie 而不是那两个访问器。改为经 upsertMovie 自己的
  // `originLang` 入参写入、直接查表读回。
  it('upsertMovie 不覆盖已有的 origin_lang（ON CONFLICT COALESCE 语义锁）', () => {
    const originLangOf = (id: string) => (lib.db
      .prepare('SELECT origin_lang FROM movies WHERE id = ?')
      .get(id) as { origin_lang: string | null }).origin_lang

    lib.upsertMovie({ id: 'm2', name: 'M', path: '/m.mkv', subStatus: 'missing', originLang: 'zh' })
    expect(originLangOf('m2')).toBe('zh')

    // 第二次 upsert 不带 originLang（undefined → SQL NULL）→ COALESCE 保住旧值
    lib.upsertMovie({ id: 'm2', name: 'M2', path: '/m2.mkv', subStatus: 'covered', year: 2020 })
    expect(originLangOf('m2')).toBe('zh')
  })

  it('upsertSeries posterPath / upsertMovie posterPath 写入 poster_path 列', () => {    lib.upsertSeries({ id: 's1', name: 'Show', posterPath: '/dqZEN.jpg' })
    expect(lib.getSeries('s1')?.poster_path).toBe('/dqZEN.jpg')

    lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing', posterPath: '/abc.jpg' })
    expect(lib.getMovie('m1')?.poster_path).toBe('/abc.jpg')
  })
})

describe('P2：自有 id 空间新表 + 探针 memo（去 Jellyfin 化 schema v9）', () => {
  describe('parked_paths', () => {
    const HOUR = 60 * 60 * 1000
    const fp = (mtimeMs = 100, size = 1000) => ({ mtimeMs, size })

    it('upsertParkedPath 插入新行；再次 upsert 更新 reason/last_attempt，保留 first_seen', () => {
      lib.upsertParkedPath('/media/unknown/a.mkv', 'no tmdb match', 1000, fp())
      lib.upsertParkedPath('/media/unknown/a.mkv', 'ambiguous', 2000, fp())
      const rows = lib.listParkedPaths()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        path: '/media/unknown/a.mkv',
        park_reason: 'ambiguous',
        first_seen: 1000,
        last_attempt: 2000,
      })
    })

    it('listParkedPaths 按 first_seen DESC 排序', () => {
      lib.upsertParkedPath('/a', 'r1', 1000, fp())
      lib.upsertParkedPath('/b', 'r2', 3000, fp())
      lib.upsertParkedPath('/c', 'r3', 2000, fp())
      expect(lib.listParkedPaths().map((r) => r.path)).toEqual(['/b', '/c', '/a'])
    })

    it('clearParkedPath 删除该行（认领成功后调用）', () => {
      lib.upsertParkedPath('/a', 'r1', 1000, fp())
      lib.clearParkedPath('/a')
      expect(lib.listParkedPaths()).toEqual([])
    })

    it('updateParkReason 改写 reason/last_attempt；行不存在=空操作', () => {
      lib.upsertParkedPath('/a', 'r1', 1000, fp())
      lib.updateParkReason('/a', 'agent still unsure', 2000)
      expect(lib.listParkedPaths()[0]).toMatchObject({
        path: '/a',
        park_reason: 'agent still unsure',
        first_seen: 1000,
        last_attempt: 2000,
      })
      // 不存在的行：不抛错、不影响表。
      lib.updateParkReason('/nope', 'whatever', 3000)
      expect(lib.listParkedPaths()).toHaveLength(1)
    })

    // ---- bumpParkedRetry（活锁防线，spec 2026-08-07 §3.3.1）----
    // 二轮审计 R2-B1 定罪：identify 失败的三条路径全都不推进退避轨——updateParkReason 只写
    // park_reason+last_attempt，而唯一推进 retry_count/next_retry_at 的 upsertParkedPath 只被
    // ingest 调用。结果坏单元的 next_retry_at 永久停在首次 park 的 now+1h，一小时后退避窗恒开，
    // 组批时它恒排队首 → 活锁。本方法是那条缺失的接线。
    it('bumpParkedRetry 推进退避阶梯 0→1h，不动 park_reason', () => {
      lib.upsertParkedPath('/a', 'awaiting-agent-identification', 10_000, fp())
      lib.bumpParkedRetry('/a', 20_000)
      const row = lib.listParkedPaths()[0]
      expect(row.retry_count).toBe(1)
      expect(row.next_retry_at).toBe(20_000 + 4 * HOUR)  // retry_count 已变 1 → 下一档 4h
      expect(row.last_attempt).toBe(20_000)
      // 🔴 park_reason 绝不能被动：反幻觉红线要求"编造被拒时保持
      // awaiting-agent-identification"，bump 只记"尝试过一次"这个机械事实。
      expect(row.park_reason).toBe('awaiting-agent-identification')
    })

    it('bumpParkedRetry 阶梯封顶 24h，且与 upsertParkedPath 共用同一组常量', () => {
      lib.upsertParkedPath('/a', 'r', 0, fp())
      lib.bumpParkedRetry('/a', 1000)   // rc 0→1，下次 4h
      expect(lib.listParkedPaths()[0].next_retry_at).toBe(1000 + 4 * HOUR)
      lib.bumpParkedRetry('/a', 2000)   // rc 1→2，下次 24h
      expect(lib.listParkedPaths()[0].next_retry_at).toBe(2000 + 24 * HOUR)
      lib.bumpParkedRetry('/a', 3000)   // rc 2→3，封顶仍 24h
      expect(lib.listParkedPaths()[0].next_retry_at).toBe(3000 + 24 * HOUR)
      expect(lib.listParkedPaths()[0].retry_count).toBe(3)
    })

    it('bumpParkedRetry 对不存在的行是空操作（幽灵防御：文件可能已被识别退户口）', () => {
      lib.bumpParkedRetry('/nope', 1000)
      expect(lib.listParkedPaths()).toEqual([])
    })

    it('bumpParkedRetry 不重置阶梯（与 upsertParkedPath 的 reason-变化重置语义相反）', () => {
      lib.upsertParkedPath('/a', 'r', 0, fp())
      lib.bumpParkedRetry('/a', 1000)
      lib.bumpParkedRetry('/a', 2000)
      expect(lib.listParkedPaths()[0].retry_count).toBe(2)
      // 换 reason 也不该让 bump 回到 0——那是 upsertParkedPath 的语义（给 ingest 的），
      // 不是这里要的（见 unidentifiedFindSubtitle.ts:308 的既有注释）。
      lib.updateParkReason('/a', 'identification-failed', 2500)
      lib.bumpParkedRetry('/a', 3000)
      expect(lib.listParkedPaths()[0].retry_count).toBe(3)
    })

    // ---- countParked（身份产出判据，方案 2026-08-07-identity-decoupling-plan §3/§4 改动 1，
    // 回归锁 #8）----
    // bumpParkedRetry 的姊妹方法：那个推退避轨（写），这个只回答"这批路径还剩几条在 park"
    // （读）。判据要的是机械事实——识别落库时 identityTools 会 clearParkedPath，所以
    // stillParked < targets.length 就等价于"身份落库发生了"，不必问 advisory 的 identity。
    it('countParked 空数组 → 0，且不发查询（SQLite 的 IN () 是语法错误）', () => {
      const spy = vi.spyOn(db, 'prepare')
      expect(lib.countParked([])).toBe(0)
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it('countParked 混合存在/不存在 → 只数存在的', () => {
      lib.upsertParkedPath('/a.mkv', 'r', 1000, fp())
      lib.upsertParkedPath('/b.mkv', 'r', 1000, fp())
      expect(lib.countParked(['/a.mkv', '/b.mkv', '/gone.mkv'])).toBe(2)
      expect(lib.countParked(['/gone.mkv'])).toBe(0)
      // 识别落库（clearParkedPath）后差值出现 —— 这就是判据消费的信号。
      lib.clearParkedPath('/a.mkv')
      expect(lib.countParked(['/a.mkv', '/b.mkv'])).toBe(1)
    })

    it('🔴 countParked 不做路径归一化——这是显式契约，不是巧合（审计 S-1）', () => {
      // 失效方向是最坏那侧：若哪天一侧多/少一次归一化 → 命中数虚低 → 判据
      // (stillParked < targets.length) 恒真 → 失败单元永不记 failure → 活锁。
      // 把"字面量匹配"钉成契约：谁将来给 countParked 加 resolve()，这条会红，
      // 迫使他同时确认 targets 侧的形态来源（unidentifiedFindSubtitle.ts:117 裸取 DB 列）。
      lib.upsertParkedPath('/media/tv/Show/E01.mkv', 'r', 1000, fp())
      expect(lib.countParked(['/media/tv/Show/E01.mkv'])).toBe(1)
      // 以下三种等价但非规范的形态一律不命中（实测行为，锁死）
      expect(lib.countParked(['/media/tv/Show/../Show/E01.mkv'])).toBe(0)
      expect(lib.countParked(['/media/tv//Show/E01.mkv'])).toBe(0)
      expect(lib.countParked(['/media/tv/./Show/E01.mkv'])).toBe(0)
    })

    it('countParked 入参重复不重复计数（path 是 PK，IN 是集合判定；审计 I-3）', () => {
      // 消费方的分母 targets.length 不去重，所以它假定 targets 无重复路径——
      // 该不变量由 listParkedPaths 的 PK 保证。这条锁住"分子侧去重"这个事实。
      lib.upsertParkedPath('/a.mkv', 'r', 1000, fp())
      expect(lib.countParked(['/a.mkv', '/a.mkv', '/a.mkv'])).toBe(1)
    })

    it('🔴 countParked 路径含 % 与 _ 字面量 → 精确匹配，不当通配符（防 LIKE 回归）', () => {
      // 真实媒体路径合法含这两个字符（"100% Pascal-sensei"、"Look_Back"）。若实现用了 LIKE，
      // '%' 会匹配任意串、'_' 会匹配任意单字符 → 计数虚高。见 settingsRepo.ts:138-141 的
      // removeRoot 同款陷阱记录（那里为此改用 substr）。
      lib.upsertParkedPath('/media/100% Pascal-sensei/E01.mkv', 'r', 1000, fp())
      lib.upsertParkedPath('/media/Look_Back/E01.mkv', 'r', 1000, fp())
      // 只查这两条本身 → 恰好 2
      expect(lib.countParked(['/media/100% Pascal-sensei/E01.mkv', '/media/Look_Back/E01.mkv'])).toBe(2)
      // 通配符形状的查询串：LIKE 下会命中上面两行，精确匹配下必须是 0。
      expect(lib.countParked(['/media/100%/E01.mkv'])).toBe(0)
      expect(lib.countParked(['/media/Look_Back/E01.mkv'.replace('_', 'X')])).toBe(0)
      expect(lib.countParked(['%'])).toBe(0)
      expect(lib.countParked(['/media/Look?Back/E01.mkv'])).toBe(0)
    })

    it('🔴 countParked 超 500 条 → 分片正确（SQLite 变量上限 999）', () => {
      // 1200 = 2 整片 + 200 余，专抓"最后一片漏了"这类差一错误。超限单元确实可能这么大：
      // spec §3.3.2 允许单元自身超 MAX_TARGETS_PER_JOB 时整单元上车。
      const paths = Array.from({ length: 1200 }, (_, i) => `/media/x/${i}.mkv`)
      for (const p of paths.slice(0, 700)) lib.upsertParkedPath(p, 'r', 1000, fp())
      expect(lib.countParked(paths)).toBe(700)
      // 全部存在的一整片 + 余数形状也要对
      expect(lib.countParked(paths.slice(0, 600))).toBe(600)
      expect(lib.countParked(paths.slice(700))).toBe(0)
    })

    it('负缓存：新 park → retry_count=0, next_retry_at=now+1h，存 fingerprint', () => {
      lib.upsertParkedPath('/a', 'no-match', 10_000, fp(111, 222))
      const row = lib.listParkedPaths()[0]
      expect(row.retry_count).toBe(0)
      expect(row.next_retry_at).toBe(10_000 + HOUR)
      expect(row.probe_mtime).toBe(111)
      expect(row.probe_size).toBe(222)
    })

    it('负缓存：同 reason+fp 到期后 bump 阶段 1h→4h→24h→cap', () => {
      const t0 = 1_000_000
      lib.upsertParkedPath('/a', 'no-match', t0, fp())
      // stage0 done: next was t0+1h; retry when due → stage1 next = now+4h
      const t1 = t0 + HOUR
      lib.upsertParkedPath('/a', 'no-match', t1, fp())
      expect(lib.listParkedPaths()[0]).toMatchObject({
        retry_count: 1,
        next_retry_at: t1 + 4 * HOUR,
      })
      // stage1 done → stage2 next = now+24h
      const t2 = t1 + 4 * HOUR
      lib.upsertParkedPath('/a', 'no-match', t2, fp())
      expect(lib.listParkedPaths()[0]).toMatchObject({
        retry_count: 2,
        next_retry_at: t2 + 24 * HOUR,
      })
      // stage2+ stays 24h
      const t3 = t2 + 24 * HOUR
      lib.upsertParkedPath('/a', 'no-match', t3, fp())
      expect(lib.listParkedPaths()[0]).toMatchObject({
        retry_count: 3,
        next_retry_at: t3 + 24 * HOUR,
      })
      const t4 = t3 + 24 * HOUR
      lib.upsertParkedPath('/a', 'no-match', t4, fp())
      expect(lib.listParkedPaths()[0]).toMatchObject({
        retry_count: 4,
        next_retry_at: t4 + 24 * HOUR,
      })
    })

    it('负缓存：同 reason+fp 在 next_retry_at 之前 → shouldRetry=false；到期后 true', () => {
      const t0 = 1_000_000
      lib.upsertParkedPath('/a', 'no-match', t0, fp())
      expect(lib.shouldRetryParkedPath('/a', fp(), t0 + HOUR - 1)).toBe(false)
      expect(lib.shouldRetryParkedPath('/a', fp(), t0 + HOUR)).toBe(true)
      expect(lib.shouldRetryParkedPath('/a', fp(), t0 + HOUR + 1)).toBe(true)
    })

    it('负缓存：reason 变更 → 重置到 1h 阶段', () => {
      const t0 = 1_000_000
      lib.upsertParkedPath('/a', 'no-match', t0, fp())
      lib.upsertParkedPath('/a', 'no-match', t0 + HOUR, fp()) // bump to stage1
      expect(lib.listParkedPaths()[0].retry_count).toBe(1)

      const tReset = t0 + HOUR + 1000
      lib.upsertParkedPath('/a', 'ambiguous', tReset, fp())
      expect(lib.listParkedPaths()[0]).toMatchObject({
        park_reason: 'ambiguous',
        retry_count: 0,
        next_retry_at: tReset + HOUR,
      })
    })

    it('负缓存：fingerprint 变更 → 立即 eligible；再 park 新 fp 重置 1h', () => {
      const t0 = 1_000_000
      lib.upsertParkedPath('/a', 'no-match', t0, fp(100, 200))
      expect(lib.shouldRetryParkedPath('/a', fp(100, 200), t0 + 1)).toBe(false)
      expect(lib.shouldRetryParkedPath('/a', fp(999, 200), t0 + 1)).toBe(true)
      expect(lib.shouldRetryParkedPath('/a', fp(100, 999), t0 + 1)).toBe(true)

      const t1 = t0 + 5000
      lib.upsertParkedPath('/a', 'no-match', t1, fp(999, 200))
      expect(lib.listParkedPaths()[0]).toMatchObject({
        retry_count: 0,
        next_retry_at: t1 + HOUR,
        probe_mtime: 999,
        probe_size: 200,
      })
    })

    it('负缓存：路径未 park → shouldRetry=true（首次识别）', () => {
      expect(lib.shouldRetryParkedPath('/never', fp(), 0)).toBe(true)
    })

    it('负缓存：next_retry_at 为 null（存量迁移行）→ eligible', () => {
      lib.upsertParkedPath('/a', 'no-match', 1000, fp())
      db.prepare('UPDATE parked_paths SET next_retry_at = NULL').run()
      expect(lib.shouldRetryParkedPath('/a', fp(), 1000)).toBe(true)
    })

    // 「救援R4b：addExtrasExemption/isExtrasExempt」一例已随两个方法与 extras_exemptions
    // 表一并删除（2026-08-13 用户裁决「特典都完全不算在找字幕的范围」，db.ts v44 迁移）。
    // 特典判据现在落在 subtitleJudge 的规则 0 上，由 subtitleJudge.test.ts 覆盖。
  })

  describe('upsertParkedPath with raw data', () => {
    it('stores duration_sec and embedded_langs as JSON', () => {
      lib.upsertParkedPath(
        '/test/video.mkv',
        'awaiting-agent-identification',
        1000,
        { mtimeMs: 500, size: 1024, durationSec: 3600, embeddedLangs: ['eng', 'chi'] },
      )

      const rows = lib.listParkedPaths()
      const row = rows.find((r) => r.path === '/test/video.mkv')

      expect(row).toBeDefined()
      expect(row?.duration_sec).toBe(3600)
      // 与 episodes/movies.embedded_langs 同构：JSON 数组串，非逗号串
      expect(row?.embedded_langs).toBe('["eng","chi"]')
      expect(JSON.parse(row!.embedded_langs!)).toEqual(['eng', 'chi'])
    })

    it('empty embeddedLangs array stores NULL, not a phantom empty language', () => {
      lib.upsertParkedPath(
        '/test/video.mkv',
        'awaiting-agent-identification',
        1000,
        { mtimeMs: 500, size: 1024, durationSec: 3600, embeddedLangs: [] },
      )

      const row = lib.listParkedPaths().find((r) => r.path === '/test/video.mkv')
      expect(row?.duration_sec).toBe(3600)
      expect(row?.embedded_langs).toBeNull()
    })

    it('preserves existing raw data on re-park when fingerprint unchanged and raw data omitted', () => {
      lib.upsertParkedPath(
        '/test/video.mkv',
        'awaiting-agent-identification',
        1000,
        { mtimeMs: 500, size: 1024, durationSec: 3600, embeddedLangs: ['eng'] },
      )

      // Re-park with same fingerprint but no raw data (probe skipped this round)
      lib.upsertParkedPath(
        '/test/video.mkv',
        'awaiting-agent-identification',
        2000,
        { mtimeMs: 500, size: 1024 },
      )

      const row = lib.listParkedPaths().find((r) => r.path === '/test/video.mkv')
      expect(row?.duration_sec).toBe(3600) // Preserved
      expect(row?.embedded_langs).toBe('["eng"]') // Preserved
    })

    it('clears stale raw data when fingerprint changed and raw data omitted', () => {
      lib.upsertParkedPath(
        '/test/video.mkv',
        'awaiting-agent-identification',
        1000,
        { mtimeMs: 500, size: 1024, durationSec: 3600, embeddedLangs: ['eng'] },
      )

      // File changed on disk (mtime bumped) but no fresh probe data → old raw data is invalid
      lib.upsertParkedPath(
        '/test/video.mkv',
        'awaiting-agent-identification',
        2000,
        { mtimeMs: 600, size: 1024 },
      )

      const row = lib.listParkedPaths().find((r) => r.path === '/test/video.mkv')
      expect(row?.probe_mtime).toBe(600)
      expect(row?.duration_sec).toBeNull()
      expect(row?.embedded_langs).toBeNull()
    })

    it('overwrites old raw data when new data arrives with a changed fingerprint', () => {
      lib.upsertParkedPath(
        '/test/video.mkv',
        'awaiting-agent-identification',
        1000,
        { mtimeMs: 500, size: 1024, durationSec: 3600, embeddedLangs: ['eng'] },
      )

      lib.upsertParkedPath(
        '/test/video.mkv',
        'awaiting-agent-identification',
        2000,
        { mtimeMs: 600, size: 2048, durationSec: 5400, embeddedLangs: ['eng', 'jpn'] },
      )

      const row = lib.listParkedPaths().find((r) => r.path === '/test/video.mkv')
      expect(row?.duration_sec).toBe(5400)
      expect(row?.embedded_langs).toBe('["eng","jpn"]')
    })
  })

  describe('item_files（重复源 P1，schema v16）', () => {
    beforeEach(() => {
      lib.upsertSeries({ id: 's1', name: 'A' })
      lib.upsertEpisode({ id: 's1/e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/main.mkv', subStatus: 'covered' })
    })

    it('addItemFile + listItemFiles：副本入册，added_at ASC 排序（最年长在前）', () => {
      lib.addItemFile('s1/e1', '/media/1080p.mkv', 2000)
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      const files = lib.listItemFiles('s1/e1')
      expect(files.map((f) => f.path)).toEqual(['/media/4k.mkv', '/media/1080p.mkv'])
      expect(files.every((f) => f.item_id === 's1/e1')).toBe(true)
    })

    it('addItemFile 幂等（path UNIQUE，重复入册不抛不重复）', () => {
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      lib.addItemFile('s1/e1', '/media/4k.mkv', 2000)
      expect(lib.listItemFiles('s1/e1')).toHaveLength(1)
    })

    it('itemFileCoverage：主文件 covered + 副本无字幕 → 主 covered、副本 uncovered（partial 素材）', () => {
      // 主文件已入库为 covered（beforeEach 设的 sub_status='covered'）
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      const cov = lib.itemFileCoverage('s1/e1')
      expect(cov).toEqual([
        { path: '/media/main.mkv', isMain: true, covered: true },
        { path: '/media/4k.mkv', isMain: false, covered: false },
      ])
      // 派生：混合 → partial，filesMissing=1
      expect(cov.filter((f) => !f.covered)).toHaveLength(1)
    })

    it('itemFileCoverage：副本有 file_path 归属的字幕行 → 副本 covered', () => {
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      // 给副本装一条按 file_path 归属的字幕（P2 起 subtitles 支持 file_path）
      db.prepare(`INSERT INTO subtitles (item_id, path, language, source, file_path, created_at) VALUES (?,?,?,?,?,?)`)
        .run('s1/e1', '/media/4k.zh.srt', 'zh-Hans', 'scout-download', '/media/4k.mkv', 1000)
      const cov = lib.itemFileCoverage('s1/e1')
      expect(cov.find((f) => f.path === '/media/4k.mkv')!.covered).toBe(true)
      expect(cov.every((f) => f.covered)).toBe(true) // 全覆盖
    })

    it('itemFileCoverage：file_path IS NULL 的存量字幕只挂主文件，不算副本覆盖', () => {
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      // 存量字幕（无 file_path）——挂主文件，不应让副本变 covered
      db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
        .run('s1/e1', '/media/main.zh.srt', 'zh-Hans', 'scout-download', 1000)
      expect(lib.itemFileCoverage('s1/e1').find((f) => f.path === '/media/4k.mkv')!.covered).toBe(false)
    })

    it('itemFileCoverage：主文件 missing 无副本 → 单元素主文件 uncovered', () => {
      lib.upsertEpisode({ id: 's1/e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/media/e2.mkv', subStatus: 'missing' })
      expect(lib.itemFileCoverage('s1/e2')).toEqual([
        { path: '/media/e2.mkv', isMain: true, covered: false },
      ])
    })

    it('itemFileCoverage：条目不存在 → 空数组', () => {
      expect(lib.itemFileCoverage('tmdb:999/s9e9')).toEqual([])
    })

    it('listSubtitlesForFile：主文件（isMainFile=true）捡到 file_path 匹配的 + file_path IS NULL 的存量行', () => {
      db.prepare(`INSERT INTO subtitles (item_id, path, language, source, file_path, created_at) VALUES (?,?,?,?,?,?)`)
        .run('s1/e1', '/media/main.zh.srt', 'zh-Hans', 'scout-download', '/media/main.mkv', 1000)
      db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
        .run('s1/e1', '/media/legacy.zh.srt', 'zh-Hant', 'adopted-local', 2000)
      const rows = lib.listSubtitlesForFile('s1/e1', '/media/main.mkv', true)
      expect(rows.map((r) => r.path).sort()).toEqual(['/media/legacy.zh.srt', '/media/main.zh.srt'])
    })

    it('listSubtitlesForFile：副本（isMainFile=false）只捡 file_path 精确匹配，不捡 NULL 存量行', () => {
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      db.prepare(`INSERT INTO subtitles (item_id, path, language, source, file_path, created_at) VALUES (?,?,?,?,?,?)`)
        .run('s1/e1', '/media/4k.zh.srt', 'zh-Hans', 'scout-download', '/media/4k.mkv', 1000)
      db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
        .run('s1/e1', '/media/legacy.zh.srt', 'zh-Hant', 'adopted-local', 2000) // NULL=挂主文件，不属于这个副本
      const rows = lib.listSubtitlesForFile('s1/e1', '/media/4k.mkv', false)
      expect(rows.map((r) => r.path)).toEqual(['/media/4k.zh.srt'])
    })

    it('listSubtitlesForFile：无匹配 → 空数组', () => {
      expect(lib.listSubtitlesForFile('s1/e1', '/media/main.mkv', true)).toEqual([])
    })

    // 重复源 P4b："复制优先"机械通道（v2/subtitlePropagation.ts）的唯一写口。
    it('addReplicaSubtitle：给副本挂一行字幕账，file_path 指向副本自己的 path——之后 listSubtitlesForFile(isMainFile=false) 能捡到', () => {
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      lib.addReplicaSubtitle('s1/e1', '/media/4k.mkv', '/media/4k.zh-Hans.srt', 'zh-Hans', 'scout-propagate', 2000)
      const rows = lib.listSubtitlesForFile('s1/e1', '/media/4k.mkv', false)
      expect(rows).toEqual([{ id: expect.any(Number), path: '/media/4k.zh-Hans.srt', language: 'zh-Hans' }])
      // 不影响主文件——isMainFile=true 的既有 NULL-兼容语义不该意外捡到副本这行（file_path 精确等于副本自己的 path，不等于主文件 path，也不是 NULL）
      expect(lib.listSubtitlesForFile('s1/e1', '/media/main.mkv', true)).toEqual([])
    })

    it('addReplicaSubtitle：不动 episodes/movies.sub_status——副本覆盖只反映在 subtitles.file_path 上', () => {
      lib.upsertEpisode({ id: 's1/e3', seriesId: 's1', season: 1, episode: 3, name: 'E3', path: '/media/e3-main.mkv', subStatus: 'missing' })
      lib.addItemFile('s1/e3', '/media/e3-4k.mkv', 1000)
      lib.addReplicaSubtitle('s1/e3', '/media/e3-4k.mkv', '/media/e3-4k.zh-Hans.srt', 'zh-Hans', 'scout-propagate', 2000)
      expect(lib.getEpisode('s1/e3')!.sub_status).toBe('missing') // 主文件仍缺口，未被这次副本写入意外改动
      expect(lib.itemFileCoverage('s1/e3').find((f) => f.path === '/media/e3-4k.mkv')!.covered).toBe(true)
    })

    it('addReplicaSubtitle：ON CONFLICT(item_id, path) 幂等——同一目标路径重复调用不抛不重复插入', () => {
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      lib.addReplicaSubtitle('s1/e1', '/media/4k.mkv', '/media/4k.zh-Hans.srt', 'zh-Hans', 'scout-propagate', 2000)
      lib.addReplicaSubtitle('s1/e1', '/media/4k.mkv', '/media/4k.zh-Hans.srt', 'zh-Hans', 'scout-propagate', 3000)
      expect(lib.listSubtitlesForFile('s1/e1', '/media/4k.mkv', false)).toHaveLength(1)
    })
  })

  describe('probeMemo / setProbeMemo', () => {
  })

  describe('deleteEpisodeByPath / deleteMovieByPath / deleteSeriesIfEmpty', () => {
  })
})

// 胶水层修复战役（2026-07-16）：季级缺口事实清单，替代被处决的 LIMIT 1 代表集查询。
describe('listMissingEpisodesInSeason', () => {
  const NOW = 10_000
  const NOW_BEFORE_RECHECK = 1_000

  it('listMissingEpisodesInSeason: 返回全部缺口事实行（missing ∪ 到期 unavailable），episode 升序', () => {
    lib.upsertSeries({ id: 'tmdb:7', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:7/s1e1', seriesId: 'tmdb:7', season: 1, episode: 1, name: 'E1', path: '/p/1.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'tmdb:7/s1e2', seriesId: 'tmdb:7', season: 1, episode: 2, name: 'E2', path: '/p/2.mkv', subStatus: 'covered' })
    lib.upsertEpisode({ id: 'tmdb:7/s1e3', seriesId: 'tmdb:7', season: 1, episode: 3, name: 'E3', path: '/p/3.mkv', subStatus: 'missing' })
    // R-3: 3rd arg is now `now`（判决发生的时刻），阶梯自算 recheck_after=now+1天（首次）。
    // 要让它在查询时刻 NOW 已到期，判决时刻要落在 NOW 的 1 天以上之前。
    lib.markUnavailable('tmdb:7/s1e3', '搜索穷尽', NOW - 2 * 86_400_000) // 已到期

    const rows = lib.listMissingEpisodesInSeason('tmdb:7', 1, NOW)
    expect(rows.map(r => r.episode)).toEqual([1, 3])
    expect(rows[0]).toMatchObject({ id: 'tmdb:7/s1e1', season: 1 })
    expect(typeof rows[0].path).toBe('string')
  })

  it('listMissingEpisodesInSeason: 未到期 unavailable 不算缺口', () => {
    lib.upsertSeries({ id: 'tmdb:7', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:7/s1e1', seriesId: 'tmdb:7', season: 1, episode: 1, name: 'E1', path: '/p/1.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'tmdb:7/s1e2', seriesId: 'tmdb:7', season: 1, episode: 2, name: 'E2', path: '/p/2.mkv', subStatus: 'covered' })
    lib.upsertEpisode({ id: 'tmdb:7/s1e3', seriesId: 'tmdb:7', season: 1, episode: 3, name: 'E3', path: '/p/3.mkv', subStatus: 'missing' })
    // 判决时刻=NOW_BEFORE_RECHECK，阶梯首次 +1 天 → 远晚于查询时刻，未到期。
    lib.markUnavailable('tmdb:7/s1e3', '搜索穷尽', NOW_BEFORE_RECHECK) // 未到期

    const rows = lib.listMissingEpisodesInSeason('tmdb:7', 1, NOW_BEFORE_RECHECK)
    expect(rows.map(r => r.episode)).toEqual([1])
  })
})

// R-11（用户裁决 2026-07-16）：派活范围是主代理的判断，不是系统常量——listMissingEpisodesForSeries
// 是 listMissingEpisodesInSeason 的全剧/季子集泛化版，供 mapper 按 payload.seasons 取事实清单。
describe('listMissingEpisodesForSeries (R-11：派活范围裁量化)', () => {
  const NOW = 10_000
  const NOW_BEFORE_RECHECK = 1_000

  it('seasons=null 返回全剧缺口（跨季，season,episode 升序）', () => {
    lib.upsertSeries({ id: 'tmdb:9', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:9/s1e1', seriesId: 'tmdb:9', season: 1, episode: 1, name: 'E1', path: '/p/s1e1.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'tmdb:9/s2e1', seriesId: 'tmdb:9', season: 2, episode: 1, name: 'E1', path: '/p/s2e1.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'tmdb:9/s2e2', seriesId: 'tmdb:9', season: 2, episode: 2, name: 'E2', path: '/p/s2e2.mkv', subStatus: 'covered' })
    lib.upsertEpisode({ id: 'tmdb:9/s3e1', seriesId: 'tmdb:9', season: 3, episode: 1, name: 'E1', path: '/p/s3e1.mkv', subStatus: 'missing' })

    const rows = lib.listMissingEpisodesForSeries('tmdb:9', null, NOW)
    expect(rows.map(r => [r.season, r.episode])).toEqual([[1, 1], [2, 1], [3, 1]])
  })

  it('seasons=[2] 只返回该季缺口', () => {
    lib.upsertSeries({ id: 'tmdb:9', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:9/s1e1', seriesId: 'tmdb:9', season: 1, episode: 1, name: 'E1', path: '/p/s1e1.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'tmdb:9/s2e1', seriesId: 'tmdb:9', season: 2, episode: 1, name: 'E1', path: '/p/s2e1.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'tmdb:9/s3e1', seriesId: 'tmdb:9', season: 3, episode: 1, name: 'E1', path: '/p/s3e1.mkv', subStatus: 'missing' })

    const rows = lib.listMissingEpisodesForSeries('tmdb:9', [2], NOW)
    expect(rows.map(r => r.season)).toEqual([2])
  })

  it('seasons=[1,3] 只返回子集季的缺口（用户例的跨季变体：多季资源都缺字幕，一次带上但跳过没资源的季）', () => {
    lib.upsertSeries({ id: 'tmdb:9', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:9/s1e1', seriesId: 'tmdb:9', season: 1, episode: 1, name: 'E1', path: '/p/s1e1.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'tmdb:9/s2e1', seriesId: 'tmdb:9', season: 2, episode: 1, name: 'E1', path: '/p/s2e1.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'tmdb:9/s3e1', seriesId: 'tmdb:9', season: 3, episode: 1, name: 'E1', path: '/p/s3e1.mkv', subStatus: 'missing' })

    const rows = lib.listMissingEpisodesForSeries('tmdb:9', [1, 3], NOW)
    expect(rows.map(r => r.season)).toEqual([1, 3])
  })

  it('未到期 unavailable 不算缺口（谓词与 listMissingEpisodesInSeason 一致）', () => {
    lib.upsertSeries({ id: 'tmdb:9', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:9/s1e1', seriesId: 'tmdb:9', season: 1, episode: 1, name: 'E1', path: '/p/s1e1.mkv', subStatus: 'missing' })
    // R-3: 判决时刻=NOW_BEFORE_RECHECK，阶梯首次 +1 天 → 未到期。
    lib.markUnavailable('tmdb:9/s1e1', '搜索穷尽', NOW_BEFORE_RECHECK)

    const rows = lib.listMissingEpisodesForSeries('tmdb:9', null, NOW_BEFORE_RECHECK)
    expect(rows).toEqual([])
  })

  // F-R2-4（R2 复审，审计定罪：停牌提前重派的管道缺失）：orchestratorSkill 早就教"re-dispatching
  // a throttled-only row is YOUR call"，但谓词此前无条件 recheck_after<=now，模型说了算的路径
  // 根本不存在——一次"我判断该提前重查"的派发落地后照样被这道 SQL 门槛挡回空批。第 4 参
  // includeThrottled=true 时放宽为不看 recheck_after，让机制真的存在。
  it('includeThrottled=true：未到期 unavailable 也算缺口（放宽谓词，无 recheck 窗口过滤）', () => {
    lib.upsertSeries({ id: 'tmdb:9', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:9/s1e1', seriesId: 'tmdb:9', season: 1, episode: 1, name: 'E1', path: '/p/s1e1.mkv', subStatus: 'missing' })
    lib.markUnavailable('tmdb:9/s1e1', '搜索穷尽', NOW_BEFORE_RECHECK)

    const rows = lib.listMissingEpisodesForSeries('tmdb:9', null, NOW_BEFORE_RECHECK, true)
    expect(rows.map(r => r.id)).toEqual(['tmdb:9/s1e1'])
  })

  it('includeThrottled 默认 false（省略第 4 参）：既有窗口语义不变', () => {
    lib.upsertSeries({ id: 'tmdb:9', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:9/s1e1', seriesId: 'tmdb:9', season: 1, episode: 1, name: 'E1', path: '/p/s1e1.mkv', subStatus: 'missing' })
    lib.markUnavailable('tmdb:9/s1e1', '搜索穷尽', NOW_BEFORE_RECHECK)

    const rows = lib.listMissingEpisodesForSeries('tmdb:9', null, NOW_BEFORE_RECHECK)
    expect(rows).toEqual([])
  })
})

describe('isParkedPathEligible', () => {
  it('returns true for awaiting-agent-identification', ({ expect }) => {
    expect(isParkedPathEligible('awaiting-agent-identification')).toBe(true)
  })

  it('returns false for excluded-extra', ({ expect }) => {
    expect(isParkedPathEligible('excluded-extra')).toBe(false)
  })

  it('returns false for duplicate-content', ({ expect }) => {
    expect(isParkedPathEligible('duplicate-content')).toBe(false)
  })

  it('returns true for no-episode-number', ({ expect }) => {
    expect(isParkedPathEligible('no-episode-number')).toBe(true)
  })

  it('returns true for no-signal', ({ expect }) => {
    expect(isParkedPathEligible('no-signal')).toBe(true)
  })
})

// Task 2（接回 [tmdbid-N] 证据通道，schema v26）：路径里的 TMDB id 标签本项目自己就在产出
// （libraryRealign 的 buildTargetShowDir 输出 `Show (Year) [tmdbid-N]/Season NN/`），此前
// parked_paths 缺这一列，等于"本项目整理过的库，再次扫描时认不出自己写下的 id"。
// 存的是 hint 不是判决——agent 仍须 TMDB 核验后才能认领。
describe('parked_paths.embedded_tmdb_id（[tmdbid-N] 路径标签，schema v26）', () => {
  it('parked_paths 存取 embedded_tmdb_id（[tmdbid-N] 路径标签）', () => {
    const lib = new LibraryRepo(db)
    lib.upsertParkedPath('/media/tv/Show (2020) [tmdbid-1396]/S01E01.mkv', 'awaiting-agent-identification', 1000, {
      mtimeMs: 500, size: 1024, embeddedTmdbId: '1396',
    })
    const row = lib.listParkedPaths().find((p) => p.path.includes('tmdbid-1396'))
    expect(row?.embedded_tmdb_id).toBe('1396')
  })

  it('无标签路径的 embedded_tmdb_id 为 NULL（绝大多数情况的回归锁）', () => {
    const lib = new LibraryRepo(db)
    lib.upsertParkedPath('/media/tv/Plain/S01E01.mkv', 'awaiting-agent-identification', 1000, {
      mtimeMs: 500, size: 1024,
    })
    const row = lib.listParkedPaths().find((p) => p.path.includes('Plain'))
    expect(row?.embedded_tmdb_id).toBeNull()
  })

  it('指纹未变的重 park 保留已有 embedded_tmdb_id（不被无标签的重 park 冲掉）', () => {
    const lib = new LibraryRepo(db)
    const p = '/media/tv/Show (2020) [tmdbid-1396]/S01E01.mkv'
    lib.upsertParkedPath(p, 'awaiting-agent-identification', 1000, { mtimeMs: 500, size: 1024, embeddedTmdbId: '1396' })
    lib.upsertParkedPath(p, 'awaiting-agent-identification', 2000, { mtimeMs: 500, size: 1024 })
    expect(lib.listParkedPaths().find((r) => r.path === p)?.embedded_tmdb_id).toBe('1396')
  })
})

describe('shouldRetryParkedPath 与 insufficient-evidence', () => {
  it('🔴 insufficient-evidence + 指纹未变 → 不重试（等用户改名）', () => {
    const lib = new LibraryRepo(db)
    const fp = { mtimeMs: 500, size: 1024 }
    lib.upsertParkedPath('/media/movies/random/1.mp4', PARK_REASON.insufficientEvidence, 1000, fp)
    expect(lib.shouldRetryParkedPath('/media/movies/random/1.mp4', fp, 1000 + 999 * 3600_000)).toBe(false)
  })

  it('🔴 指纹变了（用户动了文件）→ 重试，优先级高于 insufficient-evidence', () => {
    const lib = new LibraryRepo(db)
    lib.upsertParkedPath('/media/movies/random/1.mp4', PARK_REASON.insufficientEvidence, 1000, { mtimeMs: 500, size: 1024 })
    expect(lib.shouldRetryParkedPath('/media/movies/random/1.mp4', { mtimeMs: 999, size: 1024 }, 2000)).toBe(true)
  })

  it('identification-failed 照常按时间退避', () => {
    const lib = new LibraryRepo(db)
    const fp = { mtimeMs: 500, size: 1024 }
    lib.upsertParkedPath('/media/tv/x.mkv', PARK_REASON.identificationFailed, 1000, fp)
    expect(lib.shouldRetryParkedPath('/media/tv/x.mkv', fp, 1000)).toBe(false)
    expect(lib.shouldRetryParkedPath('/media/tv/x.mkv', fp, 1000 + 3700_000)).toBe(true)
  })
})
