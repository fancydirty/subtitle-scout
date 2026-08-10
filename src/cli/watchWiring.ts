// src/cli/watchWiring.ts：cmdWatch 的 daemonV2 接线（第 2 步 / C2 + C16 + D5）。
//
// 为什么这段接线要从 cmdWatch 里剥出来单独成文件：cmdWatch 是个 550 行的过程式启动序列
// （openDb / 起 dashboard HTTP 服务 / 装 SIGINT 处理器 / 结尾 process.exit(0)），在测试进程里
// 跑它就是把测试进程自己搞死——于是它整体是不可测的。而本步唯一容易**静默**出错的地方恰恰
// 就在这段接线里：4 个运维器官漏接一个不会有任何报错，只是从此永不 checkpoint、永不备份、
// workspace 垃圾无人回收，直到软路由下一次掉电（2026-07-21 那次报废了 WAL 里 4MB 数据，
// db.ts:579-584 记有实案）。剥出来之后"接线"变成可断言的纯数据映射（watchWiring.test.ts）。
//
// 切换方式是"cmdWatch 内部把 ScoutDaemon 换成 ScoutDaemonV2"，**不换 Dockerfile 的 CMD**
// （D5）：这样 4 个运维器官的接线天然留在原处，不用在第二个入口文件里重建第二份。本仓已经
// 反复因"留两份实现漂移"栽过（D7 的 findOverlappingRoot、C30 的两套字幕标签集）。那个备选
// 入口 watchV2.ts 已于**第 7 步删除**——正是这条裁决的执行结果（它从未被 CMD 指过）。
import type { DaemonV2Deps } from '../v2/daemonV2.js'
import type { ScoutDb } from '../v2/db.js'
import type { IdentifySchedulerDeps } from '../v2/identifyScheduler.js'
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'
import type { FindSubtitleTask, FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'
import type { TranslateRunItemResult } from '../v2/translateWorkerTask.js'

export interface WatchWiringArgs {
  db: ScoutDb
  /** 惰性守备目录（cmdWatch 的 currentRoots：每次查 media_roots 表）。dashboard 加根后
   *  下一轮巡检就能扫到——不许在这里冻结成一份静态数组（dashboard G4 的既有属性）。 */
  rootsProvider: () => string[]
  /** 惰性识别 deps（spec A §4.2 holder：secrets_version 变化时长命客户端整体重建换 current，
   *  消费方一律经 holder 现取）。求值一次会把"点火前的 null 世界"冻死在进程里——wizard 落库
   *  后 preTick 重建了客户端，daemon 却还拿着旧的那份。 */
  identifyProvider: () => IdentifySchedulerDeps
  subtitleWorker: (task: FindSubtitleTask) => Promise<FindSubtitleBatchReport>

  /** 惰性目标语言（settings.target_languages 行为级 > env 部署级，债务D5 的既有口径）。 */
  targetLanguage: () => string
  log: (msg: string) => void
  now: () => number

  // ── 4 个运维器官的原料（D5 验收清单）──
  /** files/stagingSandbox.ts 的 gcOrphans。传函数而不是直接在这里 import 调用，是为了让
   *  "传进去的 in-flight 集合到底是什么"能被测试断言到——C34 记的 bug 就是这里传了 new Set()。 */
  gcOrphans: (roots: string[], activeJobIds: ReadonlySet<string>, bootTimeMs: number) => number
  /** 进程启动时间——gcOrphans 的两条保留条件之一（mtime 新于 bootTime 的"新建未写"工作台）。 */
  bootTimeMs: number
  /** 已预绑定 db/cacheRoot/state 的 runDbMaintenance 闭包（内部时间门控）。 */
  dbMaintenance: () => void
  /** 已预绑定守备目录的写探针清扫闭包。 */
  sweepWriteProbes: () => number
  runs: { pruneTraces: (beforeMs: number) => number }
  traceRetentionDays: () => number

  // ── 切换时同样不许丢的（与 4 器官同一类伤害）──
  preTick: () => Promise<void>
  workPermitted: () => boolean
  /** 翻译总开关的**双门控**（TRANSLATE_* 凭证 ∧ settings.ai_translate_enabled==='true'）。
   *  阶段 2.6 停牌复查闸的取件范围靠它分流（D14 / C41）。
   *
   *  必须惰性（同 targetLanguage / rootsProvider 的既有口径）：`ai_translate_enabled` 是行为级
   *  开关，用户在 dashboard 里改。求值一次 = 把 watch 启动那一刻的开关冻死在进程里，用户关掉
   *  翻译后 handoff_translate 行要等容器重启才恢复复查——而它们正是最需要被放回来的那批。 */
  translateEnabled: () => boolean
  /** 翻译一个视频（第 4 步 / C3 + R19）。生产实现是 `makeDaemonTranslateRunItem`，与手动
   *  `translate-item` CLI 共用同一份组装（防两处漂移）。
   *
   *  **必须惰性**（同 identifyProvider 的 holder 口径 / spec A §4.2）：runItem 内部攥着 LLM
   *  客户端与 adapters，而 secrets_version 变化时 preTick 会整体重建它们。组装时求值一次 =
   *  把"点火前的 null 世界"冻死在进程里，wizard 里配完 TRANSLATE_* 也要等容器重启才生效。
   *  故这里收的是"每次调用时才现建"的那个函数本身，buildDaemonV2Deps 只做透传、绝不调用。 */
  translateRunItem: (videoPath: string) => Promise<TranslateRunItemResult>
  /** 装盘成功后踢一脚扫描（R24：只有扫描有权把 sub_status 写成 covered，越早扫到越早解除停牌）。 */
  requestIngest: () => void
  probe: (videoPath: string) => Promise<EmbeddedSubtitleTrack[] | null>
  probeDuration: (videoPath: string) => Promise<number | null>
}

/** 把 cmdWatch 已经组装好的原料映射成 DaemonV2Deps。纯函数、无副作用、不 new 任何东西。 */
export function buildDaemonV2Deps(args: WatchWiringArgs): DaemonV2Deps {
  return {
    db: args.db,
    // roots 是启动快照（类型要求非空），运行期真相一律走 rootsProvider——两者必须同源，
    // 否则"启动时是一份、运行期是另一份"这种漂移会让删除作用域在第一轮就出错。
    roots: args.rootsProvider(),
    rootsProvider: args.rootsProvider,
    // getter 而不是求值一次（同 targetLanguage）：daemon 每次读 deps.identify 都拿到 holder
    // 当前那一代客户端。求值一次会把"点火前的世界"冻死在进程里——preTick 重建了客户端，
    // daemon 却还攥着旧的那份，wizard 落库等于白配。
    get identify() { return args.identifyProvider() },
    subtitleWorker: args.subtitleWorker,
    // getter：设置页改 target_languages 后下一轮巡检即生效，不用重启容器（债务D5 口径）。
    // 用 get 访问器而不是求值一次——后者会把 watch 启动那一刻的语言冻死在进程里。
    get targetLanguage() { return args.targetLanguage() },
    log: args.log,
    now: args.now,

    // ── D5：4 个运维器官 ──
    dbMaintenance: args.dbMaintenance,
    // in-flight 集合由 daemon 提供（它是唯一知道"现在有哪个工作台在飞"的人）。
    // C34：旧接线硬编码 new Set()，而 gcOrphans 的保留条件之一是"这个工作台正在被使用"
    // ——空集合意味着它会 rm 掉正在被 agent 写入的沙盒。现在这个参数是真实集合。
    // roots 每次现取：dashboard 加根后，新根下的 .subtitle-staging 也要能被回收。
    gcStaging: (inFlight) => args.gcOrphans(args.rootsProvider(), inFlight, args.bootTimeMs),
    sweepWriteProbes: args.sweepWriteProbes,
    traceRetentionDays: args.traceRetentionDays,
    runs: args.runs,

    preTick: args.preTick,
    workPermitted: args.workPermitted,
    // D14：传函数本身（不是 `args.translateEnabled()` 求值一次）——daemonV2 每轮巡检现取。
    translateEnabled: args.translateEnabled,
    // 第 4 步（C3 + R19）：翻译流的两条接线。同样传函数本身、绝不在这里调用——
    // runItem 每次调用现建 LLM 客户端与 adapters（见 WatchWiringArgs.translateRunItem 的论证）。
    // 漏接的伤害与那 4 个运维器官同型且更隐蔽：翻译流恒休眠，而这与"还没接翻译"完全无法区分
    // （C3/C45 记的正是这个现状），界面、日志、库里都看不出差别。
    translateRunItem: args.translateRunItem,
    requestIngest: args.requestIngest,
    // C12：复用 files/streamProbe.ts 的既有实现（cli 给旧 ingest 接的是同一对函数），不写第二份。
    // 漏了这两行的后果是"测试绿、生产漏"：files.embedded_langs 继续全 NULL，
    // judge 规则 2 与 D9 的 translatable 预判照旧静默失效。
    probe: args.probe,
    probeDuration: args.probeDuration,
  }
}
