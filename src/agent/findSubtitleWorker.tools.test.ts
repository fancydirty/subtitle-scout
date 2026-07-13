import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchAdapter } from '../cli/fetchLib.js'
import { makeDownloadCandidateTool } from './findSubtitleWorker.tools.js'
import type { InspectSignals } from '../files/subtitleInspect.js'

interface DownloadCandidateOutput {
  stagedFileId: string
  bytes: number
  encoding: string | null
  signals: InspectSignals
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
