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
}

export class RunsRepo {
  constructor(private db: ScoutDb) {}

  insert(params: {
    jobId: number
    startedAt: number
    finishedAt: number
    decision: string
    detail: string
    journalPath: string | null
    llmCalls?: number
    assrtCalls?: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, llm_calls, assrt_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.jobId,
        params.startedAt,
        params.finishedAt,
        params.decision,
        params.detail,
        params.journalPath ?? null,
        params.llmCalls ?? null,
        params.assrtCalls ?? null
      )
  }

  getByJobId(jobId: number): Run[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC`)
      .all(jobId) as Run[]
  }
}
