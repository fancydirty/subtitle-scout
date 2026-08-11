import { describe, it, expect } from 'vitest'
import { openDb } from './db.js'
import { runIdentifyWorkDir, type IdentifySchedulerDeps } from './identifyScheduler.js'
import type { IdentifyReport } from '../agent/identifyWorker.js'

function mkDeps(db: ReturnType<typeof openDb>, runIdentifyImpl: () => Promise<IdentifyReport>): IdentifySchedulerDeps {
  return {
    db,
    runIdentify: async () => runIdentifyImpl(),
    worker: {
      model: {} as any,
      tmdb: { search: async () => [], getDetails: async () => null } as any,
    },
  }
}


describe('runIdentifyWorkDir（识别轨 catch-all）', () => {
  it('🔴 识别抛错 → next_retry_at 推进（不 30s 死循环）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Show'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/E01.mkv`, workDir, 'E01.mkv', 100, 1000, workDir, 1000)

    const deps = mkDeps(db, () => { throw new Error('LLM timeout') })
    const report = await runIdentifyWorkDir(deps, {
      workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false,
    })
    const row = db.prepare('SELECT attempt, next_retry_at, last_error FROM files WHERE work_dir = ?').get(workDir) as any
    expect(row.attempt).toBe(1)
    expect(row.next_retry_at).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
    expect(row.next_retry_at).toBeLessThan(Date.now() + 28 * 60 * 60 * 1000)
    expect(row.last_error).toContain('LLM timeout')
    expect(report.tmdbId).toBeNull()
    db.close()
  })

  it('🔴 连续抛错 → 退避递增（attempt 阶梯）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Show'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/E01.mkv`, workDir, 'E01.mkv', 100, 1000, workDir, 1000)
    const deps = mkDeps(db, () => { throw new Error('err') })
    await runIdentifyWorkDir(deps, { workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false })
    await runIdentifyWorkDir(deps, { workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false })
    const row = db.prepare('SELECT attempt, next_retry_at FROM files WHERE work_dir = ?').get(workDir) as any
    expect(row.attempt).toBe(2)
    // 巡检模型：全部 24h
    expect(row.next_retry_at).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C5：识别时把 imdb 落进 works.provider_ids。
//
// 为什么这一步不能"等翻译流自己去查"：翻译抓源腿是**机械路径**（fetchSourceSub 内部任何网络
// 错都吞成"试下一候选"，绝不抛），它没有任何位置能承载一次 TMDB 往返的失败与退避。而识别
// 本来就已经在打 TMDB（getDetails），顺手多一个 external_ids 请求是同一次会话里最便宜的采集点。
//
// 为什么 imdb 缺席**不许**让识别失败：getExternalIds 的语义是 404→{imdbId:null}（真无数据）、
// 其余失败→抛 TmdbRequestFailedError（瞬时）。身份认定只依赖 getDetails 本体——这是
// tmdbCatalog / cli/index.ts 里 getChineseTitles/getOriginLanguage 的既有口径（两者都用
// `.catch(() => …)` 兜住）。若让 external_ids 的一次 5xx 把整次识别打回退避轨，
// 代价是一整个作品目录明天才重试、外加一次白烧的 LLM session。
// ─────────────────────────────────────────────────────────────────────────────
describe('runIdentifyWorkDir · works.provider_ids 落库（C5）', () => {
  const DETAILS = {
    id: 1, title: 'The Rig', originalTitle: 'The Rig', year: 2023,
    overview: null, posterPath: null, genreIds: null,
    originLanguage: 'en', chineseTitles: ['钻井危机'],
  }

  /** 播种一个"agent 已确认身份"的场景：目录名与 TMDB 标题一致才能过 verifyEvidence。 */
  function seed(db: ReturnType<typeof openDb>) {
    const workDir = '/media/TV/The Rig (2023)'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/S02E06.mkv`, workDir, 'S02E06.mkv', 100, 1000, workDir, 2, 6, 1000)
    return workDir
  }

  function depsWith(
    db: ReturnType<typeof openDb>,
    workDir: string,
    externalIds: (mt: 'tv' | 'movie', id: string) => Promise<{ imdbId: string | null }>,
  ): IdentifySchedulerDeps {
    return {
      db,
      runIdentify: async () => ({ tmdbId: '1', title: 'The Rig', reason: 'confirmed' }),
      worker: {
        model: {} as any,
        tmdb: {
          search: async () => [],
          getDetails: async () => DETAILS,
          getExternalIds: externalIds,
        } as any,
      },
    }
  }

  const item = (workDir: string) => ({
    workDir, dirName: 'The Rig (2023)', fileCount: 1, seasons: [2], hasSeasonDirs: true,
  })

  it('🔴 用例 6：识别成功 → works.provider_ids 含 imdb（JSON，照旧表既有口径）', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    const calls: Array<[string, string]> = []
    const deps = depsWith(db, workDir, async (mt, id) => {
      calls.push([mt, id]); return { imdbId: 'tt14827638' }
    })
    await runIdentifyWorkDir(deps, item(workDir))

    // 前置：识别真的成功了（否则下面断言 provider_ids 为 NULL 也"通过"，是假绿）
    const bound = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as { work_id: string | null }
    expect(bound.work_id).toBe('tmdb:1')

    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(row.provider_ids).not.toBeNull()
    // 形状锁死成 record（不是裸 'tt...' 串）：fetchSourceSub 的 imdbFromProviderIds 与
    // v2/findSubtitleWorkerTask 的 parseProviderIds 都按 `{imdb: string}` 解析，
    // 存成裸串两处都会静默返回 undefined —— 列有值、功能照旧退化，最难查的那种。
    expect(JSON.parse(row.provider_ids!)).toEqual({ tmdb: '1', imdb: 'tt14827638' })
    // 用的是 getDetails 那一次已经定下的 mediaType 与 id，不是二次推断
    expect(calls).toEqual([['tv', '1']])
    db.close()
  })

  it('🔴 getExternalIds 抛错 → 识别照常成功，provider_ids 落 NULL（增益不许反噬主线）', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    const deps = depsWith(db, workDir, async () => { throw new Error('TMDB 503') })
    await runIdentifyWorkDir(deps, item(workDir))

    const bound = db.prepare('SELECT work_id, last_error FROM files WHERE work_dir = ?')
      .get(workDir) as { work_id: string | null; last_error: string | null }
    expect(bound.work_id).toBe('tmdb:1')       // 身份认定不依赖 external_ids
    expect(bound.last_error).toBeNull()        // 没被打进退避轨
    // 留 NULL 而不是 '{}' —— NULL 是回填 pass 的唯一取件凭据（C21）。写成 '{}' 就等于
    // 声称"查过了、TMDB 真没有"，这一行从此永远补不上 imdb（同 D18/D22 那个坑的第 N 次）。
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(row.provider_ids).toBeNull()
    db.close()
  })

  it('🔴 TMDB 真无 imdb（imdbId=null）→ provider_ids 仍落库（有 tmdb 键，非 NULL）', async () => {
    // 与上一条的分野：这里是**查过、确认没有**，不该让回填 pass 每天回来重查一遍
    // （identifyScheduler 的队列谓词永不再选它，但回填 pass 的谓词会——见 C21）。
    // 收敛靠"非 NULL"，故这一支必须写。
    const db = openDb(':memory:')
    const workDir = seed(db)
    const deps = depsWith(db, workDir, async () => ({ imdbId: null }))
    await runIdentifyWorkDir(deps, item(workDir))
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(JSON.parse(row.provider_ids!)).toEqual({ tmdb: '1' })
    db.close()
  })

  it('🔴 getExternalIds 未注入（旧构造点）→ 识别照常，不抛（optional 接线纪律）', async () => {
    // IdentifyWorkerDeps.tmdb 有几十个既有构造点（cli/index.ts、dispatcher.test、daemonV2.test…）。
    // 把 getExternalIds 做成必填会让它们全部编译不过；做成可选则"生产漏接线"是**静默**的
    // ——这条与 watchWiring.test.ts 逐个器官钉住接线是同一套分工：类型层留宽，接线层单钉。
    const db = openDb(':memory:')
    const workDir = seed(db)
    const deps: IdentifySchedulerDeps = {
      db,
      runIdentify: async () => ({ tmdbId: '1', title: 'The Rig', reason: 'confirmed' }),
      worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => DETAILS } as any },
    }
    await runIdentifyWorkDir(deps, item(workDir))
    const bound = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as { work_id: string | null }
    expect(bound.work_id).toBe('tmdb:1')
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(row.provider_ids).toBeNull()
    db.close()
  })

  it('🔴 重识别同一作品 → 已有的 provider_ids 不被 INSERT OR REPLACE 洗成 NULL', async () => {
    // identifyScheduler 用的是 `INSERT OR REPLACE INTO works`，语义是**整行替换**。
    // 若某次重识别（用户重命名目录/手动重跑）拿不到 external_ids，REPLACE 会把上一次
    // 成功采到的 imdb 抹掉 —— 而回填 pass 的谓词是 `provider_ids IS NULL`，
    // 它会把这一行捡回来重查，不至于永久丢。但白烧一次 TMDB 且抓源腿在两轮之间退化。
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(deps1(), item(workDir))
    function deps1() { return depsWith(db, workDir, async () => ({ imdbId: 'tt14827638' })) }
    // 第二次：external_ids 挂了
    await runIdentifyWorkDir(depsWith(db, workDir, async () => { throw new Error('503') }), item(workDir))
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(row.provider_ids).not.toBeNull()
    expect(JSON.parse(row.provider_ids!).imdb).toBe('tt14827638')
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v42 / R-F13：识别时把横版背景图落进 works.backdrop_path。
//
// 这是 backdrop_path 的**写入点①**。为什么只有回填 pass 不够（本仓病 A 的典型形态
// ——"只修一半"）：identifyScheduler 的队列谓词是 `files.work_id IS NULL`，识别成功后
// 那个目录永不再进识别队列；反过来只有回填 pass 而没有这一点，新识别的作品要等到
// **下一次 boot** 才拿到图（boot 可能几周一次），在那之前活动页对它退化成模糊海报。
// 两个写入点合起来才收敛，同 provider_ids（C5 写入点 + C21 回填 pass）的既有分工。
// ─────────────────────────────────────────────────────────────────────────────
describe('runIdentifyWorkDir · works.backdrop_path 落库（v42 / R-F13 写入点①）', () => {
  const BASE = {
    id: 1, title: 'The Rig', originalTitle: 'The Rig', year: 2023,
    overview: null, posterPath: null, genreIds: null,
    originLanguage: 'en', chineseTitles: ['钻井危机'],
  }

  function seed(db: ReturnType<typeof openDb>) {
    const workDir = '/media/TV/The Rig (2023)'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/S02E06.mkv`, workDir, 'S02E06.mkv', 100, 1000, workDir, 2, 6, 1000)
    return workDir
  }

  const item = (workDir: string) => ({
    workDir, dirName: 'The Rig (2023)', fileCount: 1, seasons: [2], hasSeasonDirs: true,
  })

  function depsWith(db: ReturnType<typeof openDb>, details: unknown): IdentifySchedulerDeps {
    return {
      db,
      runIdentify: async () => ({ tmdbId: '1', title: 'The Rig', reason: 'confirmed' }),
      worker: {
        model: {} as any,
        tmdb: { search: async () => [], getDetails: async () => details } as any,
      },
    }
  }

  it('🔴 识别成功 → works.backdrop_path 落 TMDB 的 backdropPath（此前这一列被丢弃）', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, { ...BASE, backdropPath: '/bd.jpg' }), item(workDir))

    // 前置：识别真的成功了（否则下面断言列值也可能"通过"，是假绿）
    const bound = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as { work_id: string | null }
    expect(bound.work_id).toBe('tmdb:1')

    const row = db.prepare('SELECT backdrop_path FROM works WHERE id = ?').get('tmdb:1') as { backdrop_path: string | null }
    expect(row.backdrop_path).toBe('/bd.jpg')
    db.close()
  })

  it('🔴 TMDB 真没有横版图（backdropPath=null）→ 落 NULL，识别照常成功', async () => {
    // NULL 是回填 pass 的取件谓词。这里刻意**不写空串哨兵**：裸路径列没有第三个值可用，
    // "查过没有"与"还没采过"在这一列上不可区分是已知代价（见 db.ts v42 entry）。
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, { ...BASE, backdropPath: null }), item(workDir))
    const bound = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as { work_id: string | null }
    expect(bound.work_id).toBe('tmdb:1')
    const row = db.prepare('SELECT backdrop_path FROM works WHERE id = ?').get('tmdb:1') as { backdrop_path: string | null }
    expect(row.backdrop_path).toBeNull()
    db.close()
  })

  it('🔴 getDetails 没给 backdropPath 字段（旧构造点）→ 落 NULL，不抛（optional 接线纪律）', async () => {
    // IdentifyWorkerDeps.tmdb.getDetails 的 backdropPath 是 optional（几十个既有构造点的
    // 编译成本，同 getExternalIds 的既有分工：类型层留宽、接线层单钉）。
    // 这一条钉的是**不许炸**：undefined 直接喂给 better-sqlite3 会抛
    // `TypeError: Invalid value`，把一次成功的识别整个打回退避轨。
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, BASE), item(workDir))   // BASE 里没有 backdropPath
    const bound = db.prepare('SELECT work_id, last_error FROM files WHERE work_dir = ?')
      .get(workDir) as { work_id: string | null; last_error: string | null }
    expect(bound.work_id).toBe('tmdb:1')
    expect(bound.last_error).toBeNull()          // 没被打进退避轨
    const row = db.prepare('SELECT backdrop_path FROM works WHERE id = ?').get('tmdb:1') as { backdrop_path: string | null }
    expect(row.backdrop_path).toBeNull()
    db.close()
  })

  it('🔴 重识别同一作品 → 已有的 backdrop_path 不被 INSERT OR REPLACE 洗成 NULL', async () => {
    // `INSERT OR REPLACE INTO works` 是**整行替换**（provider_ids 那条已经吃过一次）。
    // 第二次识别拿不到横版图时若直接绑 null，会把回填 pass 上一轮采到的值抹掉——
    // 而与 provider_ids 不同的是，这里丢了**不保证**补得回来：若 TMDB 对这个作品本来
    // 就没有横版图，回填每轮都白烧一次往返却永远写不进值。
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, { ...BASE, backdropPath: '/bd.jpg' }), item(workDir))
    // 第二次：TMDB 这次没给横版图
    await runIdentifyWorkDir(depsWith(db, { ...BASE, backdropPath: null }), item(workDir))
    const row = db.prepare('SELECT backdrop_path FROM works WHERE id = ?').get('tmdb:1') as { backdrop_path: string | null }
    expect(row.backdrop_path).toBe('/bd.jpg')
    db.close()
  })
})
