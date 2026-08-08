import { describe, it, expect } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import { SettingsRepo } from './settingsRepo.js'

/** D7 附加（2026-08-08）：存量嵌套配置检测。
 *
 *  Task 1a-2 的闸门只挡**新增**。库里可能已有闸门上线前配好的嵌套根——那些是历史遗留，
 *  程序**不擅自删**（守备目录是用户的配置意图，不是程序的判断），但必须告警。
 *
 *  为什么不能只靠告警就完事（写回 spec 第 1b 步的风险 5）：告警只是让用户知道。
 *  若用户不理，D1 的删除逻辑上线后**仍会删错**——所以第 1b 步的删除逻辑必须自己
 *  跳过被嵌套污染的根，不能依赖用户看了告警去修配置。 */
describe('detectNestedRoots（D7 附加：存量嵌套检测）', () => {
  const seedRaw = (db: ScoutDb, path: string, addedAt = 100): void => {
    db.prepare("INSERT INTO media_roots (path, type, added_at) VALUES (?, 'local', ?)")
      .run(path, addedAt)
  }
  const fresh = (): ScoutDb => {
    const db = openDb(':memory:')
    db.prepare('DELETE FROM media_roots').run()
    return db
  }

  it('无嵌套 → 空数组', () => {
    const db = fresh()
    seedRaw(db, '/media/tv')
    seedRaw(db, '/media/movies')
    seedRaw(db, '/data/anime')
    expect(new SettingsRepo(db).detectNestedRoots()).toEqual([])
  })

  it('父子两根 → 报一条，方向为 child（后者是前者的子目录）', () => {
    const db = fresh()
    seedRaw(db, '/media')
    seedRaw(db, '/media/tv')
    const hits = new SettingsRepo(db).detectNestedRoots()
    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual({ root: '/media', nested: '/media/tv', relation: 'child' })
  })

  it('三层嵌套 → 报出全部成对关系（不只相邻层）', () => {
    const db = fresh()
    seedRaw(db, '/a')
    seedRaw(db, '/a/b')
    seedRaw(db, '/a/b/c')
    const hits = new SettingsRepo(db).detectNestedRoots()
    // /a⊃/a/b、/a⊃/a/b/c、/a/b⊃/a/b/c —— 三对都要报，因为每一对都会让 D1 删错
    expect(hits).toHaveLength(3)
    const pairs = hits.map((h) => `${h.root}⊃${h.nested}`).sort()
    expect(pairs).toEqual(['/a/b⊃/a/b/c', '/a⊃/a/b', '/a⊃/a/b/c'])
  })

  it('同名前缀不误报：/media/tv 与 /media/tv2 无嵌套关系', () => {
    const db = fresh()
    seedRaw(db, '/media/tv')
    seedRaw(db, '/media/tv2')
    expect(new SettingsRepo(db).detectNestedRoots()).toEqual([])
  })

  it('根目录 / 与任意根都算嵌套（F1 的同一漏洞面，这里也要盖住）', () => {
    const db = fresh()
    seedRaw(db, '/')
    seedRaw(db, '/media/tv')
    const hits = new SettingsRepo(db).detectNestedRoots()
    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual({ root: '/', nested: '/media/tv', relation: 'child' })
  })

  it('单根 / 空表 → 空数组', () => {
    const db1 = fresh()
    seedRaw(db1, '/media/tv')
    expect(new SettingsRepo(db1).detectNestedRoots()).toEqual([])
    const db2 = fresh()
    expect(new SettingsRepo(db2).detectNestedRoots()).toEqual([])
  })

  it('检测结果稳定不重复：同一对关系只报一次（不因遍历顺序报两遍）', () => {
    const db = fresh()
    seedRaw(db, '/media/tv')  // 先插子
    seedRaw(db, '/media')     // 后插父
    const hits = new SettingsRepo(db).detectNestedRoots()
    expect(hits).toHaveLength(1)
    // 无论插入顺序，root 恒为外层、nested 恒为内层
    expect(hits[0].root).toBe('/media')
    expect(hits[0].nested).toBe('/media/tv')
  })
})
