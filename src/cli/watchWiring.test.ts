// 第 2 步（C2 + D5）：cmdWatch 组装出来的 daemon 必须是 V2，且 4 个运维器官全部接上。
//
// 为什么把组装抽成 buildDaemonV2Deps 这个纯函数来测，而不是直接测 cmdWatch：
// cmdWatch 是个 550 行的过程式启动序列（openDb / 起 dashboard HTTP 服务 / 装 SIGINT 处理器 /
// 结尾 process.exit(0)），在测试进程里跑它就是把测试进程自己搞死。把"接线"从"启动"里剥出来
// 之后，接线这件事变成可断言的纯数据映射——而它恰恰是本步唯一容易静默错的地方（C16：
// 器官漏接不会有任何报错，只是从此永不 checkpoint）。
//
// 剩下的"cmdWatch 到底 new 了哪个 daemon 类"这一条无法用纯函数覆盖，由文件末尾那条
// 源码断言兜住。它是弱证据（不执行代码），但它守的东西很窄很硬：有人把入口切回旧
// ScoutDaemon 时必须红。
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildDaemonV2Deps } from './watchWiring.js'
import { openDb } from '../v2/db.js'

function mkArgs(over: Record<string, any> = {}) {
  const db = openDb(':memory:')
  return {
    db,
    args: {
      db,
      rootsProvider: () => ['/media'],
      identifyProvider: () => ({} as any),
      subtitleWorker: (async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] })) as any,
      targetLanguage: () => 'zh',
      log: () => {},
      now: () => 1_000,
      gcOrphans: vi.fn(() => 0),
      bootTimeMs: 500,
      dbMaintenance: vi.fn(),
      sweepWriteProbes: vi.fn(() => 0),
      runs: { pruneTraces: vi.fn(() => 0) },
      traceRetentionDays: () => 30,
      preTick: async () => {},
      workPermitted: () => true,
      translateEnabled: () => false,
      // 第 4 步的两条翻译接线。**刻意在 WatchWiringArgs 里是必填**（同那 4 个运维器官的手法）：
      // 漏接不报错、只是翻译流恒休眠，而那与"还没接翻译"完全无法区分（C3/C45）。
      // 让类型层强制每个构造点都想一次，比事后靠一条断言去追要可靠。
      translateRunItem: async () => ({ status: 'installed' as const }),
      requestIngest: () => {},
      probe: async () => null,
      probeDuration: async () => null,
      ...over,
    },
  }
}

describe('buildDaemonV2Deps · D5 四个运维器官全部接上', () => {
  it('🔴 dbMaintenance 被接上（WAL checkpoint + 天级 VACUUM INTO 备份；2026-07-21 掉电血案）', () => {
    const { db, args } = mkArgs()
    const deps = buildDaemonV2Deps(args)
    expect(deps.dbMaintenance).toBeDefined()
    deps.dbMaintenance!()
    expect(args.dbMaintenance).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('🔴 gcStaging 被接上，且**带真实 in-flight 集合**（C34：空集合会 rm 掉正在跑的工作台）', () => {
    const { db, args } = mkArgs()
    const deps = buildDaemonV2Deps(args)
    expect(deps.gcStaging).toBeDefined()
    deps.gcStaging!(new Set(['subtitle:tmdb:7']))
    // 断言到 gcOrphans 的实参：只断言"deps.gcStaging 存在"会让传 new Set() 的实现全绿，
    // 而那正是 C34 记的那个 bug 本身。
    expect(args.gcOrphans).toHaveBeenCalledWith(['/media'], new Set(['subtitle:tmdb:7']), 500)
    db.close()
  })

  it('🔴 gcStaging 的守备目录是每次现取（dashboard 加根后新根下的沙盒也要能被回收）', () => {
    let roots = ['/media/tv']
    const { db, args } = mkArgs({ rootsProvider: () => roots })
    const deps = buildDaemonV2Deps(args)
    roots = ['/media/tv', '/media/movies']
    deps.gcStaging!(new Set())
    expect(args.gcOrphans).toHaveBeenCalledWith(['/media/tv', '/media/movies'], new Set(), 500)
    db.close()
  })

  it('🔴 C34 决策留痕：翻译流未接入 daemonV2，故 in-flight 集合里不会有 .subtitle-translate 的 jobId', () => {
    // 这条用例是**决策的留痕**，不是行为断言：C34 说 `new Set()` 会 GC 掉正在跑的翻译工作台。
    // 处置分两半：
    //  ① `.subtitle-staging`（字幕工作台）——daemonV2 自己在跑，jobId 由它登记，已真实填充。
    //  ② `.subtitle-translate`（翻译工作台）——**daemonV2 里根本没有翻译流**（第 4 步才接，C3），
    //     所以本进程不可能有在飞行的翻译 jobId，填不出来也不需要填。
    // 那"正在跑的翻译工作台"从哪来？只能来自并发的手动 CLI（cmdTranslateItem）。它由 gcOrphans
    // 自己的两道既有防线兜住，与 jobId 集合无关：mtime 新于 bootTime（新建未写）+ 递归最新
    // mtime 在 10 分钟活性窗口内（R6-9 / R7-1 两次修复，stagingSandbox.test.ts 已钉住）。
    // 再加上 gcStaging 只在 boot 跑一次（daemonV2.test.ts 钉住），暴露窗口是启动那一瞬间。
    // 第 4 步把翻译接进 daemonV2 时，必须把它的 jobId 也登记进同一个集合——那时这条注释是入口。
    const { db, args } = mkArgs()
    const deps = buildDaemonV2Deps(args)
    deps.gcStaging!(new Set(['subtitle:tmdb:7']))
    const passed = (args.gcOrphans as any).mock.calls[0][1] as Set<string>
    expect([...passed].some(id => id.startsWith('translate'))).toBe(false)
    db.close()
  })

  it('🔴 sweepWriteProbes 被接上（isDirWritable 在云盘上留 0 字节探针，实测残留 175 个）', () => {
    const { db, args } = mkArgs()
    const deps = buildDaemonV2Deps(args)
    expect(deps.sweepWriteProbes).toBeDefined()
    deps.sweepWriteProbes!()
    expect(args.sweepWriteProbes).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('🔴 traceRetentionDays + runs 被接上（trace 快照按天修剪）', () => {
    const { db, args } = mkArgs({ traceRetentionDays: () => 7 })
    const deps = buildDaemonV2Deps(args)
    expect(deps.traceRetentionDays!()).toBe(7)
    deps.runs!.pruneTraces(123)
    expect(args.runs.pruneTraces).toHaveBeenCalledWith(123)
    db.close()
  })

  it('targetLanguage 与 roots 都是惰性求值（设置页改完下一轮生效，不用重启容器）', () => {
    let lang = 'zh'
    let roots = ['/media']
    const { db, args } = mkArgs({ targetLanguage: () => lang, rootsProvider: () => roots })
    const deps = buildDaemonV2Deps(args)
    lang = 'ja'; roots = ['/media', '/media2']
    expect(deps.targetLanguage).toBe('ja')
    expect(deps.rootsProvider!()).toEqual(['/media', '/media2'])
    db.close()
  })

  it('🔴 identify deps 也是惰性求值（holder 换代后 daemon 必须拿到新客户端，否则 wizard 落库白配）', () => {
    let gen = { tag: 'gen1' } as any
    const { db, args } = mkArgs({ identifyProvider: () => gen })
    const deps = buildDaemonV2Deps(args)
    gen = { tag: 'gen2' }
    expect((deps.identify as any).tag).toBe('gen2')
    db.close()
  })

  it('probe / probeDuration 被接上（C12：不接线则 embedded_langs 永远 NULL，judge 规则 2 静默失效）', () => {
    const { db, args } = mkArgs()
    const deps = buildDaemonV2Deps(args)
    expect(deps.probe).toBeDefined()
    expect(deps.probeDuration).toBeDefined()
    db.close()
  })

  it('🔴 translateEnabled 被接上（D14：阶段 2.6 的取件范围靠它分流）', () => {
    const { db, args } = mkArgs({ translateEnabled: () => true })
    const deps = buildDaemonV2Deps(args)
    // 不接线的后果是**静默**的：daemonV2 侧缺省 false → handoff_translate 恒参与复查 →
    // 用户真开了翻译时，复查闸会去碰飞行中的翻译（D10 守卫匹配 0 行 → 热循环）。
    expect(deps.translateEnabled).toBeDefined()
    expect(deps.translateEnabled!()).toBe(true)
    db.close()
  })

  it('🔴 translateEnabled 是**惰性求值**（dashboard 改 ai_translate_enabled 后下一轮生效，不用重启）', () => {
    // 与 targetLanguage / rootsProvider / identify 同一条既有口径。求值一次会把 watch 启动
    // 那一刻的开关冻死在进程里：用户关掉翻译后，handoff_translate 行要等容器重启才恢复复查——
    // 而它们正是最需要被放回来的那批（C41 的永久卡死）。
    let on = false
    const { db, args } = mkArgs({ translateEnabled: () => on })
    const deps = buildDaemonV2Deps(args)
    on = true
    expect(deps.translateEnabled!()).toBe(true)
    db.close()
  })

  it('preTick / workPermitted 被接上（wizard 落库同进程点火 + setup 模式不空烧）', () => {
    const { db, args } = mkArgs()
    const deps = buildDaemonV2Deps(args)
    expect(deps.preTick).toBeDefined()
    expect(deps.workPermitted!()).toBe(true)
    db.close()
  })
})

describe('cmdWatch 的入口切换（C2：容器重启后必须跑 daemonV2）', () => {
  const src = readFileSync('src/cli/index.ts', 'utf8')

  it('🔴 cmdWatch 构造 ScoutDaemonV2 并用它 run', () => {
    expect(src).toContain('new ScoutDaemonV2(')
    expect(src).toMatch(/const daemon = new ScoutDaemonV2\(/)
    expect(src).toMatch(/await daemon\.run\(shutdown\.signal\)/)
  })

  it('🔴 旧 ScoutDaemon 不再被 cmdWatch 构造（切换是"内部替换"，D5）', () => {
    expect(src).not.toMatch(/new ScoutDaemon\(/)
  })

  it('🔴 Dockerfile 的 CMD 仍指向 cli/index.js watch（D5：不换入口文件，运维器官接线天然保留）', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')
    expect(dockerfile).toContain('"dist/cli/index.js", "watch"')
    expect(dockerfile).not.toContain('watchV2')
  })

  it('cmdWatch 经 buildDaemonV2Deps 组装（防"绕过被测的接线函数、就地手写第二份"）', () => {
    expect(src).toContain('buildDaemonV2Deps(')
  })

  it('🔴 cmdWatch 传的 translateEnabled 是**真实双门控**，不是硬编码的常量', () => {
    // 为什么这一条必须是源码断言：buildDaemonV2Deps 的那两条用例注入的是**测试自己写的**
    // 替身函数，`translateEnabled: () => false` 这种硬编码在它们眼里与真实双门控完全等价，
    // 全绿。而生产上接错的后果是静默且相反的两种伤害：
    //   · 硬编码 false → 用户开了翻译，复查闸照旧去碰飞行中的翻译（D10 守卫 0 行 → 热循环）
    //   · 硬编码 true  → 用户没开翻译，handoff_translate 永不复查 → C41 永久卡死
    // 弱证据（不执行代码）但守的东西很窄很硬，与本文件末尾那条"入口是不是 V2"同一手法。
    //
    // 口径必须与 cli/index.ts:767 的 dispatchTranslate 逐字同源（TRANSLATE_* 凭证 ∧
    // settings 行为级开关）：两处若各写一份判据，用户眼里"翻译开着"这一件事会在派活与复查
    // 两条路上得到相反答案——本仓已因"留两份漂移实现"栽过多次（D7 / C30）。
    const m = src.match(/translateEnabled:\s*\(\)\s*=>([\s\S]{0,200}?)\n/)
    expect(m).not.toBeNull()
    const body = m![1]
    expect(body).toContain('tryAutoTranslateCfg')
    expect(body).toContain('ai_translate_enabled')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 第 4 步（C3 + R19）：翻译流的接线。
//
// 这一条与那 4 个运维器官是**同一类伤害**：漏接不报错，只是翻译从此永不推进——而"翻译永不
// 推进"恰恰是本步开工前的现状（C3/C45：daemonV2 里 translate 零命中），所以漏接之后的系统
// 与漏接之前**完全无法区分**，界面上、日志上、库里都看不出差别。故必须逐条钉住。
// ─────────────────────────────────────────────────────────────────────────────
describe('buildDaemonV2Deps · 翻译流接线（第 4 步 / C3 + R19）', () => {
  it('🔴 translateRunItem 被接上（漏接 = 翻译流恒休眠，与"没接翻译"不可区分）', () => {
    const runItem = vi.fn(async () => ({ status: 'installed' as const }))
    const { db, args } = mkArgs({ translateRunItem: runItem })
    const deps = buildDaemonV2Deps(args as any)
    expect(deps.translateRunItem).toBeDefined()
    db.close()
  })

  it('🔴 translateRunItem 是**惰性取用**（不在组装时求值一次）', () => {
    // 与 identify holder 同一条既有理由（spec A §4.2）：翻译 runItem 内部攥着 LLM 客户端与
    // adapters，而 secrets_version 变化时 preTick 会整体重建它们。组装时求值一次 =
    // 把"点火前的 null 世界"冻死在进程里，wizard 里配完 TRANSLATE_* 也要等容器重启才生效。
    let built = 0
    const { db, args } = mkArgs({
      translateRunItem: () => { built++; return Promise.resolve({ status: 'installed' as const }) },
    })
    buildDaemonV2Deps(args as any)
    expect(built).toBe(0)      // 只组装、不调用
    db.close()
  })

  it('🔴 requestIngest 被接上（装盘成功踢一脚扫描，R24 只有扫描有权写 covered）', () => {
    const { db, args } = mkArgs({ requestIngest: vi.fn() })
    const deps = buildDaemonV2Deps(args as any)
    expect(deps.requestIngest).toBeDefined()
    db.close()
  })
})

describe('cmdWatch 源码级接线 · 翻译流（第 4 步）', () => {
  const src = readFileSync('src/cli/index.ts', 'utf8')

  it('🔴 cmdWatch 传了 translateRunItem，且它来自 makeDaemonTranslateRunItem（与手动 CLI 同源）', () => {
    // 为什么是源码断言：与本文件既有的 translateEnabled 那条同一手法。buildDaemonV2Deps 的
    // 用例注入的是测试自己写的替身，`translateRunItem: async () => ({status:'installed'})`
    // 这种硬编码在它们眼里与真实 agent 完全等价、全绿。而生产上真正要守的是"接的是那个
    // 会跑 workspace agent 的实现"，且与手动 CLI 共用同一份组装（防两处漂移）。
    expect(src).toMatch(/translateRunItem:/)
    expect(src).toContain('makeDaemonTranslateRunItem')
  })

  it('🔴 翻译 runItem 的凭证走 tryAutoTranslateCfg（不许回退 LLM_* 弱模型烧配额）', () => {
    // 既有铁律（cli/index.ts 原 translate 分支的注释）：只认显式 TRANSLATE_* 三件套，
    // 绝不回退 LLM_*=mimo。回退的后果是用一个过不了质量闸的弱模型反复 held，
    // 每次都是一个付费 session（旧世界实案：job29 重试 11 次全同样错误）。
    expect(src).toContain('tryAutoTranslateCfg')
  })
})
