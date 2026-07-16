import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import { RunsRepo } from './runsRepo.js'
import { JobsRepo } from './jobsRepo.js'

// G3（痕迹通道 C）：trace_json 是 v12 迁移新增列（见 db.ts MIGRATIONS 最后一条 entry），这里
// 补一份专属 repo 单测——此前 RunsRepo 只被业务层测试间接覆盖，从没有自己的单测文件。
let db: ScoutDb
let runs: RunsRepo
let jobId: number

beforeEach(() => {
  db = openDb(':memory:')
  runs = new RunsRepo(db)
  const jobs = new JobsRepo(db)
  jobs.upsertWorkerTask({ seriesId: 'runsrepo-trace-series', season: null, movieId: null }, { taskType: 'find_subtitle' }, null, 1000)
  jobId = jobs.claimNext(1000)!.id
})

describe('RunsRepo trace_json (痕迹通道 C 收官快照)', () => {
  it('insert 传 traceJson 时原样落列', () => {
    const snapshot = JSON.stringify([{ runKey: `job-${jobId}`, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '{}', tookMs: 1, at: 1 }])
    runs.insert({ jobId, startedAt: 1000, finishedAt: 2000, decision: 'installed', detail: 'ok', journalPath: null, traceJson: snapshot })
    const rows = runs.getByJobId(jobId)
    expect(rows).toHaveLength(1)
    expect(rows[0].trace_json).toBe(snapshot)
  })

  it('insert 不传 traceJson 时落 null（不是 undefined，也不是 "[]" 噪音）', () => {
    runs.insert({ jobId, startedAt: 1000, finishedAt: 2000, decision: 'installed', detail: 'ok', journalPath: null })
    const rows = runs.getByJobId(jobId)
    expect(rows[0].trace_json).toBeNull()
  })

  it('insert 显式传 traceJson: null 时也落 null', () => {
    runs.insert({ jobId, startedAt: 1000, finishedAt: 2000, decision: 'installed', detail: 'ok', journalPath: null, traceJson: null })
    const rows = runs.getByJobId(jobId)
    expect(rows[0].trace_json).toBeNull()
  })
})
