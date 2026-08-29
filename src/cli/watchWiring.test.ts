// 第 2 步（C2 + D5）：cmdWatch 组装出来的 daemon 必须是 V2，且 4 个运维器官全部接上。
//
// 为什么把组装抽成 buildDaemonV2Deps 这个纯函数来测，而不是直接测 cmdWatch：
// cmdWatch 是个 550 行的过程式启动序列（openDb / 起 dashboard HTTP 服务 / 装 SIGINT 处理器 /
// 结尾 process.exit(0)），在测试进程里跑它就是把测试进程自己搞死。把"接线"从"启动"里剥出来
// 之后，接线这件事变成可断言的纯数据映射——而它恰恰是本步唯一容易静默错的地方（C16：
// 器官漏接不会有任何报错，只是从此永不 checkpoint）。
//
// 剩下的"cmdWatch 到底 new 了哪个 daemon 类"这一条无法用纯函数覆盖，由文件末尾那条
// 源码断言兜住。它是弱证据（不执行代码），但它守的东西很窄很硬：有人重建第二个 daemon
// 入口、导致运维器官静默漏接一批时必须红（旧 ScoutDaemon 是这个错误形态的历史名字，
// 它本身已于第 7 步 B 组随 src/v2/daemon.ts 删除——详见那条用例自己的注释）。
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildDaemonV2Deps } from './watchWiring.js'
// 翻译工作台 jobId 的唯一构造入口（GC 炸弹修复）：不在测试里复述目录名格式，理由同 subtitleJobId。
import { translateJobId } from '../v2/ownIds.js'
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
      inspectEveryMs: () => 24 * 60 * 60 * 1000,
      log: () => {},
      now: () => 1_000,
      gcOrphans: vi.fn(() => 0),
      bootTimeMs: 500,
      dbMaintenance: vi.fn(),
      sweepWriteProbes: vi.fn(() => 0),
      runs: { pruneTraces: vi.fn(() => 0), insert: vi.fn() },
      traceRetentionDays: () => 30,
      preTick: async () => {},
      workPermitted: () => true,
      translateEnabled: () => false,
      // 第 4 步的两条翻译接线。**刻意在 WatchWiringArgs 里是必填**（同那 4 个运维器官的手法）：
      // 漏接不报错、只是翻译流恒休眠，而那与"还没接翻译"完全无法区分（C3/C45）。
      // 让类型层强制每个构造点都想一次，比事后靠一条断言去追要可靠。
      translateRunItem: async () => ({ status: 'installed' as const }),
      probe: async () => null,
      probeDuration: async () => null,
      // R-F10：默认 no-op（本文件多数用例不关心事件）。**必填字段**，故这里必须有默认——
      // 而"必填"本身就是那道防线：新增构造点漏接 emit 时 tsc 直接红，不会静默漏。
      emit: () => {},
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

  it('🔴 C34 收口：in-flight 集合原样透传，两条工作台的 jobId 都能进（翻译流已接入）', () => {
    // 这条用例的**前身**是"翻译流未接入 daemonV2，故集合里不会有 .subtitle-translate 的 jobId"
    // ——那条留痕的末句写着"第 4 步把翻译接进 daemonV2 时，必须把它的 jobId 也登记进同一个
    // 集合——那时这条注释是入口"。A live run once exposed stale workspace data; the fix uses this
    // entry: translateJobId lets the loop know the directory name,
    // daemonV2.advanceTranslateOnce 于是像字幕流一样登记/摘除。留着旧断言会把一个**已经不成立
    // 的世界观**钉死在测试里（"翻译 jobId 永远不该出现"），故连同论证一起改写。
    //
    // 本层（接线层）要守的只有一条：gcStaging 把 daemon 给的集合**原样**递给 gcOrphans，
    // 不筛、不拷、不加工。谁往集合里放什么是 daemon 的事（由 daemonV2.test.ts 分别钉住两条轨）。
    // 拷一份在这里恰好是危险的：GC 的判据是"此刻是否在被使用"，任何拷贝都可能在 await
    // 边界上变成陈旧快照，把跑了两小时的翻译工作台当孤儿 rm 掉（gcOrphans 头注的既有论证）。
    const { db, args } = mkArgs()
    const deps = buildDaemonV2Deps(args)
    const live = new Set(['subtitle:tmdb:7', translateJobId('tmdb:7', '/media/Show/E01.mkv')])
    deps.gcStaging!(live)
    const passed = (args.gcOrphans as any).mock.calls[0][1] as Set<string>
    // 同一个对象（不是等值副本）——"原样透传"这条契约只有引用相等才测得到
    expect(passed).toBe(live)
    expect([...passed].some(id => id.startsWith('translate'))).toBe(true)
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

  // 2026-08-28 死设置复活：inspectEveryMs 此前只有测试注入、生产从不接线（settings.scan_interval_ms
  // 到 daemon 之间断线）。现在它是 WatchWiringArgs 必填字段（同 4 运维器官/翻译流的手法：漏接不报错、
  // 只是巡检频率永远吃硬编码 24h），且惰性——设置页改完下一轮巡检即生效，不用重启容器。
  it('🔴 inspectEveryMs 被接上且惰性（改 scan_interval_ms 下一轮即生效）', () => {
    let every = 6 * 3600_000
    const { db, args } = mkArgs({ inspectEveryMs: () => every })
    const deps = buildDaemonV2Deps(args)
    expect(deps.inspectEveryMs!()).toBe(6 * 3600_000)
    every = 12 * 3600_000
    expect(deps.inspectEveryMs!()).toBe(12 * 3600_000)
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

  it('🔴 不许出现第二个 daemon 入口重建接线（D5；旧 ScoutDaemon 已于第 7 步 B 组删除）', () => {
    // 处理判断（第 7 步 B 组）：**保留这条，不删**，与上一批处理 watchV2 死守卫时同一裁决。
    //
    // 表面上它已永久绿——`ScoutDaemon` 这个类连同 src/v2/daemon.ts 已整体删除，今天没有任何
    // 符号能让它红。但它守的不是"那个类还在不在"，而是 D5 裁决的另一半、且是面向未来的：
    // **不许有人再造第二个 daemon 并在 cmdWatch 里构造它**。这个故障形态的代价极高且静默——
    // 第二个 daemon 意味着第二份接线，而那 4 个运维器官（+ preTick/workPermitted）漏接任何
    // 一个都不会报错，只是从此永不 checkpoint、永不备份、workspace 垃圾无人回收，直到软路由
    // 下一次掉电（2026-07-21 那次报废了 WAL 里 4MB 数据，db.ts:579-584 记有实案）。
    //
    // 正则刻意保持 `new ScoutDaemon\(` 而不是放宽成"任何 new XxxDaemon"：后者会把合法的
    // `new ScoutDaemonV2(` 一起判红（上一条用例正要求它出现）。ScoutDaemon 是这个错误形态的
    // 历史名字，留住这个名字就是留住那条裁决唯一的可执行痕迹，成本为零。
    expect(src).not.toMatch(/new ScoutDaemon\(/)
  })

  it('🔴 Dockerfile 的 CMD 仍指向 cli/index.js watch（D5：不换入口文件，运维器官接线天然保留）', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8')
    expect(dockerfile).toContain('"dist/cli/index.js", "watch"')
    // 下面这条防的**不再是** watchV2.ts（该文件已于第 7 步删除，现在没人能把 CMD 指过去）。
    // 保留的理由是它防的是 D5 裁决的另一半、且是面向未来的：谁要是重新造一个第二入口
    // （watchV2 是这个错误形态的历史名字）并把 CMD 指过去，运维器官接线就会静默漏接一批
    // （见本文件头注释的 WAL 掉电实案）。成本为零，且是这条裁决唯一的可执行痕迹。
    expect(dockerfile).not.toContain('watchV2')
  })

  it('cmdWatch 经 buildDaemonV2Deps 组装（防"绕过被测的接线函数、就地手写第二份"）', () => {
    expect(src).toContain('buildDaemonV2Deps(')
  })

  it('cmdWatch 组装的 find-subtitle worker 不许打开 librarySandbox', () => {
    // sandbox-library 命令可以传 true；watch 那条 makeFindSubtitleWorker 不许。
    const watchChunk = src.slice(src.indexOf('async function cmdWatch'), src.indexOf('async function cmdDoctor'))
    expect(watchChunk).not.toMatch(/librarySandbox:\s*true/)
    // 2026-08-29：worker 装配加了 r3subClient 注入（r3sub 两跳下载旁路）——匹配放宽到含该键。
    expect(src).toMatch(/makeFindSubtitleWorker\(\{ model: reasoningModel, adapters: realignAdapters, cacheRoot, tmdb, r3subClient \}\)/)
  })

  it('🔴 cmdWatch 传的 translateEnabled 是**真实双门控**，不是硬编码的常量', () => {
    // 为什么这一条必须是源码断言：buildDaemonV2Deps 的那两条用例注入的是**测试自己写的**
    // 替身函数，`translateEnabled: () => false` 这种硬编码在它们眼里与真实双门控完全等价，
    // 全绿。而生产上接错的后果是静默且相反的两种伤害：
    //   · 硬编码 false → 用户开了翻译，复查闸照旧去碰飞行中的翻译（D10 守卫 0 行 → 热循环）
    //   · 硬编码 true  → 用户没开翻译，handoff_translate 永不复查 → C41 永久卡死
    // 弱证据（不执行代码）但守的东西很窄很硬，与本文件末尾那条"入口是不是 V2"同一手法。
    //
    // 定位方式刻意用**符号名而非行号**：本仓已有多处"注释硬写行号"在删除重构期持续腐烂的
    // 实例（这条注释自己此前就写着 `cli/index.ts:767`，B 组删 daemon.ts 后已指向别的内容）。
    // 被守的判据是 cmdWatch 传给 buildDaemonV2Deps 的 `translateEnabled` 字段（搜符号名即达），
    // 口径 = TRANSLATE_* 凭证（tryAutoTranslateCfg）∧ settings 行为级开关（ai_translate_enabled）。
    // 它曾与旧 daemon 的 `dispatchTranslate` 字段逐字同源；该字段已随 src/v2/daemon.ts 于第 7 步
    // B 组删除，故今天这是全仓唯一一处此判据。将来若再添一处派活闸，必须回到 `translateEnabled`
    // 复用——两处各写一份判据，用户眼里"翻译开着"这一件事会在派活与复查两条路上得到相反
    // 答案（本仓已因"留两份漂移实现"栽过多次：D7 / C30）。
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

  // 2026-08-13：原先这里有一条「🔴 requestIngest 被接上」——守的是"装盘成功踢一脚扫描"
  // 这根注入线。那根线**已删除**：daemonV2 现在直接调自己的 requestScan()（同一进程内它
  // 就是那个扫描器，绕出去再注回来只是多一处能漏接线的地方）。原实现指向的 v2/ingest.ts
  // 一行 files 都不写，那一脚从来就是踢空的——完整实测证据见 v2/daemonV2.ts 的
  // requestScan 头注释。
  //
  // 用**负向锁**替代，而不是删掉了事：这条守的是"没人把那根注入线加回来"。加回来就意味着
  // 又有一个 optional、漏接静默、且可能再次指向错误目标的接线点。
  it('🔴 buildDaemonV2Deps 不再产出 requestIngest 注入线（daemon 自己调 requestScan）', () => {
    const { db, args } = mkArgs()
    const deps = buildDaemonV2Deps(args as any)
    expect('requestIngest' in deps).toBe(false)
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

// ─────────────────────────────────────────────────────────────────────────────
// R-F10：SSE 事件通道的接线。
//
// 为什么这一组必须存在：本仓栽过 6 次「写了某列/某能力，却没定谁来写、谁来读、谁来触发」
// （C12→C35→C43→C21→audio_langs→tmdb_seasons）。emit 漏接是**静默**的——daemon 照常跑、
// 测试照常绿、SSE 端点照常 200，只是那条流上永远一条事件都没有，而这与"系统正在歇着"
// 在界面上完全无法区分。同 4 个运维器官的既有守法：纯函数映射在这里断言，"cmdWatch 到底
// 有没有把总线同时喂给 daemon 与 dashboard"由文件末尾的源码断言兜住。
// ─────────────────────────────────────────────────────────────────────────────
describe('buildDaemonV2Deps · R-F10 SSE 事件通道', () => {
  it('🔴 emit 被接上（漏接 = SSE 流永远空着，与"系统在歇着"无法区分）', () => {
    const emit = vi.fn()
    const { db, args } = mkArgs({ emit })
    const deps = buildDaemonV2Deps(args as any)
    expect(deps.emit).toBeDefined()
    deps.emit!({ type: 'activity', message: 'x' })
    expect(emit).toHaveBeenCalledWith({ type: 'activity', message: 'x' })
    db.close()
  })

  it('🔴 emit 是**透传**而不是在这里就地求值/包装（总线换实例后 daemon 必须跟着换）', () => {
    const a = vi.fn(); const b = vi.fn()
    let cur = a
    const { db, args } = mkArgs({ emit: (e: any) => cur(e) })
    const deps = buildDaemonV2Deps(args as any)
    deps.emit!({ type: 'found', message: '1' })
    cur = b
    deps.emit!({ type: 'found', message: '2' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    db.close()
  })
})

describe('cmdWatch 源码级接线 · POST /api/v2/library/inspect', () => {
  const src = readFileSync('src/cli/index.ts', 'utf8')

  it('🔴 cmdWatch 把 requestInspect 交给 startDashboard，且与 requestScan 共用 daemonHolder', () => {
    // 漏接 = 端点永远 503「not configured」，界面上与「没跑 watch」无法区分。
    // 源码断言：cmdWatch 太过程式，测它会把测试进程自己搞死（见本文件头）。
    expect(src).toMatch(/requestInspect:\s*\(\)\s*=>/)
    expect(src).toMatch(/startDashboard\(\{[\s\S]*requestInspect/)
    expect(src).toMatch(/daemonHolder:\s*\{\s*current:\s*\{\s*requestScan:[\s\S]*requestInspect:/)
  })
})

describe('cmdWatch 源码级接线 · R-F10 SSE 通道（一条总线两个消费方）', () => {
  const src = readFileSync('src/cli/index.ts', 'utf8')

  it('🔴 cmdWatch 建了 ScoutEventBus，并**同时**喂给 dashboard 与 daemon', () => {
    // 这条守的正是本仓栽过 6 次的那个形态：只喂一头 = 有产无收（daemon 发了没人推）或
    // 有收无产（端点在但永远没数据），两者都测不出来、界面上都只是"很安静"。
    expect(src).toContain('new ScoutEventBus(')
    // dashboard 侧：startDashboard 的 events 参数
    expect(src).toMatch(/events:\s*scoutEvents/)
    // daemon 侧：buildDaemonV2Deps 的 emit 参数
    expect(src).toMatch(/emit:\s*\(e\)\s*=>\s*scoutEvents\.publish\(e\)/)
  })
})
