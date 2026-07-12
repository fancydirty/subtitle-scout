import { describe, it, expect } from 'vitest'
import { runGate } from './gate.js'
import type { SubtitleCandidate, MediaIdentity, RankDecision } from './schemas.js'

const identity: MediaIdentity = {
  canonical_title: 'The Matrix', original_title: null, year: 1999, type: 'movie',
  season: null, episode: null, edition: null, confidence: 0.95, evidence: [],
}
const candidates: SubtitleCandidate[] = [
  { provider: 'assrt', providerId: '673114', videoName: 'The.Matrix.1999', nativeName: null, language: 'zh', subtype: null, releaseSite: null, uploadDate: null, fileList: [{ index: 0, name: 'a.zh.ass' }] },
  { provider: 'assrt', providerId: '606770', videoName: 'Matrix Trilogy', nativeName: null, language: 'zh', subtype: null, releaseSite: null, uploadDate: null, fileList: [{ index: 0, name: 'animatrix.ass' }, { index: 1, name: 'matrix1.ass' }] },
]

const rankWith = (order: RankDecision['order']): RankDecision => ({ order, rejected: [], reasons: [] })

describe('runGate', () => {
  it('builds a one-item queue from a valid order', () => {
    const r = runGate(rankWith([{ candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'exact match' }]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.decision).toBe('proceed')
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].candidate.providerId).toBe('673114')
    expect(r.queue[0].fileIndex).toBe(0)
    expect(r.queue[0].identityMatch).toBe('confirmed')
  })

  it('keeps both confirmed and uncertain candidates in the queue, preserving order', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'exact match' },
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain', reason: 'no season/episode signal' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue.map(q => q.candidate.providerId)).toEqual(['673114', '606770'])
  })

  it('drops a mismatch entry defensively even if rank disobeys the prompt and includes it', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'mismatch', reason: 'wrong film' },
    ]), candidates, identity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.join(' ')).toMatch(/mismatch/i)
    expect(r.queue).toEqual([])
  })

  it('skips an unresolvable candidate_id but keeps trying the rest of the order (fail-soft per item)', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:999999', file_index: 0, identity_match: 'confirmed', reason: 'x' },
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'y' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].candidate.providerId).toBe('673114')
    expect(r.failures[0]).toMatch(/candidate_id/)
  })

  it('skips an out-of-range file_index for one item without failing the whole gate', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:673114', file_index: 5, identity_match: 'confirmed', reason: 'x' },
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'confirmed', reason: 'y' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].candidate.providerId).toBe('606770')
  })

  it('empty fileList tolerates file_index null or 0, rejects >0', () => {
    const noFiles: SubtitleCandidate = {
      provider: 'opensubtitles', providerId: '7174766', videoName: 'The.Matrix.1999',
      nativeName: null, language: 'zh-CN', subtype: null, releaseSite: null, uploadDate: null, fileList: [],
    }
    const pool = [...candidates, noFiles]
    const ok = runGate(rankWith([{ candidate_id: 'opensubtitles:7174766', file_index: null, identity_match: 'uncertain', reason: 'x' }]), pool, identity)
    expect(ok.ok).toBe(true)
    const bad = runGate(rankWith([{ candidate_id: 'opensubtitles:7174766', file_index: 2, identity_match: 'uncertain', reason: 'x' }]), pool, identity)
    expect(bad.ok).toBe(false)
    expect(bad.decision).toBe('no_safe_match')
  })

  it('empty order → no_safe_match with an explanatory failure', () => {
    const r = runGate(rankWith([]), candidates, identity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.length).toBeGreaterThan(0)
  })

  it('self-heals a bare providerId (model dropped the provider prefix)', () => {
    const r = runGate(rankWith([{ candidate_id: '673114', file_index: 0, identity_match: 'confirmed', reason: 'x' }]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue[0].candidate.providerId).toBe('673114')
  })

  it('a bare providerId colliding across providers is skipped as ambiguous', () => {
    const pool: SubtitleCandidate[] = [
      { provider: 'assrt', providerId: '123', videoName: 'ASSRT Video', nativeName: null, language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [] },
      { provider: 'opensubtitles', providerId: '123', videoName: 'OpenSubtitles Video', nativeName: null, language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [] },
    ]
    const r = runGate(rankWith([{ candidate_id: '123', file_index: null, identity_match: 'confirmed', reason: 'x' }]), pool, identity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.join(' ')).toMatch(/ambiguous/i)
  })

  it('dedups the queue by resolved candidate identity + fileIndex, keeping first occurrence (quota protection: no double-download/double-verify)', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'exact match' },
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'literal duplicate order row' },
      { candidate_id: '673114', file_index: 0, identity_match: 'confirmed', reason: 'bare id self-heals to the same candidate' },
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain', reason: 'second, distinct candidate' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue).toHaveLength(2)
    expect(r.queue.map(q => q.candidate.providerId)).toEqual(['673114', '606770'])
    // first-occurrence reason preserved, not overwritten by the later duplicate rows
    expect(r.queue[0].identityMatch).toBe('confirmed')
  })

  it('episode media without resolved season/episode fails closed regardless of order contents', () => {
    const epIdentity: MediaIdentity = { ...identity, type: 'episode', season: null, episode: 3 }
    const r = runGate(rankWith([{ candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'x' }]), candidates, epIdentity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.queue).toEqual([])
  })
})

/**
 * position-vs-i LLM 混淆兜底：MAX_FILELIST_ENTRIES 截断后，prompt 里的展示顺序（"第几条"）
 * 和条目自带的 i 值可能不再一一对应（截断丢了中间条目）。模型偶尔会把展示顺序误当 i 值报出
 * file_index——范围校验（63-68 行）拿不住这种"in-range 但错位"的越界，正常放行后下游按数组
 * 下标定位（pipeline.ts 的 fileList[fileIndex]），静默装错成相邻的另一集。这里用完整（未经
 * rank 精简/截断）fileList 反查目标集号，在 gate 层堵住。
 */
describe('runGate position-vs-i confusion backstop', () => {
  const epIdentity: MediaIdentity = {
    canonical_title: 'Show', original_title: null, year: 2020, type: 'episode',
    season: 1, episode: 5, edition: null, confidence: 0.9, evidence: [],
  }

  // index MUST equal array position (see core/schemas.ts SubtitleFileSchema / adapters/providers/assrt.ts
  // toCandidate) — this builder takes a sparse { position: name } map over a fixed-size array and fills
  // every unspecified position with a noise entry, so every fixture respects that invariant by construction.
  function packOfSize(size: number, named: Record<number, string>): SubtitleCandidate {
    const fileList = Array.from({ length: size }, (_, i) => ({ index: i, name: named[i] ?? `Show.S01.noise.${i}.jpg` }))
    return {
      provider: 'assrt', providerId: '900001', videoName: 'Show.S01', nativeName: null,
      language: '简', subtype: null, releaseSite: null, uploadDate: null, fileList,
    }
  }

  it('(a) auto-remaps a position-confused file_index to the sole filename match for the target episode', () => {
    // position 29 (0-based) in the array holds the ADJACENT wrong episode (E04); the real E05
    // entry sits one further at index 30 — exactly the shape a truncation-shifted prompt produces.
    const pack = packOfSize(31, { 29: 'Show.S01E04.chs.ass', 30: 'Show.S01E05.chs.ass' })
    // LLM confused the shown position (29) with the true i value (30)
    const r = runGate(rankWith([{ candidate_id: 'assrt:900001', file_index: 29, identity_match: 'confirmed', reason: 'x' }]), [pack], epIdentity)
    expect(r.ok).toBe(true)
    expect(r.decision).toBe('proceed')
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].fileIndex).toBe(30)
    expect(r.queue[0].candidate.fileList[r.queue[0].fileIndex!].name).toBe('Show.S01E05.chs.ass')
    // journal/failures note the remap even though the item still proceeds
    expect(r.failures.join(' ')).toMatch(/auto-remapped/i)
  })

  it('(b) rejects the item when multiple entries match the target episode and the chosen index matches none of them', () => {
    const pack = packOfSize(31, {
      5: 'Show.S01E05.repack.chs.ass', 12: 'Show.S01E01.chs.ass', 30: 'Show.S01E05.chs.ass',
    })
    const r = runGate(rankWith([{ candidate_id: 'assrt:900001', file_index: 12, identity_match: 'confirmed', reason: 'x' }]), [pack], epIdentity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.queue).toEqual([])
    expect(r.failures.join(' ')).toMatch(/rather than guessing/i)
  })

  it('(c) leaves a code-less candidate unaffected (no filename in the pack carries a parseable episode code)', () => {
    const pack: SubtitleCandidate = {
      provider: 'assrt', providerId: '900002', videoName: 'Show.S01', nativeName: null,
      language: '简', subtype: null, releaseSite: null, uploadDate: null,
      fileList: [{ index: 0, name: '简体.srt' }, { index: 1, name: '繁体.srt' }],
    }
    const r = runGate(rankWith([{ candidate_id: 'assrt:900002', file_index: 0, identity_match: 'confirmed', reason: 'x' }]), [pack], epIdentity)
    expect(r.ok).toBe(true)
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].fileIndex).toBe(0)
    expect(r.failures).toEqual([])
  })

  it('(d) regression pin: a null file_index against a multi-file pack is still rejected by the pre-existing range check, not silently healed', () => {
    const pack = packOfSize(31, { 0: 'Show.S01E01.chs.ass', 30: 'Show.S01E05.chs.ass' })
    const r = runGate(rankWith([{ candidate_id: 'assrt:900001', file_index: null, identity_match: 'confirmed', reason: 'x' }]), [pack], epIdentity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.queue).toEqual([])
    expect(r.failures.join(' ')).toMatch(/out of range/i)
  })
})
