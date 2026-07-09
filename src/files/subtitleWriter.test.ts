import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import * as iconv from 'iconv-lite'
import { writeSubtitle } from './subtitleWriter.js'

const outDir = () => mkdtempSync(join(tmpdir(), 'subw-'))

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

  it('throws UnsupportedArchiveError for rar', async () => {
    await expect(writeSubtitle({
      artifact: Buffer.from('Rar!\x1a\x07'), artifactFilename: 'pack.rar',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: outDir(),
    })).rejects.toThrow(/unsupported archive/i)
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
