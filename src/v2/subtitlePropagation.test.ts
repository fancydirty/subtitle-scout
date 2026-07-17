import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type ScoutDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { propagateSubtitleToReplica } from './subtitlePropagation.js'

// 重复源 P4b："复制优先"机械通道——真实临时文件（不 mock fs），真实 in-memory DB，只
// probeDuration 注入固定值（同 IngestDeps.probe 的既有测试约定，从不真的 spawn ffprobe）。
let root: string
let db: ScoutDb
let lib: LibraryRepo
let logs: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scout-subtitle-propagate-'))
  db = openDb(':memory:')
  lib = new LibraryRepo(db)
  logs = []
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function deps(probeDuration: (p: string) => Promise<number | null>) {
  return { lib, probeDuration, log: (msg: string) => logs.push(msg) }
}

describe('propagateSubtitleToReplica', () => {
  it('主文件已有字幕、副本没有、时长接近 → 复制改名装到副本身边 + 挂 file_path 归属的字幕行', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, '1\n00:00:01,000 --> 00:00:02,000\nhello\n')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'zh-Hans', 'scout-download', 1000)

    const probeDuration = vi.fn(async (p: string) => (p === mainPath ? 1420 : 1418))
    await propagateSubtitleToReplica(deps(probeDuration), 'e1', mainPath, replicaPath, 2000)

    const destPath = join(root, 'Show.4K.zh-Hans.srt')
    expect(existsSync(destPath)).toBe(true)
    expect(readFileSync(destPath, 'utf8')).toContain('hello')
    const rows = lib.listSubtitlesForFile('e1', replicaPath, false)
    expect(rows).toEqual([{ id: expect.any(Number), path: destPath, language: 'zh-Hans' }])
  })

  it('主文件挂了多个语言的字幕 → 每个语言各自复制一份到副本身边', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    const hansPath = join(root, 'Show.1080p.zh-Hans.srt')
    const hantPath = join(root, 'Show.1080p.zh-Hant.srt')
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(hansPath, 'hans content'); writeFileSync(hantPath, 'hant content')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', hansPath, 'zh-Hans', 'scout-download', 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', hantPath, 'zh-Hant', 'scout-download', 1000)

    await propagateSubtitleToReplica(deps(async () => 1420), 'e1', mainPath, replicaPath, 2000)

    expect(existsSync(join(root, 'Show.4K.zh-Hans.srt'))).toBe(true)
    expect(existsSync(join(root, 'Show.4K.zh-Hant.srt'))).toBe(true)
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toHaveLength(2)
  })

  it('时长差超过容差（不同剪辑版本嫌疑）→ 不复制，落 log 说明', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.Extended.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, 'content')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'zh-Hans', 'scout-download', 1000)

    const probeDuration = vi.fn(async (p: string) => (p === mainPath ? 1420 : 1620)) // 差 200s，远超 5s 容差
    await propagateSubtitleToReplica(deps(probeDuration), 'e1', mainPath, replicaPath, 2000)

    expect(existsSync(join(root, 'Show.Extended.zh-Hans.srt'))).toBe(false)
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([])
    expect(logs.some((l) => l.includes('时长不一致'))).toBe(true)
  })

  it('任一时长探测失败（ffprobe 缺席/超时）→ 宁停不猜，不复制', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, 'content')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'zh-Hans', 'scout-download', 1000)

    const probeDuration = vi.fn(async (p: string) => (p === mainPath ? 1420 : null))
    await propagateSubtitleToReplica(deps(probeDuration), 'e1', mainPath, replicaPath, 2000)

    expect(existsSync(join(root, 'Show.4K.zh-Hans.srt'))).toBe(false)
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([])
    expect(logs.some((l) => l.includes('时长探测失败'))).toBe(true)
  })

  it('主文件自己也没字幕 → 没有可传播的东西，直接返回，不探测时长', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'missing' })
    lib.addItemFile('e1', replicaPath, 1000)

    const probeDuration = vi.fn(async () => 1420)
    await propagateSubtitleToReplica(deps(probeDuration), 'e1', mainPath, replicaPath, 2000)

    expect(probeDuration).not.toHaveBeenCalled()
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([])
  })

  it('副本已经有字幕（不论来源）→ 幂等短路，不重新探测/复制', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, 'content')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'zh-Hans', 'scout-download', 1000)
    // 副本已经用别的手段（比如 agent 判断安装）挂上了一份字幕
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, file_path, created_at) VALUES (?,?,?,?,?,?)`)
      .run('e1', join(root, 'Show.4K.en.srt'), 'en', 'scout-download', replicaPath, 1500)

    const probeDuration = vi.fn(async () => 1420)
    await propagateSubtitleToReplica(deps(probeDuration), 'e1', mainPath, replicaPath, 2000)

    expect(probeDuration).not.toHaveBeenCalled()
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toHaveLength(1) // 还是原来那一份，没被追加
  })

  it('复制失败（目标目录不可写等）→ best-effort 落 log，不抛出，不写字幕行', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    // 副本落在一个不存在的子目录下——copyFile 目标目录不存在会失败
    const replicaPath = join(root, 'no-such-dir', 'Show.4K.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    writeFileSync(mainPath, 'video')
    writeFileSync(mainSubPath, 'content')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'zh-Hans', 'scout-download', 1000)

    await expect(
      propagateSubtitleToReplica(deps(async () => 1420), 'e1', mainPath, replicaPath, 2000),
    ).resolves.toBeUndefined()

    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([])
    expect(logs.some((l) => l.includes('复制失败'))).toBe(true)
  })

  // 数据损失防线：副本旁边磁盘上已经有一份字幕文件（比如用户亲手放的 sidecar，它不在 DB 里——
  // 副本走 ingest 的 addItemFile 分支不做 sidecar 探测）——绝不能用主文件的字幕覆盖它。
  it('目标位置磁盘上已有文件（未登记 DB 的手放 sidecar）→ 绝不覆盖，跳过并落 log，不写字幕行', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    const userSidecar = join(root, 'Show.4K.zh-Hans.srt') // 副本旁用户手放的字幕，DB 里没有这行
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, 'MAIN subtitle content')
    writeFileSync(userSidecar, 'USER hand-placed subtitle — must survive')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'zh-Hans', 'scout-download', 1000)

    await propagateSubtitleToReplica(deps(async () => 1420), 'e1', mainPath, replicaPath, 2000)

    // 用户那份字幕原样活着——没被主文件字幕覆盖
    expect(readFileSync(userSidecar, 'utf8')).toBe('USER hand-placed subtitle — must survive')
    // 不猜它的归属，不登记进 DB（宁停不猜）
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([])
    expect(logs.some((l) => l.includes('目标位置已有文件'))).toBe(true)
  })
})
