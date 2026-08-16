import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import * as iconv from 'iconv-lite'
import { writeSubtitle, type WriteSubtitleOutcome, type WriteSubtitleResult } from './subtitleWriter.js'

const outDir = () => mkdtempSync(join(tmpdir(), 'subw-'))

// C-D1 fix widened writeSubtitle's return type to a WriteSubtitleOutcome union (a >1-entry zip
// with no selectFileName now returns {needsSelection: true, entries} instead of writing). Most
// assertions below only ever expect the written-result branch — this narrows that branch once so
// they can keep accessing path/bytes/encoding/alreadyExists directly, with zero semantic change.
const asWritten = (o: WriteSubtitleOutcome): WriteSubtitleResult => {
  if ('needsSelection' in o) throw new Error('unexpected needsSelection')
  return o
}

// 用于模拟"原子写入的最后一步（rename）崩溃"：真正的进程崩溃无法在测试里重现，
// 但可以让 renameSync 在被调用一次后抛错，观察崩溃发生在 rename 之前 vs 之后的落盘状态。
let renameShouldFailOnce = false
// 用于模拟"raw writeSync 短写"：真正的短写（内核只接受部分字节）在测试环境里几乎无法
// 可靠触发，但可以让被 mock 的 writeSync 在第一次调用时故意只写 1 字节并如实返回该计数，
// 观察调用方是否会用剩余字节循环补写（而不是像裸 writeFileSync 假设的那样一次写完）。
let forceShortWriteOnce = false
// 用于模拟"writeSync 返回 0"：内核在极端情况下可以对一次 write() 调用如实返回 0（写入 0
// 字节）而不报错；如果调用方不做防护，会拿着不变的 written 计数原地死循环。让被 mock 的
// writeSync 在第一次调用时强制返回 0，观察调用方是否会识别并抛错而不是空转。
let forceZeroWriteOnce = false
// 用于模拟 NAS/SMB 等文件系统上 unlink 因 EPERM/EACCES/EBUSY 失败：孤儿 .tmp 清理只是
// best-effort，失败不应把"文件已存在"的良性短路变成整次调用的硬失败。
let forceUnlinkThrowOnce = false
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
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (forceUnlinkThrowOnce) {
        forceUnlinkThrowOnce = false
        throw Object.assign(new Error('simulated EBUSY on unlink'), { code: 'EBUSY' })
      }
      return actual.unlinkSync(...args)
    },
    writeSync: (...args: unknown[]) => {
      if (forceZeroWriteOnce && Buffer.isBuffer(args[1])) {
        forceZeroWriteOnce = false
        const [fd, buffer, offset] = args as [number, Buffer, number?, number?]
        return actual.writeSync(fd, buffer, offset ?? 0, 0)
      }
      if (forceShortWriteOnce && Buffer.isBuffer(args[1])) {
        forceShortWriteOnce = false
        const [fd, buffer, offset, length] = args as [number, Buffer, number?, number?]
        const fullLength = length ?? buffer.length - (offset ?? 0)
        const shortLength = Math.min(1, fullLength)
        return actual.writeSync(fd, buffer, offset ?? 0, shortLength)
      }
      return (actual.writeSync as (...a: unknown[]) => number)(...args)
    },
  }
})

describe('writeSubtitle', () => {
  it('writes a plain utf-8 srt with Jellyfin naming', async () => {
    const dir = outDir()
    const r = asWritten(await writeSubtitle({
      artifact: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n你好\n'),
      artifactFilename: 'sub.srt',
      videoFilename: 'The.Matrix.1999.1080p.BluRay.x264.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    }))
    expect(r.path).toBe(join(dir, 'The.Matrix.1999.1080p.BluRay.x264.zh-Hans.srt'))
    expect(existsSync(r.path)).toBe(true)
    expect(r.encoding).toBe('utf-8')
  })

  // A2: langTag was typed 'zh-Hans' | 'zh-Hant' — locked out any non-Chinese language at the type
  // level even though the naming logic below never assumed Chinese. Widened to `string` so a
  // caller can write e.g. an English subtitle with the same Jellyfin-naming convention.
  it('accepts a non-Chinese langTag (e.g. "en") with the same Jellyfin naming convention', async () => {
    const dir = outDir()
    const r = asWritten(await writeSubtitle({
      artifact: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n'),
      artifactFilename: 'sub.srt',
      videoFilename: 'The.Matrix.1999.1080p.BluRay.x264.mkv',
      langTag: 'en',
      outDir: dir,
    }))
    expect(r.path).toBe(join(dir, 'The.Matrix.1999.1080p.BluRay.x264.en.srt'))
    expect(existsSync(r.path)).toBe(true)
  })

  // 审计三轮 R3：zip 炸弹双闸（声明值 + 解压后实际值）此前零测试——这是面向灰色字幕站
  // （zimuku/subhd）的关键防线，被删掉也不会有测试变红。这里在真实 zip 的中央目录里把
  // "解压后大小"字段改写成 64MB（数据仍然极小），锁住"声明超限即拒绝"的第一道闸。
  it('rejects a zip entry whose declared uncompressed size exceeds the 32MB cap (zip bomb 第一道闸)', async () => {
    const zip = new AdmZip()
    zip.addFile('bomb.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\ntiny\n'))
    const buf = zip.toBuffer()
    // 篡改所有 local file header (PK\x03\x04) 与 central directory (PK\x01\x02) 里的
    // uncompressed-size 字段（分别位于各自签名后 +22 / +24 偏移），伪装成 64MB。
    const FAKE = 64 * 1024 * 1024
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b) {
        if (buf[i + 2] === 0x03 && buf[i + 3] === 0x04 && i + 26 <= buf.length) buf.writeUInt32LE(FAKE, i + 22)
        if (buf[i + 2] === 0x01 && buf[i + 3] === 0x02 && i + 28 <= buf.length) buf.writeUInt32LE(FAKE, i + 24)
      }
    }
    await expect(writeSubtitle({
      artifact: buf,
      artifactFilename: 'pack.zip',
      videoFilename: 'Movie.mkv',
      langTag: 'zh-Hans',
      outDir: outDir(),
    })).rejects.toThrow(/zip bomb/)
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
    if ('needsSelection' in r) throw new Error('expected a written result, not needsSelection')
    expect(readFileSync(r.path, 'utf8')).toContain('Title: right')
    expect(r.path.endsWith('Movie.2020.zh-Hans.ass')).toBe(true)
  })

  // C-D1 fix: a zip with exactly one subtitle entry is zero-friction — no selectFileName needed,
  // it is picked directly (unchanged behavior; only the >1-entries-with-no-selection case changes).
  it('picks the sole entry directly when a zip has exactly one subtitle file and no selectFileName is given', async () => {
    const zip = new AdmZip()
    zip.addFile('only.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nsolo\n'))
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: zip.toBuffer(),
      artifactFilename: 'pack.zip',
      videoFilename: 'Movie.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    if ('needsSelection' in r) throw new Error('expected a written result, not needsSelection')
    expect(readFileSync(r.path, 'utf8')).toContain('solo')
    expect(r.path.endsWith('Movie.zh-Hans.srt')).toBe(true)
  })

  // 季包 zip 自动安全选择：视频季集号恰好只匹配包内一条字幕时直接取它；
  // 匹配 0 条或 2 条都不猜，仍返回条目清单交给 agent。
  it('multi-entry zip auto-selects the uniquely matching SxxExx entry and writes it', async () => {
    const zip = new AdmZip()
    zip.addFile('Show.S01E01.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep1\n'))
    zip.addFile('Show.S01E02.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep2\n'))
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: zip.toBuffer(),
      artifactFilename: 'pack.zip',
      videoFilename: 'Show.S01E01.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    if ('needsSelection' in r) throw new Error('expected auto-selected write')
    expect(readFileSync(r.path, 'utf8')).toContain('ep1')
    expect(r.path.endsWith('Show.S01E01.zh-Hans.srt')).toBe(true)
  })

  it('returns needsSelection when the video episode key is missing or ambiguous', async () => {
    const zip = new AdmZip()
    zip.addFile('Show.S01E01.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep1\n'))
    zip.addFile('Show.S01E02.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep2\n'))
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: zip.toBuffer(),
      artifactFilename: 'pack.zip',
      videoFilename: 'Show.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    expect(r).toEqual({ needsSelection: true, entries: ['Show.S01E01.srt', 'Show.S01E02.srt'] })
    expect(readdirSync(dir)).toEqual([])
  })

  // Selection-then-write follow-up: once the agent knows the entry list, selectFileName picks the
  // exact episode out of a multi-entry pack (not just the 2-entry wrong/right shape already covered
  // above) and it writes normally.
  it('writes the selected entry out of a multi-entry zip once selectFileName is given', async () => {
    const zip = new AdmZip()
    zip.addFile('Show.S01E01.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep1\n'))
    zip.addFile('Show.S01E02.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nep2\n'))
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: zip.toBuffer(),
      artifactFilename: 'pack.zip',
      selectFileName: 'Show.S01E02.srt',
      videoFilename: 'Show.S01E02.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    if ('needsSelection' in r) throw new Error('expected a written result, not needsSelection')
    expect(readFileSync(r.path, 'utf8')).toContain('ep2')
    expect(r.path.endsWith('Show.S01E02.zh-Hans.srt')).toBe(true)
  })

  it('converts GB18030 to utf-8 and records original encoding', async () => {
    const gbk = iconv.encode('1\n00:00:01,000 --> 00:00:02,000\n黑客帝国经典台词测试字幕内容\n', 'gb18030')
    const dir = outDir()
    const r = asWritten(await writeSubtitle({
      artifact: gbk, artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    }))
    expect(readFileSync(r.path, 'utf8')).toContain('黑客帝国')
    expect(r.encoding?.toLowerCase()).not.toBe('utf-8')
  })

  it('refuses to overwrite an existing file', async () => {
    const dir = outDir()
    writeFileSync(join(dir, 'Movie.zh-Hans.srt'), 'existing')
    const r = asWritten(await writeSubtitle({
      artifact: Buffer.from('new'), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    }))
    expect(r.alreadyExists).toBe(true)
    expect(readFileSync(join(dir, 'Movie.zh-Hans.srt'), 'utf8')).toBe('existing')
    // 无残留临时文件时，短路分支不应凭空创建任何文件
    expect(readdirSync(dir)).toEqual(['Movie.zh-Hans.srt'])
  })

  it('sweeps a stale sibling .tmp orphan when the final path already exists, without touching the final file', async () => {
    // 场景：某次写入在 rename 前崩溃（或最终路径被别的来源写入），留下这个 writer 自己
    // 命名规则产生的 <finalPath>.tmp 垃圾文件。下一次调用命中 existsSync 短路分支时，
    // 应清理这个孤儿临时文件，但绝不能碰最终文件本身的内容。
    const dir = outDir()
    const finalPath = join(dir, 'Movie.zh-Hans.srt')
    const tmpPath = `${finalPath}.tmp`
    writeFileSync(finalPath, 'existing final content')
    writeFileSync(tmpPath, 'orphaned partial write')

    const r = asWritten(await writeSubtitle({
      artifact: Buffer.from('new'), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    }))

    expect(r.alreadyExists).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe('existing final content')
    expect(existsSync(tmpPath)).toBe(false)
  })

  it('never touches unrelated files or a differently-named sibling temp file while sweeping the orphan', async () => {
    const dir = outDir()
    const finalPath = join(dir, 'Movie.zh-Hans.srt')
    const tmpPath = `${finalPath}.tmp`
    const unrelatedFile = join(dir, 'notes.txt')
    // 同前缀但不同 langTag 的另一部字幕临时文件——不是本次目标的孤儿，绝不能被清理
    const otherTargetTmp = join(dir, 'Movie.zh-Hant.srt.tmp')
    writeFileSync(finalPath, 'existing final content')
    writeFileSync(tmpPath, 'orphaned partial write')
    writeFileSync(unrelatedFile, 'unrelated')
    writeFileSync(otherTargetTmp, 'not our orphan')

    await writeSubtitle({
      artifact: Buffer.from('new'), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    })

    expect(existsSync(tmpPath)).toBe(false)
    expect(readFileSync(unrelatedFile, 'utf8')).toBe('unrelated')
    expect(readFileSync(otherTargetTmp, 'utf8')).toBe('not our orphan')
  })

  it('swallows a failing unlinkSync during orphan cleanup so the already-exists short-circuit still succeeds', async () => {
    // 场景：孤儿 .tmp 清理命中一个会抛错的文件系统（NAS/SMB 上常见的 EPERM/EACCES/EBUSY）。
    // 清理只是 best-effort，绝不能把"文件已存在"这一良性状态变成整次调用抛错。
    const dir = outDir()
    const finalPath = join(dir, 'Movie.zh-Hans.srt')
    const tmpPath = `${finalPath}.tmp`
    writeFileSync(finalPath, 'existing final content')
    writeFileSync(tmpPath, 'orphaned partial write')

    forceUnlinkThrowOnce = true
    const r = asWritten(await writeSubtitle({
      artifact: Buffer.from('new'), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    }))

    expect(r.alreadyExists).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe('existing final content')
  })

  it('passes through an OpenSubtitles-style bare .srt (no zip) with correct naming, uppercase ext tolerated', async () => {
    // OpenSubtitles 下载是裸 UTF-8 .srt 而非 zip——必须原样直通，不做 zip 解析
    const dir = outDir()
    const body = '1\n00:00:01,000 --> 00:00:02,000\n和平使者第一集\n'
    const r = asWritten(await writeSubtitle({
      artifact: Buffer.from(body),
      artifactFilename: 'Peacemaker.S01E01.chs.SRT',
      videoFilename: 'Peacemaker.S01E01.2160p.WEB.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    }))
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

  afterEach(() => {
    renameShouldFailOnce = false
    forceShortWriteOnce = false
    forceZeroWriteOnce = false
    forceUnlinkThrowOnce = false
  })

  it('loops on a short writeSync so a partial kernel write never fsyncs+renames a truncated file', async () => {
    const dir = outDir()
    const body = '1\n00:00:01,000 --> 00:00:02,000\nfull content that is definitely longer than one byte\n'

    forceShortWriteOnce = true
    const r = asWritten(await writeSubtitle({
      artifact: Buffer.from(body), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    }))

    expect(r.alreadyExists).toBe(false)
    expect(r.bytes).toBe(Buffer.byteLength(body))
    expect(readFileSync(r.path, 'utf8')).toBe(body)
  })

  it('throws instead of spinning forever when writeSync reports 0 bytes written', async () => {
    const dir = outDir()
    const body = '1\n00:00:01,000 --> 00:00:02,000\nfull content that is definitely longer than one byte\n'

    forceZeroWriteOnce = true
    await expect(writeSubtitle({
      artifact: Buffer.from(body), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    })).rejects.toThrow(/wrote 0 bytes|zero bytes/i)
  })

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
    const r = asWritten(await writeSubtitle({
      artifact: Buffer.from(body), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    }))
    expect(r.alreadyExists).toBe(false)
    expect(existsSync(finalPath)).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe(body)
  })

  it('sanitizes path-traversal videoFilename and stays inside outDir', async () => {
    const dir = outDir()
    const { resolve } = await import('node:path')
    const r = asWritten(await writeSubtitle({
      artifact: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n'),
      artifactFilename: 'sub.srt',
      videoFilename: '../../../../tmp/EVIL-INJECTED.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    }))
    expect(r.path.startsWith(resolve(dir))).toBe(true)
    expect(r.path.endsWith('EVIL-INJECTED.zh-Hans.srt')).toBe(true)
  })
})
