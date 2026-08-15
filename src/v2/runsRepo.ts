import type { ScoutDb } from './db.js'

export interface Run {
  id: number
  job_id: number | null
  started_at: number
  finished_at: number | null
  decision: string | null
  detail: string | null
  journal_path: string | null
  llm_calls: number | null
  assrt_calls: number | null
  trace_json: string | null
}

export class RunsRepo {
  constructor(private db: ScoutDb) {}

  /** 新架构（subtitleScheduler 路径）没有 jobs 表行——job_id 落 NULL。NULL 对 FK 列永远
   * 合法（better-sqlite3 连接的 foreign_keys 默认 ON，见 db.ts openDb 的 pragma 论证——
   * 非空假 id 才会撞 FK）。旧路径（runFindSubtitleWorkerTask，jobs claim-dispatch）仍传数字 id。 */
  insert(params: {
    jobId: number | null
    startedAt: number
    finishedAt: number
    decision: string
    detail: string
    journalPath: string | null
    llmCalls?: number
    assrtCalls?: number
    /** 痕迹通道 C 收官快照：traceBus.snapshot(runKey) 的 JSON.stringify 结果。undefined/空数组
     *  一律落 null（不存 '[]' 噪音，见 findSubtitleWorkerTask.ts/reconcileAll.ts 的调用处）。 */
    traceJson?: string | null
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, llm_calls, assrt_calls, trace_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.jobId,
        params.startedAt,
        params.finishedAt,
        params.decision,
        params.detail,
        params.journalPath ?? null,
        params.llmCalls ?? null,
        params.assrtCalls ?? null,
        params.traceJson ?? null
      )
  }

  getByJobId(jobId: number): Run[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC`)
      .all(jobId) as Run[]
  }

  /** 债务D5：trace 快照修剪——过保留期的 runs 行 trace_json 置 NULL（行本身保留：决策史是
   *  一等事实不删，只丢直播回放的大 JSON）。返回修剪行数。 */
  pruneTraces(beforeMs: number): number {
    return this.db.prepare(
      `UPDATE runs SET trace_json = NULL WHERE finished_at < ? AND trace_json IS NOT NULL`
    ).run(beforeMs).changes
  }
}
