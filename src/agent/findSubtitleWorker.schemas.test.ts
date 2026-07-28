import { describe, it, expect } from 'vitest'
import { FindSubtitleBatchReportSchema } from './findSubtitleWorker.schemas.js'
import type { FindSubtitleTask } from './findSubtitleWorker.schemas.js'

describe('FindSubtitleBatchReportSchema', () => {
  it('接受三桶批量报告', () => {
    const r = FindSubtitleBatchReportSchema.parse({
      installed: [
        {
          itemId: 'tmdb:1/s1e1',
          installedPath: '/m/a.zh-Hans.srt',
          installedLanguage: 'zh-Hans',
          candidateProvider: 'assrt',
          candidateProviderId: '1',
          reason: 'ok',
        },
      ],
      no_safe_match: [{ itemId: 'tmdb:1/s1e2', reason: 'no entry in any pack' }],
      retry_later: [],
    })
    expect(r.installed).toHaveLength(1)
  })

  it('真模型哨兵容错：缺桶/None/null 一律折叠为空数组', () => {
    const r = FindSubtitleBatchReportSchema.parse({ installed: 'None', no_safe_match: null } as unknown)
    expect(r.installed).toEqual([])
    expect(r.no_safe_match).toEqual([])
    expect(r.retry_later).toEqual([])
  })

  it('installed 项的 installedPath 必须非空（覆盖入账不许无路径）', () => {
    expect(() =>
      FindSubtitleBatchReportSchema.parse({
        installed: [{ itemId: 'x', installedPath: '', reason: 'r' }],
        no_safe_match: [],
        retry_later: [],
      }),
    ).toThrow()
  })

  it('installed 项的可空字段（installedLanguage/candidateProvider/candidateProviderId）容许省略/哨兵', () => {
    const r = FindSubtitleBatchReportSchema.parse({
      installed: [
        {
          itemId: 'tmdb:1/s1e3',
          installedPath: '/m/c.srt',
          installedLanguage: 'None',
          candidateProvider: undefined,
          candidateProviderId: 'null',
          reason: 'ok',
        },
      ],
      no_safe_match: [],
      retry_later: [],
    })
    expect(r.installed[0].installedLanguage).toBeNull()
    expect(r.installed[0].candidateProvider).toBeNull()
    expect(r.installed[0].candidateProviderId).toBeNull()
  })

  it('no_safe_match / retry_later 项要求 reason 非空；itemId 空串哨兵折叠为 null（第三例容错后不再炸）', () => {
    // 第三例（job 34）之前 itemId:'' 会炸整份报告——现在 '' 是 nullish 哨兵，折叠为 null
    // 进入 runner 层丢弃告警轨（归属反解/丢弃），不再让一个空 id 炸掉整批收割。
    const r = FindSubtitleBatchReportSchema.safeParse({
      installed: [],
      no_safe_match: [{ itemId: '', reason: 'x' }],
      retry_later: [],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.no_safe_match[0].itemId).toBeNull()
    expect(() =>
      FindSubtitleBatchReportSchema.parse({
        installed: [],
        no_safe_match: [],
        retry_later: [{ itemId: 'x', reason: '' }],
      }),
    ).toThrow()
  })

})

describe('FindSubtitleBatchReportSchema with new identity', () => {
  it('accepts identified outcome with required fields', ({ expect }) => {
    const report = {
      targets: [],
      installed: [],
      no_safe_match: [],
      retry_later: [],
      identity: {
        outcome: 'identified',
        tmdbId: '12345',
        isTv: true,
        season: 1,
        episode: 5,
        nameEvidence: 'Title matches "Show Name"',
        structureEvidence: 'Season 1 exists in TMDB season table',
      },
    }

    const result = FindSubtitleBatchReportSchema.safeParse(report)
    expect(result.success).toBe(true)
  })

  it('accepts unidentified outcome', ({ expect }) => {
    const report = {
      targets: [],
      installed: [],
      no_safe_match: [],
      retry_later: [],
      identity: {
        outcome: 'unidentified',
        reason: 'No TMDB hits for cleaned title',
      },
    }

    const result = FindSubtitleBatchReportSchema.safeParse(report)
    expect(result.success).toBe(true)
  })

  // job 34 第二次失败后语义反转：identity 内层校验失败不再拒绝整份报告（旧断言是
  // success:false），改为折叠 null——advisory 元数据不许炸掉收割账目。见下方专门 describe。
  it('identified 但 TV 缺 season/episode → identity 折叠 null（不再拒绝整份报告）', ({ expect }) => {
    const report = {
      targets: [],
      installed: [],
      no_safe_match: [],
      retry_later: [],
      identity: {
        outcome: 'identified',
        tmdbId: '12345',
        isTv: true,
        season: null,
        episode: null,
        nameEvidence: 'Title matches',
        structureEvidence: 'Season table OK',
      },
    }

    const result = FindSubtitleBatchReportSchema.safeParse(report)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.identity).toBeNull()
  })

  it('identified 但 tmdbId 非数字 → identity 折叠 null（不再拒绝整份报告）', ({ expect }) => {
    const report = {
      targets: [],
      installed: [],
      no_safe_match: [],
      retry_later: [],
      identity: {
        outcome: 'identified',
        tmdbId: 'abc123',
        isTv: true,
        season: 1,
        episode: 5,
        nameEvidence: 'Title matches',
        structureEvidence: 'Season table OK',
      },
    }

    const result = FindSubtitleBatchReportSchema.safeParse(report)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.identity).toBeNull()
  })
})

describe('identity 内层校验失败折叠为 null（job 34 第二次实测：advisory 元数据不许炸掉收割）', () => {
  const base = { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
  it('🔴 identified 但 TV 缺 season（12 作品混合批的语义错配）→ identity 折叠 null，报告存活', () => {
    const r = FindSubtitleBatchReportSchema.safeParse({ ...base, identity: { outcome: 'identified', tmdbId: '241002', isTv: true, season: null, episode: null, nameEvidence: 'x', structureEvidence: 'y' } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.identity).toBeNull()
  })
  it('未知 outcome 字面量 → 折叠 null，报告存活', () => {
    const r = FindSubtitleBatchReportSchema.safeParse({ ...base, identity: { outcome: 'partially-identified', reason: 'x' } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.identity).toBeNull()
  })
  it('合法 identified 原样通过（回归锁）', () => {
    const r = FindSubtitleBatchReportSchema.safeParse({ ...base, identity: {
      outcome: 'identified', tmdbId: '1038392', isTv: false, season: null, episode: null,
      nameEvidence: 'name matches', structureEvidence: 'runtime fits',
    } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.identity).toMatchObject({ outcome: 'identified', tmdbId: '1038392', isTv: false })
  })
  it('合法 unidentified + kind 原样通过（回归锁）', () => {
    const r = FindSubtitleBatchReportSchema.safeParse({ ...base, identity: {
      outcome: 'unidentified', reason: 'TMDB 无此条目', kind: 'insufficient-evidence',
    } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.identity).toMatchObject({ outcome: 'unidentified', kind: 'insufficient-evidence' })
  })
  it('JSON 字符串编码的合法 identity 仍被折叠回对象（既有行为回归锁）', () => {
    const r = FindSubtitleBatchReportSchema.safeParse({ ...base,
      identity: '{"outcome": "identified", "tmdbId": "1038392", "isTv": false, "season": null, "episode": null, "nameEvidence": "name matches", "structureEvidence": "runtime fits"}',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.identity).toMatchObject({ outcome: 'identified', tmdbId: '1038392' })
  })
  it('哨兵/缺席仍折叠 null（既有行为回归锁）', () => {
    for (const identity of ['None', 'null', '', undefined, null]) {
      const r = FindSubtitleBatchReportSchema.safeParse({ ...base, identity })
      expect(r.success).toBe(true)
      if (r.success) expect(r.data.identity).toBeNull()
    }
  })
})

describe('identity.unidentified 的 kind 分类容错（六轮血案纪律）', () => {
  const base = { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
  const parse = (identity: unknown) =>
    FindSubtitleBatchReportSchema.safeParse({ ...base, identity })

  it('标准值：insufficient-evidence', () => {
    const r = parse({ outcome: 'unidentified', reason: '路径无任何片名信息', kind: 'insufficient-evidence' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('insufficient-evidence')
  })

  it('标准值：identification-failed', () => {
    const r = parse({ outcome: 'unidentified', reason: 'TMDB 无此条目', kind: 'identification-failed' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('identification-failed')
  })

  it('下划线变体折叠为连字符', () => {
    const r = parse({ outcome: 'unidentified', reason: 'x', kind: 'insufficient_evidence' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('insufficient-evidence')
  })

  it('大写变体折叠', () => {
    const r = parse({ outcome: 'unidentified', reason: 'x', kind: 'INSUFFICIENT-EVIDENCE' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('insufficient-evidence')
  })

  it('🔴 省略 kind → 安全默认 identification-failed（宁可多跑一轮，不可永久钉死文件）', () => {
    const r = parse({ outcome: 'unidentified', reason: 'x' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('identification-failed')
  })

  it('🔴 无法识别的值 → 安全默认 identification-failed，不炸报告', () => {
    const r = parse({ outcome: 'unidentified', reason: 'x', kind: 'i-have-no-idea' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('identification-failed')
  })
})

describe('installed/unresolved 的 itemId 容错（六轮血案第三例：混合批 finalize null itemId）', () => {
  const base = { no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null }
  it('🔴 installed 项 itemId:null 不炸整个报告（job34 实测：152 秒收割成果全灭）', () => {
    const r = FindSubtitleBatchReportSchema.safeParse({ ...base, installed: [
      { itemId: null, installedPath: '/x/y.zh-Hans.srt', installedLanguage: 'zh-Hans', candidateProvider: 'assrt', candidateProviderId: '1', reason: 'ok' },
    ]})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.installed[0].itemId).toBeNull()
  })
  it('installed 项 itemId 省略 → null', () => {
    const r = FindSubtitleBatchReportSchema.safeParse({ ...base, installed: [
      { installedPath: '/x/y.zh-Hans.srt', installedLanguage: 'zh-Hans', candidateProvider: 'assrt', candidateProviderId: '1', reason: 'ok' },
    ]})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.installed[0].itemId).toBeNull()
  })
  it('no_safe_match 项 itemId:null 同样不炸', () => {
    const r = FindSubtitleBatchReportSchema.safeParse({ ...base, installed: [], no_safe_match: [{ itemId: null, reason: 'x' }] })
    expect(r.success).toBe(true)
  })
})

describe('FindSubtitleTargetFact with raw evidence', () => {
  it('accepts targets with raw evidence fields', ({ expect }) => {
    const task: FindSubtitleTask = {
      jobId: 'job-1',
      mediaRoot: '/media',
      title: 'Test',
      originalTitle: null,
      year: null,
      alternativeTitles: [],
      overview: null,
      runtimeMinutes: null,
      providerIds: {},
      targetLanguage: 'zh',
      hardsubMode: 'off' as const,
      localCandidates: [],
      targets: [
        {
          itemId: null, // Unidentified
          videoPath: '/media/tv/Show.S01E01.mkv',
          videoFilename: 'Show.S01E01.mkv',
          season: 1,
          episode: 1,
          absoluteEpisode: null,
          imdbId: null,
          embeddedTmdbId: null,
          runtimeMinutes: 40,
          // Raw evidence for agent identification
          dirName: 'tv',
          durationSec: 2400,
          embeddedLangs: ['eng', 'jpn'],
        },
      ],
    }

    // TypeScript should accept this
    expect(task.targets[0].dirName).toBe('tv')
    expect(task.targets[0].durationSec).toBe(2400)
    expect(task.targets[0].embeddedLangs).toEqual(['eng', 'jpn'])
  })

describe('identity 字段的真模型编码容错（identityEval 第一轮实测）', () => {
  it('JSON 字符串编码的 identity 对象 parse 回对象', () => {
    const r = FindSubtitleBatchReportSchema.parse({
      installed: [],
      no_safe_match: [],
      retry_later: [],
      identity: '{"outcome": "identified", "tmdbId": "1038392", "isTv": false, "season": null, "episode": null, "nameEvidence": "name matches", "structureEvidence": "runtime fits"}',
    } as unknown)
    expect(r.identity).toMatchObject({
      outcome: 'identified',
      tmdbId: '1038392',
      isTv: false,
    })
  })
})
})
