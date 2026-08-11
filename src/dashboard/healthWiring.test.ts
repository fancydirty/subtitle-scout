// src/dashboard/healthWiring.test.ts —— Task ⑤ 的**源码级**接线断言。
//
// ── 为什么必须是源码断言（不执行代码）─────────────────────────────────────────
// 照 watchWiring.test.ts 末尾那三组的既有形态（`new ScoutDaemonV2(` / `events: scoutEvents` /
// `emit: (e) => scoutEvents.publish(e)`）。那边的理由逐字适用于这里：
//
// Task ④ 把「现在在处理什么」的快照挂在 ScoutEventBus 上并加了 `getCurrent()`，而审计指出
// **它在生产零读取点**。本仓栽过 6 次「有表有函数没人触发」（C12 → C35 → C43 → C21 →
// audio_langs → tmdb_seasons），且 cli/index.ts:260 明写这类接线靠源码级断言守卫。
//
// 隔壁 health.test.ts 那条「current 来自 getCurrent 的快照」是**行为**断言，它守不住这件事：
// 任何能凑出同样 JSON 的实现都能让它绿——比如有人"优化"成在 startDashboard 组装时
// `const cur = events?.getCurrent()` 求值一次，或者绕过总线自己去 meta 表里读一份快照
// （Task ④ 明确否掉的方案）。两者都会让端点在生产上说假话，而行为用例里那个刚 publish 完
// 就查的 bus 照样能对上。
//
// 这是弱证据（不执行代码），但守的东西很窄很硬：**/health 的响应体里，`current` 这个字段
// 的值必须直接来自 events.getCurrent() 的调用**。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * 丢掉整行的注释行（`//…` 与块注释的 `*` 续行），只留下带代码的行。
 *
 * ── 为什么这一步是刚性的（变异验证实测逼出来的）────────────────────────────────
 * 本端点的注释里**必然**写着它读 `ScoutEventBus.getCurrent()`（task 明确要求把数据源与
 * queue 裁决写死在注释里）。于是任何对源码原文做的正则都会被自己的文档喂饱：
 * 实测把 `current: events ? events.getCurrent() : null` 整行删成 `current: null` 之后，
 * 裸串版本的 `toContain('getCurrent()')` **仍然绿**；改成带点的 `/\.getCurrent\(\)/` 也**仍然绿**
 * （注释里写的正是 `ScoutEventBus.getCurrent()`，同样带点）。
 * 一条被自己的注释喂饱的接线断言等于没有——而这恰恰是本 task 唯一的硬要求。
 *
 * ── 为什么是**按行**丢，不是正则剥 `/*…*\/` ──
 * 第一版用 `s.replace(/\/\*[\s\S]*?\*\//g,'')` 剥块注释，结果把整个文件吃空了
 * （server.ts 的字符串字面量里存在 `/*` 形状的内容，正则从那里一路吃到下一个 `*\/`）——
 * 实测表现为 4 条断言在**未变异**的源码上全红。按行判断没有这个失控面：一行要么整行是
 * 注释、要么含代码，判据只看行首。代价是行尾注释（`foo() // 说明`）不被剥掉——无所谓，
 * 本文件的判据全是"某段代码在不在"，行尾注释只会让判据更严，不会让它假绿。
 */
function codeLines(s: string): string {
  return s
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

describe('GET /api/v2/health 源码级接线 · current 必须真的读 ScoutEventBus.getCurrent()', () => {
  // **只留代码行**。见 codeLines 的头注释：不剥注释的话本端点自己的文档就足以让
  // 每一条断言假绿（变异验证实测）。
  const src = codeLines(readFileSync('src/dashboard/server.ts', 'utf8'))

  /** `/api/v2/health` 那个分支体的源码文本。
   *
   *  为什么所有断言都要先切出这一段，而不是对整个 server.ts 做匹配：整文件匹配会被
   *  **本端点自己的注释**与**同名的接口声明**骗过——第一版就踩了两个：
   *   · `/current:\s*(.*)/` 匹配到了 HealthDTO 的字段声明 `current: ScoutCurrent | null`；
   *   · `not.toContain('listSubtitleQueue')` 被端点注释里那段"不许接 listSubtitleQueue"的
   *     论证判红（而那段论证是 task 明确要求写死在注释里的）。
   *  两次都是断言自己不精确，不是实现有问题。切分支体让判据落在**代码**上。
   *
   *  下界取下一个 `rawPath ===`（端点之间的天然边界）——刻意不数大括号：那需要在测试里
   *  写一个迷你解析器，而它自己出 bug 时表现为"断言静默匹配到空串"，比它要防的问题更隐蔽。 */
  function healthBranch(): string {
    const start = src.indexOf(`rawPath === '/api/v2/health'`)
    expect(start).toBeGreaterThan(-1)
    const next = src.indexOf('rawPath ===', start + 1)
    const branch = src.slice(start, next === -1 ? src.length : next)
    // 切出来必须是有内容的一段（防上面那个 indexOf 组合哪天退化成空串，让后续断言空转）。
    expect(branch.length).toBeGreaterThan(200)
    return branch
  }

  it('🔴 server.ts 里存在 getCurrent() 的**调用**（Task ④ 那个快照的唯一生产读取点）', () => {
    // 最外层的那道门：整个仓库里除了这里没有第二个生产读取点（有的话本断言要跟着扩，
    // 那正是"多了一处读取方"该被看见的时刻）。
    //
    // 判据是 `\.getCurrent\(\)`（**带点的方法调用**）而不是裸串 'getCurrent()'：
    // 变异验证实测到裸串版本在把 `current: events ? events.getCurrent() : null` 整行删成
    // `current: null` 之后**仍然绿**——因为端点自己的注释里写着"读取点 = getCurrent()"。
    // 一条被自己的文档喂饱的断言等于没有。带点的形态注释里不会出现（注释写的是无接收者的
    // 那种叙述形式），且真实调用必然带接收者。
    expect(src).toMatch(/\.getCurrent\(\)/)
  })

  it('🔴 `current` 字段的值就是 getCurrent() 的返回，不是别处凑出来的同形对象', () => {
    // 定位方式刻意用**字段名 + 调用**的邻接关系而非行号：本仓已有多处"注释硬写行号"在
    // 重构期持续腐烂的实例（watchWiring.test.ts 那条 translateEnabled 断言的注释记有实案）。
    //
    // 正则允许 `events ? events.getCurrent() : null` 与 `events?.getCurrent() ?? null` 两种
    // 写法（缺席降级的等价形态，本 task 的裁决只要求"不整体 503"，没规定用哪个语法），
    // 但**不允许** `current: null`、`current: someLocalSnapshot`、`current: cur`（组装时
    // 求值一次的那个坑）这些形态。
    const m = healthBranch().match(/current:\s*([^\n]*)/)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('getCurrent()')
  })

  it('🔴 四条接线都长在这个分支体内（不是别的端点顺手读了一下）', () => {
    // 前两条各自都能被"在别处调一次 getCurrent()、health 里另写一份"骗过（第一条只看
    // 全文件）。这一条把四个事实**锁在同一段文本里**：有人把 health 掏空成只回 current
    // 时，行为用例会红，但这条源码断言不该因此退化成一条只守 current 的孤证——
    // 它守的是"这个端点的四条接线都在这里"。
    const branch = healthBranch()
    expect(branch).toContain('getCurrent()')
    expect(branch).toContain('last_inspect_at')
    expect(branch).toContain('media_roots')
    expect(branch).toContain('engineEnabled(')
  })

  it('🔴 不许把 queue 接回来（§3.5:568 明令；§3.6 说要返回是文档自相矛盾）', () => {
    // 与 watchWiring.test.ts 那条 `new ScoutDaemon\(` 同一手法：表面上它今天恒绿，
    // 但它守的是**面向未来**的那一半裁决——下一个人读 §3.6 会以为端点残缺，照它把
    // listSubtitleQueue 接上去，正好踩中 :568（语义与 R4 冻结快照相反，会让活动页
    // total 与 SSE 的 total 对不上且越跑越飘）。成本为零。
    //
    // 判据是**调用形态与 import**，不是裸字符串：端点注释里那段"不许接 listSubtitleQueue"
    // 的论证正是 task 要求写死的，拿裸字符串判会把那段论证自己判红（第一版实测如此）。
    expect(src).not.toMatch(/listSubtitleQueue\s*\(/)
    expect(src).not.toMatch(/import[^\n]*listSubtitleQueue/)
    // 端点响应体里也不许出现 queue 字段（就算数据来自别处也不行——裁决砍的是这个字段本身）。
    expect(healthBranch()).not.toMatch(/\bqueue:/)
  })
})
