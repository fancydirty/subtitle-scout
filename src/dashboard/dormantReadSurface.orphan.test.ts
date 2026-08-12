// src/dashboard/dormantReadSurface.orphan.test.ts
// ═══════════════════════════════════════════════════════════════════════════
// 2026-08-13「三个 jobs 读取面」裁决的承载物：把 `buildDormantTasks` 的**保留条件**
// 从一段会过期的注释，升级成一条会红的断言。
// ═══════════════════════════════════════════════════════════════════════════
//
// 同轮裁决删掉了 `buildWorkflowWorkers`（显示位已有活的后继），留下了 `buildDormantTasks`
// （显示位没有后继 + 它的容器 TriagePage 是另一轮裁决写明的恢复路径）。
// 完整论证在 `apiV2.ts` 该函数上方的头注释，这里只承载**判据**。
//
// 留就要给可证伪的删除判据。本条的判据是「与 jobs 队列同进退」，而队列的死活由
// `cli/handleWorkerTask.ts` 是否仍是生产孤儿决定。那个事实已经有一份守卫
// （`cli/handleWorkerTask.orphan.test.ts`），本文件**不重复实现它**——重复实现两份
// 判据必然漂移（本仓 C30 的老教训）。本文件锁的是另外两件那份守卫管不到的事：
//
//   ① 这条读取面**今天仍然完整**（端点 → builder → DTO 四键封闭）。
//      没有这条，②会以最糟的方式恒绿：函数被误删或改坏，"没有活 UI"照样成立。
//
//   ② dormant 行在生产**已经没有任何写入者**——这正是裁决第 2 条的事实基础。
//      它红了 = 有人把 park/reap/forceState 接回了生产 = dormant 重新是活事实，
//      那时必须回答「它在三页产品的哪一页露出」，而不是继续挂在雪藏页上。
//      **红不等于错，等于"该重读裁决了"**。
//
// ⚠️ 判据为什么解析 import 而不是裸 grep：grep 会被注释与散文喂饱。上一轮
//    ingestTrigger 的同型判据初版就是被**它自己头注释里引用的同一个字符串**匹配到而假红
//    （那次真踩过，教训写在 handleWorkerTask.orphan.test.ts 里）。本文件照抄它的
//    `codeOf()` 剥注释手法，并且自带阳性对照证明扫描器没有空转。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../v2/db.js'
import { buildDormantTasks } from './apiV2.js'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** src 下所有**非测试** .ts（测试里的调用不是"接线"，生产调用才是）。 */
function productionSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
    }
  }
  walk(SRC_ROOT)
  return out
}

/** 剥掉块注释与行注释，只留可执行代码。 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** 把一行 job 推进 dormant 的四个方法。`park` 是唯一今天还有（间接）调用者的那个——
 *  它的两个调用方 realignWorkerTask / translateWorkerTask 只经 handleWorkerTask 到达，
 *  而后者是生产孤儿，所以整条路径在生产不可达。 */
const DORMANT_WRITERS = ['park', 'reapExpiredLeases', 'reapAllActive', 'forceState'] as const

describe('dormant 读取面的保留条件（2026-08-13 裁决的机器可查载体）', () => {
  it('① 阳性对照：这条读取面仍然完整——builder 可调用，DTO 四键封闭', () => {
    // 先立这条。没有它，②在"函数被删/改坏"时会以假绿的方式通过。
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, payload, state, priority, attempt, reap_count, created_at, updated_at)
       VALUES ('worker_task', 'tmdb:1', ?, 'dormant', 0, 5, 0, ?, ?)`,
    ).run(JSON.stringify({ taskType: 'find_subtitle', seasons: [2] }), now, now)

    const rows = buildDormantTasks(db)
    expect(rows).toHaveLength(1)
    // 四键封闭——多一个键就意味着有人往这个"零按钮只读面"上加了语义，
    // 而 spec §3 决策 1 明确不补唤醒通道。
    expect(Object.keys(rows[0]!).sort()).toEqual(['attempts', 'jobId', 'targetLabel', 'task'])
    expect(rows[0]!.attempts).toBe(5)
    expect(rows[0]!.targetLabel).toBe('tmdb:1, Season 2')
  })

  it('② dormant 在生产**零写入者**——红了说明 jobs 队列活过来了，去重读裁决', () => {
    // 谁在生产代码里调这四个方法。jobsRepo.ts 自身是**定义处**，不是调用点，故排除。
    const repoPath = join(SRC_ROOT, 'v2', 'jobsRepo.ts')
    const callers: string[] = []
    for (const f of productionSources()) {
      if (f === repoPath) continue
      const code = codeOf(f)
      for (const m of DORMANT_WRITERS) {
        if (new RegExp(`\\.${m}\\s*\\(`).test(code)) callers.push(`${relative(SRC_ROOT, f)} → ${m}()`)
      }
    }

    // 🔴 例外白名单：`park` 的两个调用者。它们**确实写着 jobs.park(...)**，但只经
    // `cli/handleWorkerTask.ts` 到达，而那是生产孤儿（handleWorkerTask.orphan.test.ts
    // 钉着）。把它们列成显式白名单而不是放宽正则，是为了让"为什么它们不算数"这件事
    // 留在代码里——哪天队列被接回 claim，这两条立刻变成真实写入者，
    // 而那时 orphan 守卫会先红，指向同一次重读。
    const UNREACHABLE_VIA_ORPHAN = [
      'v2/realignWorkerTask.ts → park()',
      'v2/translateWorkerTask.ts → park()',
    ]
    const unexpected = callers.filter((c) => !UNREACHABLE_VIA_ORPHAN.includes(c))

    expect(unexpected,
      '有生产代码能把 job 推进 dormant —— jobs 队列的写入侧回来了。\n' +
      '这不一定是错，但 `apiV2.ts` 上 buildDormantTasks 头注释的第 2 条（"查不到新行"）\n' +
      '与第 4 条判据的前提已变，必须重读并更新：\n' +
      '  · 若队列真活了 → dormant 是活事实，要回答它在三页产品的哪一页露出；\n' +
      '  · 若只是新增了一个孤儿写入者 → 把它加进上面的白名单并写清为何不可达。',
    ).toEqual([])

    // 白名单本身也要有靶子：那两条若消失（比如 runner 被删），说明整族已在退役中，
    // 本读取面该跟着走 —— 判据 (a) 触发。
    expect(callers.sort(), '白名单里的 park 调用者不见了 —— jobs 队列可能正在整族退役，判据 (a) 触发')
      .toEqual([...UNREACHABLE_VIA_ORPHAN].sort())
  })

  it('判据自检：扫描器真的能抓到调用点（否则②恒绿）', () => {
    // 阴性对照的对照。用 `upsertWorkerTask` 当靶子——它是 jobs 队列**唯一还活着**的
    // 写入者（triageOps.redispatch 调它，写 'wanted'），同一套 codeOf + 正则必须抓得到。
    // 抓不到 = 扫描器空转 = ②的"零写入者"毫无意义。
    const hits = productionSources()
      .filter((f) => /\.upsertWorkerTask\s*\(/.test(codeOf(f)))
      .map((f) => relative(SRC_ROOT, f))
    expect(hits).toContain('v2/triageOps.ts')
  })
})
