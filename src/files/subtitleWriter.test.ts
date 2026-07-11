import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import * as iconv from 'iconv-lite'
import { writeSubtitle } from './subtitleWriter.js'

const outDir = () => mkdtempSync(join(tmpdir(), 'subw-'))

// 用于模拟"原子写入的最后一步（rename）崩溃"：真正的进程崩溃无法在测试里重现，
// 但可以让 renameSync 在被调用一次后抛错，观察崩溃发生在 rename 之前 vs 之后的落盘状态。
let renameShouldFailOnce = false
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameShouldFailOnce) {
        renameShouldFailOnce = false
        throw new Error('simulated crash before rename completed')
      }
      return actual.renameSync(...args)
    },
  }
})

describe('writeSubtitle', () => {
  it('writes a plain utf-8 srt with Jellyfin naming', async () => {
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n你好\n'),
      artifactFilename: 'sub.srt',
      videoFilename: 'The.Matrix.1999.1080p.BluRay.x264.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    expect(r.path).toBe(join(dir, 'The.Matrix.1999.1080p.BluRay.x264.zh-Hans.srt'))
    expect(existsSync(r.path)).toBe(true)
    expect(r.encoding).toBe('utf-8')
  })

  it('extracts the requested file from a zip by name', async () => {
    const zip = new AdmZip()
    zip.addFile('wrong.ass', Buffer.from('WRONG'))
    zip.addFile('right.ass', Buffer.from('[Script Info]\nTitle: right\n'))
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: zip.toBuffer(),
      artifactFilename: 'pack.zip',
      selectFileName: 'right.ass',
      videoFilename: 'Movie.2020.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    expect(readFileSync(r.path, 'utf8')).toContain('Title: right')
    expect(r.path.endsWith('Movie.2020.zh-Hans.ass')).toBe(true)
  })

  it('converts GB18030 to utf-8 and records original encoding', async () => {
    const gbk = iconv.encode('1\n00:00:01,000 --> 00:00:02,000\n黑客帝国经典台词测试字幕内容\n', 'gb18030')
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: gbk, artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    })
    expect(readFileSync(r.path, 'utf8')).toContain('黑客帝国')
    expect(r.encoding?.toLowerCase()).not.toBe('utf-8')
  })

  it('refuses to overwrite an existing file', async () => {
    const dir = outDir()
    writeFileSync(join(dir, 'Movie.zh-Hans.srt'), 'existing')
    const r = await writeSubtitle({
      artifact: Buffer.from('new'), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    })
    expect(r.alreadyExists).toBe(true)
    expect(readFileSync(join(dir, 'Movie.zh-Hans.srt'), 'utf8')).toBe('existing')
  })

  it('passes through an OpenSubtitles-style bare .srt (no zip) with correct naming, uppercase ext tolerated', async () => {
    // OpenSubtitles 下载是裸 UTF-8 .srt 而非 zip——必须原样直通，不做 zip 解析
    const dir = outDir()
    const body = '1\n00:00:01,000 --> 00:00:02,000\n和平使者第一集\n'
    const r = await writeSubtitle({
      artifact: Buffer.from(body),
      artifactFilename: 'Peacemaker.S01E01.chs.SRT',
      videoFilename: 'Peacemaker.S01E01.2160p.WEB.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    expect(r.path).toBe(join(dir, 'Peacemaker.S01E01.2160p.WEB.zh-Hans.srt'))
    expect(readFileSync(r.path, 'utf8')).toBe(body)
    expect(r.alreadyExists).toBe(false)
  })

  it('throws UnsupportedArchiveError for rar', async () => {
    await expect(writeSubtitle({
      artifact: Buffer.from('Rar!\x1a\x07'), artifactFilename: 'pack.rar',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: outDir(),
    })).rejects.toThrow(/unsupported archive/i)
  })

  afterEach(() => { renameShouldFailOnce = false })

  it('atomic write: a crash right before rename leaves only a temp artifact (no truncated file at the final sidecar path), and the retry writes a clean, complete file', async () => {
    const dir = outDir()
    const finalPath = join(dir, 'Movie.zh-Hans.srt')
    const body = '1\n00:00:01,000 --> 00:00:02,000\nfull content\n'

    renameShouldFailOnce = true
    await expect(writeSubtitle({
      artifact: Buffer.from(body), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    })).rejects.toThrow(/simulated crash/)

    // 崩溃发生在 rename 之前：final 路径绝不能出现半截文件
    expect(existsSync(finalPath)).toBe(false)
    // 但写入应已落到同目录的临时文件上（原子写的第一步）
    const leftovers = readdirSync(dir).filter(f => f !== 'Movie.zh-Hans.srt')
    expect(leftovers.length).toBeGreaterThan(0)

    // 重试（下一次守护进程 tick）：不应被残留临时文件卡住，应产出完整正确的文件
    const r = await writeSubtitle({
      artifact: Buffer.from(body), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    })
    expect(r.alreadyExists).toBe(false)
    expect(existsSync(finalPath)).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe(body)
  })

  it('sanitizes path-traversal videoFilename and stays inside outDir', async () => {
    const dir = outDir()
    const { resolve } = await import('node:path')
    const r = await writeSubtitle({
      artifact: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n'),
      artifactFilename: 'sub.srt',
      videoFilename: '../../../../tmp/EVIL-INJECTED.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    expect(r.path.startsWith(resolve(dir))).toBe(true)
    expect(r.path.endsWith('EVIL-INJECTED.zh-Hans.srt')).toBe(true)
  })
})
