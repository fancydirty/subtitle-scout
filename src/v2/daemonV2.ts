// src/v2/daemonV2.ts：新架构 daemon（巡检模型）。
// spec: docs/design/2026-08-08-daemon-inspection-model.md
//
// 用户裁决：工作台语义是"有活就一直跑，跑完歇，明天再巡检"（对齐 Jellyfin 库扫描频率），
// **不是 30s tick 轮询**（旧架构 orchestrator 残留思维）。
//
// 每天一次巡检（距上次满 24h）：
//   阶段 1：机械扫描守备目录 → files 表（新文件入库，指纹跳过）
//   阶段 2：识别工作流（上游）——识别工作台有活就一直跑，跑空才进下一步
//   阶段 2.5：judge（B-1 补齐）——识别绑定后判 needs_subtitle
//   阶段 3：字幕工作流（下游）——字幕工作台有活就一直跑，跑空才结束
//   阶段 4：停，歇着，等明天
import { walkVideoFiles } from '../daemon/selfScan.js'
import { statSync } from 'node:fs'
import { toMediaFileRow, isScannable } from './scanner.js'
import type { ScoutDb } from './db.js'
import { listIdentifyQueue, runIdentifyWorkDir, type IdentifySchedulerDeps } from './identifyScheduler.js'
import { listSubtitleQueue, runSubtitleWorkDir, subtitleJobId, type SubtitleQueueItem } from './subtitleScheduler.js'
import { judgeSubtitle, judgeTranslatable, type TranslatableDeps } from './subtitleJudge.js'
import { tagsForLanguage } from '../agent/languages.js'
import { findExternalSidecar, listSidecarLanguages } from '../files/sidecar.js'
// R-F15：目标语言 → sidecar_langs 记账值域的换算（zh → {zh-Hans, zh-Hant}）。与换语言重判
// 共用**同一份**换算，不另写第二份——两份必然漂移（C30 的原案就是两处标签集各漏一半）。
import { coverageValuesFor } from './retarget.js'
import { existsSync, readdirSync } from 'node:fs'
import { isDirWritable } from '../core/mediaContext.js'
import { SettingsRepo } from './settingsRepo.js'
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'
import { mapWithConcurrency } from './probeConcurrency.js'
// C21 回填 pass 用它把 works.id（'tmdb:<id>'）解回 TMDB id。复用 ownIds 这一份唯一解析入口，
// 不在这里另写一遍 slice(5)——本仓已因"两份实现漂移"栽过（D7 的 findOverlappingRoot）。
import { tmdbIdFromOwnId, translateItemId, translateJobId } from './ownIds.js'
// R-F5 应有集回填：复用既有的 tmdbCatalog 写入方，**不在这里另写一份季集抓取**。
// TTL 门、gain-path 降级（拿不全所有季就一行不落）两条语义都长在它里面，回填 pass 只负责
// "把 works 里的 tv 一个个喂给它"——刷新节奏因此只有一个权威。
import { refreshSeriesCatalog } from './tmdbCatalog.js'
// R-F10：SSE 事件的载荷类型（只引类型，总线实例由 cmdWatch 注入——daemon 不认识总线本体，
// 同 reasoningAgent 只引 TraceEvent 类型不引 traceBus 单例的既有分层）。
import type { ScoutEventInput } from '../core/scoutEvents.js'
// 语言集合的唯一定义处（C31 末段 / 任务 G 收敛）：judge 的喂料与翻译流的语言门同源。
import {
  FETCHABLE_SOURCE_LANGS, EXTRACTABLE_SOURCE_LANGS,
  listNewTranslateCandidates, applyTranslateOutcome,
  type TranslateRunItemResult,
} from './translateWorkerTask.js'

export const INSPECT_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 维护循环的节拍——也就是 run() 的 idle sleep 周期。
 *
 *  为什么运维必须挂在这一层而不是巡检里面（D5 的关键取舍）：巡检是**每日一次**，而
 *  `wal_checkpoint(TRUNCATE)` 每天才做一次等于把 WAL 里一整天的写入押在"今天不掉电"上——
 *  2026-07-21 那次软路由掉电报废的正是 WAL 里 4MB 未 checkpoint 的数据（db.ts:579-584）。
 *  旧 daemon 的组织方式是"维护循环不受产工作闸限制"（daemon.ts 的 2c/2d 分支跑在
 *  `if (!permitted) return` 之外），这里照同一思路：维护在时间闸**之外**，每 5 分钟一拍，
 *  内部各器官自带更粗的时间门（dbMaintenance 内部小时/天级、trace 修剪天级）。 */
export const MAINTENANCE_TICK_MS = 5 * 60 * 1000

/** 巡检抛错后的重试退避（D4 的"独立短 backoff"那条分支）。
 *
 *  为什么不是"失败就完全不推进任何时刻"：那样下一拍（5 分钟后）就会重跑整轮巡检，而巡检
 *  里有识别/字幕两条付费 LLM 工作台——一个持续性故障（比如 TMDB key 过期）会变成每 5 分钟
 *  烧一轮的热循环。为什么不是"失败也推进 24h 闸"：那正是 C22 本身（挂载抖 5 分钟修好，
 *  系统睡满一天，与 R8"优雅恢复"的本意正相反）。
 *
 *  故分账：24h 闸只由**成功**的巡检推进（记开始时刻），失败另记一个短退避时刻。30 分钟是
 *  "挂载抖动/网盘限流这类几分钟级故障能在同一天自愈"与"别把持续性故障做成热循环"之间的
 *  折中；退避只存进程内存，进程重启即重试（重启是运维的显式动作，不该被上一次的失败罚站）。 */
export const INSPECT_FAILURE_BACKOFF_MS = 30 * 60 * 1000

/** trace 快照修剪的时间门（照旧 daemon 的 `last_trace_prune_at` meta 手法，一天一次足矣）。 */
const TRACE_PRUNE_EVERY_MS = 24 * 60 * 60 * 1000


/** B 档轮转复核的周期（D12）：每次检测后把 `sub_recheck_at` 推到 now + 这个间隔，
 *  于是全库自然摊平成"每个文件每周复核一次"，单轮开销 ≈ 全库 1/7。
 *
 *  为什么是"检测后推 7 天"而不是"每轮扫全库"：R24 让扫描承担"每个视频当前有没有同名中文
 *  字幕"这项事实观察，代价是 21 个中文标签 × 4 种扩展名 = 84 次 stat/文件，而生产上有个守备
 *  目录是 115 网盘的 rclone FUSE 挂载（stat 代价放大约 46 倍）。几万文件全量复核就是把"本该
 *  秒级的机械扫描"变成跑一整天，期间删除清理与识别/字幕工作台全被堵在后面。 */
const SUB_RECHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

/** D17 回填 pass 的每批上限（spec §4 第 3 步前置迁移 2 明写 200）。
 *
 *  这是**硬上限而不是调优参数**：生产有个守备目录是 115 网盘的 rclone FUSE 挂载，单文件
 *  ffprobe 实测 12-16s。一次探完全库（存量 248 行只是今天的量级）就是把 boot 拖成几小时，
 *  期间删除清理、识别、字幕三条主路全被堵在后面——而回填只是让存量行**重新被 judge 看一眼**，
 *  晚一天完成没有任何实质损失。剩余行留 NULL，下次启动继续，靠谓词自然收敛、不丢活。 */
const BACKFILL_BATCH_SIZE = 200

/** C46：R8 两道闸门的**当场重试**退避阶梯（毫秒），长度即重试次数。
 *
 *  生产实测（2026-08-11 02:48:39）：Movies 这个根读出 0 个媒体文件走了 R8 保护，而同一轮里
 *  Anime/TV 两个根扫出 1155 个文件一切正常；20 分钟后手工 ls 同一目录完全正常（36 个作品
 *  目录、51 个文件、2s 走完、rclone 日志零错误），随后连做 30 轮读取零失败。结论：
 *  openlist WebDAV + rclone FUSE 有**几秒级的瞬时读取抖动**，且抖动时 readdir **不抛错、
 *  只返回空数组**。R8 保护本身做对了（没把"看起来是空的"当成"文件都被删了"去清库），
 *  但它只是 `continue` 等下一轮——而下一轮是 **24 小时后**。一次几秒的抖动被日巡检模型
 *  放大成整整一天不处理该根；若每天巡检那一刻恰好都抖一下，这个根**永远**不被处理，
 *  日志却只平静地说"跳过"。
 *
 *  为什么是 2 次 / 1s+3s 这个保守值：
 *   · **次数**取 2 —— 观测到的抖动是"下一秒就好"，2 次覆盖 4 秒窗口已远超实测形态；
 *     再多只是在真掉线时把每轮巡检的空转拉长（Movies 一趟全量 readdir 实测 44s，
 *     3 次就是 2 分钟），而真掉线本就该由 R8 保护接住、等下一轮，不该在这里死磕。
 *   · **递增**（1s→3s）而非等长 —— 抖动最常见的成因是网盘侧限流/连接重建，等长间隔
 *     等于拿同样的节奏再撞两次；递增给对端喘息窗口。
 *   · **绝不密集重试** —— 这是慢挂载不是本地盘，紧凑重试正是会把 115 打崩的那个行为。
 *     总退避 4s 相对于 24 小时的损失可以忽略，相对于一趟 44s 的 readdir 也只是零头。 */
const R8_RETRY_BACKOFFS_MS = [1000, 3000]

/** C47：R8 第三道闸的**存活比例**下限。本轮扫到的行数 / 库里该根既有的行数 低于此值
 *  即判定"读取不可信"，触发一次确认性重读（见 scanOnce 里的三分处置）。
 *
 *  生产实测（2026-08-11 04:07）——这是一次**真实数据损失**，不是推演：
 *      scan: 删除磁盘上已消失的文件 572 行（R7）: .../Mediary Scout/TV
 *      scan: scanned=720 upserted=135 skipped=2
 *  上一轮扫到 1155，这一轮只读出 720，差集 572 行被当成"磁盘上已消失"删掉，而磁盘上一个
 *  文件都没少。R8 原有两道闸只认"抛错"和"整根 0 个"，**部分成功**这第三种形态毫无防线——
 *  它长得跟"用户真的删了 572 个文件"一模一样。
 *
 *  ★ 为什么是存活比例，不是删除比例（这个方向搞反一次，守卫就完全失效）：
 *  出事那轮库里既有 = 720 + 572 = 1292。直觉上"删掉了 572/1292 ≈ 44%，快一半了"，
 *  于是很容易定出"删除超过 50% 才拦"——但守卫真正要比的是 seen/existing = 720/1292
 *  = **55.7%**，它**高于** 50%。按删除比例定阈值的话，这次事故会原样再发生一次。
 *  （用用户记忆里的 1155 做分母也一样：720/1155 = 62.3%，同样高于 50%。）
 *
 *  ★ 为什么 80% 挡不住用户的真实删除——阈值必须落在这个区间里：
 *   · 下界（必须拦住的）：生产事故的 55.7%，以及用 1155 做分母的 62.3% → 阈值须 > 0.623
 *   · 上界（必须放行的）：用户删掉一整季 20/351，存活 331/351 = 94.3% → 阈值须 < 0.943
 *     区间 (0.623, 0.943)，取 0.80 ——大致居中，两侧都留足余量，且能用一句人话说清：
 *     "一轮之内消失超过 20% 就先别信"。
 *   · 按这个阈值，用户一次删到多少集才会**触发**守卫？351 集的库要一次删掉 71 集
 *     （≈ 3.5 整季）才跌破 80%。而即便触发了也**不等于不删**：确认性重读只要复现同一个
 *     数字，删除照常执行（见下）。所以 80% 的代价上限只是"一次超大规模删除多花一趟
 *     readdir 并延后几秒"，不存在"用户删了但库里清不掉"这种结局。
 *
 *  ★ 为什么必须配确认性重读，而不能是纯比例守卫：
 *  纯比例守卫会把真实的大规模删除**永久锁死**——库 351 / 盘 200 → 57% → 拦下不删 →
 *  下一轮库还是 351、盘还是 200 → 又拦 → 永远，日志每轮平静地说"跳过删除"。这正是 D18
 *  （sub_recheck_at 停在 NULL 再没人复核）和 C46（抖一下停摆一整天）栽过的那类静默失效，
 *  不能在修一个删库 bug 的同时把它请回来。
 *  判别真实删除与 FUSE 抖动的信号是现成的、且不需要任何配置或持久状态：
 *  **真实删除在两次读取之间是稳定的，抖动不是。** 故三分：
 *   ① 重读恢复到 ≥ 阈值 → 抖动，用重读结果照常入库+删除（顺带救回这一轮，同 C46 的收益）
 *   ② 重读拿到**同一个**数字 → 稳定事实 → 确系用户删除 → 照删，无死锁
 *   ③ 重读拿到**不同的**低数字 → 两次读取自相矛盾，没有一个可信 → 跳过该根（R8 处置）
 *  用户点名的最坏情况"每次都是不同的部分"落在 ③，正是最该跳过的那一档。
 *
 *  ★ 为什么不给开关（沿用 R-F9 的教训：设置页铺 33 个字段是反效果）：
 *  会被误拦的合法场景只有"一次删掉 >20% 且删除动作恰好横跨两次读取之间"，而它的后果
 *  仅仅是延后到下一轮（那时两次读取都会看到删除后的稳定状态，走 ②）。既然没有"用户想
 *  删却永远删不掉"的结局，就不存在必须由用户绕过的场景，也就不需要开关。 */
const R8_MIN_SURVIVAL_RATIO = 0.8

/** R20 的 MVP 语言边界，喂给 judgeTranslatable（R21 + D9）。
 *
 *  两个集合**刻意不同**，这正是 R20 的裁决内容：
 *   · 外挂抓取仅 en —— OpenSubtitles 靠 imdb 命中；日语要等 F2 的 jimaku 落地（C6）
 *   · 内嵌轨抽取 en/ja 皆可 —— 抽轨是纯本地 ffmpeg 操作、零 provider 依赖，天然比抓取宽
 *
 *  定义已在第 4 步任务 G 里收敛到 `translateWorkerTask.ts`（C31 末段）。3-2 写这段时两处
 *  各有一份常量、注释里记着"第 4 步重接翻译时应把那个常量也拆成两个，届时两处收敛成一份"
 *  ——就是现在。这里只做引用组装，**不留第二份字面量**：语言映射分叉的那天没有任何测试会红，
 *  只是日漫又开始被判死（本仓已因"两份漂移实现"栽过多次，见 D7 的 findOverlappingRoot、
 *  C30 的两套字幕标签集）。 */
const TRANSLATABLE_LANGS: TranslatableDeps = {
  fetchableSourceLangs: FETCHABLE_SOURCE_LANGS,
  extractableSourceLangs: EXTRACTABLE_SOURCE_LANGS,
}


export interface DaemonV2Deps {
  db: ScoutDb
  /** 守备目录的**启动快照**。保留是为了不动既有构造点/测试；运行期真相请走 rootsProvider。 */
  roots: string[]
  /** 守备目录的惰性提供者（cmdWatch 侧 = `settingsRepo.listRoots()`）。
   *
   *  为什么必须惰性：守备目录是产品层配置（media_roots 表，dashboard 里增删）。上面那个
   *  `roots: string[]` 就是被冻死的形态——**启动那一刻读一次表就再不刷新**，用户在 dashboard
   *  里加根后要重启容器才生效（历史上 watchV2.ts 那条独立入口整体就是这么接的，它已于第 7 步
   *  随死代码清理删除）。cmdWatch 侧的既有口径是 `currentRoots()` 每次现取（dashboard G4），
   *  切过来不能退化。
   *
   *  **同一轮巡检内取一次快照**（见 runInspection）：中途变动会让扫描作用域与删除作用域
   *  对不上——deleteMissing 的 deeperPrefixes 是从 roots 算的，跑到一半少了一个根，那个根
   *  名下的行就会落进别人的差集被误删（D21 同一漏洞面）。 */
  rootsProvider?: () => string[]
  identify: IdentifySchedulerDeps
  subtitleWorker: (task: import('../agent/findSubtitleWorker.schemas.js').FindSubtitleTask) => Promise<import('../agent/findSubtitleWorker.schemas.js').FindSubtitleBatchReport>
  targetLanguage: string
  /** 只读根缓存（115 测试目录——字幕派发会 ENOENT，识别照常）。检测一次缓存。 */
  writableRoots?: Map<string, boolean>
  log: (msg: string) => void
  /** 测试注入：距上次巡检满这个时间才算到点。默认 INSPECT_INTERVAL_MS。 */
  inspectEveryMs?: number
  /** 巡检失败后的重试退避（D4）。默认 INSPECT_FAILURE_BACKOFF_MS。 */
  inspectFailureBackoffMs?: number
  /** 维护循环的节拍（测试注入）。默认 MAINTENANCE_TICK_MS(5min)。
   *  抽成注入点是"运维不跟着 24h 巡检闸走"这条 D5 红线的刚性需求：不能把它做成"每圈跑一次
   *  维护"就完事——必须能在一个 run() 内驱动出**多拍**，才能证明 gcStaging 只在 boot 跑一次
   *  而 dbMaintenance 每拍都跑（前者若漏进维护循环，就会周期性 rm 掉正在跑的工作台）。 */
  maintenanceTickMs?: number

  /** 测试注入：等待。默认下面那个真实的 `sleep`（setTimeout + AbortSignal 中断）。
   *
   *  存在的理由是 C46 的 R8 重试退避（1s+3s）：不可注入的话，每条"持续失败"用例都要真睡
   *  4 秒，daemonV2.test.ts 会从 2 秒拖成十几秒。更坏的是它会诱使后来人把退避调小来"救测试"
   *  ——而退避小正是会打崩 115 网盘的那个行为。测试用 no-op 替身，把"等多久"变成可断言的
   *  数字（`expect(waited).toEqual([1000, 3000])`），比真等强。
   *
   *  **签名必须带 signal 且实现必须真的响应它**：重试退避期间收到停止信号要当场返回，
   *  否则 `docker stop` 会白等 3 秒（run() 主循环的 idle sleep 早就是这个口径，此处复用
   *  同一个函数，不造第二份）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>

  now?: () => number
  /** 测试注入：遍历一个守备目录。默认 walkVideoFiles。
   *  抽成注入点是删除逻辑的刚性需求——R8 的两种"不许删"场景（目录不可访问 / 目录看起来是空的）
   *  在真实文件系统上无法稳定复现，而这两条正是"一次删光全库"的唯一防线。 */
  listVideoFiles?: (root: string) => string[]

  /** 测试注入：stat 一个文件。默认 statSync；返回 null 视为不可 stat。 */
  statFile?: (p: string) => { mtimeMs: number; size: number } | null
  /** C12：内嵌字幕轨探针。**必须可注入**——这是 spawn ffprobe 的重 IO，测试里从不真的跑
   *  （同 IngestDeps.probe 的既有约定）。缺省时退化成"只入库、不探测"：探测是增益，
   *  绝不能因为构造点忘了接线就让阶段 1 整个失效。
   *
   *  返回值三态由 streamProbe.ts 的契约定死，**消费方不许折叠**：
   *  null = 探测不可用（二进制缺席/超时/损坏）；[] = 探过、容器里确实零字幕轨。 */
  probe?: (videoPath: string) => Promise<EmbeddedSubtitleTrack[] | null>
  /** C12：时长探针（复用 files/streamProbe.ts 的 probeDurationSec，不是第二份实现）。 */
  probeDuration?: (videoPath: string) => Promise<number | null>
  /** 跨文件探针并发上限。默认 2 沿用 IngestDeps.probeConcurrency 的实测结论：阿里云盘经
   *  rclone WebDAV 的单文件 ffprobe 是 12-16s（~12s 是 CDN 延迟地板，串行不可优化），
   *  并发才买得到吞吐；而 CIFS NAS 上探针只 1.09s，高并发只是白白放大挂载压力。 */
  probeConcurrency?: number
  /** R24：字幕存在性探针。测试用注入点——测试要能数 stat 调用次数才能守住"未到点的文件
   *  一次 stat 都不许发"这条性能红线（115 FUSE 上全量复核是几万文件 × 60 次 stat）。 */
  fileExists?: (path: string) => boolean

  /** R-F15：列目录（sidecar_langs 观察用）。默认 readdirSync。
   *
   *  为什么与 fileExists 并存而不是替它（两者问的不是同一个问题）：fileExists 回答"当前目标
   *  语言的那条字幕在不在"（单点判据，服务 sub_status），readdir 回答"这个视频旁边一共有哪些
   *  语言的字幕"（与配置无关的磁盘事实，服务 sidecar_langs）。见 files/sidecar.ts 两个函数的
   *  分工注释。
   *
   *  同为测试注入点、同一条理由：测试要能**数调用次数**才守得住性能红线。这里的红线是
   *  「同目录多个视频只 readdir 一次」——忘了做 per-scan 目录缓存的话，一个 24 集的季目录
   *  就是 24 次 readdir，在 115 FUSE 上比原来的逐个 stat 还慢。 */
  readdir?: (dir: string) => string[]

  /** 翻译总开关的**双门控**（TRANSLATE_* 凭证 ∧ settings.ai_translate_enabled==='true'），
   *  阶段 2.6 复查闸的取件范围靠它分流（D14 / C41）。接线点在 cli/watchWiring.ts。
   *
   *  为什么必须是**函数**而不是布尔值（照 rootsProvider / targetLanguage / traceRetentionDays
   *  的既有惰性口径）：`ai_translate_enabled` 是行为级开关，用户在 dashboard 里改。求值一次
   *  会把 watch 启动那一刻的开关冻死在进程里——用户关掉翻译后，handoff_translate 行要等容器
   *  重启才恢复复查，而它们正是最需要被放回来的那批（C41 的永久卡死）。
   *
   *  **未注入时默认 false（"翻译未启用"）**，两种默认的伤害不对称：
   *   · 默认 true → handoff_translate 永远不被复查 → C41 的永久卡死在**缺省接线下复活**，
   *     而缺省接线正是最常见形态（几十条既有测试的构造点都不传这个字段）。
   *     伤害是永久且静默的：那批文件再也不补字幕，界面上什么异常都看不出来。
   *   · 默认 false → 复查闸可能碰到飞行中的翻译。3-2 写这段时的论证是"翻译流第 4 步才
   *     接入 daemonV2，故今天不存在飞行中的翻译，这条伤害的前提为假"——**第 4 步已到，
   *     那个前提从现在起为真**。但结论不变，且现在有了更强的理由：本开关同时门控
   *     `advanceTranslateOnce`（不注入 → 恒 false → 翻译流根本不领活），故"复查闸碰到
   *     飞行中的翻译"在缺省接线下依然不可能发生——两支被同一个开关关掉，自洽。
   *  取伤害小的那个。生产的真实双门控在 cli/index.ts（TRANSLATE_* 凭证 ∧ ai_translate_enabled），
   *  由 watchWiring.test.ts 逐字钉住。 */
  translateEnabled?: () => boolean

  /** 翻译一个视频（第 4 步 / C3）。**必须可注入**：这是数分钟到数小时的付费 LLM agent，
   *  测试里从不真的跑（同 subtitleWorker / probe 的既有约定）。
   *
   *  未注入时**整支翻译流休眠**（零成本，同 probe/gcStaging 的既有门控模式）：既有构造点与
   *  一百多条既有测试都不传这个字段，不许因为"忘了接线"就让巡检失效。但反过来——生产接线
   *  漏了是**静默**的（不报错、只是翻译永不推进，正是 C3 记的那个状态），故 cli 侧的接线由
   *  watchWiring.test.ts 钉住。
   *
   *  生产实现是 `makeDaemonTranslateRunItem`（cli/translateItemCommand.ts），与手动 CLI
   *  共用同一份组装防漂移。 */
  translateRunItem?: (videoPath: string) => Promise<TranslateRunItemResult>

  /** 翻译装盘成功后踢一脚扫描，让新 sidecar 尽快被记账成 covered（R24：只有扫描有权写）。
   *  可选：不注入时靠下一轮自然巡检确认，慢一天但不丢。 */
  requestIngest?: () => void

  // ───────────────────────────────────────────────────────────────────────────
  // 运维器官（D5 / C16）。签名照旧 DaemonDeps 的既有形态（那个类型与它的 ScoutDaemon 已于
  // 第 7 步 B 组随 src/v2/daemon.ts 整体删除；此处保留"照它的形态"这句是为了说明这批字段的
  // optional 门控口径来自何处）。接线点仍在 cmdWatch——切换方式是"cmdWatch 内部把 ScoutDaemon
  // 换成 daemonV2"，不是换入口文件，这样这些接线天然留在原处，
  // 不用在第二个入口文件里重建第二份；那个备选入口 watchV2.ts 已于第 7 步删除。
  //
  // 全部 optional，缺省即整支休眠、零成本（这套门控模式的来源见上一段）：既有构造点与
  // 几十条既有测试都不传这些字段，不许因为"忘了接线"就让阶段 1 失效。
  // 但反过来——生产接线漏一个是**静默**的（不报错、只是从此永不 checkpoint），
  // 所以 cli 侧的接线由 watchWiring.test.ts 逐个器官钉住。
  // ───────────────────────────────────────────────────────────────────────────

  /** DB 耐久运维：小时级 `wal_checkpoint(TRUNCATE)` + 天级 `VACUUM INTO` 在线备份（留 7 份）。
   *  内部自带时间门（dbMaintenance.ts），故这里每拍无脑调即可。
   *
   *  **这不是可选增益，是这个项目在软路由上的生存条件**：2026-07-21 本机 scout.db 真损坏
   *  （malformed），WAL 里 4MB 未 checkpoint 的数据随主文件一起报废，恢复只能靠几天前的手动
   *  备份（db.ts:579-584 记有实案）。VACUUM INTO 是对活 WAL 库唯一安全的在线备份形态。 */
  dbMaintenance?: () => void
  /** 沙盒孤儿 GC：清 `<root>/.subtitle-staging/<jobId>` 与 `.subtitle-translate/<jobId>`。
   *  **只在 daemon 启动时调一次**，镜像旧 daemon 的"单实例前提，无条件回收"语义——
   *  旧进程遗留的工作台全部是孤儿垃圾。
   *
   *  参数是本进程当前在飞行的 staging jobId 集合（C34）。旧接线传的是 `new Set()`，而
   *  gcOrphans 的两条保留条件之一就是"这个工作台正在被使用"——空集合意味着它会 rm 掉正在
   *  被 agent 写入的沙盒。启动时刻本进程还没有任何在飞行的活，所以启动这一次传空集合本身是
   *  正确的；把集合做成**参数**而不是让调用方硬编码 `new Set()`，是为了让"谁在飞行"这个
   *  事实由 daemon（唯一知道它的人）提供，将来若有第二个调用时机也不会再退回空集合。 */
  gcStaging?: (inFlightStagingJobIds: ReadonlySet<string>) => number
  /** 写探针残留清扫：`isDirWritable` 在网络挂载上"写成功但立刻删不掉"（最终一致性）会留下
   *  0 字节隐藏文件，2026-07-29 生产实测全库残留 175 个。
   *
   *  新架构下这个器官**必须由 daemon 调**：旧世界里它挂在 ingest 的走盘循环里
   *  （ingest.ts:894，顺便扫本轮见过的每个目录），而 daemonV2 不跑 ingest——切换后没有任何
   *  代码路径会清它，且 daemonV2 自己的 writableRoots() 每个进程都会各留一枚新探针。 */
  sweepWriteProbes?: () => number
  /** trace 快照保留天数（惰性读 settings，默认 30）。 */
  traceRetentionDays?: () => number
  /** trace 修剪的执行体（RunsRepo）。runs 行本身保留（决策史不删），只把过保留期的
   *  trace_json 置 NULL。与 traceRetentionDays 是一对：只有两者都注入才启用这一支。 */
  runs?: { pruneTraces: (beforeMs: number) => number }
  /** 每拍最先跑（"照旧 DaemonDeps 形态"的措辞来源见本节开头的运维器官段落）：cmdWatch 接
   *  secrets_version watcher——wizard 把密钥
   *  落库后同进程热重建长命客户端，容器零重启。放在维护层而不是巡检里：巡检一天才一次，
   *  配好密钥要等到明天才点火就等于没有 wizard。 */
  preTick?: () => Promise<void>
  /** 产工作许可（措辞来源同上）= engine_enabled ∧ setup 闸（TMDB+LLM 可解析）。
   *  false 时**整轮巡检跳过**（零密钥的 setup 模式下识别/字幕 agent 一定失败，跑就是空烧），
   *  维护循环不闸——见旧 daemon 对这条分界的既有论证。
   *
   *  被闸住时也**不推进时间闸**：否则用户配好密钥点火后，还要等最多 24h 才有第一轮巡检。 */
  workPermitted?: () => boolean

  /** R-F10：SSE 推送通道的事件出口。**只发"对用户有必要"的 4 类**——发布点清单与逐条判据
   *  见 docs/design/2026-08-11-FRONTEND-SPEC.md §六·六，接线在 cli/watchWiring.ts。
   *
   *  ── 为什么是显式 emit，而不是在 cli 的 log 函数里做模式匹配（设计选择 A）──
   *  旁路 log 等于**解析自己刚打印出来的字符串**：日志文案一改事件就静默失效，而本仓今天
   *  已经栽过三次"日志文案与实际口径不符"（`judge: N 个文件判定需字幕` 把总数说成需字幕数、
   *  `scan: probe ok=N` 统计"没抛异常"而非"写进去了"）。显式调用点则由 tsc 与本文件旁边的
   *  daemonV2.events.test.ts（走完整 run()）钉住。
   *
   *  ── 纪律：不许把排障信息塞进来 ──
   *  probe wrote=N 统计、`回填: xxx ok=N`、`judge: 判定 N 个文件`、trace 修剪、清理写探针、
   *  各种"（隔离，下轮重试）"的单文件错误**一律不发**（R-F10 反面清单）。它们的去处是
   *  doctor 按钮 + 日志文件。理由：**把系统的辛苦展示给用户看是反效果**——用户要的是
   *  "找到了什么"，不是"我跑了多少次 ffprobe"。反例锁在 daemonV2.events.test.ts。
   *
   *  ── optional + 失败隔离 ──
   *  缺席即整支静默、零成本（同 probe / gcStaging / translateRunItem 的既有门控模式：
   *  几百条既有测试与构造点都不传这个字段）。调用一律经私有的 `this.emit()` 包 try/catch
   *  ——SSE 挂了绝不能影响巡检，与本仓 gcStaging/dbMaintenance 的既有口径一致。 */
  emit?: (e: ScoutEventInput) => void
}


/** C11 换片源时该清空的状态列（**意图声明**，不是 schema 快照）。
 *
 *  实际清哪些列 = 本表 ∩ `PRAGMA table_info(files)`。为什么必须取交集而不是直接写 SQL：
 *  `sub_attempt` / `translatable` 归 spec 第 3 步加列，今天的库里还没有，硬编码进 SQL 会让
 *  本轮扫描整个抛错；反过来，若只写"今天有的列"，第 3 步加完列的那天就**静默漏清**——
 *  本仓已经三次栽在"写了某列却没定谁来写/谁来读"这一模式上（C12 → C35 → D17），
 *  取交集是让这份名单先于 schema 存在、加列即自动生效的唯一办法。
 *
 *  为什么 needs_subtitle 也在名单里（spec 的 C11 与 §4 第 1b 步用例清单在这一列上自相矛盾，
 *  已报告未改 spec；用户裁决取 C11）：D8 说 needs_subtitle 表达"原则上需要中文字幕"、
 *  **装盘**不改它——它防的是 C19 那种"装盘/手删字幕改判决"的卡死，而换片源恰恰改变了
 *  needs_subtitle 赖以成立的事实本身（新片源可能自带中文轨）。更硬的理由：我们同一次就把
 *  embedded_langs 清成 NULL 了，清掉证据却留着据此做出的判决，正是 D17 点名的同型缺陷——
 *  judge 谓词是 `needs_subtitle IS NULL`，留着旧值就等于这一行永不重判。
 *  真实剧本：旧 720p 自带中文内嵌轨 → needs_subtitle=0(embedded)；换成无中文轨的 1080p 后
 *  仍是 0 → 永远不补字幕，与 C11 自己描述的失效场景是同一个洞的另一扇门。
 *
 *  work_id **不在**名单里（C11 明写"同路径通常仍是同作品"）：换片源不改身份，清了就是
 *  白烧一整轮识别 LLM。 */
const FINGERPRINT_RESET_COLUMNS = [
  'needs_subtitle',   // judge 的重判凭据（谓词 IS NULL）
  'sub_status',       // 磁盘当前有没有字幕（D8）——换了文件，旧结论作废
  'sub_attempt',      // 第 3 步加。残留 = 新片源自带失败额度，提前进停牌
  // 第 5 步下游加。残留 = 新片源自带"半程折算进度"：streak 的语义是"连续几轮**这个文件**
  // 在源站上问不到"，而换片源后这一行代表的是另一个文件（mtime/size 全变、embedded_langs
  // 与 sub_attempt 都已清）。极端形态是 streak=CAP-1 的行换了片源，新文件第一次撞限流就
  // 凭空折算出一次"真实尝试"——而它一次都没被真正搜过。与 sub_attempt 残留是同一个洞。
  'sub_retry_streak',
  'translatable',     // 第 3 步加。基于旧文件内嵌轨算出的可救性，证据已清，判决必须跟着清
  'recheck_after',    // 未来时刻的退避会把新文件挡在字幕工作台外
] as const

export class ScoutDaemonV2 {
  private stopping = false
  private writableCache: Map<string, boolean>
  /** 本轮巡检期间生效的守备目录快照（见 DaemonV2Deps.rootsProvider 的论证：同一轮内必须稳定，
   *  否则删除作用域与扫描作用域会对不上）。巡检外的读取（writableRoots/gcStaging）走现取。 */
  private rootsSnapshot: string[] | null = null
  /** 巡检失败后的退避到点时刻（D4 的独立短 backoff）。0 = 没有待退避的失败。
   *  只存内存不落库：进程重启是运维的显式动作，不该被上一次失败罚站。 */
  private inspectRetryAfter = 0
  /** trace 修剪的天级时间门（照旧 daemon 的 meta 手法，但这一支只服务本进程，存内存足够；
   *  重启后多修剪一次是幂等的、无害的）。 */
  private lastTracePruneAt = 0
  /** C34：本进程当前在飞行的 staging 沙盒 jobId（= 目录名，见 subtitleJobId 的论证）。
   *  gcOrphans 靠它区分"孤儿垃圾"与"正在被 agent 写入的工作台"。 */
  private inFlightStagingJobIds = new Set<string>()

  constructor(private deps: DaemonV2Deps) {
    this.writableCache = deps.writableRoots ?? new Map<string, boolean>()
  }

  /** 运行期守备目录：巡检中用本轮快照，巡检外现取（dashboard 加根后下一拍即生效）。 */
  private currentRoots(): string[] {
    if (this.rootsSnapshot !== null) return this.rootsSnapshot
    return this.deps.rootsProvider?.() ?? this.deps.roots
  }

  /** R-F10：唯一的事件出口。**所有 emit 调用都必须走这里**，不许在业务代码里裸调
   *  `this.deps.emit?.()`——那样每个调用点都得自己包一次 try/catch，漏一个就是"SSE 挂掉
   *  连带掀翻整轮巡检"，而它恰恰是最不该拖垮流水线的那一支（推送是增益，巡检是本体）。
   *  与 gcStaging / dbMaintenance / 各回填 pass 的既有隔离口径完全一致。
   *
   *  刻意**不记日志**：这里失败最可能的成因就是订阅者侧的问题，而每次巡检会调它十几次，
   *  记日志等于在真出问题时把日志刷爆——而日志文件正是排障的那一层。 */
  private emit(e: ScoutEventInput): void {
    try {
      this.deps.emit?.(e)
    } catch {
      // 吞掉：见方法头注释。
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    // stopping 从入参 signal 现取，而不是沿用上一次 run 留下的 true。
    // 生产上 run() 只被调一次，这行看着多余——但少了它，"同一个实例 run 第二次"会静默地
    // **什么都不做**（while 条件当场为假），而这正好是测试里驱动多圈的写法：于是任何
    // "第二圈应该/不应该发生某事"的断言都变成假绿（断言的是"一次都没跑"，不是"跑了但没做"）。
    // 本轮写这批用例时就真踩到了：三条用例靠这个空转过绿。信号是唯一权威，照它取。
    this.stopping = signal.aborted
    signal.addEventListener('abort', () => { this.stopping = true }, { once: true })


    // 启动时的一次性沙盒孤儿回收（照旧 daemon boot 的 gcStaging 语义：单实例前提下，
    // 本进程启动时旧进程必已死，它遗留的工作台全部是孤儿垃圾）。
    // **绝不能挪进下面的维护循环**：那样每 5 分钟就会去清一遍，而"正在被 agent 写入"这个
    // 事实只能靠 in-flight 集合 + mtime 活性窗口保护，任何一处判据失灵就是把跑了两小时的
    // 翻译工作台整个 rm 掉（gcOrphans 的 R6-9/R7-1 两次修复都在还这笔债）。
    try {
      const cleaned = this.deps.gcStaging?.(this.inFlightStagingJobIds) ?? 0
      if (cleaned > 0) this.deps.log(`boot: 清理了 ${cleaned} 个上个进程遗留的孤儿工作台`)
    } catch (e) {
      this.deps.log(`warn: boot 孤儿工作台回收失败（隔离，不阻塞启动）: ${String(e)}`)
    }

    // D17 存量回填（C38 + C43）：boot 一次，**不进下面的 while 循环**。
    // 位置在巡检之前是刚性要求（见 backfillEmbeddedLangs 的分区论证）：先回填、后扫描，
    // 两个 pass 才不会重复探同一批文件。
    //
    // 整支 try/catch 隔离，与 gcStaging 同一口径：回填是增益，它挂了顶多是存量行晚一天重判，
    // 做成阻塞项就是"一次 ffprobe 故障停掉整条流水线"。这条 catch 是"不阻塞主巡检"
    // （spec 明写）在实现层的唯一保证者——mapWithConcurrency 是 allSettled，单文件失败进不到
    // 这里，但 pass 级别的爆炸（库被锁、PRAGMA 读不出）会。
    try {
      await this.backfillEmbeddedLangs()
    } catch (e) {
      this.deps.log(`warn: boot embedded_langs 回填失败（隔离，不阻塞巡检，下次启动重试）: ${String(e)}`)
    }

    // C21 存量回填（works.provider_ids）：同一 boot 阶段、同一 try/catch 隔离口径。
    // 位置在 embedded_langs 回填**之后**、巡检之前——两者互不依赖（一个探本地文件、一个打
    // TMDB），顺序只取"都在扫描之前"这一条：本 pass 与扫描无交集，但放进 while 循环就会
    // 每 5 分钟去打一轮 TMDB（谓词收敛后是 0 行、代价为零，但那是靠运气而不是设计）。
    //
    // 独立 try/catch 而不是与上面共用一个：共用时 embedded_langs 那支的 pass 级爆炸会
    // **跳过**本支，于是"ffprobe 二进制缺失"这种与 TMDB 毫不相干的故障会连带让 imdb 永远补不上。
    try {
      await this.backfillProviderIds()
    } catch (e) {
      this.deps.log(`warn: boot provider_ids 回填失败（隔离，不阻塞巡检，下次启动重试）: ${String(e)}`)
    }

    // R-F5 存量回填（works → tmdb_seasons 应有集缓存）：同一 boot 阶段、同一 try/catch 隔离口径。
    //
    // 位置在 provider_ids 回填**之后**、巡检之前，理由同上一支：与扫描无交集，但放进 while
    // 循环就会每 5 分钟去打一轮 TMDB。
    //
    // 独立 try/catch 而不是与上面共用：共用时 provider_ids 那支的 pass 级爆炸会**跳过**本支，
    // 于是一个与季集表毫不相干的 external_ids 故障会连带让媒体库页的虚线卡片永远画不出来。
    // 这条 catch 是"TMDB 抓不到季集表只是媒体库页少个虚线、绝不阻塞主巡检"的唯一保证者。
    try {
      await this.backfillSeasonCatalog()
    } catch (e) {
      this.deps.log(`warn: boot 应有集回填失败（隔离，不阻塞巡检，下次启动重试）: ${String(e)}`)
    }

    while (!this.stopping) {
      // 维护循环跑在时间闸**之外**（旧 daemon 的既有分界：产工作循环受闸、维护循环不受）。
      // 巡检一天一次，WAL checkpoint 若跟着变成一天一次，等于把一整天的写入押在"今天不掉电"上。
      await this.runMaintenance()

      const now = this.deps.now?.() ?? Date.now()
      const lastInspectAt = this.readLastInspectAt()
      const everyMs = this.deps.inspectEveryMs ?? INSPECT_INTERVAL_MS
      const permitted = this.deps.workPermitted?.() ?? true

      if (permitted && now - lastInspectAt >= everyMs && now >= this.inspectRetryAfter) {
        this.deps.log(`巡检开始 (距上次 ${lastInspectAt === 0 ? '(冷启动)' : `${Math.round((now - lastInspectAt) / 3600000)}h`})`)
        // R-F10 activity ①：巡检开始。用户视角的"系统在忙还是在歇"——日巡检模型下这是
        // 一天里最重要的那条状态变化（没有它，活动页在 23 小时里看起来与宕机无异）。
        this.emit({ type: 'activity', message: '巡检开始' })
        // D4 ①：时间闸记的是巡检**开始**时刻（这个 now），不是跑完之后再取一次。
        // 用结束时刻的话真实周期 = 24h + 本轮耗时，逐轮漂移——大库在 115 FUSE 上真能跑 10h，
        // 周期就漂成 34h，几轮之后巡检时刻会跑到用户看电视的黄金时段去。
        try {
          await this.runInspection(signal)
          // D4 ②：**只有成功才推进 24h 闸**。失败推进 = 挂载抖一下（FUSE 常态）就静默睡满
          // 一天，用户 5 分钟后修好挂载什么也不会发生——而 R8 保护的本意恰恰是优雅恢复。
          this.writeLastInspectAt(now)
          this.inspectRetryAfter = 0
          this.deps.log('巡检完成，歇着等明天')
          // R-F10 activity ②：巡检完成。与 ① 成对——活动页据此从"在忙"切回"歇着"。
          this.emit({ type: 'activity', message: '巡检完成，歇着等明天' })
        } catch (e) {
          // 失败走**独立的短退避**，与 24h 闸分账（见 INSPECT_FAILURE_BACKOFF_MS 的论证）：
          // 不推进时间闸，但也不许下一拍（5min 后）就重跑——巡检里有两条付费 LLM 工作台，
          // 持续性故障（TMDB key 过期之类）会变成每 5 分钟烧一轮的热循环。
          const backoff = this.deps.inspectFailureBackoffMs ?? INSPECT_FAILURE_BACKOFF_MS
          this.inspectRetryAfter = now + backoff
          this.deps.log(`巡检失败（隔离，时间闸不推进，${Math.round(backoff / 60000)}min 后重试）: ${String(e)}`)
          // R-F10 health ④：**整轮**巡检失败。这与反面清单里那些"（隔离，下轮重试）"的单文件
          // 错误不是一档——单文件抖动会自愈且不影响别的文件，而整轮失败意味着这一天什么都没做
          // （时间闸不推进，30min 后才重试）。用户视角就是"我的库可能有问题"，正是 health 的定义。
          this.emit({ type: 'health', message: `巡检失败，${Math.round(backoff / 60000)} 分钟后重试: ${String(e)}` })
        }
      }

      if (this.stopping) break
      // "歇着"：每 5min 一拍——既是时间闸的轮询（不是轮询工作台），也是维护循环的节拍。
      await sleep(this.deps.maintenanceTickMs ?? MAINTENANCE_TICK_MS, signal)
    }
  }

  /** 维护循环：4 个运维器官（D5 / C16）。**不受 24h 巡检闸与 workPermitted 限制**。
   *
   *  每个器官各自 try/catch：口径与旧 daemon 一致（"失败只记日志，运维是增益，绝不拖垮主
   *  循环"），但**必须逐个包**而不是整体包一层——整体包的话第一个器官抛错就短路掉后面三个，
   *  一次磁盘满会同时静默掉 checkpoint、备份、探针清扫和 trace 修剪。 */
  private async runMaintenance(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now()

    // preTick 最先跑：secrets_version 变了在这里完成热重建，本拍后续的 workPermitted 与
    // 所有闭包就能立刻看到新客户端（wizard 落库 → 同进程点火，容器零重启）。
    if (this.deps.preTick) {
      try { await this.deps.preTick() } catch (e) { this.deps.log(`warn: preTick 失败（隔离）: ${String(e)}`) }
    }

    if (this.deps.dbMaintenance) {
      try { this.deps.dbMaintenance() } catch (e) { this.deps.log(`warn: db 运维失败（隔离）: ${String(e)}`) }
    }

    if (this.deps.sweepWriteProbes) {
      try {
        const swept = this.deps.sweepWriteProbes()
        if (swept > 0) this.deps.log(`清理了 ${swept} 个残留写探针文件`)
      } catch (e) { this.deps.log(`warn: 写探针清扫失败（隔离）: ${String(e)}`) }
    }

    // trace 修剪自带天级时间门：修剪不是热路径，每 5 分钟发一条全表 UPDATE 是白付 IO。
    if (this.deps.runs && this.deps.traceRetentionDays && now - this.lastTracePruneAt >= TRACE_PRUNE_EVERY_MS) {
      try {
        const days = this.deps.traceRetentionDays()
        const pruned = this.deps.runs.pruneTraces(now - days * 86_400_000)
        if (pruned > 0) this.deps.log(`trace 修剪: 清空了 ${pruned} 份超过 ${days} 天的快照`)
      } catch (e) { this.deps.log(`warn: trace 修剪失败（隔离）: ${String(e)}`) }
      // 时间门在**尝试之后**推进（不论成败）：失败也隔一天再试，避免坏库上每拍重试。
      this.lastTracePruneAt = now
    }
  }

  /** 一轮完整巡检：扫描 → 识别跑空 → judge → 字幕跑空。 */
  private async runInspection(signal: AbortSignal): Promise<void> {
    // 本轮 roots 快照（见 rootsProvider 的论证）。finally 清掉，让巡检外的读取回到现取。
    this.rootsSnapshot = this.deps.rootsProvider?.() ?? this.deps.roots
    try {
      await this.runInspectionInner(signal)
    } finally {
      this.rootsSnapshot = null
    }
  }

  private async runInspectionInner(signal: AbortSignal): Promise<void> {
    // 阶段 1：机械扫描
    // signal 传下去是 C46 的刚性需求：R8 重试的退避（1s+3s）落在 scanOnce 里面，
    // 不接的话 `docker stop` 会在每个抖动的根上白等 4 秒。
    await this.scanOnce(signal)

    // 阶段 2：识别工作流（上游）——消费**冻结快照**（R4 / C23）
    //
    // 用户原话：「每次巡检开始，流水线是冻结的，开工没有回头箭，找到的记录，找不到的不管，
    // 留给下次。」改动前这里是 `while (true) { queue = listIdentifyQueue(...); 处理 queue[0] }`
    // ——每圈重查库，那是滚动重算而不是冻结（C23，spec 的缺口清单一开始也漏记了这一条）。
    //
    // 两个真实伤害（阶段 3 同型，论证不重复）：
    //  ① 大库在 115 FUSE 上真能跑 10h，期间新入库的目录会被本轮捞走 → "开工没有回头箭"被破坏
    //  ② 任何一条失败路径漏了写退避 → 该行仍满足工作台谓词 → **同轮无限重选**，跑完整 agent
    //     session 一直烧到进程被杀。识别侧退避写在 next_retry_at（identifyScheduler），
    //     字幕侧写在 recheck_after（D6）；冻结是这两条之外的**第二道防线**——一道防线的意思
    //     就是"哪天谁漏写一次就出事"。
    const identifyQueue = listIdentifyQueue(this.deps.db, this.deps.now?.() ?? Date.now())
    let identifyRounds = 0
    for (const item of identifyQueue) {
      if (this.stopping) break
      identifyRounds++
      this.deps.log(`识别 ${item.workDir} (${item.fileCount} 文件, 第 ${identifyRounds}/${identifyQueue.length} 个)`)
      // R-F10 activity ④ + progress：识别工作台的作品级状态变化（与阶段 3 字幕流同构）。
      // 识别是巡检里第一条真正"在动"的阶段，不推的话大库跑识别的那几小时活动页是死的。
      this.emit({ type: 'activity', message: `正在识别：${item.workDir}`, title: item.workDir, workbench: 'identify' })
      this.emit({
        type: 'progress',
        message: `识别第 ${identifyRounds}/${identifyQueue.length} 个`,
        title: item.workDir,
        workbench: 'identify',
        data: { done: identifyRounds, total: identifyQueue.length },
      })
      await runIdentifyWorkDir(this.deps.identify, item)
    }
    // 识别工作台**收工**（审计 🔴-2：F-6 的同型小尺度复发）。
    //
    // 为什么必须有这一条：ScoutEventBus 的 current 快照只在收到带 workbench 的事件时推进，
    // 只在收到不带 workbench 的事件时清空。阶段 2 结束到阶段 3 第一条 emit（:687）之间，
    // 隔着 judge（:638，大库上分钟级）与停牌复查闸（:650）**两段无 emit 的时间**。
    // 没有这一条的话，/api/v2/health 在这几分钟里会稳定地说「正在识别 W9，第 47/47 个」
    // ——而识别台早已空了。那正是 F-6 被修的那个缺陷，只是尺度从"跨巡检"缩到"跨阶段"。
    //
    // 不带 workbench = 归属巡检级 = 总线据此清空 current（与巡检开始/完成/失败同一口径）。
    // 只在真的识别过东西时发，空跑不发（避免每天给用户一条"识别完成 0 个"的噪音）。
    if (identifyQueue.length > 0) {
      this.emit({ type: 'activity', message: `识别完成，处理了 ${identifyQueue.length} 个目录` })
    }

    // 阶段 2.5：judge（B-1）——识别绑定后判 needs_subtitle
    await this.judgeOnce()

    // 阶段 2.6：停牌复查闸（D13 / C35）——把到点的停牌行放回 NULL。
    //
    // 位置在 2.5 与 3 **之间**是刚性要求，不是风格：放回来的行本轮就能被下面的字幕工作台
    // 捞走，不用白等一整天（24h 时间闸）。放在阶段 3 之后的话，状态列的终值一模一样、
    // 单元用例照样全绿，只是每次复查都白亏一天——这类"顺序错了但列对了"的缺陷，只有端到端
    // 跑真实 listSubtitleQueue 的用例才看得见（daemonV2.test.ts 用例 7）。
    //
    // 冻结之后这个顺序更是 load-bearing：阶段 3 的快照只拍一次，2.6 若跑在它后面，
    // 放回来的行**这一整轮都不会被看见**（改动前靠每圈重查还能歪打正着捞到）。
    //
    // 整支 try/catch 隔离，口径与 gcStaging / 回填 pass / 各运维器官一致：复查是增益，它挂了
    // 顶多是停牌行晚一天被放回；做成阻塞项就是"一次库锁停掉整条流水线"，而流水线里还有
    // 扫描的删除清理（R6/R7 的地基）与两条工作台。
    try {
      this.reviewParkedOnce()
    } catch (e) {
      this.deps.log(`warn: 停牌复查闸失败（隔离，不阻塞本轮巡检，下轮重试）: ${String(e)}`)
    }

    // 阶段 3：字幕工作流（下游）——消费**冻结快照**（R4 / C23）。
    //
    // ── 为什么消费完就结束，**不再补查一轮**（用户点名要论证的那条）──
    // spec §2 的阶段语义是"有活就一直跑，跑空才进下一步"，字面读像是"要跑到查不出活为止"。
    // 但阶段 2 → 2.5 → 2.6 → 3 是**串行**的，故阶段 3 开跑时上游已经全部静止：识别不会再绑
    // 新 work_id、judge 不会再写 needs_subtitle、复查闸不会再放回停牌行、扫描早在阶段 1 就
    // 结束了。于是"快照拍完之后还能新长出来的字幕活"只有两个来源，两个都**必须**被排除：
    //  · 磁盘上新出现的文件 —— R4 原话点名不管（"找到的记录，找不到的不管，留给下次"）
    //  · 拍快照那一刻仍在退避窗内、跑到一半才到点的行 —— 这就是"队列漂移"本身，
    //    R4 那句"跑的过程中队列不漂移"说的正是它
    // 补查一轮既违背 R4，又把上面伤害 ① 原样放回来。所以"跑空"在冻结模型下的正确解读是
    // **"把这一轮的快照消费空"**，而不是"把库查空"。
    const subtitleQueue = listSubtitleQueue(this.deps.db, this.writableRoots(), this.deps.now?.() ?? Date.now())
    let subtitleRounds = 0
    for (const frozen of subtitleQueue) {
      if (this.stopping) break

      // R12 + C23：消费**这个作品**之前逐文件 stat。快照是冻结的，磁盘不是。
      const item = this.dropVanishedFiles(frozen)
      if (item === null) continue   // 整簇都没了 → 跳过，worker 一次都不调

      subtitleRounds++
      this.deps.log(`字幕 ${item.title} (${item.files.length} 文件, 第 ${subtitleRounds}/${subtitleQueue.length} 个)`)
      // R-F10 activity ③ + progress：开始处理一个作品。
      //  · activity 说"现在在干什么"（作品级，一部剧一条）
      //  · progress 说"排到第几个了"（队列级，24 集的剧在这里连发 → 唯一需要节流的事件源；
      //    **节流是总线的职责，不是这里的**——发布方如实发，ScoutEventBus 折叠。两边都做
      //    就会出现"节流窗口叠加"这种没人算得清的行为）。
      this.emit({ type: 'activity', message: `正在找字幕：${item.title}（${item.files.length} 个文件）`, title: item.title, workbench: 'subtitle' })
      this.emit({
        type: 'progress',
        message: `第 ${subtitleRounds}/${subtitleQueue.length} 个作品`,
        title: item.title,
        workbench: 'subtitle',
        data: { done: subtitleRounds, total: subtitleQueue.length },
      })
      // C34：把这个作品的 staging 沙盒目录名登记为"在飞行"，跑完（含抛错）必须摘掉。
      // 登记必须在**剔除之后**：整簇消失的作品若也登记一次，这个 jobId 就白白免疫一次 GC。
      // jobId 必须与 buildSubtitleTask 实际用的那个**字节一致**，故共用 subtitleJobId
      // 而不是在这里手写一遍 `subtitle:${workId}`（两份必然漂移，漂了 GC 保护就静默失效）。
      const jobId = subtitleJobId(item.workId)
      this.inFlightStagingJobIds.add(jobId)
      try {
        const report = await runSubtitleWorkDir(this.deps.db, this.deps.subtitleWorker, item, this.deps.targetLanguage)
        // R-F10 found ①：**找到并装上了字幕**——这一条就是通知页的数据源，也是整条通道里
        // 用户唯一真正想要的那个信号（"找到了什么"）。
        //
        // 计数取 `report.installed.length` 而不是 `item.files.length`：后者是"这次派了几个
        // 文件的活"，与"装上了几条"完全是两回事（最常见的形态恰恰是派 8 集只找到 3 集）。
        // 把派发量当成果量报出去，就是在通知页上撒谎。
        //
        // report 为 null（worker 抛错，runSubtitleWorkDir 内部按失败轨记完账后返回 null）
        // 或 installed 为空（搜过确实没有）时**不发**——R-F10 约束 1「只推变化」：
        // "这一轮没找到"不是成果，也不是异常（它是最常见的正常结局），推它只会把通知页
        // 变成噪音流。它的去处是日志文件与 runs 表。
        if (report && report.installed.length > 0) {
          this.emit({
            type: 'found',
            message: `${item.title}：装上了 ${report.installed.length} 条字幕`,
            title: item.title,
            workbench: 'subtitle',
            data: { installed: report.installed.length, files: item.files.length },
          })
        }
      } catch (e) {
        // ── C13 计数单调的兜底（"finally 保证回写"这条路的实现）──
        //
        // 为什么选"保证回写"而不是"领取即计数"（两条路我选这条并论证）：
        // 领取即计数要求"成功则回退"，也就是**装盘成功路径上必须再发一条 -1 的写**。
        // 那条回退写一旦漏掉或在它之前掉电（软路由掉电是本项目常态），成功就变成了一次
        // 失败额度 —— 一个"每次都装盘成功但字幕总没落地"的文件会在 7 轮后被判进停牌，
        // 而它一次都没"找不到"过。3-2 刚明确"装盘成功不递增计数"，领取即计数是逆着这条走、
        // 靠一条补偿写把语义扳回来；而补偿写的失效是**静默**的（状态流转看起来一模一样）。
        // 保证回写没有这个反向风险：它只在真的出了异常时补一次，成功路径一列都不碰。
        //
        // runSubtitleWorkDir 内部已有 catch-all（B-3）+ B-2 无结局兜底，正常形态下每个文件
        // 都会被回写一次。这里兜的是**它自己整体抛错**那条缝：buildSubtitleTask / traceBus /
        // 报告反解等它 try 之外的代码抛出时，改动前是直接掀翻整轮巡检、且一行都没记账 →
        // sub_attempt 不涨 → 永远攒不到 7 次 → 停牌与移交翻译**静默失效**，那个文件每天被
        // 重选一次、每天烧一次付费 LLM，永不终止（C13）。
        //
        // 诚实划界：进程被杀（掉电/OOM/kill -9）**这里救不了**，任何进程内机制都救不了。
        // 那条缝只能靠"下一轮巡检会重选它、再失败一次就记上"来收敛——代价是丢一次计数，
        // 不违反单调（计数不会倒退），只是慢一天。不为它编一条测不出来的补丁。
        this.deps.log(`warn: 字幕工作台整体抛错，补记一次尝试（C13 计数单调）: ${item.title}: ${String(e)}`)
        this.bumpAllAsAttempt(item)
      } finally {
        // finally 而不是顺序执行：worker 抛错时若不摘，这个 jobId 会永久免疫 GC，
        // 沙盒垃圾从此无界堆积（媒体目录里的隐藏目录，用户看不见、只会看到盘满）。
        this.inFlightStagingJobIds.delete(jobId)
      }
    }
    // 字幕工作台**收工**（同上，审计 🔴-2）。翻译流（阶段 4）每轮只推进一个作品，
    // 且可能整轮不推进（无活时直接返回）——那种情况下若没有这一条，current 会一直停在
    // 最后一个字幕作品上，直到明天巡检开始才被清掉。
    if (subtitleQueue.length > 0) {
      this.emit({ type: 'activity', message: `字幕工作台跑完，处理了 ${subtitleQueue.length} 个作品` })
    }

    // 阶段 4：翻译流推进一个作品（R19 + C32 / 第 4 步把 C3 接回来）。
    //
    // 位置在**最末尾**是形态的一部分，不是随手放的（完整论证见 advanceTranslateOnce）：
    // 翻译是这条流水线里唯一"单个活可能跑几小时"的阶段，放在前面会把删除清理与两条工作台
    // 全堵在它后面；放最后则它再慢也只是让"歇到明天"晚开始。
    //
    // 整支 try/catch 隔离，口径与 gcStaging / 回填 pass / 阶段 2.6 一致：翻译挂了不许连带
    // 掀翻整轮巡检——否则 D4 的失败退避不推进时间闸，扫描与识别跟着一起停摆（一次 LLM 偶发
    // 超时就能停掉整条流水线）。advanceTranslateOnce 内部已把 runItem 的抛错收成失败轨记账，
    // 这里兜的是它 try 之外那条缝（取候选的 SQL、守卫回写、日志）。
    try {
      await this.advanceTranslateOnce()
    } catch (e) {
      this.deps.log(`warn: 翻译流推进失败（隔离，不阻塞本轮巡检，下轮重试）: ${String(e)}`)
    }
  }

  /** R12 + C23：把快照里**已从磁盘消失**的文件剔掉；整簇都没了返回 null。
   *
   *  为什么非做不可（这是本步最贵的一条，成本以"7 天 LLM"计）：改动前 agent 会拿到一批不存在
   *  的 videoPath → staging 沙盒在已删目录里 ENOENT → 抛错 → runSubtitleWorkDir 的 catch-all
   *  给**整簇**文件 bump 一次 → `sub_attempt` 白涨。连 7 天白涨 7 次之后，这个**已经不存在的
   *  文件**被判"移交翻译流"，翻译流才用 R12 检出它不存在 → 7 天的付费 LLM 花在幽灵上。
   *  真实剧本（C23）：大库巡检跑 10h，快照第 0 分钟冻结，用户第 3h 删掉一整部剧，第 7h 字幕流
   *  才处理到它。
   *
   *  ── 为什么**不计 sub_attempt**（红线）──
   *  文件没了不是"一次失败尝试"。R10 的 7 次是给"认真找了但确实没有"的额度（R9/R17），
   *  让幽灵吃掉它就是把停牌/移交翻译的判据整个污染。正解在别处：R7 规定"磁盘上消失的文件
   *  直接删除记录"，下一轮扫描的删除清理会把这一行整个删掉——本函数只需要**这一轮别乱记账**，
   *  连退避都不写（写了就是替一个即将被删的行安排未来）。
   *
   *  ── 为什么按文件粒度剔而不是"有一个不在就跳过整簇"──
   *  同一部剧的其他集还在盘上、还该照常补字幕，整簇跳过就是连坐（用例 5 钉住这条反向红线）。
   *
   *  复用 `deps.fileExists`（1b-4 为 R24 加的注入点，默认 existsSync），**不写第二份探针**：
   *  两份实现必然漂移，而这两处问的是同一个问题（"这个路径现在在盘上吗"）。
   *  stat 抛错（FUSE 挂载常态）时**当它还在**：这条判据的唯一后果是"要不要把活交给 agent"，
   *  而 R8/D23 已经立过同一条原则——"问不出答案"绝不许折叠成"消失"，否则挂载抖一下就等于
   *  把整轮的活全部丢掉，而文件其实一直在。 */
  private dropVanishedFiles(item: SubtitleQueueItem): SubtitleQueueItem | null {
    const fileExists = this.deps.fileExists ?? existsSync
    const alive: SubtitleQueueItem['files'] = []
    const gone: string[] = []
    for (const f of item.files) {
      let present: boolean
      try {
        present = fileExists(f.path)
      } catch {
        present = true   // 问不出答案 ≠ 消失（见上方论证）
      }
      if (present) alive.push(f)
      else gone.push(f.path)
    }
    if (gone.length > 0) {
      this.deps.log(
        `字幕: 快照中 ${gone.length} 个文件已从磁盘消失，剔除且**不计 sub_attempt**（R12 / C23）: ${gone[0]}`
        + (gone.length > 1 ? ` 等 ${gone.length} 个` : ''),
      )
    }
    if (alive.length === 0) return null
    if (alive.length === item.files.length) return item
    return { ...item, files: alive }
  }

  /** C13 兜底：给这一簇的每个文件补记一次失败尝试 + 退避。
   *
   *  刻意**不复用** subtitleScheduler 里的 bump()：那个函数还负责满 7 次的停牌分流（读
   *  translatable、写 sub_status、写 +7 天），而这里是"我们不知道 worker 到底做了什么"的
   *  异常缝。在信息最少的路径上做最重的状态跃迁（把一行推进停牌态）是拿不确定性去改终态——
   *  真正的分流留给下一轮：计数已经涨上去了，下次失败会立刻按 `>= 7` 分流（D15 的两半咬合）。
   *
   *  逐条 try/catch：这条路径本身就是异常处理，它再抛错会盖掉原始异常（排障时看到的是
   *  "database is locked"而不是真正掀翻工作台的那个错）。 */
  private bumpAllAsAttempt(item: SubtitleQueueItem): void {
    const now = this.deps.now?.() ?? Date.now()
    const DAY_MS = 24 * 60 * 60 * 1000
    for (const f of item.files) {
      try {
        // last_error 带 `sub:` 前缀是硬要求（跨轨串味防线，subtitleScheduler.bump 立的先例）：
        // 这一列与识别轨共用，而 identifyScheduler 的队列谓词靠 `last_error != 'tmdb-404'`
        // 把 TMDB 查不到的目录永久排除。字幕轨裸写会洗掉那个终态凭据 → 该目录重进识别队列、
        // 每天白烧一次 TMDB + LLM。
        // sub_retry_streak 归零（编排侧裁决，2026-08-08）：这条 UPDATE 写的是
        // `sub_attempt + 1` ——它已经表态"这是一次真实尝试"。既然表了态，留着连续
        // "问不到"的进度就是同一次回写里自相矛盾：一边说算一次尝试、一边保留豁免额度。
        // 极端形态：streak=CAP-1 的行在这里抛错记一次尝试，下一次真限流立刻再折算一次，
        // 同一个失败被计两笔。规则是"任何非 retry_later 的结局都归零"，工作台异常同样适用。
        this.deps.db.prepare(
          `UPDATE files SET sub_attempt = sub_attempt + 1, sub_retry_streak = 0, recheck_after = ?,`
          + ` last_error = 'sub:workbench-error', updated_at = ? WHERE path = ?`,
        ).run(now + DAY_MS, now, f.path)
      } catch (e) {
        this.deps.log(`warn: 补记尝试失败（隔离，不盖掉原始异常）: ${f.path}: ${String(e)}`)
      }
    }
  }

  /** 只读根过滤：字幕只在可写根内派发（115 只读跳过）。 */
  private writableRoots(): string[] {
    const out: string[] = []
    for (const root of this.currentRoots()) {
      if (!this.writableCache.has(root)) {
        this.writableCache.set(root, isDirWritable(root))
      }
      if (this.writableCache.get(root)) out.push(root)
    }
    return out
  }


  /** judge 阶段：对已识别但未判定的文件跑 judgeSubtitle（国产/内嵌跳过）。
   *
   *  **不探磁盘**（D8 / C27）：needs_subtitle 只表达"这资源原则上需要中文字幕"，判据是语言
   *  事实（origin_lang / 内嵌轨）。"磁盘上当前有没有外挂字幕"归 sub_status，由扫描独占写入
   *  （R24），judge 一次 stat 都不该发——留着不仅是每轮白付 84 次 stat/文件（115 是 FUSE 挂载），
   *  更会把同一个磁盘事实投影到两列上，造出 needs_subtitle=0 + sub_status=NULL 的永久卡死态
   *  （见 subtitleJudge.ts 顶部对 C27 的完整论证）。 */
  private async judgeOnce(): Promise<void> {
    const db = this.deps.db
    const now = this.deps.now?.() ?? Date.now()
    const rows = db.prepare(`
      SELECT f.path, f.filename, f.embedded_langs, f.work_id, w.origin_lang
      FROM files f LEFT JOIN works w ON f.work_id = w.id
      WHERE f.work_id IS NOT NULL AND f.needs_subtitle IS NULL
    `).all() as Array<{ path: string; filename: string; embedded_langs: string | null; work_id: string; origin_lang: string | null }>

    if (rows.length === 0) return
    // needs_subtitle 与 translatable 写在**同一条 UPDATE** 里（不是两条）。
    // 分两条的话，进程在两条之间被杀（软路由掉电是本项目常态，见 db.ts 的 synchronous=FULL
    // 论证）会留下"needs_subtitle 已判、translatable 还是 NULL"的行——而 judge 的谓词是
    // `needs_subtitle IS NULL`，这一行从此**永不重判** → translatable 永久冻结在 NULL。
    // C40 说 NULL 不判死（不会立刻出事），但它会永远停在"暂不可判"：满 7 次时既不移交翻译、
    // 也不停牌，在字幕流里无限期打转。这正是 C12 → C35 → D17 → D18 那条"写了某列却没定谁
    // 来读/何时写全"的血案的第五次形态。
    //
    // translatable 列按 PRAGMA 取交集动态拼（照 fingerprintResetColumns / backfill 的既有
    // 口径）：硬编码进 SQL 会让本阶段在**没有该列的旧库**上抛 `no such column` → 整轮巡检
    // 挂掉。生产上这形态真实存在（容器滚更时新代码可能先于迁移起来、或从旧备份恢复的库）。
    //
    // R-F15：skip_reason 走**同一套**动态拼列口径（v40 加的列，旧库上同样可能缺席），
    // 并且与 needs_subtitle 写在**同一条 UPDATE** 里——理由与上面 translatable 那段逐字同源：
    // 分两条时进程被杀会留下"判决已写、理由还是上一次目标语言口径"的行，而 judge 谓词是
    // `needs_subtitle IS NULL` → 这一行从此永不重判 → skip_reason 永久冻结在错误的值上，
    // 媒体库页据它显示 ◇/◆ 标记，用户看到的是**与事实相反**的标记且无从察觉。
    const haveCols = (() => {
      try {
        return new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
          .map((c) => c.name))
      } catch { return new Set<string>() }
    })()
    const haveTranslatable = haveCols.has('translatable')
    const haveSkipReason = haveCols.has('skip_reason')
    const update = db.prepare(
      `UPDATE files SET needs_subtitle = ?, updated_at = ?`
      + (haveTranslatable ? `, translatable = ?` : '')
      + (haveSkipReason ? `, skip_reason = ?` : '')
      + ` WHERE path = ?`,
    )
    let judged = 0
    // 分开计数（needs / skip）而不是只记总数：日志文案曾写成「judge: N 个文件判定需字幕」而 N
    // 其实是**判定过的行数**——2026-08-10 live test 里 61 个文件全被报成"需字幕"，我据此误判
    // judge 规则 2（已有内嵌中文轨 → 跳过）失效并停了引擎排查，实际规则完全正常（44 需 / 17 跳）。
    // 与 probe 的 `ok=N`（统计"没抛异常"而非"写进去了"）是同一类缺陷：**日志把一个中间量说成
    // 结论量**，读日志的人无从分辨。计数口径必须与文案逐字对应。
    let needsCount = 0

    for (const r of rows) {
      let embedded: string[] | null = null
      if (r.embedded_langs) { try { embedded = JSON.parse(r.embedded_langs) } catch { embedded = null } }

      const input = { originLang: r.origin_lang, embeddedLangs: embedded }
      const verdict = judgeSubtitle(input, { targetLanguages: [this.deps.targetLanguage] })
      // R21：可救性与 needs_subtitle 同时判定。**无条件判**（连 needs=0 的行也判）——
      // 若写成"needs=0 就跳过"，将来换片源把 needs 清成 NULL 重判时会留下一批 translatable
      // 语义不明的行；而多判一次的成本是零（纯函数、不碰磁盘、判据都已在手上）。
      const translatable = judgeTranslatable(input, TRANSLATABLE_LANGS)
      // 参数按上面拼列的**同一顺序**组装（needs, now, [translatable], [skip_reason], path）。
      // R-F15：verdict.reason 是 judgeSubtitle **已经算出来**的量，此前算完即丢——生产库
      // 1026 个 needs_subtitle=0 的行分不出 origin-skip 与 embedded，媒体库页第三种标记 ◇
      // 拿不到数据、排障也答不出"这些到底为什么被跳过"。存的是 reason **原值**，不做任何
      // 二次归纳：字段名与真实含义必须逐字对应（今天已栽过三次"把中间量说成结论量"）。
      const args: unknown[] = [verdict.needs ? 1 : 0, now]
      if (haveTranslatable) args.push(translatable)
      if (haveSkipReason) args.push(verdict.reason)
      args.push(r.path)
      update.run(...args)
      judged++
      if (verdict.needs) needsCount++
    }
    if (judged > 0) {
      this.deps.log(`judge: 判定 ${judged} 个文件——${needsCount} 需字幕 / ${judged - needsCount} 跳过（国产或已有内嵌中文轨）`)
    }
  }

  /** 阶段 2.6 停牌复查闸（D13 + D14 + D15 / 缺口 C35 + C41 + C36）。
   *
   *  用户原话：「可以改成每周一次，但是页面上还是显示停牌吧，除非哪天字幕真找到了」
   *  即**停牌 ≠ 系统放弃**（R25/R26）：后台继续每周找一次，但界面在字幕真出现前一直显示停牌
   *  （界面语义不由这里负责——停牌的解除凭据只有"扫描发现同名字幕"这一条，见 observeSubtitle）。
   *
   *  ── 为什么必须是独立阶段，不能塞给字幕流（D13 / C35 的鸡生蛋）──
   *  字幕工作台的谓词是 `sub_status IS NULL`（listSubtitleQueue，3-2 已收紧）→ 停牌行根本不在
   *  它的视野内，它看不见也就改不了。3-2 实现了"满 7 次 → 写停牌态 + recheck_after=+7天"这个
   *  写入者，却没有任何代码把它们读回来——与 C12（embedded_langs 从未被写入）、C35、D17 完全
   *  同型的第五次形态："写了某列却没定谁来读它"。
   *  更糟的是若强行让字幕流去改：它会掀掉**正在被翻译流处理**的 handoff_translate 行 →
   *  翻译回写时 D10 的乐观守卫 `WHERE sub_status='handoff_translate'` 匹配 0 行 →
   *  tr_recheck_after 不写 → D6 要防的付费 LLM 热循环从侧门放回来。
   *
   *  ── 取件范围取决于翻译开关（D14，用户裁决 a / C41）──
   *   · `unsolvable` —— **恒参与**。它 translatable=0，翻译流对它无能为力（R21 明令不给第 8 次
   *     机会），不存在"打断飞行中的翻译"这回事。
   *   · `handoff_translate` —— **仅当翻译未启用时**参与。默认场景下用户并没开翻译（双门控），
   *     于是满 7 次 → judge 判可翻译 → 写 handoff_translate → 翻译流不启动 → 若复查闸也不管它
   *     就是**永久卡死**（C41，上一轮刚修掉的"永久判死"原地复活）。反之翻译开着时它归翻译流管、
   *     有自己的 tr_recheck_after 节奏，复查会打断飞行中的翻译，故不参与。
   *  这个设计保住了 R23"开关与文件状态解耦"的好性质：开关变化时**不需要批量改库**，
   *  只是取件范围随开关变；开关一开，停在 handoff_translate 的行自然被翻译流领走。
   *
   *  ── sub_attempt 保持不动（D15 / C36 的成本红线）──
   *  归零后要重新攒 7 次才再停牌 → 一个永远找不到字幕的文件变成 **7 次 / 14 天 ≈ 182 session/年**；
   *  不归零则回 NULL 后下次失败立即判 `>= 7` → 直接回停牌 → 稳定 **1 次/周 ≈ 52 session/年**。
   *  差 3.5 倍，而这个退化是**完全静默**的：状态流转看起来一模一样，只有账单会说话。
   *  3-2 已把移交判据写成 `>= 7` 而非 `== 7`（见 subtitleScheduler 的 bump），正是为了配合这里——
   *  两半咬合才等于"每周一次"，任一半错了都变 182 次/年，而两半各自单测都能全绿。
   *
   *  ── 为什么 recheck_after 也一起清（**不是** load-bearing，别照抄这条当范例）──
   *  诚实记账：这一列清不清，**今天的行为完全一样**。本闸门的取件条件是
   *  `recheck_after IS NOT NULL AND recheck_after <= now`，而字幕工作台的是
   *  `recheck_after IS NULL OR recheck_after <= now`——前者成立**蕴含**后者成立，
   *  故放回来的行无论留不留那个旧时刻，本轮都照样能被工作台捞走。
   *  （写这段时我一度在注释里断言"不清就白等一整周"，变异验证 M4 打掉了它：把这一句删掉
   *  跑全套测试 0 红。留着那句错话比留着这行代码更危险——后人会据此推断出一条不存在的约束。）
   *
   *  那为什么还是清：**与既有的"回到出厂值"语义保持一致**。recheck_after 的含义是"字幕流的
   *  重试退避到点时刻"，停牌期间它被借去当本闸门的取件凭据；放回 NULL 态之后那个值就是一段
   *  无主的陈旧历史，而 fingerprintResetColumns 对同一列的处置也是清成 NULL（换片源时）。
   *  一列的"无待退避"只该有一种表示，否则下一个读它的人得先分辨"这个过去时刻是谁写的"。
   *  代价为零，故取一致性。若将来有人收紧工作台谓词（去掉 `IS NULL OR`），这行会从
   *  "无所谓"变成"有害"——那时该改的是这里，本段注释是入口。
   *
   *  ── 单条 UPDATE 而不是"先 SELECT 再逐行改"──
   *  一条语句 = 一个原子写。分两步的话进程在中间被杀（软路由掉电是本项目常态，见 db.ts 的
   *  synchronous=FULL 论证）会留下"选出来了但没改"的半状态；且 WHERE 里的 `sub_status IN (...)`
   *  天然表达了"只有这两态会被碰"这条隔离语义——covered 与 NULL 一列都不许动
   *  （covered 归扫描独占 / R24；NULL 行的 recheck_after 是它自己的失败退避凭据，清掉就等于
   *  次日重选，退避机制整个失效）。 */
  private reviewParkedOnce(): void {
    const db = this.deps.db
    const now = this.deps.now?.() ?? Date.now()
    // 惰性求值（见 DaemonV2Deps.translateEnabled 的论证）：每轮巡检现取，dashboard 改完
    // 下一轮即生效。未注入时默认 false = "翻译未启用"——两种默认的伤害不对称，取小的那个。
    const translateOn = this.deps.translateEnabled?.() ?? false

    // 取件范围随开关变（D14）。handoff_translate 只在翻译未启用时进这个名单。
    const statuses = translateOn ? ['unsolvable'] : ['unsolvable', 'handoff_translate']

    const res = db.prepare(
      `UPDATE files SET sub_status = NULL, recheck_after = NULL, updated_at = ?`
      + ` WHERE sub_status IN (${statuses.map(() => '?').join(',')})`
      + ` AND recheck_after IS NOT NULL AND recheck_after <= ?`,
    ).run(now, ...statuses, now)

    // `recheck_after IS NOT NULL` 是刻意的（不是漏了 `IS NULL OR`）：停牌态的行**必然**带着
    // 3-2 写下的 +7 天时刻，NULL 只可能来自手工改库或将来某条没写全的路径。照字面只收到点的，
    // 宁可漏放一行（下轮人工可见）也不要把"时刻未知"当成"已到点"——后者会让一个刚停牌的行
    // 在同一天就被放回，复查退化成日频，正是 D15 在成本上要避免的那件事。

    if (res.changes > 0) {
      this.deps.log(
        `停牌复查: ${res.changes} 行放回字幕工作台（sub_attempt 不归零 / D15，`
        + `翻译${translateOn ? '已启用→只收 unsolvable' : '未启用→含 handoff_translate'} / D14）`,
      )
    }
  }

  /** 翻译流推进**一个作品**（spec §2 的"翻译工作流" / R19 + C32 的形态）。
   *
   *  ── 形态：主进程内独立循环，跑在巡检每轮末尾，单次只处理一个作品 ──
   *  R19 定的是"主进程内独立循环"而**不是独立进程**：独立进程要重建跨进程租约、竞态与 GC
   *  保护（gcStaging 的 in-flight 集合是进程内的 Set），而这三样每一样都曾在本仓出过事。
   *
   *  为什么这个形态满足 R11「翻译流独立，不与识别/字幕互相阻塞」——两个方向分别论证：
   *   · **不阻塞它们**：本方法在阶段 3 之后调用，那时识别与字幕的冻结快照都已消费完毕。
   *     翻译再慢也只是让"歇到明天"晚开始，不会让任何一个字幕活排在它后面等。
   *     且单次只一个作品：一个作品的翻译是数分钟到数小时的付费 LLM，一轮吃光队列会把巡检
   *     拖成几十小时，期间删除清理（R6/R7 的地基）与两条工作台全被堵住——那才是真的阻塞。
   *   · **不被它们阻塞**：谓词（`sub_status='handoff_translate'`）与退避列（tr_recheck_after）
   *     都是翻译轨自己的，与字幕流的 `sub_status IS NULL` 严格互斥（C14），故字幕队列里有
   *     多少活都挡不住它。旧 daemon.ts 恰恰相反——"translate 只在巡检世界全空时才领"，
   *     那就是 C3 记的"旧设计与 R11 正相反"。
   *  队列不会因"单次一个"而饿死：没被领到的行 tr_recheck_after 一列都没被碰过，下轮照样是
   *  最优先候选（谓词是 `IS NULL OR <= now` 的时刻判定，不是轮转指针）。
   *
   *  ── 双门控（翻译总开关）──
   *  `translateEnabled` 惰性求值、每轮现取（同阶段 2.6 的口径）；关闭时**不领新活**，
   *  已在飞行中的这一个跑完（本方法是同步等待一个 runItem，天然满足"在飞行中的跑完"）。
   *
   *  ── R12：跑前校验文件仍存在，且**不计 tr_attempt** ──
   *  复用 `deps.fileExists`（1b-4 的注入点，默认 existsSync），不写第二份探针。
   *  文件没了不是"一次失败尝试"：让幽灵吃掉失败额度会污染"满 3 次转 unsolvable"的判据——
   *  一个已删除的文件 3 轮后被写成 unsolvable，而它压根不该再有任何状态（R7 规定下一轮扫描
   *  把这行整个删掉）。故这一支连退避都不写：给一个即将被删的行安排未来是没有意义的。 */
  private async advanceTranslateOnce(): Promise<void> {
    const runItem = this.deps.translateRunItem
    if (!runItem) return                                   // 未接线 → 整支休眠（零成本）
    // 惰性求值（见 translateEnabled 的论证）：dashboard 里关掉翻译，下一轮就不再领新活。
    if (!(this.deps.translateEnabled?.() ?? false)) return

    const db = this.deps.db
    const now = this.deps.now?.() ?? Date.now()
    const fileExists = this.deps.fileExists ?? existsSync

    const candidates = listNewTranslateCandidates(db, now)
    if (candidates.length === 0) return

    // 单次只处理一个**作品**（C32）：取队首那个 work_id 的第一个文件。
    // 为什么按文件而不是按整簇：翻译是逐文件的付费 LLM（每集一个 session），一簇 24 集就是
    // 24 个 session 串行几小时。字幕流可以整簇一次（一个 agent session 处理一批），翻译不行。
    const c = candidates[0]

    // R12：跑到时资源文件仍存在。stat 抛错时**当它还在**（同 dropVanishedFiles 的既有口径）：
    // FUSE 挂载抖动时"问不出答案"绝不许折叠成"消失"，否则挂载抖一下就等于把活丢掉。
    let present = true
    try { present = fileExists(c.videoPath) } catch { present = true }
    if (!present) {
      this.deps.log(`翻译跳过（文件已消失，不计 tr_attempt / R12）: ${c.videoPath}`)
      return
    }

    this.deps.log(`翻译 ${c.title} (${c.videoPath})`)
    // R-F10 activity ⑤：翻译是流水线里唯一"单个活可能跑几小时"的阶段（阶段 4）。不推的话
    // 用户在活动页上会看到系统"卡在最后一步不动"——而它其实正在逐段翻一集片。
    this.emit({ type: 'activity', message: `正在翻译：${c.title}`, title: c.title, workbench: 'translate' })
    // 🔴 GC 炸弹修复（2026-08-08 live test 实测残留 312KB / CURRENT-STATE §八 + C34 的翻译那一半）。
    //
    // 把这个活的翻译工作台目录名登记为"在飞行"，跑完（含抛错）必须摘掉——与阶段 3 字幕流的
    // 那段登记完全同构，理由也同：gcOrphans 的两条保留条件之一就是"这个工作台正在被使用"，
    // 空集合意味着 boot GC 会 rm 掉正在被 agent 写入的现场。
    //
    // 文档此前把这条记为"做不到"，根因是旧 jobId 是 `daemon-${Date.now()}` —— 循环层无法预知。
    // `translateJobId(workId, path)` 把它变成稳定派生值之后，这里能算出与
    // makeDaemonTranslateRunItem 实际用的那个**字节一致**的同一个字符串，登记于是成立。
    // 两处必须共用同一个构造函数（不许任何一侧手拼）：漂了 GC 保护就静默失效而测试全绿。
    //
    // 登记必须在 R12 的存在性检查**之后**（与字幕流"登记必须在剔除之后"同一条论证）：
    // 一个根本没开工的 jobId 若也登记一次，它对应的（上次失败留下的）现场就白白免疫一次回收。
    const jobId = translateJobId(c.workId, c.videoPath)
    this.inFlightStagingJobIds.add(jobId)
    let status: TranslateRunItemResult['status']
    try {
      const r = await runItem(c.videoPath)
      status = r.status
    } catch (e) {
      // 抛错按失败轨记账（**不是**静默跳过）：一个稳定抛错的文件若不记额度就永远攒不满 3 次，
      // 于是每轮巡检重跑一次、每次一个付费 LLM session，永不终止（C13 在字幕轨的同型血案）。
      // 归到 write-failed 这一档是因为它与"诚实无源"截然不同——无源是终局（→ unsolvable），
      // 抛错是"这次没跑通"，该走退避轨、给它剩下的额度。
      this.deps.log(`warn: 翻译抛错（隔离，按失败轨退避）: ${c.videoPath}: ${String(e)}`)
      status = 'write-failed'
    } finally {
      // finally 而不是顺序执行（照字幕流的既有形态）：runItem 抛错时若不摘，这个 jobId 会
      // 永久免疫 GC，工作台垃圾从此无界堆积——而它正是本次要修的那个缺陷本身。
      this.inFlightStagingJobIds.delete(jobId)
    }

    // 全部回写带乐观守卫（D10），守卫匹配 0 行时必须留下痕迹——见下方论证。
    const write = applyTranslateOutcome(db, c.videoPath, status, now)
    if (write.guardMissed) {
      // D10 + C32：这几分钟里扫描已经改过 sub_status（最常见是扫到字幕写了 covered）。
      // 回写整个作废是**正确**的（磁盘事实优先），但它同时意味着 tr_recheck_after 没写上 →
      // D6 要防的热循环从侧门回来。故这件事必须可观察：不记日志的话，"翻译白跑一轮付费 LLM
      // 且下一轮还会重跑"在库里和日志里都留不下任何痕迹，排障时无从下手。
      this.deps.log(
        `warn: 翻译回写守卫未命中（sub_status 已被扫描改成 ${write.status}，本次 ${status} 回写作废 / D10）: ${c.videoPath}`,
      )
      return
    }
    this.deps.log(`翻译结果 ${status} → sub_status=${write.status}: ${c.videoPath}`)
    // R-F10 found ②：翻译装盘成功同样是"找到了字幕"——对用户而言"从哪来的"是实现细节，
    // 结果都是"这一集现在有中文字幕了"，故与抓源装盘同走 found（通知页不分两个池子）。
    // 只在 installed 这一档发：其余状态（no-source / write-failed / unsupported）是失败或
    // 终局判定，不是成果，走日志与 sub_status。
    if (status === 'installed') {
      this.emit({
        type: 'found', message: `${c.title}：翻译完成并装上了字幕`, title: c.title,
        workbench: 'translate',
        data: { via: 'translate' },
      })
    }

    // 装盘成功踢一脚扫描：新 sidecar 越早被扫到、covered 越早落库（R24 只有扫描有权写）。
    if (status === 'installed') {
      try { this.deps.requestIngest?.() } catch (e) {
        this.deps.log(`warn: 翻译后踢扫描失败（下一轮自然巡检仍会确认）: ${String(e)}`)
      }
    }
  }

  /** C46：读一个守备目录，**带当场重试**。R8 两道闸门的判定收敛到这一个地方。
   *
   *  返回 `ok:false` 有且仅有两种成因，正好对应 R8 的两道闸：
   *   · `error !== undefined` —— walk 抛错（挂载掉线/权限）
   *   · `error === undefined` —— walk 成功但入库口径快照为空（FUSE 抖动的那张阴脸）
   *  调用方据此打不同的日志，但**两者的后续处置完全一致**（跳过删除与字幕观察）。
   *
   *  "空" 判据用 `entries.length`（过完 isScannable 的入库口径）而非 `files.length`：
   *  全部文件都被 isScannable 挡掉（比如整根都是探针残留小文件）同样意味着"没有可信的
   *  入库口径快照"，一样不该拿去做差集。这是 R8 第二道闸原本就有的口径，原样保留。
   *
   *  stat 在这里做而不是留给调用方：判"空"本来就得过一遍 isScannable，而 isScannable 要
   *  size。既然已经 stat 过，就把结果一并带出去给 upsert 用——在 115 FUSE 上 stat 代价放大
   *  约 46 倍，让调用方再 stat 一遍就是白白翻倍。
   *
   *  `signal` 在**退避期间**生效：`docker stop` 时 daemon 若正卡在 3s 退避上必须当场收手。
   *  中断后不再发下一次 walk，直接返回最后一次的失败结果 → 走 R8 那条安全路径。
   *  这一点是刚性的：中断绝不能变成"拿着空快照去做差集"。 */
  private async readRootWithRetry(
    root: string,
    stat: (p: string) => { mtimeMs: number; size: number } | null,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; attempts: number; files: string[]; entries: Array<{ path: string; st: { mtimeMs: number; size: number } }> }
    | { ok: false; attempts: number; error?: unknown }
  > {
    const walk = this.deps.listVideoFiles ?? walkVideoFiles
    const sleepFn = this.deps.sleep ?? sleep
    const backoffs = R8_RETRY_BACKOFFS_MS

    let lastError: unknown
    let hadError = false
    // attempt 0 是首次读取，1..N 是重试。循环上界 = 首次 + backoffs.length 次重试。
    for (let attempt = 0; attempt <= backoffs.length; attempt++) {
      if (attempt > 0) {
        // 退避在**发起重试之前**，不是在失败之后：写成"失败就 sleep"的话最后一次失败
        // 也会白等一轮退避，把一个已经确定要跳过的根再多拖 3 秒。
        await sleepFn(backoffs[attempt - 1], signal)
        // 退避期间被 abort → 当场收手，返回上一次的失败结果（走 R8 安全路径）。
        if (signal?.aborted) return { ok: false, attempts: attempt, error: hadError ? lastError : undefined }
      }

      let files: string[]
      try {
        files = walk(root)
      } catch (e) {
        lastError = e
        hadError = true
        continue
      }
      hadError = false
      lastError = undefined

      // 入库口径快照：过 isScannable 这道门。seen 只收这一档，否则差集会把
      // "扫到了但按规矩不入库"的文件当成"库里该有的行"，两边口径不一致。
      const entries: Array<{ path: string; st: { mtimeMs: number; size: number } }> = []
      for (const f of files) {
        const st = stat(f)
        if (!st) continue
        if (!isScannable(f, st.size).ok) continue
        entries.push({ path: f, st })
      }
      if (entries.length > 0) {
        return { ok: true, attempts: attempt + 1, files, entries }
      }
      // 读成功但为空 → 落进下一轮重试（或耗尽后由调用方走 R8 第二道闸）。
    }

    return { ok: false, attempts: backoffs.length + 1, error: hadError ? lastError : undefined }
  }

  private async scanOnce(signal?: AbortSignal): Promise<void> {
    const db = this.deps.db
    const now = this.deps.now?.() ?? Date.now()

    // 本轮的守备目录：巡检内是 runInspection 冻结的快照，直接 scanOnce（既有测试口径）时现取。
    // 整个 scanOnce **只在这里取一次**：扫描作用域与删除作用域必须是同一份名单，中途换名单
    // 就是让 deleteMissing 的 deeperPrefixes 与刚扫过的路径集对不上（D21 同一漏洞面）。
    const scanRoots = this.currentRoots()
    const resetCols = this.fingerprintResetColumns()

    // 清空子句拼进 upsert 的 DO UPDATE 而不是事后另发一条 UPDATE：一条语句 = 一个原子写。
    // 分两条的话，进程在两条之间被杀（软路由掉电是常态，见 db.ts 的 synchronous=FULL 论证）
    // 会留下"机械事实已是新文件、状态列还是旧文件"的库——那正是 C11 要修的那个状态本身。
    const resetSql = resetCols.map((c) => `, ${c.name}=${c.value}`).join('')
    // sub_recheck_at 写在 upsert 里（C42 的**兜底地板**，不是主路径）。
    //
    // 主路径是下面的 detectSubtitles：它对每个新增/指纹变化的文件观察完就写 now+7 天。
    // 那为什么还要在这里再写一次？因为 observeSubtitle 的 stat 可能抖动抛错（FUSE 挂载常态），
    // 那条路径上我们**故意**不推 sub_recheck_at（好让下一轮重试）。若这一列只由观察写，
    // 一个在首次观察时恰好抖了一下的新文件就会永久停在 NULL——而 B 档谓词 `<= now` 在 NULL 上
    // 是三值逻辑的 unknown，**永远选不中它** → 这一行的字幕存在性从此再没人复核过，
    // 界面上却什么异常都看不出来。这正是 D18 花一整条迁移去消灭的那个静默失效，
    // 只不过换从"新文件"这条侧门进来（C42）。
    //
    // 值取 now 而不是 Date.now()：与观察路径写的值同源，否则同一行会在两个时刻之间反复漂移。
    const upsert = db.prepare(`
      INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, parse_confidence, sub_recheck_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        dir=excluded.dir, filename=excluded.filename, size=excluded.size, mtime=excluded.mtime,
        work_dir=excluded.work_dir, season=excluded.season, episode=excluded.episode,
        parse_confidence=excluded.parse_confidence, sub_recheck_at=excluded.sub_recheck_at,
        updated_at=excluded.updated_at${resetSql}
    `)
    const findExisting = db.prepare('SELECT mtime, size FROM files WHERE path = ?')
    const stat = this.deps.statFile ?? ((p: string) => { try { return statSync(p) } catch { return null } })
    let scanned = 0, upserted = 0, skipped = 0

    // D20：删除前先算一次嵌套关系，凡出现在任何一对里的根（**内外层都算**）整轮跳过删除。
    // 为什么不能靠告警了事：第 1a 步的 detectNestedRoots 只告警、不擅自改用户配置（守备目录
    // 是用户的意图），所以不能假设"用户看了告警会去修"。真实剧本（C29）：/media 与 /media/115
    // 并存，115 的 rclone FUSE 掉线 → /media 的 walk 照样成功（它自己不空）→ 115 下的 files 行
    // 落进 /media 的差集被当成"消失的文件"全删。这正是 R8 要防的灾难的实现版。
    const nestedRoots = this.nestedRootSet()

    // C12：本轮需要探测的文件（新增 / 指纹变化）。**先收集、后统一探**，不在 upsert 循环里
    // 逐个 await：探针是 12-16s 级别的重 IO（115 是 rclone FUSE 挂载），在循环里串行会把
    // "机械扫描"这个本该秒级的阶段拖成几小时，且期间删除逻辑迟迟不生效。
    const toProbe: string[] = []
    // R24 A 档名单：新增 / 指纹变化的文件。与 toProbe 同批但**必须是独立的两个名单**——
    // toProbe 会在探针未注入时整批空转（probeNewOrChanged 直接 return），而字幕存在性观察
    // 不依赖 ffprobe，凭一个 fileExists 就能做。合成一个名单就等于"没装 ffprobe 的机器
    // 连字幕都不认了"。
    const toDetect: string[] = []
    // D23：本轮被跳过的根（R8 两种形态 + D20 嵌套）。名单要传给 detectSubtitles——B 档的挑选
    // 谓词是全库查询、**不分根**，光看库里的列推不出"这个根本轮可不可信"。
    const skippedRoots: string[] = []

    // Task ③：守备目录健康度的**唯一写入点**（media_roots.last_error / last_checked_at）。
    //
    // 为什么必须是 try/finally 的单点收敛，而不是"每根循环末尾统一写一次"：
    // 下面这个循环体里有 **3 处 `continue`**（R8 第一/二道闸合并的那个 `!read.ok` 分支、
    // C47 第三道闸的分支 ③、D20 嵌套根分支），循环末尾对它们**根本到不了**。写在末尾
    // 等于"只有健康的根会被记录"——而这两列存在的全部意义恰恰是记录不健康的那些。
    //
    // 为什么 catch 里要记一笔再 rethrow：循环体里任何未预期的异常（upsert 撞库、
    // deleteMissing 抛错）都会掀翻整轮巡检。若只有 finally 而没有 catch，rootError 仍是
    // null → 这一行被写成"健康"，然后整轮巡检失败——库里留下一条与事实相反的记录。
    // rethrow 保证控制流与改动前**逐字一致**（异常照旧向上传播，走 run() 的 health ④）。
    const markRoot = db.prepare(
      'UPDATE media_roots SET last_error = ?, last_checked_at = ? WHERE path = ?',
    )

    for (const root of scanRoots) {
      // 本根本轮的判决。null = 健康（这正是**成功路径清空**的载体：finally 里无条件写，
      // 值为 null 时那条 UPDATE 就是一次清空）。绝不能写成"只在出错时才发 UPDATE"——
      // 那样用户修好挂载后 last_error 永久粘住，界面永远显示红的（这是本任务点名的缺失点）。
      let rootError: string | null = null
      try {
        // C46：两道 R8 闸门合并成一次**带当场重试**的读取（见 R8_RETRY_BACKOFFS_MS 的论证）。
        // 合并而不是各写一段重试的理由：两种形态（抛错 / 读出空）是**同一个瞬时故障的两张脸**
        // ——生产实测的那次是"不抛错只返回空"，但 rclone 在别的抖动路径上是会抛 EIO 的。
        // 分开写等于同一件事有两份退避策略，哪天调了一处就漂移。
        const read = await this.readRootWithRetry(root, stat, signal)

        if (!read.ok) {
          // ── 重试全部失败 → 行为与改动前**逐字一致**（跳过删除、跳过字幕观察、
          //    skippedRoots.push、打日志）。重试是 R8 保护之上的增益，绝不是它的替代品：
          //    "一次删光该根全库"仍是这个项目最严重的可能故障。
          //    日志带上"已重试 N 次"——不带的话运维看到"跳过"会以为系统没努力过，
          //    而真相是连着 3 次读取都是坏的（那是真掉线，该去看 rclone 了）。
          const tried = `已重试 ${read.attempts - 1} 次`
          if (read.error !== undefined) {
            // walk 抛错 = 守备目录不可访问（挂载掉线/权限）。此时**已扫到的路径集是不可信的**，
            // 拿它做差集就是删库，故整根跳过删除；upsert 也无从做（一个文件都没拿到）。
            // 原始错因（String(e)）必须原样带出：那是排障的唯一线索，不许被重试包装吃掉。
            this.deps.log(`scan: 守备目录不可访问，跳过删除与字幕观察（R8 挂载保护 / D23，${tried}）: ${root}: ${String(read.error)}`)
            // R-F10 health ①：R8 第一道闸。用户视角就是"我的库可能有问题"——这个根这一整轮
            // 都不会被处理，而下一轮是 24 小时之后。**不推的话它只存在于日志文件里**，
            // 而日志文件正是用户不会去看的地方（R-F9 的三层分区：排障归排障，但"整个根停摆"
            // 已经越过了排障，是产品事实）。
            this.emit({ type: 'health', message: `守备目录读取失败，本轮跳过（${tried}）: ${root}` })
            // Task ③：与 health 事件**同源**的持久化判决（见循环顶部 rootError 的论证）。
            // 文案刻意与 health message 保持一致：两个出口说同一件事，漂了就会出现
            // "SSE 说读取失败、库里说行数骤降"这种自相矛盾的排障现场。
            rootError = `守备目录读取失败，本轮跳过（${tried}）: ${String(read.error)}`
          } else {
            // R8 第二道：目录可访问但一个媒体文件都没扫到。115 的 rclone FUSE 掉线时目录
            // **不报错、只是看起来是空的**——这是最阴的形态，无脑差集就是一次删光该根全库。
            this.deps.log(`scan: 守备目录扫出 0 个媒体文件，跳过删除与字幕观察（R8 挂载保护 / D23，${tried}）: ${root}`)
            // R-F10 health ②：R8 第二道闸（FUSE 掉线最阴的形态——目录不报错、只是看起来是空的）。
            this.emit({ type: 'health', message: `守备目录扫出 0 个媒体文件，疑似挂载异常，本轮跳过（${tried}）: ${root}` })
            // Task ③：同上，R8 第二道闸的持久化判决。
            rootError = `守备目录扫出 0 个媒体文件，疑似挂载异常，本轮跳过（${tried}）`
          }
          skippedRoots.push(root)
          continue
        }

        // 重试后成功 = 用户的挂载**正在抖**。必须打日志：这一条是"抖动"与"一切正常"之间
        // 唯一的可观察差别（入库结果两者完全相同）。不打的话抖动会一直恶化到重试也救不回来
        // 的那天才第一次被发现——本仓已因"日志把中间量说成结论量"栽过三次（probe ok=N 数的
        // 是没抛异常、judge 把总数说成需字幕数、mismatch 截断到看不出差异）。
        if (read.attempts > 1) {
          this.deps.log(`scan: 守备目录瞬时读取故障，第 ${read.attempts - 1} 次重试成功（R8 / C46）: ${root}`)
        }

        // 本轮采信的读取结果。守卫的"重读已恢复"分支会**整体换掉**这两个变量，故用 let：
        // 只换 seen 而留下旧的 entries/files，会让入库走 720 个的旧快照、删除走 1292 个的新
        // 快照，两个口径当场劈叉（且 skipped 会算成 720-1292 的负数）。
        let files = read.files
        let entries = read.entries
        // deleteMissing 的差集口径：过完 isScannable 的那一档（见 readRootWithRetry 的论证）。
        let seen = new Set<string>(entries.map(e => e.path))

        // ── C47：R8 第三道闸——部分读取的比例守卫。
        //
        // 走到这里说明本轮读到了 >0 个文件（0 个已被上面第二道闸接走），但"读到了一些"
        // 距离"读到的是全部"还差得远：生产 04:07 那次读到 720 个、库里 1292 行，差集 572 行
        // 被当成"磁盘上已消失"删了个干净，而磁盘上一个文件都没少。
        //
        // 分母取库里归本根管的行数（与删除作用域同源，见 rootScopeQuery）。既有为 0 时
        // 直接放行：那是**首次入库**（从无到有），不是骤降；且此时比值的分母为 0，
        // 让它参与比较会得到 Infinity/NaN，而 NaN 的任何比较都是 false ——究竟表现为
        // "永远拦"还是"永远放"取决于比较写法，两种写错法都不会在别处暴露。故显式短路。
        const existingCount = this.countRowsUnderRoot(root, scanRoots)
        if (existingCount > 0 && seen.size < existingCount * R8_MIN_SURVIVAL_RATIO) {
          // 触发了守卫**不等于**判定为故障——真实的大规模删除也会落到这里。两者的区别在于
          // 稳定性：真实删除在两次读取之间是稳定的，FUSE 抖动不是。故再读一次来分辨。
          // 这一趟额外 readdir（115 上实测 44s）只在守卫触发时付，正常轮次一次都不发。
          const confirm = await this.readRootWithRetry(root, stat, signal)
          const pct = (n: number) => `${(n / existingCount * 100).toFixed(1)}%`
          // 日志一次把四个数字全给出来：扫到多少 / 库里多少 / 比例 / 阈值 / 重读多少。
          // 本仓已栽过三次"日志把中间量说成结论量"（probe ok=N 数的是没抛异常、judge 把
          // 总数说成需字幕数、mismatch 截断到看不出差异），这条日志的存在意义就是让人
          // **当场**判断这次拦截是对是错，而不是回头去猜。
          const facts = `扫到 ${seen.size} / 库里 ${existingCount} = ${pct(seen.size)}`
            + `，低于阈值 ${R8_MIN_SURVIVAL_RATIO * 100}%；重读`
            + (confirm.ok ? `扫到 ${confirm.entries.length}（${pct(confirm.entries.length)}）` : '失败')

          if (confirm.ok && confirm.entries.length >= existingCount * R8_MIN_SURVIVAL_RATIO) {
            // ① 重读恢复 → 确系抖动。用**重读的结果**继续，本轮照常入库+删除。
            // 不退化成"跳过了事"是刻意的：那等于把一次几秒的抖动放大成一整天停摆，
            // 正是 C46 刚修掉的放大效应，不许在这里请回来。
            this.deps.log(`scan: 首次读取骤降但重读已恢复，采用重读结果（R8 第三道闸 / C47）: ${root}: ${facts}`)
            files = confirm.files
            entries = confirm.entries
            seen = new Set<string>(entries.map(e => e.path))
          } else if (confirm.ok && confirm.entries.length === seen.size) {
            // ② 两次读到同一个数字 → 这是稳定事实，确系用户删除 → 放行，照常删。
            // 这一分支是**防死锁**的：没有它，库 351/盘 200 会每轮都跌破阈值、每轮都被拦、
            // 库永远停在 351，日志每轮平静地说"跳过删除"——D18/C46 那类静默失效的翻版。
            this.deps.log(`scan: 行数骤降但两次读取一致，判定为真实删除，照常清理（R8 第三道闸 / C47）: ${root}: ${facts}`)
          } else {
            // ③ 重读失败、或拿到**另一个**低数字 → 两次读取自相矛盾，没有一个可信。
            // 用户点名的最坏情况"每次都是不同的部分"正落在这一档。处置与现有两道闸
            // 完全一致：跳过删除**并**跳过字幕观察（D23 联动，只跳删除不跳观察等于
            // 拿不可信快照把 covered 打回 NULL，下一轮重跑整轮付费字幕 session）。
            this.deps.log(`scan: 守备目录行数骤降且重读不一致，跳过删除与字幕观察（R8 第三道闸 / D23 / C47）: ${root}: ${facts}`)
            // R-F10 health ③：C47 拦截。这一档尤其必须让用户看见——它拦下的正是"一次删掉
            // 572 行而磁盘上一个文件都没少"那种真实数据损失（2026-08-11 04:07 实测），
            // 而拦截本身意味着这个根本轮不被清理，用户有权知道自己的库正处在这个状态。
            this.emit({ type: 'health', message: `守备目录行数骤降且两次读取不一致，已拦下删除（${facts}）: ${root}` })
            // Task ③：C47 第三道闸的持久化判决。这一档尤其重要——生产 04:07 那次走的就是
            // 它，而当时事后完全查不出"哪个根、什么时候、拦下了多少"。facts 原样带进去：
            // 那串数字（扫到多少/库里多少/比例/重读多少）是判断"这次拦截对不对"的全部依据。
            rootError = `守备目录行数骤降且两次读取不一致，已拦下删除（${facts}）`
            skippedRoots.push(root)
            continue
          }
        }

        // 本根的 A 档候选先攒在局部名单里，**跑完两道 R8/D20 闸门之后**才并进 toDetect。
        // 不能边扫边直接 push 进 toDetect：嵌套根这条形态（D20）里 walk 是**成功**的
        // （/media 自己不空），文件确实被 upsert 了，等到发现"这个根不可信"时它们已经进名单了。
        const rootDetect: string[] = []
        scanned += files.length
        skipped += files.length - entries.length
        // 复用探空阶段已经取到的 st，**不重新 stat**：stat 在 115 FUSE 上代价放大约 46 倍，
        // 几千文件重取一遍就是把本该秒级的机械扫描又拖长一截（同 R24 那条性能红线的理由）。
        for (const { path: f, st } of entries) {
          const existing = findExisting.get(f) as { mtime: number; size: number } | undefined
          if (existing && existing.mtime === Math.round(st.mtimeMs) && existing.size === st.size) continue
          const row = toMediaFileRow(f, st, scanRoots)
          upsert.run(row.path, row.dir, row.filename, row.size, row.mtime,
            row.workDir, row.season, row.episode, row.parseConfidence,
            now + SUB_RECHECK_INTERVAL_MS, Date.now())
          upserted++
          // 只有走到这里（新增 or 指纹变化）才排进探测队列。指纹未变的文件在上面那行
          // `continue` 就走了，**一次 ffprobe 都不会发**——这是性能红线而非优化：
          // 生产上一个守备目录是 115 网盘的 rclone FUSE 挂载，全库重探是几万 × 12s。
          toProbe.push(f)
          rootDetect.push(f)
        }

        if (nestedRoots.has(root)) {
          // 打日志是硬要求：不说原因的话运维只会看到"删除逻辑坏了"，无从排查。
          this.deps.log(`scan: 守备目录处于嵌套关系中，跳过删除与字幕观察（D20 / C29 / D23）: ${root}`)
          skippedRoots.push(root)
          // Task ③ 审计补：这一支原先**不写 rootError**，于是库里说它健康，而日志与
          // skippedRoots 都说它整轮停摆——三个出口两种结论。Task ⑤ 的 /api/v2/health
          // 据 last_error 判 roots.ok，会把一个整轮不被处理的根判成绿的。
          // 这一支与另外三道闸的**用户后果完全相同**（跳过删除与字幕观察，下一轮是 24h 后），
          // 判决就必须相同。区别只在成因是配置问题而非挂载故障，故文案指向"怎么修"。
          rootError = `守备目录处于嵌套关系中，本轮跳过（请在设置里去掉其中一个）: ${root}`
          continue
        }

        for (const f of rootDetect) toDetect.push(f)
        this.deleteMissing(root, seen, scanRoots)
      } catch (e) {
        // 未预期异常（upsert 撞库 / deleteMissing 抛错 / stat 替身炸了）。先把判决记成
        // "这个根本轮出事了"，再原样 rethrow —— 控制流与本改动之前逐字一致。
        // 不记的话 finally 会把它写成健康，而整轮巡检随即失败：库里留下与事实相反的一行。
        rootError = `扫描本根时异常: ${String(e)}`
        throw e
      } finally {
        // ── 单点收敛（本轮这个根**唯一**的一次健康度写入）。
        //
        // 放在 finally 而不是循环末尾：上面的循环体有 3 处 continue（R8 一/二道闸、
        // C47 分支 ③、D20 嵌套），末尾根本到不了；而那三处恰恰是最需要被记录的三种不健康。
        // finally 对 continue / return / throw 三种离开方式都会执行，是唯一无遗漏的位置。
        //
        // rootError 为 null 时这条 UPDATE 就是**成功路径的清空**：把上一轮留下的
        // last_error 抹掉。只写不清 = 用户修好挂载后界面永远显示红的。清与写共用同一条
        // 语句、同一个变量，结构上就不存在"漏了清空那条分支"的可能。
        //
        // 两列同一条 UPDATE：分两条会在掉电时留下"错误已清、时刻还是旧的"的行，
        // 而 `last_error IS NULL` 单独看不出是"健康"还是"从没扫过"，两列必须同生共死。
        //
        // try/catch 包住：media_roots 表可能不存在（测试用裸库 / v11 及更早的旧库），
        // 且这个根可能根本不在表里（deps.roots 启动快照与表会漂移，见 rootsProvider 注释）
        // —— 后者是 UPDATE 影响 0 行，不抛错，本就无害。健康度记账是**增益**，
        // 绝不许因为它失败而掀翻整轮扫描（同 nestedRootSet / emit 的既有隔离口径）。
        try {
          markRoot.run(rootError, now, root)
        } catch { /* 无表/写失败：不阻断扫描，见上 */ }
      }
    }
    if (upserted > 0) {
      this.deps.log(`scan: scanned=${scanned} upserted=${upserted} skipped=${skipped}`)
    }

    // 字幕存在性观察（R24）**必须在删除清理跑完之后**：对一个已经从磁盘消失的文件跑 84 次
    // stat 是纯浪费，在 FUSE 挂载上尤其贵（ENOENT 也要过一趟网络）。顺序在这里是硬要求，
    // 不是风格问题——B 档是从库里挑行，删除没跑完的话幽灵行就在挑选范围里。
    this.detectSubtitles(toDetect, now, skippedRoots)

    await this.probeNewOrChanged(toProbe)
  }

  /** R24 + D12：字幕存在性观察的两档调度。
   *
   *  A 档 = 本轮新增/指纹变化的文件（调用方传进来的 aPaths），无条件全量检测——这些文件的
   *  字幕状态必然未知（新文件）或已失效（换了片源，旧字幕对不上新时长/分段）。
   *  B 档 = 库里 `sub_recheck_at <= now` 的行，到点轮转。
   *
   *  为什么 A 先跑 B 后跑：A 档检测完就把 `sub_recheck_at` 推到 now+7 天，于是 B 档的
   *  `<= now` 谓词天然选不中它们，不需要额外去重（spec §5「A/B 档不重复检测」）。
   *  反过来（B 先 A 后）也不会错，但会白扫一遍刚被 A 档扫过的文件。
   *
   *  fileExists 未注入时整个观察退化成 no-op（同 probe 的既有约定）：观察是增益，不是阶段 1
   *  的前提，绝不能因为某个构造点忘了接线就让机械扫描/删除清理整个失效。
   *
   *  D23：`skippedRoots` = 本轮被 R8/D20 跳过删除的根，其下文件**整批不做观察**。
   *  为什么观察必须与删除共进退：R8 保护的本意是"挂载掉线时目录看起来是空的，别当真"，
   *  而这个"别当真"对字幕存在性同样成立——挂载掉线时 fileExists 对整个根返回 false（或抛错），
   *  该根下所有 covered 会被一次回退成 NULL，挂载恢复后系统为整根重新找一遍字幕，
   *  **而字幕一直在磁盘上**。烧的是整轮付费 LLM，且界面上看不出任何异常。
   *
   *  过滤必须在**这里**做而不是在调用方：A 档名单可以在调用方过滤（那是逐根攒的），
   *  但 B 档的挑选谓词是全库查询、不分根——`SELECT path FROM files WHERE sub_recheck_at <= now`
   *  里没有任何"这个根本轮可不可信"的信息，只能靠这个显式传进来的名单排除。 */
  private detectSubtitles(aPaths: string[], now: number, skippedRoots: string[] = []): void {
    const fileExists = this.deps.fileExists ?? existsSync
    const db = this.deps.db
    // R-F15：**per-scan 的目录缓存**。sidecar_langs 的观察靠 readdir 一次拿到整个目录的文件名
    // （替代原本每文件 60 次 stat），但同一个目录下通常有一整季 24 个视频——不缓存的话就是
    // 24 次 readdir，收益归零且比逐个 stat 更糟（单次 readdir 更贵）。缓存的生命周期严格是
    // **本次扫描的这一趟**（局部变量，不是实例字段）：跨轮复用会让"用户刚放进去的字幕"要等到
    // 下一次进程重启才被看见，正是 R23/R24 要消解的那类"库与磁盘不一致"。
    // 失败（FUSE 抖动抛错）同样入缓存——存 null 而不是不存，否则同目录每个文件都重试一次，
    // 挂载真掉线时这一趟扫描要在同一个坏目录上撞 24 次。
    const readdir = this.deps.readdir ?? ((d: string) => readdirSync(d))
    const dirCache = new Map<string, string[] | null>()
    const cachedReaddir = (d: string): string[] => {
      if (!dirCache.has(d)) {
        try { dirCache.set(d, readdir(d)) } catch { dirCache.set(d, null) }
      }
      const hit = dirCache.get(d) ?? null
      if (hit === null) throw new Error(`readdir failed (cached): ${d}`)
      return hit
    }
    // 前缀补 '/' 与 deleteMissing 同源：避免 "/media/tv" 吃到兄弟目录 "/media/tv2"。
    const skipPrefixes = skippedRoots.map((r) => (r.endsWith('/') ? r : `${r}/`))
    const inSkippedRoot = (p: string): boolean => skipPrefixes.some((pre) => p.startsWith(pre))

    // A 档：本轮新增/指纹变化。用 Set 去重——同一路径不该在名单里出现两次（今天不会，但
    // 多根重叠配置下曾经出过同一文件被两个根各扫一次的形态）。
    const detected = new Set<string>()
    for (const p of aPaths) {
      if (detected.has(p)) continue
      detected.add(p)
      this.observeSubtitle(p, fileExists, cachedReaddir, now)
    }

    // B 档：到点轮转。谓词**只看 sub_recheck_at**，不带 sub_status 过滤（D16 铁律 / C37）：
    // 用户手放字幕**不改视频文件指纹** → 这类文件永远进不了 A 档 → 若 B 档只抽样 covered，
    // 则 unsolvable / handoff_translate 的行永远不被检测 → R23/R24 承诺的"用户手放的也认"
    // "停牌自然解除"对停牌态永不生效。而停牌态恰恰是最需要它的那批（用户看到系统搞不定，
    // 才会自己去手放一个字幕）。两条单独看都对，合起来废掉整个 R23 设计意图。
    //
    // 谓词也不带 `IS NULL OR`（D18 / C42）：NULL 行由 v32 迁移打散过、新插入行由下面的
    // markRechecked 写死，故库里不该有 NULL。补 `IS NULL OR` 反而会在首轮把全库一起命中，
    // 正是 D12 要避免的那场雪崩。
    let due: Array<{ path: string }> = []
    try {
      due = db.prepare('SELECT path FROM files WHERE sub_recheck_at <= ?').all(now) as Array<{ path: string }>
    } catch { return }   // 无该列的旧库：观察退化成只做 A 档，不阻断扫描

    let checked = detected.size
    let skipped = 0
    for (const row of due) {
      if (detected.has(row.path)) continue   // A 档本轮已看过（正常情况下谓词已排除，双保险）
      if (inSkippedRoot(row.path)) {
        // D23：不观察，也**不推 sub_recheck_at**。
        //
        // 设计约束辨析（用户点名要论证的那条）："跳过观察"不许实现成"跳过推 sub_recheck_at"
        // 这句话防的是把它当**常态机制**用——若正常路径上"观察完不推时刻"，这些行每轮都被
        // B 档重选，D12 的性能收益归零。但这里是**异常路径**，两点让它不构成那个问题：
        //  ① 被跳过的根本轮一次 stat 都没发，成本是 0；重选的代价只是下一轮多一条 SELECT 行。
        //  ② "下一轮"是 24h 后的下次巡检（时间闸），不是同轮内的 while 循环——不存在热循环。
        // 反过来若在这里推 7 天：挂载抖 5 分钟就修好了，这批文件的字幕存在性却还要再瞎 7 天，
        // 而 B 档是它们唯一的复核通路（手放/手删字幕不改视频指纹，永远进不了 A 档）。
        // 那正好把 R8"优雅恢复"的本意做成了"故障惩罚 7 天"，与 D4 修 C22 时的同一条道理。
        // 处置与 observeSubtitle 里 stat 抖动那条完全同源：本轮没能观察到 → 时刻不动 → 下轮重试。
        skipped++
        continue
      }
      detected.add(row.path)
      this.observeSubtitle(row.path, fileExists, cachedReaddir, now)
      checked++
    }
    if (checked > 0 || skipped > 0) {
      this.deps.log(`scan: 字幕存在性观察 A档=${aPaths.length} B档=${checked - aPaths.length}`
        + `${skipped > 0 ? ` 跳过=${skipped}（D23 挂载保护）` : ''}（R24 / D12）`)
    }
  }

  /** 观察单个视频：磁盘上现在有没有同名中文字幕，据此写 sub_status（R24 的本体）。
   *
   *  **唯一有权写 covered 的是这里**（R24 / spec §5）——不是字幕/翻译 worker 的成功报告。
   *  worker 只负责把文件放到磁盘上，磁盘上有没有由扫描说了算。三个连带收益：
   *   ① worker 声称装盘成功但文件其实没落地 → 系统不会误认为搞定
   *   ② 用户嫌翻译质量差手删字幕 → 下次扫描自然回退 NULL 重新去找（C19 从根上消解，
   *      **不需要任何额外的"回滚"逻辑**——这正是把 covered 建模成"事实观察"的全部价值）
   *   ③ 用户自己手放一个字幕 → 扫到就认（系统从未为它跑过字幕流也认）
   *
   *  没扫到字幕时的两种情况**必须分开处理**（状态转换表 §5）：
   *   · 原本 covered → 回退 NULL（字幕消失了，重进字幕工作台）
   *   · 原本是别的状态 → **一列不动**。扫描没有被授权把停牌写回 NULL：那是阶段 2.6 复查闸
   *     的职责（D13），节奏是周频。若扫描顺手把 handoff_translate 清成 NULL，就会掀掉飞行中
   *     的翻译（D10 的守卫匹配 0 行 → 退避不写 → 付费 LLM 热循环从侧门回来）。
   *
   *  标签集/扩展名集统一走 files/sidecar.ts（C30）：此前 judgeOnce 里另有一份手写正则，
   *  与 sidecar.ts 各漏一半（正则漏 cht 与全部 BCP-47 地区变体，sidecar.ts 漏 .vtt），
   *  同一个磁盘事实在两条代码路径上得到相反结论。本项目已因"留两份漂移实现"栽过
   *  （第 1a 步的 findOverlappingRoot），故收敛到一份。
   *  顺带修掉误归属：判据是"`<stem>.<tag><ext>` 精确整段匹配"，精确到字符；
   *  旧的 `startsWith(stem + '.')` 会把 `X.1080p.zh.srt` 误归给 `X.mkv`（C30）。
   *
   *  ── R-F15：covered 的判据改由 readdir 那一趟**同源导出**（这是本次唯一的机制变更）──
   *  同一个问题（"磁盘上现在有哪些字幕"）此前要付两趟 IO：listSidecarLanguages 的 1 次
   *  readdir + findExternalSidecar 的最多 60 次 stat。两趟不仅浪费，更是**两份判据**——
   *  它们在同一时刻对同一个目录可能给出不一致的答案（FUSE 上尤其可能：一趟成功一趟抖动），
   *  于是 sidecar_langs 记着 ["zh-Hans"] 而 sub_status 是 NULL，两列互相矛盾且无人察觉。
   *  这正是 C27「同一个磁盘事实被两列各判一次」的形状，本仓已明令一个磁盘事实只许有一个
   *  投影来源。故 readdir 成功时，covered 直接由语言集合判定（目标语言 ∈ 集合），
   *  **一次 stat 都不发**——60 次 stat/文件 归零，这是本次改动净赚的性能。
   *
   *  fileExists 那条路**保留为降级路径**，不是死代码：readdir 读不了目录时（权限/FUSE 抖动，
   *  或调用方没接 readdir 这个注入点）仍按老办法逐个探测。降级比放弃观察好——R24 的本体是
   *  "磁盘上有没有字幕由扫描说了算"，不该因为列不出目录就整个失效。 */
  private observeSubtitle(
    videoPath: string, fileExists: (p: string) => boolean,
    readdir: (d: string) => string[], now: number,
  ): void {
    const db = this.deps.db
    const targetValues = coverageValuesFor([this.deps.targetLanguage])

    // R-F15 缺口②：一趟 readdir 同时产出两个结论——**全部**外挂字幕语言（sidecar_langs，
    // 与当前目标语言无关的磁盘事实）与"当前目标语言的字幕在不在"（sub_status 的判据）。
    // 三态：null = 目录读不了（下面降级到逐个 stat）；[] = 读了、确认零条外挂字幕。
    let sidecarLangs: string[] | null = null
    try {
      sidecarLangs = listSidecarLanguages(videoPath, readdir)
    } catch { sidecarLangs = null }

    let found = false
    if (sidecarLangs !== null) {
      found = sidecarLangs.some((l) => targetValues.has(l))
      // 单独一条 UPDATE、且**只写这一列**：它与下面 sub_status 的写入条件不同（后者有
      // "只回退 covered"的守卫），合并会把那条守卫带到这一列上——磁盘事实的记录不该因为
      // 这一行当前是停牌态就被跳过。列缺席的旧库上静默跳过（同 judge 的动态拼列口径）。
      try {
        db.prepare('UPDATE files SET sidecar_langs = ? WHERE path = ?')
          .run(JSON.stringify(sidecarLangs), videoPath)
      } catch { /* 无该列的旧库：记录是增益，不许阻断 R24 的本体 */ }
    } else {
      // 降级路径：目录列不出来，退回逐个 stat 探测当前目标语言（老机制，逐字不变）。
      // sidecar_langs 保持 NULL——**不许**在这里瞎写 []，那会把"没观察到"记成"确认没有"，
      // 换语言重判时据此重新找一遍（三态契约，同 embedded_langs）。
      try {
        found = findExternalSidecar(videoPath, tagsForLanguage(this.deps.targetLanguage), fileExists) !== null
      } catch (e) {
        // 单个文件的 stat 抖动（FUSE 挂载常态）不许掀翻整轮扫描。跳过 = 不改状态列，
        // 且**不推 sub_recheck_at**，于是下一轮它还在 B 档名单里，天然重试。
        this.deps.log(`scan: 字幕存在性观察失败（隔离，下轮重试）: ${videoPath}: ${String(e)}`)
        return
      }
    }

    if (found) {
      // 无条件写 covered：不论原状态是 NULL 还是停牌态。停牌的解除凭据就是这个（R23）。
      db.prepare(`UPDATE files SET sub_status = 'covered', sub_recheck_at = ?, updated_at = ?
                  WHERE path = ?`).run(now + SUB_RECHECK_INTERVAL_MS, now, videoPath)
      return
    }

    // 没扫到：只把 covered 回退成 NULL，其余状态一列不动（见上方论证）。
    // 用 `WHERE sub_status = 'covered'` 做条件而不是先读后写：一条语句 = 一个原子写，
    // 且天然表达了"只有 covered 会被回退"这条语义。
    db.prepare(`UPDATE files SET sub_status = NULL, updated_at = ?
                WHERE path = ? AND sub_status = 'covered'`).run(now, videoPath)
    // sub_recheck_at 单独推：无论状态改没改，"这一行本轮已经复核过"这件事都成立。
    // 合进上面那条的话，非 covered 的行（停牌态）永远推不动 sub_recheck_at → 每轮都被
    // B 档重新选中 → B 档对停牌态退化成全量扫描，D12 的性能收益在最需要它的那批上归零。
    db.prepare('UPDATE files SET sub_recheck_at = ? WHERE path = ?')
      .run(now + SUB_RECHECK_INTERVAL_MS, videoPath)
  }

  /** C11 的清空名单 ∩ 库里实际有的列，且每列的"清空值"取**该列自己声明的 DEFAULT**而不是
   *  一律 NULL（见 FINGERPRINT_RESET_COLUMNS 的论证）。
   *
   *  为什么不能一律写 NULL：`sub_attempt` 在 spec 第 3 步会照既有 `attempt` 列的样子建成
   *  `INTEGER NOT NULL DEFAULT 0`，`x=NULL` 直接撞 NOT NULL 约束 → **整轮扫描抛错**。
   *  这不是理论风险：本仓的 files 表已经有一列 `attempt INTEGER NOT NULL DEFAULT 0` 就是这个
   *  形状，第 3 步加 sub_attempt 时必然照抄。从 PRAGMA 读 notnull/dflt_value 让"清空"的语义
   *  变成"回到该列的出厂值"，加列的人不需要回来改这里。
   *
   *  读不到 PRAGMA（不该发生，但扫描不能因为它挂）时退化成空 → 只更新机械事实，
   *  等同于改动前的行为，不会把库写坏。 */
  private fingerprintResetColumns(): Array<{ name: string; value: string }> {
    try {
      const info = this.deps.db.prepare('PRAGMA table_info(files)').all() as
        Array<{ name: string; notnull: number; dflt_value: string | null }>
      const byName = new Map(info.map((c) => [c.name, c]))
      const out: Array<{ name: string; value: string }> = []
      for (const name of FINGERPRINT_RESET_COLUMNS) {
        const col = byName.get(name)
        if (!col) continue
        // NOT NULL 列回落到它的 DEFAULT；DEFAULT 也没有的 NOT NULL 列**跳过**——没有任何
        // 安全的"空值"可写，硬猜一个（0？''？）就是替 schema 作者发明语义。
        if (col.notnull) {
          if (col.dflt_value === null) continue
          out.push({ name, value: col.dflt_value })
        } else {
          out.push({ name, value: 'NULL' })
        }
      }
      return out
    } catch { return [] }
  }

  /** C12：对新增/指纹变化的文件探测内嵌字幕轨 + 时长，写 files.embedded_langs / duration_sec。
   *
   *  为什么这一列非写不可：judge 规则 2（"已有内嵌中文轨 → 不用找字幕"）读的就是它，而全仓
   *  从来没人写过 files.embedded_langs → 该规则在新架构下**静默失效**，本该跳过的片子被送进
   *  字幕流白烧一轮付费 LLM；D9 的 translatable 预判（日漫有日文内嵌轨 = 纯本地抽取、可救）
   *  同样以它为前提，缺了会误判死一批能救的片子。
   *
   *  三态语义**忠实转录**，不折叠（streamProbe.ts 的 load-bearing 契约）：
   *   · 探针返回 null（二进制缺席/超时/JSON 解析不出）→ embedded_langs 留 NULL = "没探测过"。
   *     绝不能写成 []：[] 是"探过、确认零轨"，D9 会据此判"无同语言内嵌轨 → 不可救 → unsolvable"，
   *     把一个只是网盘超时过一次的日漫**永久判死**。留 NULL 还能被 D17 的回填 pass
   *     （谓词 `embedded_langs IS NULL`）捞回来重探——那是失败重试的唯一凭据。
   *   · 探针返回 [] → 写 '[]'，不写 NULL。反过来同样有害：把"确认零轨"记成 NULL 会让回填 pass
   *     每次启动都重探这批文件，在 FUSE 挂载上就是永不收敛的重探循环。
   *
   *  逐文件 try/catch + allSettled 语义（mapWithConcurrency 已是 allSettled）：一个损坏文件
   *  或一次网盘超时不许掀翻整轮巡检（ingest 的既有铁律）。失败行留 NULL，天然进入下轮/回填的
   *  重试范围，不需要额外记账。 */
  private async probeNewOrChanged(paths: string[]): Promise<void> {
    const probe = this.deps.probe
    const probeDuration = this.deps.probeDuration
    if (paths.length === 0 || (!probe && !probeDuration)) return

    const db = this.deps.db
    const write = db.prepare('UPDATE files SET embedded_langs = ?, duration_sec = ?, updated_at = ? WHERE path = ?')
    // 三态计数（不是二态）：`wrote`（真探到值并落库）/ `unavailable`（探针给不出值，两列留 NULL）
    // / `failed`（抛异常，被隔离）。口径照 backfillEmbeddedLangs 的 `{ path, wrote }`，不另发明。
    //
    // 为什么必须区分：旧实现只统计"没抛异常"（ok++），而探针不可用时 probe() 是**正常返回 null**
    // 的（streamProbe 的三态契约把一切失败归一为 null，不抛）——于是 FFPROBE_PATH 被 compose
    // 设成空串导致 61 个文件一个值都没探到时，日志打的是 `scan: probe ok=61 failed=0`，
    // 61 次静默失败被逐字报告成成功。这是那次故障没被第一时间发现的**直接原因**：
    // 日志本身不可证伪。改成三态后同一场故障的日志是 `wrote=0 unavailable=61 failed=0`，
    // 一眼看出探针整体不可用，不必去查数据库。
    let wrote = 0, unavailable = 0, failed = 0

    const results = await mapWithConcurrency(paths, this.deps.probeConcurrency ?? 2, async (p) => {
      // 同一文件的两个探针**串行**（沿用 ingest 的既有口径）：并发只在跨文件那一层买得到
      // 吞吐，同文件并发两次 ffprobe 只是把同一份网络读放大一倍。
      let langs: string[] | null = null
      let duration: number | null = null
      if (probe) {
        const tracks = await probe(p)
        // 剔图形字幕轨（PGS/DVD/DVB/XSub 是位图叠加，没法当文本比对）与无语言标签的轨——
        // 复用 ingest.ts usableEmbeddedLangs 的同一套"图形字幕不算覆盖"裁决。不剔的话
        // judge 规则 2 会把一条读不了的 PGS 中文轨当成"已有内嵌中字"，永久跳过找字幕。
        // tracks 为 null 时保持 langs=null（不可用 ≠ 零轨，见上方三态论证）。
        if (tracks !== null) {
          langs = [...new Set(tracks.filter((t) => !t.isImageBased && t.lang !== null).map((t) => t.lang as string))]
        }
      }
      if (probeDuration) duration = await probeDuration(p)
      // 探测失败（null）不写 '[]'、也不覆盖已有值为 NULL——这里 langs/duration 本轮必然是
      // 该文件的最新事实（指纹刚变过，旧值已在 upsert 里被清），直写即可。
      write.run(langs === null ? null : JSON.stringify(langs), duration, Date.now(), p)
      // wrote 的判据是"这一轮到底有没有探到任何一样东西"——两个探针都给不出值（langs 为 null
      // 且 duration 为 null）就是 unavailable。**注意这与写库与否无关**：本函数按上面的论证恒
      // 直写（指纹刚变，旧值必须被清），所以不能像 backfill 那样用"是否执行 write"当判据。
      const gotSomething = langs !== null || duration !== null
      return { path: p, wrote: gotSomething }
    })

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'fulfilled') {
        if (r.value.wrote) wrote++
        else unavailable++
        continue
      }
      failed++
      // 逐个记日志而不是只记个数：事后排障要能分辨"这片子真没内嵌轨"与"这台机器的 ffprobe 坏了"
      // （referenceSource.ts 的同一条论证）。失败行的两列保持 NULL，下轮/回填 pass 会重探。
      this.deps.log(`scan: probe 失败（隔离，留 NULL 待重探）: ${paths[i]}: ${String(r.reason)}`)
    }
    if (wrote > 0 || unavailable > 0 || failed > 0) {
      this.deps.log(`scan: probe wrote=${wrote} unavailable=${unavailable} failed=${failed}`)
    }
    // 整体不可用闸：一个都没探到 = 几乎必然是环境/配置问题（FFPROBE_PATH 空串、二进制缺席、
    // 挂载全掉），不是"这批片子恰好都没内嵌轨也没时长"——后者在真实媒体库里概率为零。
    // 这条 warn 的价值是让下一次同类故障在**第一次 live test 的日志里就自证**，
    // 而不是等人去查数据库才发现全 NULL（本次事故正是这么被拖住的）。
    if (unavailable === paths.length && paths.length > 0) {
      this.deps.log(`warn: scan: probe 整体不可用——${paths.length} 个文件一个值都没探到，`
        + `疑似 FFPROBE_PATH 配置错误（compose ${'${FFPROBE_PATH:-}'} 会把它设成空串）或 ffprobe 二进制缺席；`
        + `这两列全留 NULL，judge/D9 会因缺证据退化，请先核实容器内 ffprobe 可用`)
    }
  }

  /** D17 加强版（C38 + C43）：embedded_langs 存量回填 pass。
   *
   *  为什么非有不可：1b-3 已让扫描对新增/指纹变化的文件写 embedded_langs，但存量行是在 probe
   *  上线前入库的（115 上那 248 行），这一列全 NULL——而它是三样东西的共同前提：judge 规则 2
   *  （已有内嵌中文轨 → 跳过找字幕）、D9 的 translatable 判定（日漫有日文内嵌轨 = 纯本地抽取、
   *  可救）、以及 C12 本身。存量行的**指纹不会变**，扫描那条路径永远探不到它们
   *  （probeNewOrChanged 之前那行 `continue` 就走了），故本 pass 是它们唯一的通路。
   *
   *  ── 为什么"探完就完"是错的（这是本仓第三次栽在同一模式上：C12 → C35 → 本条）──
   *  回填 embedded_langs **不会改 needs_subtitle**，而 judgeOnce 的谓词是
   *  `needs_subtitle IS NULL` → judge 永不再看存量行 → 刚探出来的那一列一辈子没人读 →
   *  几万次 12s 的 ffprobe 换来零行为变化，日志上却是一片"回填成功"。故必须**同一条 UPDATE**
   *  里把 needs_subtitle 与 translatable 一起置 NULL，打通重判通路。
   *  同一条语句而不是两条：进程在两条之间被杀（软路由掉电是常态）会留下"证据已补、判决还是
   *  旧的"的行，而它已不在 `embedded_langs IS NULL` 的重试范围里 → 永久冻结，比不回填更糟。
   *
   *  translatable 列**今天还不存在**（归后续 task 加），故按 PRAGMA 取交集动态拼列，
   *  照 fingerprintResetColumns 的同一条既有口径：硬编码进 SQL 会让本 pass 在今天的库上抛
   *  `no such column` → boot 阶段就炸、daemon 起不来；而只写"今天有的列"则会在加列那天静默
   *  漏清——那正是本条要修的缺陷本身。
   *
   *  ── 执行位置与分批（spec §4 第 3 步前置迁移 2 的第 3 项）──
   *  boot 时跑一次，**不是每轮巡检的常驻阶段**。谓词 `embedded_langs IS NULL` 让它自然收敛：
   *  回填完的行选不中，全库探完后每次 boot 只剩一条 SELECT 的成本。
   *
   *  与 1b-3 的 probeNewOrChanged **零重复**，靠"这一行当前有没有 embedded_langs"天然分区：
   *   · 新增文件 boot 时还没有 files 行 → 本 pass 的谓词看不见 → 只被扫描探
   *   · 指纹变化的行 boot 时 embedded_langs 还是旧的非 NULL 值 → 本 pass 跳过 → 只被扫描探
   *   · 存量行指纹不变 → 扫描提前 continue → 只被本 pass 探
   *  boot（在 while 循环之前）这个位置是 load-bearing 的：若挪到扫描之后的同一轮内，
   *  刚被 upsert 清成 NULL、探针又恰好失败的行会在同轮里立刻被重探一次，FUSE 上成本翻倍。
   *
   *  每批 200 是硬上限而非调优参数：生产有个守备目录是 115 网盘的 rclone FUSE 挂载，
   *  单文件 ffprobe 12-16s。一次探完全库就是把 boot 拖成几小时，期间主巡检（删除清理、
   *  识别、字幕）全被堵在后面。剩下的行留 NULL，下次启动继续，不丢活。
   *
   *  失败行记 last_error 并**留 NULL**：NULL 是下轮重探的唯一凭据（streamProbe 的三态契约），
   *  last_error 让运维能分辨"这片子真没内嵌轨"与"这台机器的 ffprobe 坏了"。
   *  值带 `probe:` 前缀而不是裸字符串：last_error 是与识别轨**共用**的列，而
   *  identifyScheduler 的队列谓词是 `last_error IS NULL OR last_error != 'tmdb-404'`——
   *  往这一列写识别轨的终态值会让一次 ffprobe 超时把文件永久踢出识别队列（跨轨串味）。
   *
   *  探针未注入时整支休眠（同 probeNewOrChanged 的既有约定），且**一列都不动**：
   *  若先无条件置 NULL 再探测，探针缺席时就会把全库判决清空却没有任何新证据，
   *  下一轮 judge 拿着同一批 NULL 的 embedded_langs 重判一遍——纯白烧，且每次启动重复一次。 */
  private async backfillEmbeddedLangs(): Promise<void> {
    const probe = this.deps.probe
    const probeDuration = this.deps.probeDuration
    if (!probe && !probeDuration) return

    const db = this.deps.db
    let rows: Array<{ path: string }> = []
    try {
      rows = db.prepare(
        `SELECT path FROM files WHERE embedded_langs IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`,
      ).all() as Array<{ path: string }>
    } catch { return }   // 无 files 表/无该列的旧库：回填是增益，不许阻断启动
    if (rows.length === 0) return

    // 重判通路的那两列按 PRAGMA 实际存在的取（见上方论证）。
    const have = new Set(
      (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    const rejudge = ['needs_subtitle', 'translatable'].filter((c) => have.has(c))
    // 成功时只清**自己写的**失败叙事（`probe:` 前缀），不碰识别轨的值。
    // 无条件 `last_error = NULL` 是跨轨越界：`tmdb-404` 是识别轨的**终态凭据**
    // （identifyScheduler 的队列谓词靠它把 404 的目录永久排除），被字幕轨的一次
    // probe 成功洗掉，那个目录就重进识别队列白烧一次 TMDB。
    // 留着旧的失败叙事会误导排障（libraryRepo.ts:642 有同型血案），但那是两条轨
    // 各自的账——本轨只销自己的。
    const write = db.prepare(
      `UPDATE files SET embedded_langs = ?, duration_sec = ?, updated_at = ?,`
      + ` last_error = CASE WHEN last_error LIKE 'probe:%' THEN NULL ELSE last_error END`
      + rejudge.map((c) => `, ${c} = NULL`).join('')
      + ` WHERE path = ?`,
    )
    const markError = db.prepare('UPDATE files SET last_error = ?, updated_at = ? WHERE path = ?')

    this.deps.log(`回填: embedded_langs 存量回填开始（本批 ${rows.length} 行 / 上限 ${BACKFILL_BATCH_SIZE}，D17）`)
    let ok = 0, failed = 0

    const paths = rows.map((r) => r.path)
    const results = await mapWithConcurrency(paths, this.deps.probeConcurrency ?? 2, async (p) => {
      // 同一文件的两个探针串行（沿用 probeNewOrChanged / ingest 的既有口径）：并发只在跨文件
      // 那一层买得到吞吐，同文件并发两次 ffprobe 只是把同一份网络读放大一倍。
      let langs: string[] | null = null
      let duration: number | null = null
      if (probe) {
        const tracks = await probe(p)
        // 剔图形字幕轨与无语言标签的轨，复用 probeNewOrChanged 的同一套裁决（不剔的话 judge
        // 规则 2 会把一条读不了的 PGS 中文轨当成"已有内嵌中字"，永久跳过找字幕）。
        // tracks 为 null（探测不可用）时保持 langs=null，绝不折叠成 []。
        if (tracks !== null) {
          langs = [...new Set(tracks.filter((t) => !t.isImageBased && t.lang !== null).map((t) => t.lang as string))]
        }
      }
      if (probeDuration) duration = await probeDuration(p)
      // langs 仍为 null（探针不可用）时**不写**：写了就等于把这一行从 `embedded_langs IS NULL`
      // 的重试范围里删掉，而我们其实什么也没探到。留着 NULL 下次 boot 再试。
      // 反过来 langs 为 [] 必须写：那是"探过、确认零轨"，不写就是每次启动重探，永不收敛。
      if (langs === null) return { path: p, wrote: false }
      write.run(JSON.stringify(langs), duration, Date.now(), p)
      return { path: p, wrote: true }
    })

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'fulfilled') { if (r.value.wrote) ok++; continue }
      failed++
      // 逐个记日志 + 落 last_error：事后排障要能分辨"这片子真没内嵌轨"与"ffprobe 坏了"。
      const reason = `probe: ${String(r.reason).slice(0, 200)}`
      try { markError.run(reason, Date.now(), paths[i]) } catch { /* 记账失败不许拖垮回填 */ }
      this.deps.log(`回填: probe 失败（隔离，留 NULL 待下轮重探）: ${paths[i]}: ${String(r.reason)}`)
    }
    this.deps.log(`回填: embedded_langs ok=${ok} failed=${failed}`
      + `（重判通路已置 NULL: ${rejudge.join('/')}，D17 / C43）`)
  }

  /** C21 存量回填 pass：给 `works.provider_ids IS NULL` 的作品补 imdb（boot 一次，不进主循环）。
   *
   *  为什么必须有这条**独立于识别队列**的通路（这就是 C21 的全部内容）：识别成功后
   *  `files.work_id` 非 NULL，而 identifyScheduler 的队列谓词是 `work_id IS NULL`
   *  → 那个作品目录**永不再进识别队列**。于是"识别时顺手采 imdb"（C5）只覆盖**今后**新识别的
   *  作品；CURRENT-STATE 记录的 83 个已识别作品的 provider_ids 会永远是 NULL，抓源腿对它们
   *  退化成纯文本 query（假阴性多），而第 6 步的 e2e 恰好就在这批存量上跑——会量出一个偏低的
   *  命中率并被当成"真实命中率"。这是本仓栽过四次的同型缺陷（C12 → C35 → D17 → D18：
   *  写了某列却没定谁来写/谁来重读），手法照 3-1 已落地的 embedded_langs 回填 pass。
   *
   *  **与 embedded_langs 那个 pass 的关键差别：这里没有"重判通路"要打通。**
   *  那边必须额外置 `needs_subtitle = NULL` / `translatable = NULL`（D17 / C43），因为那两列是
   *  **据旧证据做出的判决**——证据换了，判决必须重来。provider_ids 不是任何判决的输入，它只是
   *  搜索时的一个可选增益参数（`FetchArgs.imdb`），补上之后下一次抓源自然就带上了，不需要
   *  推动任何状态机。这个差别是**论证过的**，不是遗漏：若日后 provider_ids 变成 judge 的判据
   *  （例如"有 imdb 才算可抓源"），这条论证即失效，那时必须同步加重判通路。
   *
   *  三态写入语义（决定这一行会不会被下轮捡回来重查，不许折叠）：
   *   · 拿到 imdb       → `{tmdb, imdb}`
   *   · TMDB 确认没有   → `{tmdb}`，**非 NULL**——"查过、确实没有"，靠非 NULL 收敛。
   *                       只在拿到 imdb 时才写的话，这批作品每次 boot 都重查一遍、永不收敛，
   *                       而列值断言看不出来（NULL 本来也是 NULL）。
   *   · 调用失败        → 留 NULL，下次 boot 重试。
   *
   *  探针（getExternalIds）未注入时整支休眠且**一行不动**：若在缺席时也照写 `{tmdb}`，
   *  一次"忘接线的启动"就把全库标成"查过、没有 imdb"而其实一次 TMDB 都没打 → 抓源腿永久
   *  退化且再无人重试。同 backfillEmbeddedLangs 的"探针缺席不动列"论证。 */
  private async backfillProviderIds(): Promise<void> {
    const getExternalIds = this.deps.identify?.worker?.tmdb?.getExternalIds
    if (!getExternalIds) return

    const db = this.deps.db
    let rows: Array<{ id: string; media_type: string }> = []
    try {
      rows = db.prepare(
        `SELECT id, media_type FROM works WHERE provider_ids IS NULL ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`,
      ).all() as Array<{ id: string; media_type: string }>
    } catch { return }   // 无 works 表/无该列的旧库：回填是增益，不许阻断启动
    if (rows.length === 0) return

    const write = db.prepare('UPDATE works SET provider_ids = ?, updated_at = ? WHERE id = ?')
    this.deps.log(`回填: works.provider_ids 存量回填开始（本批 ${rows.length} 行 / 上限 ${BACKFILL_BATCH_SIZE}，C21）`)
    let ok = 0, failed = 0, skipped = 0

    // **串行**，与 embedded_langs 那个 pass 的并发 2 刻意不同：那边是本地 ffprobe（瓶颈在
    // FUSE IO，并发才买得到吞吐），这边是 TMDB HTTP——配额敏感，且 identifyScheduler 的既有
    // 口径就是"一次一个 work_dir（串行，TMDB 配额敏感）"。200 次串行请求在 TMDB 上是秒级，
    // 而并发打满换来的一次 429 会让整批白跑。
    for (const r of rows) {
      const tmdbId = tmdbIdFromOwnId(r.id)
      if (tmdbId === null) {
        // 非 `tmdb:<id>` 形状（ownIds 注释点名的历史合成 id，如 'self-scan-trigger'）：
        // 拿它去打 `/tv/self-scan-trigger/external_ids` 是保证 404 的白烧，且会把这一行写成
        // "查过没有"从而永久放弃它。留 NULL 等人修数据才是诚实的处置。
        skipped++
        continue
      }
      const mediaType = r.media_type === 'movie' ? 'movie' : 'tv'
      try {
        const ext = await getExternalIds(mediaType, tmdbId)
        const ids: Record<string, string> = { tmdb: tmdbId }
        if (ext.imdbId) ids.imdb = ext.imdbId
        write.run(JSON.stringify(ids), Date.now(), r.id)
        ok++
      } catch (e) {
        // 留 NULL（下轮重试的唯一凭据）。**不往 works 写任何失败叙事**：works 表没有
        // last_error 列，而 files.last_error 是识别/字幕两轨共用的（3-1 那个 pass 的
        // 跨轨串味教训）——一个作品级的 TMDB 故障没有理由去污染文件级的失败账。
        failed++
        this.deps.log(`回填: provider_ids 失败（隔离，留 NULL 待下轮）: ${r.id}: ${String(e)}`)
      }
    }
    this.deps.log(`回填: works.provider_ids ok=${ok} failed=${failed} skipped=${skipped}（C21）`)
  }

  /** R-F5 存量回填（works → tmdb_seasons 应有集缓存）：把 TMDB 的季集表抓进本地库，
   *  供媒体库页画"应有集 vs 实有集"的**虚线小卡片**（TMDB 说这季有、磁盘上没有的集）。
   *
   *  **这一条修的是"表建好了、读写函数都写好了，但没有生产者"**——本仓栽过 5 次的
   *  同型缺陷（C12 → C35 → C43 → C21 → audio_langs）的第 6 例，且形态更隐蔽。实测现状：
   *   · `tmdb_seasons` 表 db.ts v12 就建好；`tmdbCatalog.refreshSeriesCatalog` 是唯一写入方，
   *     `canonicalEpisodes` 是唯一读出方——都在、都有测试、都能跑。
   *   · 但它唯一的**触发点**是 `server.ts:275` 的 `librarySeriesDetail`，那条通路先查
   *     `SELECT … FROM series WHERE id = ?`，detail 为 null 就不触发。
   *   · `series` 是**旧世界**的表，只有 `libraryRepo.upsertSeries`（ingest 走盘循环）会写；
   *     新架构的 daemonV2 一行 series 都不写，它写的是 `works`。
   *   → 新架构识别出的作品在 `series` 里没有行 → detail 恒 null → refreshSeriesCatalog
   *     对它们**一次都不会被调用** → tmdb_seasons 对新架构恒空，虚线卡片一根画不出来。
   *
   *  三个职责（本仓铁律：每加一列/一表都必须写死谁写、谁读、什么时候写全）：
   *   · **谁写**：本 pass。boot 一次，不进 while 循环（同 C21：放进循环就是每 5 分钟打一轮
   *     TMDB；谓词收敛后确实是 0 行，但那是靠运气不是设计）。
   *   · **谁读**：`tmdbCatalog.canonicalEpisodes`（既有），媒体库页/详情页的应有集来源。
   *   · **什么时候写全**：`works` 全表扫 + 每轮 BACKFILL_BATCH_SIZE 上限，多轮 boot 收敛；
   *     单轮内 refreshSeriesCatalog 自己的 7 天 TTL 门跳过已刷新的 series（幂等来源）。
   *
   *  为什么是回填 pass 而不是"识别成功那一刻同步抓"（R-F5 落地形态的关键选择）：与 C21
   *  完全同构——识别成功后 `files.work_id` 非 NULL，而 identifyScheduler 的队列谓词是
   *  `work_id IS NULL` → 那个目录**永不再进识别队列**。只在识别时抓，覆盖的仅是今后新识别
   *  的作品，库里现存的存量作品永远没有季集表。回填 pass 同时覆盖存量与新增（新识别的作品
   *  下一次 boot 被同一个谓词捞到），是唯一收敛的形态。且它天然满足"不许让 TMDB 抓取阻塞
   *  识别"——本 pass 与识别在时间上完全不相交。
   *
   *  **movie 跳过**：电影没有季集，`tmdb_seasons` 里给它留行没有任何读出方会用；更要紧的是
   *  拿 movie id 去打 `/tv/{id}` 是保证 404 的白烧。谓词层就滤掉，不进循环。
   *
   *  **失败留空不写 0**（与 embedded_langs 的三态契约同源，见 backfillEmbeddedLangs 的论证）：
   *  `tmdb_seasons` 没有独立的"探过没有"标志列，**是否存在行**就是那个标志。TMDB 429/网络
   *  抖动时若写 0 行并记 fetched_at，媒体库页会把它读成"这季确实有 0 集"→ 一根虚线都不画，
   *  而真相是没抓到。故失败路径一行不落（refreshSeriesCatalog 的 gain-path 降级已经保证了
   *  这一点：拿不全所有季就原样返回、旧缓存纹丝不动），让下一轮 boot 重新捞起来。
   *
   *  探针（getSeasonTable/getSeasonEpisodes）未注入时整支休眠且**一行不动**，同
   *  backfillProviderIds 的"探针缺席不动列"论证：漏接线是静默的，不能让它伪装成"抓过了"。 */
  private async backfillSeasonCatalog(): Promise<void> {
    // 无 cast：季集两个方法已经是 IdentifyWorkerDeps.tmdb 上的可选字段（identifyWorker.ts），
    // 取值即窄化。窄化后 tmdb 恰好就是 refreshSeriesCatalog 要的
    // `Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes'>`。
    const { getSeasonTable, getSeasonEpisodes } = this.deps.identify?.worker?.tmdb ?? {}
    if (!getSeasonTable || !getSeasonEpisodes) return
    const tmdb = { getSeasonTable, getSeasonEpisodes }

    const db = this.deps.db
    let rows: Array<{ id: string }> = []
    try {
      // 谓词只挑 tv：movie 在 SQL 层就滤掉（见上方 movie 论证）。不加 `已有缓存` 的排除条件
      // ——那由 refreshSeriesCatalog 的 TTL 门负责，两处都判会让 TTL 语义分裂成两份。
      // 代价是批量额度会被已刷新的 series 占掉一部分名额，但它们不发任何请求（TTL 门早退），
      // 配额上是零成本，而少一处重复谓词换来的是"刷新节奏只有一个权威"。
      rows = db.prepare(
        `SELECT id FROM works WHERE media_type = 'tv' ORDER BY id LIMIT ${BACKFILL_BATCH_SIZE}`,
      ).all() as Array<{ id: string }>
    } catch { return }   // 无 works 表的旧库：回填是增益，不许阻断启动（同 C21 口径）
    if (rows.length === 0) return

    this.deps.log(`回填: works 应有集缓存开始（本批 ${rows.length} 个剧 / 上限 ${BACKFILL_BATCH_SIZE}，R-F5）`)
    let refreshed = 0, skipped = 0, failed = 0

    // **串行**，与 backfillProviderIds 同一口径（TMDB 配额敏感；且这里每个剧还要按季再打
    // N 次 /tv/{id}/season/{n}，并发打满换来的一次 429 会让整批白跑）。
    for (const r of rows) {
      if (tmdbIdFromOwnId(r.id) === null) {
        // 非 `tmdb:<id>` 形状（历史合成 id，如 'self-scan-trigger'）：打端点保证 404 的白烧。
        skipped++
        continue
      }
      const before = (db.prepare('SELECT MAX(fetched_at) ts FROM tmdb_seasons WHERE series_id = ?')
        .get(r.id) as { ts: number | null }).ts
      try {
        await refreshSeriesCatalog(db, tmdb, r.id, this.deps.now?.() ?? Date.now())
      } catch (e) {
        // refreshSeriesCatalog 内部已把 TMDB 故障吞成"原样返回、旧缓存不动"，能漏到这里的
        // 只有库级异常。仍然隔离：一个剧的失败没有理由让后面 199 个剧不回填。
        failed++
        this.deps.log(`回填: 应有集失败（隔离，留空待下轮）: ${r.id}: ${String(e)}`)
        continue
      }
      // 🔴 计数口径必须与日志逐字对应（本仓刚栽过三次"日志把中间量说成结论量"）：
      // refreshSeriesCatalog 是 void 返回，"没抛异常"**不等于**"刷新成功"——TTL 门早退、
      // gain-path 降级（TMDB 429/某季拿不到）两条路径都是静默 return。若把循环次数记成
      // refreshed，日志会报 `refreshed=200` 而实际一个剧都没抓到。故这里改读 fetched_at
      // 是否真的推进了，只有真写进库的才计入 refreshed，其余归 skipped。
      const after = (db.prepare('SELECT MAX(fetched_at) ts FROM tmdb_seasons WHERE series_id = ?')
        .get(r.id) as { ts: number | null }).ts
      if (after !== null && after !== before) refreshed++
      else skipped++
    }
    // refreshed=本轮真的写进 tmdb_seasons 的剧数；skipped=TTL 门内/降级/非自有 id（三者都
    // 没写库，但性质不同，故不与 failed 合并）；failed=库级异常。
    this.deps.log(`回填: works 应有集 refreshed=${refreshed} skipped=${skipped} failed=${failed}（R-F5）`)
  }

  /** 出现在任何一对嵌套关系里的守备目录（内层外层都算）——D20 的跳过名单。
   *
   *  判据取 media_roots **表**（复用 settingsRepo.detectNestedRoots 这一份既有实现，不重写
   *  第二份），而不是 deps.roots——两者会漂移：deps.roots 是**启动快照**（见 DaemonV2Deps.roots
   *  的注释），运行期用户在 dashboard 里加根不会反映到进程内那份数组里。
   *
   *  漂移方向决定了为什么防线 3 必须独立存在：表里已成嵌套但 deps.roots 还没看见时，防线 2
   *  会照实跳过（安全）；反之 deps.roots 里有嵌套而表里还没落库时，防线 2 静默失效——此时
   *  唯一顶住的就是 deleteMissing 里的"排除更深根前缀"（D21）。两条防线保护的对象也不同：
   *  防线 3 救的是**内层根**名下的行（被外层的差集吃掉），防线 2 额外救的是**外层根**名下
   *  那些确实没扫到的行——那些行前缀上就归外层管，防线 3 帮不上，只能整根不删。
   *
   *  表读不到（旧库无 media_roots / 测试用裸库）时返回空集：宁可让防线 3 单独顶，也不能因为
   *  读表抛错就让整轮扫描挂掉。 */
  private nestedRootSet(): Set<string> {
    const out = new Set<string>()
    try {
      for (const pair of new SettingsRepo(this.deps.db).detectNestedRoots()) {
        out.add(pair.root)     // 外层
        out.add(pair.nested)   // 内层——两边都算，内层的行会被外层的差集吃掉，外层自己也不可信
      }
    } catch { /* 无表/读失败：交给防线 3，不阻断扫描 */ }
    return out
  }

  /** "库中归 root 管的行"这个作用域谓词。D21 的全部要害都在这里，故只此一份。
   *
   *  从 deleteMissing 里抽出来是 C47 的刚性需求：比例守卫的**分母**必须与删除的**作用域**
   *  逐字同源。分母若比删除域宽（比如漏掉 deeperPrefixes 那一档），嵌套配置下内层根的行
   *  会被算进外层的分母，比例被稀释到守卫永远触发不了——而嵌套正是 C29 那次删库的形态，
   *  守卫在最需要它的配置下失效。反过来若窄了则会凭空误拦。两个口径同源才不会漂移。
   *
   *  谓词本身的论证（原样保留在 deleteMissing 的文档注释里）：substr 定长比较而非 LIKE，
   *  root 后补 '/'，并排除所有更深的守备目录前缀（D21 '/' 防护）。 */
  private rootScopeQuery(root: string, roots: string[]): { sql: string; args: string[] } {
    const prefix = root.endsWith('/') ? root : `${root}/`
    const deeperPrefixes = roots
      .filter((r) => r !== root)
      .map((r) => (r.endsWith('/') ? r : `${r}/`))
      .filter((p) => p !== prefix && p.startsWith(prefix))
    return {
      sql: `substr(path,1,length(?)) = ?`
        + deeperPrefixes.map(() => ' AND substr(path,1,length(?)) != ?').join(''),
      args: [prefix, prefix, ...deeperPrefixes.flatMap((p) => [p, p])],
    }
  }

  /** C47：库里"归 root 管"的行数——比例守卫的分母。 */
  private countRowsUnderRoot(root: string, roots: string[]): number {
    const { sql, args } = this.rootScopeQuery(root, roots)
    const row = this.deps.db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${sql}`).get(...args) as { n: number }
    return row.n
  }

  /** 差集删除：库中归 root 管的行里，本轮没扫到的那些（R7 直接删，历史不留）。
   *
   *  D1 逐根比对，**不做全局补集**——把所有根扫到的路径并成一个大集合再删补集的话，
   *  "这个根根本没扫到（挂载掉线）"与"这个根扫到了但是空的"不可区分，R8 保护形同虚设。
   *
   *  D21（'/' 防护）："归 root 管的行" = 在 root 前缀下、且**不在任何更深守备目录前缀下**。
   *  若 '/' 是守备目录，裸前缀条件 `substr(path,1,1)='/'` 对每一条绝对路径都为真 → '/' 的
   *  差集覆盖全库，把仍然有效的 /media/tv 名下的行一起清光。removeRoot 侧已在审校 F8 修过
   *  同一漏洞面，但那是"删一个根时的自我限界"、这里是"查库中归这个根管的行"，两条独立代码
   *  路径不会自动继承，故必须独立再修一次。
   *  正常（无嵌套）配置下 deeperPrefixes 为空，退化成纯前缀匹配。
   *
   *  前缀比较用 `substr(path,1,length(?)) = ?` 而不是 LIKE：媒体路径可以合法含 % 和 _
   *  （"100% Pascal-sensei"、"Look_Back"），LIKE 会把这些字面字符当通配符展开 → 兄弟目录
   *  的行被卷进别人的差集误删。substr 定长字面量比较没有这个陷阱（沿用 removeRoot 的论证）。
   *  root 后补 '/' 是避免 "/media/tv" 前缀吃到兄弟目录 "/media/tv2"。 */
  private deleteMissing(root: string, seen: Set<string>, roots: string[]): void {
    const db = this.deps.db
    const { sql: scopeSql, args: scopeArgs } = this.rootScopeQuery(root, roots)

    // 事务包住"读该根名下的行 → 逐条删"（照 removeRoot 的 transaction().immediate() 手法）：
    // 中途崩溃留下半删状态的库，比不删更糟——库不再是任何一个时刻的磁盘快照。
    const tx = db.transaction((): number => {
      const rows = db.prepare(`SELECT path FROM files WHERE ${scopeSql}`).all(...scopeArgs) as { path: string }[]
      const del = db.prepare('DELETE FROM files WHERE path = ?')
      let deleted = 0
      for (const r of rows) {
        if (seen.has(r.path)) continue
        del.run(r.path)
        deleted++
      }
      return deleted
    })
    const deleted = tx.immediate()
    if (deleted > 0) {
      this.deps.log(`scan: 删除磁盘上已消失的文件 ${deleted} 行（R7）: ${root}`)
    }
  }

  /** last_inspect_at 持久化到 meta（M-3：重启读它判 24h，冷启动立即跑）。 */
  private readLastInspectAt(): number {
    try {
      const row = this.deps.db.prepare(`SELECT value FROM meta WHERE key = 'last_inspect_at'`).get() as { value: string } | undefined
      const v = row ? Number(row.value) : 0
      return Number.isFinite(v) ? v : 0
    } catch { return 0 }
  }

  private writeLastInspectAt(now: number): void {
    this.deps.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)
                          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(now))
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); resolve() }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
