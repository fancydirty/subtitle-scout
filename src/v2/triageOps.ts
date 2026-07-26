// 甄别页域操作（架构审计 C3：原本住在 dashboard/apiV2 查询模块里，daemon rescue worker 要执行
// 域操作必须穿透接口层——下沉到 v2 域层,apiV2 与 cli 都向下依赖本模块,防两处实现漂移）。
import { z } from 'zod'
import { dirname } from 'node:path'
import type { ScoutDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import type { JobsRepo, WorkerTaskUpsertOutcome } from './jobsRepo.js'

export type ClaimParkedResult = { ok: true } | { ok: false; error: string }

/**
 * park 救援页认领：校验后写一条 identify_overrides。覆盖目标是 path 所在的**目录**
 * （dirname(path)，前缀匹配），不是这一个文件本身——同一部剧的其它集通常散在同一目录下，
 * 一次认领顺带救活整目录的兄弟集（LibraryRepo.findOverride 的最长前缀匹配语义）。
 *
 * 注意：这里**不**调用 clearParkedPath——认领只写 override，不代摄取层清 parked_paths 那一行。
 * 下一轮巡检 recognize() 命中这条 override、重新识别成功后，识别层自己调用 clearParkedPath
 * （T3 既有逻辑），parked_paths 这张表的"是否还挂着"由巡检的真实识别结果唯一决定，不由这个
 * 认领端点越权代劳——保持单一数据源。
 *
 * P7 disambiguation 补丁：可选 season 入参——多季剧下裸集号有歧义（见 ingest.ts 的
 * override-ambiguous-numbering 守卫），认领时把季一起给上就能让 recognize() 直接构造出无歧义
 * 的 (season, episode)，绕开那道守卫。省略/传 null = 未指定（原有行为，交给 ingest 层判断单季
 * 剧可以无歧义折算、多季剧则诚实 park）。传了就必须是正整数——不接受 0/负数/小数，那些不是
 * 合法的季号，静默接受只会把一个用户输入错误伪装成"认领成功"。
 */
export function claimParked(
  db: ScoutDb,
  input: { path: string; tmdbId: string; isTv: boolean; season?: number | null }
): ClaimParkedResult {
  const { path, tmdbId, isTv, season } = input
  if (!path) return { ok: false, error: 'path is required' }
  if (!/^\d+$/.test(tmdbId)) return { ok: false, error: 'tmdbId must be a numeric string' }
  if (season !== undefined && season !== null && !(Number.isInteger(season) && season > 0)) {
    return { ok: false, error: 'season must be a positive integer' }
  }

  const lib = new LibraryRepo(db)
  const parked = lib.listParkedPaths().some((p) => p.path === path)
  if (!parked) return { ok: false, error: 'path is not currently parked' }

  lib.addOverride(dirname(path), tmdbId, isTv, Date.now(), season ?? null)
  return { ok: true }
}

/** 救援R4b 翻案：用户在甄别页「Excluded extras」箱认为某个被机械排除的文件其实是真内容。
 *  校验它确实是当前 park reason=excluded-extra 的行 → 写豁免（extras_exemptions）+ 退 park 户口，
 *  让下一轮 ingest 跳过机械铁案、重新走识别流（豁免持久，见 db.ts v14 迁移注释）。校验失败诚实
 *  拒绝（同 claimParked 的分层：调用方薄，判断集中在这一层可单测）。 */
export function unexclude(db: ScoutDb, input: { path: string }): ClaimParkedResult {
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

/** 撤销一条认领（2026-07-26 审计 A-5）：甄别页「已认领」箱的删除扳手。这是 agent 写权限的
 *  唯一逃生阀——路 A 让 find-subtitle agent 也能写 identify_overrides，认错了那条错误身份会
 *  每轮被 ingest 拿去重建行、删掉正确的旧行，此前用户除了手动改库没有任何出路。
 *
 *  刻意不校验 source：人有权撤销任何一条认领，包括自己写的（改主意）和 agent 写的（纠 agent
 *  的错）。addOverride 的不对称规则保护的是"agent 不许静默改人的判断"，不是"人不许动"——
 *  人始终是最终裁量者。撤销后该路径回到纯机械识别，下一轮 ingest 重新走识别流。 */
export function unclaim(db: ScoutDb, input: { pathPrefix: string }): ClaimParkedResult {
  const { pathPrefix } = input
  if (!pathPrefix) return { ok: false, error: 'pathPrefix is required' }
  const lib = new LibraryRepo(db)
  if (!lib.removeOverride(pathPrefix)) {
    return { ok: false, error: 'no claim exists for that path prefix' }
  }
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
 *  只有 zod 校验本身不通过才是 ok:false（对应 400）。 */
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
