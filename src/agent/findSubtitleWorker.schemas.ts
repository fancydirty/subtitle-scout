import { z } from 'zod'
import { nullableTolerant, nullableJsonTolerantCaught, tolerantArray } from './coerce.js'
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
  /** 路径里的 `[tmdbid-N]` 标签。null = 路径无标签（绝大多数）。
   *  **这是 hint 不是判决**：标签由上一轮 run 或外部整理工具写下，可能过期或错误，
   *  agent 必须 get_tmdb_details 核验通过才能认领——否则等于重开一个绕过
   *  two-evidence bar 的后门。 */
  embeddedTmdbId: string | null
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
  /** 作品单元管线（spec 2026-08-07 §3.4）：这批 target 是"同一个作品目录的完整文件集"
   *  （work-dir），还是"配置根下彼此无关的扁平文件凑的一批"（flat-batch）。前者可以告诉 agent
   *  "当一部作品来识别，一次搜索覆盖全部"，后者绝不能——那批 target 彼此不是同一部作品。
   *
   *  可选（`?:`）——新增可选字段对既有构造点零影响，这是刻意选的最小触碰面：
   *  🔴 绝不能把这个信息加到 `FindSubtitleTargetFact` 上——那个类型被 realignExecutor.ts
   *  （圣文件，不可动）的 makeRealignRunEpisode 复用（见本文件 :50-52 的同款说明）。
   *  缺席 = 未知，消费方按"不做任何单元级断言"的保守措辞处理。 */
  workUnitKind?: 'work-dir' | 'flat-batch'
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

/** 🔴 itemId 可空（2026-07-28，job 34 实测——"向模型索要它按设计拿不到的数据"这个缺陷类的
 *  第三例；前两例记在原 agent/identityTools.ts 的头注释里，该文件已于第 7 步 C 组删除）：
 *  混合批（73 个未识别 parked 文件 + 24 个库行目标）里，弱模型 74 次 write_identified_media
 *  全对、68 次 install_subtitle 全成，finalize 却对部分 installed 项报了 itemId:null——
 *  原 `z.string().min(1)` 拒收，整份报告校验失败，execute 永不运行，152 秒收割成果全灭，
 *  job 落 failed。这不是模型的错：工具层自己就容忍 null itemId（resolveTarget 明文处理
 *  未识别目标的 itemId:null，见 findSubtitleWorker.tools.ts），prompt 的 target 行也明写
 *  `itemId: null`——系统亲手把 null 递给模型，finalize 却拒收它递回来。绝不向模型索要
 *  系统没给它的数据。null 的归属由 runner 层反解：installed 项从 installedPath（字幕装在
 *  视频旁，`<video-stem>.<langTag><ext>` 命名约定）匹配 target 目录 + 视频 stem 前缀，再查
 *  该 videoPath 的库行；unresolved 项无路径可反解，null 一律丢弃告警（park-reason 回写已
 *  按 targetPaths 整批覆盖 unidentified 结局，丢弃不损失任何账目）。 */
export const FindSubtitleInstalledItemSchema = z.object({
  itemId: nullableTolerant(z.string().min(1)),
  installedPath: z.string().min(1),
  installedLanguage: nullableTolerant(z.string().min(1)),
  candidateProvider: nullableTolerant(z.string()),
  candidateProviderId: nullableTolerant(z.string()),
  reason: z.string().min(1),
})
export const FindSubtitleUnresolvedItemSchema = z.object({
  // 同上（第三例）：no_safe_match/retry_later/hardsub_assumed 桶里一个 null itemId 同样会
  // 炸掉整份报告——容忍进来，runner 层丢弃告警（无 installedPath 可反解归属）。
  itemId: nullableTolerant(z.string().min(1)),
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
  /** Agent-first 识别架构（取代路 A 的 identity_correction/identity_verified）：整个 task
   *  共享一个身份，agent 在 finalize 里报告识别结论——identified（带 tmdbId/isTv/season/
   *  episode + 名称与结构双重证据）或 unidentified（带原因）。TV 识别必须给出 season 与
   *  episode；null = 本 run 未做识别（tmdb 工具缺席等）。
   *  语义反转注意：identified 允许 installed（身份已确认，照装不误）；unidentified 要求
   *  installed 为空（身份未定时装的字幕会记到错的库行上）——后者由 runner 层把关。
   *  nullableJsonTolerant：真模型对 object 字段会把整个对象序列化成 JSON 字符串发上来
   *  （identityEval 第一轮实测：15/15 全这么发），先 JSON.parse 回对象再走哨兵/缺席折叠——
   *  见 coerce.ts 该 helper 的头注释。
   *
   *  🔴 升级为 nullableJsonTolerantCaught（2026-07-28，job 34 第二次实测失败）：内层校验
   *  失败（identified+isTv:true+season:null 撞 refine、未知 outcome 字面量等）不再炸掉整份
   *  报告，折叠为 null。排除链：四个桶是 tolerantArray（垃圾项被丢弃）、itemId 等全
   *  nullable-tolerant，identity 的内层 discriminatedUnion 是唯一还能硬炸整份报告的面——
   *  而 43 次 write_identified_media 早已逐文件事务落库，identity 只是 advisory 元数据。
   *  设计错配让这必然发生：identity 建模"一个 task 一个身份"，混合批合法横跨 12 个作品，
   *  单一 identity 对这种批语义上就是胡话。advisory 元数据绝不许炸掉收割入账；null 本就是
   *  两个消费方（cli/unidentifiedFindSubtitle.ts、v2/findSubtitleWorkerTask.ts）处理的合法
   *  状态。折叠无声，runner 层负责在丢失时大声告警。详见 coerce.ts 该 helper 头注释。 */
  identity: nullableJsonTolerantCaught(z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('identified'),
      tmdbId: z.string().regex(/^\d+$/),
      isTv: z.boolean(),
      season: z.number().int().nullable(),
      episode: z.number().int().nullable(),
      nameEvidence: z.string().min(1),
      structureEvidence: z.string().min(1),
    }).refine(
      data => {
        // TV must have season and episode
        if (data.isTv) {
          return data.season !== null && data.episode !== null
        }
        return true
      },
      { message: 'TV identification requires season and episode' }
    ),
    z.object({
      outcome: z.literal('unidentified'),
      reason: z.string().min(1),
      /** 两种失败在物理上不同——`insufficient-evidence`（证据集合为空或不可判，重跑必然
       *  同样结果，**指纹未变则永不重试**，等用户改名）vs `identification-failed`（有证据
       *  但未过 two-evidence bar，可能 TMDB 后来收录/模型这轮不行/网络抖动 → 照常退避）。
       *
       *  🔴 安全默认是 identification-failed：省略键或发了无法识别的值时，宁可多跑一轮，
       *  也不可把一个可自愈的文件永久钉死。偏向"继续尝试"是刻意的不对称。
       *
       *  🔴 容错口径同 identityEval 六轮血案（原记于 agent/identityTools.ts 顶部，该文件已于
       *  第 7 步 C 组删除）：真模型对枚举会发下划线/大写/
       *  省略等变体，schema 太窄会让 agent"想报却报不进来"。preprocess 折叠变体。 */
      kind: z.preprocess(
        (v) => {
          if (typeof v !== 'string') return 'identification-failed'
          const norm = v.trim().toLowerCase().replace(/_/g, '-')
          return norm === 'insufficient-evidence' ? 'insufficient-evidence' : 'identification-failed'
        },
        z.enum(['insufficient-evidence', 'identification-failed']),
      ),
    }),
  ])),
})
export type FindSubtitleBatchReport = z.infer<typeof FindSubtitleBatchReportSchema>
export type FindSubtitleInstalledItem = z.infer<typeof FindSubtitleInstalledItemSchema>
export type FindSubtitleUnresolvedItem = z.infer<typeof FindSubtitleUnresolvedItemSchema>
