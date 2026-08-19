import { basename } from 'node:path'
import { stepCountIs, type LanguageModel } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeRunTracer } from '../core/traceBus.js'
import { translateSkill } from './skills/translateSkill.js'
import { systemPromptSkillIndex, makeReadDocTool } from './skills/registry.js'
import { makeTranslateWorkspaceTools } from './translateWorker.tools.js'
import { TranslateReportSchema, type TranslateReport, type TranslateTask } from './translateWorker.schemas.js'
import { resetWorkspace, cleanupWorkspace } from '../translate/workspace/paths.js'
import type { ResolveSourceDeps } from '../translate/workspace/resolveSource.js'
import type { GlossaryTerm } from '../translate/workspace/types.js'

export interface TranslateWorkerDeps {
  model: LanguageModel
  resolveDeps: ResolveSourceDeps
  /** Install merge-produced SRT as the Chinese sidecar; returns installed path. */
  install: (videoPath: string, srtContent: string) => string
  videoDurationSec?: (videoPath: string) => Promise<number | null>
  /** 目标语言覆盖检查：盘上已有目标语言 sidecar 的路径，或 null（already-covered 短路）。
   *  F2（spec §4.3）：旧名 readExistingChineseSidecar 硬编码中文，目标语言切 en 后对盘上
   *  旧中文 sidecar 误报 already-covered（DxD ep01 实案）——改为 (videoPath, tags)，tags 由
   *  调用方按 task.targetLanguage 组好传入。 */
  readExistingSidecar?: (videoPath: string, tags: string[]) => string | null
  /** P2: 剧级术语持久化(v2/glossaryRepo 的真实现由 CLI/daemon 接线)。 */
  glossaryStore?: {
    load: (seriesKey: string) => GlossaryTerm[]
    save: (seriesKey: string, terms: GlossaryTerm[], updatedAt: number) => void
  }
  fetchTmdbContext?: (task: TranslateTask) => Promise<string | null>
  fetchSeriesTargetSubs?: (task: TranslateTask) => Promise<string | null>
  /** P2.2b critic 适配器(可选;TRANSLATE_CRITIC=off 时缺席)。 */
  critic?: {
    evaluate: (src: string[], tgt: string[], glossary: Array<{ en: string; zh: string }>) => Promise<string>
  }
  /** 步数上限（默认 2000,为 pro reasoning 留足余量;2026-07-24 Oppenheimer 压测）。 */
  stepCap?: number
  /** 超时毫秒（默认 4h,daemon 可注入有限值;Infinity → 无限;压测 pro reasoning 用）。 */
  timeoutMs?: number
}

export type TranslateRunReport = TranslateReport & { llmCalls?: number }

/** Assembles one translate workspace run. The model is the translator: it reads cleaned
 *  documents on the job workspace and writes tgt rows KV-style; final SRT comes only from
 *  the deterministic merge tool. Every dependency is injected — no global state.
 *  The returned report carries llmCalls = agent loop steps (runs 账本口径:尝试边界的模型调用)。 */
export function makeTranslateWorker(deps: TranslateWorkerDeps) {
  return async function runTranslateTask(task: TranslateTask): Promise<TranslateRunReport> {
    const stagingBase = task.stagingRoot ?? task.mediaRoot
    // 开工前清空（jobId 现在是稳定身份 → 同一文件重试复用同一目录 → 上一次的 FROZEN /
    // bilingual 残留会串味甚至永久锁死这一次；完整论证见 workspace/paths.ts resetWorkspace）。
    const paths = resetWorkspace(stagingBase, task.jobId)

    const tools = {
      read_doc: makeReadDocTool([translateSkill]),
      ...makeTranslateWorkspaceTools({
        task,
        paths,
        resolveDeps: deps.resolveDeps,
        install: deps.install,
        videoDurationSec: deps.videoDurationSec,
        readExistingSidecar: deps.readExistingSidecar,
        glossaryStore: deps.glossaryStore,
        fetchTmdbContext: deps.fetchTmdbContext,
        fetchSeriesTargetSubs: deps.fetchSeriesTargetSubs,
        critic: deps.critic,
      }),
    }

    const instructions = [
      'You are the translation clerk for exactly ONE video file. You know nothing about any other',
      'file, directory, or series — do not ask about or reference one.',
      'Your desk is a workspace of documents on disk; read and write ONLY through the provided tools.',
      '',
      'Available skill documents (call read_doc(name) to load the full text of one):',
      systemPromptSkillIndex([translateSkill]),
    ].join('\n')

    const prompt = [
      'Translate this video\'s subtitle into Simplified Chinese following the workspace playbook.',
      'Start with read_doc(translate-workspace), then resolve_source. Report via finalize exactly once.',
      '',
      `title: ${task.title}`,
      `itemId: ${task.itemId}`,
      `origin_lang: ${task.originLang ?? 'unknown'}`,
      `file: ${basename(task.videoPath)}`,
    ].join('\n')

    const tracer = makeRunTracer(`job-${task.jobId}`)
    // 配额账本(复审 Important-2):耗尽/abort 路径 result.steps 不可得,llm 调用数必须走
    // onStepEvent 闭包计数——最烧配额的路径恰恰不能在账本里显示零成本。
    let stepCount = 0
    const { agent, readFinalized } = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      schema: TranslateReportSchema,
      stopWhen: stepCountIs(deps.stepCap ?? 2000),
      reasoning: 'high',
      telemetry: { isEnabled: true },
      onStepEvent: (e) => {
        stepCount++
        tracer(e)
      },
    })

    const timeoutMs = deps.timeoutMs ?? 14_400_000 // 默认 4h(Oppenheimer 压测级);undefined → 无限
    try {
      const result = await agent.generate({
        prompt,
        abortSignal: timeoutMs === Infinity ? undefined : AbortSignal.timeout(timeoutMs),
      })
      console.error(`[translate-worker] job ${task.jobId} finished in ${result.steps.length} step(s)`)
      const report = { ...readFinalized(), llmCalls: result.steps.length }
      // ── Reclaim the translation workspace after the task completes. ──
      //
      // 两侧刻意**不对称**（这是与字幕流唯一的差异，故必须论证而不是照抄 stagingSandbox 的
      // "无论成败都删"）：
      //  · 成功轨（installed / already-covered）→ 删。产物已经 rename 进视频目录，工作台是
      //    纯垃圾。改动前它永久留着：唯一的清扫者 gcOrphans 只在 daemon **boot** 跑一次，
      //    一个长期不重启的 daemon 每翻一集就攒一个 312KB 的隐藏目录在用户的媒体库里。
      //  · 未成功（held / no-source / extract-failed / probe-failed）→ **留现场**。翻译是数分钟
      //    到数小时的付费 LLM，held 的半成品（已译好的几百行 bilingual + 冻结术语表 + critic.md）
      //    是排障与人工救援的唯一材料，删掉就等于"失败了但没人知道模型卡在哪"。
      //
      // 留现场为什么不会堆满磁盘（用户点名要的那条上限）——三道各自独立的收口：
      //  ① jobId 是稳定身份（translateJobId）→ 同一个文件无论重试几次都只占**一个**目录。
      //     旧的 `daemon-${Date.now()}` 才是真的堆积源：每次失败一个新目录，无上限。
      //  ② 失败额度有限（TRANSLATE_HELD_LIMIT=3 → unsolvable），一个文件最多留一份现场。
      //  ③ 跨文件的总量由 gcOrphans 的 boot 回收 + 10 分钟 mtime 活性窗口收口——一个已经
      //     停牌的失败现场在下次 daemon 重启时必然被当孤儿清掉（它既不在 in-flight 集合里，
      //     mtime 也早就陈旧）。这条路径本就是为此存在的，不需要在这里再造第二套超时清理。
      if (report.status === 'installed' || report.status === 'already-covered') {
        const removed = cleanupWorkspace(stagingBase, task.jobId)
        if (!removed) {
          // 必须留痕：静默失败会让"每集残留一个工作台"再次隐形，而那正是本次实测抓到的形态。
          console.error(`[translate-worker] job ${task.jobId} 工作台回收失败（下次 boot GC 兜底）`)
        }
      } else {
        console.error(`[translate-worker] job ${task.jobId} status=${report.status} → 保留工作台现场供排障（稳定 jobId，重试复用同一目录）`)
      }
      return report
    } catch (e) {
      // 模型放弃/步数耗尽/abort 等未 finalize 的情形:诚实 held(fail-closed),绝不让异常
      // 以未捕获形态炸出调用方——与 find-subtitle worker-exhaustion 语义对齐。
      // 工作台**保留**（同上面的未成功轨）：耗尽路径恰恰是最需要看现场的那一种。
      const reason = e instanceof Error ? e.message : String(e)
      console.error(`[translate-worker] job ${task.jobId} ended without a clean finalize: ${reason}`)
      return { status: 'held', reason: `worker exhausted: ${reason.slice(0, 200)}`, sourceRef: null, sidecarPath: null, llmCalls: stepCount }
    }
  }
}
