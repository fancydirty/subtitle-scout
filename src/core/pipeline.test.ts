import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPipeline, pickSeasonPack, matchesEpisodeCode, type PipelineDeps } from './pipeline.js'
import type { SubtitleCandidate } from './schemas.js'
import { MediaContextSchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema } from './schemas.js'
import { toCandidate } from '../adapters/providers/assrt.js'
import { ProviderQuotaExhaustedError, type ProviderPort } from './providerPort.js'
import { DecisionCache } from './cache.js'
import { scanOrphans } from '../files/orphanScanner.js'
import { allocate, install, cleanup, gcOrphans } from '../files/stagingSandbox.js'
import type { Journal } from './journal.js'

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

/** search 正常返回：候选 + 零 provider 故障 */
const ok = (candidates: SubtitleCandidate[]) => ({ candidates, providerErrors: [] })

function makeProviders(over: Partial<ProviderPort> = {}): ProviderPort {
  return {
    search: vi.fn(async () => ok(matrixCandidates)),
    resolveDownload: vi.fn(async () => ({
      url: 'http://file0.assrt.net/onthefly/673114/x.ass',
      filename: 'The.Matrix.1999.RERIP.2160p.BluRay.x265.10bit.SDR.DTS-HD.MA.TrueHD.7.1.Atmos-SWTYBLZ.zh.ass',
    })),
    ...over,
  }
}

// 一份可解析出 2 条 cue 的最小 ASS/SRT 样本——新流程里每次成功下载都要过 inspectSubtitle 结构
// 体检，旧夹具 '[Script Info]\nTitle: t\n'（零 cue）会被结构体检直接拒收，必须换成真实可解析
// 内容。extension 决定解析器（.ass 走 parseAssCues，.srt 走 parseSrtCues），两份都要备着，因为
// 测试里候选的 fileList 扩展名不全是同一种。
const SAMPLE_ASS = [
  '[Script Info]', 'Title: t', '', '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,你好',
  'Dialogue: 0,0:00:04.00,0:00:06.20,Default,,0,0,0,,再见',
].join('\n')

const SAMPLE_SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  '你好',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,200',
  '再见',
  '',
].join('\n')

function makeVerify(result: { match: boolean; reason: string } = { match: true, reason: 'looks right' }) {
  return vi.fn(async () => ({ parsed: result, rawText: '', retries: 0, durationMs: 1, prompt: 'verify prompt' }))
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
        order: [{ candidate_id: 'assrt:673114', file_index: 0, identity_match: 'uncertain' as const, reason: 'exact match' }], rejected: [], reasons: ['exact match'],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    })),
    verify: makeVerify(),
    providers: makeProviders(),
    download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
    cache: new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-'))),
    maxApiCallsPerJob: 4,
    staging: { allocate, install, cleanup },
    ...overrides,
  }
}

describe('runPipeline', () => {
  it('golden path: downloads, verifies, installs subtitle + writes decision.json, exit download', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps()
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('download')
    expect(existsSync(result.subtitlePath!)).toBe(true)
    expect(result.subtitlePath).toContain('The.Matrix.1999.1080p.BluRay.x264.zh-Hans')
    const journal = JSON.parse(readFileSync(join(outDir, 'decision.json'), 'utf8'))
    expect(journal.llm_calls.length).toBe(4) // identify, plan, rank, verify（新增一轮终审）
    expect(journal.decision.decision).toBe('download')
    // A real download+write happened this run — verification.downloaded must stay true (MINOR-A
    // only tightens the already_exists sites; the actual download path is unaffected).
    expect(journal.decision.verification.downloaded).toBe(true)
    // 沙盒目录随 job 结束清空，试错垃圾零残留
    expect(existsSync(join(outDir, '.subtitle-staging', ctx.request_id))).toBe(false)
  })

  it('FINDING-1: sandbox is allocated at the media-root level (not the deep video dir), install still lands next to the video, and a leftover sandbox is reachable by gcOrphans(root)', async () => {
    // outDir 模拟一个电视剧的深层目录（root/Show/Season 01/），mediaRoots 里配的是顶层 root——
    // 镜像真实生产接线（cli/index.ts mediaRoots(mappings) → deps.mediaRoots，daemon 启动的
    // gcStaging 只按顶层 root 非递归扫 <root>/.subtitle-staging/）。
    const root = mkdtempSync(join(tmpdir(), 'root-'))
    const outDir = join(root, 'Show', 'Season 01')
    mkdirSync(outDir, { recursive: true })
    const allocateSpy = vi.fn((jobId: string, mediaRootForVideo: string) => allocate(jobId, mediaRootForVideo))
    const cleanupSpy = vi.fn((jobId: string, mediaRootForVideo: string) => cleanup(jobId, mediaRootForVideo))
    const deps = makeDeps({ mediaRoots: [root], staging: { allocate: allocateSpy, install, cleanup: cleanupSpy } })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('download')
    // 沙盒挂在 root 一级，不是深层的 Season 目录。
    expect(allocateSpy).toHaveBeenCalledWith(ctx.request_id, root)
    expect(cleanupSpy).toHaveBeenCalledWith(ctx.request_id, root)
    expect(allocateSpy).not.toHaveBeenCalledWith(ctx.request_id, outDir)
    // install() 仍然把最终文件落在视频自己的目录（root/Show/Season 01/），不是 root 本身。
    expect(existsSync(result.subtitlePath!)).toBe(true)
    expect(result.subtitlePath!.startsWith(outDir)).toBe(true)
    // job 结束沙盒清空——root 一级和 outDir 一级都不该有残留。
    expect(existsSync(join(root, '.subtitle-staging', ctx.request_id))).toBe(false)
    expect(existsSync(join(outDir, '.subtitle-staging'))).toBe(false)

    // 硬杀模拟：allocate 了沙盒但从未跑到 cleanup（进程被 SIGKILL/OOM/断电杀死）。按 root 一级
    // 非递归扫描的 gcOrphans 必须能找到并回收它——这正是 FINDING-1 要修的泄漏场景。
    const orphanJobId = 'crashed-job-1'
    allocate(orphanJobId, root)
    expect(existsSync(join(root, '.subtitle-staging', orphanJobId))).toBe(true)
    const cleaned = gcOrphans([root], new Set())
    expect(cleaned).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(root, '.subtitle-staging', orphanJobId))).toBe(false)
  })

  it('tries the next candidate in the queue when the first fails structural inspection', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const rank = vi.fn(async () => ({
      parsed: {
        order: [
          { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'uncertain' as const, reason: 'first guess' },
          { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain' as const, reason: 'second guess' },
        ], rejected: [], reasons: ['ordered'],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    let downloadCall = 0
    const download = vi.fn(async () => {
      downloadCall++
      // 第一次下载返回 HTML 错误页（结构体检硬拒，不打 LLM）；第二次返回正常字幕
      return downloadCall === 1
        ? { bytes: Buffer.from('<!DOCTYPE html><html><body>404</body></html>'), contentType: 'text/html' }
        : { bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' }
    })
    const verify = makeVerify({ match: true, reason: 'second candidate matches' })
    const deps = makeDeps({ rank, download, verify })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('download')
    expect(downloadCall).toBe(2)
    expect(verify).toHaveBeenCalledTimes(1) // 第一个候选结构性拒绝，不触发终审；只有第二个触发
  })

  it('exhausts the queue and reports no_safe_match when verify rejects every candidate (sandbox still cleaned up)', async () => {
    // 决定性内容结论回归钉子：每个候选都真正下载+体检+终审过，终审说都不是——这是诚实的
    // "确实没有安全匹配"，负缓存正当写入（区别于下面 transient-error 场景绝不能写负缓存）。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const verify = makeVerify({ match: false, reason: 'wrong episode' })
    const deps = makeDeps({ verify, cache })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('no_safe_match')
    expect(existsSync(join(outDir, '.subtitle-staging', ctx.request_id))).toBe(false)
    expect(cache.get('id:imdb:tt0133093:S-:E-')).toMatchObject({ kind: 'negative' })
  })

  it('FINDING-3: every candidate structurally rejects as HTML (rate-limited/challenge page, HTTP 200) → retry_later, cache NOT poisoned', async () => {
    // download() 只在 !res.ok 才抛错——一个限流/人机挑战的 provider 大概率照样回 HTTP 200，
    // 正文却是一坨 HTML。这类候选解码后 isHtml=true，结构体检硬拒，从未走到终审。旧行为把它
    // 和"真的打开看了、内容不是这个"一样计成决定性结论，全灭时误判成诚实的"确实没有安全匹配"
    // 写负缓存——把一次限流误诊成"这剧真的没字幕"，永久压制后续重试。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const rank = vi.fn(async () => ({
      parsed: {
        order: [
          { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'uncertain' as const, reason: 'first guess' },
          { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain' as const, reason: 'second guess' },
        ], rejected: [], reasons: ['ordered'],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const download = vi.fn(async () => ({
      bytes: Buffer.from('<!DOCTYPE html><html><body>rate limited, please wait</body></html>'),
      contentType: 'text/html',
    }))
    const verify = makeVerify()
    const deps = makeDeps({ rank, download, verify, cache })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('retry_later')
    expect(verify).not.toHaveBeenCalled() // isHtml 结构性硬拒，从未触发终审
    expect(cache.get('id:imdb:tt0133093:S-:E-')).toBeFalsy() // 负缓存绝不能被这种情况污染
  })

  it('mixed queue exhaustion (one transient resolveDownload error + one decisive verify-reject) forces retry_later, not poisoned', async () => {
    // 混合场景：候选池里一个打不通（resolve 瞬时故障），另一个打通但终审拒绝（决定性内容结论）。
    // 任何一个瞬时失败都要保守退避——不能因为"至少凑出一个决定性结论"就把整体判成诚实的
    // "确实没有"而写负缓存。镜像 searchProviderErrors 守卫（约 pipeline.ts:540）的瞬时 vs
    // 内容结论区分。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const rank = vi.fn(async () => ({
      parsed: {
        order: [
          { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'uncertain' as const, reason: 'first guess' },
          { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain' as const, reason: 'second guess' },
        ], rejected: [], reasons: ['ordered'],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    let resolveCall = 0
    const providers = makeProviders({
      resolveDownload: vi.fn(async () => {
        resolveCall++
        if (resolveCall === 1) throw new Error('subtitle-fetch exit 1: network blip')
        return { url: 'http://file0.assrt.net/onthefly/606770/x.ass', filename: 'second.ass' }
      }),
    })
    const verify = makeVerify({ match: false, reason: 'wrong episode' })
    const deps = makeDeps({ rank, providers, verify, cache })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('retry_later')
    expect(cache.get('id:imdb:tt0133093:S-:E-')).toBeFalsy()
  })

  describe('CRITICAL: candidate-queue budget must not be starved by search-phase api_calls', () => {
    // The real bug (reproduced end-to-end against production wiring, not just mocks): in
    // cli/index.ts, deps.providers.search() spawns the subtitle-fetch subprocess and its
    // onEvent('api_call', ...) hook journals every provider hit (ASSRT query×2 + similar/gems +
    // OS login+search — 4-5 events) SYNCHRONOUSLY, before search()'s own promise resolves (see
    // providerPort.ts's stderr 'data' handler calling opts.onEvent ahead of the child 'close'
    // event). Unit tests never caught this because a bare mocked `search` never touches the
    // journal — journal.counts().apiCalls stayed 0 in every existing test, silently hiding the
    // bug. These tests capture the journal via deps.journalReady (the same seam cli/index.ts
    // uses via AsyncLocalStorage) and have the mocked search call journal.apiCall(...) directly,
    // mirroring the real onEvent seam, to reproduce it faithfully.
    it('search journaling 5 api_calls (production default maxApiCallsPerJob=4) no longer starves the queue — the candidate IS tried, installed, decision=download', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      let journalRef: Journal | undefined
      const search = vi.fn(async () => {
        // Pre-fix: journal.counts().apiCalls===5 here would make tryCandidateQueue's budget
        // (maxApiCallsPerJob(4) - 5 = -1) negative before trying any candidate.
        for (let i = 0; i < 5; i++) {
          journalRef!.apiCall({ endpoint: `search-leg-${i}`, params: { provider: 'assrt' }, status: 200, durationMs: 5 })
        }
        return ok(matrixCandidates)
      })
      const deps = makeDeps({
        journalReady: j => { journalRef = j },
        providers: makeProviders({ search }),
        maxApiCallsPerJob: 4, // production default (cli/index.ts assemble())
      })
      const result = await runPipeline(deps, ctx, outDir)
      expect(deps.providers.resolveDownload).toHaveBeenCalled() // the flagship path actually tries
      expect(result.decision).toBe('download')
      expect(existsSync(result.subtitlePath!)).toBe(true)
      const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
      expect(journal.steps.some((s: { name: string }) => s.name === 'candidateQueueBudgetExhausted')).toBe(false)
    })

    it('budget exhausted mid-queue with untried ranked candidates remaining → retry_later, negative cache NOT written', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
      const rank = vi.fn(async () => ({
        parsed: {
          order: [
            { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'uncertain' as const, reason: 'first guess' },
            { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain' as const, reason: 'second guess' },
          ], rejected: [], reasons: ['ordered'],
        }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      }))
      // First candidate is a genuine, decisive verify-reject (not transient) — proves it's the
      // BUDGET, not a decisive verdict on every tried candidate, that stops the queue short.
      const verify = makeVerify({ match: false, reason: 'wrong episode' })
      const deps = makeDeps({ rank, verify, cache, maxApiCallsPerJob: 1 })
      const result = await runPipeline(deps, ctx, outDir)
      expect(deps.providers.resolveDownload).toHaveBeenCalledTimes(1) // only the 1st candidate tried
      expect(result.decision).toBe('retry_later')
      expect(cache.get('id:imdb:tt0133093:S-:E-')).toBeFalsy()
    })

    it('zero-tried budget starvation (maxApiCallsPerJob=0) → retry_later, negative cache NOT written', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
      const deps = makeDeps({ cache, maxApiCallsPerJob: 0 })
      const result = await runPipeline(deps, ctx, outDir)
      expect(deps.providers.resolveDownload).not.toHaveBeenCalled()
      expect(result.decision).toBe('retry_later')
      expect(cache.get('id:imdb:tt0133093:S-:E-')).toBeFalsy()
    })

    // Genuine full exhaustion (every ranked candidate tried, all decisively rejected, budget
    // fine) → no_safe_match + negative cache STILL written — already pinned by the existing
    // 'exhausts the queue and reports no_safe_match when verify rejects every candidate' test
    // above; not duplicated here.
  })

  it('already_exists: pre-existing on-disk subtitle short-circuits before resolve/download (crash-recovery replay), and carries the real path', async () => {
    // 崩溃恢复场景：上一轮已把字幕写到磁盘，但 DB 提交前进程崩溃；job 被 reap 重派后整条流水线
    // 重跑到这里。目标文件其实已经在磁盘上（文件名可从 candidate 的 fileList 静态推出，无需先
    // resolve/download）——不该再打一次 provider API + 下一次载全量字节，全部作废只为发现已存在。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const preexistingPath = join(outDir, 'The.Matrix.1999.1080p.BluRay.x264.zh-Hans.ass')
    writeFileSync(preexistingPath, '[Script Info]\nTitle: already on disk\n')
    const deps = makeDeps()
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('already_exists')
    expect(result.subtitlePath).toBe(preexistingPath) // 真实路径，不再是 undefined
    expect(deps.providers.resolveDownload).not.toHaveBeenCalled()
    expect(deps.download).not.toHaveBeenCalled()
    // MINOR-A: nothing was downloaded this run (pre-flight short-circuit before resolve/download) —
    // the journal must not claim otherwise, even though a real path is now recorded.
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.decision.verification).toEqual({ downloaded: false, path: preexistingPath, bytes: null, encoding: null })
  })

  it('already_exists: when the file only turns up already-written after a real download (not predictable up front), the result still carries the real path', async () => {
    // 覆盖旧的"晚期"分支：无法从候选元数据预判文件名的场景（如 resolved.filename 与候选静态名不同）
    // 仍要在实际下载后发现 alreadyExists 时把真实路径带回 result，而不是留 undefined。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    // 让本地候选池里的 fileList 名字与实际 resolveDownload 返回的 filename 不同（不可预判），
    // 这样预检必然 miss，只能在真下载后由 writeSubtitle 的 existsSync 分支发现已存在。
    const search = vi.fn(async () => ok([mkCand(900, 'Show', ['unrelated-name.txt'])]))
    const preexistingPath = join(outDir, 'The.Matrix.1999.1080p.BluRay.x264.zh-Hans.ass')
    writeFileSync(preexistingPath, '[Script Info]\nTitle: already on disk\n')
    const deps = makeDeps({
      providers: makeProviders({
        search,
        resolveDownload: vi.fn(async () => ({ url: 'http://file0.assrt.net/x.ass', filename: 'real-name.ass' })),
      }),
      rank: vi.fn(async () => ({
        parsed: { order: [{ candidate_id: 'assrt:900', file_index: 0, identity_match: 'uncertain' as const, reason: 'x' }], rejected: [], reasons: ['x'] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('already_exists')
    expect(result.subtitlePath).toBe(preexistingPath)
    expect(deps.providers.resolveDownload).toHaveBeenCalledTimes(1) // 预检 miss，仍会真的 resolve 一次
    // MINOR-A: a network fetch happened, but nothing new was written this run (writeSubtitle's
    // existsSync short-circuit discarded the bytes) — downloaded must stay false, not true.
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.decision.verification).toEqual({ downloaded: false, path: preexistingPath, bytes: null, encoding: null })
  })

  it('sends the first two plan queries to the provider port in one call; rank sees the port pool', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const portPool = [
      mkCand(673114, 'A', ['a.srt']),
      mkCand(800000, 'B', ['b.ass']),
    ]
    const search = vi.fn(async () => ok(portPool))
    const rank = vi.fn(async (_c: unknown, _id: unknown, cands: { providerId: string }[]) => ({
      parsed: {
        order: [{ candidate_id: 'assrt:673114', file_index: 0, identity_match: 'uncertain' as const, reason: 'union' }], rejected: [], reasons: ['union'],
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
      providers: makeProviders({ search: vi.fn(async () => ok([mkCand(900001, 'G', ['g.sup'])])) }),
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
          order: [{ candidate_id: "assrt:999999", file_index: null, identity_match: 'uncertain' as const, reason: 'hallucinated' }], rejected: [], reasons: ['hallucinated'],
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
          order: [{ candidate_id: '673114', file_index: 0, identity_match: 'uncertain' as const, reason: 'bare id from model' }], rejected: [], reasons: ['bare id from model'],
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
        parsed: { order: [], rejected: [], reasons: ['nothing safe'] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })),
    })
    await runPipeline(deps, ctx, mkdtempSync(join(tmpdir(), 'out-')))
    const second = await runPipeline(deps, ctx, outDir)
    expect(second.decision).toBe('no_safe_match')
    expect(second.fromCache).toBe(true)
    expect(deps.providers.search).toHaveBeenCalledTimes(1) // 只有第一次
  })

  it('zero candidates WITH provider errors → error decision, negative cache NOT poisoned', async () => {
    // 瞬时源故障（429/5xx/超时）被 CLI fail-soft 成零候选时，绝不能当"确实没有"写 1 天负缓存
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const deps = makeDeps({
      cache,
      providers: makeProviders({
        search: vi.fn(async () => ({ candidates: [], providerErrors: [{ provider: 'assrt', message: '429 rate limited' }] })),
      }),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('error')
    expect(result.reasons?.join(' ')).toMatch(/429 rate limited/)
    expect(cache.get('id:imdb:tt0133093:S-:E-')).toBeFalsy() // 无负条目
    expect(deps.rank).not.toHaveBeenCalled()
    // 第二次跑不该被缓存短路：search 再次被调用
    await runPipeline(deps, ctx, mkdtempSync(join(tmpdir(), 'out-')))
    expect(deps.providers.search).toHaveBeenCalledTimes(2)
  })

  it('zero candidates with ZERO provider errors → honest negative cache still written', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const deps = makeDeps({
      cache,
      providers: makeProviders({ search: vi.fn(async () => ok([])) }),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('no_safe_match')
    expect(cache.get('id:imdb:tt0133093:S-:E-')).toMatchObject({ kind: 'negative' })
  })

  it('gate rejects an INCOMPLETE candidate set (one source 429, other returned mismatches) → retry_later, no negative cache', async () => {
    // 一源瞬时 429 被 fail-soft 吞，另一源返回不匹配候选 → candidates>0 跳过零候选守卫，
    // rank/gate 在残缺集上判 no_safe_match。绝不能写 1 天负缓存把它当"确实没有"。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const deps = makeDeps({
      cache,
      providers: makeProviders({
        search: vi.fn(async () => ({
          candidates: [mkCand(500, 'Some.Other.Movie', ['other.srt'])],
          providerErrors: [{ provider: 'assrt', message: '429 rate limited' }],
        })),
      }),
      rank: vi.fn(async () => ({
        parsed: { order: [], rejected: [], reasons: ['none match'] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('retry_later')                          // ① 不是 no_safe_match
    expect(result.reasons?.join(' ')).toMatch(/assrt.*429/)
    expect(cache.get('id:imdb:tt0133093:S-:E-')).toBeFalsy()             // ② 无负条目
    // ③ 第二次跑不被短路：重新搜索
    await runPipeline(deps, ctx, mkdtempSync(join(tmpdir(), 'out-')))
    expect(deps.providers.search).toHaveBeenCalledTimes(2)
  })

  it('gate rejects a COMPLETE candidate set (zero provider errors) → honest negative cache still written', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const deps = makeDeps({
      providers: makeProviders({ search: vi.fn(async () => ok([mkCand(500, 'Some.Other.Movie', ['other.srt'])])) }),
      cache,
      rank: vi.fn(async () => ({
        parsed: { order: [], rejected: [], reasons: ['none match'] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('no_safe_match')
    expect(cache.get('id:imdb:tt0133093:S-:E-')).toMatchObject({ kind: 'negative' })
  })

  it('llm error surfaces as error decision with journal written', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({ identify: vi.fn(async () => { throw new Error('LLM down') }) })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('error')
    expect(existsSync(join(outDir, 'decision.json'))).toBe(true)
  })

  it('ProviderQuotaExhaustedError from resolveDownload surfaces as error decision carrying quotaExhausted.resetAt', async () => {
    // 根因：resolveDownload 报 OS 配额耗尽时，若这个 resetAt 信息在 pipeline outer catch 丢了，
    // 上游（v2 executor）就没法按重置时间精确退避，只能走盲的短退避阶梯白烧配额。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const resetAt = '2026-07-13T00:00:00.000Z'
    const deps = makeDeps({
      providers: makeProviders({
        resolveDownload: vi.fn(async () => { throw new ProviderQuotaExhaustedError('quota exhausted', resetAt) }),
      }),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('error')
    expect(result.quotaExhausted).toEqual({ resetAt })
  })

  it('a plain (non-quota) resolveDownload error is fail-soft per-candidate but forces retry_later at exhaustion, without poisoning the negative cache', async () => {
    // 行为变化（候选队列架构的直接后果，非误删覆盖）：旧单候选流水线里，resolveDownload 抛出的
    // 任何非配额错误都会一路冒到最外层 catch，整个 run 判 error（不缓存，可安全重试）。新架构下
    // 每个候选的下载尝试独立 try/catch（tryCandidateQueue）——非 ProviderQuotaExhaustedError 的
    // 瞬时失败只是"这个候选试错失败，换下一个"，队列耗尽后才是终态；这里只有一个候选，试完即
    // 耗尽。
    //
    // COVERAGE_LOST 修复：队列耗尽时若耗尽原因是瞬时故障（resolve/download 从未打通、没有真正
    // 拿到内容评判），绝不能当成"确实没有安全匹配"写 1 天负缓存——否则下一次 run 会被负缓存
    // 短路，永远等不到自愈重试。此处终态必须是 retry_later（镜像 searchProviderErrors 守卫，
    // 约 pipeline.ts:540 的瞬时 vs 内容结论区分），且 quotaExhausted 依旧不被误置。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const deps = makeDeps({
      cache,
      providers: makeProviders({
        resolveDownload: vi.fn(async () => { throw new Error('subtitle-fetch exit 1: network blip') }),
      }),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('retry_later')
    expect(result.quotaExhausted).toBeUndefined()
    expect(cache.get('id:imdb:tt0133093:S-:E-')).toBeFalsy()
    // 第二次跑不该被负缓存短路：重新搜索而不是命中缓存直接判 no_safe_match
    await runPipeline(deps, ctx, mkdtempSync(join(tmpdir(), 'out-')))
    expect(deps.providers.search).toHaveBeenCalledTimes(2)
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
      parsed: { order: [{ candidate_id: "assrt:900900", file_index: 0, identity_match: 'uncertain' as const, reason: 'pack' }], rejected: [], reasons: ['pack'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: false },
    ]
    const covered: string[] = []
    const coveredRefs: (string | undefined)[] = []
    const deps = makeDeps({
      providers: makeProviders({ search: vi.fn(async () => ok([packCandidate])), resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(async () => ({
          parsed: { pairs: [
            { filelist_index: 0, episode_code: 'S02E01', confidence: 0.95, reason: 'x' },
            { filelist_index: 1, episode_code: 'S02E02', confidence: 0.95, reason: 'x' },
          ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
        })),
        onCovered: vi.fn(async (ep: { episodeCode: string }, _path: string, ref?: string) => { covered.push(ep.episodeCode); coveredRefs.push(ref) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02'])
    expect(covered.sort()).toEqual(['S02E01', 'S02E02'])
    // MS-P1: 季包路径 onCovered 携带 provider-neutral 标识；result.selected 带 pack 来源
    expect(coveredRefs).toEqual(['assrt:900900', 'assrt:900900'])
    expect(result.coveredEpisodes?.every(c => c.providerRef === 'assrt:900900')).toBe(true)
    expect(result.selected).toMatchObject({ provider: 'assrt', provider_id: '900900', language: 'zh-Hans', format: 'ass' })
    // 每集独立 resolve：fileIndex 对应 filelist 序号
    expect(resolveDownload).toHaveBeenCalledTimes(2)
    expect(resolveDownload).toHaveBeenCalledWith(expect.objectContaining({ provider: 'assrt', providerId: '900900', fileIndex: 0 }))
    expect(resolveDownload).toHaveBeenCalledWith(expect.objectContaining({ provider: 'assrt', providerId: '900900', fileIndex: 1 }))
    expect(existsSync(join(outDir, 'Show.S02E01.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(outDir, 'Show.S02E02.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(outDir, 'Show.S02E03.zh-Hans.ass'))).toBe(false)
  })

  it('MINOR (finding 4): season pack graduation — an episode whose target file already exists on disk is onCovered(alreadyExisted=true), not conflated with a genuinely new install', async () => {
    // v2 executor's onCovered handler used to hardcode subtitles.source='scout-download' for
    // every episode a season-pack graduation covers, even when that episode's file was already
    // sitting on disk (stageInspectVerifyInstall's findOnDiskNfc short-circuit — install() never
    // called). Fix threads the outcome's alreadyExisted flag through onCovered's 4th arg so the
    // executor can attribute source='preexisting' instead, same as the single-episode
    // already_exists→'preexisting' mapping.
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = toCandidate(seasonDetail.sub.subs[0])
    const resolveDownload = vi.fn(async (ref: { fileIndex: number | null }) => ({
      url: `http://file0.assrt.net/pack/900900/${(ref.fileIndex ?? 0) + 1}`,
    }))
    const rank = vi.fn(async () => ({
      parsed: { order: [{ candidate_id: "assrt:900900", file_index: 0, identity_match: 'uncertain' as const, reason: 'pack' }], rejected: [], reasons: ['pack'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    // Pre-write E01's target — its install must short-circuit (alreadyExisted=true); E02 has no
    // pre-existing file and genuinely installs (alreadyExisted=false).
    writeFileSync(join(outDir, 'Show.S02E01.zh-Hans.ass'), SAMPLE_ASS)
    const onCoveredCalls: { episodeCode: string; alreadyExisted: unknown }[] = []
    const deps = makeDeps({
      providers: makeProviders({ search: vi.fn(async () => ok([packCandidate])), resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(async () => ({
          parsed: { pairs: [
            { filelist_index: 0, episode_code: 'S02E01', confidence: 0.95, reason: 'x' },
            { filelist_index: 1, episode_code: 'S02E02', confidence: 0.95, reason: 'x' },
          ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
        })),
        onCovered: vi.fn(async (ep: { episodeCode: string }, _path: string, _ref?: string, alreadyExisted?: boolean) => {
          onCoveredCalls.push({ episodeCode: ep.episodeCode, alreadyExisted })
        }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(onCoveredCalls.sort((a, b) => a.episodeCode.localeCompare(b.episodeCode))).toEqual([
      { episodeCode: 'S02E01', alreadyExisted: true },
      { episodeCode: 'S02E02', alreadyExisted: false },
    ])
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

  describe('matchesEpisodeCode (tolerant episode-code matcher)', () => {
    it('matches exact-case canonical SxxEyy (parity with the old .includes() check)', () => {
      expect(matchesEpisodeCode('Show.S02E05.chs.srt', 'S02E05')).toBe(true)
    })
    it('matches lowercase sxxeyy (IMPORTANT-2: coverage regression vs main)', () => {
      expect(matchesEpisodeCode('show.s02e05.chs.srt', 'S02E05')).toBe(true)
    })
    it('matches the NxM convention (e.g. 2x05)', () => {
      expect(matchesEpisodeCode('Show.2x05.srt', 'S02E05')).toBe(true)
    })
    it('rejects s02e050 as a false-positive match for S02E05 (digit-boundary guard)', () => {
      expect(matchesEpisodeCode('Show.S02E050.srt', 'S02E05')).toBe(false)
    })
    it('rejects a genuinely different episode code', () => {
      expect(matchesEpisodeCode('Show.S02E01.srt', 'S02E05')).toBe(false)
    })
    it('rejects 12x05 as a false-positive NxM match for season 2 (digit-boundary guard on the leading number too)', () => {
      expect(matchesEpisodeCode('Show.12x05.srt', 'S02E05')).toBe(false)
    })
    it('declines bare E05 without a season — ambiguous in a candidate pool that can span multiple seasons', () => {
      expect(matchesEpisodeCode('Show.E05.srt', 'S02E05')).toBe(false)
    })
    it('declines the CJK 第N集 form — season is unstated and numbering conventions vary too much to parse safely', () => {
      expect(matchesEpisodeCode('第5集.srt', 'S02E05')).toBe(false)
    })
    it('returns false for empty/undefined-ish text without throwing', () => {
      expect(matchesEpisodeCode('', 'S02E05')).toBe(false)
    })
  })

  it('season sweep: maps 4 loose per-episode candidates to 4 episodes in one run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass'], '第1集'),
      mkCand(802, 'Show.S02E02.chs', ['Show.S02E02.chs.ass'], '第2集'),
      mkCand(803, 'Show.S02E03.chs', ['Show.S02E03.chs.ass'], '第3集'),
      mkCand(804, 'Show.S02E04.chs', ['Show.S02E04.chs.ass'], '第4集'),
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [{ candidate_id: "assrt:801", file_index: 0, identity_match: 'uncertain' as const, reason: 'loose' }], rejected: [], reasons: ['loose'] },
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
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }, _path: string, ref?: string) => { covered.push(`${ep.episodeCode}=${ref}`) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02', 'S02E03', 'S02E04'])
    // MS-P1: 横扫路径 onCovered 携带各集命中候选的 provider-neutral 标识
    expect(covered.sort()).toEqual(['S02E01=assrt:801', 'S02E02=assrt:802', 'S02E03=assrt:803', 'S02E04=assrt:804'])
    expect(result.selected).toMatchObject({ provider: 'assrt', provider_id: '801' }) // 多集覆盖取首集作代表
    expect(llm.call).toHaveBeenCalledTimes(1) // one LLM call maps the whole season
    expect(resolveDownload).toHaveBeenCalledTimes(4)
    expect(existsSync(join(outDir, 'Show.S02E01.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(outDir, 'Show.S02E04.zh-Hans.ass'))).toBe(true)
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.steps.some((s: { name: string }) => s.name === 'seasonSweep')).toBe(true)
  })

  it('MINOR (finding 4): season sweep — an episode whose target file already exists on disk is onCovered(alreadyExisted=true), not conflated with a genuinely new install', async () => {
    // Same fix as the season-pack graduation path (see the sibling test above): the sweep's
    // stageInspectVerifyInstall can short-circuit an episode's install because the target file is
    // already on disk (findOnDiskNfc hit) — that must not be reported to onCovered the same way
    // as an episode scout genuinely just downloaded and wrote this run.
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass'], '第1集'),
      mkCand(802, 'Show.S02E02.chs', ['Show.S02E02.chs.ass'], '第2集'),
    ]
    // Pre-write E01's target — the sweep's install for E01 must short-circuit as "already
    // existed", while E02 is a genuine new install.
    writeFileSync(join(outDir, 'Show.S02E01.zh-Hans.ass'), SAMPLE_ASS)
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E01', candidate_id: 'assrt:801', confidence: 0.95 },
        { episode_code: 'S02E02', candidate_id: 'assrt:802', confidence: 0.95 },
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const onCoveredCalls: { episodeCode: string; alreadyExisted: unknown }[] = []
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }, _path: string, _ref?: string, alreadyExisted?: boolean) => {
          onCoveredCalls.push({ episodeCode: ep.episodeCode, alreadyExisted })
        }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国' // CJK-native → alias harvest skipped, isolate the sweep path
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(onCoveredCalls.sort((a, b) => a.episodeCode.localeCompare(b.episodeCode))).toEqual([
      { episodeCode: 'S02E01', alreadyExisted: true },
      { episodeCode: 'S02E02', alreadyExisted: false },
    ])
  })

  it('season sweep: rejects a loose candidate whose fileList has no file matching the assigned episode (no unconditional first-file fallback)', async () => {
    // 单文件候选(801)只有 E01 的字幕；LLM 幻觉把它映射到 E05（真实缺集）。修复前 line500 的
    // .find() 找不到匹配文件时无条件回退 subtitleFiles[0]（E01 那个文件）——把 E01 的字幕当 E05
    // 写盘、markCovered，永久污染 E05。修复后：找不到匹配文件必须跳过该 assignment，绝不下载/写盘。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.srt'], '第1集'),
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e5', seasonNumber: 2, episodeNumber: 5, episodeCode: 'S02E05', videoPath: join(outDir, 'Show.S02E05.mkv'), videoFilename: 'Show.S02E05.mkv', needsChinese: true },
    ]
    const covered: string[] = []
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E05', candidate_id: 'assrt:801', confidence: 0.92 }, // hallucinated cross-episode map
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国' // CJK-native → alias harvest skipped, isolate the sweep path
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(covered).toEqual([]) // E05 must NOT be covered by E01's file
    expect(resolveDownload).not.toHaveBeenCalled() // never even attempted to resolve the mismatched file
    expect(existsSync(join(outDir, 'Show.S02E05.zh-Hans.srt'))).toBe(false)
    expect(result.decision).toBe('no_safe_match') // 0-coverage sweep falls back to normal gate early-return
  })

  it('season sweep: IMPORTANT-2 regression check — a lowercase sxxeyy fileList name is a legitimate match, not skipped', async () => {
    // 修复前 f.name.includes(assignment.episode_code) 大小写敏感：'S02E05' 不是 's02e05.chs.srt' 的子串，
    // 常见的全小写命名会被误判为"无匹配文件"而跳过——这是相对 main 的覆盖率倒退，不是安全收益。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.S02E05.chs', ['show.s02e05.chs.srt'], '第5集'), // lowercase on disk, common release naming
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e5', seasonNumber: 2, episodeNumber: 5, episodeCode: 'S02E05', videoPath: join(outDir, 'Show.S02E05.mkv'), videoFilename: 'Show.S02E05.mkv', needsChinese: true },
    ]
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E05', candidate_id: 'assrt:801', confidence: 0.92 },
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_SRT), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode)).toEqual(['S02E05'])
    expect(resolveDownload).toHaveBeenCalledTimes(1)
    expect(existsSync(join(outDir, 'Show.S02E05.zh-Hans.srt'))).toBe(true)
  })

  it('season sweep: IMPORTANT-1 — an OS-style empty-fileList candidate whose videoName carries a matching episode signal is covered', async () => {
    // OS loose candidates always have fileList:[] (opensubtitles.ts osToCandidates). 修复前，subtitleFiles.length===0
    // 时整个校验被跳过、直接放行——一次 LLM 幻觉映射即可无验证写盘。修复后：空 fileList 必须回退校验
    // candidate-level 元数据（videoName/nativeName）里是否有可识别的集号信号。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const osCandidate: SubtitleCandidate = {
      provider: 'opensubtitles', providerId: '5001',
      videoName: 'Show.S02E05.720p.WEB-DL.chs', nativeName: null,
      language: null, subtype: null, releaseSite: null, uploadDate: null,
      fileList: [], // OS 单文件 provider 的常态
    }
    const search = vi.fn(async () => ok([osCandidate]))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}`, filename: 'Show.S02E05.srt' }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e5', seasonNumber: 2, episodeNumber: 5, episodeCode: 'S02E05', videoPath: join(outDir, 'Show.S02E05.mkv'), videoFilename: 'Show.S02E05.mkv', needsChinese: true },
    ]
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E05', candidate_id: 'opensubtitles:5001', confidence: 0.92 },
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_SRT), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode)).toEqual(['S02E05'])
    expect(resolveDownload).toHaveBeenCalledTimes(1)
  })

  it('season sweep: IMPORTANT-1 — an OS-style empty-fileList candidate whose videoName signals a DIFFERENT episode is skipped, never written', async () => {
    // 靶场景：assrt:801 的 fileList 为空(OS 候选)，LLM 幻觉把它映射到 S02E05，但其 videoName 明明白白
    // 写的是 S02E01。修复前该分支完全不做结构校验，直接 resolve/download/写盘覆盖 E05——permanent 串号。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const osCandidate: SubtitleCandidate = {
      provider: 'opensubtitles', providerId: '5001',
      videoName: 'Show.S02E01.720p.WEB-DL.chs', nativeName: null, // 明确是 E01 的字幕
      language: null, subtype: null, releaseSite: null, uploadDate: null,
      fileList: [],
    }
    const search = vi.fn(async () => ok([osCandidate]))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e5', seasonNumber: 2, episodeNumber: 5, episodeCode: 'S02E05', videoPath: join(outDir, 'Show.S02E05.mkv'), videoFilename: 'Show.S02E05.mkv', needsChinese: true },
    ]
    const covered: string[] = []
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E05', candidate_id: 'opensubtitles:5001', confidence: 0.92 }, // hallucinated cross-episode map
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(covered).toEqual([]) // E05 must NOT be covered by E01's subtitle
    expect(resolveDownload).not.toHaveBeenCalled() // never even attempted to resolve the mismatched candidate
    expect(existsSync(join(outDir, 'Show.S02E05.zh-Hans.srt'))).toBe(false)
    expect(result.decision).toBe('no_safe_match')
  })

  it('season sweep: IMPORTANT-1 — an OS-style empty-fileList candidate with no recognizable episode signal anywhere is skipped', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const osCandidate: SubtitleCandidate = {
      provider: 'opensubtitles', providerId: '5002',
      videoName: 'Show.Unknown.Release.720p.WEB-DL.chs', nativeName: null, // no SxxEyy/NxM signal at all
      language: null, subtype: null, releaseSite: null, uploadDate: null,
      fileList: [],
    }
    const search = vi.fn(async () => ok([osCandidate]))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e5', seasonNumber: 2, episodeNumber: 5, episodeCode: 'S02E05', videoPath: join(outDir, 'Show.S02E05.mkv'), videoFilename: 'Show.S02E05.mkv', needsChinese: true },
    ]
    const covered: string[] = []
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E05', candidate_id: 'opensubtitles:5002', confidence: 0.92 },
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(covered).toEqual([])
    expect(resolveDownload).not.toHaveBeenCalled()
    expect(result.decision).toBe('no_safe_match')
  })

  it('season sweep: one candidate mapped to N episodes covers at most one when it has no distinct per-episode file (rejects fan-out of a single file)', async () => {
    // 候选 801 只有一个物理文件，但其文件名恰好同时含 S02E01 与 S02E02 两个 code 子串
    // （如打包命名 "S02E01.S02E02.combo.srt"）。LLM 把同一个 candidate_id 映射到两集，
    // 两次 .includes() 各自都"匹配"到——但其实是同一个 fileIndex。这就是 dimension 警告的
    // 一集字幕串号覆盖全季：必须按 candidate_id+fileIndex 去重，同一文件只能覆盖一集。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.combo', ['Show.S02E01.S02E02.combo.srt'], '合集'),
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const covered: string[] = []
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E01', candidate_id: 'assrt:801', confidence: 0.95 },
        { episode_code: 'S02E02', candidate_id: 'assrt:801', confidence: 0.95 }, // same candidate, same file → fan-out
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_SRT), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    // Exactly one episode covered — the other rejected as a duplicate fan-out of the same file
    expect(covered.length).toBe(1)
    expect(resolveDownload).toHaveBeenCalledTimes(1)
    expect(result.decision).toBe('download')
  })

  it('season sweep: when two candidates map to the same episode, keeps the first-occurrence one (confidence-based tie-break removed — order is the model\'s own preference expression), not both', async () => {
    // 行为变化（非误删覆盖）：mapLooseEpisodes 的输出已在 Phase 4 删除 confidence 字段
    // （LooseEpisodesMapSchema），dedup 语义从"比较数字择优"改为"先出现者胜出"——数组顺序本身
    // 就是模型的偏好表达（它把更有把握的排前面），不再需要额外的置信度数字来打破平局
    // （同 seasonPackGate 的 pairs[] 去重语义，见 pipeline.ts runSeasonSweep 的 bestByCode）。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(810, 'Show.S02E03.v1', ['Show.S02E03.v1.srt'], '第3集v1'),
      mkCand(822, 'Show.S02E03.v2', ['Show.S02E03.v2.srt'], '第3集v2'),
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: true },
    ]
    const covered: { episodeCode: string; ref?: string }[] = []
    const llm = { call: vi.fn(async () => ({
      // 模型把更有把握的那个排在前面——822 先出现，应该是最终胜出者。
      parsed: { assignments: [
        { episode_code: 'S02E03', candidate_id: 'assrt:822' },
        { episode_code: 'S02E03', candidate_id: 'assrt:810' },
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_SRT), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }, _path: string, ref?: string) => { covered.push({ episodeCode: ep.episodeCode, ref }) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(covered).toEqual([{ episodeCode: 'S02E03', ref: 'assrt:822' }]) // first occurrence wins
    // The second-occurrence loser is dropped before any network I/O — no wasted resolve call
    expect(resolveDownload).toHaveBeenCalledTimes(1)
    expect(resolveDownload).toHaveBeenCalledWith(expect.objectContaining({ providerId: '822' }))
    expect(result.decision).toBe('download')
  })

  it('season sweep: MINOR-B — a higher-confidence assignment that fails structural validation must not eclipse a valid lower-confidence rival for the same episode', async () => {
    // dedup-then-validate 顺序问题：若 bestByCode 只按置信度先选（不看是否能通过结构校验），
    // 高置信度但文件名对不上的那个会被选中、随后在校验环节被跳过——而本来能通过校验的低置信度
    // 候选早就在 dedup 阶段被扔掉了，整集因此颗粒无收。修复后：先校验再按置信度择优，
    // 只在"通过校验"的候选之间比置信度。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      // Higher confidence (0.97) but its only file does NOT carry the S02E05 signal — must fail validation.
      mkCand(810, 'Show.mislabeled', ['Show.wrong.episode.file.srt'], '未知'),
      // Lower confidence (0.88) but its file DOES carry the correct S02E05 signal — must pass validation.
      mkCand(822, 'Show.S02E05.v2', ['Show.S02E05.chs.srt'], '第5集v2'),
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e5', seasonNumber: 2, episodeNumber: 5, episodeCode: 'S02E05', videoPath: join(outDir, 'Show.S02E05.mkv'), videoFilename: 'Show.S02E05.mkv', needsChinese: true },
    ]
    const covered: { episodeCode: string; ref?: string }[] = []
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E05', candidate_id: 'assrt:810', confidence: 0.97 }, // wins naive dedup-by-confidence, fails validation
        { episode_code: 'S02E05', candidate_id: 'assrt:822', confidence: 0.88 }, // would be discarded by naive dedup, but is the only valid one
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_SRT), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }, _path: string, ref?: string) => { covered.push({ episodeCode: ep.episodeCode, ref }) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    // The valid lower-confidence rival must win coverage — not zero coverage for the episode.
    expect(covered).toEqual([{ episodeCode: 'S02E05', ref: 'assrt:822' }])
    expect(resolveDownload).toHaveBeenCalledTimes(1)
    expect(resolveDownload).toHaveBeenCalledWith(expect.objectContaining({ providerId: '822' }))
    expect(result.decision).toBe('download')
  })

  it('season sweep: a resolve failure storm trips a consecutive-failure circuit breaker (budget guard alone does not bound it, since it only counted successes)', async () => {
    // OS 406/quota 抖动场景：resolveDownload 对每个 assignment 都抛错。修复前 apiCallsUsed++
    // 只在成功后才执行，budget 守卫永不触发——全季逐集都会各打一次 resolve，无视预算与失败风暴。
    // 修复后：3 次连续失败即熔断（对齐季包升格路径的 consecutiveFails>=3 语义）。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [801, 802, 803, 804, 805].map(id =>
      mkCand(id, `Show.S02E0${id - 800}.chs`, [`Show.S02E0${id - 800}.chs.srt`], `第${id - 800}集`))
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async () => { throw new Error('406 not acceptable') })
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3, 4, 5].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [1, 2, 3, 4, 5].map(n => ({ episode_code: `S02E0${n}`, candidate_id: `assrt:${800 + n}`, confidence: 0.95 })), reasons: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      maxApiCallsPerJob: 4,
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: { enumerate: vi.fn(async () => seasonEps), map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    // Circuit breaker trips after 3 consecutive failures — stops well short of all 5 assignments
    expect(resolveDownload).toHaveBeenCalledTimes(3)
    expect(result.decision).toBe('no_safe_match') // 0 coverage, falls back to gate early-return
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.steps.some((s: { name: string }) => s.name === 'seasonSweepCircuitBreak')).toBe(true)
  })

  it('season sweep: failed resolveDownload attempts still consume the per-job API call budget', async () => {
    // 预算守卫本身也要把失败尝试算进去——不能只在成功后才 apiCallsUsed++。用一个远小于熔断阈值(3)
    // 的预算(2)来隔离验证:budget 守卫必须先于熔断触发生效。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [801, 802, 803].map(id =>
      mkCand(id, `Show.S02E0${id - 800}.chs`, [`Show.S02E0${id - 800}.chs.srt`], `第${id - 800}集`))
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async () => { throw new Error('406 not acceptable') })
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [1, 2, 3].map(n => ({ episode_code: `S02E0${n}`, candidate_id: `assrt:${800 + n}`, confidence: 0.95 })), reasons: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      maxApiCallsPerJob: 2, // budget of 2 < circuit breaker threshold of 3 → budget guard must bind first
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: { enumerate: vi.fn(async () => seasonEps), map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    await runPipeline(deps, epCtx, outDir)
    expect(resolveDownload).toHaveBeenCalledTimes(2) // budget of 2, all failed attempts still counted
  })

  it('FINDING-4: season sweep — 3 consecutive verify-rejects do NOT trip the circuit breaker (later episodes still attempted)', async () => {
    // 与季包升格路径对称：provider 健康(下载+体检+终审全走通)时的内容拒绝不该计入熔断。
    // 前 3 集终审判 match:false，第 4/5 集判 true——熔断绝不能把内容拒绝计入，否则第 4/5 集
    // 永远打不到。（注：sweep 原实现在每次 resolve 成功后就把 consecutiveFails 清零，所以这条
    // 断言在修复前也成立；真正的失败先行测试是下面那条 post-resolve transient 风暴——见其注释。
    // 这条留作行为守卫，锁死"内容拒绝不熔断"这个意图。）
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    // fileList 用 .ass 扩展名——须与下面 download() 喂回的 SAMPLE_ASS 内容匹配（结构体检按
    // 扩展名选解析器，.srt 喂 ASS 内容会先被解析器判成零 cue，永远走不到终审）。
    const looseCandidates = [801, 802, 803, 804, 805].map(id =>
      mkCand(id, `Show.S02E0${id - 800}.chs`, [`Show.S02E0${id - 800}.chs.ass`], `第${id - 800}集`))
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3, 4, 5].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [1, 2, 3, 4, 5].map(n => ({ episode_code: `S02E0${n}`, candidate_id: `assrt:${800 + n}`, confidence: 0.95 })), reasons: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    // 提交顺序即 dedupedAssignments 顺序（E01..E05）：前 3 次终审判 false，第 4/5 次判 true。
    let verifyCall = 0
    const verify = vi.fn(async () => {
      verifyCall++
      return {
        parsed: verifyCall <= 3 ? { match: false, reason: 'wrong episode' } : { match: true, reason: 'ok' },
        rawText: '', retries: 0, durationMs: 1, prompt: 'verify prompt',
      }
    })
    const deps = makeDeps({
      maxApiCallsPerJob: 10,
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      verify: verify as unknown as PipelineDeps['verify'],
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: { enumerate: vi.fn(async () => seasonEps), map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(resolveDownload).toHaveBeenCalledTimes(5) // all 5 assignments attempted — breaker never tripped
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E04', 'S02E05'])
  })

  it('FINDING-4: season sweep — a post-resolve transient (download throw) storm now trips the breaker (was masked by reset-after-successful-resolve)', async () => {
    // 失败先行测试，坐实 sweep 修复的实质变化：把 consecutiveFails 的清零点从"resolve 成功后"
    // 挪到"拿到决定性内容结论后"。原实现里每次 resolve 成功就清零，导致 resolve 通了但紧接着
    // download() 抛错（限流/网络抖动的另一种表现）的风暴永远攒不满 3 次、熔断永不触发——一个
    // 只能列表却下不动文件的病态 provider 会被逐集硬打到预算耗尽。修复后：resolve 成功不再清零，
    // 连续 3 次 download 抛错即熔断。
    // 原实现（reset-after-resolve）：5 集全打、不熔断 → resolveDownload 5 次、无 circuit-break step。
    // 修复后：第 3 次后熔断 → resolveDownload 3 次、有 seasonSweepCircuitBreak step。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [801, 802, 803, 804, 805].map(id =>
      mkCand(id, `Show.S02E0${id - 800}.chs`, [`Show.S02E0${id - 800}.chs.ass`], `第${id - 800}集`))
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const download = vi.fn(async () => { throw new Error('connection reset by peer') }) // resolve 通、下载抛
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3, 4, 5].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [1, 2, 3, 4, 5].map(n => ({ episode_code: `S02E0${n}`, candidate_id: `assrt:${800 + n}`, confidence: 0.95 })), reasons: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      maxApiCallsPerJob: 10, // 预算宽松（>5），隔离验证是熔断而非预算守卫在收尾
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: download as unknown as PipelineDeps['download'],
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: { enumerate: vi.fn(async () => seasonEps), map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(resolveDownload).toHaveBeenCalledTimes(3) // 熔断在第 3 次后触发，E04/E05 不再打
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.steps.some((s: { name: string }) => s.name === 'seasonSweepCircuitBreak')).toBe(true)
  })

  it('season sweep: does NOT trigger when a whole-season pack is available (pack has priority)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = toCandidate(seasonDetail.sub.subs[0])
    const search = vi.fn(async () => ok([
      packCandidate, // whole-season pack
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass']),
    ]))
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
    const search = vi.fn(async () => ok([mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass'])]))
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

  it('season sweep: fail-soft null candidate_id row is filtered out defensively, does not crash the sweep (confidence threshold removed — agent binary judgment replaces it)', async () => {
    // 行为变化（非误删覆盖）：LooseEpisodesMapSchema 已在 Phase 4 删除 confidence 字段——判断链
    // 两态化后，"拿不准"的候选不再靠数字阈值挡在门外，而是照样进候选队列，下载进沙盒、体检、
    // agent 终审后才二选一表态（本用例默认 verify=match:true）。这里只保留仍然成立的部分：
    // candidate_id 为 null 的行必须被 fail-soft 过滤掉，不能让整个 sweep 崩掉。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass']),
      mkCand(802, 'Show.S02E02.maybe', ['Show.S02E02.ass']),
      mkCand(803, 'Show.S02E03.chs', ['Show.S02E03.chs.ass']),
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: true },
    ]
    const llm = {
      call: vi.fn(async () => ({
        parsed: { assignments: [
          { episode_code: 'S02E01', candidate_id: "assrt:801" },
          { episode_code: 'S02E02', candidate_id: "assrt:802" },
          { episode_code: 'S02E02', candidate_id: null },        // fail-soft null row → filter 剔除，不炸 sweep
          { episode_code: 'S02E03', candidate_id: "assrt:803" },
        ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
      })),
    }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: vi.fn(async () => ({
        parsed: { order: [{ candidate_id: "assrt:801", file_index: 0, identity_match: 'uncertain' as const, reason: 'loose' }], rejected: [], reasons: ['loose'] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })) as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
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
    // 三集皆覆盖：E01/E03 正常映射；E02 的合法候选(802)覆盖，null 那一行被 fail-soft 剔除、
    // 没有让 sweep 崩掉，也没有重复覆盖 E02（先出现者胜出去重）。
    expect(result.coveredEpisodes?.length).toBe(3)
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02', 'S02E03'])
    expect(resolveDownload).toHaveBeenCalledTimes(3)
  })

  it('season sweep: 裸 providerId 自愈——candidate_id 没有 provider 前缀但候选池内唯一命中时仍覆盖该集（gate 语义对齐）', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(803, 'Show.S02E01.chs', ['Show.S02E01.chs.ass']),
      mkCand(804, 'Show.S02E02.chs', ['Show.S02E02.chs.ass']),
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const covered: string[] = []
    const llm = {
      call: vi.fn(async () => ({
        parsed: { assignments: [
          { episode_code: 'S02E01', candidate_id: '803', confidence: 0.95 }, // 裸 id，模型丢了 "assrt:" 前缀
          { episode_code: 'S02E02', candidate_id: 'assrt:804', confidence: 0.95 },
        ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
      })),
    }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: vi.fn(async () => ({
        parsed: { order: [{ candidate_id: 'assrt:803', file_index: 0, identity_match: 'uncertain' as const, reason: 'loose' }], rejected: [], reasons: ['loose'] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })) as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(),
        onCovered: vi.fn(async (ep: { episodeCode: string }, _path: string, ref?: string) => { covered.push(`${ep.episodeCode}=${ref}`) }),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    // 自愈成功：裸 id 唯一命中候选池 → E01 照常覆盖，不因缺前缀被跳过
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02'])
    expect(covered.sort()).toEqual(['S02E01=assrt:803', 'S02E02=assrt:804'])
    expect(resolveDownload).toHaveBeenCalledWith(expect.objectContaining({ provider: 'assrt', providerId: '803' }))
  })

  it('season sweep: 裸 providerId 在候选池内跨 provider 碰撞（2+ 命中）→ 该集仍跳过，其余集不受影响', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates: SubtitleCandidate[] = [
      mkCand(805, 'Show.S02E01.chs', ['Show.S02E01.chs.ass']),
      {
        provider: 'opensubtitles', providerId: '805', videoName: 'Show.S02E02.chs', nativeName: null,
        language: null, subtype: null, releaseSite: null, uploadDate: null,
        fileList: [{ index: 0, name: 'Show.S02E02.chs.srt' }],
      },
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const llm = {
      call: vi.fn(async () => ({
        parsed: { assignments: [
          { episode_code: 'S02E01', candidate_id: 'assrt:805', confidence: 0.95 }, // 全key，不受影响
          { episode_code: 'S02E02', candidate_id: '805', confidence: 0.95 },       // 裸 id，跨 provider 碰撞（assrt:805 与 opensubtitles:805）
        ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
      })),
    }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: vi.fn(async () => ({
        parsed: { order: [{ candidate_id: 'assrt:805', file_index: 0, identity_match: 'uncertain' as const, reason: 'loose' }], rejected: [], reasons: ['loose'] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      })) as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
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
    // 碰撞集 fail-safe 跳过（不覆盖），非碰撞集照常覆盖
    expect(result.coveredEpisodes?.map(c => c.episodeCode)).toEqual(['S02E01'])
    expect(resolveDownload).toHaveBeenCalledTimes(1)
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
      .mockResolvedValueOnce(ok(firstRound)) // main port call (both queries in one)
      .mockResolvedValueOnce(ok(aliasRound)) // alias-harvest re-search
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn()
      .mockResolvedValueOnce({ parsed: { order: [], rejected: [], reasons: ['no english match'] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
      .mockResolvedValueOnce({ parsed: { order: [{ candidate_id: "assrt:901", file_index: 0, identity_match: 'uncertain' as const, reason: 'alias match' }], rejected: [], reasons: ['alias match'] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
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
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
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
    const search = vi.fn(async () => ok(looseCandidates))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['no exact single-episode match for the representative episode'] },
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
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
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
    const search = vi.fn(async () => ok(looseCandidates))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['no safe match'] },
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

  it('IMPORTANT-1a: season sweep quota death mid-run after 1 covered episode → partial coverage + quotaExhausted preserved, no further resolve attempts', async () => {
    // 修复前：per-episode catch 吞掉 ProviderQuotaExhaustedError，继续（或熔断阈值内）尝试剩余集，
    // 且最终 finish('download', {coveredEpisodes}) 从不携带 quotaExhausted——executor 就会把这当
    // 普通 partial 走 30s 节流，配额重置前反复重打全链路。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [801, 802, 803, 804].map(id =>
      mkCand(id, `Show.S02E0${id - 800}.chs`, [`Show.S02E0${id - 800}.chs.ass`], `第${id - 800}集`))
    const search = vi.fn(async () => ok(looseCandidates))
    const resetAt = '2026-07-13T00:00:00.000Z'
    const resolveDownload = vi.fn()
      .mockResolvedValueOnce({ url: 'http://dl/801' })
      .mockRejectedValue(new ProviderQuotaExhaustedError('quota exhausted', resetAt))
    const rank = vi.fn(async () => ({
      parsed: { order: [{ candidate_id: 'assrt:801', file_index: 0, identity_match: 'uncertain' as const, reason: 'loose' }], rejected: [], reasons: ['loose'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3, 4].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [1, 2, 3, 4].map(n => ({ episode_code: `S02E0${n}`, candidate_id: `assrt:${800 + n}`, confidence: 0.95 })), reasons: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: { enumerate: vi.fn(async () => seasonEps), map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode)).toEqual(['S02E01'])
    expect(result.quotaExhausted).toEqual({ resetAt })
    // 1 次成功 + 1 次撞配额，随即停手——不再为 803/804 打注定失败的 resolve
    expect(resolveDownload).toHaveBeenCalledTimes(2)
  })

  it('IMPORTANT-1b: pre-gate sweep quota death before any coverage → error decision carrying quotaExhausted, never falls through to gate negative-cache', async () => {
    // 修复前：0 覆盖落回 gate 早退，rank 仍是 no_safe_match → 写 1 天负缓存，resetAt 丢失。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const looseCandidates = [
      mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass'], '第1集'),
      mkCand(802, 'Show.S02E02.chs', ['Show.S02E02.chs.ass'], '第2集'),
    ]
    const search = vi.fn(async () => ok(looseCandidates))
    const resetAt = '2026-07-13T00:00:00.000Z'
    const resolveDownload = vi.fn(async () => { throw new ProviderQuotaExhaustedError('quota exhausted', resetAt) })
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['no safe match'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E01', candidate_id: 'assrt:801', confidence: 0.95 },
        { episode_code: 'S02E02', candidate_id: 'assrt:802', confidence: 0.95 },
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const putSpy = vi.spyOn(cache, 'put')
    const deps = makeDeps({
      cache,
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: { enumerate: vi.fn(async () => seasonEps), map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('error')
    expect(result.quotaExhausted).toEqual({ resetAt })
    // 撞到第一次配额就停手，不为 802 打第二次注定失败的 resolve
    expect(resolveDownload).toHaveBeenCalledTimes(1)
    expect(putSpy).not.toHaveBeenCalled() // 绝不负缓存
  })

  it('season sweep: mixed-provider winners — OS quota exhaustion skips only OS-backed episodes, ASSRT-backed episodes still resolve and cover this run', async () => {
    // Sweep winners can come from DIFFERENT providers (SubtitleCandidate.provider). A quota error on
    // ONE provider (opensubtitles here) must not abandon episodes whose winning candidate is a
    // different, healthy provider (assrt) — those would succeed right now. Pre-fix: the loop broke
    // unconditionally on the first quota error regardless of which provider threw it, parking
    // healthy-provider coverage until the OS daily reset for no reason.
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const osCand1: SubtitleCandidate = {
      provider: 'opensubtitles', providerId: '901', videoName: 'Show.S02E01.chs', nativeName: null,
      language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [],
    }
    const osCand4: SubtitleCandidate = {
      provider: 'opensubtitles', providerId: '904', videoName: 'Show.S02E04.chs', nativeName: null,
      language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [],
    }
    const assrtCand2 = mkCand(902, 'Show.S02E02.chs', ['Show.S02E02.chs.ass'])
    const assrtCand3 = mkCand(903, 'Show.S02E03.chs', ['Show.S02E03.chs.ass'])
    const search = vi.fn(async () => ok([osCand1, assrtCand2, assrtCand3, osCand4]))
    const resetAt = '2026-07-13T00:00:00.000Z'
    const resolveDownload = vi.fn(async (ref: { provider: string; providerId: string }) => {
      if (ref.provider === 'opensubtitles') throw new ProviderQuotaExhaustedError('quota exhausted', resetAt)
      return { url: `http://dl/${ref.providerId}` }
    })
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['no safe match'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3, 4].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [
        { episode_code: 'S02E01', candidate_id: 'opensubtitles:901', confidence: 0.95 },
        { episode_code: 'S02E02', candidate_id: 'assrt:902', confidence: 0.95 },
        { episode_code: 'S02E03', candidate_id: 'assrt:903', confidence: 0.95 },
        { episode_code: 'S02E04', candidate_id: 'opensubtitles:904', confidence: 0.95 },
      ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: { enumerate: vi.fn(async () => seasonEps), map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国' // CJK-native → alias harvest skipped, isolate the sweep path
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    // ASSRT-backed episodes still covered this run — they're healthy, no reason to wait for the OS reset.
    expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E02', 'S02E03'])
    // quotaExhausted still attached even though other-provider resolves succeeded afterward — the
    // remaining gap (S02E01, S02E04) is OS-winner episodes that must wait for resetAt, same as the
    // executor's existing resetAt-based scheduling for a plain partial+quotaExhausted result.
    expect(result.quotaExhausted).toEqual({ resetAt })
    // 1 failed OS attempt (S02E01) + 2 successful ASSRT attempts (S02E02/03) = 3. The second OS
    // assignment (S02E04) must be skipped once OS is known exhausted — never a 4th doomed resolve call.
    expect(resolveDownload).toHaveBeenCalledTimes(3)
  })

  it('season sweep: all-OS-provider winners — quota exhaustion still stops remaining resolves and preserves partial coverage (single-provider behavior unchanged)', async () => {
    // Regression guard: when every sweep winner shares the SAME (now-exhausted) provider, there is no
    // healthy alternative to keep resolving — behavior must match the pre-fix single-provider case
    // exactly (stop immediately, never attempt the remaining same-provider episodes).
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const osCands: SubtitleCandidate[] = [1, 2, 3, 4].map(n => ({
      provider: 'opensubtitles', providerId: String(900 + n),
      videoName: `Show.S02E0${n}.chs`, nativeName: null,
      language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [],
    }))
    const search = vi.fn(async () => ok(osCands))
    const resetAt = '2026-07-13T00:00:00.000Z'
    const resolveDownload = vi.fn()
      .mockResolvedValueOnce({ url: 'http://dl/901' })
      .mockRejectedValue(new ProviderQuotaExhaustedError('quota exhausted', resetAt))
    const rank = vi.fn(async () => ({
      parsed: { order: [], rejected: [], reasons: ['no safe match'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3, 4].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    const llm = { call: vi.fn(async () => ({
      parsed: { assignments: [1, 2, 3, 4].map(n => ({ episode_code: `S02E0${n}`, candidate_id: `opensubtitles:${900 + n}`, confidence: 0.95 })), reasons: [] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
    })) }
    const deps = makeDeps({
      providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_SRT), contentType: 'text/plain' })),
      llm: llm as unknown as PipelineDeps['llm'],
      seasonPack: { enumerate: vi.fn(async () => seasonEps), map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = structuredClone(ctx)
    epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
    epCtx.media.title = '黑客帝国'
    epCtx.media.alternative_titles = []
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode)).toEqual(['S02E01'])
    expect(result.quotaExhausted).toEqual({ resetAt })
    expect(resolveDownload).toHaveBeenCalledTimes(2)
  })

  it('IMPORTANT-1a: season pack quota death mid-run after 1 covered episode → partial coverage + quotaExhausted preserved, no further resolve attempts', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = toCandidate(seasonDetail.sub.subs[0])
    const resetAt = '2026-07-13T00:00:00.000Z'
    const resolveDownload = vi.fn(async (ref: { fileIndex: number | null }) => {
      if (ref.fileIndex === 0) return { url: 'http://file0.assrt.net/pack/900900/1' }
      throw new ProviderQuotaExhaustedError('quota exhausted', resetAt)
    })
    const rank = vi.fn(async () => ({
      parsed: { order: [{ candidate_id: 'assrt:900900', file_index: 0, identity_match: 'uncertain' as const, reason: 'pack' }], rejected: [], reasons: ['pack'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: true },
    ]
    const deps = makeDeps({
      providers: makeProviders({ search: vi.fn(async () => ok([packCandidate])), resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(async () => ({
          parsed: { pairs: [
            { filelist_index: 0, episode_code: 'S02E01', confidence: 0.95, reason: 'x' },
            { filelist_index: 1, episode_code: 'S02E02', confidence: 0.95, reason: 'x' },
            { filelist_index: 2, episode_code: 'S02E03', confidence: 0.95, reason: 'x' },
          ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
        })),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode)).toEqual(['S02E01'])
    expect(result.quotaExhausted).toEqual({ resetAt })
    // 1 次成功 + 1 次撞配额，随即停手——不再为 E03 打注定失败的 resolve
    expect(resolveDownload).toHaveBeenCalledTimes(2)
  })

  it('IMPORTANT-1b: season pack quota death before any coverage → error decision carrying quotaExhausted, not falling back to the single-episode path', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = toCandidate(seasonDetail.sub.subs[0])
    const resetAt = '2026-07-13T00:00:00.000Z'
    const resolveDownload = vi.fn(async () => { throw new ProviderQuotaExhaustedError('quota exhausted', resetAt) })
    const rank = vi.fn(async () => ({
      parsed: { order: [{ candidate_id: 'assrt:900900', file_index: 0, identity_match: 'uncertain' as const, reason: 'pack' }], rejected: [], reasons: ['pack'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [
      { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
      { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    ]
    const deps = makeDeps({
      providers: makeProviders({ search: vi.fn(async () => ok([packCandidate])), resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(async () => ({
          parsed: { pairs: [
            { filelist_index: 0, episode_code: 'S02E01', confidence: 0.95, reason: 'x' },
            { filelist_index: 1, episode_code: 'S02E02', confidence: 0.95, reason: 'x' },
          ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
        })),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(result.decision).toBe('error')
    expect(result.quotaExhausted).toEqual({ resetAt })
    // 撞到第一次配额就停手，绝不落回单集路径再打一次注定失败的 resolve
    expect(resolveDownload).toHaveBeenCalledTimes(1)
  })

  it('FINDING-4: season pack — 3 consecutive verify-rejects do NOT trip the circuit breaker (later episodes still attempted)', async () => {
    // provider 健康：每一集都真下载+体检+终审过，终审对前 3 集判 match:false（决定性内容拒绝）。
    // 旧行为把内容拒绝和瞬时故障一样计入 consecutiveFails，3 次即熔断——第 4/5 集永远打不到，
    // 即便它们本可以正常覆盖。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = mkCand(900900, 'Show.S02', [
      'Show.S02E01.chs.ass', 'Show.S02E02.chs.ass', 'Show.S02E03.chs.ass', 'Show.S02E04.chs.ass', 'Show.S02E05.chs.ass',
    ])
    const resolveDownload = vi.fn(async (ref: { fileIndex: number | null }) => ({
      url: `http://file0.assrt.net/pack/900900/${(ref.fileIndex ?? 0) + 1}`,
    }))
    const rank = vi.fn(async () => ({
      parsed: { order: [{ candidate_id: 'assrt:900900', file_index: 0, identity_match: 'uncertain' as const, reason: 'pack' }], rejected: [], reasons: ['pack'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3, 4, 5].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    // 提交顺序即 pairs[] 顺序（E01..E05）：前 3 次终审判 false，第 4/5 次判 true。
    let verifyCall = 0
    const verify = vi.fn(async () => {
      verifyCall++
      return {
        parsed: verifyCall <= 3 ? { match: false, reason: 'wrong episode' } : { match: true, reason: 'ok' },
        rawText: '', retries: 0, durationMs: 1, prompt: 'verify prompt',
      }
    })
    const deps = makeDeps({
      maxApiCallsPerJob: 10,
      providers: makeProviders({ search: vi.fn(async () => ok([packCandidate])), resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      verify: verify as unknown as PipelineDeps['verify'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(async () => ({
          parsed: { pairs: [
            { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
            { filelist_index: 1, episode_code: 'S02E02', reason: 'x' },
            { filelist_index: 2, episode_code: 'S02E03', reason: 'x' },
            { filelist_index: 3, episode_code: 'S02E04', reason: 'x' },
            { filelist_index: 4, episode_code: 'S02E05', reason: 'x' },
          ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
        })),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    // 全部 5 集都被尝试——若熔断误把内容拒绝计入，会在攒够 3 次拒绝后（E03）停手，E04/E05 永远打不到。
    expect(resolveDownload).toHaveBeenCalledTimes(5)
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.map(c => c.episodeCode)).toEqual(['S02E04', 'S02E05'])
  })

  it('FINDING-4: season pack — 3 consecutive transient (resolve/download) failures DO trip the circuit breaker', async () => {
    // 对照组：resolveDownload 每次都抛（非配额）异常——provider 真没打通，这才是熔断器该防的
    // 场景。3 次连续失败即停手，落回单集路径（同样打不通）→ retry_later，绝不写负缓存。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = mkCand(900900, 'Show.S02', [
      'Show.S02E01.chs.ass', 'Show.S02E02.chs.ass', 'Show.S02E03.chs.ass', 'Show.S02E04.chs.ass', 'Show.S02E05.chs.ass',
    ])
    const resolveDownload = vi.fn(async () => { throw new Error('406 not acceptable') })
    const rank = vi.fn(async () => ({
      parsed: { order: [{ candidate_id: 'assrt:900900', file_index: 0, identity_match: 'uncertain' as const, reason: 'pack' }], rejected: [], reasons: ['pack'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3, 4, 5].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    const deps = makeDeps({
      maxApiCallsPerJob: 10,
      cache,
      providers: makeProviders({ search: vi.fn(async () => ok([packCandidate])), resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(async () => ({
          parsed: { pairs: [
            { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
            { filelist_index: 1, episode_code: 'S02E02', reason: 'x' },
            { filelist_index: 2, episode_code: 'S02E03', reason: 'x' },
            { filelist_index: 3, episode_code: 'S02E04', reason: 'x' },
            { filelist_index: 4, episode_code: 'S02E05', reason: 'x' },
          ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
        })),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    // 3 次熔断 + 落回单集路径再打一次（同样失败）= 4 次总调用；不再往下打 E04/E05。
    expect(resolveDownload).toHaveBeenCalledTimes(4)
    expect(result.decision).toBe('retry_later')
    // identify mock 保留默认返回值（season/episode: null）——cacheKeys 据此产出 "S-:E-"（同其它
    // 未覆写 identify 的季包测试），不是 epCtx.media 上手写的 season/episode。
    expect(cache.get('id:imdb:tt0133093:S-:E-')).toBeFalsy()
  })

  it('FINDING-2: season pack graduation loop is bounded by maxApiCallsPerJob (not just episode count)', async () => {
    // 与队列试错/季横扫对齐：季包升格逐集 resolve 也要受同一份预算约束，而不是只靠
    // seasonEpisodes 数量天然收尾——季很长时（数十集）无预算约束会无视预算打穿。
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const packCandidate = mkCand(900900, 'Show.S02', [
      'Show.S02E01.chs.ass', 'Show.S02E02.chs.ass', 'Show.S02E03.chs.ass', 'Show.S02E04.chs.ass', 'Show.S02E05.chs.ass',
    ])
    const resolveDownload = vi.fn(async (ref: { fileIndex: number | null }) => ({
      url: `http://file0.assrt.net/pack/900900/${(ref.fileIndex ?? 0) + 1}`,
    }))
    const rank = vi.fn(async () => ({
      parsed: { order: [{ candidate_id: 'assrt:900900', file_index: 0, identity_match: 'uncertain' as const, reason: 'pack' }], rejected: [], reasons: ['pack'] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    }))
    const seasonEps = [1, 2, 3, 4, 5].map(n => ({
      itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E0${n}`,
      videoPath: join(outDir, `Show.S02E0${n}.mkv`), videoFilename: `Show.S02E0${n}.mkv`, needsChinese: true,
    }))
    const deps = makeDeps({
      maxApiCallsPerJob: 2, // 预算 2 < 5 个待覆盖集，也远小于熔断阈值 3——预算守卫必须先生效
      providers: makeProviders({ search: vi.fn(async () => ok([packCandidate])), resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
      rank: rank as unknown as PipelineDeps['rank'],
      download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
      verify: makeVerify({ match: true, reason: 'ok' }),
      seasonPack: {
        enumerate: vi.fn(async () => seasonEps),
        map: vi.fn(async () => ({
          parsed: { pairs: [
            { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
            { filelist_index: 1, episode_code: 'S02E02', reason: 'x' },
            { filelist_index: 2, episode_code: 'S02E03', reason: 'x' },
            { filelist_index: 3, episode_code: 'S02E04', reason: 'x' },
            { filelist_index: 4, episode_code: 'S02E05', reason: 'x' },
          ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
        })),
        onCovered: vi.fn(),
      } as unknown as PipelineDeps['seasonPack'],
    })
    const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
    const result = await runPipeline(deps, epCtx, outDir)
    expect(resolveDownload).toHaveBeenCalledTimes(2) // 预算耗尽即停手，不打完全部 5 集
    expect(result.decision).toBe('download')
    expect(result.coveredEpisodes?.length).toBe(2)
  })

  it('M-1: alias harvest merges fresh into the sweep pool; second-round rank input stays fresh-only', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    // 首轮候选覆盖 E01（CJK nativeName 触发别名收割）；别名搜索带回 fresh 覆盖 E02
    const firstRound = [mkCand(700, '流浪剧.S02E01', ['Show.S02E01.chs.srt'], '流浪剧 第1集')]
    const aliasRound = [mkCand(902, '流浪剧.S02E02', ['Show.S02E02.chs.ass'], '流浪剧 第2集')]
    const search = vi.fn().mockResolvedValueOnce(ok(firstRound)).mockResolvedValueOnce(ok(aliasRound))
    const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
    const rank = vi.fn()
      .mockResolvedValueOnce({ parsed: { order: [], rejected: [], reasons: ['no english match'] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
      .mockResolvedValueOnce({ parsed: { order: [{ candidate_id: "assrt:902", file_index: 0, identity_match: 'uncertain' as const, reason: 'alias match' }], rejected: [], reasons: ['alias match'] }, rawText: '', retries: 0, durationMs: 1, prompt: 'r' })
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
      // 700 的 fileList 是 .srt，902 的是 .ass——按 URL（携带 providerId）分别喂回匹配扩展名的
      // 真实内容，否则任一方会被结构体检当错误格式拒收（SAMPLE_ASS 喂进 .srt 解析器解不出 cue）。
      download: vi.fn(async (url: string) => ({
        bytes: Buffer.from(url.includes('/700') ? SAMPLE_SRT : SAMPLE_ASS), contentType: 'text/plain',
      })),
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

  describe('addendum B: NFC/NFD-normalized already-exists probing (Synology SMB hazard)', () => {
    it('pre-flight check finds an NFD-encoded on-disk file for an NFC-normalized predicted name', async () => {
      // 群晖等 SMB 存储可能把文件名按 NFD 落盘（macOS 客户端惯例）；预测文件名（来自 ctx.media.filename，
      // 这里刻意含重音字符）是 NFC 形式。若只归一化预测侧、不归一化磁盘侧，existsSync(NFC 路径) 会
      // 找不到磁盘上视觉上完全相同、字节上是 NFD 的文件——误判"不存在"，白白重下一次。
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const testCtx = structuredClone(ctx)
      // NFC 预组合的 é（é，单个码点）——与下面磁盘上的 NFD 拼写视觉相同、字节不同。
      testCtx.media.filename = 'Caf\u00E9.1999.mkv' // NFC precomposed \u00E9, explicit escape (avoid tool-chain re-normalization ambiguity)
      // NFD 分解形式：ASCII 'e' + U+0301 COMBINING ACUTE ACCENT（两个码点）。
      const nfdName = 'Cafe' + '\u0301' + '.1999.zh-Hans.ass' // NFD: ASCII 'e' + U+0301 COMBINING ACUTE ACCENT
      const preexistingPath = join(outDir, nfdName)
      writeFileSync(preexistingPath, '[Script Info]\nTitle: already on disk (NFD name)\n')
      const deps = makeDeps()
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('already_exists')
      expect(result.subtitlePath).toBe(preexistingPath) // 磁盘上的真实（NFD）路径原样返回，不强行改写
      expect(deps.providers.resolveDownload).not.toHaveBeenCalled()
      expect(deps.download).not.toHaveBeenCalled()
    })

    it('post-download install-time check finds an NFD-encoded on-disk file too (not just the pre-flight static-filename path)', async () => {
      // 与上一条对称：候选静态元数据无法预判文件名（预检必然 miss）时，唯一的探测点是下载+体检+
      // 终审通过之后、install() 之前。同样必须双向 NFC 归一，否则会覆盖掉磁盘上已存在的 NFD 文件。
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const testCtx = structuredClone(ctx)
      testCtx.media.filename = 'Caf\u00E9.1999.mkv' // NFC precomposed \u00E9, explicit escape (avoid tool-chain re-normalization ambiguity)
      const nfdName = 'Cafe' + '\u0301' + '.1999.zh-Hans.ass' // NFD: ASCII 'e' + U+0301 COMBINING ACUTE ACCENT
      const preexistingPath = join(outDir, nfdName)
      writeFileSync(preexistingPath, '[Script Info]\nTitle: already on disk (NFD name)\n')
      // fileList 名字与 resolveDownload 返回的 filename 不同（不可预判）——逼预检 miss，只能靠
      // 下载后的 install-time 探测发现已存在。
      const search = vi.fn(async () => ok([mkCand(900, 'Show', ['unrelated-name.txt'])]))
      const deps = makeDeps({
        providers: makeProviders({
          search,
          resolveDownload: vi.fn(async () => ({ url: 'http://file0.assrt.net/x.ass', filename: 'real-name.ass' })),
        }),
        rank: vi.fn(async () => ({
          parsed: { order: [{ candidate_id: 'assrt:900', file_index: 0, identity_match: 'uncertain' as const, reason: 'x' }], rejected: [], reasons: ['x'] },
          rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
        })),
      })
      const result = await runPipeline(deps, testCtx, outDir)
      expect(result.decision).toBe('already_exists')
      expect(result.subtitlePath).toBe(preexistingPath)
      expect(deps.providers.resolveDownload).toHaveBeenCalledTimes(1) // 预检 miss，仍会真的 resolve 一次
    })
  })

  describe('addendum C: season pack / season sweep route downloads through stage→inspect→verify→install too', () => {
    it('season pack: one mapped episode fails structural inspection (HTML error page) — that episode is skipped, the other episode still covers normally, no crash', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const packCandidate = toCandidate(seasonDetail.sub.subs[0])
      const resolveDownload = vi.fn(async (ref: { fileIndex: number | null }) => ({
        url: `http://file0.assrt.net/pack/900900/${(ref.fileIndex ?? 0) + 1}`,
      }))
      const rank = vi.fn(async () => ({
        parsed: { order: [{ candidate_id: 'assrt:900900', file_index: 0, identity_match: 'uncertain' as const, reason: 'pack' }], rejected: [], reasons: ['pack'] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      }))
      const seasonEps = [
        { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
        { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      ]
      // fileIndex 0 (E01) downloads a real subtitle; fileIndex 1 (E02) downloads an HTML error page
      // (structural reject — never reaches verify).
      const download = vi.fn(async (url: string) => ({
        bytes: Buffer.from(url.endsWith('/2') ? '<!DOCTYPE html><html><body>404</body></html>' : SAMPLE_ASS),
        contentType: 'text/plain',
      }))
      const covered: string[] = []
      const verify = makeVerify({ match: true, reason: 'looks right' })
      const deps = makeDeps({
        providers: makeProviders({ search: vi.fn(async () => ok([packCandidate])), resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
        rank: rank as unknown as PipelineDeps['rank'],
        download,
        verify,
        seasonPack: {
          enumerate: vi.fn(async () => seasonEps),
          map: vi.fn(async () => ({
            parsed: { pairs: [
              { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
              { filelist_index: 1, episode_code: 'S02E02', reason: 'x' },
            ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
          })),
          onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
        } as unknown as PipelineDeps['seasonPack'],
      })
      const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
      const result = await runPipeline(deps, epCtx, outDir)
      expect(result.decision).toBe('download')
      expect(covered).toEqual(['S02E01']) // E02 structurally rejected, never covered
      expect(result.coveredEpisodes?.map(c => c.episodeCode)).toEqual(['S02E01'])
      // verify only called once — E02's HTML page never reaches the LLM terminal review
      expect(verify).toHaveBeenCalledTimes(1)
      expect(existsSync(join(outDir, 'Show.S02E01.zh-Hans.ass'))).toBe(true)
      expect(existsSync(join(outDir, 'Show.S02E02.zh-Hans.ass'))).toBe(false)
    })

    it('season sweep: agent verify rejects one episode\'s downloaded content — that episode is skipped, the rest still cover normally', async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'out-'))
      const looseCandidates = [
        mkCand(801, 'Show.S02E01.chs', ['Show.S02E01.chs.ass'], '第1集'),
        mkCand(802, 'Show.S02E02.chs', ['Show.S02E02.chs.ass'], '第2集'),
      ]
      const search = vi.fn(async () => ok(looseCandidates))
      const resolveDownload = vi.fn(async (ref: { providerId: string }) => ({ url: `http://dl/${ref.providerId}` }))
      const rank = vi.fn(async () => ({
        parsed: { order: [], rejected: [], reasons: ['rep episode not matched'] },
        rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
      }))
      const seasonEps = [
        { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
        { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
      ]
      const covered: string[] = []
      const llm = { call: vi.fn(async () => ({
        parsed: { assignments: [
          { episode_code: 'S02E01', candidate_id: 'assrt:801' },
          { episode_code: 'S02E02', candidate_id: 'assrt:802' },
        ], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'sweep prompt',
      })) }
      // agent 终审对 802 的下载内容判 match:false（第二次调用起拒收；第一次即 801 放行）
      let verifyCall = 0
      const verify = vi.fn(async () => {
        verifyCall++
        return { parsed: verifyCall === 1 ? { match: true, reason: 'ok' } : { match: false, reason: 'wrong show' }, rawText: '', retries: 0, durationMs: 1, prompt: 'verify prompt' }
      })
      const deps = makeDeps({
        providers: makeProviders({ search, resolveDownload: resolveDownload as unknown as ProviderPort['resolveDownload'] }),
        rank: rank as unknown as PipelineDeps['rank'],
        download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
        verify: verify as unknown as PipelineDeps['verify'],
        llm: llm as unknown as PipelineDeps['llm'],
        seasonPack: {
          enumerate: vi.fn(async () => seasonEps),
          map: vi.fn(),
          onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
        } as unknown as PipelineDeps['seasonPack'],
      })
      const epCtx = structuredClone(ctx)
      epCtx.media = { ...epCtx.media, type: 'episode', season: 2, episode: 1 }
      epCtx.media.title = '黑客帝国'
      epCtx.media.alternative_titles = []
      const result = await runPipeline(deps, epCtx, outDir)
      expect(result.decision).toBe('download')
      expect(covered).toEqual(['S02E01']) // 802 被终审拒收，未覆盖
      expect(verify).toHaveBeenCalledTimes(2)
      expect(existsSync(join(outDir, 'Show.S02E01.zh-Hans.ass'))).toBe(true)
      expect(existsSync(join(outDir, 'Show.S02E02.zh-Hans.ass'))).toBe(false)
    })
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

  it('adoption already_exists returns early without plan/provider calls, and carries the real path (IMPORTANT-3)', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'media-'))
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    // Pre-create the conforming-named subtitle in outDir
    const preexistingPath = join(outDir, 'The.Matrix.1999.1080p.BluRay.x264.zh-Hans.ass')
    writeFileSync(preexistingPath, '[Script Info]\nTitle: already there\n')
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
    // IMPORTANT-3: the other two already_exists sites carry the real path; this one must too —
    // downstream persistence (coverPath = subtitlePath) would otherwise silently persist NULL here.
    expect(result.subtitlePath).toBe(preexistingPath)
    // MINOR-A: nothing was downloaded this run (adoption was skipped) — verification must say so.
    const journal = JSON.parse(readFileSync(result.journalPath, 'utf8'))
    expect(journal.decision.verification).toEqual({ downloaded: false, path: preexistingPath, bytes: null, encoding: null })
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
    expect(result.stats.llmCalls).toBe(4) // identify, plan, rank, verify（新增一轮终审）
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
        order: [], rejected: [], reasons: ['no match among candidates'],
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
        .mockResolvedValueOnce(ok(firstRoundCands)) // main port call (both queries)
        .mockResolvedValueOnce(ok(aliasRoundCands)) // alias search
      const mockLlm = mockHarvestLlm()
      const rank = vi.fn()
        .mockResolvedValueOnce(noSafeMatchRank) // first pass rejects
        .mockResolvedValueOnce({               // second pass on fresh candidates only
          parsed: {
            order: [{ candidate_id: "assrt:3", file_index: 0, identity_match: 'uncertain' as const, reason: 'season pack under Chinese alias' }], rejected: [], reasons: ['season pack under Chinese alias'],
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
        // winning candidate resolves to a .srt filename — default makeDeps() download mock is
        // ASS-formatted (SAMPLE_ASS) and would fail structural inspection under a .srt parser.
        download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_SRT), contentType: 'text/plain' })),
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
      const search = vi.fn(async () => ok(matrixCandidates))
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
      const search = vi.fn(async () => ok(firstRoundCands))
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
      const search = vi.fn(async () => ok(firstRoundCands))
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
