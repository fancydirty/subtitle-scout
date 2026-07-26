import { describe, it, expect } from 'vitest'
import { FindSubtitleBatchReportSchema } from './findSubtitleWorker.schemas.js'

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

  // 路 A（2026-07-26 识别架构）：identity_correction 字段——agent Step 0 核验发现库身份
  // 错了时的纠错报告通道。单值不是桶（整个 task 共享一个身份），nullableTolerant 折叠
  // 缺席/None/null 为 null（输出统一 null 不是 undefined，下游不用区分两种"没有"）。
  describe('identity_correction（路 A 识别纠错报告）', () => {
    it('接受合法纠错报告（tmdbId/isTv/reason）', () => {
      const r = FindSubtitleBatchReportSchema.parse({
        installed: [],
        no_safe_match: [{ itemId: 'tmdb:1/s1e1', reason: 'identity mismatch' }],
        retry_later: [],
        identity_correction: { tmdbId: '999', isTv: true, reason: 'season table fits' },
      })
      expect(r.identity_correction).toEqual({ tmdbId: '999', isTv: true, reason: 'season table fits' })
    })

    it('键缺席折叠为 null（核验通过的绝大多数 run）', () => {
      const r = FindSubtitleBatchReportSchema.parse({
        installed: [],
        no_safe_match: [],
        retry_later: [],
      })
      expect(r.identity_correction).toBeNull()
    })

    it('真模型哨兵容错："None"/"" 折叠为 null', () => {
      for (const sentinel of ['None', 'null', '']) {
        const r = FindSubtitleBatchReportSchema.parse({
          installed: [],
          no_safe_match: [],
          retry_later: [],
          identity_correction: sentinel,
        } as unknown)
        expect(r.identity_correction).toBeNull()
      }
    })

    // 2026-07-26 identityEval 实测暴露：mimo-v2.5 对 object 字段会把整个对象序列化成
    // JSON 字符串发上来（四个 case 全这么发），schema 不容错则 finalize 验证失败、整个
    // 纠错报告丢失——这是 plumbing 不是模型问题，与 coercibleInt 容错 "10"→10 同一类。
    it('真模型编码容错：JSON 字符串编码的对象 parse 回对象', () => {
      const r = FindSubtitleBatchReportSchema.parse({
        installed: [],
        no_safe_match: [{ itemId: 'x', reason: 'r' }],
        retry_later: [],
        identity_correction: '{"tmdbId": "276161", "isTv": true, "reason": "season table fits"}',
      } as unknown)
      expect(r.identity_correction).toEqual({ tmdbId: '276161', isTv: true, reason: 'season table fits' })
    })

    it('非法 JSON 字符串原样拒绝（容错只针对编码层，不吞内容层错误）', () => {
      expect(() =>
        FindSubtitleBatchReportSchema.parse({
          installed: [],
          no_safe_match: [],
          retry_later: [],
          identity_correction: '{not json',
        } as unknown),
      ).toThrow()
    })

    it('缺字段（reason 空/tmdbId 空）硬拒——纠错报告不许空判词', () => {
      expect(() =>
        FindSubtitleBatchReportSchema.parse({
          installed: [],
          no_safe_match: [],
          retry_later: [],
          identity_correction: { tmdbId: '999', isTv: true, reason: '' },
        }),
      ).toThrow()
      expect(() =>
        FindSubtitleBatchReportSchema.parse({
          installed: [],
          no_safe_match: [],
          retry_later: [],
          identity_correction: { tmdbId: '', isTv: false, reason: 'r' },
        }),
      ).toThrow()
    })
  })
})
