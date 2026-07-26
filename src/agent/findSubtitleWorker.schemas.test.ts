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

  it('no_safe_match / retry_later 项要求 itemId 与 reason 非空', () => {
    expect(() =>
      FindSubtitleBatchReportSchema.parse({
        installed: [],
        no_safe_match: [{ itemId: '', reason: 'x' }],
        retry_later: [],
      }),
    ).toThrow()
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

  it('rejects identified without required season/episode for TV', ({ expect }) => {
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
    expect(result.success).toBe(false)
  })

  it('rejects identified with non-numeric tmdbId', ({ expect }) => {
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
    expect(result.success).toBe(false)
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
})
