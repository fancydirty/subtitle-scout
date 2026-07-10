import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPipeline, pickSeasonPack, type PipelineDeps } from './pipeline.js'
import type { SubtitleCandidate } from './schemas.js'
import { MediaContextSchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema } from './schemas.js'
import { toCandidate } from '../adapters/providers/assrt.js'
import type { ProviderPort } from './providerPort.js'
import { DecisionCache } from './cache.js'
import { scanOrphans } from '../files/orphanScanner.js'

const ctx = MediaContextSchema.parse(JSON.parse(readFileSync('fixtures/contexts/matrix.json', 'utf8')))
const searchResp = AssrtSearchResponseSchema.parse(JSON.parse(readFileSync('fixtures/assrt/search-matrix.json', 'utf8')))
const seasonDetail = AssrtDetailResponseSchema.parse(JSON.parse(readFileSync('fixtures/assrt/detail-season-pack.json', 'utf8')))

// 中性候选池：既有 ASSRT fixture 通过 toCandidate 归一（provider-neutral 边界）
const matrixCandidates = searchResp.sub.subs.map(toCandidate)

/** 手写中性候选（sweep/alias 测试用） */
function mkCand(id: number, videoName: string, files: string[], nativeName: string | null = null): SubtitleCandidate {
  return {
    provider: 'assrt', providerId: String(id), videoName, nativeName,
    language: null, subtype: null, releaseSite: null, uploadDate: null,
    fileList: files.map((name, index) => ({ index, name })),
  }
}

function makeProviders(over: Partial<ProviderPort> = {}): ProviderPort {
  return {
    search: vi.fn(async () => matrixCandidates),
    resolveDownload: vi.fn(async () => ({
      url: 'http://file0.assrt.net/onthefly/673114/x.ass',
      filename: 'The.Matrix.1999.RERIP.2160p.BluRay.x265.10bit.SDR.DTS-HD.MA.TrueHD.7.1.Atmos-SWTYBLZ.zh.ass',
    })),
    ...over,
  }
}

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
        decision: 'download' as const, candidate_id: 'assrt:673114', file_index: 0,
        confidence: 0.91, reasons: ['exact match'], identity_match: 'uncertain' as const, rejected: [],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    })),
    providers: makeProviders(),
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

  it('sends the first two plan queries to the provider port in one call; rank sees the port pool', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const portPool = [
      mkCand(673114, 'A', ['a.srt']),
      mkCand(800000, 'B', ['b.ass']),
    ]
    const search = vi.fn(async () => portPool)
    const rank = vi.fn(async (_c: unknown, _id: unknown, cands: { providerId: string }[]) => ({
      parsed: {
        decision: 'download' as const, candidate_id: 'assrt:673114', file_index: 0,
        confidence: 0.91, reasons: ['union'], identity_match: 'uncertain' as const, rejected: [],
        _seen: cands.map(c => c.providerId),
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const deps = makeDeps({
      plan: vi.fn(async () => ({
        parsed: { queries: [
          { q: 'title 1999', reason: 'year' },
          { q: 'title bluray', reason: 'broad' },
          { q: 'title third', reason: 'never sent' },
        ] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'plan prompt',
      })),
      providers: makeProviders({ search }),
      rank: rank as unknown as PipelineDeps['rank'],
    })
    const result = await runPipeline(deps, ctx, outDir)
    // 一次端口调用带前两条查询（多查询/去重/gems 在 CLI 内部）
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ queries: ['title 1999', 'title bluray'] }))
    expect(result.decision).toBe('download')
    const rankResult = await rank.mock.results[0].value as any
    const seen = rankResult.parsed._seen as string[]
    expect(seen.sort()).toEqual(['673114', '800000'])
  })

  it('passes identity hints (imdb/year/filename/deep) to the provider port', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps()
    await runPipeline(deps, ctx, outDir)
    expect(deps.providers.search).toHaveBeenCalledWith(expect.objectContaining({
      imdb: 'tt0133093',
      year: 1999,
      filename: 'The.Matrix.1999.1080p.BluRay.x264.mkv',
      deep: false,
    }))
  })

  it('graphic-only candidates yield no_safe_match with graphic reason', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({
      providers: makeProviders({ search: vi.fn(async () => [mkCand(900001, 'G', ['g.sup'])]) }),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('no_safe_match')
    const journal = JSON.parse(readFileSync(join(outDir, 'decision.json'), 'utf8'))
    expect(JSON.stringify(journal.decision.reasons)).toContain('图形字幕')
    expect(deps.rank).not.toHaveBeenCalled()
  })

  it('gate failure: bogus candidate id yields no_safe_match, nothing written', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({
      rank: vi.fn(async () => ({
        parsed: {
          decision: 'download' as const, candidate_id: "assrt:999999", file_index: null,
          confidence: 0.99, reasons: ['hallucinated'], identity_match: 'uncertain' as const, rejected: [],
        }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('no_safe_match')
    expect(result.subtitlePath).toBeUndefined()
    expect(deps.download).not.toHaveBeenCalled()
    expect(deps.providers.resolveDownload).not.toHaveBeenCalled()
  })

  it('bare candidate_id self-heals through gate → normalized key → download + provider-qualified cache entry', async () => {
    // 端到端：模型丢 "assrt:" 前缀只回 '673114' → gate filter 恰一命中自愈 →
    // candidate_id 归一化为完整 key → resolve/download 走通 → cache.put 带 provider
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const deps = makeDeps({
      cache,
      rank: vi.fn(async () => ({
        parsed: {
          decision: 'download' as const, candidate_id: '673114', file_index: 0,
          confidence: 0.91, reasons: ['bare id from model'], identity_match: 'uncertain' as const, rejected: [],
        }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('download')
    expect(deps.providers.resolveDownload).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'assrt', providerId: '673114' }))
    const entry = cache.get('id:imdb:tt0133093:S-:E-')
    expect(entry).toMatchObject({ kind: 'positive', provider: 'assrt', providerId: '673114' })
  })

  it('caches negative results and skips provider search on second run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({
      rank: vi.fn(async () => ({
        parsed: { decision: 'no_safe_match' as const, candidate_id: null, file_index: null, confidence: 0.3, reasons: ['nothing safe'], identity_match: 'uncertain' as const, rejected: [] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })),
    })
    await runPipeline(deps, ctx, mkdtempSync(join(tmpdir(), 'out-')))
    const second = await runPipeline(deps, ctx, outDir)
    expect(second.decision).toBe('no_safe_match')
    expect(second.fromCache).toBe(true)
    expect(deps.providers.search).toHaveBeenCalledTimes(1) // 只有第一次
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
      { kind: 'positive', provider: 'assrt', providerId: '606770', fileIndex: 0, confidence: 0.9 })
    // context 无 provider_ids → 只有 title key 可命中
    const bareCtx = structuredClone(ctx)
    bareCtx.media.provider_ids = {}
    const deps = makeDeps({ cache })
    const result = await runPipeline(deps, bareCtx, outDir1)
    // 不信任 title-only positive：必须走完整 plan/search/rank 流程
    expect(deps.plan).toHaveBeenCalled()
    expect(deps.providers.search).toHaveBeenCalled()
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
    const packCandidate = toCandidate(seasonDetail.sub.subs[0])
    const resolveDownload = vi.fn(async (ref: { fileIndex: number | null }) => ({
      url: `http://file0.assrt.net/pack/900900/${(ref.fileIndex ?? 0) + 1}`,
    }))
    const rank = vi.fn(async () => ({
      parsed: { decision: 'download' as const, candidate_id: "assrt:900900", file_index: 0, confidence: 0.95, reasons: ['pack'], identity_match: 'uncertain' as const, rejected: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: false },
    ]
    const covered: string[] = []
    const deps = makeDeps({
      providers: makeProviders({ search: vi.fn(async () => [packCandidate]), resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
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
    // 每集独立 resolve：fileIndex 对应 filelist 序号
    expect(resolveDownload).toHaveBeenCalledTimes(2)
    expect(resolveDownload).toHaveBeenCalledWith(expect.objectContaining({ provider: 'assrt', providerId: '900900', fileIndex: 0 }))
    expect(resolveDownload).toHaveBeenCalledWith(expect.objectContaining({ provider: 'assrt', providerId: '900900', fileIndex: 1 }))
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
    const cands = [
      mkCand(1, 'x', ['Show.S03E12.chs.ass']),                                   // single episode
      mkCand(2, 'x', ['Show.S03E01.ass', 'Show.S03E02.ass', 'Show.S03E03.ass']), // 3-ep pack
      mkCand(3, 'x', ['Show.S03E01.ass', 'Show.S03E02.ass']),                    // 2-ep pack
      mkCand(4, 'x', ['cover.jpg']),                                             // no subs
    ]
    expect(pickSeasonPack(cands)?.providerId).toBe('2')   // fullest pack wins, single-episode ignored
    expect(pickSeasonPack([mkCand(9, 'x', ['a.chs.srt'])])).toBeUndefined()   // no pack → undefined
  })

  it('season sweep: maps 4 loose per-episode candidates to 4 episodes in one run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass'], '第1集'),
      mkCand(802, 'Show.S02E02.chs', ['Show.S02E02.chs.ass'], '第2集'),
      mkCand(803, 'Show.S02E03.chs', ['Show.S02E03.chs.ass'], '第3集'),
      mkCand(804, 'Show.S02E04.chs', ['Show.S02E04.chs.ass'], '第4集'),
    ]
    const search = vi.fn(async () => looseCandidates)
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { decision: 'download' as const, candidate_id: "assrt:801", file_index: 0, confidence: 0.90, reasons: ['loose'], identity_match: 'uncertain' as const, rejected: [] },
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
          { episode_code: 'S02E01', candidate_id: "assrt:801", confidence: 0.95 },
          { episode_code: 'S02E02', candidate_id: "assrt:802", confidence: 0.95 },
          { episode_code: 'S02E03', candidate_id: "assrt:803", confidence: 0.95 },
          { episode_code: 'S02E04', candidate_id: "assrt:804", confidence: 0.95 },
        ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
      })),
    }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
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
    expect(resolveDownload).toHaveBeenCalledTimes(4)
    expect(existsSync(join(outDir, 'Show.S02E01.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(outDir, 'Show.S02E04.zh-Hans.ass'))).toBe(true)
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.steps.some((s: { name: string }) => s.name === 'seasonSweep')).toBe(true)
  })

  it('season sweep: does NOT trigger when a whole-season pack is available (pack has priority)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = toCandidate(seasonDetail.sub.subs[0])
    const search = vi.fn(async () => [
      packCandidate, // whole-season pack
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass']),
    ])
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const llmSweep = vi.fn()
    const deps = makeDeps({
      providers: makeProviders({ search }),
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
    const search = vi.fn(async () => [mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass'])])
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: false },
    ]
    const llmSweep = vi.fn()
    const deps = makeDeps({
      providers: makeProviders({ search }),
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
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass']),
      mkCand(802, 'Show.S02E02.maybe', ['Show.S02E02.ass']),
      mkCand(803, 'Show.S02E03.chs', ['Show.S02E03.chs.ass']),
    ]
    const search = vi.fn(async () => looseCandidates)
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: true },
    ]
    const llm = {
      call: vi.fn(async () => ({
        parsed: { assignments: [
          { episode_code: 'S02E01', candidate_id: "assrt:801", confidence: 0.95 },
          { episode_code: 'S02E02', candidate_id: "assrt:802", confidence: 0.70 }, // below auto_download_min_confidence
          { episode_code: 'S02E02', candidate_id: null, confidence: 0.99 },        // fail-soft null row → filter 剔除，不炸 sweep
          { episode_code: 'S02E03', candidate_id: "assrt:803", confidence: 0.90 },
        ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
      })),
    }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: vi.fn(async () => ({
        parsed: { decision: 'download' as const, candidate_id: "assrt:801", file_index: 0, confidence: 0.90, reasons: ['loose'], identity_match: 'uncertain' as const, rejected: [] },
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
    expect(resolveDownload).toHaveBeenCalledTimes(2) // only high-confidence assignments resolve
  })

  it('season sweep: 0-coverage falls back to single-episode path; alias-harvest fallback stays reachable', async () => {
    // Ordering guard: on a no_safe_match rank the alias-harvest fallback fires (rank phase),
    // its fresh loose candidates then reach the season block where a sweep is attempted;
    // when the sweep covers nothing it must fall through to the normal single-episode download.
    // The two fallbacks must chain, never short-circuit each other.
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    // First-round candidate carries a CJK name so alias harvest actually calls the LLM.
    const firstRound = [mkCand(700, '流浪剧.Wandering.S02E01', ['x.srt'], '流浪剧')]
    const aliasRound = [
      mkCand(901, '流浪剧.S02E01', ['S02E01.chs.ass'], '流浪剧 第1集'),
      mkCand(902, '流浪剧.S02E02', ['S02E02.chs.ass'], '流浪剧 第2集'),
    ]
    const search = vi.fn()
      .mockResolvedValueOnce(firstRound) // main port call (both queries in one)
      .mockResolvedValueOnce(aliasRound) // alias-harvest re-search
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn()
      .mockResolvedValueOnce({ parsed: { decision: 'no_safe_match' as const, candidate_id: null, file_index: null, confidence: 0.3, reasons: ['no english match'], identity_match: 'uncertain' as const, rejected: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
      .mockResolvedValueOnce({ parsed: { decision: 'download' as const, candidate_id: "assrt:901", file_index: 0, confidence: 0.9, reasons: ['alias match'], identity_match: 'uncertain' as const, rejected: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
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
    const onCovered = vi.fn()
    const testCtx = structuredClone(ctx)
    testCtx.media = { ...testCtx.media, type: 'episode', season: 2, episode: 1 }
    testCtx.media.alternative_titles = [] // upstream has no CJK title → alias harvest allowed
    const deps = makeDeps({
      plan: vi.fn(async () => ({ parsed: { queries: [{ q: 'Show S02', reason: 's' }, { q: 'Show 2020', reason: 'y' }] }, rawText: '', retries: 0, durationMs: 1, prompt: 'p' })),
      rank: rank as unknown as PipelineDeps['rank'],
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\n'), contentType: 'text/plain' })),
      llm: { call: llmCall } as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered,
      } as unknown as PipelineDeps['seasonPack'],
    })
    const result = await runPipeline(deps, testCtx, outDir)
    // alias-harvest fallback stayed reachable: two port searches, two rank passes
    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenNthCalledWith(2, expect.objectContaining({ queries: ['流浪剧'] }))
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

  it('I-1: season sweep runs BEFORE gate early-return — rep-episode rank rejected, loose candidates cover the season', async () => {
    // 靶场景：代表集自己没安全单集匹配 → rank 拒绝整组（散装候选是其他集的）。
    // 修复前：gate 在 rank 非 download 时早退，季横扫永不触发 → decision no_safe_match（红）。
    // 修复后：gate 早退之前先横扫，覆盖全季 → download。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass'], '第1集'),
      mkCand(802, 'Show.S02E02.chs', ['Show.S02E02.chs.ass'], '第2集'),
      mkCand(803, 'Show.S02E03.chs', ['Show.S02E03.chs.ass'], '第3集'),
    ]
    const search = vi.fn(async () => looseCandidates)
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { decision: 'no_safe_match' as const, candidate_id: null, file_index: null, confidence: 0.2, reasons: ['no exact single-episode match for the representative episode'], identity_match: 'uncertain' as const, rejected: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: true },
    ]
    const covered: string[] = []
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E01', candidate_id: "assrt:801", confidence: 0.95 },
        { episode_code: 'S02E02', candidate_id: "assrt:802", confidence: 0.95 },
        { episode_code: 'S02E03', candidate_id: "assrt:803", confidence: 0.95 },
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\n'), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'          // CJK-native → 别名收割跳过，隔离 pre-gate 横扫
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02', 'S02E03'])
    expect(covered.sort()).toEqual(['S02E01', 'S02E02', 'S02E03'])
    expect(rank).toHaveBeenCalledTimes(1)     // 别名收割未触发（CJK 守卫），只有首轮 rank
    expect(llm.call).toHaveBeenCalledTimes(1) // 一次 map_loose_episodes 覆盖全季
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    const sweepStart = journal.steps.find((s: { name: string; data?: { trigger?: string } }) => s.name === 'seasonSweepStart')
    expect(sweepStart?.data?.trigger).toBe('pre-gate')
    expect(existsSync(join(outDir, 'Show.S02E01.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(outDir, 'Show.S02E03.zh-Hans.ass'))).toBe(true)
  })

  it('I-1: pre-gate sweep with 0 coverage falls back to no_safe_match gate early-return; sweep runs exactly once', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass'], '第1集'),
      mkCand(802, 'Show.S02E02.chs', ['Show.S02E02.chs.ass'], '第2集'),
    ]
    const search = vi.fn(async () => looseCandidates)
    const rank = vi.fn(async () => ({
      parsed: { decision: 'no_safe_match' as const, candidate_id: null, file_index: null, confidence: 0.2, reasons: ['no safe match'], identity_match: 'uncertain' as const, rejected: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const onCovered = vi.fn()
    const llm = { call: vi.fn(async () => ({ parsed: { assignments: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt' })) }
    const deps = makeDeps({
      providers: makeProviders({ search }),
      rank: rank as unknown as PipelineDeps['rank'],
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: { enumerate: vi.fn(async () => seasonEps), map: vi.fn(), onCovered } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('no_safe_match')  // 0 覆盖 → 落回 gate 早退，语义不变
    expect(llm.call).toHaveBeenCalledTimes(1)       // 横扫只跑一次：gate 前跑过，gate 后不重复
    expect(onCovered).not.toHaveBeenCalled()
    expect(result.coveredEpisodes).toBeUndefined()
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    const starts = journal.steps.filter((s: { name: string }) => s.name === 'seasonSweepStart')
    expect(starts.length).toBe(1)
    expect(starts[0].data.trigger).toBe('pre-gate')
    expect(journal.steps.some((s: { name: string }) => s.name === 'seasonSweep')).toBe(false) // 0 valid → 无 seasonSweep
  })

  it('M-1: alias harvest merges fresh into the sweep pool; second-round rank input stays fresh-only', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    // 首轮候选覆盖 E01（CJK nativeName 触发别名收割）；别名搜索带回 fresh 覆盖 E02
    const firstRound = [mkCand(700, '流浪剧.S02E01', ['Show.S02E01.chs.srt'], '流浪剧 第1集')]
    const aliasRound = [mkCand(902, '流浪剧.S02E02', ['Show.S02E02.chs.ass'], '流浪剧 第2集')]
    const search = vi.fn().mockResolvedValueOnce(firstRound).mockResolvedValueOnce(aliasRound)
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn()
      .mockResolvedValueOnce({ parsed: { decision: 'no_safe_match' as const, candidate_id: null, file_index: null, confidence: 0.3, reasons: ['no english match'], identity_match: 'uncertain' as const, rejected: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
      .mockResolvedValueOnce({ parsed: { decision: 'download' as const, candidate_id: "assrt:902", file_index: 0, confidence: 0.9, reasons: ['alias match'], identity_match: 'uncertain' as const, rejected: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const covered: string[] = []
    const llmCall = vi.fn(async (opts: { name: string }) => {
      if (opts.name === 'extract_chinese_alias') return { parsed: { alias: '流浪剧', confidence: 0.95 }, rawText: '', retries: 0, durationMs: 1, prompt: '' }
      // map_loose_episodes：E01←首轮 700，E02←fresh 902。仅当池为并集时首轮 700 才可覆盖。
      return { parsed: { assignments: [
        { episode_code: 'S02E01', candidate_id: "assrt:700", confidence: 0.95 },
        { episode_code: 'S02E02', candidate_id: "assrt:902", confidence: 0.95 },
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: '' }
    })
    const deps = makeDeps({
      plan: vi.fn(async () => ({ parsed: { queries: [{ q: 'Show S02', reason: 's' }, { q: 'Show 2020', reason: 'y' }] }, rawText: '', retries: 0, durationMs: 1, prompt: 'p' })),
      rank: rank as unknown as PipelineDeps['rank'],
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\n'), contentType: 'text/plain' })),
      llm: { call: llmCall } as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.alternative_titles = []  // 上游无 CJK → 允许别名收割
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    // 二轮 rank 输入仅 fresh（902），不含被拒的首轮 700
    expect(rank).toHaveBeenCalledTimes(2)
    expect((rank.mock.calls[1][2] as { providerId: string }[]).map(c => c.providerId)).toEqual(['902'])
    // 横扫池含首轮(700)+fresh(902)并集：map_loose_episodes 候选 prompt 两者都在
    const mapCall = llmCall.mock.calls.find(c => (c[0] as { name: string }).name === 'map_loose_episodes')!
    expect((mapCall[0] as unknown as { prompt: string }).prompt).toContain('"candidate_id":"assrt:700"')
    expect((mapCall[0] as unknown as { prompt: string }).prompt).toContain('"candidate_id":"assrt:902"')
    // 两集皆覆盖（首轮 E01 只能来自并集池里的 700）证明并入而非替换
    expect(covered.sort()).toEqual(['S02E01', 'S02E02'])
  })

  it('cached-positive episode hit does NOT trigger season graduation (no enumerate); resolves straight from cache', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const identify = vi.fn(async () => ({
      parsed: { canonical_title: 'Show', original_title: 'Show', year: 2020, type: 'episode' as const, season: 2, episode: 1, edition: null, confidence: 0.95, evidence: ['x'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'id',
    }))
    const enumerate = vi.fn(async () => [])
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1, provider_ids: { imdb: 'tt999' } } }
    cache.put(['id:imdb:tt999:S2:E1'], { kind: 'positive', provider: 'assrt', providerId: '673114', fileIndex: 0, confidence: 0.95 })
    const deps = makeDeps({ cache, identify, seasonPack: { enumerate, map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'] })
    const result = await runPipeline(deps, epCtx, outDir)
    expect(enumerate).not.toHaveBeenCalled()   // 缓存命中路径跳过季块（!cached 守卫）
    expect(result.fromCache).toBe(true)
    expect(result.decision).toBe('download')
    // 缓存命中直奔 resolve：不再 plan/search
    expect(deps.plan).not.toHaveBeenCalled()
    expect(deps.providers.search).not.toHaveBeenCalled()
    expect(deps.providers.resolveDownload).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'assrt', providerId: '673114', fileIndex: 0 }))
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

  it('adopts a local orphan and never touches providers', async () => {
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
    expect(deps.providers.search).not.toHaveBeenCalled()
    expect(deps.plan).not.toHaveBeenCalled()
  })

  it('falls through to provider search when judge declines', async () => {
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
    expect(result.decision).toBe('download') // 走了 provider 黄金路径
  })

  it('bypassNegativeCache forces a fresh run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    cache.put(['id:imdb:tt0133093:S-:E-'], { kind: 'negative', reason: 'stale' })
    const deps = makeDeps({ cache })
    const result = await runPipeline(deps, ctx, outDir, outDir, { bypassNegativeCache: true })
    expect(result.decision).toBe('download')
    expect(deps.providers.search).toHaveBeenCalled()
  })

  it('adoption already_exists returns early without plan/provider calls', async () => {
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
    expect(deps.providers.search).not.toHaveBeenCalled()
  })

  it('judgeOrphan error degrades gracefully, continues to provider search (production robustness)', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'media-'))
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    writeFileSync(join(mediaDir, '乱名字幕.ass'), '[Script Info]\nTitle: orphan\n')
    // Simulate judgeOrphan throwing (StructuredOutputError exhausted retries, schema parse failure, etc.)
    const judge = vi.fn(async () => { throw new Error('StructuredOutputError: retries exhausted') })
    const testCtx = structuredClone(ctx)
    testCtx.media.path = join(mediaDir, 'The.Matrix.1999.1080p.BluRay.x264.mkv')
    const deps = makeDeps({ adoption: adoptionDeps(mediaDir, judge) })
    const result = await runPipeline(deps, testCtx, outDir)
    // judgeOrphan failed but run continues → should reach provider search and produce normal decision
    expect(result.decision).toBe('download') // golden path from makeDeps
    expect(deps.providers.search).toHaveBeenCalled() // fell through to search
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.steps.some((s: { name: string }) => s.name === 'judgeOrphanFailed')).toBe(true)
  })

  it('returns stats with duration and call counts', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const result = await runPipeline(makeDeps(), ctx, outDir)
    expect(result.stats.llmCalls).toBe(3)
    expect(result.stats.apiCalls).toBe(0) // mock port 不经过 onEvent→journal.apiCall
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0)
  })

  describe('alias harvest fallback', () => {
    const twoQueryPlan = () => vi.fn(async () => ({
      parsed: { queries: [{ q: 'LDR S04', reason: 'season' }, { q: 'LDR 2022', reason: 'year' }] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'plan prompt',
    }))
    const firstRoundCands = [
      mkCand(1, '爱、死亡与机器人.Love.Death.and.Robots.S04E01', ['s04e01.srt']),
      mkCand(2, 'Love.Death.and.Robots.S04E02.1080p', ['s04e02.ass']),
    ]
    const aliasRoundCands = [
      mkCand(3, '爱，死亡与机器人 第三季', ['s03e01.srt']),
      mkCand(1, '爱、死亡与机器人.Love.Death.and.Robots.S04E01', ['s04e01-dup.srt']),  // dup of first round
    ]
    const noSafeMatchRank = {
      parsed: {
        decision: 'no_safe_match' as const, candidate_id: null, file_index: null,
        confidence: 0.3, reasons: ['no match among candidates'], identity_match: 'uncertain' as const, rejected: [],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }
    const mockHarvestLlm = (alias: string | null = '爱，死亡与机器人', confidence = 0.95) => ({
      call: vi.fn(async () => ({
        parsed: { alias, confidence }, rawText: '', retries: 0, durationMs: 1, prompt: '',
      })),
      profileInfo: () => ({ mode: 'test' }),
    })

    it('first rank rejects → harvest alias, second port search, fresh rank pass wins', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const search = vi.fn()
        .mockResolvedValueOnce(firstRoundCands) // main port call (both queries)
        .mockResolvedValueOnce(aliasRoundCands) // alias search
      const mockLlm = mockHarvestLlm()
      const rank = vi.fn()
        .mockResolvedValueOnce(noSafeMatchRank) // first pass rejects
        .mockResolvedValueOnce({               // second pass on fresh candidates only
          parsed: {
            decision: 'download' as const, candidate_id: "assrt:3", file_index: 0,
            confidence: 0.92, reasons: ['season pack under Chinese alias'], identity_match: 'uncertain' as const, rejected: [],
          }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
        })
      const testCtx = structuredClone(ctx)
      testCtx.media.alternative_titles = [] // upstream gives no Chinese title
      const deps = makeDeps({
        plan: twoQueryPlan(),
        rank: rank as unknown as PipelineDeps['rank'],
        providers: makeProviders({
          search,
          resolveDownload: vi.fn(async () => ({ url: 'http://file0.assrt.net/download/3/s03e01.srt', filename: 's03e01.srt' })),
        }),
        llm: mockLlm as unknown as PipelineDeps['llm'],
      })
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('download')
      // second port search happens only after first rank rejected, with the harvested alias
      expect(search).toHaveBeenCalledTimes(2)
      expect(search).toHaveBeenNthCalledWith(2, expect.objectContaining({ queries: ['爱，死亡与机器人'] }))
      expect(mockLlm.call).toHaveBeenCalledWith(expect.objectContaining({ name: 'extract_chinese_alias' }))
      // second rank pass sees ONLY fresh candidates (providerId 3), not the already-rejected first-round set
      expect(rank).toHaveBeenCalledTimes(2)
      const secondPassCands = rank.mock.calls[1][2] as { providerId: string }[]
      expect(secondPassCands.map(c => c.providerId)).toEqual(['3'])
      // journal records the harvest steps
      const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
      const harvestStep = journal.steps.find((s: { name: string }) => s.name === 'aliasHarvest')
      expect(harvestStep.data.alias).toBe('爱，死亡与机器人')
      const mergedStep = journal.steps.find((s: { name: string }) => s.name === 'aliasSearchMerged')
      expect(mergedStep.data.added).toBe(1) // id 3 is new, id 1 is a duplicate
    })

    it('first rank succeeds → harvest never triggers (zero extra cost)', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const search = vi.fn(async () => matrixCandidates)
      const mockLlm = mockHarvestLlm()
      const testCtx = structuredClone(ctx)
      testCtx.media.alternative_titles = []
      const deps = makeDeps({
        plan: twoQueryPlan(),
        providers: makeProviders({ search }),
        llm: mockLlm as unknown as PipelineDeps['llm'],
      })
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('download') // golden-path rank from makeDeps
      expect(search).toHaveBeenCalledTimes(1)  // no alias search
      expect(mockLlm.call).not.toHaveBeenCalled()
      const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
      expect(journal.steps.some((s: { name: string }) => s.name === 'aliasHarvest')).toBe(false)
    })

    it('skips harvest when upstream provides a Chinese alternative title', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const search = vi.fn(async () => firstRoundCands)
      const mockLlm = mockHarvestLlm()
      const testCtx = structuredClone(ctx)
      testCtx.media.alternative_titles = ['黑客帝国'] // upstream already has Chinese
      const deps = makeDeps({
        plan: twoQueryPlan(),
        rank: vi.fn(async () => noSafeMatchRank),
        providers: makeProviders({ search }),
        llm: mockLlm as unknown as PipelineDeps['llm'],
      })
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('no_safe_match')
      expect(search).toHaveBeenCalledTimes(1)
      expect(mockLlm.call).not.toHaveBeenCalled()
    })

    it('skips harvest when the media title itself is Chinese (CJK-native guard)', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const search = vi.fn(async () => firstRoundCands)
      const mockLlm = mockHarvestLlm()
      const testCtx = structuredClone(ctx)
      testCtx.media.alternative_titles = []
      testCtx.media.title = '流浪地球' // CJK-native library — nothing to harvest
      const deps = makeDeps({
        plan: twoQueryPlan(),
        rank: vi.fn(async () => noSafeMatchRank),
        providers: makeProviders({ search }),
        llm: mockLlm as unknown as PipelineDeps['llm'],
      })
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('no_safe_match')
      expect(search).toHaveBeenCalledTimes(1)
      expect(mockLlm.call).not.toHaveBeenCalled()
    })
  })
})
