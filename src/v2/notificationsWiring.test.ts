// src/v2/notificationsWiring.test.ts —— R-F3 通知表的**接线**测试。
//
// ⚠️ 为什么这个文件必须独立存在、而不是把断言塞进 notificationsRepo.test.ts：
// 本仓栽过 6 次「加了某个能力却没定谁来写/谁来读/谁来触发」（C12→C35→C43→C21→audio_langs→
// tmdb_seasons：**有表有函数但没人触发**）。notificationsRepo.test.ts 里的每一条用例都直接调
// recordFound/listRecentFound —— 那些断言在"repo 写好了但两个装盘点一行都没接"的实现下
// **全部会绿**。这正是上一个 subagent 在 tmdb_seasons 上撞到的那个形态。
//
// 故这里的每一条都**只经由生产入口**（runSubtitleWorkDir / applyTranslateOutcome / 真实
// dbMaintenance 循环），一次 recordFound 都不直接调，然后去 notifications 表里查结果。
// 把 recordFound 的调用从生产代码里删掉，本文件必须红。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import { runSubtitleWorkDir, type SubtitleQueueItem } from './subtitleScheduler.js'
import { applyTranslateOutcome } from './translateWorkerTask.js'
import { runDbMaintenance, makeMaintenanceState } from './dbMaintenance.js'
import { listRecentFound, listRecentFoundGrouped } from './notificationsRepo.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DAY = 24 * 3600_000

function mkItem(): SubtitleQueueItem {
  return {
    workId: 'tmdb:1396', title: '绝命毒师', originalTitle: 'Breaking Bad', year: 2008,
    overview: null, chineseTitles: [], mediaType: 'tv',
    files: [
      { path: '/media/TV/BB/BB - S01E03.mkv', filename: 'BB - S01E03.mkv', season: 1, episode: 3, dir: '/media/TV/BB', durationSec: 1440, embeddedLangs: null },
      { path: '/media/TV/BB/BB - S01E05.mkv', filename: 'BB - S01E05.mkv', season: 1, episode: 5, dir: '/media/TV/BB', durationSec: 1440, embeddedLangs: null },
    ],
  }
}

describe('通知表接线（谁写 / 谁读 / 何时清 —— 防"有表没人触发"）', () => {
  let db: ReturnType<typeof openDb>
  let item: SubtitleQueueItem
  beforeEach(() => {
    db = openDb(':memory:')
    item = mkItem()
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run(item.workId, item.title, 'tv', 1000, 1000)
    for (const f of item.files) {
      db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, season, episode, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(f.path, f.dir, f.filename, 100, 1000, f.dir, item.workId, 1, f.season, f.episode, 1000)
    }
  })

  // ── 写入点 ① 抓取装盘（subtitleScheduler，走真实 runSubtitleWorkDir）──────────

  it('🔴 字幕装盘成功 → 有通知记录（**经由 runSubtitleWorkDir**，不是直接调 repo）', async () => {
    const worker = async () => ({
      installed: [{
        itemId: 'tmdb:1396/s1e3', installedPath: '/media/TV/BB/BB - S01E03.zh-Hans.ass',
        installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '',
      }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const rows = listRecentFound(db, Date.now())
    expect(rows).toHaveLength(1)
    expect(rows[0].workId).toBe('tmdb:1396')
    expect(rows[0].title).toBe('绝命毒师')
    expect(rows[0].season).toBe(1)
    expect(rows[0].episode).toBe(3)
    expect(rows[0].via).toBe('fetch')
  })

  it('🔴 装盘两集 → 两条通知，且季集号取自 files 行（不是从 installedPath 猜）', async () => {
    const worker = async () => ({
      installed: [
        { itemId: 'tmdb:1396/s1e3', installedPath: '/media/TV/BB/BB - S01E03.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' },
        { itemId: 'tmdb:1396/s1e5', installedPath: '/media/TV/BB/BB - S01E05.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'y', reason: '' },
      ],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const rows = listRecentFound(db, Date.now())
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.episode).sort()).toEqual([3, 5])
  })

  it('🔴 一集都没装上 → 一条通知都不许有（"这轮没找到"不是成果 / R-F10 约束 1）', async () => {
    const worker = async () => ({
      installed: [], no_safe_match: [{ itemId: 'tmdb:1396/s1e3', reason: 'none' }],
      retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    expect(listRecentFound(db, Date.now())).toHaveLength(0)
  })

  it('🔴 worker 整体抛错 → 无通知（失败轨不许留下"找到了"的假成果）', async () => {
    const worker = async () => { throw new Error('boom') }
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    expect(listRecentFound(db, Date.now())).toHaveLength(0)
  })

  it('🔴 通知表被删也不许影响装盘回写（隔离——通知是增益，绝不反噬主流程）', async () => {
    db.exec('DROP TABLE notifications')
    const worker = async () => ({
      installed: [{ itemId: 'tmdb:1396/s1e3', installedPath: '/media/TV/BB/BB - S01E03.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    const report = await runSubtitleWorkDir(db, worker as any, item, 'zh')
    expect(report).not.toBeNull()
    // 装盘的出队凭据照旧写上了（这是隔离真正要保护的东西）
    const row = db.prepare('SELECT recheck_after FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.recheck_after).toBeGreaterThan(Date.now())
  })

  // ── 写入点 ② 翻译装盘（applyTranslateOutcome 的 installed 分支）──────────────

  it('🔴 翻译成功 → 有通知记录，且 via=translate（能与抓取来的区分开）', () => {
    const p = item.files[0].path
    db.prepare(`UPDATE files SET sub_status = 'handoff_translate' WHERE path = ?`).run(p)
    const now = 5_000_000
    applyTranslateOutcome(db, p, 'installed', now)
    const rows = listRecentFound(db, now)
    expect(rows).toHaveLength(1)
    expect(rows[0].via).toBe('translate')
    expect(rows[0].workId).toBe('tmdb:1396')
    expect(rows[0].season).toBe(1)
    expect(rows[0].episode).toBe(3)
    expect(rows[0].foundAt).toBe(now)
  })

  it('🔴 翻译失败态一律无通知（no-source / write-failed 不是成果）', () => {
    const p = item.files[0].path
    db.prepare(`UPDATE files SET sub_status = 'handoff_translate' WHERE path = ?`).run(p)
    applyTranslateOutcome(db, p, 'no-source', 5_000_000)
    expect(listRecentFound(db, 5_000_000)).toHaveLength(0)
    db.prepare(`UPDATE files SET sub_status = 'handoff_translate' WHERE path = ?`).run(p)
    applyTranslateOutcome(db, p, 'write-failed', 5_000_000)
    expect(listRecentFound(db, 5_000_000)).toHaveLength(0)
  })

  it('🔴 already-covered 不发通知（字幕本来就在盘上，不是这一轮的新成果）', () => {
    const p = item.files[0].path
    db.prepare(`UPDATE files SET sub_status = 'handoff_translate' WHERE path = ?`).run(p)
    applyTranslateOutcome(db, p, 'already-covered', 5_000_000)
    expect(listRecentFound(db, 5_000_000)).toHaveLength(0)
  })

  it('🔴 乐观守卫未命中（D10）→ 不许发通知（回写整个作废了，成果不存在）', () => {
    const p = item.files[0].path
    // 刻意**不**把 sub_status 置成 handoff_translate → 守卫匹配 0 行
    const w = applyTranslateOutcome(db, p, 'installed', 5_000_000)
    expect(w.guardMissed).toBe(true)
    expect(listRecentFound(db, 5_000_000)).toHaveLength(0)
  })

  it('🔴 翻译轨的通知表故障同样隔离（不许打断 applyTranslateOutcome 的回写）', () => {
    db.exec('DROP TABLE notifications')
    const p = item.files[0].path
    db.prepare(`UPDATE files SET sub_status = 'handoff_translate' WHERE path = ?`).run(p)
    expect(() => applyTranslateOutcome(db, p, 'installed', 5_000_000)).not.toThrow()
    const row = db.prepare('SELECT tr_recheck_after FROM files WHERE path = ?').get(p) as any
    expect(row.tr_recheck_after).toBeGreaterThan(5_000_000)
  })

  it('未识别文件（work_id 为 NULL）翻译成功 → 不写通知（没有作品维度可展示）', () => {
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, sub_status, updated_at)
                VALUES ('/media/x.mkv','/media','x.mkv',1,1,'handoff_translate',1000)`).run()
    applyTranslateOutcome(db, '/media/x.mkv', 'installed', 5_000_000)
    expect(listRecentFound(db, 5_000_000)).toHaveLength(0)
  })

  // ── 两轨汇流：前端真正要读的那个形状 ────────────────────────────────────────

  it('🔴 抓取 + 翻译混合 → 聚合成一条「S01 的第 3/5 集」（前端要的形状，全程走生产入口）', async () => {
    const worker = async () => ({
      installed: [{ itemId: 'tmdb:1396/s1e3', installedPath: '/media/TV/BB/BB - S01E03.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const p5 = item.files[1].path
    db.prepare(`UPDATE files SET sub_status = 'handoff_translate' WHERE path = ?`).run(p5)
    applyTranslateOutcome(db, p5, 'installed', Date.now())

    const groups = listRecentFoundGrouped(db, Date.now())
    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe('绝命毒师')
    expect(groups[0].season).toBe(1)
    expect(groups[0].episodes).toEqual([3, 5])
    expect(groups[0].via).toBe('mixed')
  })

  // ── 何时清：真实 dbMaintenance 循环 ─────────────────────────────────────────

  it('🔴 清理由 dbMaintenance 顺手做（**经由 runDbMaintenance**，不新起定时器）', () => {
    const now = 100 * DAY
    // 直接造两条老数据（此处不是被测行为，是被测清理的输入）
    db.prepare(`INSERT INTO notifications (work_id, title, season, episode, via, found_at) VALUES (?,?,?,?,?,?)`)
      .run('tmdb:1', '旧的', 1, 1, 'fetch', now - 30 * DAY)
    db.prepare(`INSERT INTO notifications (work_id, title, season, episode, via, found_at) VALUES (?,?,?,?,?,?)`)
      .run('tmdb:2', '新的', 1, 1, 'fetch', now - 1 * DAY)

    const cacheDir = mkdtempSync(join(tmpdir(), 'notif-maint-'))
    runDbMaintenance(db, cacheDir, makeMaintenanceState(), now)

    const left = db.prepare('SELECT title FROM notifications').all() as Array<{ title: string }>
    expect(left.map(r => r.title)).toEqual(['新的'])
  })

  it('🔴 清理跑过之后一周内的照旧可读（清理不误删 = 用户没丢成果）', () => {
    const now = 100 * DAY
    db.prepare(`INSERT INTO notifications (work_id, title, season, episode, via, found_at) VALUES (?,?,?,?,?,?)`)
      .run('tmdb:2', '新的', 1, 3, 'fetch', now - 2 * DAY)
    const cacheDir = mkdtempSync(join(tmpdir(), 'notif-maint2-'))
    runDbMaintenance(db, cacheDir, makeMaintenanceState(), now)
    expect(listRecentFound(db, now).map(r => r.title)).toEqual(['新的'])
  })

  it('🔴 通知清理失败不许拖垮 checkpoint/backup（运维器官逐个隔离的既有口径）', () => {
    db.exec('DROP TABLE notifications')
    const cacheDir = mkdtempSync(join(tmpdir(), 'notif-maint3-'))
    const r = runDbMaintenance(db, cacheDir, makeMaintenanceState(), 100 * DAY)
    expect(r.checkpointed).toBe(true)
    expect(r.backupPath).not.toBeNull()
  })
})
