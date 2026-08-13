// src/dashboard/health.test.ts —— Task ⑤ GET /api/v2/health（健康横幅与活动页状态条的基线快照）。
//
// 为什么单独一个文件而不是塞进 server.test.ts：照 eventStream.test.ts 的既有先例——那两个文件
// 曾在全套件并行下偶发失败。本端点的用例要区分 `ok: null`（未知）与 `ok: false`（坏）这种细
// 差别，混进去会让"是我改坏的还是那条既有 flake"变得无法区分。
// （2026-08-12：那条 flake 已根治——真因是 listen 绑 `::` 而请求拨 `127.0.0.1` 的跨地址族串台，
//  不是前人以为的 undici 连接池复用。见 testServerHost.ts 的头注释。本文件保持独立，理由仍是
//  上面那条"细差别不该跟别人的红搅在一起"，与 flake 无关。）
//
// 本文件覆盖：字段各自的数据源与降级 / `roots[].ok` 的三态（从没扫过 / 陈旧 / 新鲜）/
// events 缺席时**不 503** / 刻意不返回 queue / method 门 / 鉴权门 /
// workPermitted 与 daemon 同源（🔴-2）/ getCurrent 的运行时接线探针（🔴-1）。
//
// ⚠️ 曾经有一个 healthWiring.test.ts 用**源码文本**断言来守"端点真的读了 getCurrent()"。
// 它的 4 条断言实测全是假绿（`current: null, // events.getCurrent()` 就能全部喂饱），
// **已删除**——理由与替代方案见本文件下方那条运行时探针用例的头注释。
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import type { Server } from 'node:http'
import { openDb, type ScoutDb } from '../v2/db.js'
import { startDashboard, buildRootHealth } from './server.js'
import { TEST_HOST, baseOf } from './testServerHost.js'
import { ScoutEventBus } from '../core/scoutEvents.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
// 🔴-2：端点的 workPermitted 必须与 daemon 逐字同源。测试直接调 daemon 那一侧用的同一个
// 函数来比对，**不在这里复述判据**——复述就是第三处手写实现（D7/C30 的既有形态）。
import { workPermitted } from '../cli/watchClients.js'
import { makeAdapterConfigResolver } from '../v2/secrets.js'
// 陈旧门以巡检周期为单位（不在测试里复述 48h 这个数字——复述就是第二处定义，
// 同 watchWiring.test.ts 拒绝复述目录名格式的既有理由）。
import { INSPECT_INTERVAL_MS } from '../v2/daemonV2.js'

let server: Server | undefined
let db: ScoutDb

// 同 eventStream.test.ts / server.test.ts 的两层隔离（服务端断 keep-alive + 客户端换
// dispatcher）。注意这两层**不是**那条串台 flake 的解药（真因＝跨地址族，见 testServerHost.ts），
// 保留只为与隔壁两个文件的收尾形态一致。
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

/** setup 闸满足所需的最小 env（TMDB + LLM 三件套，见 watchClients.setupSatisfied）。
 *
 *  为什么每个用例都必须显式给 env：不给的话 startDashboard 落到 `process.env`，于是
 *  `setupSatisfied` / `workPermitted` 两个字段的值取决于**跑测试的这台机器配没配 TMDB_API_KEY**
 *  ——开发机上恒绿、CI 上恒红（或反过来）。这正是本仓 deployContract 那批用例踩过的坑。 */
const SETUP_OK_ENV = {
  TMDB_API_KEY: 't', LLM_BASE_URL: 'b', LLM_API_KEY: 'k', LLM_MODEL: 'm',
} as const

async function start(opts: {
  events?: ScoutEventBus | null
  token?: string
  /** 缺省 = setup 闸满足。多数用例测的是别的字段，让 workPermitted 不要在背景里干扰它们。 */
  env?: Record<string, string | undefined>
} = {}) {
  server = await startDashboard({
    db, port: 0, host: TEST_HOST, token: opts.token ?? 'tok', distDir: distWith('<!doctype html>'),
    env: opts.env ?? { ...SETUP_OK_ENV },
    // 默认**不接**总线：本端点的多数用例关心的是三个 DB 字段，而"没接线怎么办"恰恰是
    // 本 task 要论证的降级（不 503），故它是默认态而不是特例。
    events: opts.events ?? undefined,
  })
  return { base: baseOf(server) }
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

  it('空库：字段齐全，lastInspectAt 冷启动为 null（前端要保留冷启动分支）', async () => {
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

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴-2：daemon 不干活时这个端点不许说引擎开着。
  //
  // 修复前这里只有一个 `engineEnabled` 字段，注释声称它"与 daemon 的 workPermitted 同源"，
  // 而 daemon 的判据是 `engineEnabled(...) && setupSatisfied(cfg)`——端点只取了左半边。
  // 于是全新部署 / 凭据过期时：daemon 整轮巡检被 setup 闸闸死、什么都不做，
  // 而健康横幅坚定地说"引擎开着"。这一组把那句假话钉死。
  // ───────────────────────────────────────────────────────────────────────────

  it('🔴 setup 闸不满足（TMDB/LLM 缺失）→ workPermitted: false，即使总开关是开的', async () => {
    // 这是 🔴-2 那句假话的正脸：engineEnabled 照实报 true（用户确实没关开关），
    // 但 workPermitted 必须是 false——daemon 此刻整轮跳过，端点不许说它在干活。
    const { base } = await start({ env: {} })          // 一个密钥都没有 = 全新部署
    const { body } = await getHealth(base)
    expect(body.engineEnabled).toBe(true)
    expect(body.setupSatisfied).toBe(false)
    expect(body.workPermitted).toBe(false)
  })

  it('🔴 setup 闸只差一件（LLM_MODEL 缺）也算不满足——与 watchClients.setupSatisfied 同口径', async () => {
    // 部分配置是"凭据过期/漏填"最真实的形状（用户填了 TMDB 和 LLM 的 base+key，忘了 model）。
    // 若 dashboard 层把判据手写成"TMDB 有就算数"这类近似，这一条会红。
    const { base } = await start({ env: { TMDB_API_KEY: 't', LLM_BASE_URL: 'b', LLM_API_KEY: 'k' } })
    const { body } = await getHealth(base)
    expect(body.setupSatisfied).toBe(false)
    expect(body.workPermitted).toBe(false)
  })

  it('🔴 密钥配在**库**里（wizard 落库，不走 env）也算满足——不许只认 env', async () => {
    // setup wizard 的正常路径是 PUT /api/v2/setup/secrets 落库，env 一个都没有。
    // 若这里的解析只看 env（在 dashboard 层另写一套解析规则最容易掉的坑），
    // 一个配置完好的部署会被报成 workPermitted: false——方向相反的另一句假话。
    const settings = new SettingsRepo(db)
    for (const [k, v] of Object.entries(SETUP_OK_ENV)) settings.setSecret(k as any, v, NOW)
    const { base } = await start({ env: {} })
    const { body } = await getHealth(base)
    expect(body.setupSatisfied).toBe(true)
    expect(body.workPermitted).toBe(true)
  })

  it('🔴 总开关关 + setup 满足 → workPermitted false，且两个合取项可分辨', async () => {
    // 为什么必须是三个字段而不是把 engineEnabled 直接改成合取：这一条与上面第一条
    // （开关开、凭据缺）在 workPermitted 上**同为 false**，而用户的下一步动作完全相反
    // （把开关打开 / 去 setup 页填 key）。两条用例的 engineEnabled/setupSatisfied 组合
    // 恰好相反，那正是前端指路所需的全部信息。合成一个字段的话这两条会变得不可区分。
    new SettingsRepo(db).set('engine_enabled', 'false', NOW)
    const { base } = await start()                      // env 默认满足 setup 闸
    const { body } = await getHealth(base)
    expect(body.engineEnabled).toBe(false)
    expect(body.setupSatisfied).toBe(true)
    expect(body.workPermitted).toBe(false)
  })

  it('🔴 workPermitted 与 daemon 的 workPermitted 逐字同源（不是端点自己算的第二份）', async () => {
    // 上面四条锁的是"值对不对"，这一条锁的是"**判据是同一个**"：把 cli/index.ts 喂给
    // daemon 的那两个数据源原样喂给 watchClients.workPermitted，逐一比对四种组合下
    // 端点与它是否给出同一个答案。任何一方将来增减合取项而另一方没跟上，这条就红。
    //
    // 直接调那个函数而不是复述它的逻辑：复述就是**第三处手写判据**，正是本 task 禁止的
    // D7/C30 形态——那样的断言在两份实现一起漂移时会跟着一起绿。
    const settings = new SettingsRepo(db)
    const cases: Array<{ engine: string | null; env: Record<string, string> }> = [
      { engine: null, env: { ...SETUP_OK_ENV } },
      { engine: null, env: {} },
      { engine: 'false', env: { ...SETUP_OK_ENV } },
      { engine: 'false', env: {} },
    ]
    for (const c of cases) {
      settings.set('engine_enabled', c.engine ?? 'true', NOW)
      const { base } = await start({ env: c.env })
      const { body } = await getHealth(base)
      // daemon 侧的构造：cli/index.ts:801 就是这两个入参（settings 裸键读 + env/库两级密钥面）。
      const daemonSays = workPermitted(
        (k) => settings.get(k),
        makeAdapterConfigResolver(c.env, (k) => settings.get(k)),
      )
      expect(body.workPermitted).toBe(daemonSays)
      // 顺带钉住三者自洽——端点若把某一项算漏（比如 workPermitted 忘了合取），这里也红。
      expect(body.workPermitted).toBe(body.engineEnabled && body.setupSatisfied)
      const s = server; server = undefined
      s?.closeAllConnections?.()
      await new Promise<void>((resolve) => s!.close(() => resolve()))
    }
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

  // ── unidentified：「有几个目录我认不出来」（病 A 第 7 例的读出面）─────────────
  // 这一段的完整论证（含 R-F1/R-F2 的作用域解读）在 unidentifiedHealth.ts 头注释。
  // 这里只钉**端点边界**：字段确实出得来、且是活谓词算出来的，不是恒空占位。
  it('🔴 unidentified 出现在 /health 里，且空库时是 0（不是缺席字段）', async () => {
    const { base } = await start()
    const { body } = await getHealth(base)
    expect(body.unidentified).toEqual({ dirCount: 0, dirs: [] })
  })

  it('🔴 unidentified 端到端：work_id IS NULL 的目录真的能走到 HTTP 响应上', async () => {
    // 含一个 404 终态目录——它**永不再进识别队列**，是这条提示最该抓到的那一类。
    db.prepare(
      `INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, last_error, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run('/media/Unknown Show/e1.mkv', '/media/Unknown Show', 'e1.mkv', 1, NOW,
      '/media/Unknown Show', null, 'tmdb-404', NOW)

    const { base } = await start()
    const { body } = await getHealth(base)
    expect(body.unidentified.dirCount).toBe(1)
    expect(body.unidentified.dirs).toEqual([{ dirName: 'Unknown Show', fileCount: 1 }])
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

  it('🔴 接线（运行时探针）：每次请求都**真的调用** ScoutEventBus.getCurrent()，而不是别处凑出同形对象', async () => {
    // ── 这一条替代了原 healthWiring.test.ts（已删）──────────────────────────────
    // 那个文件用源码文本匹配来证明"端点读了 getCurrent()"，实测**四条断言全是假绿**：
    // codeLines() 只剥整行注释，把 `current: events ? events.getCurrent() : null` 改成
    // `current: null, // events.getCurrent()` 之后 4/4 全过。剥掉行尾注释也救不了——
    // 判据仍落在文本上，一个字符串字面量或一个叫 getCurrent 的局部变量照样喂得饱。
    // 文本断言的能力上限就在这里：它证明的是"源码里写了这几个字"，不是"运行时调了"。
    //
    // 这条探针证明后者：给端点一个**被监视过的**总线，断言那个方法真的被调用了。
    // 它同时钉死了原文件想守却守不住的那个变异——"绕过总线自己去 meta 表读一份同形快照"
    // （Task ④ 明确否掉的方案）：那种实现下响应体可以完全正确，但 getCurrent 调用数为 0。
    const bus = new ScoutEventBus()
    bus.publish({ type: 'activity', message: '开始处理', title: '丙剧', workbench: 'identify' })
    // spy 而不是替身对象：真实 ScoutEventBus 的行为原样保留（含"返回副本"那条），
    // 这里只在它身上加一个计数器。ESM 无法 spy 模块导出，但**实例方法**可以。
    const calls: number[] = []
    const real = bus.getCurrent.bind(bus)
    bus.getCurrent = () => { calls.push(1); return real() }

    const { base } = await start({ events: bus })
    expect(calls.length).toBe(0)                    // 组装阶段不许求值（那会冻死快照）
    const first = await getHealth(base)
    expect(calls.length).toBe(1)                    // 恰好一次：请求来了才取，且只取一次
    expect(first.body.current).toEqual({ kind: 'identify', title: '丙剧', index: null, total: null })
    // 第二次请求要再调一次——"现取"这件事在调用计数上也留痕（上面那条只看得见值）。
    await getHealth(base)
    expect(calls.length).toBe(2)
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
    expect(Object.keys(body).sort()).toEqual(
      ['current', 'engineEnabled', 'lastInspectAt', 'roots', 'setupSatisfied', 'unidentified', 'workPermitted'],
    )
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
