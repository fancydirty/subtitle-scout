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

  // 审校 F14：原测试名声称"同一事务"，但它只观察了"两张表都被清了"——把 files 的 DELETE
  // 挪到 tx.immediate() 之后，这条断言依然全绿。真正的原子性要制造中途失败看回滚。
  // 这里改成两条：一条如实只测"级联覆盖两代表"，一条真测回滚。
  it('级联覆盖新旧两代表（files 与旧表都被清，计数都如实回显）', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/tv', NOW)
    seedFile(db, '/media/tv/A.mkv')
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
    expect(repo.listRoots()).toEqual([])
  })

  it('中途失败 → 全部回滚，files 与旧表和根登记同进同退（真原子性）', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/tv', NOW)
    seedFile(db, '/media/tv/A.mkv')

    // 在事务中途制造失败：让 tmdb_seasons 变成不可写（DROP 掉它，级联清理时会抛
    // "no such table"）。这样 files 的 DELETE 已执行、media_roots 的 DELETE 还没到，
    // 若不在同一事务里就会留下"files 清了但根还在"的半清状态。
    db.prepare('INSERT INTO series (id, name) VALUES (?, ?)').run('tmdb:1', 'S')
    db.prepare(
      `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
       VALUES (?, 'tmdb:1', 1, 1, 'E1', ?, 'missing', ?)`,
    ).run('tmdb:1/s1e1', '/media/tv/S/e1.mkv', NOW)
    db.exec('DROP TABLE tmdb_seasons')

    expect(() => repo.removeRoot('/media/tv')).toThrow()
    // 回滚证据：files 行、旧表行、根登记全都还在
    expect(filePaths(db)).toEqual(['/media/tv/A.mkv'])
    expect(
      (db.prepare('SELECT COUNT(*) c FROM episodes').get() as { c: number }).c,
    ).toBe(1)
    expect(repo.listRoots().map((r) => r.path)).toEqual(['/media/tv'])
  })

  it('守备目录下没有 files 行时，files 计数为 0 且不抛', () => {
    const { db, repo } = setup()
    repo.addRoot('/media/tv', NOW)
    const result = repo.removeRoot('/media/tv')
    expect(result!.files).toBe(0)
    expect(filePaths(db)).toEqual([])
  })

  // ── 审校 F8（2026-08-08）：removeRoot('/') 把整表清光 ──
  // prefix = path.endsWith('/') ? path : path + '/'。当 path === '/' 时 prefix 就是 '/'，
  // 而 substr(path,1,1) = '/' 对**每一条绝对路径**都为真 → files/episodes/movies/parked
  // 全表清空，包括那些属于**其他仍然有效的守备目录**的行。
  //
  // 真实剧本（实测确认）：库里存量有 '/' 与 '/media/tv' 并存（闸门上线前配的），
  // 1a-3 的告警正好引导用户去删掉 '/'（detectNested 的用例里就有这一对）——
  // 照着警告操作，/media/tv 下所有 files 行被清空，而它还是守备目录 →
  // 下轮巡检全库重识别 + 重找字幕，烧一整轮 LLM。
  it("移除 '/' 只清它自己名下的行，不波及其他守备目录（F8 防毁库）", () => {
    const { db, repo } = setup()
    // 绕过闸门模拟历史遗留（闸门上线后不可能这么配，但存量库有）
    const ins = db.prepare("INSERT INTO media_roots (path, type, added_at) VALUES (?, 'local', ?)")
    ins.run('/', NOW)
    ins.run('/media/tv', NOW + 1)
    seedFile(db, '/media/tv/keep.mkv')  // 归 /media/tv 管，不该被删
    seedFile(db, '/loose.mkv')          // 直接躺在 / 下，该被删

    const result = repo.removeRoot('/')
    expect(result).not.toBeNull()
    // 只删真正归 '/' 管的那一行
    expect(result!.files).toBe(1)
    expect(filePaths(db)).toEqual(['/media/tv/keep.mkv'])
    // /media/tv 仍是守备目录，它的数据必须完好
    expect(repo.listRoots().map((r) => r.path)).toEqual(['/media/tv'])
  })

  it("移除 '/' 时不清空旧表里属于其他守备目录的行（F8 同一漏洞面）", () => {
    const { db, repo } = setup()
    const ins = db.prepare("INSERT INTO media_roots (path, type, added_at) VALUES (?, 'local', ?)")
    ins.run('/', NOW)
    ins.run('/media/tv', NOW + 1)
    const park = db.prepare(
      `INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt)
       VALUES (?, 'test', ?, ?)`,
    )
    park.run('/media/tv/parked.mkv', NOW, NOW) // 归 /media/tv 管
    park.run('/loose-parked.mkv', NOW, NOW)    // 归 / 管

    const result = repo.removeRoot('/')
    expect(result!.parked).toBe(1)
    expect(
      (db.prepare('SELECT path FROM parked_paths').all() as { path: string }[]).map((r) => r.path),
    ).toEqual(['/media/tv/parked.mkv'])
  })
})
