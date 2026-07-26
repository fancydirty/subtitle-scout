import { z } from 'zod'
import { nullableTolerant, nullableJsonTolerant, nullableBooleanTolerant, tolerantArray } from './coerce.js'
import type { SubtitleCandidate } from '../core/schemas.js'

/** Batch task/report shapes for the find-subtitle worker (phase ③) — see
 *  docs/design/2026-07-16-glue-layer-repair-and-semantic-audit-design.md, 第一部分第 1/3 条
 *  (glue-layer repair + batch harvest campaign). Superseded here: the old single-episode
 *  `FindSubtitleTask` (videoPath/videoFilename/season/episode/absoluteEpisode at the task's top
 *  level) and the old single-decision `FindSubtitleDecisionSchema`/`FindSubtitleDecision`
 *  (the finalize tool's old inputSchema, one decision per worker run). A worker run now takes a
 *  season-level (or single-movie) range plus the current gap fact-list and reports a batch of
 *  per-target outcomes in one finalize call — see `FindSubtitleTask`/`FindSubtitleBatchReportSchema`
 *  below.
 *
 *  The nullable/array fields use nullableTolerant / tolerantArray (coerce.ts): the real model
 *  string-encodes "no value" as "None"/"null"/"" instead of JSON null, and sometimes omits an
 *  empty bucket's key entirely rather than sending `[]`. Without that tolerance those sentinels
 *  would hard-fail validation of the finalize tool's inputSchema — captured never gets set and
 *  readFinalized() throws, killing the whole run. Collapsing those sentinels to null/[] fixes
 *  that AND keeps the string fields from storing "None".
 *
 *  installedLanguage was a zh-Hans/zh-Hant enum (locked to Chinese) — generalized (A2) to any
 *  non-empty BCP-47-ish string so the worker can install a subtitle in any target language; for
 *  Chinese targets the Hans/Hant refinement is still made by the agent from subtitleInspect's
 *  detectedScript signal, this schema just no longer enforces it. */

/** A gap target's fact row (mechanical pre-cleaning output, presented as fact, not instruction).
 *  itemId lives in own id space (episodes.id/movies.id) — the messenger carries it verbatim, and
 *  harvest ingestion (markCovered/markUnavailable) keys off it. */
export interface FindSubtitleTargetFact {
  itemId: string | null // null = unidentified (agent must identify first)
  videoPath: string
  videoFilename: string
  season: number | null
  episode: number | null
  /** System-computed whole-series absolute episode number (a locating hint, not a proof of
   *  belonging); null for movies or when it couldn't be reliably derived. */
  absoluteEpisode: number | null
  /** 验收修复轮一：从 series/movies.provider_ids 解析出的真 imdb id（或 null）。这个值会被原样
   *  写进 worker prompt 的 targetsBlock，search_source 工具只许用它，禁止 LLM 自行编造。 */
  imdbId: string | null
  /** 2026-07-18 事故修复（True Detective S02E08）：该集/该片的实际时长（分钟）——per-episode
   *  fact，区别于 FindSubtitleTask 顶层的 `runtimeMinutes`（那是 TMDB `episode_run_time[0]`
   *  给出的剧级"典型"单集时长，通常是首集/众数，不代表某一集）。根因事故：True Detective
   *  S02E08 是 ~86 分钟的加长季终，agent 被喂剧级典型 ~58 分钟，把时长正确的候选字幕全部
   *  诚实拒判判无——agent 判断没错，喂的事实错了。mapper（findSubtitleWorkerTask.ts）用
   *  TmdbClient.getSeasonEpisodeRuntimes 逐季取值填充，取不到（tmdb 未配置/季端点失败）
   *  → null，绝不因此让整批任务构造失败。
   *
   *  必须可选（`?:`）——realignExecutor.ts（圣文件，不可动）的 makeRealignRunEpisode 构造
   *  target 字面量时不带这个键，字段必须允许缺席才能保持零改动兼容；缺席等价于 null。 */
  runtimeMinutes?: number | null
  // Raw evidence for agent identification (present when itemId is null)
  dirName?: string | null
  durationSec?: number | null
  embeddedLangs?: string[] | null
}

/** Input to one find-subtitle worker run: a season-level (or single-movie) range + the current
 *  gap fact-list. Glue-layer repair (2026-07-16 incident): the single-episode fields are
 *  abolished — one worker run consumes every completable target in the list. */
export interface FindSubtitleTask {
  jobId: string
  /** This task's INNER sandbox root: the common ancestor directory of every target's path (the
   *  mapper derives it and has already verified it's inside MEDIA_ROOTS). */
  mediaRoot: string
  /** H4（2026-07-18 数据安全审计——gcOrphans 盲区修复）：staging 沙盒该挂在哪个目录，供
   *  files/stagingSandbox.ts 的 allocate/cleanup 使用——必须是配置媒体根一级（deps.mediaRoots 里
   *  包含 mediaRoot 的那一个），不是上面这个收窄的 INNER 沙盒根：gcOrphans 只在每个"配置根"
   *  一级非递归扫描 `<root>/.subtitle-staging/`（见 stagingSandbox.ts allocate 的头注释），
   *  沙盒挂在 mediaRoot 这样的深层目录上，硬杀（SIGKILL/OOM/断电）在 allocate 与 cleanup 之间
   *  发生时就会成为永久泄漏——没有任何清扫路径够得到它。
   *
   *  可选（`?:`）——两个原因都要求它能缺席：① v2/realignExecutor.ts（圣文件，不可改）的
   *  makeRealignRunEpisode 构造 FindSubtitleTask 字面量时不带这个键，字段必须允许缺席才能保持
   *  零改动兼容；② 那条路径恰好不需要它——realign 的 task.mediaRoot 本就是配置根级（见该文件
   *  libRootFromRealignBuildDir 的注释），缺席时 fallback 到 mediaRoot 本身刚好正确。
   *  找不到匹配配置根的场景（mapper 侧 containingRoot 返回 null）也会让这个字段缺席/等于
   *  mediaRoot——安全退化（沙盒目录不受 gcOrphans 保护），不阻塞派发。
   *  实际 fallback 逻辑在消费方（agent/findSubtitleWorker.ts）：`task.stagingRoot ?? task.mediaRoot`。 */
  stagingRoot?: string
  title: string
  originalTitle: string | null
  year: number | null
  alternativeTitles: string[]
  overview: string | null
  runtimeMinutes: number | null
  providerIds: Record<string, string>
  /** BCP-47 primary language code for the subtitle to find, e.g. 'zh'/'en'. Interpolated into the
   *  worker prompt via languageName() (see languages.ts). */
  targetLanguage: string
  /** 救援R5：hardsub_mode 透传给 skill 决定是否教模型用第四桶。派发时新鲜读取（同
   *  targetLanguage 的既有先例——见 cli/index.ts handleWorkerTask find_subtitle 分支）。 */
  hardsubMode: 'off' | 'agent' | 'aggressive'
  /** 重复源 P4：本地候选——该任务目标里有副本条目（partial 覆盖）时，其已覆盖文件的现有字幕
   *  作为零成本候选前置注入 search_source 结果集（provider:'local'）。空数组=本任务没有需要
   *  传播的条目（绝大多数任务）。构造方=mapper（findSubtitleWorkerTask.ts）；search_source
   *  工具（resultHandles.ts）每次调用都把它们 prepend 进真实搜索结果——agent 用同一套
   *  list_candidates/get_candidate/download_candidate/install_subtitle 工具面对待它们，
   *  "同一套归属判断，无特殊心虚状态"（spec §4）。 */
  localCandidates: SubtitleCandidate[]
  /** ≥1. List order is fact-list order (episode ascending), not an execution-order instruction. */
  targets: FindSubtitleTargetFact[]
}

export const FindSubtitleInstalledItemSchema = z.object({
  itemId: z.string().min(1),
  installedPath: z.string().min(1),
  installedLanguage: nullableTolerant(z.string().min(1)),
  candidateProvider: nullableTolerant(z.string()),
  candidateProviderId: nullableTolerant(z.string()),
  reason: z.string().min(1),
})
export const FindSubtitleUnresolvedItemSchema = z.object({
  itemId: z.string().min(1),
  reason: z.string().min(1),
})

/** Batch harvest report (the finalize tool's inputSchema): the worker verifies belonging and
 *  installs episode-by-episode for every target in the list; an unclear single episode is
 *  skipped, not the whole batch. retry_later = transient-failure targets needing a retry (the
 *  rest of this season); no_safe_match = judged absent after genuine exhaustion. North star
 *  invariant unchanged: no confidence score anywhere — decision + plain-language reason. */
export const FindSubtitleBatchReportSchema = z.object({
  installed: tolerantArray(FindSubtitleInstalledItemSchema),
  no_safe_match: tolerantArray(FindSubtitleUnresolvedItemSchema),
  retry_later: tolerantArray(FindSubtitleUnresolvedItemSchema),
  /** 救援R5：hardsub_mode='agent' 时 skill 教模型用这桶——目标已判定"字幕烧录进画面本身，
   *  不需要外挂"。'off'/'aggressive' 模式下 skill 文字不提这个概念，模型不会主动填它，但
   *  schema 层不按模式收紧（tolerantArray 缺省即 []，零填也不炸）——校验只管形状。 */
  hardsub_assumed: tolerantArray(FindSubtitleUnresolvedItemSchema),
  /** 路 A（2026-07-26 识别架构，Step 0 识别验证）：agent 核验发现库身份（机械文件名解析
   *  的猜测）错了、并重新识别出正确条目时，在这里报告正确身份（tmdbId/isTv + 证据化判词）。
   *  整个 task 共享一个身份，故是单值不是桶；缺席/null/"None" = 身份核验通过（或本 run 没
   *  做验证——tmdb 工具缺席时 skill 不教 Step 0，模型不会填它）。identity_correction 出现
   *  时 targets 应全部躺在 no_safe_match（身份没纠正前装的字幕会记到错的库行上，skill 明
   *  确禁止）；runner（findSubtitleWorkerTask.ts）收到后记录待迁行——Phase 1 先只记录
   *  （runs/log），迁行重派是后续切片。
   *  nullableJsonTolerant（不是 nullableTolerant）：真模型对 object 字段会把整个对象序列化
   *  成 JSON 字符串发上来（identityEval 实测四连）——见 coerce.ts 该 helper 的头注释。 */
  identity_correction: nullableJsonTolerant(z.object({
    tmdbId: z.string().min(1),
    isTv: z.boolean(),
    reason: z.string().min(1),
  })),
  /** 路 A 第六轮 auto research 的机制修复（2026-07-26）：给"我核验过了，是对的"一个正当去处。
   *  此前只有 identity_correction 一个字段，skill 三次加码措辞（"leave it absent"/"never
   *  announce a confirmation"/"echoing a CORRECT id is a false alarm"）都没能阻止模型把确认
   *  塞进它——实测两个 case 的 reason 里模型自己写着"No correction needed"却照样填了字段。
   *  这不是措辞问题：一个孤零零的可选字段，模型天然想填满它来交代自己的工作。
   *  加一个显式的确认字段后，两种结论各有归宿，identity_correction 回归"仅纠错"的单一语义
   *  （runner 只认它，这个字段纯做展示/可观测，不驱动任何写操作）。 */
  //  真模型对 boolean 发字符串（"True" —— Python 风格，实测第七轮）：nullableBooleanTolerant
  //  折叠这类编码差异，否则一个字段的形态就能炸掉整份 finalize 报告（见 coerce.ts 该 helper）。
  identity_verified: nullableBooleanTolerant(),
}).superRefine((report, ctx) => {
  // 🔴 自相矛盾的报告一律拒收（2026-07-26 审计 BLIND SPOT 1，实测复现）：agent 报了
  // identity_correction 就意味着它判定"库里这批目标的身份是错的"，此时任何 installed
  // 都是把字幕装到它自己刚宣布错误的身份上——正是 Peacemaker 事故的形状（整季装成同名
  // 芬兰剧）。skill 明文禁止这个组合（"Do NOT install subtitles in this run"），但没有
  // 任何机械约束时模型照样会两个都填：实测跑出过 sub_status='covered' + 一条挂在错 id 上
  // 的 subtitles 行，下一轮 ingest 换身份把该行连带删掉，磁盘上的 .srt 变成孤儿，job 却
  // 已 completeDone，没有任何重试。
  //
  // 在 schema 层拒（而不是只在 runner 层丢弃）是刻意的：finalize 的 inputSchema 校验失败
  // 发生在 agent 循环内部，模型能看到错误并自我纠正（重填一份自洽的报告）；runner 层丢弃
  // 则是事后无声修正，模型学不到东西。runner 侧另有一道防御（见 findSubtitleWorkerTask.ts
  // 的 installed 循环），两道都上。
  if (report.identity_correction && report.installed.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message:
        `contradictory report: identity_correction says the library identity is wrong, ` +
        `but ${report.installed.length} item(s) were reported as installed. When the identity ` +
        `is wrong, install nothing — put every target in no_safe_match instead.`,
      path: ['installed'],
    })
  }
})
export type FindSubtitleBatchReport = z.infer<typeof FindSubtitleBatchReportSchema>
export type FindSubtitleInstalledItem = z.infer<typeof FindSubtitleInstalledItemSchema>
export type FindSubtitleUnresolvedItem = z.infer<typeof FindSubtitleUnresolvedItemSchema>
