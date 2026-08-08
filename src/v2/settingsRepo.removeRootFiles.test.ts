import { describe, it, expect } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import { SettingsRepo } from './settingsRepo.js'

/** D11 / C33（2026-08-08）：removeRoot 必须一起清 files 表。
 *
 *  为什么是缺口：removeRoot 级联清理了 8 张旧表（subtitles/item_files/pending_removals/
 *  episodes/movies/series/tmdb_seasons/parked_paths），但**一行 files 都不碰**（已核实）。
 *  新架构的数据在 files/works 里——留下的行成为孤儿：
 *  识别流的队列谓词只看 `work_id IS NULL`，不按守备目录过滤（C18 幽灵队列），
 *  于是会永远为一个已不在任何守备目录内的文件跑识别 agent，每天烧 TMDB + LLM，永不终止。
 *
 *  铁律（spec D11）：测试**必须走 removeRoot 真实入口**，不许直接 SQL 造删除。
 *  spec 原把这条归在"扫描删除清理"下，若用裸 SQL 测就会绿灯而生产照漏。 */
describe('removeRoot 清理 files 表（D11 / C33）', () => {
  const NOW = 1_700_000_000_000

  const setup = (): { db: ScoutDb; repo: SettingsRepo } => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    return { db, repo: new SettingsRepo(db) }
  }

  const seedFile = (db: ScoutDb, path: string): void => {
    const slash = path.lastIndexOf('/')
    db.prepare(
      `INSERT INTO files (path, dir, filename, size, mtime, updated_at)
       VALUES (?, ?, ?, 100, 1, ?)`,
    ).run(path, path.slice(0, slash), path.slice(slash + 1), NOW)
  }

  const filePaths = (db: ScoutDb): string[] =>
    (db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[])
      .map((r) => r.path)

  it('移除守备目录 → 其下 files 行被清除，返回 files 计数', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/tv', NOW)
    seedFile(db, '/media/tv/Show/S01E01.mkv')
    seedFile(db, '/media/tv/Show/S01E02.mkv')

    const result = repo.removeRoot('/media/tv')
    expect(result).not.toBeNull()
    expect(result!.files).toBe(2)
    expect(filePaths(db)).toEqual([])
  })

  it('其他守备目录下的 files 行不受影响（前缀隔离）', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/tv', NOW)
    repo.addRoot('/media/movies', NOW)
    seedFile(db, '/media/tv/Show/S01E01.mkv')
    seedFile(db, '/media/movies/Film.mkv')

    const result = repo.removeRoot('/media/tv')
    expect(result!.files).toBe(1)
    expect(filePaths(db)).toEqual(['/media/movies/Film.mkv'])
  })

  it('同名前缀不误伤：移除 /media/tv 不动 /media/tv2 下的行', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/tv', NOW)
    repo.addRoot('/media/tv2', NOW)
    seedFile(db, '/media/tv/A.mkv')
    seedFile(db, '/media/tv2/B.mkv')

    const result = repo.removeRoot('/media/tv')
    expect(result!.files).toBe(1)
    expect(filePaths(db)).toEqual(['/media/tv2/B.mkv'])
  })

  // 既有注释论证过：媒体路径可以合法含 % 和 _（"100% Pascal-sensei"、"Look_Back"），
  // LIKE 的通配符语义会把这些字面字符误当模式展开 → 误删/漏删。必须用 substr 定长比较。
  it('路径含 % 或 _ 的目录能正确清理（防 LIKE 通配符陷阱）', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/100% Pascal-sensei', NOW)
    repo.addRoot('/media/Look_Back', NOW)
    seedFile(db, '/media/100% Pascal-sensei/E01.mkv')
    seedFile(db, '/media/Look_Back/movie.mkv')

    const result = repo.removeRoot('/media/100% Pascal-sensei')
    expect(result!.files).toBe(1)
    expect(filePaths(db)).toEqual(['/media/Look_Back/movie.mkv'])
  })

  it('不是守备目录的路径 → 返回 null，files 表零改动（既有存在性守卫不破）', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/tv', NOW)
    seedFile(db, '/media/tv/Show/S01E01.mkv')

    // /media 是现存根的父目录，但它自己不是守备目录——没有守卫的话这一发 DELETE
    // 会把整个前缀下的行静默清光
    expect(repo.removeRoot('/media')).toBeNull()
    expect(filePaths(db)).toEqual(['/media/tv/Show/S01E01.mkv'])
  })

  it('files 清理与旧表清理在同一事务（无半清状态）', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/tv', NOW)
    seedFile(db, '/media/tv/A.mkv')
    // 旧表也放一行，证明两者同进同退
    db.prepare(
      `INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt)
       VALUES (?, 'test', ?, ?)`,
    ).run('/media/tv/parked.mkv', NOW, NOW)

    const result = repo.removeRoot('/media/tv')
    expect(result!.files).toBe(1)
    expect(result!.parked).toBe(1)
    expect(filePaths(db)).toEqual([])
    expect(
      (db.prepare('SELECT COUNT(*) c FROM parked_paths').get() as { c: number }).c,
    ).toBe(0)
    // 根本身也没了
    expect(repo.listRoots()).toEqual([])
  })

  it('守备目录下没有 files 行时，files 计数为 0 且不抛', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/tv', NOW)
    const result = repo.removeRoot('/media/tv')
    expect(result!.files).toBe(0)
    expect(filePaths(db)).toEqual([])
  })
})
