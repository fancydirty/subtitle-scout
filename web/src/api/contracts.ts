// web/src/api/contracts.ts：**致命 DTO 短名单**——只有这几个接契约校验，其余 60+ 个不接。
//
// ══════════════════════════════════════════════════════════════════════════════
// 为什么不是 69 个（这一条比名单本身更重要）
// ══════════════════════════════════════════════════════════════════════════════
// 给 69 个 DTO 全写声明是几千行样板，维护成本高于收益，而且**大部分 DTO 违约不致命**：
// 少一个 `chineseTitle` 就是卡片上少显示一行副标题，用户损失约等于零。为那种字段
// 把整页打成错误态，是拿"少显示一行"换"整页不可用"——净亏。
//
// 更坏的是它会**制造一类新故障**：声明写得越全，后端每一次无害的字段调整（改名一个
// 前端根本没读的键、去掉一个废弃字段）都会变成一次线上白屏。契约校验的价值来自它
// **只在真出事时说话**；话说得越多，狼来了喊得越勤，最后没人信它。
//
// ══════════════════════════════════════════════════════════════════════════════
// 「致命」的三条判据（满足任意一条才进名单）
// ══════════════════════════════════════════════════════════════════════════════
// ① **违约会崩页**：字段被解引用两层以上（`data.work.title`、`data.providers.subhd.enabled`）。
//    缺中间那一层就是 `Cannot read properties of undefined` + React 卸载整棵树。
//    只被解引用一层的（`item.title`）不算——那顶多渲染出 `undefined`，难看但不致命。
// ② **全局壳依赖**：横幅/守备目录提示这类**跨页常驻**的判决源。它违约的影响不局限在
//    一页，且它恰恰是"系统现在是什么状态"的唯一信源——它撒谎，用户对整个系统的判断
//    全是错的。
// ③ **整页的主数据源**：违约会让整页空白，而**用户分不清"真没数据"还是"接口坏了"**。
//    这是本仓 §4.4「错误态绝不显示空态文案」那条纪律在 API 边界的同一形态：
//    HTTP 200 + 形状不对，在现有代码里会一路走到"空态"分支，说出一句谎话。
//
// ══════════════════════════════════════════════════════════════════════════════
// 名单（6 个端点）与逐条判据
// ══════════════════════════════════════════════════════════════════════════════
//  1. `/api/v2/health`          判据 ①②。`workPermitted` 决定 EngineBanner 说什么，
//                               `roots[]` 决定守备目录提示（媒体库页 + 活动页共用）。
//                               🔴 **静默撒谎的最强样本**：`workPermitted` 缺席 →
//                               `undefined` 是 falsy → `workPermission()` 走进
//                               `setup-incomplete`，横幅告诉用户"去填 key"，而 key
//                               全都在、引擎正在跑。用户会去重填一遍所有凭据。
//                               `roots` 缺席 → `RootHealthNote` 的 `if (!roots)` 静静
//                               返回 null → 挂载掉的守备目录**界面上一个字都不显示**
//                               （这正是 rootHealth.ts 头注释记录的那次审计变异）。
//  2. `/api/v2/mediaLibrary`    判据 ③。媒体库页主数据源。行内四个计数字段缺席 →
//                               `coverageParts` 算出 `undefined > 0` = false → 缺集数
//                               整段不渲染 → 一部缺 12 集的剧在墙上显示得像齐全的。
//  3. `/api/v2/mediaLibrary/:id` 判据 ①③。`detail.data.work.title` 是**两层解引用**，
//                               `work` 缺席直接崩详情页；`seasons` 不是数组 → `.map`
//                               抛 TypeError。
//  4. `/api/v2/activity`        判据 ③。两个队列。`subtitleQueue` 缺席 → `?? []` 兜成
//                               空数组 → 页面说"没有排队"，而其实是接口坏了。
//  5. `/api/v2/notifications`   判据 ③。通知页唯一数据源。不是数组 → `.map` 崩；
//                               `latestAt` 缺席 → `dayOffset(undefined)` = NaN →
//                               分桶全乱、`formatClock` 出 `NaN:NaN`。
//  6. `/api/v2/setup/status`    判据 ①。**上一轮真崩过的那一个**：`providers.subhd.enabled`
//                               三层解引用。这里接上之后，`SettingsTabsPage.readProviders`
//                               那个消费点判定就从"唯一防线"退回成"第二道"（保留，
//                               见下方 §与 readProviders 的关系）。
//
// ══════════════════════════════════════════════════════════════════════════════
// 明确**不进**名单的，及理由（防止下一个人顺手加满）
// ══════════════════════════════════════════════════════════════════════════════
//  · `/api/v2/auth/status`  —— 想接，但**不能**：它是 App 层鉴权门的探测源，
//    `useAuthStatus` 的 catch 把任何失败都判成"连接错误"。契约违例走进那个 catch
//    会让用户看到"连不上服务器"——一句**错误的诊断**（服务器明明回了 200）。
//    在鉴权门有能力区分"网络失败"与"契约违例"之前，接上去是拿一句谎换另一句谎。
//    🟡 如实记为未修问题（见报告 §7）。
//  · `/api/v2/settings`     —— `SettingsDTO` 是 `Record<SettingsKey, string|null>`，
//    键集合随后端 SETTINGS_KEYS 演进，且每个消费点都已按"可能没有这个键"写。
//    声明它等于把一份会漂移的键表复刻到前端。
//  · `/api/v2/runs`、`/parked`、`/triage`、`/workflow/*` 等 —— 判据①②③一条都不占：
//    列表页、单层解引用、违约表现是"少显示一列"。
//  · `/api/v2/fs/list`、各 POST 回执 —— 动作类，失败路径已有各自的 error 态。
//
// ── 与 `SettingsTabsPage.readProviders` 的关系：**两道都留，不删** ─────────────
// 这一层查的是 `providers.subhd.enabled` 存不存在、是不是布尔；`readProviders` 查的是
// 「`data` 在但 `providers` 缺席」这个**语义分档**（`data==null` 是合法缺席，要降级；
// `providers` 缺席是违约，要抛）。后者是消费点才知道的事——契约层不知道 `null` 的
// `data` 意味着"还没加载完"。删掉任何一道都会漏。
import { obj, arr, str, num, bool, nullable, type Shape } from './contract.js'

/** `/api/v2/health`。
 *  ⚠️ **只声明有人读的**：`lastInspectAt` / `nextInspectAt` 在（活动页的巡检行读它们），`currents` 是
 *  per-workbench 三槽（每槽 `ScoutCurrentDTO | null`）——槽里的字段**不展开**，因为消费点
 *  （`useCurrentState`）已经按"每个字段可能是 null"写了，展开只会把 SSE 与 HTTP 两个来源的形状焊死。 */
export const HEALTH_SHAPE: Shape = obj({
  lastInspectAt: nullable(num()),
  nextInspectAt: nullable(num()),
  workPermitted: bool(),
  engineEnabled: bool(),
  setupSatisfied: bool(),
  // roots[].ok 是**三态**（true/false/null，见 rootHealth.ts 的论证）——声明成
  // nullable(bool()) 而不是 bool()，否则合法的"不知道"会被判成违约。
  roots: arr(obj({ path: str(), ok: nullable(bool()) })),
  // 病 A 第 7 例：活动页状态条读它（UnidentifiedNote）。**两个字段都要声明**——
  // `dirCount` 缺席时 `dirCount === 0` 判空会把 undefined 当 0 静默吞掉整条提示；
  // `dirs` 缺席时 `dirs.map` 直接抛。二者都是"后端换版本"下的真实形态。
  unidentified: obj({
    dirCount: num(),
    dirs: arr(obj({ dirName: str(), fileCount: num() })),
  }),
  // 🔴-4。**不声明**：老后端缺这个字段时 `StalledJobsNote` 的 `if (!stalledJobs) return null`
  // 会整段不渲染——那是正确的降级（不知道就不说话，同 RootHealthNote 的既有口径）。
  // 声明它会把一个无害缺席升级成整页拦截，而这一段的违约表现只是"少一行提示"。
})

/** `/api/v2/mediaLibrary` 的**一行**（client 那边包成数组）。
 *  计数字段全在：它们参与 `coverageParts` 的算术，缺一个就会得到未知或错误的覆盖数。 */
export const MEDIA_LIBRARY_ITEM_SHAPE: Shape = obj({
  workId: str(),
  title: str(),
  expectedEpisodeCount: num(),
  onDiskEpisodeCount: num(),
  missingEpisodeCount: num(),
  subtitledEpisodeCount: num(),
  embeddedEpisodeCount: num(),
  originLanguageEpisodeCount: num(),
  readyEpisodeCount: num(),
  uncoveredEpisodeCount: num(),
  // 🔴 2026-08-13。**刻意不声明**：`unplacedFileCount` 缺席时，老后端响应在这里
  // 不会整页被拦，而只会少显示一条附加信息——判据③不占。coverageParts 已按
  // `> 0` 写（undefined > 0 为 false → 整段不渲染），那是正确的降级。
  // 上面的计数字段不同：它们参与算术或直接决定覆盖分子，缺席必须拦截。
})

/** `/api/v2/mediaLibrary/:workId`。
 *  `seasons[].episodes[]` **展开到集**：`EpisodeCell` 对 `fileCount`/`subtitledFileCount`
 *  做减法（`extraUnsubtitledCount`），缺席出 NaN；`episodeState` 拿去查表
 *  （`EPISODE_STATE_LABEL[state]`），缺席 → `undefined` 键 → 标签空白。
 *  ⚠️ `episodeState` 只校验"是字符串"，**不校验八态枚举值**：枚举是后端的判据，
 *  在前端复刻一份必然漂移（types.ts 对 EpisodeState 的头注释点名了这条）。 */
export const MEDIA_LIBRARY_DETAIL_SHAPE: Shape = obj({
  work: obj({ workId: str(), title: str() }),
  seasons: arr(obj({
    season: num(),
    episodes: arr(obj({
      episode: num(),
      onDisk: bool(),
      episodeState: str(),
      fileCount: num(),
      subtitledFileCount: num(),
    })),
  })),
  // 电影恒 null、剧集恒 null 之外的那一格。nullable 的对象——里面的字段在非 null 时必在。
  movie: nullable(obj({ episodeState: str(), fileCount: num(), subtitledFileCount: num() })),
  unplacedFileCount: num(),
})

/** `/api/v2/activity`。两个队列都必在（缺席会被 `?? []` 兜成"没有排队"的谎话）。
 *  `pendingFileCount` 是显示在卡片上的数字，缺席出 `undefined`。
 *  `dueNow` 决定卡片上说"在等"还是"N 小时后重试"——缺席时 `!dueNow` 为 true，
 *  会让**已到点**的项挂上一句"重试中"的假话，故必须声明。 */
const QUEUE_ITEM_SHAPE: Shape = obj({
  workId: str(),
  title: str(),
  pendingFileCount: num(),
  dueNow: bool(),
  // `awaitingRescan` 区分 markInstalled 哨兵与失败退避；缺席会让「核对片库」被说成「等待重试」（同 dueNow 当年那句假话）。
  awaitingRescan: bool(),
  // `retryAfter` 刻意**不声明**：null 是它的常态值（到点的项），而契约层的 nullable(num())
  // 对 `undefined` 与 `null` 的区分在这里没有消费差异——前端读到 null/undefined 都走
  // "不说重试时刻"那一支。声明它只会把一个无害缺席升级成整页拦截。
})
export const ACTIVITY_SHAPE: Shape = obj({
  subtitleQueue: arr(QUEUE_ITEM_SHAPE),
  translateQueue: arr(QUEUE_ITEM_SHAPE),
})

/** `/api/v2/notifications` 的**一行**。
 *  `latestAt` 参与分桶与时刻排版（缺席 → NaN → `NaN:NaN` 与错误的日期分组）；
 *  `episodes` 参与 `formatEpisodes` 的连号折叠（不是数组 → `.length` 崩）；
 *  `season` 是 `number|null`（null=电影，是合法值，不是缺席）。 */
export const FOUND_GROUP_SHAPE: Shape = obj({
  workId: str(),
  title: str(),
  season: nullable(num()),
  episodes: arr(num()),
  latestAt: num(),
  via: str(),
  // 🔴 **不声明** mediaType：老后端（还没有这个字段）返回的行在这里会整页被拦，
  // 而它缺席的表现是 `notifShape` 走 'unknown' 那一支——一句在任何情况下都为真的话。
  // 拿一句真话换整页拦截是坏交易。判据①②③一条都不占。
})

/** `/api/v2/setup/status` 的 `providers` 子树——上一轮崩页的那三层解引用。
 *  ⚠️ 只声明 `subhd`/`zimuku` 两支：那是 `SettingsTabsPage` 真正解引用到 `.enabled`
 *  的两个（badge 与两张 ToggleCard）。另外三支（assrt/opensubtitles/jimaku）走
 *  `ProviderRowDTO` 那条路，与这里无关。 */
export const SETUP_STATUS_SHAPE: Shape = obj({
  providers: obj({
    subhd: obj({ enabled: bool() }),
    zimuku: obj({ enabled: bool(), captchaReady: bool() }),
  }),
})
