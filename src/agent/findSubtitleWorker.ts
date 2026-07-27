import { dirname, join, relative, basename } from 'node:path'
import { stepCountIs, type LanguageModel } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeRunTracer } from '../core/traceBus.js'
import { languageName } from './languages.js'
import { makeFindSubtitleSkill } from './skills/findSubtitleSkill.js'
import { systemPromptSkillIndex, makeReadDocTool } from './skills/registry.js'
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
import type { TmdbClient, TmdbDetails } from '../adapters/providers/tmdb.js'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import { makeWriteIdentityTool } from './identityTools.js'

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
  /** For write_identified_media tool (agent-first identification, Task 9): when provided, the
   *  worker gets the write_identified_media tool so the agent can persist a TMDB-verified
   *  identity (series/episode or movie row) itself. Shape mirrors WriteIdentityDeps in
   *  identityTools.ts; absent → the tool is not mounted at all (model never sees its name). */
  identityDeps?: {
    lib: LibraryRepo
    tmdb: {
      getDetails: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<TmdbDetails | null>
      getChineseTitles: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string[]>
      getExternalIds: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<{ imdbId: string | null } | null>
      getOriginLanguage: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string | null>
    }
  }
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

    const tools = {
      read_doc: makeReadDocTool([skill]),
      // 路 A：身份证据工具——tmdb 配置时才挂上（deps.tmdb 为 null 时整个 spread 为空对象，
      // 模型连工具名都看不到，与 skill 的 identityVerification 分支严格同开同关）。
      ...(deps.tmdb ? makeTmdbEvidenceTools({ tmdb: deps.tmdb }) : {}),
      // write_identified_media（Task 9，agent-first 识别落地）：identityDeps 提供时才挂上——
      // agent 用 TMDB 证据（two-evidence bar）验证身份后亲自把识别结果写进库；缺席时整个
      // spread 为空对象，与 tmdb 证据工具同一个"依赖不在则工具不可见"的纪律。
      ...(deps.identityDeps ? { write_identified_media: makeWriteIdentityTool(deps.identityDeps) } : {}),
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
    }

    // Sandbox layer 2 (prompt/skill): this instructions string is the ENTIRE system prompt —
    // no other directory name is ever mentioned anywhere in it. Batch (Task 6): the sandbox
    // worldview widens from ONE media item to the target items of this ONE task — it must NOT
    // widen any further than that (still no OTHER task/directory/series is ever nameable).
    const instructions = [
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
      systemPromptSkillIndex([skill]),
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
    // 内嵌字幕语言（embeddedLangs）、目录段——识别动作全归 agent（Step 0 →
    // write_identified_media），机械层只递证据不递结论。
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
          return `- itemId: null (unidentified — identify first, then write_identified_media) | structure hint: ${hints || 'none'}${duration}${langs}${dir} | file: ${t.videoFilename}`
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
    // 证据不递结论），改成明示"无身份、先识别"。tmdb 缺席时（识别工具与
    // write_identified_media 双双未挂）诚实标注本 run 做不了识别——同库行分支的
    // tmdb-conditional 口径，不教模型空谈"我会验证"。
    const identityBlock = unidentified
      ? [
          'This task carries NO identity — every target below is an unidentified parked file.',
          ...(deps.tmdb
            ? [
                'Identify each target from its raw evidence (directory names, file name, duration,',
                'embedded subtitle languages, structure hints) per the skill document (Step 0): clean',
                'a title, verify against TMDB under the two-evidence bar, then call',
                'write_identified_media for the target BEFORE searching for its subtitles.',
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

    const prompt = [
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
      schema: FindSubtitleBatchReportSchema,
      stopWhen: stepCountIs(deps.stepCap ?? 500),
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
      return readFinalized()
    } finally {
      // Try-error sandbox cleanup runs even on a thrown error — the staging dir never
      // survives a run, matching stagingSandbox's own "job ends, sandbox is deleted" contract.
      // Must match whatever root allocate() above actually used (stagingBase, not task.mediaRoot).
      cleanup(task.jobId, stagingBase)
    }
  }
}
