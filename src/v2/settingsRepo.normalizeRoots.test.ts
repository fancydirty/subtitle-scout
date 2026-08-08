import { describe, it, expect } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import { SettingsRepo } from './settingsRepo.js'

/** F2（审校发现，2026-08-08）：存量非规范守备目录的迁移。
 *
 *  Task 1a-2 给 addRoot 加了入库前 resolve() 归一化，但**只管新写入**。库里可能已有
 *  历史遗留的非规范形态（尾斜杠 '/media/tv/'、重复斜杠 '/media//tv'）——它们是在闸门
 *  上线前写进去的。
 *
 *  为什么必须迁移，而不是"比较时归一化就够了"：
 *   1. findOverlappingRoot 比较时会剥尾斜杠，所以能正确识别嵌套；但 INSERT OR IGNORE 的
 *      幂等靠的是**主键字符串相等**。存量 '/media/tv/' 与新写的 '/media/tv' 字符串不等
 *      → 两行共存（实测确认），逻辑上却是同一个目录。此后每轮扫描把同一批文件走两遍。
 *   2. 这行用户**从 UI 删不掉**：removeRoot 按 path 精确匹配，而 dashboard 传下来的路径
 *      经过 resolve() 已是规范形态，与库里的非规范字符串对不上。
 *   3. D1 的删除逻辑按守备目录逐个比对差集——两行"同一目录"会各自算一次差集。
 *
 *  迁移策略：把存量 path 逐条 resolve()；若规范形态已存在则删掉非规范那行（去重），
 *  否则原地改写。added_at 取两者较早的——"何时首次加入"是出生事实。 */
describe('存量非规范守备目录迁移（F2）', () => {
  const seedRaw = (db: ScoutDb, path: string, addedAt: number): void => {
    // 绕过 addRoot 直接写——历史遗留数据就是这么来的（闸门上线前）
    db.prepare("INSERT INTO media_roots (path, type, added_at) VALUES (?, 'local', ?)")
      .run(path, addedAt)
  }

  it('尾斜杠形态被归一化，且不与规范形态共存', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    seedRaw(db, '/media/tv/', 100)
    // 迁移已在 openDb 里跑过，这里手动触发一次归一化以模拟"库里本来就有脏数据"的启动
    new SettingsRepo(db).normalizeRoots()
    expect(new SettingsRepo(db).listRoots().map((r) => r.path)).toEqual(['/media/tv'])
  })

  it('非规范与规范形态并存时去重，保留较早的 added_at', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    seedRaw(db, '/media/tv', 100)   // 规范形态，先加入
    seedRaw(db, '/media/tv/', 200)  // 非规范形态，后加入
    new SettingsRepo(db).normalizeRoots()
    const roots = new SettingsRepo(db).listRoots()
    expect(roots).toHaveLength(1)
    expect(roots[0].path).toBe('/media/tv')
    expect(roots[0].addedAt).toBe(100) // 出生事实取较早的那个
  })

  it('重复斜杠形态同样被归一化', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    seedRaw(db, '/media//tv', 100)
    new SettingsRepo(db).normalizeRoots()
    expect(new SettingsRepo(db).listRoots().map((r) => r.path)).toEqual(['/media/tv'])
  })

  it('已规范的根不被改动（幂等，added_at 不变）', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    seedRaw(db, '/media/tv', 100)
    seedRaw(db, '/data/anime', 200)
    const repo = new SettingsRepo(db)
    repo.normalizeRoots()
    repo.normalizeRoots() // 再跑一次证明幂等
    const roots = repo.listRoots()
    expect(roots.map((r) => r.path)).toEqual(['/data/anime', '/media/tv'])
    expect(roots.find((r) => r.path === '/media/tv')!.addedAt).toBe(100)
  })

  it('归一化后本来隐藏的嵌套关系变得可检出（迁移与 D7 的接力）', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    seedRaw(db, '/media/tv/', 100)
    seedRaw(db, '/media/tv/anime', 200) // 归一化前 '/media/tv/'+sep='//' 挡不住它
    const repo = new SettingsRepo(db)
    repo.normalizeRoots()
    // 迁移本身不删嵌套根（那是用户的配置，程序不擅自改），但归一化后 detectNestedRoots
    // （Task 1a-3）能看见它们。这里只断言归一化到位、两行都还在。
    expect(repo.listRoots().map((r) => r.path)).toEqual(['/media/tv', '/media/tv/anime'])
  })

  it('空表 → 空操作，不抛', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    expect(() => new SettingsRepo(db).normalizeRoots()).not.toThrow()
    expect(new SettingsRepo(db).listRoots()).toEqual([])
  })

  // ── 审校 F7（2026-08-08）：两个不同别名指向同一规范形态 → UNIQUE 冲突 → daemon 启动即死 ──
  // 原实现的 canonicalExists 查的是事务开始时的一次性快照，循环内不更新。当库里有两个别名
  // （'/media/tv/' 与 '/media//tv'）且规范形态本身不在库里时，两条都判"规范形态不存在"、
  // 都走 UPDATE → 第二条撞 UNIQUE → 事务全回滚，脏数据一行不修。
  // 而两处调用点（cli/index.ts）都没有 try/catch → cmdWatch/cmdReconcileAll 直接死，
  // 重启不自愈。原有 6 条测试只造了"单别名"和"别名+规范并存"，系统性绕过了这个形态。
  it('两个别名指向同一规范形态 → 合并成一行，不抛 UNIQUE（F7）', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    seedRaw(db, '/media/tv/', 100)
    seedRaw(db, '/media//tv', 200)
    const repo = new SettingsRepo(db)
    expect(() => repo.normalizeRoots()).not.toThrow()
    const roots = repo.listRoots()
    expect(roots).toHaveLength(1)
    expect(roots[0].path).toBe('/media/tv')
    expect(roots[0].addedAt).toBe(100) // 取最早的出生事实
  })

  it('三个别名 + 规范形态混杂 → 全部收敛成一行（F7 加强）', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    seedRaw(db, '/media//tv', 300)
    seedRaw(db, '/media/tv/', 200)
    seedRaw(db, '/media/tv', 400)
    seedRaw(db, '/media/tv///', 100)
    const repo = new SettingsRepo(db)
    expect(() => repo.normalizeRoots()).not.toThrow()
    const roots = repo.listRoots()
    expect(roots).toHaveLength(1)
    expect(roots[0].path).toBe('/media/tv')
    expect(roots[0].addedAt).toBe(100)
  })

  it('多组别名互不干扰（F7：每组各自收敛）', () => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    seedRaw(db, '/media/tv/', 100)
    seedRaw(db, '/media//tv', 200)
    seedRaw(db, '/data/anime/', 300)
    seedRaw(db, '/data//anime', 400)
    const repo = new SettingsRepo(db)
    expect(() => repo.normalizeRoots()).not.toThrow()
    expect(repo.listRoots().map((r) => `${r.path}@${r.addedAt}`))
      .toEqual(['/data/anime@300', '/media/tv@100'])
  })
})
