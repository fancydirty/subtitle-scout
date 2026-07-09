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

  it('returns stats with duration and call counts', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const result = await runPipeline(makeDeps(), ctx, outDir)
    expect(result.stats.llmCalls).toBe(3)
    expect(result.stats.apiCalls).toBe(0) // fake assrt 不经过 onApiCall
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0)
  })
})
