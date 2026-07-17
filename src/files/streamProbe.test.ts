import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import type { execFile } from 'node:child_process'
import { path as ffprobeStaticPath } from 'ffprobe-static'
import { probeEmbeddedSubtitles, probeDurationSec } from './streamProbe.js'

/** Builds a fake execFileImpl that resolves/rejects like node:child_process's execFile
 *  callback form (error, stdout, stderr) — real signature is overloaded to the point of being
 *  unusable for direct mocking, hence the cast. */
function fakeExecFile(
  handler: (bin: string, args: readonly string[]) => { stdout: string } | { error: unknown },
): typeof execFile {
  return ((bin: string, args: readonly string[], _options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
    const result = handler(bin, args)
    if ('error' in result) callback(result.error, '', '')
    else callback(null, result.stdout, '')
  }) as unknown as typeof execFile
}

// Realistic `-show_streams -select_streams s` JSON shape (per ffprobe docs / real fixture probe).
const TWO_TRACK_JSON = JSON.stringify({
  streams: [
    { index: 2, codec_name: 'subrip', codec_type: 'subtitle', tags: { language: 'chi', title: '简体中文' } },
    { index: 3, codec_name: 'hdmv_pgs_subtitle', codec_type: 'subtitle', tags: { language: 'eng' } },
  ],
})

describe('probeEmbeddedSubtitles', () => {
  it('parses a realistic ffprobe JSON shape into tracks with lang/codec/isImageBased', async () => {
    const execFileImpl = fakeExecFile(() => ({ stdout: TWO_TRACK_JSON }))
    const result = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl })
    expect(result).toEqual([
      { lang: 'chi', codec: 'subrip', isImageBased: false },
      { lang: 'eng', codec: 'hdmv_pgs_subtitle', isImageBased: true },
    ])
  })

  it('returns null when execFileImpl throws ENOENT (binary missing)', async () => {
    const enoent = Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' })
    const execFileImpl = fakeExecFile(() => ({ error: enoent }))
    const result = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl })
    expect(result).toBeNull()
  })

  it('returns null on a timeout-shaped error', async () => {
    const timeoutErr = Object.assign(new Error('command timed out'), { killed: true, signal: 'SIGTERM' })
    const execFileImpl = fakeExecFile(() => ({ error: timeoutErr }))
    const result = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, timeoutMs: 5 })
    expect(result).toBeNull()
  })

  it('returns [] when ffprobe succeeds with zero subtitle streams', async () => {
    const execFileImpl = fakeExecFile(() => ({ stdout: JSON.stringify({ streams: [] }) }))
    const result = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl })
    expect(result).toEqual([])
  })

  it('returns null on unparseable (garbage) stdout', async () => {
    const execFileImpl = fakeExecFile(() => ({ stdout: 'not json at all {{{' }))
    const result = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl })
    expect(result).toBeNull()
  })

  it('reports lang: null when a stream has no tags at all', async () => {
    const execFileImpl = fakeExecFile(() => ({
      stdout: JSON.stringify({ streams: [{ index: 2, codec_name: 'subrip', codec_type: 'subtitle' }] }),
    }))
    const result = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl })
    expect(result).toEqual([{ lang: null, codec: 'subrip', isImageBased: false }])
  })

  it('reports lang: null when tags exist but language is absent', async () => {
    const execFileImpl = fakeExecFile(() => ({
      stdout: JSON.stringify({ streams: [{ index: 2, codec_name: 'ass', codec_type: 'subtitle', tags: { title: 'Forced' } }] }),
    }))
    const result = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl })
    expect(result).toEqual([{ lang: null, codec: 'ass', isImageBased: false }])
  })

  describe('binary resolution order', () => {
    const ORIGINAL_FFPROBE_PATH = process.env.FFPROBE_PATH

    afterEach(() => {
      if (ORIGINAL_FFPROBE_PATH === undefined) delete process.env.FFPROBE_PATH
      else process.env.FFPROBE_PATH = ORIGINAL_FFPROBE_PATH
    })

    it('opts.ffprobePath wins over FFPROBE_PATH env and the ffprobe-static default', async () => {
      process.env.FFPROBE_PATH = '/env/ffprobe'
      let seenBin: string | undefined
      const execFileImpl = fakeExecFile((bin) => { seenBin = bin; return { stdout: JSON.stringify({ streams: [] }) } })
      await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, ffprobePath: '/explicit/ffprobe' })
      expect(seenBin).toBe('/explicit/ffprobe')
    })

    it('falls back to FFPROBE_PATH env when opts.ffprobePath is not given', async () => {
      process.env.FFPROBE_PATH = '/env/ffprobe'
      let seenBin: string | undefined
      const execFileImpl = fakeExecFile((bin) => { seenBin = bin; return { stdout: JSON.stringify({ streams: [] }) } })
      await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl })
      expect(seenBin).toBe('/env/ffprobe')
    })

    it('FFPROBE_PATH still wins over the lazy ffprobe-static import — the import is never attempted', async () => {
      process.env.FFPROBE_PATH = '/env/ffprobe'
      let seenBin: string | undefined
      let importCalled = false
      const execFileImpl = fakeExecFile((bin) => { seenBin = bin; return { stdout: JSON.stringify({ streams: [] }) } })
      const importFfprobeStatic = async () => { importCalled = true; return { path: '/should/not/be/used' } }
      await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, importFfprobeStatic })
      expect(seenBin).toBe('/env/ffprobe')
      expect(importCalled).toBe(false)
    })

    it('falls back to the ffprobe-static bundled binary when neither opt nor env is set', async () => {
      delete process.env.FFPROBE_PATH
      let seenBin: string | undefined
      const execFileImpl = fakeExecFile((bin) => { seenBin = bin; return { stdout: JSON.stringify({ streams: [] }) } })
      await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl })
      expect(seenBin).toBe(ffprobeStaticPath)
    })

    describe('ffprobe-static is optional — lazy import can fail without crashing the process', () => {
      it('returns null (probe-unavailable contract) when the import rejects and no explicit/env path is set', async () => {
        delete process.env.FFPROBE_PATH
        let execFileCalled = false
        const execFileImpl = fakeExecFile(() => { execFileCalled = true; return { stdout: JSON.stringify({ streams: [] }) } })
        const importFfprobeStatic = async () => { throw new Error('cannot download vendored binary tarball') }
        const result = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, importFfprobeStatic })
        expect(result).toBeNull()
        expect(execFileCalled).toBe(false)
      })

      it('returns null when the import resolves but the module has no usable path (package missing/stubbed)', async () => {
        delete process.env.FFPROBE_PATH
        const execFileImpl = fakeExecFile(() => ({ stdout: JSON.stringify({ streams: [] }) }))
        const importFfprobeStatic = async () => ({})
        const result = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, importFfprobeStatic })
        expect(result).toBeNull()
      })

      it('accepts the default-export shape (`{ default: { path } }`) as well as the named-export shape', async () => {
        delete process.env.FFPROBE_PATH
        let seenBin: string | undefined
        const execFileImpl = fakeExecFile((bin) => { seenBin = bin; return { stdout: JSON.stringify({ streams: [] }) } })
        const importFfprobeStatic = async () => ({ default: { path: '/interop/ffprobe' } })
        await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, importFfprobeStatic })
        expect(seenBin).toBe('/interop/ffprobe')
      })
    })
  })
})

describe('probeDurationSec', () => {
  it('returns floor(duration) from format.duration string', async () => {
    const execFileImpl = fakeExecFile(() => ({
      stdout: JSON.stringify({ format: { duration: '123.456789' } }),
    }))
    const result = await probeDurationSec('/media/movie.mkv', { execFileImpl })
    expect(result).toBe(123)
  })

  it('returns null on malformed stdout', async () => {
    const execFileImpl = fakeExecFile(() => ({ stdout: 'not json' }))
    const result = await probeDurationSec('/media/movie.mkv', { execFileImpl })
    expect(result).toBeNull()
  })

  it('returns null when execFileImpl throws ENOENT', async () => {
    const enoent = Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' })
    const execFileImpl = fakeExecFile(() => ({ error: enoent }))
    const result = await probeDurationSec('/media/movie.mkv', { execFileImpl })
    expect(result).toBeNull()
  })

  it('returns null when format.duration is absent', async () => {
    const execFileImpl = fakeExecFile(() => ({
      stdout: JSON.stringify({ format: { filename: '/media/movie.mkv' } }),
    }))
    const result = await probeDurationSec('/media/movie.mkv', { execFileImpl })
    expect(result).toBeNull()
  })

  it('returns null when format.duration is non-numeric', async () => {
    const execFileImpl = fakeExecFile(() => ({
      stdout: JSON.stringify({ format: { duration: 'N/A' } }),
    }))
    const result = await probeDurationSec('/media/movie.mkv', { execFileImpl })
    expect(result).toBeNull()
  })
})

// Real-binary smoke test — only runs when both the ffprobe-static binary and a real repo fixture
// video exist on this machine. Never makes CI depend on media files: skips cleanly otherwise.
const SAMPLE_VIDEO = 'fixtures/media/Movies/The Wandering Earth (2019)/The Wandering Earth (2019) 1080p.mkv'
const canRunRealSmoke = existsSync(ffprobeStaticPath) && existsSync(SAMPLE_VIDEO)

describe.skipIf(!canRunRealSmoke)('probeEmbeddedSubtitles — real binary smoke', () => {
  it('probes a real fixture file without throwing', async () => {
    const result = await probeEmbeddedSubtitles(SAMPLE_VIDEO)
    expect(result === null || Array.isArray(result)).toBe(true)
  })
})
