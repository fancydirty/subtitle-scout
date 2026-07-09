import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPipeline, pickSeasonPack, type PipelineDeps } from './pipeline.js'
import type { AssrtSub } from './schemas.js'
import { MediaContextSchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema } from './schemas.js'
import { DecisionCache } from './cache.js'
import { scanOrphans } from '../files/orphanScanner.js'

const ctx = MediaContextSchema.parse(JSON.parse(readFileSync('fixtures/contexts/matrix.json', 'utf8')))
const searchResp = AssrtSearchResponseSchema.parse(JSON.parse(readFileSync('fixtures/assrt/search-matrix.json', 'utf8')))
const detailResp = AssrtDetailResponseSchema.parse(JSON.parse(readFileSync('fixtures/assrt/detail-673114.json', 'utf8')))
const seasonDetail = AssrtDetailResponseSchema.parse(JSON.parse(readFileSync('fixtures/assrt/detail-season-pack.json', 'utf8')))

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    identify: vi.fn(async () => ({
      parsed: {
        canonical_title: 'The Matrix', original_title: 'The Matrix', year: 1999,
        type: 'movie' as const, season: null, episode: null, edition: null,
        confidence: 0.95, evidence: ['filename'],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'identify prompt',
    })),
    plan: vi.fn(async () => ({
      parsed: { queries: [{ q: 'The.Matrix.1999.1080p.BluRay.x264', reason: 'release name' }] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'plan prompt',
    })),
    rank: vi.fn(async () => ({
      parsed: {
        decision: 'download' as const, assrt_id: 673114, file_index: 0,
        confidence: 0.91, reasons: ['exact match'], rejected: [],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    })),
    assrt: {
      search: vi.fn(async () => searchResp),
      detail: vi.fn(async () => detailResp),
    },
    download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\nTitle: t\n'), contentType: 'text/plain' })),
    cache: new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-'))),
    maxApiCallsPerJob: 4,
    ...overrides,
  }
}

describe('runPipeline', () => {
  it('golden path: downloads, writes subtitle + decision.json, exit download', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps()
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('download')
    expect(existsSync(result.subtitlePath!)).toBe(true)
    expect(result.subtitlePath).toContain('The.Matrix.1999.1080p.BluRay.x264.zh-Hans')
    const journal = JSON.parse(readFileSync(join(outDir, 'decision.json'), 'utf8'))
    expect(journal.llm_calls.length).toBe(3)
    expect(journal.decision.decision).toBe('download')
  })

  it('unions first two queries, dedups by id, does not stop at first non-empty', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const searchA = AssrtSearchResponseSchema.parse({
      status: 0, sub: { subs: [{ id: 673114, videoname: 'A', filelist: [{ f: 'a.srt' }] }] },
    })
    const searchB = AssrtSearchResponseSchema.parse({
      status: 0, sub: { subs: [
        { id: 673114, videoname: 'A-dup', filelist: [{ f: 'a.srt' }] },
        { id: 800000, videoname: 'B', filelist: [{ f: 'b.ass' }] },
      ] },
    })
    const search = vi.fn()
      .mockResolvedValueOnce(searchA)
      .mockResolvedValueOnce(searchB)
    const rank = vi.fn(async (_c: unknown, _id: unknown, cands: { id: number }[]) => ({
      parsed: {
        decision: 'download' as const, assrt_id: 673114, file_index: 0,
        confidence: 0.91, reasons: ['union'], rejected: [],
        _seen: cands.map(c => c.id),
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const deps = makeDeps({
      plan: vi.fn(async () => ({
        parsed: { queries: [
          { q: 'title 1999', reason: 'year' },
          { q: 'title bluray', reason: 'broad' },
        ] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'plan prompt',
      })),
      assrt: { search, detail: vi.fn(async () => detailResp) },
      rank: rank as unknown as PipelineDeps['rank'],
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(search).toHaveBeenCalledTimes(2)
    expect(result.decision).toBe('download')
    const rankResult = await rank.mock.results[0].value as any
    const seen = rankResult.parsed._seen as number[]
    expect(seen.sort((a: number, b: number) => a - b)).toEqual([673114, 800000])
  })

  it('graphic-only candidates yield no_safe_match with graphic reason', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const graphicResp = AssrtSearchResponseSchema.parse({
      status: 0, sub: { subs: [{ id: 900001, videoname: 'G', filelist: [{ f: 'g.sup' }] }] },
    })
    const deps = makeDeps({
      assrt: { search: vi.fn(async () => graphicResp), detail: vi.fn(async () => detailResp) },
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('no_safe_match')
    const journal = JSON.parse(readFileSync(join(outDir, 'decision.json'), 'utf8'))
    expect(JSON.stringify(journal.decision.reasons)).toContain('图形字幕')
    expect(deps.rank).not.toHaveBeenCalled()
  })

  it('gate failure: bogus assrt_id yields no_safe_match, nothing written', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({
      rank: vi.fn(async () => ({
        parsed: {
          decision: 'download' as const, assrt_id: 999999, file_index: null,
          confidence: 0.99, reasons: ['hallucinated'], rejected: [],
        }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('no_safe_match')
    expect(result.subtitlePath).toBeUndefined()
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('caches negative results and skips ASSRT on second run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({
      rank: vi.fn(async () => ({
        parsed: { decision: 'no_safe_match' as const, assrt_id: null, file_index: null, confidence: 0.3, reasons: ['nothing safe'], rejected: [] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })),
    })
    await runPipeline(deps, ctx, mkdtempSync(join(tmpdir(), 'out-')))
    const second = await runPipeline(deps, ctx, outDir)
    expect(second.decision).toBe('no_safe_match')
    expect(second.fromCache).toBe(true)
    expect(deps.assrt.search).toHaveBeenCalledTimes(1) // 只有第一次
  })

  it('tries the next query when the first yields zero candidates', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const empty = AssrtSearchResponseSchema.parse({ status: 0, sub: { subs: [] } })
    const deps = makeDeps({
      plan: vi.fn(async () => ({
        parsed: { queries: [{ q: 'weird exact', reason: 'r' }, { q: 'The Matrix 1999', reason: 'r' }] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'plan prompt',
      })),
      assrt: {
        search: vi.fn(async (q: string) => (q === 'weird exact' ? empty : searchResp)),
        detail: vi.fn(async () => detailResp),
      },
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('download')
    expect(deps.assrt.search).toHaveBeenCalledTimes(2)
  })

  it('llm error surfaces as error decision with journal written', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({ identify: vi.fn(async () => { throw new Error('LLM down') }) })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('error')
    expect(existsSync(join(outDir, 'decision.json'))).toBe(true)
  })

  it('does not fast-path a positive cache hit from a title-only key', async () => {
    const outDir1 = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    // 预置：title key 上有一个 positive 条目（模拟碰撞/污染）
    cache.put(['title:the matrix|1999|movie|S-|E-'],
      { kind: 'positive', assrt_id: 606770, file_index: 0, confidence: 0.9 })
    // context 无 provider_ids → 只有 title key 可命中
    const bareCtx = structuredClone(ctx)
    bareCtx.media.provider_ids = {}
    const deps = makeDeps({ cache })
    const result = await runPipeline(deps, bareCtx, outDir1)
    // 不信任 title-only positive：必须走完整 plan/search/rank 流程
    expect(deps.plan).toHaveBeenCalled()
    expect(deps.assrt.search).toHaveBeenCalled()
    expect(result.decision).toBe('download')
  })

  it('writes decision.json to journalDir when provided, subtitle to outDir', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const journalDir = mkdtempSync(join(tmpdir(), 'jr-'))
    const deps = makeDeps()
    const result = await runPipeline(deps, ctx, outDir, journalDir)
    expect(result.decision).toBe('download')
    expect(existsSync(join(journalDir, 'decision.json'))).toBe(true)
    expect(existsSync(join(outDir, 'decision.json'))).toBe(false)
    expect(result.subtitlePath!.startsWith(outDir)).toBe(true)
  })

  it('graduates to season mode: writes a sidecar per mapped episode', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = seasonDetail.sub.subs[0]
    const search = vi.fn(async () => AssrtSearchResponseSchema.parse({ status: 0, sub: { subs: [packCandidate] } }))
    const rank = vi.fn(async () => ({
      parsed: { decision: 'download' as const, assrt_id: 900900, file_index: 0, confidence: 0.95, reasons: ['pack'], rejected: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: false },
    ]
    const covered: string[] = []
    const deps = makeDeps({
      assrt: { search, detail: vi.fn(async () => seasonDetail) },
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\n'), contentType: 'text/plain' })),
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(async () => ({
          parsed: { pairs: [
            { filelist_index: 0, episode_code: 'S02E01', confidence: 0.95, reason: 'x' },
            { filelist_index: 1, episode_code: 'S02E02', confidence: 0.95, reason: 'x' },
          ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
        })),
        onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02'])
    expect(covered.sort()).toEqual(['S02E01', 'S02E02'])
    expect(existsSync(join(outDir, 'Show.S02E01.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(outDir, 'Show.S02E02.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(outDir, 'Show.S02E03.zh-Hans.ass'))).toBe(false)
  })

  it('does NOT graduate for a movie (enumerate never called)', async () => {
    const enumerate = vi.fn(async () => [])
    const deps = makeDeps({ seasonPack: { enumerate, map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'] })
    await runPipeline(deps, ctx, mkdtempSync(join(tmpdir(), 'out-')))
    expect(enumerate).not.toHaveBeenCalled()
  })

  it('pickSeasonPack chooses the fullest multi-file pack, not a single-episode candidate', () => {
    const mk = (id: number, files: string[]): AssrtSub => ({ id, filelist: files.map(f => ({ f })) } as unknown as AssrtSub)
    const cands = [
      mk(1, ['Show.S03E12.chs.ass']),                                   // single episode
      mk(2, ['Show.S03E01.ass', 'Show.S03E02.ass', 'Show.S03E03.ass']), // 3-ep pack
      mk(3, ['Show.S03E01.ass', 'Show.S03E02.ass']),                    // 2-ep pack
      mk(4, ['cover.jpg']),                                             // no subs
    ]
    expect(pickSeasonPack(cands)?.id).toBe(2)   // fullest pack wins, single-episode ignored
    expect(pickSeasonPack([mk(9, ['a.chs.srt'])])).toBeUndefined()   // no pack → undefined
  })

  it('season sweep: maps 4 loose per-episode candidates to 4 episodes in one run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      { id: 801, videoname: 'Show.S02E01.chs', native_name: '第1集', filelist: [{ f: 'Show.S02E01.chs.ass', url: 'http://dl/801' }] },
      { id: 802, videoname: 'Show.S02E02.chs', native_name: '第2集', filelist: [{ f: 'Show.S02E02.chs.ass', url: 'http://dl/802' }] },
      { id: 803, videoname: 'Show.S02E03.chs', native_name: '第3集', filelist: [{ f: 'Show.S02E03.chs.ass', url: 'http://dl/803' }] },
      { id: 804, videoname: 'Show.S02E04.chs', native_name: '第4集', filelist: [{ f: 'Show.S02E04.chs.ass', url: 'http://dl/804' }] },
    ]
    const search = vi.fn(async () => AssrtSearchResponseSchema.parse({ status: 0, sub: { subs: looseCandidates } }))
    const rank = vi.fn(async () => ({
      parsed: { decision: 'download' as const, assrt_id: 801, file_index: 0, confidence: 0.90, reasons: ['loose'], rejected: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: true },
      { itemId: 'e4', seasonNumber: 2, episodeNumber: 4, episodeCode: 'S02E04', videoPath: join(outDir, 'Show.S02E04.mkv'), videoFilename: 'Show.S02E04.mkv', needsChinese: true },
    ]
    const covered: string[] = []
    const llm = {
      call: vi.fn(async () => ({
        parsed: { assignments: [
          { episode_code: 'S02E01', sub_id: 801, confidence: 0.95 },
          { episode_code: 'S02E02', sub_id: 802, confidence: 0.95 },
          { episode_code: 'S02E03', sub_id: 803, confidence: 0.95 },
          { episode_code: 'S02E04', sub_id: 804, confidence: 0.95 },
        ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
      })),
    }
    const detail = vi.fn(async (id: number) => {
      const sub = looseCandidates.find(c => c.id === id)!
      return AssrtDetailResponseSchema.parse({ status: 0, sub: { subs: [sub] } })
    })
    const deps = makeDeps({
      assrt: { search, detail },
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\n'), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02', 'S02E03', 'S02E04'])
    expect(covered.sort()).toEqual(['S02E01', 'S02E02', 'S02E03', 'S02E04'])
    expect(llm.call).toHaveBeenCalledTimes(1) // one LLM call maps the whole season
    expect(detail).toHaveBeenCalledTimes(4)
    expect(existsSync(join(outDir, 'Show.S02E01.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(outDir, 'Show.S02E04.zh-Hans.ass'))).toBe(true)
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.steps.some((s: { name: string }) => s.name === 'seasonSweep')).toBe(true)
  })

  it('season sweep: does NOT trigger when a whole-season pack is available (pack has priority)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = seasonDetail.sub.subs[0]
    const looseCandidates = [
      packCandidate, // whole-season pack
      { id: 801, videoname: 'Show.S02E01.chs', filelist: [{ f: 'Show.S02E01.chs.ass', url: 'http://dl/801' }] },
    ]
    const search = vi.fn(async () => AssrtSearchResponseSchema.parse({ status: 0, sub: { subs: looseCandidates } }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const llmSweep = vi.fn()
    const deps = makeDeps({
      assrt: { search, detail: vi.fn(async () => seasonDetail) },
      llm: { call: llmSweep } as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(async () => ({
          parsed: { pairs: [{ filelist_index: 0, episode_code: 'S02E01', confidence: 0.95, reason: 'x' }], unmapped_files: [], reasons: [] },
          rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
        })),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    await runPipeline(deps, epCtx, outDir)
    expect(llmSweep).not.toHaveBeenCalled() // pack path used, sweep skipped
  })

  it('season sweep: does NOT trigger when only 1 episode needs subs', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      { id: 801, videoname: 'Show.S02E01.chs', filelist: [{ f: 'Show.S02E01.chs.ass' }] },
    ]
    const search = vi.fn(async () => AssrtSearchResponseSchema.parse({ status: 0, sub: { subs: looseCandidates } }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: false },
    ]
    const llmSweep = vi.fn()
    const deps = makeDeps({
      assrt: { search, detail: vi.fn(async () => detailResp) },
      llm: { call: llmSweep } as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    await runPipeline(deps, epCtx, outDir)
    expect(llmSweep).not.toHaveBeenCalled() // only 1 episode needs subs, no sweep
  })

  it('season sweep: filters out low-confidence assignments below auto_download_min_confidence', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      { id: 801, videoname: 'Show.S02E01.chs', filelist: [{ f: 'Show.S02E01.chs.ass', url: 'http://dl/801' }] },
      { id: 802, videoname: 'Show.S02E02.maybe', filelist: [{ f: 'Show.S02E02.ass', url: 'http://dl/802' }] },
      { id: 803, videoname: 'Show.S02E03.chs', filelist: [{ f: 'Show.S02E03.chs.ass', url: 'http://dl/803' }] },
    ]
    const search = vi.fn(async () => AssrtSearchResponseSchema.parse({ status: 0, sub: { subs: looseCandidates } }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: true },
    ]
    const llm = {
      call: vi.fn(async () => ({
        parsed: { assignments: [
          { episode_code: 'S02E01', sub_id: 801, confidence: 0.95 },
          { episode_code: 'S02E02', sub_id: 802, confidence: 0.70 }, // below auto_download_min_confidence
          { episode_code: 'S02E03', sub_id: 803, confidence: 0.90 },
        ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
      })),
    }
    const detail = vi.fn(async (id: number) => {
      const sub = looseCandidates.find(c => c.id === id)!
      return AssrtDetailResponseSchema.parse({ status: 0, sub: { subs: [sub] } })
    })
    const deps = makeDeps({
      assrt: { search, detail },
      rank: vi.fn(async () => ({
        parsed: { decision: 'download' as const, assrt_id: 801, file_index: 0, confidence: 0.90, reasons: ['loose'], rejected: [] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })) as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\n'), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.length).toBe(2) // E01 and E03; E02 filtered out
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E03'])
    expect(detail).toHaveBeenCalledTimes(2) // only high-confidence assignments resolve detail
  })

  it('season sweep: 0-coverage falls back to single-episode path; alias-harvest fallback stays reachable', async () => {
    // Ordering guard: on a no_safe_match rank the alias-harvest fallback fires (rank phase),
    // its fresh loose candidates then reach the season block where a sweep is attempted;
    // when the sweep covers nothing it must fall through to the normal single-episode download.
    // The two fallbacks must chain, never short-circuit each other.
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    // First-round candidate carries a CJK name so alias harvest actually calls the LLM.
    const firstResp = AssrtSearchResponseSchema.parse({ status: 0, sub: { subs: [
      { id: 700, videoname: '流浪剧.Wandering.S02E01', native_name: '流浪剧', filelist: [{ f: 'x.srt' }] },
    ] } })
    const aliasCandidates = [
      { id: 901, videoname: '流浪剧.S02E01', native_name: '流浪剧 第1集', filelist: [{ f: 'S02E01.chs.ass', url: 'http://dl/901' }] },
      { id: 902, videoname: '流浪剧.S02E02', native_name: '流浪剧 第2集', filelist: [{ f: 'S02E02.chs.ass', url: 'http://dl/902' }] },
    ]
    const aliasResp = AssrtSearchResponseSchema.parse({ status: 0, sub: { subs: aliasCandidates } })
    const search = vi.fn()
      .mockResolvedValueOnce(firstResp) // query 1
      .mockResolvedValueOnce(firstResp) // query 2 (dedup)
      .mockResolvedValueOnce(aliasResp) // alias-harvest search
    const rank = vi.fn()
      .mockResolvedValueOnce({ parsed: { decision: 'no_safe_match' as const, assrt_id: null, file_index: null, confidence: 0.3, reasons: ['no english match'], rejected: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
      .mockResolvedValueOnce({ parsed: { decision: 'download' as const, assrt_id: 901, file_index: 0, confidence: 0.9, reasons: ['alias match'], rejected: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
    const llmCall = vi.fn(async (opts: { name: string }) => {
      if (opts.name === 'extract_chinese_alias') {
        return { parsed: { alias: '流浪剧', confidence: 0.95 }, rawText: '', retries: 0, durationMs: 1, prompt: '' }
      }
      // map_loose_episodes → no confident assignments → sweep covers nothing
      return { parsed: { assignments: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: '' }
    })
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const detail = vi.fn(async (id: number) => {
      const sub = aliasCandidates.find(c => c.id === id) ?? aliasCandidates[0]
      return AssrtDetailResponseSchema.parse({ status: 0, sub: { subs: [sub] } })
    })
    const onCovered = vi.fn()
    const testCtx = structuredClone(ctx)
    testCtx.media = { ...testCtx.media, type: 'episode', season: 2, episode: 1 }
    testCtx.media.alternative_titles = [] // upstream has no CJK title → alias harvest allowed
    const deps = makeDeps({
      plan: vi.fn(async () => ({ parsed: { queries: [{ q: 'Show S02', reason: 's' }, { q: 'Show 2020', reason: 'y' }] }, rawText: '', retries: 0, durationMs: 1, prompt: 'p' })),
      rank: rank as unknown as PipelineDeps['rank'],
      assrt: { search, detail },
      download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\n'), contentType: 'text/plain' })),
      llm: { call: llmCall } as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered,
      } as unknown as PipelineDeps['seasonPack'],
    })
    const result = await runPipeline(deps, testCtx, outDir)
    // alias-harvest fallback stayed reachable: three searches, two rank passes
    expect(search).toHaveBeenCalledTimes(3)
    expect(rank).toHaveBeenCalledTimes(2)
    const calledNames = llmCall.mock.calls.map(c => (c[0] as { name: string }).name)
    expect(calledNames).toContain('extract_chinese_alias')
    expect(calledNames).toContain('map_loose_episodes') // sweep was attempted on the alias result
    // sweep covered nothing → fell back to the single-episode download path
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.steps.some((s: { name: string }) => s.name === 'seasonSweepStart')).toBe(true)
    expect(onCovered).not.toHaveBeenCalled()
    expect(result.coveredEpisodes).toBeUndefined()
    expect(result.decision).toBe('download')
    expect(existsSync(result.subtitlePath!)).toBe(true)
  })

  it('cached-positive episode hit does NOT trigger season graduation (no enumerate)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const identify = vi.fn(async () => ({
      parsed: { canonical_title: 'Show', original_title: 'Show', year: 2020, type: 'episode' as const, season: 2, episode: 1, edition: null, confidence: 0.95, evidence: ['x'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'id',
    }))
    const enumerate = vi.fn(async () => [])
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1, provider_ids: { imdb: 'tt999' } } }
    cache.put(['id:imdb:tt999:S2:E1'], { kind: 'positive', assrt_id: 673114, file_index: 0, confidence: 0.95 })
    const deps = makeDeps({ cache, identify, seasonPack: { enumerate, map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'] })
    const result = await runPipeline(deps, epCtx, outDir)
    expect(enumerate).not.toHaveBeenCalled()   // 缓存命中路径跳过季块（!cached 守卫）
    expect(result.fromCache).toBe(true)
  })
})

describe('adoptLocal step', () => {
  function adoptionDeps(mediaDir: string, judge: any) {
    writeFileSync(join(mediaDir, '乱名字幕.ass'), '[Script Info]\nTitle: matrix zh\n')
    return {
      scan: (dir: string, video: string) => scanOrphans(dir, video),
      judge,
      read: (p: string) => readFileSync(p),
    }
  }

  it('adopts a local orphan and never touches ASSRT', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'media-'))
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const judge = vi.fn(async () => ({
      parsed: { adopt: true, file: '乱名字幕.ass', language: 'zh-Hans' as const, confidence: 0.93, reasons: ['zh sample'] },
      rawText: '', prompt: 'p', retries: 0, durationMs: 1,
    }))
    // Adjust context to point to our temp media directory
    const testCtx = structuredClone(ctx)
    testCtx.media.path = join(mediaDir, 'The.Matrix.1999.1080p.BluRay.x264.mkv')
    const deps = makeDeps({ adoption: adoptionDeps(mediaDir, judge) })
    const result = await runPipeline(deps, testCtx, outDir)
    expect(result.decision).toBe('adopted_local')
    expect(existsSync(join(outDir, 'The.Matrix.1999.1080p.BluRay.x264.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(mediaDir, '乱名字幕.ass'))).toBe(true) // 原件不动
    expect(deps.assrt.search).not.toHaveBeenCalled()
    expect(deps.plan).not.toHaveBeenCalled()
  })

  it('falls through to ASSRT when judge declines', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'media-'))
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const judge = vi.fn(async () => ({
      parsed: { adopt: false, confidence: 0.2, reasons: ['not this movie'] },
      rawText: '', prompt: 'p', retries: 0, durationMs: 1,
    }))
    const testCtx = structuredClone(ctx)
    testCtx.media.path = join(mediaDir, 'The.Matrix.1999.1080p.BluRay.x264.mkv')
    const deps = makeDeps({ adoption: adoptionDeps(mediaDir, judge) })
    const result = await runPipeline(deps, testCtx, outDir)
    expect(result.decision).toBe('download') // 走了 ASSRT 黄金路径
  })

  it('bypassNegativeCache forces a fresh run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    cache.put(['id:imdb:tt0133093:S-:E-'], { kind: 'negative', reason: 'stale' })
    const deps = makeDeps({ cache })
    const result = await runPipeline(deps, ctx, outDir, outDir, { bypassNegativeCache: true })
    expect(result.decision).toBe('download')
    expect(deps.assrt.search).toHaveBeenCalled()
  })

  it('adoption already_exists returns early without plan/assrt calls', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'media-'))
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    // Pre-create the conforming-named subtitle in outDir
    writeFileSync(join(outDir, 'The.Matrix.1999.1080p.BluRay.x264.zh-Hans.ass'), '[Script Info]\nTitle: already there\n')
    writeFileSync(join(mediaDir, '乱名字幕.ass'), '[Script Info]\nTitle: orphan\n')
    const judge = vi.fn(async () => ({
      parsed: { adopt: true, file: '乱名字幕.ass', language: 'zh-Hans' as const, confidence: 0.93, reasons: ['zh sample'] },
      rawText: '', prompt: 'p', retries: 0, durationMs: 1,
    }))
    const testCtx = structuredClone(ctx)
    testCtx.media.path = join(mediaDir, 'The.Matrix.1999.1080p.BluRay.x264.mkv')
    const deps = makeDeps({ adoption: adoptionDeps(mediaDir, judge) })
    const result = await runPipeline(deps, testCtx, outDir)
    expect(result.decision).toBe('already_exists')
    expect(deps.plan).not.toHaveBeenCalled()
    expect(deps.assrt.search).not.toHaveBeenCalled()
  })

  it('judgeOrphan error degrades gracefully, continues to ASSRT (production robustness)', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'media-'))
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    writeFileSync(join(mediaDir, '乱名字幕.ass'), '[Script Info]\nTitle: orphan\n')
    // Simulate judgeOrphan throwing (StructuredOutputError exhausted retries, schema parse failure, etc.)
    const judge = vi.fn(async () => { throw new Error('StructuredOutputError: retries exhausted') })
    const testCtx = structuredClone(ctx)
    testCtx.media.path = join(mediaDir, 'The.Matrix.1999.1080p.BluRay.x264.mkv')
    const deps = makeDeps({ adoption: adoptionDeps(mediaDir, judge) })
    const result = await runPipeline(deps, testCtx, outDir)
    // judgeOrphan failed but run continues → should reach ASSRT and produce normal decision
    expect(result.decision).toBe('download') // golden path from makeDeps
    expect(deps.assrt.search).toHaveBeenCalled() // fell through to search
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.steps.some((s: { name: string }) => s.name === 'judgeOrphanFailed')).toBe(true)
  })

  it('returns stats with duration and call counts', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const result = await runPipeline(makeDeps(), ctx, outDir)
    expect(result.stats.llmCalls).toBe(3)
    expect(result.stats.apiCalls).toBe(0) // fake assrt 不经过 onApiCall
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0)
  })

  describe('alias harvest fallback', () => {
    const twoQueryPlan = () => vi.fn(async () => ({
      parsed: { queries: [{ q: 'LDR S04', reason: 'season' }, { q: 'LDR 2022', reason: 'year' }] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'plan prompt',
    }))
    const firstSearchResp = AssrtSearchResponseSchema.parse({
      status: 0,
      sub: {
        subs: [
          { id: 1, videoname: '爱、死亡与机器人.Love.Death.and.Robots.S04E01', filelist: [{ f: 's04e01.srt' }] },
          { id: 2, videoname: 'Love.Death.and.Robots.S04E02.1080p', filelist: [{ f: 's04e02.ass' }] },
        ],
      },
    })
    const aliasSearchResp = AssrtSearchResponseSchema.parse({
      status: 0,
      sub: {
        subs: [
          { id: 3, videoname: '爱，死亡与机器人 第三季', filelist: [{ f: 's03e01.srt' }] },
          { id: 1, videoname: '爱、死亡与机器人.Love.Death.and.Robots.S04E01', filelist: [{ f: 's04e01-dup.srt' }] },
        ],
      },
    })
    const aliasDetailResp = AssrtDetailResponseSchema.parse({
      status: 0,
      sub: {
        subs: [{
          id: 3, videoname: '爱，死亡与机器人 第三季',
          filelist: [{ f: 's03e01.srt', url: 'http://file0.assrt.net/download/3/s03e01.srt' }],
        }],
      },
    })
    const noSafeMatchRank = {
      parsed: {
        decision: 'no_safe_match' as const, assrt_id: null, file_index: null,
        confidence: 0.3, reasons: ['no match among candidates'], rejected: [],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }
    const mockHarvestLlm = (alias: string | null = '爱，死亡与机器人', confidence = 0.95) => ({
      call: vi.fn(async () => ({
        parsed: { alias, confidence }, rawText: '', retries: 0, durationMs: 1, prompt: '',
      })),
      profileInfo: () => ({ mode: 'test' }),
    })

    it('first rank rejects → harvest alias, third search, fresh rank pass wins', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const search = vi.fn()
        .mockResolvedValueOnce(firstSearchResp) // query 1
        .mockResolvedValueOnce(firstSearchResp) // query 2 (same results)
        .mockResolvedValueOnce(aliasSearchResp) // alias search
      const mockLlm = mockHarvestLlm()
      const rank = vi.fn()
        .mockResolvedValueOnce(noSafeMatchRank) // first pass rejects
        .mockResolvedValueOnce({               // second pass on fresh candidates only
          parsed: {
            decision: 'download' as const, assrt_id: 3, file_index: 0,
            confidence: 0.92, reasons: ['season pack under Chinese alias'], rejected: [],
          }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
        })
      const testCtx = structuredClone(ctx)
      testCtx.media.alternative_titles = [] // upstream gives no Chinese title
      const deps = makeDeps({
        plan: twoQueryPlan(),
        rank: rank as unknown as PipelineDeps['rank'],
        assrt: { search, detail: vi.fn(async () => aliasDetailResp) },
        llm: mockLlm as unknown as PipelineDeps['llm'],
      })
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('download')
      // third search happens only after first rank rejected, with the harvested alias
      expect(search).toHaveBeenCalledTimes(3)
      expect(search).toHaveBeenNthCalledWith(3, '爱，死亡与机器人')
      expect(mockLlm.call).toHaveBeenCalledWith(expect.objectContaining({ name: 'extract_chinese_alias' }))
      // second rank pass sees ONLY fresh candidates (id 3), not the already-rejected first-round set
      expect(rank).toHaveBeenCalledTimes(2)
      const secondPassCands = rank.mock.calls[1][2] as { id: number }[]
      expect(secondPassCands.map(c => c.id)).toEqual([3])
      // journal records the harvest steps
      const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
      const harvestStep = journal.steps.find((s: { name: string }) => s.name === 'aliasHarvest')
      expect(harvestStep.data.alias).toBe('爱，死亡与机器人')
      const mergedStep = journal.steps.find((s: { name: string }) => s.name === 'aliasSearchMerged')
      expect(mergedStep.data.added).toBe(1) // id 3 is new, id 1 is a duplicate
    })

    it('first rank succeeds → harvest never triggers (zero extra cost)', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const search = vi.fn(async () => searchResp)
      const mockLlm = mockHarvestLlm()
      const testCtx = structuredClone(ctx)
      testCtx.media.alternative_titles = []
      const deps = makeDeps({
        plan: twoQueryPlan(),
        assrt: { search, detail: vi.fn(async () => detailResp) },
        llm: mockLlm as unknown as PipelineDeps['llm'],
      })
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('download') // golden-path rank from makeDeps
      expect(search).toHaveBeenCalledTimes(2)  // no third search
      expect(mockLlm.call).not.toHaveBeenCalled()
      const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
      expect(journal.steps.some((s: { name: string }) => s.name === 'aliasHarvest')).toBe(false)
    })

    it('skips harvest when upstream provides a Chinese alternative title', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const search = vi.fn(async () => firstSearchResp)
      const mockLlm = mockHarvestLlm()
      const testCtx = structuredClone(ctx)
      testCtx.media.alternative_titles = ['黑客帝国'] // upstream already has Chinese
      const deps = makeDeps({
        plan: twoQueryPlan(),
        rank: vi.fn(async () => noSafeMatchRank),
        assrt: { search, detail: vi.fn(async () => detailResp) },
        llm: mockLlm as unknown as PipelineDeps['llm'],
      })
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('no_safe_match')
      expect(search).toHaveBeenCalledTimes(2)
      expect(mockLlm.call).not.toHaveBeenCalled()
    })

    it('skips harvest when the media title itself is Chinese (CJK-native guard)', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const search = vi.fn(async () => firstSearchResp)
      const mockLlm = mockHarvestLlm()
      const testCtx = structuredClone(ctx)
      testCtx.media.alternative_titles = []
      testCtx.media.title = '流浪地球' // CJK-native library — nothing to harvest
      const deps = makeDeps({
        plan: twoQueryPlan(),
        rank: vi.fn(async () => noSafeMatchRank),
        assrt: { search, detail: vi.fn(async () => detailResp) },
        llm: mockLlm as unknown as PipelineDeps['llm'],
      })
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('no_safe_match')
      expect(search).toHaveBeenCalledTimes(2)
      expect(mockLlm.call).not.toHaveBeenCalled()
    })
  })
})
