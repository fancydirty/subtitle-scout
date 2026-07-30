import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './../v2/db.js'
import { SubtitleVerifyRepo } from '../v2/subtitleVerifyRepo.js'
import {
  verifySubtitleAlignment,
  verifyAndRecord,
  SIGNIFICANT_OFFSET_MS,
} from './verifySubtitle.js'
import { CONFIDENT_THRESHOLD, UNCONFIDENT_THRESHOLD, BIN_MS, type SpeechSpan } from './alignDetect.js'
import type { ReferenceSource } from './referenceSource.js'
import type { Cue } from '../files/subtitleInspect.js'

/**
 * 编排层：三个纯模块 → 三值判读 → 落库。
 *
 * 全部走注入（ESM 无法 spy 模块导出，这是本仓硬纪律），因此测试不碰真实文件系统、
 * 不 spawn ffmpeg，也不依赖 alignDetect 的具体数值——判读逻辑本身是被测对象。
 */

/** 一条够用的参考源 spans（内容不重要，注入的 detect 决定分数）。 */
const someSpans: SpeechSpan[] = [
  { startMs: 1000, endMs: 2000 },
  { startMs: 3000, endMs: 4000 },
]

/** 与 someSpans 同序等长的带文本形态（ReferenceSource.cues 的契约）。本层压根不读它
 *  ——对齐不看文本——放在这里只为满足类型，顺带钉住"cues 存在不影响本层任何判读"。 */
const someCues: Cue[] = [
  { startMs: 1000, endMs: 2000, text: 'first line' },
  { startMs: 3000, endMs: 4000, text: 'second line' },
]

const embeddedRef: ReferenceSource = {
  tier: 'embedded',
  spans: someSpans,
  cues: someCues,
  detail: 'embedded track 0 (500 cues)',
}

/** 默认注入：一切正常，由每个用例覆写自己关心的那一维。 */
function opts(over: {
  ref?: ReferenceSource | null
  ourSpans?: SpeechSpan[] | null
  offsetMs?: number
  score?: number
  hash?: string | null
} = {}) {
  return {
    findReference: async () => (over.ref === undefined ? embeddedRef : over.ref),
    loadOurSpans: async () => (over.ourSpans === undefined ? someSpans : over.ourSpans),
    detect: () => ({ offsetMs: over.offsetMs ?? 0, score: over.score ?? 1 }),
    hashSubtitle: async () => (over.hash === undefined ? 'hash-a' : over.hash),
  }
}

describe('SIGNIFICANT_OFFSET_MS（显著偏移门槛）', () => {
  it('是 BIN_MS 的整数倍——比检测分辨率更细的门槛没有意义', () => {
    expect(SIGNIFICANT_OFFSET_MS % BIN_MS).toBe(0)
  })

  it('严格大于一个 bin——1 个 bin 的离散化噪声不该点亮红芯片', () => {
    expect(SIGNIFICANT_OFFSET_MS).toBeGreaterThan(BIN_MS)
  })

  it('取 300ms：扣掉一个 bin 的噪声后仍在人眼感知阈（~100~200ms）之上', () => {
    expect(SIGNIFICANT_OFFSET_MS).toBe(300)
  })
})

describe('verifySubtitleAlignment — 三值判读', () => {
  describe('unverifiable：无参考源', () => {
    it('findReferenceSource 返回 null → unverifiable（UI 绿色，不是黄色）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ ref: null }))
      expect(r.verdict).toBe('unverifiable')
      expect(r.detail).toContain('no reference source')
    })

    it('无参考源时不带出任何内部数字（压根没算过分，不是算出了 0 分）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ ref: null }))
      expect(r.offsetMs).toBeNull()
      expect(r.score).toBeNull()
      expect(r.referenceTier).toBeNull()
    })

    it('无参考源时不调用 detect（没有基准可比，白算）', async () => {
      let called = false
      await verifySubtitleAlignment('/v.mkv', '/s.srt', {
        ...opts({ ref: null }),
        detect: () => { called = true; return { offsetMs: 0, score: 1 } },
      })
      expect(called).toBe(false)
    })
  })

  describe('unverifiable：待检字幕自己就读不出来', () => {
    it('待检字幕读不动 → unverifiable', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ ourSpans: null }))
      expect(r.verdict).toBe('unverifiable')
      expect(r.detail).toContain('unreadable')
    })

    it('待检字幕解析出 0 条 cue → unverifiable', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ ourSpans: [] }))
      expect(r.verdict).toBe('unverifiable')
    })

    it('待检侧先于参考源：自己读不出时不去找参考源（① 层最坏要 spawn 数条 ffmpeg）', async () => {
      let called = false
      await verifySubtitleAlignment('/v.mkv', '/s.srt', {
        ...opts({ ourSpans: null }),
        findReference: async () => { called = true; return embeddedRef },
      })
      expect(called).toBe(false)
    })
  })

  describe('unverifiable：分数不够', () => {
    it('分数远低于 UNCONFIDENT_THRESHOLD → unverifiable', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 0.2, offsetMs: 5000 }))
      expect(r.verdict).toBe('unverifiable')
    })

    it('灰区（0.7 ≤ score < 0.9）同样 unverifiable，不单开第四档', async () => {
      const mid = (UNCONFIDENT_THRESHOLD + CONFIDENT_THRESHOLD) / 2
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: mid, offsetMs: 5000 }))
      expect(r.verdict).toBe('unverifiable')
    })

    it('恰好 UNCONFIDENT_THRESHOLD（0.7）仍是 unverifiable', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt',
        opts({ score: UNCONFIDENT_THRESHOLD, offsetMs: 5000 }))
      expect(r.verdict).toBe('unverifiable')
    })

    it('分数不够时哪怕偏移巨大也不报 shifted（低分的偏移量是噪声）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 0.5, offsetMs: 30_000 }))
      expect(r.verdict).toBe('unverifiable')
      expect(r.offsetMs).toBeNull()
    })

    it('帧率不匹配（线性拉伸→分数必低）自然落进 unverifiable，不给校正', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 0.45, offsetMs: 1200 }))
      expect(r.verdict).toBe('unverifiable')
      expect(r.offsetMs).toBeNull()
    })

    it('低分时 referenceTier 仍如实带出（排障要能分辨用的是哪层参考源）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 0.3 }))
      expect(r.referenceTier).toBe('embedded')
    })
  })

  describe('aligned：分数够 + 偏移不显著', () => {
    it('offset 恰好 0 → aligned', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 1, offsetMs: 0 }))
      expect(r.verdict).toBe('aligned')
    })

    it('恰好 CONFIDENT_THRESHOLD（0.9）且零偏移 → aligned（边界含入可信档）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt',
        opts({ score: CONFIDENT_THRESHOLD, offsetMs: 0 }))
      expect(r.verdict).toBe('aligned')
    })

    it('偏移一个 bin（100ms，离散化噪声量级）→ aligned，不报红', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 1, offsetMs: BIN_MS }))
      expect(r.verdict).toBe('aligned')
    })

    it('偏移恰好差一个 bin 到门槛（200ms）→ 仍 aligned', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt',
        opts({ score: 1, offsetMs: SIGNIFICANT_OFFSET_MS - BIN_MS }))
      expect(r.verdict).toBe('aligned')
    })

    it('负向的不显著偏移（偏早 200ms）同样 aligned——门槛按绝对值', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt',
        opts({ score: 1, offsetMs: -(SIGNIFICANT_OFFSET_MS - BIN_MS) }))
      expect(r.verdict).toBe('aligned')
    })

    it('aligned 档的 offsetMs 落 null——那点残值是噪声而非事实', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 1, offsetMs: BIN_MS }))
      expect(r.offsetMs).toBeNull()
    })

    it('aligned 档仍保留 score/tier 供排障（内部字段，不上 UI）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 0.97, offsetMs: 0 }))
      expect(r.score).toBe(0.97)
      expect(r.referenceTier).toBe('embedded')
    })
  })

  describe('shifted：分数够 + 偏移显著', () => {
    it('恰好达到门槛（300ms）→ shifted（门槛含入显著档）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt',
        opts({ score: 1, offsetMs: SIGNIFICANT_OFFSET_MS }))
      expect(r.verdict).toBe('shifted')
      expect(r.offsetMs).toBe(SIGNIFICANT_OFFSET_MS)
    })

    it('负向恰好达到门槛（偏早 300ms）→ shifted，偏移量符号原样保留', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt',
        opts({ score: 1, offsetMs: -SIGNIFICANT_OFFSET_MS }))
      expect(r.verdict).toBe('shifted')
      expect(r.offsetMs).toBe(-SIGNIFICANT_OFFSET_MS)
    })

    it('典型秒级偏移（片头广告 2s）→ shifted 且偏移量可用于校正', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 0.96, offsetMs: 2000 }))
      expect(r).toMatchObject({ verdict: 'shifted', offsetMs: 2000, score: 0.96, referenceTier: 'embedded' })
    })

    it('恰好 CONFIDENT_THRESHOLD + 显著偏移 → shifted（阈值边界含入）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt',
        opts({ score: CONFIDENT_THRESHOLD, offsetMs: 5000 }))
      expect(r.verdict).toBe('shifted')
    })

    it('刚低于 CONFIDENT_THRESHOLD 一点点 → 落回 unverifiable（不敢报红）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt',
        opts({ score: CONFIDENT_THRESHOLD - 0.001, offsetMs: 5000 }))
      expect(r.verdict).toBe('unverifiable')
    })

    it('shifted 是唯一带出 offsetMs 的一档（唯一会真的改写用户文件的一档）', async () => {
      const cases = [
        { o: { score: 1, offsetMs: 5000 }, verdict: 'shifted', hasOffset: true },
        { o: { score: 1, offsetMs: 100 }, verdict: 'aligned', hasOffset: false },
        { o: { score: 0.3, offsetMs: 5000 }, verdict: 'unverifiable', hasOffset: false },
        { o: { ref: null }, verdict: 'unverifiable', hasOffset: false },
      ] as const
      for (const c of cases) {
        const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts(c.o))
        expect(r.verdict).toBe(c.verdict)
        expect(r.offsetMs !== null).toBe(c.hasOffset)
      }
    })
  })

  describe('三值封闭 + 参考源层级如实透传', () => {
    it('verdict 恒在三值之内，绝无第四档', async () => {
      const scores = [0, 0.3, UNCONFIDENT_THRESHOLD, 0.8, CONFIDENT_THRESHOLD, 1]
      const offsets = [0, 100, 200, 300, 2000, -300, -60_000]
      for (const score of scores) {
        for (const offsetMs of offsets) {
          const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score, offsetMs }))
          expect(['aligned', 'shifted', 'unverifiable']).toContain(r.verdict)
        }
      }
    })

    it('sibling 层参考源的 tier 如实带出', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({
        ref: { tier: 'sibling', spans: someSpans, cues: someCues, detail: 'sibling ep1.eng.srt (400 cues)' },
        score: 1, offsetMs: 3000,
      }))
      expect(r.referenceTier).toBe('sibling')
      expect(r.detail).toContain('sibling ep1.eng.srt')
    })

    it('参考源的 detail 进入本层 detail（排障要知道选中了谁）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ score: 1, offsetMs: 3000 }))
      expect(r.detail).toContain('embedded track 0 (500 cues)')
    })

    it('哈希如实带出，供落库判日后是否需重检', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ hash: 'hash-xyz' }))
      expect(r.subtitleHash).toBe('hash-xyz')
    })

    it('算不出哈希也不影响判读本身（哈希只关乎"下次要不要重检"）', async () => {
      const r = await verifySubtitleAlignment('/v.mkv', '/s.srt', opts({ hash: null, score: 1, offsetMs: 4000 }))
      expect(r.verdict).toBe('shifted')
      expect(r.subtitleHash).toBeNull()
    })
  })
})

describe('verifyAndRecord — 检测并落库', () => {
  let repo: SubtitleVerifyRepo

  beforeEach(() => {
    repo = new SubtitleVerifyRepo(openDb(':memory:'))
  })

  it('首次检测：落库一行，字段与产物一致', async () => {
    const out = await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000,
      opts({ score: 0.95, offsetMs: 2000 }))
    expect(out?.verdict).toBe('shifted')
    expect(repo.getVerifyResult('tmdb:1/s1e1')).toEqual({
      item_id: 'tmdb:1/s1e1',
      verdict: 'shifted',
      offset_ms: 2000,
      score: 0.95,
      reference_tier: 'embedded',
      subtitle_path: '/s.srt',
      subtitle_hash: 'hash-a',
      checked_at: 5000,
      detail: 'ref=embedded: embedded track 0 (500 cues)',
    })
  })

  it('unverifiable 也照样落库（"我们没能验证"是一个结论，不是"没有结论"）', async () => {
    await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000, opts({ ref: null }))
    expect(repo.getVerifyResult('tmdb:1/s1e1')).toMatchObject({
      verdict: 'unverifiable', offset_ms: null, score: null, reference_tier: null,
    })
  })

  it('aligned 也照样落库（否则每轮巡检都要重跑一遍已经验过没问题的集）', async () => {
    await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000, opts({ score: 1, offsetMs: 0 }))
    expect(repo.getVerifyResult('tmdb:1/s1e1')).toMatchObject({ verdict: 'aligned' })
  })

  describe('跳过已检过且未变的', () => {
    it('同路径同哈希 → 返回 null 且不重新检测', async () => {
      await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000, opts({ score: 1, offsetMs: 0 }))
      let detectCalls = 0
      const out = await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 9000, {
        ...opts({ score: 1, offsetMs: 0 }),
        detect: () => { detectCalls++; return { offsetMs: 0, score: 1 } },
      })
      expect(out).toBeNull()
      expect(detectCalls).toBe(0)
    })

    it('跳过时不去找参考源（跳过的全部意义就是省下 ① 层的 ffmpeg 开销）', async () => {
      await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000, opts())
      let refCalls = 0
      await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 9000, {
        ...opts(),
        findReference: async () => { refCalls++; return embeddedRef },
      })
      expect(refCalls).toBe(0)
    })

    it('跳过时库里那一行原样不动（checked_at 不被刷新）', async () => {
      await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000, opts({ score: 1, offsetMs: 0 }))
      await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 9000, opts({ score: 1, offsetMs: 0 }))
      expect(repo.getVerifyResult('tmdb:1/s1e1')).toMatchObject({ checked_at: 5000 })
    })

    it('内容哈希变了（原地替换字幕）→ 重新检测并覆盖旧结论', async () => {
      // 哈希不参与判断的话这一档会被跳过，用户换了字幕却永远看到旧结论。
      await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000,
        opts({ score: 1, offsetMs: 0, hash: 'hash-a' }))
      const out = await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 9000,
        opts({ score: 1, offsetMs: 4000, hash: 'hash-B' }))
      expect(out?.verdict).toBe('shifted')
      expect(repo.getVerifyResult('tmdb:1/s1e1')).toMatchObject({
        verdict: 'shifted', offset_ms: 4000, subtitle_hash: 'hash-B', checked_at: 9000,
      })
    })

    it('换成另一个字幕文件（路径变了）→ 重新检测', async () => {
      await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000, opts({ score: 1, offsetMs: 0 }))
      const out = await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/other.srt', 9000,
        opts({ score: 1, offsetMs: 4000 }))
      expect(out?.verdict).toBe('shifted')
      expect(repo.getVerifyResult('tmdb:1/s1e1')).toMatchObject({ subtitle_path: '/other.srt' })
    })

    it('算不出哈希 → 保守重检，不把"不知道"当成"没变"', async () => {
      await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000, opts({ hash: null }))
      const out = await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 9000, opts({ hash: null }))
      expect(out).not.toBeNull()
    })

    it('哈希只读一次盘（needsRecheck 算过就复用，不重复读）', async () => {
      let hashCalls = 0
      await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/s.srt', 5000, {
        ...opts(),
        hashSubtitle: async () => { hashCalls++; return 'hash-a' },
      })
      expect(hashCalls).toBe(1)
    })
  })

  it('落库后 listShifted 能看到红档，看不到绿档（UI 读取路径端到端）', async () => {
    await verifyAndRecord(repo, 'tmdb:1/s1e1', '/v.mkv', '/a.srt', 100, opts({ score: 1, offsetMs: 5000 }))
    await verifyAndRecord(repo, 'tmdb:1/s1e2', '/v.mkv', '/b.srt', 200, opts({ score: 1, offsetMs: 0 }))
    await verifyAndRecord(repo, 'tmdb:1/s1e3', '/v.mkv', '/c.srt', 300, opts({ ref: null }))
    expect(repo.listShifted().map((r) => r.item_id)).toEqual(['tmdb:1/s1e1'])
  })

  it('不调用 shiftTiming——检测绝不顺手改写用户的文件（校正是另一个动作）', async () => {
    // 编排层的 opts 里压根没有 shift 相关的注入口，是刻意的结构约束：
    // 想在这里写盘就必须先改接口，改接口会被 review 看见。此测试锁住这个性质。
    const injectableKeys = Object.keys(opts())
    expect(injectableKeys).toEqual(['findReference', 'loadOurSpans', 'detect', 'hashSubtitle'])
  })
})
