import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchAdapter } from '../cli/fetchLib.js'
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

describe('download_candidate tool', () => {
  it('resolves, downloads, stages, and inspects — returns a stagedFileId + signals, does not install', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from(
      '1\n00:00:01,000 --> 00:00:02,000\nhello\n',
    )))
    const tool_ = makeDownloadCandidateTool({
      adapters: [fakeAdapter('http://file0.assrt.net/x.srt')],
      stagingDir: sandboxDir,
      stagedFiles: new Map(),
      videoFilename: 'Show.S01E01.mkv',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const out = await tool_.execute!(
      { provider: 'assrt', providerId: '1', fileIndex: null },
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
      videoFilename: 'Show.S01E01.mkv',
    })
    expect(tool_.description).toMatch(/fileIndex/)
    expect(tool_.description).toMatch(/pack|collection|filelist|file list/i)
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
      videoFilename: 'Show.S01E01.mkv',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const first = await tool_.execute!({ provider: 'assrt', providerId: '1', fileIndex: null }, { toolCallId: 't1', messages: [] } as any) as DownloadCandidateOutput
    const second = await tool_.execute!({ provider: 'assrt', providerId: '2', fileIndex: null }, { toolCallId: 't2', messages: [] } as any) as DownloadCandidateOutput
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
      stagedFiles, outDir: videoDir, mediaRoot: join(sandboxDir, 'media'), videoFilename: 'Show.S01E01.mkv',
    })
    const out = await tool_.execute!({ stagedFileId, langTag: 'zh-Hans' }, { toolCallId: 't1', messages: [] } as any) as InstallSubtitleOutput
    expect(out.path).toBe(join(videoDir, 'Show.S01E01.zh-Hans.srt'))
    expect(existsSync(out.path!)).toBe(true)
  })

  it('rejects an unknown stagedFileId', async () => {
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map(), outDir: sandboxDir, mediaRoot: sandboxDir, videoFilename: 'Show.S01E01.mkv',
    })
    const out = await tool_.execute!({ stagedFileId: 'nope', langTag: 'zh-Hans' }, { toolCallId: 't1', messages: [] } as any)
    expect(out).toEqual({ error: 'unknown stagedFileId: nope — call download_candidate first' })
  })

  it('sandbox: refuses to install outside the configured mediaRoot even if outDir were miswired', async () => {
    const stagedPath = join(sandboxDir, 'staged.srt')
    writeFileSync(stagedPath, 'hello')
    const stagedFileId = 'handle-escape'
    const tool_ = makeInstallSubtitleTool({
      stagedFiles: new Map([[stagedFileId, stagedPath]]),
      outDir: join(sandboxDir, 'outside'), // deliberately NOT under mediaRoot below
      mediaRoot: join(sandboxDir, 'media'),
      videoFilename: 'Show.S01E01.mkv',
    })
    const out = await tool_.execute!({ stagedFileId, langTag: 'zh-Hans' }, { toolCallId: 't1', messages: [] } as any)
    expect(out).toHaveProperty('error')
    expect((out as { error: string }).error).toMatch(/refusing to install outside/)
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
})
