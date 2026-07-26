import { describe, it, expect, beforeEach } from 'vitest'
import { join, sep } from 'node:path'
import { openDb } from './db.js'
import type { ScoutDb } from './db.js'
import { LibraryRepo, isParkedPathEligible } from './libraryRepo.js'

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

  it('listSeriesNeedingEnrich: genres IS NULL 的行（含空名占位建行——其 genres 必为 NULL），最多 limit 条', () => {
    lib.upsertSeries({ id: 's1', name: '' }) // 空名占位（P6 认领债务）——genres NULL，经 genres 臂落网
    lib.upsertSeries({ id: 's2', name: 'Show B' }) // genres 未富化（NULL）
    // 详情页重设计后"已富化不是候选"需连 overview 也落齐——否则会经放宽后的 overview IS NULL 臂
    // 被拉回候选（下方专测覆盖该新臂）。
    lib.upsertSeries({ id: 's3', name: 'Show C', genres: [16], overview: 'ov' }) // 已富化（含 overview），不是候选
    const rows = lib.listSeriesNeedingEnrich(10)
    expect(rows.map((r) => r.id).sort()).toEqual(['s1', 's2'])
  })

  it('listSeriesNeedingEnrich: genres 已富化但 overview NULL 的真名剧（存量回填缺口）是候选', () => {
    // 详情页重设计 item B：overview/backdrop 是后加列，存量已富化剧（genres 早非 NULL）overview
    // 恒 NULL。第二臂 overview IS NULL AND name != '' 把它们拉回候选一次性补拍；overview 落值后
    // 脱离该臂自熄火，无 re-enrich 风暴。
    lib.upsertSeries({ id: 's1', name: 'Stock Show', genres: [16] }) // genres 有、overview NULL、真名 → 候选
    expect(lib.listSeriesNeedingEnrich(10).map((r) => r.id)).toEqual(['s1'])
    // 回填 overview 后脱离候选（自熄火）
    lib.applyEnrichment('s1', { overview: 'now filled' })
    expect(lib.listSeriesNeedingEnrich(10)).toEqual([])
  })

  it('listSeriesNeedingEnrich: overview 臂受 name != \'\' 护栏——空名死 id（genres 已落定论）不因 overview NULL 复活候选', () => {
    // D6 熄火不变式的护栏：空名占位/404 死 id 一旦 genres 落非 NULL 定论（如 []）即须彻底退出候选，
    // 绝不能因 overview 永远拿不到而经 overview 臂永留候选空转烧 TMDB 配额。name != '' 护栏挡住它。
    lib.upsertSeries({ id: 'dead', name: '', genres: [] }) // 空名 + genres 定论 + overview NULL
    expect(lib.listSeriesNeedingEnrich(10)).toEqual([])
  })

  it('listSeriesNeedingEnrich: 空名但 TMDB 已有定论（404 → genres=[]）的行熄火，不再是候选', () => {
    // 404 时富化重试写 genres=[]（权威答复"查无此 id"，永久态）但 name 恒 ''——旧谓词的
    // name='' 臂会让它每轮重进候选、空转烧 TMDB 配额并挤占 cap 10 的重试槽。重试对这种行
    // 必然徒劳（TMDB 每次给同一答案）：定论即熄火。
    lib.upsertSeries({ id: 's404', name: '', genres: [] })
    expect(lib.listSeriesNeedingEnrich(10)).toEqual([])
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

  it('listSeriesNeedingEnrich 遵守 limit', () => {
    lib.upsertSeries({ id: 's1', name: '' })
    lib.upsertSeries({ id: 's2', name: '' })
    lib.upsertSeries({ id: 's3', name: '' })
    expect(lib.listSeriesNeedingEnrich(2)).toHaveLength(2)
  })

  it('applyEnrichment：name 只在当前空串时才写，非空 name 不覆盖', () => {
    lib.upsertSeries({ id: 's1', name: 'Existing Name' })
    lib.applyEnrichment('s1', { name: 'New Name From TMDB' })
    expect(lib.getSeries('s1')!.name).toBe('Existing Name')

    lib.upsertSeries({ id: 's2', name: '' })
    lib.applyEnrichment('s2', { name: 'Filled In' })
    expect(lib.getSeries('s2')!.name).toBe('Filled In')
  })

  it('applyEnrichment：chinese_title/poster_path/year/genres 只在现列 NULL 时才写', () => {
    lib.upsertSeries({ id: 's1', name: 'A', chineseTitle: '甲剧', posterPath: 'ptag', year: 2020, genres: [16] })
    lib.applyEnrichment('s1', { chineseTitle: '乙剧', posterPath: 'ptag2', year: 2099, genres: [35] })
    const row = lib.getSeries('s1')!
    expect(row.chinese_title).toBe('甲剧')
    expect(row.poster_path).toBe('ptag')
    expect(row.year).toBe(2020)
    expect(row.genres).toBe(JSON.stringify([16]))

    lib.upsertSeries({ id: 's2', name: 'B' }) // 全空
    lib.applyEnrichment('s2', { chineseTitle: '乙剧', posterPath: 'ptag2', year: 2099, genres: [35] })
    const row2 = lib.getSeries('s2')!
    expect(row2.chinese_title).toBe('乙剧')
    expect(row2.poster_path).toBe('ptag2')
    expect(row2.year).toBe(2099)
    expect(row2.genres).toBe(JSON.stringify([35]))
  })

  it('applyEnrichment：overview/backdrop 只在现列 NULL 时才回填，非空不覆盖', () => {
    // 详情页重设计 item B：存量已富化剧经放宽后的候选谓词重入后，由 applyEnrichment 把 getDetails
    // 的 overview/backdrop 落进原本 NULL 的两列——同 poster/genres 的"宁可不写不可覆盖"语义。
    lib.upsertSeries({ id: 's1', name: 'Stock Show', genres: [16] }) // overview/backdrop NULL
    lib.applyEnrichment('s1', { overview: 'filled ov', backdropPath: '/bd.jpg' })
    let row = db.prepare(`SELECT overview, backdrop_path FROM series WHERE id='s1'`).get() as { overview: string | null; backdrop_path: string | null }
    expect(row).toEqual({ overview: 'filled ov', backdrop_path: '/bd.jpg' })
    // 现列已非 NULL → 后续 enrich 不覆盖
    lib.applyEnrichment('s1', { overview: 'other', backdropPath: '/other.jpg' })
    row = db.prepare(`SELECT overview, backdrop_path FROM series WHERE id='s1'`).get() as { overview: string | null; backdrop_path: string | null }
    expect(row).toEqual({ overview: 'filled ov', backdrop_path: '/bd.jpg' })
  })

  it('applyEnrichment：字段缺省（undefined）视同没查到，不误写', () => {
    lib.upsertSeries({ id: 's1', name: '' })
    lib.applyEnrichment('s1', {}) // TMDB 失败路径：什么都没拿到
    const row = lib.getSeries('s1')!
    expect(row.name).toBe('')
    expect(row.chinese_title).toBeNull()
    expect(row.genres).toBeNull()
  })

  // origin_lang 缓存（task 2 依赖）
  it('origin_lang: set + get for series and movie, null by default', () => {
    lib.upsertSeries({ id: 's1', name: 'S', posterPath: null })
    expect(lib.getSeriesOriginLang('s1')).toBeNull()
    lib.setSeriesOriginLang('s1', 'zh')
    expect(lib.getSeriesOriginLang('s1')).toBe('zh')

    lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing', posterPath: null, year: null, providerIds: null })
    expect(lib.getMovieOriginLang('m1')).toBeNull()
    lib.setMovieOriginLang('m1', 'ja')
    expect(lib.getMovieOriginLang('m1')).toBe('ja')
  })
  it('getSeriesOriginLang / getMovieOriginLang return null for unknown ids', () => {
    expect(lib.getSeriesOriginLang('nope')).toBeNull()
    expect(lib.getMovieOriginLang('nope')).toBeNull()
  })
  it('upsertMovie does not clobber an existing origin_lang', () => {
    lib.upsertMovie({ id: 'm2', name: 'M', path: '/m.mkv', subStatus: 'missing', posterPath: null, year: null, providerIds: null })
    lib.setMovieOriginLang('m2', 'zh')
    lib.upsertMovie({ id: 'm2', name: 'M2', path: '/m2.mkv', subStatus: 'covered', posterPath: null, year: 2020, providerIds: null })
    expect(lib.getMovieOriginLang('m2')).toBe('zh')
  })

  // 债务D1（realign 出生信号换代）：摄取层每轮 pass 结束时写回的磁盘布局事实。
  it('setSeriesLayoutNonstandard 写 1/0', () => {
    lib.upsertSeries({ id: 's1', name: 'S' })
    expect(lib.getSeries('s1')!.layout_nonstandard).toBe(0)
    lib.setSeriesLayoutNonstandard('s1', true)
    expect(lib.getSeries('s1')!.layout_nonstandard).toBe(1)
    lib.setSeriesLayoutNonstandard('s1', false)
    expect(lib.getSeries('s1')!.layout_nonstandard).toBe(0)
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

  it('countEpisodesInSeason 统计指定季集数', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/b', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e3', seriesId: 's1', season: 2, episode: 1, name: 'E1', path: '/c', subStatus: 'missing' })
    expect(lib.countEpisodesInSeason('s1', 1)).toBe(2)
    expect(lib.countEpisodesInSeason('s1', 2)).toBe(1)
    expect(lib.countEpisodesInSeason('s1', 3)).toBe(0)
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

  it('deleteSeriesRows 同时清 item_files——否则 realign 后副本成孤儿、集永久隐形(SEVERE 腐蚀根因)', () => {
    // realign 收尾:refreshLibrary→ingest 用同一稳定 seriesId 重识别新目录,重叠集把新文件登记成旧行
    // 的 item_files 副本;deleteSeriesRows 若漏删 item_files,这些副本 owner 已删成孤儿 → 下一轮 ingest
    // B3-3 短路命中孤儿 path 却 ownerPath=null → continue,该 path 永不再被重识别成 episode → 集消失。
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 's1/e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/main.mkv', subStatus: 'covered' })
    lib.addItemFile('s1/e1', '/media/4k-replica.mkv', 1000) // 跨根副本
    expect(lib.getItemFileByPath('/media/4k-replica.mkv')).not.toBeNull()

    lib.deleteSeriesRows('s1')

    // 副本行必须一并清除,不能留成孤儿
    expect(lib.getItemFileByPath('/media/4k-replica.mkv')).toBeNull()
  })

  // R6-4 修复：deleteEpisodeByPath/deleteMovieByPath 也要清 item_files——deleteSeriesRows 的头注释
  // 把"owner 删了但 item_files 留孤儿"定性为 SEVERE 数据腐蚀，本方法与它同形，漏了同级清理。
  // 这两条测试锁住"item_files 必须一并清除，不能留成孤儿"。
  it('deleteEpisodeByPath 同时清 item_files——否则 episode 删除后副本成孤儿（R6-4 腐蚀）', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 's1/e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/main.mkv', subStatus: 'covered' })
    lib.addItemFile('s1/e1', '/media/4k-replica.mkv', 1000) // 跨根副本
    expect(lib.getItemFileByPath('/media/4k-replica.mkv')).not.toBeNull()

    lib.deleteEpisodeByPath('/media/main.mkv')

    // 副本行必须一并清除,不能留成孤儿
    expect(lib.getItemFileByPath('/media/4k-replica.mkv')).toBeNull()
  })

  it('deleteMovieByPath 同时清 item_files——否则 movie 删除后副本成孤儿（R6-4 腐蚀）', () => {
    lib.upsertMovie({ id: 'm1', name: 'Movie', path: '/media/movie.mkv', subStatus: 'covered' })
    lib.addItemFile('m1', '/media/movie-4k.mkv', 2000) // 跨根副本
    expect(lib.getItemFileByPath('/media/movie-4k.mkv')).not.toBeNull()

    lib.deleteMovieByPath('/media/movie.mkv')

    // 副本行必须一并清除,不能留成孤儿
    expect(lib.getItemFileByPath('/media/movie-4k.mkv')).toBeNull()
  })

  it('upsertSeries posterPath / upsertMovie posterPath 写入 poster_path 列', () => {
    lib.upsertSeries({ id: 's1', name: 'Show', posterPath: '/dqZEN.jpg' })
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

    it('救援R4b：addExtrasExemption/isExtrasExempt——幂等写入，命中查询', () => {
      expect(lib.isExtrasExempt('/media/Show - NCOP01.mkv')).toBe(false)
      lib.addExtrasExemption('/media/Show - NCOP01.mkv', 1000)
      expect(lib.isExtrasExempt('/media/Show - NCOP01.mkv')).toBe(true)
      // 幂等：重复写同一 path 不抛错
      lib.addExtrasExemption('/media/Show - NCOP01.mkv', 2000)
      expect(lib.isExtrasExempt('/media/Show - NCOP01.mkv')).toBe(true)
      // 未豁免的其他 path 不受影响
      expect(lib.isExtrasExempt('/media/Other.mkv')).toBe(false)
    })
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

    it('removeItemFileByPath：删副本行；不存在的 path 无事发生', () => {
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      lib.removeItemFileByPath('/media/4k.mkv')
      expect(lib.listItemFiles('s1/e1')).toEqual([])
      expect(() => lib.removeItemFileByPath('/media/nope.mkv')).not.toThrow()
    })

    it('promoteOldestReplica：最年长副本 path 顶替 episodes.path，该副本退出 item_files', () => {
      lib.addItemFile('s1/e1', '/media/1080p.mkv', 2000)
      lib.addItemFile('s1/e1', '/media/4k.mkv', 1000)
      const newMain = lib.promoteOldestReplica('s1/e1')
      expect(newMain).toBe('/media/4k.mkv')
      expect(lib.getEpisode('s1/e1')!.path).toBe('/media/4k.mkv')
      // 晋升的副本退出 item_files，只剩另一个
      expect(lib.listItemFiles('s1/e1').map((f) => f.path)).toEqual(['/media/1080p.mkv'])
    })

    it('promoteOldestReplica：movie 分支（两表尝试模式）', () => {
      lib.upsertMovie({ id: 'm1', name: 'M', path: '/media/m-main.mkv', subStatus: 'covered' })
      lib.addItemFile('m1', '/media/m-4k.mkv', 1000)
      expect(lib.promoteOldestReplica('m1')).toBe('/media/m-4k.mkv')
      expect(lib.getMovie('m1')!.path).toBe('/media/m-4k.mkv')
    })

    it('promoteOldestReplica：无副本可晋升 → 返回 null，不动主文件', () => {
      expect(lib.promoteOldestReplica('s1/e1')).toBeNull()
      expect(lib.getEpisode('s1/e1')!.path).toBe('/media/main.mkv')
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

  describe('identify_overrides', () => {
    it('addOverride + findOverride：单条命中', () => {
      lib.addOverride('/media/anime/Show', '209867', true, 1000)
      expect(lib.findOverride('/media/anime/Show/S01/e1.mkv')).toEqual({ tmdbId: '209867', isTv: true, season: null, source: 'human' })
    })

    it('findOverride 无命中返回 null', () => {
      lib.addOverride('/media/anime/Show', '209867', true, 1000)
      expect(lib.findOverride('/media/other/x.mkv')).toBeNull()
    })

    it('findOverride 最长前缀匹配：两条嵌套前缀，更长者胜出', () => {
      lib.addOverride('/media/anime', '1', true, 1000)
      lib.addOverride('/media/anime/Show', '209867', true, 2000)
      expect(lib.findOverride('/media/anime/Show/S01/e1.mkv')).toEqual({ tmdbId: '209867', isTv: true, season: null, source: 'human' })
      expect(lib.findOverride('/media/anime/Other/e1.mkv')).toEqual({ tmdbId: '1', isTv: true, season: null, source: 'human' })
    })

    it('addOverride 对同一 path_prefix 幂等更新（PRIMARY KEY upsert）', () => {
      lib.addOverride('/media/x', '1', true, 1000)
      lib.addOverride('/media/x', '2', false, 2000)
      expect(lib.findOverride('/media/x/a.mkv')).toEqual({ tmdbId: '2', isTv: false, season: null, source: 'human' })
    })

    // P7 disambiguation 补丁：认领时人类一并给出季号——见 db.ts identify_overrides 头注释、
    // recognition/index.ts recognize() 的 claim-gated 宽松救援分支。
    it('addOverride 带 season → findOverride 原样带回', () => {
      lib.addOverride('/media/TV/High School D×D', '24240', true, 1000, 4)
      expect(lib.findOverride('/media/TV/High School D×D/Hero - 01.mkv')).toEqual({
        tmdbId: '24240', isTv: true, season: 4, source: 'human',
      })
    })

    it('addOverride 不传 season（省略实参）默认为 null，不是遗留 undefined', () => {
      lib.addOverride('/media/anime/Show', '209867', true, 1000)
      expect(lib.findOverride('/media/anime/Show/e1.mkv')).toEqual({ tmdbId: '209867', isTv: true, season: null, source: 'human' })
    })

    it('addOverride 幂等更新同样覆盖 season（重新认领可以补上此前没给的季号）', () => {
      lib.addOverride('/media/x', '1', true, 1000)
      lib.addOverride('/media/x', '1', true, 2000, 4)
      expect(lib.findOverride('/media/x/a.mkv')).toEqual({ tmdbId: '1', isTv: true, season: 4, source: 'human' })
    })

    // v24（识别架构路 A，审计 B）：人写的认领是终局判断（且可能携带 agent 无从得知的 season
    // 消歧信息），agent 的 Step 0 核验是会出错的启发式——不对称覆盖规则钉死于此。
    describe('source 不对称覆盖（human 权威高于 agent）', () => {
      it('agent 认领不许覆盖人工认领：写入被拒，返回 false，原行纹丝不动', () => {
        lib.addOverride('/media/x', '111', true, 1000, 4, 'human')
        const written = lib.addOverride('/media/x', '222', true, 2000, null, 'agent')
        expect(written).toBe(false)
        // tmdbId 没变，尤其 season=4（用户为消歧特意填的）没被抹成 null
        expect(lib.findOverride('/media/x/a.mkv')).toEqual({ tmdbId: '111', isTv: true, season: 4, source: 'human' })
      })

      it('人工认领可以覆盖 agent 认领（人永远有最终裁量权）', () => {
        lib.addOverride('/media/x', '111', true, 1000, null, 'agent')
        const written = lib.addOverride('/media/x', '222', true, 2000, 4, 'human')
        expect(written).toBe(true)
        expect(lib.findOverride('/media/x/a.mkv')).toEqual({ tmdbId: '222', isTv: true, season: 4, source: 'human' })
      })

      it('agent 可以覆盖 agent 自己的旧认领（同级，后来者胜）', () => {
        lib.addOverride('/media/x', '111', true, 1000, null, 'agent')
        const written = lib.addOverride('/media/x', '222', true, 2000, null, 'agent')
        expect(written).toBe(true)
        expect(lib.findOverride('/media/x/a.mkv')).toEqual({ tmdbId: '222', isTv: true, season: null, source: 'agent' })
      })

      it('默认 source 为 human（既有调用方零改动即保持人工语义）', () => {
        lib.addOverride('/media/x', '111', true, 1000)
        expect(lib.findOverride('/media/x/a.mkv')!.source).toBe('human')
      })
    })

    // v24（审计 A-3）：裸 startsWith 会让 '/media/tv/Show' 的认领吞掉兄弟目录
    // '/media/tv/Showgirls 1995'、'/media/tv/Show Business'——前缀匹配必须落在路径边界上。
    it('前缀匹配落在路径边界：Show 的认领不吞 Showgirls / Show Business', () => {
      lib.addOverride(join(sep, 'media', 'tv', 'Show'), '111', true, 1000)
      expect(lib.findOverride(join(sep, 'media', 'tv', 'Show', 'S01', 'e1.mkv'))).not.toBeNull()
      expect(lib.findOverride(join(sep, 'media', 'tv', 'Showgirls 1995', 'x.mkv'))).toBeNull()
      expect(lib.findOverride(join(sep, 'media', 'tv', 'Show Business', 'S01', 'e1.mkv'))).toBeNull()
      // 认领目录自身（相等）仍算命中
      expect(lib.findOverride(join(sep, 'media', 'tv', 'Show'))).not.toBeNull()
    })
  })

  describe('probeMemo / setProbeMemo', () => {
    it('对 episode 行读写', () => {
      lib.upsertSeries({ id: 's1', name: 'A' })
      lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a', subStatus: 'missing' })
      expect(lib.probeMemo('e1')).toBeNull()
      lib.setProbeMemo('e1', 111, 222, ['chi', 'eng'])
      expect(lib.probeMemo('e1')).toEqual({ mtime: 111, size: 222, langs: ['chi', 'eng'] })
    })

    it('对 movie 行读写', () => {
      lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing' })
      expect(lib.probeMemo('m1')).toBeNull()
      lib.setProbeMemo('m1', 333, 444, null)
      expect(lib.probeMemo('m1')).toEqual({ mtime: 333, size: 444, langs: null })
    })

    it('未知 id 返回 null', () => {
      expect(lib.probeMemo('nope')).toBeNull()
    })
  })

  describe('deleteEpisodeByPath / deleteMovieByPath / deleteSeriesIfEmpty', () => {
    it('deleteEpisodeByPath 删除该行 + 关联 subtitles', () => {
      lib.upsertSeries({ id: 's1', name: 'A' })
      lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a.mkv', subStatus: 'covered' })
      lib.markCovered('e1', '/a.zh-Hans.srt', 'scout-download')
      lib.deleteEpisodeByPath('/a.mkv')
      expect(lib.getEpisode('e1')).toBeNull()
      expect(lib.db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id=?').get('e1')).toEqual({ c: 0 })
    })

    it('deleteEpisodeByPath 对不存在的路径是空操作', () => {
      expect(() => lib.deleteEpisodeByPath('/nope.mkv')).not.toThrow()
    })

    it('deleteMovieByPath 删除该行 + 关联 subtitles', () => {
      lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'covered' })
      lib.markCovered('m1', '/m.zh-Hans.srt', 'scout-download')
      lib.deleteMovieByPath('/m.mkv')
      expect(lib.getMovie('m1')).toBeNull()
      expect(lib.db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id=?').get('m1')).toEqual({ c: 0 })
    })

    it('deleteSeriesIfEmpty：还有集时不删；集清空后删', () => {
      lib.upsertSeries({ id: 's1', name: 'A' })
      lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a.mkv', subStatus: 'missing' })
      lib.deleteSeriesIfEmpty('s1')
      expect(lib.getSeries('s1')).not.toBeNull()

      lib.deleteEpisodeByPath('/a.mkv')
      lib.deleteSeriesIfEmpty('s1')
      expect(lib.getSeries('s1')).toBeNull()
    })

    // 审计 M4：tmdb_seasons 是 series 级联的一部分（settingsRepo 删守备目录时就是这么清的），
    // 此前漏清 → 身份纠错频繁删空 series 行时孤儿季表无上界累积；更实际的危害是同一
    // series_id 回归时 tmdbCatalog 的 TTL 门读 MAX(fetched_at) 7 天内早退，静默跳过刷缓存。
    it('deleteSeriesIfEmpty 连带清 tmdb_seasons（不留孤儿季表）', () => {
      lib.upsertSeries({ id: 's1', name: 'A' })
      lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a.mkv', subStatus: 'missing' })
      lib.db
        .prepare(`INSERT INTO tmdb_seasons (series_id, season, episode, air_date, fetched_at) VALUES (?, 1, 1, NULL, ?)`)
        .run('s1', 1000)
      expect(lib.db.prepare(`SELECT COUNT(*) as c FROM tmdb_seasons WHERE series_id=?`).get('s1')).toEqual({ c: 1 })

      // 还有集时不动
      lib.deleteSeriesIfEmpty('s1')
      expect(lib.db.prepare(`SELECT COUNT(*) as c FROM tmdb_seasons WHERE series_id=?`).get('s1')).toEqual({ c: 1 })

      lib.deleteEpisodeByPath('/a.mkv')
      lib.deleteSeriesIfEmpty('s1')
      expect(lib.getSeries('s1')).toBeNull()
      expect(lib.db.prepare(`SELECT COUNT(*) as c FROM tmdb_seasons WHERE series_id=?`).get('s1')).toEqual({ c: 0 })
    })
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
