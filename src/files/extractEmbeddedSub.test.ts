import { describe, it, expect } from 'vitest'
import type { execFile as NodeExecFile } from 'node:child_process'
import { extractEmbeddedSubtitle } from './extractEmbeddedSub.js'

/** 假 execFile:捕获传入的 bin/args,回调配置好的 stdout 或 error。签名对齐 node:child_process。 */
function fakeExecFile(
  handler: (bin: string, args: string[]) => { stdout?: string; error?: Error },
): typeof NodeExecFile {
  return ((bin: string, args: string[], _options: unknown, callback: (e: Error | null, stdout: string, stderr: string) => void) => {
    const { stdout = '', error } = handler(bin, args)
    callback(error ?? null, stdout, '')
    return undefined as never
  }) as unknown as typeof NodeExecFile
}

const SRT = ['1', '00:00:01,000 --> 00:00:03,000', '<i>Hello.</i>', '', '2', '00:00:04,000 --> 00:00:06,000', 'World.', ''].join('\n')

describe('extractEmbeddedSubtitle', () => {
  it('跑 ffmpeg -map 0:s:<index> -f srt → pipe:1,返回 SRT 文本', async () => {
    let seenArgs: string[] = []
    let seenBin = ''
    const impl = fakeExecFile((bin, args) => { seenBin = bin; seenArgs = args; return { stdout: SRT } })
    const out = await extractEmbeddedSubtitle('/media/x.mkv', 2, { ffmpegPath: '/usr/bin/ffmpeg', execFileImpl: impl })
    expect(out).toBe(SRT)
    expect(seenBin).toBe('/usr/bin/ffmpeg')
    // -map 0:s:2 选第 3 条(0-based)字幕轨;-f srt 输出到 pipe:1;输入含视频路径
    expect(seenArgs).toContain('-map')
    expect(seenArgs).toContain('0:s:2')
    expect(seenArgs).toContain('srt')
    expect(seenArgs).toContain('pipe:1')
    expect(seenArgs).toContain('/media/x.mkv')
  })

  it('ffmpeg 报错 → 返回 null(不抛)', async () => {
    const impl = fakeExecFile(() => ({ error: new Error('ffmpeg failed') }))
    const out = await extractEmbeddedSubtitle('/media/x.mkv', 0, { ffmpegPath: '/usr/bin/ffmpeg', execFileImpl: impl })
    expect(out).toBeNull()
  })

  it('抽出空白/无内容 → 返回 null(没有可译文本不是成功)', async () => {
    const impl = fakeExecFile(() => ({ stdout: '   \n\n' }))
    const out = await extractEmbeddedSubtitle('/media/x.mkv', 0, { ffmpegPath: '/usr/bin/ffmpeg', execFileImpl: impl })
    expect(out).toBeNull()
  })

  it('无显式路径/无 FFMPEG_PATH 时默认走 PATH 上的 "ffmpeg"(Dockerfile apt 装了系统 ffmpeg)', async () => {
    const prev = process.env.FFMPEG_PATH
    delete process.env.FFMPEG_PATH
    try {
      let seenBin = ''
      const impl = fakeExecFile((bin) => { seenBin = bin; return { stdout: SRT } })
      const out = await extractEmbeddedSubtitle('/media/x.mkv', 0, { execFileImpl: impl })
      expect(seenBin).toBe('ffmpeg')
      expect(out).toBe(SRT)
    } finally {
      if (prev !== undefined) process.env.FFMPEG_PATH = prev
    }
  })

  it('FFMPEG_PATH 环境变量覆盖默认', async () => {
    const prev = process.env.FFMPEG_PATH
    process.env.FFMPEG_PATH = '/opt/ffmpeg'
    try {
      let seenBin = ''
      const impl = fakeExecFile((bin) => { seenBin = bin; return { stdout: SRT } })
      await extractEmbeddedSubtitle('/media/x.mkv', 0, { execFileImpl: impl })
      expect(seenBin).toBe('/opt/ffmpeg')
    } finally {
      if (prev !== undefined) process.env.FFMPEG_PATH = prev
      else delete process.env.FFMPEG_PATH
    }
  })

  it('默认 timeout 300s(长片 4K 抽轨);EXTRACT_TIMEOUT_MS 可覆盖', async () => {
    let seenTimeout = 0
    const impl = ((bin: string, args: string[], options: { timeout: number }, callback: (e: Error | null, stdout: string, stderr: string) => void) => {
      seenTimeout = options.timeout
      callback(null, SRT, '')
      return undefined as never
    }) as unknown as typeof NodeExecFile
    const prev = process.env.EXTRACT_TIMEOUT_MS
    delete process.env.EXTRACT_TIMEOUT_MS
    try {
      await extractEmbeddedSubtitle('/media/x.mkv', 0, { execFileImpl: impl })
      expect(seenTimeout).toBe(300_000)
      process.env.EXTRACT_TIMEOUT_MS = '120000'
      await extractEmbeddedSubtitle('/media/x.mkv', 0, { execFileImpl: impl })
      expect(seenTimeout).toBe(120_000)
    } finally {
      if (prev !== undefined) process.env.EXTRACT_TIMEOUT_MS = prev
      else delete process.env.EXTRACT_TIMEOUT_MS
    }
  })
})
