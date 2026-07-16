import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import type { FetchAdapter } from '../cli/fetchLib.js'
import type { CandidateRef } from '../core/schemas.js'
import { makeDownloadCandidateTool, makeInstallSubtitleTool, makeCheckEpisodeCodeSafetyTool } from './findSubtitleWorker.tools.js'
import type { InspectSignals } from '../files/subtitleInspect.js'

interface DownloadCandidateOutput {
  stagedFileId: string
  bytes: number
  encoding: string | null
  signals: InspectSignals
}

interface InstallSubtitleOutput {
  path: string | null
}

let sandboxDir: string
beforeEach(() => { sandboxDir = mkdtempSync(join(tmpdir(), 'scout-find-subtitle-tools-')) })
afterEach(() => { rmSync(sandboxDir, { recursive: true, force: true }) })

function fakeAdapter(url: string): FetchAdapter {
  return {
    name: 'assrt',
    enabled: () => true,
    search: async () => [],
    resolve: async () => ({ url, filename: 'Show.S01E01.srt' }),
  }
}

/** Adapter that records the exact CandidateRef runResolve hands it — used to prove download_candidate
 *  reconstructs a BARE providerId (the value the assrt adapter's `Number(ref.providerId)` needs) from
 *  the COMPOSITE `id` the agent actually sees (candidateKey → "assrt:667241"). */
function capturingAdapter(name: string, url: string, sink: { ref?: CandidateRef }): FetchAdapter {
  return {
    name,
    enabled: () => true,
    search: async () => [],
    resolve: async (ref) => {
      sink.ref = ref
      return { url, filename: 'Show.S01E01.srt' }
    },
  }
}

describe('download_candidate tool', () => {
  it('resolves, downloads, stages, and inspects — returns a stagedFileId + signals, does not install', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from(
      '1\n00:00:01,000 --> 00:00:02,000\nhello\n',
    )))
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      targetFilenames: ['Show.S01E01.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    ) as DownloadCandidateOutput
    expect(out.stagedFileId).toBeTruthy()
    expect(out.signals.cueCount).toBe(1)
    expect(out.signals.decodable).toBe(true)
  })

  // Tool-visibility (not a gate): download_candidate's inputSchema has a `fileIndex` param but its
  // description never explained what it is for — the model saw a bare `number|null` with no clue it
  // is how you pull ONE episode's file out of a season pack / collection's filelist. The description
  // is what the model reads, so the fileIndex workflow must be spelled out there.
  it('description explains fileIndex for picking one file out of a pack/collection filelist', () => {
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      targetFilenames: ['Show.S01E01.mkv'],
    })
    expect(tool_.description).toMatch(/fileIndex/)
    expect(tool_.description).toMatch(/pack|collection|filelist|file list/i)
  })

  // Task 5 (R-5): the worker now claims targets one at a time via `videoFilename`, and can pick an
  // entry out of a downloaded zip via `archiveEntryName` — the description is what the model reads,
  // so both new params must be spelled out there, including how they differ from fileIndex.
  it('description explains videoFilename for claiming a target and archiveEntryName for picking a zip entry', () => {
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      targetFilenames: ['Show.S01E01.mkv'],
    })
    expect(tool_.description).toMatch(/videoFilename/)
    expect(tool_.description).toMatch(/archiveEntryName/)
  })

  // BUG 1 (id format mismatch): the ONLY candidate identifier the agent ever sees is candidateKey(c)
  // = the COMPOSITE "provider:providerId" ("assrt:667241") surfaced as `id` by search_source /
  // list_candidates / get_candidate. The real model dutifully passes that whole composite back. The
  // assrt adapter's resolve then does Number(ref.providerId) — Number("assrt:667241") is NaN and the
  // download fails every time. download_candidate must accept the composite `candidateId` and split it
  // back into {provider, providerId} so the CandidateRef reaching runResolve carries a BARE providerId.
  it('accepts the composite candidateKey id the agent sees and resolves it to a bare providerId + matching provider', async () => {
    const sink: { ref?: CandidateRef } = {}
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')))
    const tool_ = makeDownloadCandidateTool({
      adapters: [capturingAdapter('assrt', 'http://file0.assrt.net/x.srt', sink)],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      targetFilenames: ['Show.S01E01.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await tool_.execute!(
      { candidateId: 'assrt:667241', fileIndex: 10, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(sink.ref).toEqual({ provider: 'assrt', providerId: '667241', fileIndex: 10 })
  })

  it('parses the provider out of the composite id (not hardcoded assrt) so non-assrt candidates resolve too', async () => {
    const sink: { ref?: CandidateRef } = {}
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')))
    const tool_ = makeDownloadCandidateTool({
      adapters: [capturingAdapter('zimuku', 'http://file0.zimuku.net/x.srt', sink)],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      targetFilenames: ['Show.S01E01.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await tool_.execute!(
      { candidateId: 'zimuku:z-501', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(sink.ref).toEqual({ provider: 'zimuku', providerId: 'z-501', fileIndex: null })
  })

  it('returns a structured error (does not throw) for a malformed candidate id', async () => {
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      targetFilenames: ['Show.S01E01.mkv'],
    })
    const out = await tool_.execute!(
      { candidateId: 'not-a-real-key', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toHaveProperty('error')
    expect((out as { error: string }).error).toMatch(/candidate id/i)
  })

  // BUG 2 (coercion): the real model serializes numeric args as STRINGS ("10", and even "None"/"null"
  // for a null). The old `fileIndex: z.number().int().nullable()` rejected "10" outright, so tool-arg
  // validation failed before execute ever ran. The schema must tolerate string-encoded numbers and the
  // string sentinels the model emits for null.
  it('fileIndex schema coerces string-encoded numbers and string null-sentinels', () => {
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      targetFilenames: ['Show.S01E01.mkv'],
    })
    const schema = tool_.inputSchema as import('zod').ZodType
    const idx = (v: unknown) => (schema.parse({ candidateId: 'assrt:1', fileIndex: v }) as { fileIndex: number | null }).fileIndex
    expect(idx(10)).toBe(10)
    expect(idx('10')).toBe(10)
    expect(idx(null)).toBeNull()
    expect(idx('None')).toBeNull()
    expect(idx('null')).toBeNull()
    expect(idx('')).toBeNull()
    expect(() => schema.parse({ candidateId: 'assrt:1', fileIndex: 'abc' })).toThrow()
  })

  // A2: the staged file's provisional langTag used to be hardcoded 'zh-Hans' no matter what
  // language the task actually wants. It must now flow from deps.targetLanguage — non-Chinese
  // targets (e.g. 'en') get their own code directly; the final path/name is only a staging
  // artifact, replaced by install_subtitle's own langTag once the agent decides.
  it('stages the file with a langTag derived from deps.targetLanguage for a non-Chinese target', async () => {
    const stagedFiles = new Map<string, string>()
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n')))
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles,
      targetFilenames: ['Show.S01E01.mkv'],
      targetLanguage: 'en',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    ) as DownloadCandidateOutput
    const stagedPath = stagedFiles.get(out.stagedFileId)!
    expect(stagedPath.endsWith('.en.srt')).toBe(true)
  })

  // Chinese refinement (Hans vs Hant) is decided LATER, at install time, from
  // subtitleInspect's detectedScript signal — this provisional staging default stays 'zh-Hans'
  // for a Chinese target, unchanged from before A2.
  it('still stages a Chinese target as zh-Hans (refinement happens later at install time)', async () => {
    const stagedFiles = new Map<string, string>()
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n')))
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles,
      targetFilenames: ['Show.S01E01.mkv'],
      targetLanguage: 'zh',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    ) as DownloadCandidateOutput
    const stagedPath = stagedFiles.get(out.stagedFileId)!
    expect(stagedPath.endsWith('.zh-Hans.srt')).toBe(true)
  })

  it('two downloads in the same task do not collide (each gets its own staging subdir)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nfirst\n')))
      .mockResolvedValueOnce(new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nsecond\n')))
    const stagedFiles = new Map<string, string>()
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles,
      targetFilenames: ['Show.S01E01.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const first = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    ) as DownloadCandidateOutput
    const second = await tool_.execute!(
      { candidateId: 'assrt:2', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't2', messages: [] } as any,
    ) as DownloadCandidateOutput
    expect(first.stagedFileId).not.toBe(second.stagedFileId)
    const firstPath = stagedFiles.get(first.stagedFileId)!
    const secondPath = stagedFiles.get(second.stagedFileId)!
    expect(firstPath).not.toBe(secondPath)
    expect(readFileSync(firstPath, 'utf8')).toContain('first')
    expect(readFileSync(secondPath, 'utf8')).toContain('second')
    expect(existsSync(firstPath)).toBe(true)
    expect(existsSync(secondPath)).toBe(true)
  })
})

// Task 5 (R-5): download_candidate used to be single-target — deps.videoFilename was fixed at
// worker-construction time, so a batch run over a whole season had no way to say WHICH target a
// given download_candidate call was for. Now the worker run carries every target's filename
// (deps.targetFilenames) and the tool claims one per call via the videoFilename input, resolved by
// the same three-state rule install_subtitle uses: named + valid → use it; named + unknown → error;
// omitted + exactly one target → default to it; omitted + multiple targets → error asking to pick.
describe('download_candidate target resolution', () => {
  it('defaults to the sole target when videoFilename is omitted and the task has exactly one target (already covered implicitly above, asserted explicitly here)', async () => {
    const stagedFiles = new Map<string, string>()
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')))
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles,
      targetFilenames: ['Show.S01E01.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    ) as DownloadCandidateOutput
    const stagedPath = stagedFiles.get(out.stagedFileId)!
    expect(stagedPath).toContain('Show.S01E01')
  })

  it('stages under the named target when videoFilename matches one of several task targets', async () => {
    const stagedFiles = new Map<string, string>()
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')))
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles,
      targetFilenames: ['Show.S01E01.mkv', 'Show.S01E02.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: 'Show.S01E02.mkv', archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    ) as DownloadCandidateOutput
    const stagedPath = stagedFiles.get(out.stagedFileId)!
    expect(stagedPath).toContain('Show.S01E02')
  })

  it('errors without downloading when videoFilename does not match any of the task targets', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')))
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      targetFilenames: ['Show.S01E01.mkv', 'Show.S01E02.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: 'Show.S01E99.mkv', archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({ error: "unknown videoFilename: Show.S01E99.mkv — must be one of the task's target files" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('errors asking which target when videoFilename is omitted and the task has multiple targets', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')))
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      targetFilenames: ['Show.S01E01.mkv', 'Show.S01E02.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({ error: 'this task has 2 targets — pass videoFilename to say which one this call is for' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// C-D1 (audit finding this task fixes): zimuku et al. hand back candidates with an empty fileList,
// so fileIndex can't steer which file inside a season-pack zip gets used. subtitleWriter's
// pickFromZip used to mechanically grab entries[0] whenever selectFileName was omitted — a season
// pack could only ever yield episode 1 no matter what the agent wanted, and the agent never even
// saw what else was inside. Now the zip's entry list is a fact the tool hands back to the agent.
describe('download_candidate zip entry selection (C-D1)', () => {
  function packAdapter(): FetchAdapter {
    return {
      name: 'assrt',
      enabled: () => true,
      search: async () => [],
      resolve: async () => ({ url: 'http://file0.assrt.net/pack.zip', filename: 'Show.S01.zip' }),
    }
  }

  it('returns archiveEntries as a fact — does not stage anything — when the zip has multiple subtitle entries and no archiveEntryName was given', async () => {
    const zip = new AdmZip()
    zip.addFile('Show.S01E01.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep1\n'))
    zip.addFile('Show.S01E02.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep2\n'))
    const fetchImpl = vi.fn(async () => new Response(zip.toBuffer()))
    const stagedFiles = new Map<string, string>()
    const tool_ = makeDownloadCandidateTool({
      adapters: [packAdapter()],
      stagingDir: sandboxDir,
      stagedFiles,
      targetFilenames: ['Show.S01E01.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: null, archiveEntryName: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({
      archiveEntries: ['Show.S01E01.srt', 'Show.S01E02.srt'],
      hint: 'multiple subtitle entries in this archive — call again with archiveEntryName to pick your episode',
    })
    expect(stagedFiles.size).toBe(0)
  })

  it('archiveEntryName picks the exact entry out of a multi-file zip and stages it', async () => {
    const zip = new AdmZip()
    zip.addFile('Show.S01E01.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep1\n'))
    zip.addFile('Show.S01E02.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep2\n'))
    const fetchImpl = vi.fn(async () => new Response(zip.toBuffer()))
    const stagedFiles = new Map<string, string>()
    const tool_ = makeDownloadCandidateTool({
      adapters: [packAdapter()],
      stagingDir: sandboxDir,
      stagedFiles,
      targetFilenames: ['Show.S01E02.mkv'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { candidateId: 'assrt:1', fileIndex: null, videoFilename: null, archiveEntryName: 'Show.S01E02.srt' },
      { toolCallId: 't1', messages: [] } as any,
    ) as DownloadCandidateOutput
    const stagedPath = stagedFiles.get(out.stagedFileId)!
    expect(readFileSync(stagedPath, 'utf8')).toContain('ep2')
  })
})

describe('install_subtitle tool', () => {
  it('installs a staged file to the video directory with the given lang tag', async () => {
    const videoDir = join(sandboxDir, 'media', 'Show')
    mkdirSync(videoDir, { recursive: true })
    const stagedPath = join(sandboxDir, '.staging', 'attempt1', 'staged.srt')
    mkdirSync(join(sandboxDir, '.staging', 'attempt1'), { recursive: true })
    writeFileSync(stagedPath, 'hello')
    const stagedFileId = 'handle-1'
    const stagedFiles = new Map([[stagedFileId, stagedPath]])

    const tool_ = makeInstallSubtitleTool({
      stagedFiles,
      targets: [{ videoFilename: 'Show.S01E01.mkv', outDir: videoDir }],
      mediaRoot: join(sandboxDir, 'media'),
    })
    const out = await tool_.execute!(
      { stagedFileId, langTag: 'zh-Hans', videoFilename: null },
      { toolCallId: 't1', messages: [] } as any,
    ) as InstallSubtitleOutput
    expect(out.path).toBe(join(videoDir, 'Show.S01E01.zh-Hans.srt'))
    expect(existsSync(out.path!)).toBe(true)
  })

  // A2: langTag's inputSchema used to be a two-value zh-Hans/zh-Hant enum, which would hard-reject
  // a real model's tool call to install an 'en' (or any non-Chinese) subtitle before execute ever
  // ran. Generalized to any non-empty string.
  it('inputSchema accepts any non-empty langTag string, not just zh-Hans/zh-Hant', () => {
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map(),
      targets: [{ videoFilename: 'Show.S01E01.mkv', outDir: sandboxDir }],
      mediaRoot: sandboxDir,
    })
    const schema = tool_.inputSchema as import('zod').ZodType
    expect(schema.parse({ stagedFileId: 'x', langTag: 'en' })).toEqual({ stagedFileId: 'x', langTag: 'en', videoFilename: null })
    expect(schema.parse({ stagedFileId: 'x', langTag: 'zh-Hans' })).toEqual({ stagedFileId: 'x', langTag: 'zh-Hans', videoFilename: null })
  })

  it('installs a staged file with a non-Chinese lang tag (e.g. an English subtitle)', async () => {
    const videoDir = join(sandboxDir, 'media', 'Show')
    mkdirSync(videoDir, { recursive: true })
    const stagedPath = join(sandboxDir, '.staging', 'attempt-en', 'staged.srt')
    mkdirSync(join(sandboxDir, '.staging', 'attempt-en'), { recursive: true })
    writeFileSync(stagedPath, 'hello')
    const stagedFileId = 'handle-en'
    const stagedFiles = new Map([[stagedFileId, stagedPath]])

    const tool_ = makeInstallSubtitleTool({
      stagedFiles,
      targets: [{ videoFilename: 'Show.S01E01.mkv', outDir: videoDir }],
      mediaRoot: join(sandboxDir, 'media'),
    })
    const out = await tool_.execute!(
      { stagedFileId, langTag: 'en', videoFilename: null },
      { toolCallId: 't1', messages: [] } as any,
    ) as InstallSubtitleOutput
    expect(out.path).toBe(join(videoDir, 'Show.S01E01.en.srt'))
    expect(existsSync(out.path!)).toBe(true)
  })

  it('rejects an unknown stagedFileId', async () => {
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map(),
      targets: [{ videoFilename: 'Show.S01E01.mkv', outDir: sandboxDir }],
      mediaRoot: sandboxDir,
    })
    const out = await tool_.execute!(
      { stagedFileId: 'nope', langTag: 'zh-Hans', videoFilename: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({ error: 'unknown stagedFileId: nope — call download_candidate first' })
  })

  it('sandbox: refuses to install outside the configured mediaRoot even if outDir were miswired', async () => {
    const stagedPath = join(sandboxDir, 'staged.srt')
    writeFileSync(stagedPath, 'hello')
    const stagedFileId = 'handle-escape'
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map([[stagedFileId, stagedPath]]),
      targets: [{ videoFilename: 'Show.S01E01.mkv', outDir: join(sandboxDir, 'outside') }], // deliberately NOT under mediaRoot below
      mediaRoot: join(sandboxDir, 'media'),
    })
    const out = await tool_.execute!(
      { stagedFileId, langTag: 'zh-Hans', videoFilename: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toHaveProperty('error')
    expect((out as { error: string }).error).toMatch(/refusing to install outside/)
  })
})

// Task 5 (R-5): install_subtitle used to be single-target too (deps.outDir/deps.videoFilename fixed
// at worker-construction time). A batch run installs episode-by-episode across the whole season, so
// each install_subtitle call must say which target it is installing for — same three-state
// resolution rule as download_candidate, sharing the resolveTargetFilename helper.
describe('install_subtitle target resolution', () => {
  it("installs into the named target's own outDir when videoFilename matches one of several targets", async () => {
    const dirA = join(sandboxDir, 'media', 'ShowA')
    const dirB = join(sandboxDir, 'media', 'ShowB')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    const stagedPath = join(sandboxDir, 'staged.srt')
    writeFileSync(stagedPath, 'hello')
    const stagedFileId = 'handle-multi'
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map([[stagedFileId, stagedPath]]),
      targets: [
        { videoFilename: 'ShowA.S01E01.mkv', outDir: dirA },
        { videoFilename: 'ShowB.S01E01.mkv', outDir: dirB },
      ],
      mediaRoot: join(sandboxDir, 'media'),
    })
    const out = await tool_.execute!(
      { stagedFileId, langTag: 'zh-Hans', videoFilename: 'ShowB.S01E01.mkv' },
      { toolCallId: 't1', messages: [] } as any,
    ) as InstallSubtitleOutput
    expect(out.path).toBe(join(dirB, 'ShowB.S01E01.zh-Hans.srt'))
    expect(existsSync(out.path!)).toBe(true)
    // proves it did NOT fall through to the other target's dir
    expect(existsSync(join(dirA, 'ShowA.S01E01.zh-Hans.srt'))).toBe(false)
  })

  it("errors without installing when videoFilename does not match any of the task's targets", async () => {
    const dir = join(sandboxDir, 'media', 'Show')
    mkdirSync(dir, { recursive: true })
    const stagedPath = join(sandboxDir, 'staged.srt')
    writeFileSync(stagedPath, 'hello')
    const stagedFileId = 'handle-unknown-target'
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map([[stagedFileId, stagedPath]]),
      targets: [{ videoFilename: 'Show.S01E01.mkv', outDir: dir }],
      mediaRoot: join(sandboxDir, 'media'),
    })
    const out = await tool_.execute!(
      { stagedFileId, langTag: 'zh-Hans', videoFilename: 'Show.S01E99.mkv' },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({ error: "unknown videoFilename: Show.S01E99.mkv — must be one of the task's target files" })
    expect(existsSync(join(dir, 'Show.S01E99.zh-Hans.srt'))).toBe(false)
  })

  it('errors asking which target when videoFilename is omitted and there are multiple targets', async () => {
    const dirA = join(sandboxDir, 'media', 'ShowA')
    const dirB = join(sandboxDir, 'media', 'ShowB')
    mkdirSync(dirA, { recursive: true })
    mkdirSync(dirB, { recursive: true })
    const stagedPath = join(sandboxDir, 'staged.srt')
    writeFileSync(stagedPath, 'hello')
    const stagedFileId = 'handle-omitted'
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map([[stagedFileId, stagedPath]]),
      targets: [
        { videoFilename: 'ShowA.S01E01.mkv', outDir: dirA },
        { videoFilename: 'ShowB.S01E01.mkv', outDir: dirB },
      ],
      mediaRoot: join(sandboxDir, 'media'),
    })
    const out = await tool_.execute!(
      { stagedFileId, langTag: 'zh-Hans', videoFilename: null },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({ error: 'this task has 2 targets — pass videoFilename to say which one this call is for' })
  })
})

describe('check_episode_code_safety tool', () => {
  it('reports safe:true when the filename matches the target episode code', async () => {
    const tool_ = makeCheckEpisodeCodeSafetyTool()
    const out = await tool_.execute!(
      { filename: 'Show.S01E05.1080p.srt', season: 1, episode: 5 },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({ safe: true, expectedCode: 'S01E05' })
  })

  it('reports safe:false when the filename names a different episode', async () => {
    const tool_ = makeCheckEpisodeCodeSafetyTool()
    const out = await tool_.execute!(
      { filename: 'Show.S01E06.1080p.srt', season: 1, episode: 5 },
      { toolCallId: 't1', messages: [] } as any,
    )
    expect(out).toEqual({ safe: false, expectedCode: 'S01E05' })
  })

  // Same coercion class as download_candidate.fileIndex: the real model string-encodes season/episode
  // ("1"/"5"). The old `z.number().int()` rejected those, killing the advisory check's tool-arg
  // validation before execute ran. Schema must coerce string-encoded integers.
  it('season/episode schema coerces string-encoded integers', () => {
    const tool_ = makeCheckEpisodeCodeSafetyTool()
    const schema = tool_.inputSchema as import('zod').ZodType
    expect(schema.parse({ filename: 'x', season: '1', episode: '5' })).toEqual({ filename: 'x', season: 1, episode: 5 })
    expect(schema.parse({ filename: 'x', season: 2, episode: 3 })).toEqual({ filename: 'x', season: 2, episode: 3 })
  })
})
