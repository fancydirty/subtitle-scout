import { dirname, join } from 'node:path'
import { stepCountIs, type LanguageModel } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeRunTracer } from '../dashboard/traceBus.js'
import { languageName } from './languages.js'
import { makeFindSubtitleSkill } from './skills/findSubtitleSkill.js'
import { systemPromptSkillIndex, makeReadDocTool } from './skills/registry.js'
import {
  makeFileResultSetStore, makeSearchSourceTool, makeListCandidatesTool, makeGetCandidateTool,
} from './resultHandles.js'
import {
  makeDownloadCandidateTool, makeInstallSubtitleTool, makeCheckEpisodeCodeSafetyTool,
} from './findSubtitleWorker.tools.js'
import {
  FindSubtitleBatchReportSchema, type FindSubtitleTask, type FindSubtitleBatchReport,
} from './findSubtitleWorker.schemas.js'
import { allocate, cleanup } from '../files/stagingSandbox.js'
import { isUnderRoots } from '../core/mediaContext.js'
import type { FetchAdapter } from '../cli/fetchLib.js'

export interface FindSubtitleWorkerDeps {
  model: LanguageModel
  adapters: FetchAdapter[]
  cacheRoot: string
  /** Test phase per spec: no production step cap yet — observe actual step counts first.
   *  @default 500 */
  stepCap?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
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
    // A5: the judgment playbook is parameterized by the task's target language (Chinese keeps
    // the canonical Hans/Hant-equivalence wording; other languages get language-neutral text).
    const skill = makeFindSubtitleSkill(task.targetLanguage, task.hardsubMode)

    const tools = {
      read_doc: makeReadDocTool([skill]),
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
        stagedFiles, mediaRoot: task.mediaRoot,
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
    const targetsBlock = task.targets.map(t => {
      const se = t.season != null ? `S${t.season}E${t.episode}` : '(movie)'
      const abs = t.absoluteEpisode != null ? ` | absolute episode: ${t.absoluteEpisode}` : ''
      const imdb = t.imdbId ? ` | imdb: ${t.imdbId}` : ' | imdb: unknown'
      // 2026-07-18 事故修复（True Detective S02E08）：这是该 target 自己的实际时长事实
      // （FindSubtitleTargetFact.runtimeMinutes），区别于下方 task 级那行的剧级典型 fallback
      // 值——只有取到值才附加这一段，取不到（null/缺席）时整段省略，不虚报一个 unknown。
      const runtime = t.runtimeMinutes != null ? ` | runtime ~${t.runtimeMinutes} min` : ''
      return `- itemId: ${t.itemId} | ${se}${abs}${imdb}${runtime} | file: ${t.videoFilename}`
    }).join('\n')

    const prompt = [
      // "a subtitle in X" rather than "a X subtitle": sidesteps the a/an article problem
      // ("a English subtitle") no matter what languageName() returns.
      `Find and install subtitles in ${languageName(task.targetLanguage)} for the target items ` +
      'listed below — they all belong to the same series/scope, so ONE season pack will often ' +
      'cover many of them.',
      'Report per-item outcomes via finalize exactly once (see the skill document).',
      '',
      `target subtitle language: ${languageName(task.targetLanguage)}`,
      `title: ${task.title}`,
      `original title: ${task.originalTitle ?? 'unknown'}`,
      `year: ${task.year ?? 'unknown'}`,
      `alternative/native titles: ${task.alternativeTitles.length ? task.alternativeTitles.join(', ') : 'none'}`,
      `overview: ${task.overview ?? 'none'}`,
      // 2026-07-18 事故修复（True Detective S02E08）：措辞明示这是剧级典型值/fallback，不是
      // 单集事实——真正的单集实际时长（有的话）在下方每个 target 行自己的 "runtime ~N min"。
      // 别把这行当单集事实用：加长集/季终集的实际时长可能远高于这个数字。
      `typical episode runtime (series-level fallback, minutes): ${task.runtimeMinutes ?? 'unknown'}`,
      `provider ids: ${JSON.stringify(task.providerIds)}`,
      '',
      `targets (${task.targets.length} item(s), current gaps in this scope):`,
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
