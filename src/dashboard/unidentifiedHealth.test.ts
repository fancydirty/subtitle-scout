// src/dashboard/unidentifiedHealth.test.ts —— 「有几个目录我认不出来」的读出面。
//
// 本文件钉的是 unidentifiedHealth.ts 头注释里那几条**会被下一个人当成"顺手优化"改掉**的
// 裁决，尤其是：
//   ① 谓词**不含** identifyScheduler 的退避/404 条件（含 404 终态那批才是重点）；
//   ② 粒度是**目录**不是文件；
//   ③ 出目录名、**不出**绝对路径 / last_error / attempt / next_retry_at；
//   ④ 上限截断时 dirCount 仍报全量（否则前端说不出"另外还有 N 个"）。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { buildUnidentifiedHealth, MAX_LISTED_DIRS } from './unidentifiedHealth.js'

let db: ScoutDb
const NOW = 1_700_000_000_000

beforeEach(() => {
  db = openDb(':memory:')
})

function addFile(o: {
  path: string
  workDir: string
  workId?: string | null
  attempt?: number
  nextRetryAt?: number | null
  lastError?: string | null
}): void {
  db.prepare(
    `INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, attempt, next_retry_at, last_error, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.path, o.workDir, 'f.mkv', 100, NOW, o.workDir, o.workId ?? null,
    o.attempt ?? 0, o.nextRetryAt ?? null, o.lastError ?? null, NOW,
  )
}

describe('buildUnidentifiedHealth', () => {
  it('库全部已识别 → dirCount 0 且 dirs 空（沉默即好消息，前端据此整段不渲染）', () => {
    db.prepare(
      `INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).run('tmdb:1', 'Breaking Bad', 'tv', NOW, NOW)
    addFile({ path: '/m/bb/s1e1.mkv', workDir: '/m/bb', workId: 'tmdb:1' })

    expect(buildUnidentifiedHealth(db)).toEqual({ dirCount: 0, dirs: [] })
  })

  it('粒度是目录不是文件：一个目录 24 个未识别文件 → dirCount 1、fileCount 24', () => {
    for (let i = 1; i <= 24; i++) {
      addFile({ path: `/m/Unknown Show/e${i}.mkv`, workDir: '/m/Unknown Show' })
    }

    const out = buildUnidentifiedHealth(db)
    expect(out.dirCount).toBe(1)
    expect(out.dirs).toEqual([{ dirName: 'Unknown Show', fileCount: 24 }])
  })

  // 🔴 本文件最重要的一条：404 终态那批**永不再进识别队列**（identifyScheduler.ts:37
  // 的谓词把它们永久排除），恰恰是用户最需要知道的——其余的每天还会自动重试一次。
  // 若照抄调度谓词来算展示数字，这批文件在界面上也会永久消失，那正是本模块要修的病。
  it('🔴 含 tmdb-404 终态与退避窗未到的目录——谓词只看 work_id IS NULL', () => {
    addFile({
      path: '/m/Dead 404/e1.mkv', workDir: '/m/Dead 404',
      lastError: 'tmdb-404', attempt: 3, nextRetryAt: null,
    })
    addFile({
      path: '/m/Backing Off/e1.mkv', workDir: '/m/Backing Off',
      lastError: 'identify-failed', attempt: 5, nextRetryAt: NOW + 86_400_000,
    })
    addFile({ path: '/m/Fresh/e1.mkv', workDir: '/m/Fresh' })

    const out = buildUnidentifiedHealth(db)
    expect(out.dirCount).toBe(3)
    expect(out.dirs.map((d) => d.dirName).sort()).toEqual(['Backing Off', 'Dead 404', 'Fresh'])
  })

  // R-F9/R-F10：排障读数不进界面。这条断言直接钉 DTO 的**字段全集**——谁往里加
  // lastError/attempt/nextRetryAt/path，这里当场红，并在失败信息里指回那条裁决。
  it('🔴 只出 dirName + fileCount：不出绝对路径 / last_error / attempt / next_retry_at', () => {
    addFile({
      path: '/hostroot/media/test-library/TV/Mystery/e1.mkv',
      workDir: '/hostroot/media/test-library/TV/Mystery',
      lastError: 'evidence-fail: title mismatch', attempt: 7, nextRetryAt: NOW + 1,
    })

    const out = buildUnidentifiedHealth(db)
    expect(out.dirs).toHaveLength(1)
    // 字段全集恒等——多一个字段这条就红。
    expect(Object.keys(out.dirs[0]!).sort()).toEqual(['dirName', 'fileCount'])
    // 目录名是最后一段，挂载点前缀不出去（对用户零信息量，且是容器内路径）。
    expect(out.dirs[0]!.dirName).toBe('Mystery')
    const json = JSON.stringify(out)
    expect(json).not.toContain('hostroot')
    expect(json).not.toContain('evidence-fail')
    expect(json).not.toContain('test-library')
  })

  it('文件多的目录排前面（用户先看到最值得改名的那个）', () => {
    addFile({ path: '/m/Small/e1.mkv', workDir: '/m/Small' })
    for (let i = 1; i <= 5; i++) addFile({ path: `/m/Big/e${i}.mkv`, workDir: '/m/Big' })

    const out = buildUnidentifiedHealth(db)
    expect(out.dirs.map((d) => d.dirName)).toEqual(['Big', 'Small'])
  })

  it('超过上限：dirs 截断到 MAX_LISTED_DIRS，dirCount 仍报全量', () => {
    const total = MAX_LISTED_DIRS + 5
    for (let i = 0; i < total; i++) {
      addFile({ path: `/m/D${i}/e1.mkv`, workDir: `/m/D${i}` })
    }

    const out = buildUnidentifiedHealth(db)
    expect(out.dirCount).toBe(total)
    expect(out.dirs).toHaveLength(MAX_LISTED_DIRS)
  })

  it('work_dir 末尾带分隔符 → 取最后一个非空段，不返回空串', () => {
    addFile({ path: '/m/Trailing/e1.mkv', workDir: '/m/Trailing/' })

    expect(buildUnidentifiedHealth(db).dirs[0]!.dirName).toBe('Trailing')
  })
})
