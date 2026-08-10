import { dirname, join, relative, basename } from 'node:path'
import { stepCountIs, type LanguageModel } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeRunTracer } from '../core/traceBus.js'
import { languageName } from './languages.js'
import { makeFindSubtitleSkill } from './skills/findSubtitleSkill.js'
import { systemPromptSkillIndex, makeReadDocTool } from './skills/registry.js'
import { IDENTIFY_MEDIA_SKILL } from './skills/identifyMediaSkill.js'
import {
  makeFileResultSetStore, makeSearchSourceTool, makeListCandidatesTool, makeGetCandidateTool,
} from './resultHandles.js'
import {
  makeDownloadCandidateTool, makeInstallSubtitleTool, makeCheckEpisodeCodeSafetyTool,
} from './findSubtitleWorker.tools.js'
import { makeTmdbEvidenceTools } from './tmdbTools.js'
import {
  FindSubtitleBatchReportSchema, type FindSubtitleTask, type FindSubtitleBatchReport,
} from './findSubtitleWorker.schemas.js'
import { allocate, cleanup } from '../files/stagingSandbox.js'
import { isUnderRoots } from '../core/mediaContext.js'
import type { FetchAdapter } from '../adapters/fetchLib.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

export interface FindSubtitleWorkerDeps {
  model: LanguageModel
  adapters: FetchAdapter[]
  cacheRoot: string
  /** 识别架构路 A（2026-07-26）：TMDB 身份证据工具的数据源。提供时 worker 多两个工具
   *  （search_tmdb/get_tmdb_details），skill 多一节 Step 0 识别验证——机械识别给的库身份
   *  （title/providerIds）只是候选猜测，agent 先调 TMDB 佐证（two-evidence bar），猜错了
   *  自己重新识别并在 finalize 报 identity_correction。null/缺席（TMDB 未配置）时工具与
   *  skill 章节整体降级——agent 照旧按机械身份找字幕（旧行为），不新增任何识别动作。 */
  tmdb?: Pick<TmdbClient, 'search' | 'getDetails' | 'getSeasonTable'> | null
  /** Test phase per spec: no production step cap yet — observe actual step counts first.
   *  @default 500 */
  stepCap?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** 管线拆分（2026-07-28 事故裁决：一晚 446 文件全量批，agent 烧 ~450/500 步在识别上——
   *  424 次 write_identified_media 对 7 次 search_source——步数见底后凭空编造 384 条
   *  no_safe_match、242 集被假 unavailable。裁决：识别归识别，找字幕归找字幕，DB 为状态机）。
   *  true = 识别专用 worker：只挂 read_doc/search_tmdb/get_tmdb_details/finalize，字幕工具
   *  （search_source/download_candidate/install_subtitle/…）零挂载——零误触发纪律：模型连
   *  字幕工具名都不许看到。skill 索引只含 identify-media 文档。显式 flag 而非从 adapters
   *  空推导——魔法推导会让"忘了传 adapters"静默变成识别专用 worker。
   *
   *  ⚠️ 第 7 步 C 组（2/2）实测：**这个模式已无落库通道，因此在生产上不可能产出任何持久
   *  效果**。原本的落地通道是 identityDeps 供的 write_identified_media 工具（agent 识别完
   *  自己往 series/episodes/movies 三张旧表写行）——本组已把它连同 agent/identityTools.ts
   *  整体删除，因为它是那三张旧表最后的 INSERT 路径，而它整条上游链在第 2 步切换入口那一刻
   *  就已经不可达了（identityDeps 的唯一生产供应点 cli/unidentifiedFindSubtitle.ts 的
   *  makeUnidentifiedFindSubtitleWorker ← 唯一调用点 cli/index.ts 的 handleWorkerTask
   *  scope==='unidentified' 分支 ← handleWorkerTask 是零调用者孤儿，见该函数头注释）。
   *
   *  为什么保留 identifyOnly 而不一并删：删它会连带拖走 makeUnidentifiedFindSubtitleWorker /
   *  runUnidentifiedFindSubtitleWorkerTask / unidentifiedFindSubtitle.ts 整个文件 + handleWorkerTask
   *  的一个分支——那是"旧 jobs 队列整体退役"这个独立决策的一部分（同 handleWorkerTask 本身
   *  的处置理由），不是本组"删旧表最后写入路径"这一件事能顺手带走的。识别落库在新架构里由
   *  agent/identifyWorker.ts + v2/identifyScheduler.ts 写 works/files 两张新表承担，与本模式无关。 */
  identifyOnly?: boolean
}

/** Glue-layer repair (2026-07-16): a worker run now covers a whole season-level (or
 *  single-movie) range of targets in one shot, not one episode — a legitimate whole-season
 *  harvest run legitimately takes longer than a single-episode run did, so the abort timeout
 *  scales with the target count instead of staying fixed. The lease is not at risk while this
 *  runs long: the daemon renews the inflight job's lease every tick, so a genuinely long batch
 *  run does not get reclaimed out from under it. */
export const BATCH_BASE_TIMEOUT_MS = 300_000
export const PER_TARGET_TIMEOUT_MS = 120_000
export const BATCH_TIMEOUT_CAP_MS = 3_600_000
const timeoutFor = (n: number) =>
  Math.min(BATCH_BASE_TIMEOUT_MS + PER_TARGET_TIMEOUT_MS * Math.max(0, n - 1), BATCH_TIMEOUT_CAP_MS)

/** Assembles one find-subtitle worker run. Every dependency (model, adapters, cacheRoot) is
 *  injected — this function has zero global state, so the caller (orchestrator in phase ⑤,
 *  the manual live-acceptance script in Task 7) can construct it identically in both offline
 *  tests and production. Returns a function that runs exactly one BATCH task (a season-level or
 *  single-movie range of targets) end to end, reporting a per-target outcome bucket for each. */
export function makeFindSubtitleWorker(deps: FindSubtitleWorkerDeps) {
  // identifyOnly 的构造期防线：识别专用 worker 缺识别工具（tmdb 证据面）是自相矛盾的组装
  // ——静默降级会复刻"模型空谈我会识别"的旧病，这里直接拒绝构造（同 task 目标越沙盒的
  // fail-before-model 纪律）。
  // 第 7 步 C 组（2/2）：判据原为 `!deps.tmdb || !deps.identityDeps`——identityDeps 那一臂
  // 随 write_identified_media 工具（agent/identityTools.ts，三张旧表最后的 INSERT 路径）
  // 一同删除，剩下 tmdb 这一臂。语义收窄是**如实的**，不是放松：落地通道现在恒不存在，
  // 拿它当构造期条件只会让这个（本就不可达的）模式一律构造失败，那是假装的严格。
  if (deps.identifyOnly && !deps.tmdb) {
    throw new Error(
      'identifyOnly worker requires tmdb (search_tmdb/get_tmdb_details evidence tools) — ' +
        'an identification-only worker without identification tools cannot exist',
    )
  }
  return async function runFindSubtitleTask(task: FindSubtitleTask): Promise<FindSubtitleBatchReport> {
    // Sandbox layer 1 (code): verified BEFORE any tool exists or any model call happens — a
    // misconfigured task never even gets to try. Per-target (Task 6 / batch): every target in
    // this task's list has its own directory, and EVERY one of them must sit under this task's
    // mediaRoot — one escaping target fails the whole task, not just that target.
    for (const t of task.targets) {
      if (!isUnderRoots(dirname(t.videoPath), [task.mediaRoot])) {
        throw new Error(`task target ${t.videoPath} escapes its own sandboxed mediaRoot ${task.mediaRoot}`)
      }
    }

    // H4（2026-07-18 数据安全审计）：staging 沙盒必须挂在配置媒体根一级(task.stagingRoot)才能被
    // gcOrphans 的非递归扫描回收，不是这里收窄的 INNER 沙盒根(task.mediaRoot)——见
    // findSubtitleWorker.schemas.ts 的 FindSubtitleTask.stagingRoot 字段文档。allocate/cleanup 必须
    // 用同一个根，否则 cleanup 会去清一个从未被 allocate 用过的目录，真正的 staging 目录永久泄漏。
    const stagingBase = task.stagingRoot ?? task.mediaRoot
    const stagingDir = allocate(task.jobId, stagingBase)
    const store = makeFileResultSetStore(join(deps.cacheRoot, 'result-sets', task.jobId))
    const stagedFiles = new Map<string, string>()
    // W1（装机记账修复批·跨集内容近似去重闸）：per-run 对白指纹表，与 stagedFiles 同法每 run
    // 新建注入——见 findSubtitleWorker.tools.ts 的 InstallSubtitleDeps.installedFingerprints 头注释。
    const installedFingerprints = new Map<string, string>()
    // A5: the judgment playbook is parameterized by the task's target language (Chinese keeps
    // the canonical Hans/Hant-equivalence wording; other languages get language-neutral text).
    // 路 A（2026-07-26）：第三个参数 identityVerification——tmdb 工具可用时 skill 才教
    // Step 0 识别验证（工具不在时教了也白教，反而引诱模型空谈"我会验证"）。
    const skill = makeFindSubtitleSkill(task.targetLanguage, task.hardsubMode, deps.tmdb != null)
    // progressive disclosure（2026-07-27 拆分）：识别文档独立成篇，只在识别工具真的挂载时
    // 才进 read_doc 索引——工具不在时模型连文档名都看不到（零误触发纪律）。
    // 管线拆分（2026-07-28）：identifyOnly 模式反向应用同一纪律——只有识别文档，找字幕
    // playbook 整篇不进索引（模型连 'find-subtitle-judgment' 这个名字都看不到）。
    const skillDocs = deps.identifyOnly
      ? [IDENTIFY_MEDIA_SKILL]
      : deps.tmdb != null ? [skill, IDENTIFY_MEDIA_SKILL] : [skill]

    // 第 7 步 C 组（2/2）：这里原有 write_identified_media 的整套接线——写库门
    // （writeIdentityCalled 追踪 + finalize 拒收"报了 identified 却没写库"）、
    // resolveTargetPath（模型报 basename、代码解析绝对路径）、以及包一层记调用的
    // trackedIdentityWriteTool。随 agent/identityTools.ts 一同删除：那个工具是 series/
    // episodes/movies 三张旧表最后的 INSERT 路径，而它整条上游链（identityDeps ←
    // makeUnidentifiedFindSubtitleWorker ← handleWorkerTask 的 scope==='unidentified' 分支）
    // 自第 2 步切换生产入口起就不可达。旧表从此只被读（dashboard 海报墙/详情页），不再新增行。

    // 管线拆分（2026-07-28）：identifyOnly 模式下字幕工具整组不建不挂——不是"挂了不让用"，
    // 是模型的工具清单里根本没有这些名字（零误触发纪律，同 tmdb/identityDeps 缺席时的
    // "依赖不在则工具不可见"先例）。
    const subtitleTools = () => ({
      search_source: makeSearchSourceTool({
        adapters: deps.adapters, store, targetLanguage: task.targetLanguage,
        localCandidates: task.localCandidates,
      }),
      list_candidates: makeListCandidatesTool(store),
      get_candidate: makeGetCandidateTool(store),
      download_candidate: makeDownloadCandidateTool({
        adapters: deps.adapters, stagingDir, stagedFiles,
        targetFilenames: task.targets.map(t => t.videoFilename),
        // Post-audit fix (batch②, 2026-07-18): parallel to targetFilenames — lets resolveTarget
        // disambiguate a basename collision (cross-season batch, e.g. "Season 1/01.mkv" and
        // "Season 2/01.mkv") instead of silently picking whichever target comes first.
        targetItemIds: task.targets.map(t => t.itemId),
        targetLanguage: task.targetLanguage, fetchImpl: deps.fetchImpl,
        mediaRoot: task.mediaRoot,
      }),
      install_subtitle: makeInstallSubtitleTool({
        stagedFiles, mediaRoot: task.mediaRoot, installedFingerprints,
        // itemId flows through so a basename collision across targets (see above) can be resolved
        // by itemId instead of defaulting to the first same-named target's outDir.
        targets: task.targets.map(t => ({ videoFilename: t.videoFilename, outDir: dirname(t.videoPath), itemId: t.itemId })),
      }),
      check_episode_code_safety: makeCheckEpisodeCodeSafetyTool(),
    })

    const tools = {
      read_doc: makeReadDocTool(skillDocs),
      // 路 A：身份证据工具——tmdb 配置时才挂上（deps.tmdb 为 null 时整个 spread 为空对象，
      // 模型连工具名都看不到，与 skill 的 identityVerification 分支严格同开同关）。
      ...(deps.tmdb ? makeTmdbEvidenceTools({ tmdb: deps.tmdb }) : {}),
      // 第 7 步 C 组（2/2）：write_identified_media 曾在这里按 identityDeps 在场与否挂载
      // ——随 agent/identityTools.ts 一同删除（见上方 identityWriteTool 接线处的注释）。
      ...(deps.identifyOnly ? {} : subtitleTools()),
    }

    // Sandbox layer 2 (prompt/skill): this instructions string is the ENTIRE system prompt —
    // no other directory name is ever mentioned anywhere in it. Batch (Task 6): the sandbox
    // worldview widens from ONE media item to the target items of this ONE task — it must NOT
    // widen any further than that (still no OTHER task/directory/series is ever nameable).
    // 管线拆分（2026-07-28）：identifyOnly 分支的措辞里没有任何字幕工具名（basename 冲突段
    // 讲的是 download_candidate/install_subtitle 的消歧，识别 worker 用不上也不许看见）。
    const instructions = deps.identifyOnly
      ? [
          'You are the media-identification worker for the target items of exactly ONE batch. You',
          "have no knowledge of any other directory or media item outside this task's targets — do",
          'not ask about or reference one.',
          '',
          'Your ONLY job is identification: establish what each target file actually is, verify it',
          'with evidence, and report it in finalize. You do not handle subtitles in',
          'any way — another pipeline picks up from the database after you.',
          '',
          'Available skill documents (call read_doc(name) to load the full text of one):',
          systemPromptSkillIndex(skillDocs),
        ].join('\n')
      : [
          'You are the find-subtitle worker for the target items of exactly ONE series/scope. You have',
          "no knowledge of any other directory or media item outside this task's targets — do not ask",
          'about or reference one.',
          '',
          // Post-audit fix (batch②, 2026-07-18): a cross-season batch can legitimately contain two
          // targets with the exact same file name (e.g. "Season 1/01.mkv" and "Season 2/01.mkv") — a
          // videoFilename alone can no longer tell download_candidate/install_subtitle which target
          // you mean in that case. Mechanical, not a judgment call: if the target list below shows
          // more than one target with the same file name, pass that target's itemId too.
          "If more than one target below shares the exact same file name, download_candidate and",
          "install_subtitle cannot tell them apart from videoFilename alone — pass that target's itemId",
          '(shown on its line below) as well so the correct one is used.',
          '',
          'Available skill documents (call read_doc(name) to load the full text of one):',
          systemPromptSkillIndex(skillDocs),
        ].join('\n')

    // Presented as FACT (a mechanical pre-cleaning output), not instruction — see
    // FindSubtitleTargetFact's own doc comment. List order is fact-list order, not an
    // execution-order instruction to the model.
    //
    // 🔴 2026-07-26 第九轮 auto research 修复的 plumbing 缺口：此前这里只给 basename
    // （`file: xxx.mkv`），**目录名从未进过 prompt**。而 Step 0 的 skill 明确教"文件名是纯
    // 技术 token 时，标题只在目录名里"——教了一个模型根本拿不到的证据。实测后室 case 里
    // 模型直接写下 "No directory names were provided, so re-identification is impossible"，
    // 诚实地卡死在缺料上（它的判断没错，是喂的事实缺了一块）。
    // 给相对沙盒根的目录段：既补上标题证据，又不泄漏 mediaRoot 以外的路径（沙盒纪律）。
    //
    // Task 12（agent-first 识别主链路）：unidentified scope——targets 全部 itemId=null
    // （parked_paths 的未识别文件，由 cli/unidentifiedFindSubtitle.ts 从 parked_paths 的
    // raw data 建成）。此时整份 prompt 没有任何"猜到的身份"可报（task.title 等都是空值），
    // 改报每个 target 的 raw evidence：结构提示（identifyFromPath 的 season/episode/
    // absoluteEpisode，标注为 hint 不是事实）、时长（durationSec，ffprobe raw 值）、
    // 内嵌字幕语言（embeddedLangs）、目录段——识别动作全归 agent（Step 0 → finalize 的
    // identity 字段），机械层只递证据不递结论。
    const unidentified = task.targets.every((t) => t.itemId === null)
    const targetsBlock = unidentified
      ? task.targets.map((t) => {
          const hints = [
            t.season != null ? `season ${t.season}` : null,
            t.episode != null ? `episode ${t.episode}` : null,
            t.absoluteEpisode != null ? `absolute episode ${t.absoluteEpisode}` : null,
          ].filter((h): h is string => h !== null).join(', ')
          // durationSec 是 ffprobe raw 值（agent 识别证据）；只有它缺席时才退用
          // runtimeMinutes 派生值，两值同源于 parked_paths.duration_sec，绝不并排重复。
          const duration = t.durationSec != null
            ? ` | duration: ${t.durationSec}s`
            : (t.runtimeMinutes != null ? ` | runtime ~${t.runtimeMinutes} min` : '')
          const langs = t.embeddedLangs?.length ? ` | embedded langs: ${t.embeddedLangs.join(', ')}` : ''
          // 目录段相对沙盒根（同 dirBlock 的既有纪律）；文件直躺沙盒根下时省略该段。
          const relDir = relative(task.mediaRoot, t.dirName ?? dirname(t.videoPath))
          const dir = relDir.length > 0 ? ` | dir: ${relDir}` : ''
          // Task 2（[tmdbid-N] 证据通道的呈现面）：路径里的显式 TMDB id——最强起点（可以直接
          // get_tmdb_details，跳过搜索）。措辞必须同时把"可能过期/写错"钉在同一行：这条标签由
          // 上一轮 run 或外部整理工具写下，若只报"STRONGEST hint"而不报它会骗人，等于给模型开
          // 一个绕过 two-evidence bar 的后门（skill 里的完整纪律见 identifyMediaSkill）。
          const tag = t.embeddedTmdbId
            ? ` | path carries [tmdbid-${t.embeddedTmdbId}] (STRONGEST hint — but it may be stale or wrong; verify with get_tmdb_details before claiming it)`
            : ''
          return `- itemId: null (unidentified — identify first, then report it in finalize) | structure hint: ${hints || 'none'}${duration}${langs}${dir}${tag} | file: ${t.videoFilename}`
        }).join('\n')
      : task.targets.map(t => {
          const se = t.season != null ? `S${t.season}E${t.episode}` : '(movie)'
          const abs = t.absoluteEpisode != null ? ` | absolute episode: ${t.absoluteEpisode}` : ''
          const imdb = t.imdbId ? ` | imdb: ${t.imdbId}` : ' | imdb: unknown'
          // 2026-07-18 事故修复（True Detective S02E08）：这是该 target 自己的实际时长事实
          // （FindSubtitleTargetFact.runtimeMinutes），区别于下方 task 级那行的剧级典型 fallback
          // 值——只有取到值才附加这一段，取不到（null/缺席）时整段省略，不虚报一个 unknown。
          const runtime = t.runtimeMinutes != null ? ` | runtime ~${t.runtimeMinutes} min` : ''
          return `- itemId: ${t.itemId} | ${se}${abs}${imdb}${runtime} | file: ${t.videoFilename}`
        }).join('\n')

    // 沙盒根自身的目录名 + 每个 target 相对它的子目录段——两者合起来就是"路径里的目录名"
    // 这份证据（绝大多数布局下标题就写在其中之一）。去重后逐行列出，空段（文件直接躺在
    // 沙盒根下）省略。
    const dirNames = [...new Set(
      task.targets
        .map(t => relative(task.mediaRoot, dirname(t.videoPath)))
        .filter(d => d.length > 0),
    )]
    const dirBlock = [
      `containing directory: ${basename(task.mediaRoot)}`,
      ...(dirNames.length ? [`subdirectories: ${dirNames.join(' | ')}`] : []),
    ].join('\n')

    // Task 12（agent-first 识别主链路）：unidentified scope 的任务级身份块——没有任何
    // "guessed title"可报（整批 target 都是 parked_paths 的未识别文件，机械层只递 raw
    // 证据不递结论），改成明示"无身份、先识别"。tmdb 缺席时（识别证据工具未挂）诚实标注
    // 本 run 做不了识别——同库行分支的 tmdb-conditional 口径，不教模型空谈"我会验证"。
    // 管线拆分（2026-07-28）：identifyOnly 分支——工作流措辞里没有任何字幕动作：识别 →
    // finalize，仅此而已。证据行措辞（embedded subtitle languages）保留：那是识别证据
    // （语言构成暗示产地），不是字幕工具。
    // 第 7 步 C 组（2/2）：两处"then call write_identified_media"措辞随该工具删除一并去掉
    // ——prompt 绝不许提一个本 run 根本没挂载的工具名（模型只会试、失败、把失败写进
    // finalize 的 reason，那正是 identityEval 六轮血案的形状）。
    const identityBlock = deps.identifyOnly
      ? [
          'This task carries NO identity — every target below is an unidentified parked file.',
          'Workflow: identify each target from its raw evidence (directory names, file name,',
          'duration, embedded subtitle languages, structure hints) per the identify-media skill',
          'document. When every target is done',
          '(identified, or honestly could not be identified), call finalize.',
        ]
      : unidentified
      ? [
          'This task carries NO identity — every target below is an unidentified parked file.',
          ...(deps.tmdb
            ? [
                'Identify each target from its raw evidence (directory names, file name, duration,',
                'embedded subtitle languages, structure hints) per the skill document (Step 0): clean',
                'a title, verify against TMDB under the two-evidence bar, and report the identity in',
                'finalize.',
              ]
            : [
                'No identification tools are available in this run — do not guess an identity;',
                'report every target unresolved instead of installing on an unverified one.',
              ]),
        ]
      : [
          // 路 A（2026-07-26 识别架构）：以下身份字段全部来自机械文件名解析——是候选猜测，
          // 不是事实。机械解析在版权规避乱写（招z魂z4）、乱码（H）后丨室）、fansub 括号标签、
          // 中文标题截断上经常误判。tmdb 工具在时 skill 会教 Step 0 识别验证；工具不在
          // （TMDB 未配置）时保持旧语义（按机械身份直接找字幕），但这行标注依然诚实。
          'media identity below is a MECHANICAL GUESS from filename parsing, not verified fact —',
          deps.tmdb
            ? 'verify it first per the skill document (Step 0) before searching.'
            : 'no verification tools are available in this run; proceed on this identity.',
          `guessed title: ${task.title}`,
          `guessed original title: ${task.originalTitle ?? 'unknown'}`,
          `guessed year: ${task.year ?? 'unknown'}`,
          `alternative/native titles: ${task.alternativeTitles.length ? task.alternativeTitles.join(', ') : 'none'}`,
          `overview: ${task.overview ?? 'none'}`,
          // 2026-07-18 事故修复（True Detective S02E08）：措辞明示这是剧级典型值/fallback，不是
          // 单集事实——真正的单集实际时长（有的话）在下方每个 target 行自己的 "runtime ~N min"。
          // 别把这行当单集事实用：加长集/季终集的实际时长可能远高于这个数字。
          `typical episode runtime (series-level fallback, minutes): ${task.runtimeMinutes ?? 'unknown'}`,
          `provider ids: ${JSON.stringify(task.providerIds)}`,
        ]

    const prompt = deps.identifyOnly
      ? [
          'Identify each of the unidentified parked files listed below: establish what each one',
          'actually is per the identify-media skill document,',
          'and call finalize exactly once when all targets are done (identified or honestly not).',
          '',
          ...identityBlock,
          '',
          dirBlock,
          '',
          `targets (${task.targets.length} item(s), unidentified parked files):`,
          targetsBlock,
        ].join('\n')
      : [
          // "a subtitle in X" rather than "a X subtitle": sidesteps the a/an article problem
          // ("a English subtitle") no matter what languageName() returns.
          unidentified
            ? `Find and install subtitles in ${languageName(task.targetLanguage)} for the target items ` +
              'listed below — they are unidentified parked files: identify each one first (Step 0), ' +
              'then search on its established identity.'
            : `Find and install subtitles in ${languageName(task.targetLanguage)} for the target items ` +
              'listed below — they all belong to the same series/scope, so ONE season pack will often ' +
              'cover many of them.',
          'Report per-item outcomes via finalize exactly once (see the skill document).',
          '',
          `target subtitle language: ${languageName(task.targetLanguage)}`,
          ...identityBlock,
          '',
          dirBlock,
          '',
          unidentified
            ? `targets (${task.targets.length} item(s), unidentified parked files):`
            : `targets (${task.targets.length} item(s), current gaps in this scope):`,
          targetsBlock,
        ].join('\n')

    // finalize-tool mode (NOT Output.object): the model reports its FindSubtitleBatchReport by
    // calling the injected `finalize` tool as its terminal step, and readFinalized() returns those
    // captured args. This avoids the response_format:json_object the openai-compatible provider
    // would otherwise inject for Output.object — the poison that makes real mimo-v2.5 emit a ReAct
    // text blob instead of native tool_calls (AI_NoObjectGeneratedError). See reasoningAgent.ts.
    const { agent, readFinalized } = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      // 写库门的教训（identityEval 第四轮）：曾在这里挂 superRefine 拒收"报了 identified 却
      // 没写库"的报告，指望模型在循环内看到错误后补调工具——**错的**。hasToolCall('finalize')
      // 一调就停循环（见 reasoningAgent.ts），schema 校验失败直接抛错，模型根本没有重试机会，
      // 结果把 5 个识别全对的 case 生生炸成失败。约束曾改到 runner 层软记录 + skill 措辞硬门。
      // 第 7 步 C 组（2/2）：软记录那一半随 write_identified_media 工具一同删除（写库门已无
      // 对象可门）；这段教训保留，它约束的是"别把 schema 当模型的教鞭"这条设计纪律本身。
      //
      // 管线拆分（2026-07-28）：identifyOnly 模式沿用同一份 FindSubtitleBatchReportSchema，
      // 不另起 schema——installed 桶在识别专用 run 里天然恒空（没有任何安装工具可产出它），
      // no_safe_match = "无法识别"的逐 target 判决。identity 字段保持 advisory 语义
      // （e2bff84：内层校验失败折叠 null）。
      // 第 7 步 C 组（2/2）：原注释在这里写着"真正的识别结果早已由 write_identified_media 的
      // 逐文件事务持久化，finalize 报告丢了也不丢账"——该工具已删，这句话现在是假的：
      // identifyOnly 模式已无任何落库通道，identity 只存在于 finalize 报告里（而该模式整条
      // 上游链本身不可达，见 FindSubtitleWorkerDeps.identifyOnly 的头注释）。
      schema: FindSubtitleBatchReportSchema,
      // 用户裁决：不设步数上限（100000 等效无限——实际先撞 context）。
      stopWhen: stepCountIs(deps.stepCap ?? 100000),
      reasoning: 'high',
      telemetry: { isEnabled: true },
      // 痕迹通道 C：task.jobId 总是真实的（String(job.id)，见 findSubtitleWorkerTask.ts 的
      // mapper）——无条件接线，runKey 拼法与收官快照读出时（findSubtitleWorkerTask.ts 的
      // recordRun）必须一致，都是 `job-${jobId}`。
      onStepEvent: makeRunTracer(`job-${task.jobId}`),
    })

    try {
      const result = await agent.generate({
        prompt,
        abortSignal: AbortSignal.timeout(deps.timeoutMs ?? timeoutFor(task.targets.length)),
      })
      // Diagnostic only (stderr, not part of the return contract): the live-acceptance
      // checklist (docs/design/2026-07-13-v3-live-acceptance-checklist.md, Step 6) asks a human
      // to record the step count of each real run — this is the only place that number
      // (result.steps.length, per the stepCountIs(500) test-phase ceiling) is ever observable,
      // since runFindSubtitleTask's return type is deliberately just the batch report.
      console.error(`[find-subtitle-worker] job ${task.jobId} finished in ${result.steps.length} step(s)`)
      const report = readFinalized()
      // 第 7 步 C 组（2/2）：这里原有写库门的软记录分支——报了 identified 却没调过
      // write_identified_media 时吼一行"识别没落地"。随该工具一同删除（写库门的追踪变量
      // writeIdentityCalled 已无来源）。
      return report
    } finally {
      // Try-error sandbox cleanup runs even on a thrown error — the staging dir never
      // survives a run, matching stagingSandbox's own "job ends, sandbox is deleted" contract.
      // Must match whatever root allocate() above actually used (stagingBase, not task.mediaRoot).
      cleanup(task.jobId, stagingBase)
    }
  }
}
