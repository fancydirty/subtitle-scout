import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import { SettingsRepo } from './settingsRepo.js'

const NOW = 1_700_000_000_000

/** D7 本体（2026-08-08）：addRoot 自己成为嵌套闸门。
 *
 *  为什么不能只靠 HTTP 端点校验：apiV2.addMediaRoot 确实早就有重叠校验，但 addRoot 还有
 *  第二个入口——seedRootsFromEnv（首启用 MEDIA_ROOTS env 种子）。那条路零规范化、零校验，
 *  直接写库。而 D1 的删除逻辑是「逐守备目录比对差集」：/media 与 /media/115 并存时，
 *  115 挂载掉线后 /media 的 walk 仍成功，115 下的 files 行落进 /media 的差集，
 *  被当成"消失的文件"全删（缺口 C29 = R8 保护要防的灾难）。
 *
 *  返回值而非抛异常：seedRootsFromEnv 是批量种入，单条冲突不该中断整批
 *  （env 里配了 3 个根，第 2 个跟第 1 个嵌套，第 3 个是好的——第 3 个必须能进）。 */
describe('addRoot 嵌套闸门（D7）', () => {
  let db: ScoutDb
  let settings: SettingsRepo

  beforeEach(() => {
    db = openDb(':memory:')
    settings = new SettingsRepo(db)
  })

  it('正常新增 → ok:true，表里有行', () => {
    expect(settings.addRoot('/media/tv', NOW)).toEqual({ ok: true })
    expect(settings.listRoots().map((r) => r.path)).toEqual(['/media/tv'])
  })

  it('拒绝子目录嵌套 → ok:false + conflict，且表里不留新行', () => {
    settings.addRoot('/media/tv', NOW)
    const r = settings.addRoot('/media/tv/anime', NOW + 1000)
    expect(r).toEqual({ ok: false, conflict: { root: '/media/tv', relation: 'child' } })
    // 关键：拒绝必须是"什么都没写"，不是"写了再回滚"的观察等价——直接查表确认只有一行
    expect(settings.listRoots().map((r) => r.path)).toEqual(['/media/tv'])
  })

  it('拒绝父目录嵌套 → ok:false + conflict，表里不留新行', () => {
    settings.addRoot('/media/tv', NOW)
    const r = settings.addRoot('/media', NOW + 1000)
    expect(r).toEqual({ ok: false, conflict: { root: '/media/tv', relation: 'parent' } })
    expect(settings.listRoots().map((r) => r.path)).toEqual(['/media/tv'])
  })

  it('重复提交同一路径 → ok:true 且幂等：added_at 不刷新（既有语义不破）', () => {
    settings.addRoot('/media/tv', NOW)
    expect(settings.addRoot('/media/tv', NOW + 999)).toEqual({ ok: true })
    const roots = settings.listRoots()
    expect(roots).toHaveLength(1)
    // "何时首次加入"是该行的出生事实，重复提交不该改写它
    expect(roots[0].addedAt).toBe(NOW)
  })

  it('尾斜杠形态的重复提交也算幂等，不算冲突（F3 归一化的下游效果）', () => {
    settings.addRoot('/media/tv', NOW)
    expect(settings.addRoot('/media/tv/', NOW + 1000)).toEqual({ ok: true })
    expect(settings.listRoots()).toHaveLength(1)
  })

  it('带尾斜杠的既有根仍能挡住子目录（防 C29 绕过，F3 的真实攻击面）', () => {
    // 模拟 seedRootsFromEnv 种入带尾斜杠的根（MEDIA_ROOTS=/media/tv/）
    settings.addRoot('/media/tv/', NOW)
    const r = settings.addRoot('/media/tv/anime', NOW + 1000)
    expect(r.ok).toBe(false)
    expect(settings.listRoots()).toHaveLength(1)
  })

  it('同名前缀不误挡：/media/tv2 能加进来（不是 /media/tv 的子目录）', () => {
    settings.addRoot('/media/tv', NOW)
    expect(settings.addRoot('/media/tv2', NOW + 1000)).toEqual({ ok: true })
    expect(settings.listRoots()).toHaveLength(2)
  })
})

describe('seedRootsFromEnv 受闸门保护（D7 旁路封堵）', () => {
  let db: ScoutDb
  let settings: SettingsRepo

  beforeEach(() => {
    db = openDb(':memory:')
    settings = new SettingsRepo(db)
  })

  it('全部无冲突 → 全部种入', () => {
    const r = settings.seedRootsFromEnv('/media/tv,/media/movies', NOW)
    expect(r.seeded).toEqual(['/media/tv', '/media/movies'])
    expect(r.rejected).toEqual([])
    expect(settings.listRoots()).toHaveLength(2)
  })

  it('中间一条与前一条嵌套 → 该条跳过，其余正常种入（不中断整批）', () => {
    const r = settings.seedRootsFromEnv('/media/tv,/media/tv/anime,/media/movies', NOW)
    expect(r.seeded).toEqual(['/media/tv', '/media/movies'])
    expect(r.rejected).toHaveLength(1)
    const rej = r.rejected[0]
    expect(rej.path).toBe('/media/tv/anime')
    // 判别联合：先断言 reason 再取 conflict——顺手证明 nested 分支带得出冲突事实
    expect(rej.reason).toBe('nested')
    if (rej.reason !== 'nested') throw new Error('unreachable')
    expect(rej.conflict.root).toBe('/media/tv')
    expect(settings.listRoots().map((x) => x.path).sort()).toEqual(['/media/movies', '/media/tv'])
  })

  it('冲突判定针对累积集合而非初始空快照（第 3 条与第 2 条撞也要挡）', () => {
    // 若实现只在开头取一次 listRoots()，第 3 条会因为"快照里没有 /data/anime"而漏进
    const r = settings.seedRootsFromEnv('/media/tv,/data/anime,/data/anime/s1', NOW)
    expect(r.seeded).toEqual(['/media/tv', '/data/anime'])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0].path).toBe('/data/anime/s1')
  })

  it('全部冲突 → 全跳过，不抛异常', () => {
    settings.addRoot('/media', NOW)
    // media_roots 非空 → 既有语义是空操作（下面单独测），这里先清掉验证纯冲突路径
    db.prepare('DELETE FROM media_roots').run()
    const r = settings.seedRootsFromEnv('/media/tv,/media/tv/anime,/media/tv/anime/s1', NOW)
    expect(r.seeded).toEqual(['/media/tv'])
    expect(r.rejected).toHaveLength(2)
  })

  it('media_roots 非空时仍是空操作（既有语义不破）', () => {
    settings.addRoot('/existing', NOW)
    const r = settings.seedRootsFromEnv('/media/tv', NOW + 1000)
    expect(r.seeded).toEqual([])
    expect(r.rejected).toEqual([])
    expect(settings.listRoots().map((x) => x.path)).toEqual(['/existing'])
  })

  it('env 为空/未定义 → 空操作，不抛', () => {
    expect(settings.seedRootsFromEnv(undefined, NOW)).toEqual({ seeded: [], rejected: [] })
    expect(settings.seedRootsFromEnv('', NOW)).toEqual({ seeded: [], rejected: [] })
    expect(settings.seedRootsFromEnv('  ,  ', NOW)).toEqual({ seeded: [], rejected: [] })
  })

  // ── 审校 F6（2026-08-08）：相对路径必须挡在门外，不许静默落成 <cwd>/... ──
  // addRoot 内部的 resolve() 是相对 process.cwd() 解析的。apiV2 上游有 isAbsoluteMediaPath
  // 门（apiV2.ts:723,827）挡住相对路径，但 env 种子这条路没有——MEDIA_ROOTS=media/tv
  // 会静默落库成 /app/media/tv（容器里 cwd=/app），rejected 为空、零告警，
  // 运维完全看不出守备目录跑到了哪。宁可拒绝也不要猜。
  it('相对路径被拒绝且计入 rejected（不静默落成 cwd 下的路径）', () => {
    const r = settings.seedRootsFromEnv('media/tv', NOW)
    expect(r.seeded).toEqual([])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0].path).toBe('media/tv')
    expect(r.rejected[0].reason).toBe('not-absolute')
    expect(settings.listRoots()).toHaveLength(0)
  })

  it('相对路径与绝对路径混配 → 只收绝对的，相对的进 rejected', () => {
    const r = settings.seedRootsFromEnv('/media/tv,rel/path,/media/movies', NOW)
    expect(r.seeded).toEqual(['/media/tv', '/media/movies'])
    expect(r.rejected).toHaveLength(1)
    expect(r.rejected[0].path).toBe('rel/path')
  })

  it('. 与 .. 这类相对形态同样被拒', () => {
    const r = settings.seedRootsFromEnv('.,..,./media', NOW)
    expect(r.seeded).toEqual([])
    expect(r.rejected).toHaveLength(3)
    expect(settings.listRoots()).toHaveLength(0)
  })
})
