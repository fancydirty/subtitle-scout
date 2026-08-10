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

    // 生产事故回归（compose `${FFPROBE_PATH:-}` 把变量设成**空串**而非"不设置"，覆盖了镜像
    // Dockerfile 的 ENV FFPROBE_PATH=/usr/bin/ffprobe）：原实现用 `??` 解析，空串是合法值不短路
    // → bin=""  → 绕过"二进制缺席"闸 → execFile("") 抛 ERR_INVALID_ARG_VALUE 被 catch 吞掉
    // → 探针恒 null → 61 个文件的 embedded_langs/duration_sec 静默全 NULL，日志却报 ok=61。
    // 原有用例只覆盖了 '/env/ffprobe'（已设置）与 delete（未设置）两态，**空串这第三态**——
    // 也就是 compose 默认产物、生产最可能的取值——恰好没测。这两条把它钉住。
    it('FFPROBE_PATH 为空串（compose ${VAR:-} 的默认产物）视为未设置，回落 ffprobe-static，绝不 execFile("")', async () => {
      process.env.FFPROBE_PATH = ''
      let seenBin: string | undefined
      const execFileImpl = fakeExecFile((bin) => { seenBin = bin; return { stdout: JSON.stringify({ streams: [] }) } })
      const importFfprobeStatic = async () => ({ path: '/static/ffprobe' })
      const r = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, importFfprobeStatic })
      expect(seenBin).toBe('/static/ffprobe')
      expect(r).toEqual([])
    })

    it('FFPROBE_PATH 为纯空白（"  "）同样视为未设置——trim 后为空即当没给', async () => {
      process.env.FFPROBE_PATH = '   '
      let seenBin: string | undefined
      const execFileImpl = fakeExecFile((bin) => { seenBin = bin; return { stdout: JSON.stringify({ streams: [] }) } })
      const importFfprobeStatic = async () => ({ path: '/static/ffprobe' })
      await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, importFfprobeStatic })
      expect(seenBin).toBe('/static/ffprobe')
    })

    it('空串 FFPROBE_PATH + ffprobe-static 也不可用 → 返回 null（探针不可用契约），execFile 一次不碰', async () => {
      // 纵深防御那道闸（`if (!bin)`）的直接断言：即使回落链整条都空，也绝不能走到 execFile("")。
      process.env.FFPROBE_PATH = ''
      let execFileCalled = false
      const execFileImpl = fakeExecFile(() => { execFileCalled = true; return { stdout: JSON.stringify({ streams: [] }) } })
      const importFfprobeStatic = async () => ({})
      const r = await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, importFfprobeStatic })
      expect(r).toBeNull()
      expect(execFileCalled).toBe(false)
    })

    it('opts.ffprobePath 为空串时也不当"显式指定"，继续回落 env/static', async () => {
      process.env.FFPROBE_PATH = '/env/ffprobe'
      let seenBin: string | undefined
      const execFileImpl = fakeExecFile((bin) => { seenBin = bin; return { stdout: JSON.stringify({ streams: [] }) } })
      await probeEmbeddedSubtitles('/media/movie.mkv', { execFileImpl, ffprobePath: '' })
      expect(seenBin).toBe('/env/ffprobe')
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

  // 与 probeEmbeddedSubtitles 同构的空串回归——两个探针共用同一套解析顺序，也就共用同一个 bug。
  // 生产上这一条的后果是 duration_sec 全 NULL（同一批 61 个文件）。
  describe('binary resolution order（空串回归，与 probeEmbeddedSubtitles 同构）', () => {
    const ORIGINAL_FFPROBE_PATH = process.env.FFPROBE_PATH

    afterEach(() => {
      if (ORIGINAL_FFPROBE_PATH === undefined) delete process.env.FFPROBE_PATH
      else process.env.FFPROBE_PATH = ORIGINAL_FFPROBE_PATH
    })

    it('FFPROBE_PATH 为空串（compose ${VAR:-} 的默认产物）视为未设置，回落 ffprobe-static，绝不 execFile("")', async () => {
      process.env.FFPROBE_PATH = ''
      let seenBin: string | undefined
      const execFileImpl = fakeExecFile((bin) => { seenBin = bin; return { stdout: JSON.stringify({ format: { duration: '210.016' } }) } })
      const importFfprobeStatic = async () => ({ path: '/static/ffprobe' })
      const r = await probeDurationSec('/media/movie.mkv', { execFileImpl, importFfprobeStatic })
      expect(seenBin).toBe('/static/ffprobe')
      expect(r).toBe(210)
    })

    it('空串 FFPROBE_PATH + ffprobe-static 也不可用 → 返回 null，execFile 一次不碰', async () => {
      process.env.FFPROBE_PATH = ''
      let execFileCalled = false
      const execFileImpl = fakeExecFile(() => { execFileCalled = true; return { stdout: '{}' } })
      const importFfprobeStatic = async () => ({})
      const r = await probeDurationSec('/media/movie.mkv', { execFileImpl, importFfprobeStatic })
      expect(r).toBeNull()
      expect(execFileCalled).toBe(false)
    })
  })
})

// Real-binary smoke test — only runs when both the ffprobe-static binary and a real repo fixture
// video exist on this machine. Never makes CI depend on media files: skips cleanly otherwise.
const SAMPLE_VIDEO = 'fixtures/media/Movies/The Wandering Earth (2019)/The Wandering Earth (2019) 1080p.mkv'
const canRunRealSmoke = existsSync(ffprobeStaticPath) && existsSync(SAMPLE_VIDEO)

describe.skipIf(!canRunRealSmoke)('probeEmbeddedSubtitles — real binary smoke', () => {
  // 显式 30s 测试超时:此用例真起 ffprobe 子进程探一个 1080p fixture。probeEmbeddedSubtitles
  // 内部已 catch 掉一切错误/超时返回 null(断言恒不会因返回值失败),故唯一的失败模式是 vitest
  // 测试级超时——单跑约 150ms,但在全量套件并行(数十用例争 CPU)下真 ffprobe 可超 vitest 默认
  // 5s,导致间歇性 flaky(单跑绿、全量偶挂)。内部 ffprobe 超时是 15s,这里给 30s 留足余量。
  it('probes a real fixture file without throwing', async () => {
    const result = await probeEmbeddedSubtitles(SAMPLE_VIDEO)
    expect(result === null || Array.isArray(result)).toBe(true)
  }, 30000)
})
