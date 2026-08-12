// web/src/api/typeContract.ts：**编译期**契约——把 `types.ts` 的手抄件与后端源头对拍。
//
// ══════════════════════════════════════════════════════════════════════════════
// 它补的是哪个洞（与 contracts.ts 的分工，别搞混）
// ══════════════════════════════════════════════════════════════════════════════
// `contracts.ts` 是**运行时**校验：拿到真实响应体，检查形状，形状不对就报错而不是渲染
// 空态。它防的是"后端已经变了、线上正在撒谎"。它有两个天生管不到的地方：
//   ① 只覆盖 6 个致命端点（那是刻意的裁决，见 contracts.ts 头注释，本文件不动它）；
//   ② 只在**运行时**说话——后端改了 DTO，前端 tsc 照样绿，CI 全过，部署上线，
//      用户点开页面那一刻才炸。
//
// 本文件补的是 ②：把漂移**提前到 `cd web && npx tsc --noEmit`**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 为什么不直接让 types.ts `import type` 后端类型、彻底删掉手抄件
// ══════════════════════════════════════════════════════════════════════════════
// 实测过，技术上完全可行（`import type` 被 TS 完整擦除，vite 产物字节级不变，见下）。
// 但那样会**丢掉手抄件承载的东西**：types.ts 里那几百行注释不是后端注释的复制，是
// **前端侧的渲染纪律**——「null 必须画成灰的未知，绝不许 `?? true` 兜底」「不许拿
// subtitleQueue.length 当 total」「dot 与 episodeState 共存不互推」。这些话在后端
// 那边没有、也不该有。直接 re-export 后端类型，这些纪律没有宿主。
//
// 而且 re-export 会把关系变成**恒等**：后端加一个前端根本不读的字段，前端类型面就跟着长，
// 每次后端演进都要前端跟一次——这恰好是 contracts.ts 头注释论证过的"话说得越多、狼来了
// 喊得越勤"的同一个病，只是搬到了编译期。
//
// 所以：手抄件留着（它是前端的**读取契约**：我只读这些字段、我这样理解它们），
// 本文件负责断言"后端仍然满足这份读取契约"。
//
// ══════════════════════════════════════════════════════════════════════════════
// 断言方向是**单向**的：Be extends Fe（这是本文件唯一需要论证的选择）
// ══════════════════════════════════════════════════════════════════════════════
// `Satisfies<Be, Fe>` = 「后端产出的东西，能不能当成前端声明的形状用」。据此：
//
//   后端**加**字段          → 仍然 assignable → **不报错**。✅ 正确：前端少显示，无害。
//   后端**删**字段          → 少了前端要读的键 → **报错**。✅ 正确：前端会读到 undefined。
//   后端**改名**字段        → 等价于删 + 加 → **报错**。✅ 正确。
//   后端**改类型**          → 不 assignable → **报错**。✅ 正确：运行时炸。
//   后端**放宽**类型        → 例如 `number` → `number | null`，前端没准备好接 null
//                            → **报错**。✅ 正确：这正是最阴的一类漂移。
//   后端**收窄**类型        → 例如 `string` → `'a' | 'b'` → 仍 assignable → 不报错。
//                            ✅ 正确：前端按更宽的类型写的代码依然安全。
//
// 反方向（`Fe extends Be`，即双向恒等）**刻意不做**——它会把"后端加字段"变成红，
// 也就是把上面第一行那个无害情况变成一次前端返工。四个上述实测见任务报告。
//
// ══════════════════════════════════════════════════════════════════════════════
// 为什么 `import type` 不会把后端代码拖进 bundle（实测，不是假设）
// ══════════════════════════════════════════════════════════════════════════════
// 本文件全部 import 都是 `import type`，TS/esbuild 在转译阶段整句擦除，不产生任何
// `import` 语句。实测：加入本文件前后 `npx vite build` 产物**同名同哈希**
// （index-CoY56xb9.js，487.39 kB），字节级相同。
//
// 另外两条实测（都关系到能不能这么做，别删这段注释）：
//  · **Docker 的 web 构建阶段没有 `../src`**（Dockerfile 阶段 1 只 `COPY web/ ./`）。
//    vite build 在缺失 `../src` 的目录树下**照样成功**、产物同哈希——因为擦除发生在
//    转译期，esbuild 根本不会去解析被擦掉的模块路径。已在临时目录复现验证。
//    ⚠️ 推论：本契约**只在开发机与本地 CI 的 `cd web && npx tsc --noEmit` 里生效**，
//    docker build 不跑 tsc，也不需要跑。这不是缺陷——漂移应当在提交前被抓到，
//    而不是在打镜像时。
//  · 本文件**不是** `.test.ts`：它必须进 tsc 的 include 面（`web/tsconfig.json`
//    include 了 `src`），才能在 `npx tsc --noEmit` 里说话。vitest 不查类型（本仓铁律），
//    写成测试文件就等于什么都不做。
//
// ══════════════════════════════════════════════════════════════════════════════
// 名单：**有后端源头的才对拍**，没有的如实标注（下方 §3）
// ══════════════════════════════════════════════════════════════════════════════
// types.ts 里 68 个导出，其中一部分在后端没有对应的 interface（请求体、前端自造的投影、
// 已随端点删除但仍被 `_legacy/` 引用的遗留）。那些**无源可对**，硬造一个后端类型来对拍
// 就是自欺。它们逐条列在 §3，说清为什么没有源头。

import type * as BeApiV2 from '../../../src/dashboard/apiV2.js'
import type * as BeMediaLibrary from '../../../src/dashboard/mediaLibraryApi.js'
import type * as BeActivity from '../../../src/dashboard/activityApi.js'
import type * as BeSetup from '../../../src/dashboard/setupApi.js'
import type * as BeServer from '../../../src/dashboard/server.js'
import type * as BeVerify from '../../../src/dashboard/subtitleVerifyApi.js'
import type * as BeCompare from '../../../src/dashboard/subtitleCompareApi.js'
import type * as BeTrace from '../../../src/core/traceBus.js'
import type * as BeScout from '../../../src/core/scoutEvents.js'
import type * as BeNotifications from '../../../src/v2/notificationsRepo.js'
import type * as BeSettingsRepo from '../../../src/v2/settingsRepo.js'
import type * as BeLibraryRepo from '../../../src/v2/libraryRepo.js'
import type * as Fe from './types.js'

/** 后端形状能否当前端声明用。true=能。 */
type Satisfies<Be, Fe_> = [Be] extends [Fe_] ? true : false

/**
 * 断言载体。`_T` 被约束成 `true`——`Satisfies` 求值出 `false` 时，
 * tsc 报 `TS2344: Type 'false' does not satisfy the constraint 'true'`，
 * 报错位置就是下面那一行，直接点名是哪个 DTO 漂了。
 *
 * ⚠️ 用 `never` 而不是别的：这些 `type` 别名本身没有任何值语义，
 * 它们存在的唯一目的是逼 tsc 求值那个条件类型。
 */
type Assert<_T extends true> = never

// ── §1. 后端 DTO ←→ 前端手抄件 ────────────────────────────────────────────────

// src/dashboard/apiV2.ts
export type C_RunHistoryDTO = Assert<Satisfies<BeApiV2.RunHistoryDTO, Fe.RunHistoryDTO>>
export type C_ParkedItemDTO = Assert<Satisfies<BeApiV2.ParkedItemDTO, Fe.ParkedItemDTO>>
export type C_WorkflowPendingSeriesDTO = Assert<Satisfies<BeApiV2.WorkflowPendingSeriesDTO, Fe.WorkflowPendingSeriesDTO>>
export type C_WorkflowPendingMovieDTO = Assert<Satisfies<BeApiV2.WorkflowPendingMovieDTO, Fe.WorkflowPendingMovieDTO>>
export type C_WorkflowFreshnessDTO = Assert<Satisfies<BeApiV2.WorkflowFreshnessDTO, Fe.WorkflowFreshnessDTO>>
export type C_WorkflowPendingDTO = Assert<Satisfies<BeApiV2.WorkflowPendingDTO, Fe.WorkflowPendingDTO>>
export type C_DispatchReceiptsDTO = Assert<Satisfies<BeApiV2.DispatchReceiptsDTO, Fe.DispatchReceiptsDTO>>
export type C_WorkflowPassDTO = Assert<Satisfies<BeApiV2.WorkflowPassDTO, Fe.WorkflowPassDTO>>
// 🔴 `WorkflowRunningWorkerDTO` / `WorkflowRecentRunDTO` / `WorkflowHeldJobDTO` /
//    `WorkflowWorkersDTO` **没有对拍**——后端源头已于 2026-08-13 随 jobs 读取面清理
//    （`/api/v2/workflow/workers` 端点与 buildWorkflowWorkers）一并删除。
//    前端 types.ts 里那四个还在，唯一消费方是 `web/src/_legacy/activity/`。
//    它们与 §3 末尾那批 Library* DTO 同类：**没有源头可对拍不是债务，是这批类型已经死了**，
//    随 `_legacy/` 整体删除那天一起走。
//    ⚠️ 这不是我漏写——本契约初版**写过**这四条，是后端删除后它们从"能对拍"变成"无源"。
//    这恰好演示了契约的另一半价值：后端删掉一整族 DTO 时，前端这边会当场编译红，
//    有人必须来看一眼、并做出"跟着删"还是"标注为死类型"的决定，而不是静默漂移。
export type C_RunTraceDTO = Assert<Satisfies<BeApiV2.RunTraceDTO, Fe.RunTraceDTO>>
export type C_TriageDTO = Assert<Satisfies<BeApiV2.TriageDTO, Fe.TriageDTO>>
export type C_DormantTaskDTO = Assert<Satisfies<BeApiV2.DormantTaskDTO, Fe.DormantTaskDTO>>
export type C_DeploySecretDTO = Assert<Satisfies<BeApiV2.DeploySecretDTO, Fe.DeploySecretDTO>>
export type C_DeploySettingsDTO = Assert<Satisfies<BeApiV2.DeploySettingsDTO, Fe.DeploySettingsDTO>>
export type C_SettingsDTO = Assert<Satisfies<BeApiV2.SettingsDTO, Fe.SettingsDTO>>
/** 设置键白名单：前端手写了九个字面量，后端是 `typeof SETTINGS_KEYS[number]`。
 *  这一条**双向**断言（罕见的例外，理由充分）：SettingsDTO 是
 *  `Record<SettingsKey, …>`，后端少一个键时 Record 反而变**窄**，`Be extends Fe`
 *  依然成立——单向断言在这里是瞎的。键集合本身必须逐字相等。 */
export type C_SettingsKey_BeToFe = Assert<Satisfies<BeApiV2.SettingsKey, Fe.SettingsKey>>
export type C_SettingsKey_FeToBe = Assert<Satisfies<Fe.SettingsKey, BeApiV2.SettingsKey>>

// src/dashboard/mediaLibraryApi.ts
export type C_MediaLibraryItemDTO = Assert<Satisfies<BeMediaLibrary.MediaLibraryItemDTO, Fe.MediaLibraryItemDTO>>
export type C_MediaLibraryEpisodeDTO = Assert<Satisfies<BeMediaLibrary.MediaLibraryEpisodeDTO, Fe.MediaLibraryEpisodeDTO>>
export type C_MediaLibrarySeasonDTO = Assert<Satisfies<BeMediaLibrary.MediaLibrarySeasonDTO, Fe.MediaLibrarySeasonDTO>>
export type C_MediaLibraryMovieDTO = Assert<Satisfies<BeMediaLibrary.MediaLibraryMovieDTO, Fe.MediaLibraryMovieDTO>>
export type C_MediaLibraryDetailDTO = Assert<Satisfies<BeMediaLibrary.MediaLibraryDetailDTO, Fe.MediaLibraryDetailDTO>>
/** 后端 `SubtitleDot` ←→ 前端 `MediaSubtitleDot`（名字不同，同一个三态）。 */
export type C_MediaSubtitleDot = Assert<Satisfies<BeMediaLibrary.SubtitleDot, Fe.MediaSubtitleDot>>
/** 八态枚举。**双向**：后端**加**一态时单向断言不会红（新态仍属于旧联合？不——
 *  加一态会让后端联合变宽、`Be extends Fe` 失败，单向已够）。这里补反向是为了另一件事：
 *  前端**多**列一个后端没有的态时，EpisodeMark 会为一个永不出现的态画符号（死分支）。 */
export type C_EpisodeState_BeToFe = Assert<Satisfies<BeMediaLibrary.EpisodeState, Fe.EpisodeState>>
export type C_EpisodeState_FeToBe = Assert<Satisfies<Fe.EpisodeState, BeMediaLibrary.EpisodeState>>

// src/dashboard/activityApi.ts
export type C_ActivityQueueItemDTO = Assert<Satisfies<BeActivity.ActivityQueueItemDTO, Fe.ActivityQueueItemDTO>>
export type C_ActivityDTO = Assert<Satisfies<BeActivity.ActivityDTO, Fe.ActivityDTO>>

// src/dashboard/setupApi.ts
export type C_SetupSecretStateDTO = Assert<Satisfies<BeSetup.SetupSecretStateDTO, Fe.SetupSecretStateDTO>>
export type C_SetupStatusDTO = Assert<Satisfies<BeSetup.SetupStatusDTO, Fe.SetupStatusDTO>>
export type C_SecretTestDTO = Assert<Satisfies<BeSetup.SecretTestDTO, Fe.SecretTestDTO>>
export type C_ProviderRowDTO = Assert<Satisfies<BeSetup.ProviderRowDTO, Fe.ProviderRowDTO>>
export type C_ProvidersDTO = Assert<Satisfies<BeSetup.ProvidersDTO, Fe.ProvidersDTO>>
export type C_ValidateResultDTO = Assert<Satisfies<BeSetup.ValidateResultDTO, Fe.ValidateResultDTO>>
/** 校验目标枚举，**双向**（前端 ProviderRowDTO.id 用它当判别键）。
 *  · BeToFe：后端加一个 provider 而前端不认 → 那一行走进 UI 的 default 分支静默消失。
 *  · FeToBe：前端列一个后端没有的 target → 它永远不会出现在响应里，UI 上那一块恒空。
 *
 *  ✅ 已修（2026-08-13）：`zimuku_vision` 曾是这里唯一的例外，用 `Exclude` 临时排除过。
 *     它是本契约上线第一次跑抓到的真 bug：前端 `ValidateTarget` 有 `zimuku_vision`、
 *     `ZimukuVisionCard.tsx` 拿它去 `providers.find()`，而后端从来没有过这个 id，
 *     于是 find 恒 undefined → 卡片恒显示"未配置"，哪怕三个 ZIMUKU_VISION_* 都配好了。
 *
 *     修法不是给后端补一个 `zimuku_vision` provider——视觉兜底**不是字幕源**，
 *     它是 zimuku 验证码破解的可选配置（buildAdapters.ts:58-74），没有自己的 validate
 *     探针（卡片的"测试"按钮走独立的 POST /api/v2/test-vision），也不该在 n/8 里占一格。
 *     所以那三个密钥挂到了**既有的 zimuku 行**下（后端 PROVIDER_SECRETS.zimuku），
 *     前端改读 `p.id === 'zimuku'`，`zimuku_vision` 这个 id 整个消失。
 *
 *     `Exclude` 随之删除——留着它就是在这一格上留个洞：前端再多出任何一个后端没有的
 *     target，现在会当场打红。 */
export type C_ValidateTarget_BeToFe = Assert<Satisfies<BeSetup.ValidateTarget, Fe.ValidateTarget>>
export type C_ValidateTarget_FeToBe = Assert<Satisfies<Fe.ValidateTarget, BeSetup.ValidateTarget>>

// src/dashboard/server.ts（健康端点）
export type C_HealthRootDTO = Assert<Satisfies<BeServer.HealthRootDTO, Fe.HealthRootDTO>>
export type C_HealthDTO = Assert<Satisfies<BeServer.HealthDTO, Fe.HealthDTO>>
/** 后端 HealthDTO.current 的类型是 `ScoutCurrent | null`（core/scoutEvents.ts），
 *  前端手抄成了 `ScoutCurrentDTO | null`。上面那条 C_HealthDTO 已经隐含地对拍了它，
 *  这里单列一条是为了让漂移时的报错**指名道姓**（否则只会说 HealthDTO 不匹配）。 */
export type C_ScoutCurrentDTO = Assert<Satisfies<BeScout.ScoutCurrent, Fe.ScoutCurrentDTO>>

// src/dashboard/subtitleVerifyApi.ts / subtitleCompareApi.ts
export type C_SubtitleVerifyDTO = Assert<Satisfies<BeVerify.SubtitleVerifyDTO, Fe.SubtitleVerifyDTO>>
export type C_SubtitleVerifyListDTO = Assert<Satisfies<BeVerify.SubtitleVerifyListDTO, Fe.SubtitleVerifyListDTO>>
export type C_SubtitleVisualState = Assert<Satisfies<BeVerify.SubtitleVisualState, Fe.SubtitleVisualState>>
export type C_ShiftedItemDTO = Assert<Satisfies<BeVerify.ShiftedItemDTO, Fe.ShiftedItemDTO>>
export type C_SubtitleCompareDTO = Assert<Satisfies<BeCompare.SubtitleCompareDTO, Fe.SubtitleCompareDTO>>
export type C_CompareBlock = Assert<Satisfies<BeCompare.CompareBlock, Fe.CompareBlock>>
export type C_CompareDiagnosis = Assert<Satisfies<BeCompare.CompareDiagnosis, Fe.CompareDiagnosis>>

// src/core/traceBus.ts
export type C_TraceEvent = Assert<Satisfies<BeTrace.TraceEvent, Fe.TraceEvent>>

// src/v2/*（非 dashboard 层，但确实是线上形状的源头）
/** 后端 `FoundGroup` ←→ 前端 `FoundGroupDTO`。 */
export type C_FoundGroupDTO = Assert<Satisfies<BeNotifications.FoundGroup, Fe.FoundGroupDTO>>
/** 🔴 注意方向：后端 `FoundVia` 是**两态**（'fetch' | 'translate'），
 *  组级的第三态 'mixed' 是 `FoundGroup.via` 上的 `FoundVia | 'mixed'`。
 *  前端 `FoundVia` 是**三态**（含 'mixed'），是组级那个的手抄件。
 *  故这里断言的是「后端组级三态 ⊆ 前端三态」，不是拿 BeNotifications.FoundVia 直接对
 *  ——那个对上了反而说明前端漏了 'mixed'。 */
export type C_FoundVia = Assert<Satisfies<BeNotifications.FoundGroup['via'], Fe.FoundVia>>
export type C_MediaRootDTO = Assert<Satisfies<BeSettingsRepo.MediaRoot, Fe.MediaRootDTO>>
export type C_RemoveRootResultDTO = Assert<Satisfies<BeSettingsRepo.RemoveRootResult, Fe.RemoveRootResultDTO>>
export type C_SubStatus = Assert<Satisfies<BeLibraryRepo.SubStatus, Fe.SubStatus>>

// ── §2. 由端点响应体嵌套推出的形状（后端没有独立命名的 interface） ─────────────

/** `MediaLibraryDetailDTO.work` 在后端是**内联对象字面量**，没有独立名字；
 *  前端给它起名 `MediaLibraryWorkDTO`。C_MediaLibraryDetailDTO 已隐含覆盖，
 *  这一条让漂移时的报错指名道姓。 */
export type C_MediaLibraryWorkDTO = Assert<Satisfies<BeMediaLibrary.MediaLibraryDetailDTO['work'], Fe.MediaLibraryWorkDTO>>

// ── §3. **无后端源头**的前端类型（逐条说明为什么不对拍，不是遗漏） ────────────
//
// 下列 types.ts 导出**没有**可对拍的后端 interface。硬造一个来对拍是自欺，故不做。
// 若哪天后端补上了对应的具名类型，把它挪进 §1。
//
//  · `RedispatchInput`            —— **请求体**，后端侧是 zod 的 REDISPATCH_SCHEMA
//                                    （运行时 schema，不是 interface）。方向也相反：
//                                    该断言的是「前端发的能被后端收」。
//                                    zod → TS 的对拍需要 `z.infer`，而 apiV2.ts 没有
//                                    导出这个 schema。**发现但没修**，见报告。
//  · `SettingsPatch`              —— 同上，PUT 请求体。
//  · `RedispatchOutcomeDTO`       —— 后端源头是 src/v2/jobsRepo.ts 的
//                                    `WorkerTaskUpsertOutcome`，但那是**内部**回执类型，
//                                    apiV2 在出网时做了投影（丢掉了内部字段）。
//                                    对内部类型断言会把内部演进变成前端红，是错的耦合。
//  · `AuthStatusDTO` / `AuthSecurityDTO`
//                                 —— server.ts 的 auth 端点**直接 res.json 字面量**，
//                                    没有具名 interface。**发现但没修**，见报告。
//  · `FsListDTO`                  —— `listMediaSubdirs` 的成功分支是内联返回类型，
//                                    且它是个 union（成功 {dirs} / 失败 {error}）。
//  · `PutSecretResultDTO`         —— 同 auth，端点内联字面量。
//  · `WaveformPeaksResponse`      —— 端点内联字面量（波形 peaks）。
//  · `TestVisionRequest` / `TestVisionResponse`
//                                 —— src/dashboard/testVision.ts 里**有**同名导出。
//                                    没进 §1 的原因：TestVisionRequest 后端是
//                                    `z.infer<typeof TestVisionRequestSchema>`，且它是
//                                    **请求体**（方向相反，同 RedispatchInput）。
//                                    Response 侧可以对拍——见报告"发现但没修"。
//  · `SECRET_NAMES` / `SecretName` —— 前端有一份**值**（`as const` 数组，UI 要遍历它渲染
//                                    输入框），后端 src/v2/secrets.ts 也有一份值。
//                                    这是**值**的重复，不是类型的重复，本文件管不到；
//                                    但类型层可以钉住两个联合相等 —— 见下，做了。
//  · `LibraryCanonicalEpisodeDTO` / `LibraryOnDiskEpisodeDTO` / `LibraryCoverageRowDTO`
//    / `LibrarySeasonDTO`         —— 对应端点**已删除**（2026-08-12 无活 UI 端点裁决），
//                                    后端源头已不存在。types.ts 里保留它们是给 `_legacy/`
//                                    用的，随 `_legacy/` 整体删除那天一起走。
//                                    **没有源头可对拍不是债务，是这批类型已经死了。**

/** SecretName 联合**双向**对拍（值的重复对不上，但类型的重复可以钉住）：
 *  前端 SECRET_NAMES 少一个 → Settings 页少一个输入框，用户填不了那个 key；
 *  多一个 → PUT 上去被后端白名单拒。两个方向都是真故障。 */
export type C_SecretName_BeToFe = Assert<Satisfies<BeSetup.ProviderRowDTO['secrets'][number]['name'], Fe.SecretName>>
export type C_SecretName_FeToBe = Assert<Satisfies<Fe.SecretName, BeSetup.ProviderRowDTO['secrets'][number]['name']>>
/** SecretSource 三态。 */
export type C_SecretSource = Assert<Satisfies<BeSetup.SetupSecretStateDTO['source'], Fe.SecretSource>>
