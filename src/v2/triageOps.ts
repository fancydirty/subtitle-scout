// 甄别页域操作（架构审计 C3：原本住在 dashboard/apiV2 查询模块里，daemon rescue worker 要执行
// 域操作必须穿透接口层——下沉到 v2 域层,apiV2 与 cli 都向下依赖本模块,防两处实现漂移）。
//
// 认领（claimParked/unclaim, 2026-07-28 裁决退役）：曾经允许用户在甄别页输入 TMDB id 写一条
// identify_overrides，识别层视其为权威身份。两条根本缺陷：①零证据指派身份，直接违反系统的
// 两证据红线（agent 识别必须凑齐两路独立证据）；②override 的覆盖单元是 dirname(path) 目录
// 前缀——对 1.mp4 认领一次，该目录未来落进来的每个文件都被投毒成同一身份。正确的用户动作是
// **改文件名**：改名对所有下游工具（不只本项目）都修好识别。identify_overrides 表已随之
// DROP（见 db.ts 尾部迁移）。下方 unexclude 是不同概念，刻意保留：它不指派任何身份，只是把
// 被机械铁案误伤的文件放回识别队列，身份裁决仍由 agent 在证据红线下完成。
import { z } from 'zod'
import type { ScoutDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import type { JobsRepo, WorkerTaskUpsertOutcome } from './jobsRepo.js'

/** unexclude 的回执形状（历史名 ClaimParkedResult——认领退役后随主人改名）。 */
export type UnexcludeResult = { ok: true } | { ok: false; error: string }

/** 救援R4b 翻案：用户在甄别页「Excluded extras」箱认为某个被机械排除的文件其实是真内容。
 *  校验它确实是当前 park reason=excluded-extra 的行 → 写豁免（extras_exemptions）+ 退 park 户口，
 *  让下一轮 ingest 跳过机械铁案、重新走识别流（豁免持久，见 db.ts v14 迁移注释）。校验失败诚实
 *  拒绝（调用方薄，判断集中在这一层可单测）。 */
export function unexclude(db: ScoutDb, input: { path: string }): UnexcludeResult {
  const { path } = input
  if (!path) return { ok: false, error: 'path is required' }

  const lib = new LibraryRepo(db)
  const row = lib.listParkedPaths().find((p) => p.path === path)
  if (!row) return { ok: false, error: 'path is not currently parked' }
  if (row.park_reason !== 'excluded-extra') {
    return { ok: false, error: 'path is not an excluded extra' }
  }

  lib.addExtrasExemption(path, Date.now())
  lib.clearParkedPath(path)
  return { ok: true }
}

export type RedispatchResult =  | { ok: true; outcome: WorkerTaskUpsertOutcome }
  | { ok: false; error: string }

const REDISPATCH_SCHEMA = z.object({
  seriesId: z.string().min(1),
  seasons: z.array(z.number().int().positive()).optional(),
  includeThrottled: z.boolean().optional(),
})

/** POST /api/v2/workflow/redispatch 的域实现：zod 校验后转调 jobs.upsertWorkerTask——与
 *  orchestratorAgent.tools.ts 的 dispatch_find_subtitle_task 工具逐字段同形（同一份身份元组、
 *  同一个 taskType='find_subtitle'），reason 固定标注"manual redispatch from dashboard"以便
 *  在 runs/日志里区分人工重派与 orchestrator 自主派发。回执 WorkerTaskUpsertOutcome 原样返回
 *  ——created/revived/coalesced/blocked_dormant 四态都是事实，不是错误，调用方统一按 200 回应；
 *  只有 zod 校验本身不通过才是 ok:false（对应 400）。
 *
 *  ⚠️ 2026-08-13「jobs 队列泄漏」裁决——**本函数今天写下的行没有任何消费者**：
 *  jobs 队列唯一的认领者 `cli/handleWorkerTask.ts` 自第 7 步起生产零调用点（那里有完整
 *  事实链与删除判据）。此外本端点也**没有活前端调用方**了：唯一的 UI 入口 RerunDialog
 *  已随旧活动页移入 `web/src/_legacy/`。
 *
 *  为什么仍然保留（而不是像 ingestTrigger 的 orchestrate 入队那样一并删掉）：它写的是
 *  `taskType='find_subtitle'`，而那条 runner（`v2/findSubtitleWorkerTask.ts`）真实存在、
 *  被大量用例覆盖，且就在 handleWorkerTask 的路由表里——接回 claim 那天，这些行当天就会
 *  被正常执行。它是**待接线的活**。被删掉的 orchestrate 则相反：全仓没有它的处理分支，
 *  即便队列复活也只会立刻 completeError，那是**不可执行的死行**。两者性质不同，故处置不同。
 *
 *  删除判据与 handleWorkerTask 同进退（见该文件头注释的 (a)/(b) 两条）——这两者要么一起
 *  留，要么一起删，不许只删一半。 */
export function redispatch(
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>, body: unknown, now: number,
): RedispatchResult {
  const parsed = REDISPATCH_SCHEMA.safeParse(body)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid body' }
  }
  const { seriesId, seasons, includeThrottled } = parsed.data
  const outcome = jobs.upsertWorkerTask(
    { seriesId, season: null, movieId: null },
    {
      taskType: 'find_subtitle', seasons: seasons && seasons.length > 0 ? seasons : null,
      reason: 'manual redispatch from dashboard', includeThrottled: !!includeThrottled,
    },
    null, now,
  )
  return { ok: true, outcome }
}
