// src/dashboard/health.test.ts —— Task ⑤ GET /api/v2/health（健康横幅与活动页状态条的基线快照）。
//
// 为什么单独一个文件而不是塞进 server.test.ts：照 eventStream.test.ts 的既有先例——那个文件
// 已知在全套件并行下偶发失败（`port: 0` 端口复用 + undici 连接池，见它文件头 afterEach 的
// 长注释）。本端点的用例要区分 `ok: null`（未知）与 `ok: false`（坏）这种细差别，混进去会让
// "是我改坏的还是那条既有 flake"变得无法区分。
//
// 本文件覆盖：四字段各自的数据源与降级 / `roots[].ok` 的三态（从没扫过 / 陈旧 / 新鲜）/
// events 缺席时**不 503** / 刻意不返回 queue / method 门 / 鉴权门。
// "端点真的读了 getCurrent()"那条**源码级**接线断言在隔壁 healthWiring.test.ts。
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import type { Server } from 'node:http'
import { openDb, type ScoutDb } from '../v2/db.js'
import { startDashboard, buildRootHealth } from './server.js'
import { ScoutEventBus } from '../core/scoutEvents.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
// 陈旧门以巡检周期为单位（不在测试里复述 48h 这个数字——复述就是第二处定义，
// 同 watchWiring.test.ts 拒绝复述目录名格式的既有理由）。
import { INSPECT_INTERVAL_MS } from '../v2/daemonV2.js'

let server: Server | undefined
let db: ScoutDb

// 同 eventStream.test.ts / server.test.ts 的两层隔离（服务端断 keep-alive + 客户端换
// dispatcher）——理由见那边的长注释。
afterEach(async () => {
  const s = server
  server = undefined
  if (s) {
    s.closeAllConnections?.()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  const prev = getGlobalDispatcher()
  setGlobalDispatcher(new Agent())
  await prev.close().catch(() => {})
})

beforeEach(() => { db = openDb(':memory:') })

function distWith(html: string): string {
  const dist = mkdtempSync(join(tmpdir(), 'health-dist-'))
  writeFileSync(join(dist, 'index.html'), html)
  return dist
}

async function start(opts: { events?: ScoutEventBus | null; token?: string } = {}) {
  server = await startDashboard({
    db, port: 0, token: opts.token ?? 'tok', distDir: distWith('<!doctype html>'),
    // 默认**不接**总线：本端点的多数用例关心的是三个 DB 字段，而"没接线怎么办"恰恰是
    // 本 task 要论证的降级（不 503），故它是默认态而不是特例。
    events: opts.events ?? undefined,
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}` }
}

async function getHealth(base: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/v2/health?token=tok`)
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.json().catch(() => null) }
}

/** 直接往 media_roots 写一行健康度（绕开 daemonV2——本文件测的是**读**侧的折叠口径，
 *  写侧由 daemonV2.test.ts 的 Task ③ 那组钉住）。 */
function seedRoot(
  db: ScoutDb, path: string, lastError: string | null, lastCheckedAt: number | null,
): void {
  new SettingsRepo(db).addRoot(path, 1_700_000_000_000)
  db.prepare('UPDATE media_roots SET last_error = ?, last_checked_at = ? WHERE path = ?')
    .run(lastError, lastCheckedAt, path)
}

// ─────────────────────────────────────────────────────────────────────────────
// buildRootHealth：`ok` 三态折叠的纯函数层。
//
// 为什么这一层要单独测而不是只靠 HTTP 用例：陈旧判定依赖 `now`，而端点里那个 now 是
// `Date.now()`。只走 HTTP 的话"刚好卡在容差边界"这条线根本没法摆出来——只能靠塞一个
// 很旧的时刻粗略地证明"旧的会变 null"，而边界恰恰是唯一容易写错的地方（> 还是 >=、
// 1× 还是 2×）。
// ─────────────────────────────────────────────────────────────────────────────
describe('buildRootHealth · `ok` 是三态不是布尔（Task ③ 审计留下的陈旧判决债务）', () => {
  const NOW = 1_700_000_000_000

  it('🔴 从没扫过（last_checked_at IS NULL）→ ok 是 **null（未知）**，不是 true', () => {
    // db.ts v41 那条迁移 entry 预言过这个坑：「折叠成 NOT NULL DEFAULT 0 会让『刚加的根』
    // 与『扫过且健康的根』不可区分，未来的读取方会把前者当成绿的」。本函数就是那个读取方。
    // 报 true = 替一个从未被验证过的根打包票，而"刚加的根路径写错了"正是最该抓到的场景。
    const [r] = buildRootHealth([{ path: '/media/new', last_error: null, last_checked_at: null }], NOW)
    expect(r.ok).toBeNull()
    expect(r.ok).not.toBe(true)        // 与上一条不重复：钉的是"不许折成绿的"这条裁决本身
    expect(r.lastCheckedAt).toBeNull()
  })

  it('🔴 新鲜 + 无错 → ok: true', () => {
    const [r] = buildRootHealth([{ path: '/media', last_error: null, last_checked_at: NOW - 1000 }], NOW)
    expect(r.ok).toBe(true)
  })

  it('🔴 新鲜 + 有错 → ok: false，且 lastError 原文照给', () => {
    const [r] = buildRootHealth(
      [{ path: '/media', last_error: '守备目录读取失败，本轮跳过（已重试 2 次）: EIO', last_checked_at: NOW - 1000 }],
      NOW,
    )
    expect(r.ok).toBe(false)
    expect(r.lastError).toContain('守备目录读取失败')
  })

  it('🔴 陈旧（超 2 个巡检周期没被扫过）+ 无错 → ok 变 **null**，不许继续报 true', () => {
    // 这是本 task 点名的债务的一半：库里有、本轮 scanRoots 没有的根，两列永久停在旧值。
    // 继续报 true = 把一个几周没人碰过的根说成"现在是好的"——病 B（中间量当结论量）。
    const [r] = buildRootHealth(
      [{ path: '/media', last_error: null, last_checked_at: NOW - 2 * INSPECT_INTERVAL_MS - 1 }],
      NOW,
    )
    expect(r.ok).toBeNull()
  })

  it('🔴 陈旧 + **有错** → ok 也是 null（不是 false），但 lastError 原文仍给', () => {
    // 债务的另一半，且方向相反：一个两周前失败、此后再没被扫过的根，说它"现在是坏的"
    // 与说它"现在是好的"同样没有依据。两个方向都归 null 才是诚实的。
    // lastError 照给是刻意的——它对排障有用，只是**不是当前结论**。
    const [r] = buildRootHealth(
      [{ path: '/media', last_error: '挂载掉线', last_checked_at: NOW - 2 * INSPECT_INTERVAL_MS - 1 }],
      NOW,
    )
    expect(r.ok).toBeNull()
    expect(r.ok).not.toBe(false)
    expect(r.lastError).toBe('挂载掉线')
  })

  it('🔴 容差边界：恰好 2 个巡检周期仍算新鲜，多 1ms 才转未知', () => {
    // 边界必须钉死：1× 会**每天误报**（巡检自身要跑数小时，时间闸记的是开始时刻，
    // 失败还走独立退避——"上次检查 24.5 小时前"是完全正常的稳态）。
    const at = (age: number) =>
      buildRootHealth([{ path: '/m', last_error: null, last_checked_at: NOW - age }], NOW)[0].ok
    expect(at(2 * INSPECT_INTERVAL_MS)).toBe(true)
    expect(at(2 * INSPECT_INTERVAL_MS + 1)).toBeNull()
    // 1 个周期整必须还是新鲜的——写成 1× 门的话这一条会红。
    expect(at(INSPECT_INTERVAL_MS + 1)).toBe(true)
  })
})

describe('GET /api/v2/health（Task ⑤）', () => {
  const NOW = 1_700_000_000_000

  it('空库：四个字段齐全，lastInspectAt 冷启动为 null（前端要保留冷启动分支）', async () => {
    const { base } = await start()
    const { status, body } = await getHealth(base)
    expect(status).toBe(200)
    // 冷启动 null**不是** 0：前端见 0 会显示成 1970-01-01（§3.5 附带实测发现点名的坑）。
    expect(body.lastInspectAt).toBeNull()
    expect(body.engineEnabled).toBe(true)   // fail-open 缺省
    expect(body.roots).toEqual([])
    expect(body.current).toBeNull()
  })

  it('🔴 lastInspectAt 读 meta 的 last_inspect_at（daemonV2.writeLastInspectAt 的键）', async () => {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(NOW))
    const { base } = await start()
    const { body } = await getHealth(base)
    expect(body.lastInspectAt).toBe(NOW)
  })

  it('lastInspectAt 脏值（非数字）→ null', async () => {
    // ⚠️ **这条用例是 0 红的，如实记在这里**（变异验证：把端点里的 `Number.isFinite(...)`
    // 守卫删成 `inspectRow ? Number(inspectRow.value) : null` 之后，本文件 23 条全绿）。
    //
    // 成因不是断言写松了，而是**经 HTTP 观察不到差别**：`JSON.stringify({x: NaN})` 得到
    // `{"x":null}`（已实测），所以带守卫与不带守卫的响应体逐字节相同。要让它可分辨，
    // 就得把断言从 HTTP 层挪到一个导出的纯函数上——那意味着为一个观察不到的差别去改
    // 生产代码的形状，不划算。
    //
    // 那为什么还留着那个守卫、还留着这条用例：
    //  · 守卫留着是**可读性**，不是行为——让"脏值走 null"是一句写出来的话，而不是靠
    //    JSON.stringify 的巧合兜住。哪天有人把这个字段改成非 JSON 出口（SSE 帧、日志行），
    //    巧合就没了，而守卫还在。
    //  · 用例留着是因为它**锁住了对外契约**（脏值必须是 null，不是 0、不是字符串原文）：
    //    删掉守卫它不红，但把降级改成 `: 0` 它会红——而 0 正是前端会显示成 1970-01-01 的
    //    那个值（§3.5 附带实测发现点名的坑）。
    //
    // 同型既有先例：apiV2.buildWorkflowPending 的 lastScanAt 读同一个键、**本来就没有**这个
    // 守卫，且给它反向加上守卫后 apiV2.test.ts 的 116 条同样 0 红（已实测）。故这不是本
    // task 引入的新缺口，是这一类"NaN 经 JSON 塌成 null"的字段共有的性质。
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', 'garbage')`).run()
    const { base } = await start()
    const { body } = await getHealth(base)
    expect(body.lastInspectAt).toBeNull()
  })

  it('🔴 engineEnabled 走 fail-open：显式 false → false，脏值 → true（spec §4.6）', async () => {
    const settings = new SettingsRepo(db)
    settings.set('engine_enabled', 'false', NOW)
    const { base } = await start()
    expect((await getHealth(base)).body.engineEnabled).toBe(false)
    settings.set('engine_enabled', '0', NOW)
    expect((await getHealth(base)).body.engineEnabled).toBe(true)
  })

  it('🔴 roots 端到端：三态各一行，同一次响应里同时出现 true / false / null', async () => {
    // 端到端摆全三态（而不是分三个用例各摆一个）：本 task 最容易出的错是"把三态压回布尔"，
    // 那种实现下这一条会当场红——三行里必有两行的 ok 撞成同一个值。
    const now = Date.now()
    seedRoot(db, '/media/ok', null, now - 1000)
    seedRoot(db, '/media/bad', '守备目录扫出 0 个媒体文件，疑似挂载异常，本轮跳过（已重试 2 次）', now - 1000)
    seedRoot(db, '/media/never', null, null)
    const { base } = await start()
    const { body } = await getHealth(base)
    const byPath = Object.fromEntries(body.roots.map((r: any) => [r.path, r]))
    expect(byPath['/media/ok'].ok).toBe(true)
    expect(byPath['/media/bad'].ok).toBe(false)
    expect(byPath['/media/bad'].lastError).toContain('疑似挂载异常')
    expect(byPath['/media/never'].ok).toBeNull()
    expect(byPath['/media/never'].lastCheckedAt).toBeNull()
  })

  it('🔴 roots 的四个字段全都在（lastError/lastCheckedAt 是 null 而不是缺席）', async () => {
    // `| null` 而不是可选字段：undefined 经 JSON.stringify 会让字段**整个消失**，
    // 前端就分不清"没有这个事实"和"这版后端还没这个字段"（同 ScoutCurrent 的既有论证）。
    seedRoot(db, '/media/never', null, null)
    const { base } = await start()
    const { body } = await getHealth(base)
    expect(Object.keys(body.roots[0]).sort()).toEqual(['lastCheckedAt', 'lastError', 'ok', 'path'])
  })

  it('🔴 接了总线：current 来自 ScoutEventBus 的快照（Task ④ 的 getCurrent）', async () => {
    const bus = new ScoutEventBus()
    bus.publish({ type: 'activity', message: '开始处理', title: '甲剧', workbench: 'subtitle' })
    bus.publish({ type: 'progress', message: '3/47', title: '甲剧', workbench: 'subtitle', data: { done: 3, total: 47 } })
    const { base } = await start({ events: bus })
    const { body } = await getHealth(base)
    expect(body.current).toEqual({ kind: 'subtitle', title: '甲剧', index: 3, total: 47 })
  })

  it('🔴 接了总线但没人在跑（巡检完成清空了快照）→ current: null', async () => {
    const bus = new ScoutEventBus()
    bus.publish({ type: 'activity', message: '开始处理', title: '甲剧', workbench: 'subtitle' })
    bus.publish({ type: 'activity', message: '巡检完成，歇着等明天' })   // 无 workbench → 清空
    const { base } = await start({ events: bus })
    expect((await getHealth(base)).body.current).toBeNull()
  })

  it('🔴 current 是**现取**：同一个 server 上总线推进后下一次请求要看到新值', async () => {
    // 若实现把 getCurrent() 的结果在 startDashboard 组装时求值一次（同 tmdb/translateEnabled
    // 那批惰性求值踩过的坑），首次请求照样正确、之后**永远冻在那一刻**——而这个端点的
    // 全部意义就是"随时能问出当前态"。
    const bus = new ScoutEventBus()
    const { base } = await start({ events: bus })
    expect((await getHealth(base)).body.current).toBeNull()
    bus.publish({ type: 'activity', message: '开始处理', title: '乙剧', workbench: 'translate' })
    expect((await getHealth(base)).body.current).toEqual({ kind: 'translate', title: '乙剧', index: null, total: null })
  })

  it('🔴 没接总线（不跑 watch）→ **不 503**：current 给 null，其余三个字段照给', async () => {
    // 本 task 的一条明确裁决（与隔壁 /api/v2/events 缺席即 503 刻意不同）：health 的另外
    // 三个字段与总线毫无关系，整体 503 会让"守备目录健康度"这个纯 DB 事实在没跑 watch 时
    // 也查不到——而那恰恰是最需要它的时候。
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(NOW))
    seedRoot(db, '/media/ok', null, Date.now() - 1000)
    const { base } = await start({ events: undefined })
    const { status, body } = await getHealth(base)
    expect(status).toBe(200)
    expect(body.current).toBeNull()
    expect(body.lastInspectAt).toBe(NOW)
    expect(body.roots[0].ok).toBe(true)      // 守备目录健康度照常可见
  })

  it('🔴 **刻意不返回 queue**（§3.5:578/:568 裁决；§3.6 说要返回是文档自相矛盾）', async () => {
    // 这条是那个裁决唯一的可执行痕迹：下一个人读 §3.6 会以为端点残缺、照它把
    // listSubtitleQueue 接上去，正好踩中 :568 明令禁止的那条（语义与 R4 冻结快照相反，
    // 会让活动页 total 与 SSE 的 total 对不上且越跑越飘）。
    const { base } = await start({ events: new ScoutEventBus() })
    const { body } = await getHealth(base)
    expect(Object.keys(body).sort()).toEqual(['current', 'engineEnabled', 'lastInspectAt', 'roots'])
    expect('queue' in body).toBe(false)
  })

  it('非 GET → 405（同隔壁 notifications/events 的既有 method 门）', async () => {
    const { base } = await start()
    const res = await fetch(`${base}/api/v2/health?token=tok`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  it('鉴权：无凭据 → 401（与其余 /api/v2/* 同一道统一前置门，不开旁路）', async () => {
    const { base } = await start({ token: 'tok' })
    const res = await fetch(`${base}/api/v2/health`)
    expect(res.status).toBe(401)
  })
})
