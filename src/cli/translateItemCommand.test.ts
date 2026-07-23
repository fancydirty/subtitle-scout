import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { translateTimeoutMs, sourceLangDisplayName, sidecarPathFor, readSeriesTargetSubs, locateTranslateIdentity, makeDaemonTranslateRunItem } from './translateItemCommand.js'
import { openDb } from '../v2/db.js'

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

describe('locateTranslateIdentity — db 身份定位', () => {
  it('episode:JOIN series 取 itemId/title/origin_lang/tmdbId/mediaType=tv', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO series (id, name, origin_lang) VALUES ('tmdb:261868', 'Witch Watch', 'ja')`).run()
    db.prepare(`INSERT INTO episodes (id, series_id, season, episode, path, sub_status, updated_at)
                VALUES ('tmdb:261868/s1e2', 'tmdb:261868', 1, 2, '/media/tv/ww/e02.mkv', 'unavailable', 0)`).run()
    expect(locateTranslateIdentity(db, '/media/tv/ww/e02.mkv')).toEqual({
      itemId: 'tmdb:261868/s1e2', title: 'Witch Watch', originLang: 'ja', tmdbId: '261868', mediaType: 'tv',
    })
    db.close()
  })

  it('movie:直取;未命中 → null', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO movies (id, name, path, sub_status, updated_at, origin_lang)
                VALUES ('tmdb:7', 'Some Film', '/media/movies/f.mkv', 'unavailable', 0, 'en')`).run()
    expect(locateTranslateIdentity(db, '/media/movies/f.mkv')).toEqual({
      itemId: 'tmdb:7', title: 'Some Film', originLang: 'en', tmdbId: '7', mediaType: 'movie',
    })
    expect(locateTranslateIdentity(db, '/nowhere.mkv')).toBeNull()
    db.close()
  })
})

describe('makeDaemonTranslateRunItem — P3 daemon runItem', () => {
  function seedDb(): ReturnType<typeof openDb> {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO series (id, name, origin_lang) VALUES ('tmdb:261868', 'Witch Watch', 'ja')`).run()
    db.prepare(`INSERT INTO episodes (id, series_id, season, episode, path, sub_status, updated_at)
                VALUES ('tmdb:261868/s1e2', 'tmdb:261868', 1, 2, '/media/tv/ww/e02.mkv', 'unavailable', 0)`).run()
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
          return { status: 'installed', reason: null, sourceRef: 'fallback:embedded:s:0', sidecarPath: '/media/tv/ww/e02.zh-Hans.srt', llmCalls: 9 } as never
        }
      })() as never,
    })
    const r = await runItem('/media/tv/ww/e02.mkv')
    expect(seenTask).toMatchObject({
      itemId: 'tmdb:261868/s1e2', originLang: 'ja', title: 'Witch Watch',
      mediaRoot: '/media/tv/ww', stagingRoot: '/media/tv',
    })
    expect(r).toMatchObject({
      status: 'installed', sourceRef: 'fallback:embedded:s:0',
      sidecarPath: '/media/tv/ww/e02.zh-Hans.srt', llmCalls: 9,
    })
    expect(r.reason).toBeUndefined() // null → undefined 归一化
    db.close()
  })
})
