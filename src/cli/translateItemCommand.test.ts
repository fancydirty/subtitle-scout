import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { translateTimeoutMs, sourceLangDisplayName, sidecarPathFor, readSeriesTargetSubs, locateTranslateIdentity, makeDaemonTranslateRunItem, tryAutoTranslateCfg } from './translateItemCommand.js'
import { openDb } from '../v2/db.js'
import { makeAdapterConfigResolver, envOnlyAdapterConfig } from '../v2/secrets.js'
import { translateItemId } from '../v2/ownIds.js'
import { seriesKeyOf } from '../v2/glossaryRepo.js'
import { listNewTranslateCandidates } from '../v2/translateWorkerTask.js'

// 真机逼出(F1 验收):34-cue 大批经慢端点 120s(LLM_TIMEOUT_MS)必然超时 → 整档 false-held。
// 翻译批的超时独立可配且默认更宽(300s),不与 captcha 等快路径共享 120s。
describe('translateTimeoutMs — 翻译批超时可配', () => {
  it('未配 TRANSLATE_TIMEOUT_MS → 默认 300s(大批慢端点容忍)', () => {
    expect(translateTimeoutMs({})).toBe(300_000)
  })

  it('配了合法毫秒数 → 用之', () => {
    expect(translateTimeoutMs({ TRANSLATE_TIMEOUT_MS: '600000' })).toBe(600_000)
  })

  it('脏值(非数字/零/负) → 回退默认 300s', () => {
    expect(translateTimeoutMs({ TRANSLATE_TIMEOUT_MS: 'abc' })).toBe(300_000)
    expect(translateTimeoutMs({ TRANSLATE_TIMEOUT_MS: '0' })).toBe(300_000)
    expect(translateTimeoutMs({ TRANSLATE_TIMEOUT_MS: '-5' })).toBe(300_000)
  })
})

describe('sourceLangDisplayName — F2 prompt 源语言名', () => {
  it('en → 英文;ja/jpn → 日文;缺省 → 英文;未知 → 源语言', () => {
    expect(sourceLangDisplayName('en')).toBe('英文')
    expect(sourceLangDisplayName('en-US')).toBe('英文')
    expect(sourceLangDisplayName('ja')).toBe('日文')
    expect(sourceLangDisplayName('jpn')).toBe('日文')
    expect(sourceLangDisplayName(null)).toBe('英文')
    expect(sourceLangDisplayName(undefined)).toBe('英文')
    expect(sourceLangDisplayName('ko')).toBe('源语言')
  })
})

describe('sidecarPathFor — 绝不返回源路径本身(审计🔴:无扩展名时会覆盖视频)', () => {
  it('常规视频 → 替换扩展名', () => {
    expect(sidecarPathFor('/media/a/b.mkv')).toBe('/media/a/b.zh-Hans.srt')
  })
  it('无扩展名/以点结尾 → 追加而非覆盖源文件', () => {
    expect(sidecarPathFor('/media/a/movie')).toBe('/media/a/movie.zh-Hans.srt')
    expect(sidecarPathFor('/media/a/movie.')).toBe('/media/a/movie..zh-Hans.srt')
    expect(sidecarPathFor('/media/a/movie')).not.toBe('/media/a/movie')
  })
  it('输出永≠输入', () => {
    for (const p of ['/x/y.mkv', '/x/y', '/x/.hidden', '/x/y.']) {
      expect(sidecarPathFor(p)).not.toBe(p)
    }
  })
})

describe('readSeriesTargetSubs — 同目录中文 sidecar 当术语锚', () => {
  it('只收中文 tag 的 sidecar;无则 null;视频本身与英文 sidecar 排除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-subs-'))
    try {
      writeFileSync(join(dir, 'e01.mkv'), 'video')
      writeFileSync(join(dir, 'e01.zh-Hans.srt'), '1\n00:00:01,000 --> 00:00:02,000\n你好\n')
      writeFileSync(join(dir, 'e01.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n')
      writeFileSync(join(dir, 'e02.zh-Hant.ass'), '[Script Info]\n')
      const md = readSeriesTargetSubs(join(dir, 'e01.mkv'))
      expect(md).toContain('你好')
      expect(md).not.toContain('Hello')
      expect(md).toContain('e02.zh-Hant.ass')
      expect(readSeriesTargetSubs(join(dir, 'none'))).not.toBeNull() // 同目录有中文 sidecar 即可
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const empty = mkdtempSync(join(tmpdir(), 'tw-subs-empty-'))
    try {
      expect(readSeriesTargetSubs(join(empty, 'x.mkv'))).toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

// ⚠️ 这两条原本 seed 的是 episodes/movies + series（旧表契约），随第 4 步 C4 改读 files/works
// 而整体重写——**它们全绿恰恰是这处断裂能潜伏到今天的原因**（测试忠实锁死了一个接错表的实现，
// 与 4-2 对 fetchSourceSub 那 3 条旧表用例的处置同一口径）。
// 断言的**意图**逐条保留：tv 取 title/origin_lang/tmdbId/mediaType、movie 同构、未命中 → null。
// 变的只是数据落在哪张表，以及 itemId 从旧世界的 own-id 变成 C20 定的新形态。
describe('locateTranslateIdentity — db 身份定位（新架构 files/works）', () => {
  it('tv:JOIN works 取 itemId/title/origin_lang/tmdbId/mediaType=tv', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at)
                VALUES ('tmdb:261868', 'Witch Watch', 'tv', 'ja', 0, 0)`).run()
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id, season, episode, sub_status, updated_at)
                VALUES ('/media/tv/ww/e02.mkv', '/media/tv/ww', 'e02.mkv', 100, 0, 'tmdb:261868', 1, 2, 'handoff_translate', 0)`).run()
    expect(locateTranslateIdentity(db, '/media/tv/ww/e02.mkv')).toEqual({
      itemId: translateItemId('tmdb:261868', '/media/tv/ww/e02.mkv'),
      title: 'Witch Watch', originLang: 'ja', tmdbId: '261868', mediaType: 'tv',
    })
    db.close()
  })

  it('movie:同构;未命中 → null', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at)
                VALUES ('tmdb:7', 'Some Film', 'movie', 'en', 0, 0)`).run()
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id, sub_status, updated_at)
                VALUES ('/media/movies/f.mkv', '/media/movies', 'f.mkv', 100, 0, 'tmdb:7', 'handoff_translate', 0)`).run()
    expect(locateTranslateIdentity(db, '/media/movies/f.mkv')).toEqual({
      itemId: translateItemId('tmdb:7', '/media/movies/f.mkv'),
      title: 'Some Film', originLang: 'en', tmdbId: '7', mediaType: 'movie',
    })
    expect(locateTranslateIdentity(db, '/nowhere.mkv')).toBeNull()
    db.close()
  })
})

describe('makeDaemonTranslateRunItem — P3 daemon runItem', () => {
  // 同上：seed 从旧表 series/episodes 换成新架构 files/works（C4）。断言意图不变。
  function seedDb(): ReturnType<typeof openDb> {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at)
                VALUES ('tmdb:261868', 'Witch Watch', 'tv', 'ja', 0, 0)`).run()
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id, season, episode, sub_status, updated_at)
                VALUES ('/media/tv/ww/e02.mkv', '/media/tv/ww', 'e02.mkv', 100, 0, 'tmdb:261868', 1, 2, 'handoff_translate', 0)`).run()
    return db
  }

  it('库外路径 → no-source(llmCalls=0),不调 agent', async () => {
    const db = seedDb()
    let agentCalls = 0
    const runItem = makeDaemonTranslateRunItem({
      db,
      cfg: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
      roots: () => [],
      agentRunner: (() => {
        return async () => { agentCalls++; return { status: 'installed', reason: null, sourceRef: null, sidecarPath: '/x.srt', llmCalls: 9 } as never }
      })() as never,
    })
    const r = await runItem('/nowhere/x.mkv')
    expect(r).toMatchObject({ status: 'no-source', llmCalls: 0 })
    expect(agentCalls).toBe(0)
    db.close()
  })

  it('库内身份 → 构造 agent 任务(itemId/originLang/stagingRoot=配置根),报告归一化', async () => {
    const db = seedDb()
    let seenTask: Record<string, unknown> | null = null
    const runItem = makeDaemonTranslateRunItem({
      db,
      cfg: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
      roots: () => ['/media/tv'],
      agentRunner: (() => {
        return async (task: Record<string, unknown>) => {
          seenTask = task
          return { status: 'installed', reason: null, sourceRef: 'embedded:s:1', sidecarPath: '/media/tv/ww/e02.zh-Hans.srt', llmCalls: 9 } as never
        }
      })() as never,
    })
    const r = await runItem('/media/tv/ww/e02.mkv')
    expect(seenTask).toMatchObject({
      // itemId 从旧世界的 episode own-id 换成 C20 定的新形态（唯一构造入口 translateItemId）。
      itemId: translateItemId('tmdb:261868', '/media/tv/ww/e02.mkv'), originLang: 'ja', title: 'Witch Watch',
      mediaRoot: '/media/tv/ww', stagingRoot: '/media/tv',
    })
    expect(r).toMatchObject({
      status: 'installed', sourceRef: 'embedded:s:1',
      sidecarPath: '/media/tv/ww/e02.zh-Hans.srt', llmCalls: 9,
    })
    expect(r.reason).toBeUndefined() // null → undefined 归一化
    db.close()
  })

  it('makeTranslateAgentDeps with db: glossaryStore 直连 GlossaryRepo(ESM 无 require)', async () => {
    const db = openDb(':memory:')
    const { makeTranslateAgentDeps } = await import('./translateItemCommand.js')
    const deps = makeTranslateAgentDeps(
      { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
      undefined,
      { db, critic: false },
    )
    expect(deps.glossaryStore).toBeDefined()
    deps.glossaryStore!.save('tmdb:1', [{ src: 'Nico', zh: '妮可' }], 1)
    expect(deps.glossaryStore!.load('tmdb:1')).toEqual([{ src: 'Nico', zh: '妮可' }])
    db.close()
  })
})

describe('tryAutoTranslateCfg — 来源无关 + 绝不回落 LLM_*', () => {
  const baseEnv = { TRANSLATE_BASE_URL: 'https://api.example.com/v1', TRANSLATE_API_KEY: 'sk-t', TRANSLATE_MODEL: 'gpt-4o-mini' }

  it('env 三凭证全有 → 返回 env 值', () => {
    const cfg = envOnlyAdapterConfig(baseEnv)
    expect(tryAutoTranslateCfg(cfg)).toEqual({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-t', model: 'gpt-4o-mini' })
  })

  it('db 三凭证全有 → 返回 db 值（env 缺席）', () => {
    const cfg = makeAdapterConfigResolver({}, (k) => {
      const map: Record<string, string> = {
        'secret:TRANSLATE_BASE_URL': 'https://db.example.com/v1',
        'secret:TRANSLATE_API_KEY': 'sk-db',
        'secret:TRANSLATE_MODEL': 'db-model',
      }
      return map[k] ?? null
    })
    expect(tryAutoTranslateCfg(cfg)).toEqual({ baseUrl: 'https://db.example.com/v1', apiKey: 'sk-db', model: 'db-model' })
  })

  it('env 缺一 → 返回 null（绝不回落 LLM_*）', () => {
    const cfg = envOnlyAdapterConfig({ ...baseEnv, TRANSLATE_API_KEY: '' })
    expect(tryAutoTranslateCfg(cfg)).toBeNull()
  })

  it('三凭证全无 → null', () => {
    const cfg = envOnlyAdapterConfig({})
    expect(tryAutoTranslateCfg(cfg)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 新架构（第 4 步 / C4 + C20）：locateTranslateIdentity 必须读 files/works，且 itemId 必须
// 由 ownIds.translateItemId 产出。
//
// **为什么这是本步最危险的一处**（4-2 的交接只点到一半）：4-2 把 fetchSourceSub 的 locate
// 改读了 files/works，但**这一个** locate 没改——它仍是 `FROM episodes JOIN series` / `FROM movies`。
// 而它是生产路径上 itemId 的**真实构造点**：daemonV2 的翻译循环 → makeDaemonTranslateRunItem
// → locateTranslateIdentity → agent task.itemId → translateWorker.tools 的 seriesKeyOf。
// 新架构下 episodes/movies 是空表，于是：
//  ① 每一个待翻文件都命中 `identity === null` → 返回 no-source → 按 §5 映射写 unsolvable
//     → **翻译流刚接回来就把全库待翻文件判成"无源停牌"**，且这是个诚实终态、看不出是 bug；
//  ② 即便有存量旧表行侥幸命中，itemId 也是旧世界的 `tmdb:1/s1e2` 而不是新形态。
// 4-3 的候选谓词只保证了 candidate.itemId 对，而 candidate.itemId **根本没被传下去**
// （runItem 的签名只收 videoPath，itemId 在里面重新算一遍）——两处不同源正是 C20 的形态。
// ─────────────────────────────────────────────────────────────────────────────
describe('locateTranslateIdentity — 新架构读 files/works（C4 + C20 的生产构造点）', () => {
  function seedNew(db: ReturnType<typeof openDb>): void {
    db.prepare(`INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at)
                VALUES ('tmdb:261868', 'Witch Watch', 'tv', 'ja', 0, 0)`).run()
    for (const [path, season, ep] of [
      ['/media/tv/ww/e02.mkv', 1, 2], ['/media/tv/ww/e03.mkv', 1, 3],
    ] as const) {
      db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id, season, episode,
                                     sub_status, updated_at)
                  VALUES (?,?,?,100,0,'tmdb:261868',?,?,'handoff_translate',0)`)
        .run(path, '/media/tv/ww', path.slice(path.lastIndexOf('/') + 1), season, ep)
    }
  }

  it('🔴 files/works 命中 → itemId 是新形态 `<work_id>/<sha1前12>`，origin_lang 取 works', () => {
    const db = openDb(':memory:')
    seedNew(db)
    const got = locateTranslateIdentity(db, '/media/tv/ww/e02.mkv')
    // 期望值**独立算出**（写死 sha1 前 12 位），不是拿 translateItemId 跟自己比——
    // 后者在"实现手拼但恰好同形"时也会绿。
    expect(got).toEqual({
      itemId: 'tmdb:261868/6ac516dcdc2a', title: 'Witch Watch', originLang: 'ja',
      tmdbId: '261868', mediaType: 'tv',
    })
    // 与唯一构造入口同值（这一条防的是两份实现漂移，与上一条职责不同）
    expect(got!.itemId).toBe(translateItemId('tmdb:261868', '/media/tv/ww/e02.mkv'))
    db.close()
  })

  it('🔴 同剧两集的 itemId 被 seriesKeyOf 解出同一 key（C20 端到端，生产路径）', () => {
    // 这条钉的是 C20 的真实伤害面：itemId 形态错了 → 每个文件一个 glossary key →
    // 同剧第 2 集拿不到第 1 集冻结的术语表 → 人名地名每集换译法（实案："东国 / 奥斯塔尼亚"）。
    // 纯质量漂移，功能"能跑"、字幕"能出"，别处没有任何断言会红。
    const db = openDb(':memory:')
    seedNew(db)
    const a = locateTranslateIdentity(db, '/media/tv/ww/e02.mkv')!
    const b = locateTranslateIdentity(db, '/media/tv/ww/e03.mkv')!
    expect(seriesKeyOf(a.itemId)).toBe('tmdb:261868')
    expect(seriesKeyOf(b.itemId)).toBe('tmdb:261868')
    expect(a.itemId).not.toBe(b.itemId)      // 但两集本身必须可区分
    db.close()
  })

  it('🔴 与翻译工作台的 candidate.itemId **逐字一致**（同源，不许两处各算一份）', () => {
    // daemonV2 的循环用 listNewTranslateCandidates 取活、用 videoPath 调 runItem，
    // runItem 内部再由本函数算一次 itemId。两条路必须落到同一个字符串，否则翻译工作台
    // （.subtitle-translate/<jobId>/）与 glossary key 会按不同身份存取，
    // 表现为"重跑时认不出上次的半成品"+"术语表继承断掉"。
    const db = openDb(':memory:')
    seedNew(db)
    const [c] = listNewTranslateCandidates(db, 1)
    const identity = locateTranslateIdentity(db, c.videoPath)!
    expect(identity.itemId).toBe(c.itemId)
    db.close()
  })

  it('🔴 未识别行（work_id IS NULL）→ null（不许拿占位 work_id 硬造 itemId）', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id, sub_status, updated_at)
                VALUES ('/media/orphan.mkv','/media','orphan.mkv',100,0,NULL,'handoff_translate',0)`).run()
    expect(locateTranslateIdentity(db, '/media/orphan.mkv')).toBeNull()
    db.close()
  })

  it('🔴 电影：media_type=movie 从 works 取（不再查旧 movies 表）', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at)
                VALUES ('tmdb:7', 'Some Film', 'movie', 'en', 0, 0)`).run()
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id, sub_status, updated_at)
                VALUES ('/media/movies/f.mkv','/media/movies','f.mkv',100,0,'tmdb:7','handoff_translate',0)`).run()
    const got = locateTranslateIdentity(db, '/media/movies/f.mkv')
    expect(got).toMatchObject({ title: 'Some Film', originLang: 'en', tmdbId: '7', mediaType: 'movie' })
    expect(got!.itemId).toBe(translateItemId('tmdb:7', '/media/movies/f.mkv'))
    db.close()
  })

  it('🔴 旧表有行、files/works 无行 → 仍是 null（不许 UNION 旧表兜底 / 照 4-2 对 fetchSourceSub 的口径）', () => {
    // 兜底看似"更稳"，实则让新架构的断裂永久隐形：只要旧表还有存量行，测试与生产都会
    // 表现得像接通了，而真实数据在 files/works 里的那批文件依然拿不到身份。
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO series (id, name, origin_lang) VALUES ('tmdb:9', 'Legacy', 'ja')`).run()
    db.prepare(`INSERT INTO episodes (id, series_id, season, episode, path, sub_status, updated_at)
                VALUES ('tmdb:9/s1e1', 'tmdb:9', 1, 1, '/media/tv/legacy/e01.mkv', 'unavailable', 0)`).run()
    expect(locateTranslateIdentity(db, '/media/tv/legacy/e01.mkv')).toBeNull()
    db.close()
  })
})
