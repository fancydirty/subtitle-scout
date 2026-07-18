import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
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

  // C-3（状态收敛,批③a）：副本旁边磁盘上已经有一份字幕文件（比如用户亲手放的 sidecar，它不在
  // DB 里——副本走 ingest 的 addItemFile 分支不做 sidecar 探测）——绝不能用主文件的字幕覆盖它,
  // 但文件名能识别出语言 tag 时应该登记账（让 itemFileCoverage/buildLocalCandidates 看得见它），
  // 不是永远视而不见（这一点是本批修复：此前无条件跳过不登记）。
  it('目标位置磁盘上已有文件、文件名能识别出语言 tag → 绝不覆盖，但登记为预置字幕（C-3 状态收敛）', async () => {
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
    // 识别出 zh-Hans → 登记为预置字幕（这次能猜对，不该继续装看不见）
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([
      { id: expect.any(Number), path: userSidecar, language: 'zh-Hans' },
    ])
    expect(logs.some((l) => l.includes('识别出语言'))).toBe(true)
  })

  // 同上，换一个不同的 tag + ext（zh-Hant/.ass）验证不是只认 zh-Hans/.srt 这一种组合。
  it('副本旁已有 <replica>.zh-Hant.ass（不同 tag/ext 组合）→ 同样识别登记（C-3 泛化）', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hant.ass')
    const userSidecar = join(root, 'Show.4K.zh-Hant.ass')
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, 'MAIN subtitle content')
    writeFileSync(userSidecar, 'USER hand-placed subtitle — must survive')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'zh-Hant', 'scout-download', 1000)

    await propagateSubtitleToReplica(deps(async () => 1420), 'e1', mainPath, replicaPath, 2000)

    expect(readFileSync(userSidecar, 'utf8')).toBe('USER hand-placed subtitle — must survive')
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([
      { id: expect.any(Number), path: userSidecar, language: 'zh-Hant' },
    ])
  })

  // 识别不出语言 tag（裸名/非标准）时——"宁停不猜"仍然成立，保持跳过 + warn，不登记。
  it('目标位置磁盘上已有文件、文件名无法识别出语言 tag（裸名）→ 跳过不登记，落 warn 日志（C-3 反面）', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    // 主文件字幕行故意登记一个非标准 language 值（legacy 脏数据场景），令 destPath 落在一个
    // KNOWN_LANGUAGE_TAGS 之外的裸名上——foo 不是任何已知 tag。
    const mainSubPath = join(root, 'Show.1080p.foo.srt')
    const userSidecar = join(root, 'Show.4K.foo.srt')
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, 'MAIN subtitle content')
    writeFileSync(userSidecar, 'USER hand-placed subtitle — must survive')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'foo', 'scout-download', 1000)

    await propagateSubtitleToReplica(deps(async () => 1420), 'e1', mainPath, replicaPath, 2000)

    expect(readFileSync(userSidecar, 'utf8')).toBe('USER hand-placed subtitle — must survive')
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([])
    expect(logs.some((l) => l.includes('目标位置已有文件'))).toBe(true)
    expect(logs.some((l) => l.includes('WARN'))).toBe(true)
  })

  // H5（2026-07-18 数据安全审计——TOCTOU + 悬空符号链接防线）：目标位置是一个悬空符号链接
  // （链接本身存在，但指向的目标文件不存在）——旧的 existsSync(destPath) 预检对悬空链接返回
  // false（误判"不存在"），copyFile（无 flag）会跟随链接把主文件的字幕内容写到链接指向的任意
  // 位置，哪怕那在媒体目录之外。COPYFILE_EXCL 必须在 open() 层面直接拒绝——目标 dirent 已存在
  // （哪怕是悬空链接）就 EEXIST，从不穿透写入链接目标。
  it('目标位置是悬空符号链接（existsSync 会误判为不存在）→ 不穿透写到链接目标，跳过不覆盖', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, 'MAIN subtitle content — must never leak through the dangling symlink')

    const outsideDir = mkdtempSync(join(tmpdir(), 'scout-subtitle-propagate-outside-'))
    const escapedTarget = join(outsideDir, 'escaped.srt') // dangling target — never created
    const destPath = join(root, 'Show.4K.zh-Hans.srt')
    symlinkSync(escapedTarget, destPath) // destPath itself is a dangling symlink

    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'zh-Hans', 'scout-download', 1000)

    try {
      await propagateSubtitleToReplica(deps(async () => 1420), 'e1', mainPath, replicaPath, 2000)

      // never wrote through the dangling link to somewhere outside the media root
      expect(existsSync(escapedTarget)).toBe(false)
      // not registered in the DB either (宁停不猜——同磁盘手放 sidecar 的既有纪律)
      expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([])
      expect(logs.some((l) => l.includes('目标位置已有文件'))).toBe(true)
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  // B3-5（批③顺手小件）：批①把 EEXIST 分支改成"跳过不登记"（宁停不猜，保留），但旧日志措辞
  // 只说"跳过不覆盖"，没说清后果——这类文件会永久卡在"磁盘有文件但 DB 不知道"，运维排查覆盖率
  // 缺口时容易漏看。日志必须升级为含"该文件存在但未登记，不会计入覆盖"的明确警示措辞。
  it('B3-5：EEXIST 分支日志含新警示措辞——"该文件存在但未登记，不会计入覆盖"（用无法识别语言的文件名，走 C-3 warn 分支）', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    const mainSubPath = join(root, 'Show.1080p.foo.srt')
    const userSidecar = join(root, 'Show.4K.foo.srt') // 副本旁用户手放的字幕，DB 里没有这行，tag 非标准
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, 'MAIN subtitle content')
    writeFileSync(userSidecar, 'USER hand-placed subtitle')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'foo', 'scout-download', 1000)

    await propagateSubtitleToReplica(deps(async () => 1420), 'e1', mainPath, replicaPath, 2000)

    expect(logs.some((l) => l.includes('该文件存在但未登记') && l.includes('不会计入覆盖'))).toBe(true)
    // 旧断言仍然成立——新措辞是升级，不是替换（其它测试仍按这个子串断言）。
    expect(logs.some((l) => l.includes('目标位置已有文件'))).toBe(true)
  })
})

// B3-4（专项#1，判决指纹记忆化，schema v17 item_files.duration_verdict/verdict_fingerprint）：
// mismatch/probe-failed 判决落地后，只要主副两个文件的 (mtimeMs,size) 快照没变，第二次调用必须
// 直接短路——不重新真的探测（生产实证：SPY×FAMILY 13 集×2 探测/每 pass 的探测空转）。文件被替换
// （重新下载/修复损坏文件，mtime/size 变了）时旧判决必须失效，照常重新真实探测。
describe('propagateSubtitleToReplica — B3-4 判决指纹记忆化（mismatch/probe-failed 不再每轮重新探测）', () => {
  function setupMainWithSub(mainPath: string, replicaPath: string, mainSubPath: string) {
    writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
    writeFileSync(mainSubPath, 'content')
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'covered' })
    lib.addItemFile('e1', replicaPath, 1000)
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('e1', mainSubPath, 'zh-Hans', 'scout-download', 1000)
  }

  it('时长不匹配判过一次后，文件指纹不变 → 第二次调用不再重新探测（静默短路）', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.Extended.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    setupMainWithSub(mainPath, replicaPath, mainSubPath)

    const stats = new Map<string, { mtimeMs: number; size: number }>([
      [mainPath, { mtimeMs: 5000, size: 100 }],
      [replicaPath, { mtimeMs: 6000, size: 200 }],
    ])
    const statFile = (p: string) => stats.get(p) ?? null
    const probeDuration = vi.fn(async (p: string) => (p === mainPath ? 1420 : 1620)) // 差 200s，远超容差

    await propagateSubtitleToReplica({ ...deps(probeDuration), statFile }, 'e1', mainPath, replicaPath, 2000)
    expect(probeDuration).toHaveBeenCalledTimes(2)
    expect(logs.some((l) => l.includes('时长不一致'))).toBe(true)

    probeDuration.mockClear()
    logs.length = 0

    await propagateSubtitleToReplica({ ...deps(probeDuration), statFile }, 'e1', mainPath, replicaPath, 3000)

    expect(probeDuration).not.toHaveBeenCalled() // 指纹未变——沿用旧判决，不重新探测
    expect(logs).toEqual([]) // 静默短路，不刷屏
    expect(lib.listSubtitlesForFile('e1', replicaPath, false)).toEqual([]) // 仍然没有复制成功
  })

  it('探测失败判过一次后，文件指纹不变 → 第二次调用不再重新探测（同一套记忆机制）', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.4K.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    setupMainWithSub(mainPath, replicaPath, mainSubPath)

    const stats = new Map<string, { mtimeMs: number; size: number }>([
      [mainPath, { mtimeMs: 5000, size: 100 }],
      [replicaPath, { mtimeMs: 6000, size: 200 }],
    ])
    const statFile = (p: string) => stats.get(p) ?? null
    const probeDuration = vi.fn(async (p: string) => (p === mainPath ? 1420 : null)) // 副本探测失败

    await propagateSubtitleToReplica({ ...deps(probeDuration), statFile }, 'e1', mainPath, replicaPath, 2000)
    expect(probeDuration).toHaveBeenCalledTimes(2)
    expect(logs.some((l) => l.includes('时长探测失败'))).toBe(true)

    probeDuration.mockClear()
    logs.length = 0

    await propagateSubtitleToReplica({ ...deps(probeDuration), statFile }, 'e1', mainPath, replicaPath, 3000)

    expect(probeDuration).not.toHaveBeenCalled()
    expect(logs).toEqual([])
  })

  it('副本文件被替换（mtime/size 变化）→ 判决记忆失效，照常重新真实探测（这次匹配则正常复制）', async () => {
    const mainPath = join(root, 'Show.1080p.mkv')
    const replicaPath = join(root, 'Show.Extended.mkv')
    const mainSubPath = join(root, 'Show.1080p.zh-Hans.srt')
    setupMainWithSub(mainPath, replicaPath, mainSubPath)

    const stats = new Map<string, { mtimeMs: number; size: number }>([
      [mainPath, { mtimeMs: 5000, size: 100 }],
      [replicaPath, { mtimeMs: 6000, size: 200 }],
    ])
    const statFile = (p: string) => stats.get(p) ?? null
    const probeDuration = vi.fn(async (p: string) => (p === mainPath ? 1420 : 1620)) // 第一次：不匹配

    await propagateSubtitleToReplica({ ...deps(probeDuration), statFile }, 'e1', mainPath, replicaPath, 2000)
    expect(probeDuration).toHaveBeenCalledTimes(2)

    // 副本被替换（重新下载/修了个新压制）——mtime/size 变了，这次真实时长其实匹配了。
    stats.set(replicaPath, { mtimeMs: 9000, size: 999 })
    probeDuration.mockImplementation(async () => 1420)

    await propagateSubtitleToReplica({ ...deps(probeDuration), statFile }, 'e1', mainPath, replicaPath, 3000)

    expect(probeDuration).toHaveBeenCalledTimes(4) // 2（第一轮真探测）+ 2（指纹变了，第二轮又真探测）
    const destPath = join(root, 'Show.Extended.zh-Hans.srt')
    expect(existsSync(destPath)).toBe(true) // 重判后确实匹配 → 正常复制成功
  })
})
