import { describe, it, expect } from 'vitest'
import {
  compactCandidates, filterGraphicOnly, isGraphicOnly, MAX_CANDIDATES, MAX_FILELIST_ENTRIES,
  neededEpisodeCodesFor, rankCandidates,
} from './rankCandidates.js'
import { runGate } from '../core/gate.js'
import type { LlmRuntime } from './runtime.js'
import type { MediaContext, MediaIdentity, RankDecision, SubtitleCandidate } from '../core/schemas.js'

function fakeSub(id: number, files: number): SubtitleCandidate {
  return {
    provider: 'assrt', providerId: String(id), videoName: `v${id}`, nativeName: null,
    releaseSite: null, subtype: null, language: '简', uploadDate: null,
    fileList: Array.from({ length: files }, (_, i) => ({ index: i, name: `file${i}.ass` })),
  }
}

describe('compactCandidates', () => {
  it('caps candidate count', () => {
    const out = compactCandidates(Array.from({ length: 20 }, (_, i) => fakeSub(i, 1)))
    expect(out.length).toBe(MAX_CANDIDATES)
  })
  it('truncates long filelists and records the truncation (no needed-episode signal: falls back to a head sample)', () => {
    const out = compactCandidates([fakeSub(1, 100)])
    expect(out[0].filelist.length).toBe(MAX_FILELIST_ENTRIES)
    expect(out[0].filelist_truncated).toBe(100 - MAX_FILELIST_ENTRIES)
    expect(out[0].filelist[0]).toEqual({ i: 0, name: 'file0.ass' }) // 每条自带原始 index，供 file_index 直接引用
  })
  it('leaves short filelists untouched', () => {
    const out = compactCandidates([fakeSub(1, 3)])
    expect(out[0].filelist.length).toBe(3)
    expect(out[0].filelist_truncated).toBeUndefined()
    expect(out[0].filelist).toEqual([
      { i: 0, name: 'file0.ass' }, { i: 1, name: 'file1.ass' }, { i: 2, name: 'file2.ass' },
    ])
  })
  it('regression: small filelists are unaffected by neededEpisodeCodes (no truncation logic engaged at all)', () => {
    const out = compactCandidates([fakeSub(1, 5)], ['S03E05'])
    expect(out[0].filelist.length).toBe(5)
    expect(out[0].filelist_truncated).toBeUndefined()
    expect(out[0].filelist.map(f => f.name)).toEqual(['file0.ass', 'file1.ass', 'file2.ass', 'file3.ass', 'file4.ass'])
  })
})

describe('neededEpisodeCodesFor', () => {
  const baseCtx = {
    media: { type: 'episode', filename: 'x', season: null, episode: null },
  } as unknown as MediaContext
  const baseIdentity = {
    canonical_title: 'Show', original_title: null, year: 2020, type: 'episode',
    season: null, episode: null, edition: null, confidence: 0.9, evidence: [],
  } as unknown as MediaIdentity

  it('derives the canonical episode code from identity season/episode', () => {
    const identity = { ...baseIdentity, season: 3, episode: 5 } as MediaIdentity
    expect(neededEpisodeCodesFor(baseCtx, identity)).toEqual(['S03E05'])
  })
  it('falls back to ctx.media season/episode when identity omits them', () => {
    const ctx = { ...baseCtx, media: { ...baseCtx.media, season: 3, episode: 5 } } as MediaContext
    expect(neededEpisodeCodesFor(ctx, baseIdentity)).toEqual(['S03E05'])
    // identity partially resolved (season only) still falls back per-field for the missing one
    const identity = { ...baseIdentity, season: 3 } as MediaIdentity
    expect(neededEpisodeCodesFor(ctx, identity)).toEqual(['S03E05'])
  })
  it('returns empty for movies', () => {
    const identity = { ...baseIdentity, type: 'movie', season: 3, episode: 5 } as MediaIdentity
    expect(neededEpisodeCodesFor(baseCtx, identity)).toEqual([])
  })
  it('returns empty when season/episode are unresolved anywhere', () => {
    expect(neededEpisodeCodesFor(baseCtx, baseIdentity)).toEqual([])
  })
})

/**
 * 生产事故复现（True Detective S3E5-E8 卡死）：assrt:635301 是一个 72 文件的 YYeTs 全季 S3 包。
 * 构造一个同形状的 fixture——前 30 条位置塞满噪声/E01-E04，E05-E08 的真实条目全部排在第 30 条
 * 之后（旧的 files.slice(0, 30) 会把它们整体砍掉）。
 */
function trueDetectivePack(totalFiles = 72): SubtitleCandidate {
  const files: { index: number; name: string }[] = []
  let idx = 0
  for (let i = 0; i < 26; i++) files.push({ index: idx++, name: `True.Detective.S03.sample.${i}.jpg` })
  for (let e = 1; e <= 4; e++) files.push({ index: idx++, name: `True.Detective.S03E0${e}.YYeTs.chs.ass` })
  for (let e = 5; e <= 8; e++) files.push({ index: idx++, name: `True.Detective.S03E0${e}.YYeTs.chs.ass` })
  while (files.length < totalFiles) files.push({ index: idx++, name: `True.Detective.S03.extra.${idx}.nfo` })
  return {
    provider: 'assrt', providerId: '635301', videoName: 'True.Detective.S03.YYeTs.YYeTs',
    nativeName: null, releaseSite: null, subtype: null, language: '简', uploadDate: null, fileList: files,
  }
}

describe('compactCandidates relevance-aware selection (assrt:635301 repro)', () => {
  it.each([5, 6, 7, 8])('keeps the S03E0%i entry visible even though it falls past the raw head-30 cutoff', (ep) => {
    const pack = trueDetectivePack()
    const code = `S03E0${ep}`
    // sanity: this entry really is beyond a naive slice(0, MAX_FILELIST_ENTRIES) cutoff
    const rawIndex = pack.fileList.findIndex(f => f.name.includes(code))
    expect(rawIndex).toBeGreaterThanOrEqual(MAX_FILELIST_ENTRIES)

    const out = compactCandidates([pack], [code])
    const shownEntry = out[0].filelist.find(f => f.name.includes(code))
    expect(shownEntry).toBeDefined()
    expect(shownEntry!.i).toBe(rawIndex) // 保留原始 index，file_index 才能命中真实 fileList 位置
  })

  it('bounds the prompt on a pathological 200-file pack while still surfacing the needed episode', () => {
    const pack = trueDetectivePack(200)
    const out = compactCandidates([pack], ['S03E07'])
    expect(out[0].filelist.length).toBeLessThanOrEqual(MAX_FILELIST_ENTRIES)
    expect(out[0].filelist_truncated).toBe(200 - out[0].filelist.length)
    const shownEntry = out[0].filelist.find(f => f.name.includes('S03E07'))
    expect(shownEntry).toBeDefined()
  })

  it('caps the needed-entries selection itself at MAX_FILELIST_ENTRIES when >30 entries all match (pathological re-encode pack)', () => {
    // every entry in this 40-file pack matches the needed code — the "always keep the needed
    // ones" carve-out must not let the shown list blow past MAX_FILELIST_ENTRIES in this case.
    const files = Array.from({ length: 40 }, (_, i) => ({ index: i, name: `Show.S01E01.re-encode.${i}.chs.ass` }))
    const pack: SubtitleCandidate = {
      provider: 'assrt', providerId: '1', videoName: 'Show.S01E01', nativeName: null,
      releaseSite: null, subtype: null, language: '简', uploadDate: null, fileList: files,
    }
    const out = compactCandidates([pack], ['S01E01'])
    expect(out[0].filelist.length).toBeLessThanOrEqual(MAX_FILELIST_ENTRIES)
    expect(out[0].filelist_truncated).toBe(40 - out[0].filelist.length)
  })
})

function subWithFiles(id: number, files: string[], subtype: string | null = null): SubtitleCandidate {
  return {
    provider: 'assrt', providerId: String(id), videoName: `v${id}`, nativeName: null,
    releaseSite: null, subtype, language: '简', uploadDate: null,
    fileList: files.map((name, index) => ({ index, name })),
  }
}

describe('isGraphicOnly', () => {
  it('keeps candidates that contain any text subtitle', () => {
    expect(isGraphicOnly(subWithFiles(1, ['movie.chs.srt']))).toBe(false)
    expect(isGraphicOnly(subWithFiles(2, ['movie.ass']))).toBe(false)
    expect(isGraphicOnly(subWithFiles(3, ['movie.ssa']))).toBe(false)
  })
  it('keeps mixed packs that contain at least one text file', () => {
    expect(isGraphicOnly(subWithFiles(4, ['movie.sup', 'movie.chs.srt']))).toBe(false)
  })
  it('rejects PGS-only (.sup) packs', () => {
    expect(isGraphicOnly(subWithFiles(5, ['movie.sup']))).toBe(true)
  })
  it('rejects VobSub .idx+.sub pairs', () => {
    expect(isGraphicOnly(subWithFiles(6, ['movie.idx', 'movie.sub']))).toBe(true)
  })
  it('does NOT reject a lone .sub (may be MicroDVD text)', () => {
    expect(isGraphicOnly(subWithFiles(7, ['movie.sub']))).toBe(false)
  })
  it('does NOT reject on subtype=None with empty filelist (often effect ass)', () => {
    expect(isGraphicOnly(subWithFiles(8, [], 'None'))).toBe(false)
    expect(isGraphicOnly(subWithFiles(9, [], null))).toBe(false)
  })
  it('rejects empty filelist only when subtype is explicitly graphic', () => {
    expect(isGraphicOnly(subWithFiles(10, [], 'PGS'))).toBe(true)
    expect(isGraphicOnly(subWithFiles(11, [], 'VobSub'))).toBe(true)
  })
})

describe('filterGraphicOnly', () => {
  it('removes graphic-only candidates and preserves order', () => {
    const cands = [
      subWithFiles(1, ['a.chs.srt']),
      subWithFiles(2, ['b.sup']),
      subWithFiles(3, ['c.ass']),
    ]
    const out = filterGraphicOnly(cands)
    expect(out.map(c => c.providerId)).toEqual(['1', '3'])
  })
})


describe('rankCandidates prompt', () => {
  function capture(): { llm: LlmRuntime; prompt: () => string } {
    let captured = ''
    const llm: LlmRuntime = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async call(opts: any) {
        captured = opts.prompt
        const parsed: RankDecision = {
          order: [{ candidate_id: 'assrt:1', file_index: 0, identity_match: 'confirmed', reason: 'x' }],
          rejected: [], reasons: ['ok'],
        }
        return { parsed, rawText: '', retries: 0, durationMs: 1, prompt: opts.prompt } as any
      },
      profileInfo: () => ({ mode: 'test' }),
    }
    return { llm, prompt: () => captured }
  }

  const ctx = {
    media: { filename: 'Show.S01E02.1080p.mkv' },
    preferences: { language: 'zh-Hans', prefer_bilingual: true, allow_traditional: true, allow_machine_translated: false },
  } as unknown as MediaContext
  const identity = {
    canonical_title: 'Show', original_title: null, year: 2020, type: 'episode',
    season: 1, episode: 2, edition: null, confidence: 0.9, evidence: [],
  } as unknown as MediaIdentity

  it('instructs the LLM to order candidates and emit per-item identity_match, not a single scalar decision', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    const p = prompt()
    expect(p).toMatch(/order/i)
    expect(p).toMatch(/identity_match/)
    expect(p).toMatch(/confirmed/)
    expect(p).toMatch(/mismatch/)
    expect(p).toMatch(/uncertain/)
  })

  it('instructs the LLM to keep uncertain candidates in order[] rather than refusing them', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    expect(prompt()).toMatch(/keep uncertain/i)
  })

  it('never asks for or mentions a confidence score', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    expect(prompt().toLowerCase()).not.toMatch(/decision threshold|confidence score/i)
  })

  it('encodes the M5b law: source/version differences must not downgrade identity', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    expect(prompt()).toMatch(/must not.*(lower|downgrade|change).*identity/i)
  })

  it('includes candidate_id instruction in prompt', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    expect(prompt()).toMatch(/candidate_id.*EXACTLY/)
  })

  // position-vs-i 混淆的 prompt 侧防线（gate.ts 的运行时兜底是最后一道，这里在源头减少
  // 混淆发生的概率）：一个具体的、带真实数字的 worked example，直白地示范"pick 的是 i 值，
  // 不是它在展示数组里排第几"，比抽象措辞更压得住模型把两者搞混的倾向。
  it('gives a worked example distinguishing file_index (the i value) from shown-array position', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    const p = prompt()
    expect(p).toContain('{"i":2,"name":"a.srt"},{"i":41,"name":"Show.S03E05.srt"}')
    expect(p).toMatch(/file_index:\s*41\s*\(NOT 1\)/)
  })
})

describe('rankCandidates end-to-end repro: assrt:635301 True Detective S3E5-E8 (production bug)', () => {
  /** 探测 E05 时（identity.season=3, identity.episode=5），mock LLM 从 prompt 里真实读出
   *  candidates[].filelist，找命中 "S03E05" 的条目并回它自带的 i——模拟一个称职的真实模型：
   *  它只能报告它能"看见"的东西。若旧的盲截断复现，prompt 里压根没有这个条目，这个 mock 会
   *  掉回 file_index: null，从而复现 gate.ts 的 "out of range" 死锁；修复后条目必然可见。 */
  function llmThatReadsThePrompt(episodeCode: string): LlmRuntime {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async call(opts: any) {
        const compactJson = /candidates: (\[.*\])$/s.exec(opts.prompt)?.[1]
        const compact = compactJson ? JSON.parse(compactJson) : []
        let order: RankDecision['order'] = []
        for (const c of compact) {
          const entry = (c.filelist as { i: number; name: string }[]).find((f) => f.name.includes(episodeCode))
          order = [{
            candidate_id: c.id, file_index: entry ? entry.i : null,
            identity_match: 'confirmed', reason: entry ? `matched ${episodeCode}` : 'not visible in filelist',
          }]
        }
        const parsed: RankDecision = { order, rejected: [], reasons: ['ok'] }
        return { parsed, rawText: '', retries: 0, durationMs: 1, prompt: opts.prompt } as any
      },
      profileInfo: () => ({ mode: 'test' }),
    }
  }

  it.each([5, 6, 7, 8])('resolves S03E0%i from the 72-file pack and passes the gate with a real file_index', async (ep) => {
    const pack = trueDetectivePack()
    const code = `S03E0${ep}`
    const ctx = {
      media: { filename: `True.Detective.S03E0${ep}.mkv`, season: 3, episode: ep },
      preferences: { language: 'zh-Hans', prefer_bilingual: true, allow_traditional: true, allow_machine_translated: false },
    } as unknown as MediaContext
    const identity = {
      canonical_title: 'True Detective', original_title: null, year: 2014, type: 'episode',
      season: 3, episode: ep, edition: null, confidence: 0.9, evidence: [],
    } as unknown as MediaIdentity

    const rankResult = await rankCandidates(llmThatReadsThePrompt(code), ctx, identity, [pack])

    // 可见性断言：真实 filename 必须出现在喂给模型的 candidates[].filelist 里（不是被截断藏起来）。
    // 不能直接对整个 prompt 做 toContain(code)——`media filename: True.Detective.S03E0${ep}.mkv`
    // 那一行本身就带着这个集号，无论 filelist 截断有没有正确保留目标条目，这个断言都会通过，
    // 测不出真正要防的回归。像 mock LLM 自己那样，先把 candidates JSON 从 prompt 里抠出来，
    // 只在这份真正喂给模型的 filelist 里找这个集号。
    const compactJson = /candidates: (\[.*\])$/s.exec(rankResult.prompt)?.[1]
    expect(compactJson).toBeDefined()
    const compact = JSON.parse(compactJson!) as Array<{ filelist: { i: number; name: string }[] }>
    const shownNames = compact.flatMap(c => c.filelist.map(f => f.name))
    expect(shownNames.some(name => name.includes(code))).toBe(true)

    const expectedIndex = pack.fileList.findIndex(f => f.name.includes(code))
    const gate = runGate(rankResult.parsed, [pack], identity)
    expect(gate.ok).toBe(true)
    expect(gate.decision).toBe('proceed')
    expect(gate.failures).toEqual([])
    expect(gate.queue[0]?.fileIndex).toBe(expectedIndex)
  })
})
