import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { JobsRepo, type Job } from '../v2/jobsRepo.js'
import { makeIngestTrigger, INGEST_ORCHESTRATE_SERIES_ID, type IngestTriggerDeps } from './ingestTrigger.js'
import type { IngestResult } from '../v2/ingest.js'

function ingestResult(over: Partial<IngestResult> = {}): IngestResult {
  return { scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false, ...over }
}

describe('makeIngestTrigger (去 Jellyfin 化 T4：selfScanTrigger 两信号 refresh-bridge 的替代)', () => {
  let jobs: JobsRepo
  let db: ScoutDb

  beforeEach(() => {
    db = openDb(':memory:')
    jobs = new JobsRepo(db)
  })

  // 清算波 R-6（A-F8）：jobsRepo.listByState 已随死器官处决（production 零调用点）——直接换成
  // 对同一个 db 连接的原生 SQL 查询，语义逐字不变。
  function pendingOrchestrateJobs(): Job[] {
    return (db.prepare(`SELECT * FROM jobs WHERE state = 'wanted'`).all() as Job[])
      .filter(j => j.kind === 'worker_task' && j.series_id === INGEST_ORCHESTRATE_SERIES_ID)
  }

  function makeDeps(over: Partial<IngestTriggerDeps> = {}): IngestTriggerDeps {
    return {
      ingest: vi.fn(async () => ingestResult()),
      log: () => {},
      ...over,
    }
  }

  it('always calls ingest() exactly once and surfaces its result verbatim', async () => {
    const result = ingestResult({ scanned: 5, upserted: 2, parked: 1, removed: 0, changed: true })
    const ingest = vi.fn(async () => result)
    const tick = makeIngestTrigger(makeDeps({ ingest }))

    const out = await tick()

    expect(ingest).toHaveBeenCalledTimes(1)
    expect(out.ingest).toEqual(result)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // 2026-08-13「jobs 队列泄漏」裁决的回归锁
  // ═══════════════════════════════════════════════════════════════════════════
  // 本组三条原本断言的是**相反**的事（changed=true 就该入队一行 orchestrate、二次触发
  // 复用同一行、done 行复活）。那些断言今天全部作废：orchestrate 行全仓无处理分支，
  // 连死认领者 handleWorkerTask 的路由表里都没有（它会掉进 else 走 completeError），
  // 写下去只会永久搁浅。生产库实测已搁浅一行 4.66 天。
  //
  // ⚠️ 判据必须可证伪，不能是恒真命题：
  //   · 只断言"jobs 表为空"不够——ingest 若整个没跑（比如有人把 tick 改成 no-op），
  //     它也恒绿。所以每条都**先断言 ingest 真的跑了且报了 changed=true**，
  //     再断言"在这个本该入队的时刻，表里依然一行都没有"。
  //   · 不用 spy 断言"upsertWorkerTask 没被调用"——那只锁住这一条调用路径；
  //     直接查表锁住的是**结果**（任何绕道写进去的行都会被抓到）。
  it('changed=true（本该入队的那一刻）→ jobs 表一行都没多出来：orchestrate 入队已删除', async () => {
    const ingest = vi.fn(async () => ingestResult({ scanned: 3, upserted: 1, removed: 0, changed: true }))
    const tick = makeIngestTrigger(makeDeps({ ingest }))

    const out = await tick()

    // ① 先证明这一拍真的发生了、且确实是"有变化"那一拍——否则下面两条会因为
    //    "根本没跑"而假绿。
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(out.ingest.changed).toBe(true)
    // ② 这一刻旧实现会写一行 orchestrate。今天：零行。
    expect(pendingOrchestrateJobs().length).toBe(0)
    // ③ 更强：整张 jobs 表一行都没有（不只是"没有 ingest-trigger 身份的行"——
    //    换个 seriesId 绕道写进去同样算泄漏）。
    expect((db.prepare(`SELECT COUNT(*) AS c FROM jobs`).get() as { c: number }).c).toBe(0)
  })

  it('连续多拍 changed=true → jobs 表始终为空（泄漏不是"至多一行"，是零行）', async () => {
    let calls = 0
    const ingest = vi.fn(async () => {
      calls++
      return ingestResult({ upserted: calls, changed: true })
    })
    const tick = makeIngestTrigger(makeDeps({ ingest }))

    await tick()
    await tick()
    await tick()

    // 三拍都真的跑了（否则"表为空"恒真）
    expect(ingest).toHaveBeenCalledTimes(3)
    expect((db.prepare(`SELECT COUNT(*) AS c FROM jobs`).get() as { c: number }).c).toBe(0)
    // jobs repo 在本用例里被构造但从未被本模块写过——固定 identity 去重曾是"至多一行"
    // 的唯一防线，删掉入队之后它连那一行也不需要了。
    expect(jobs.countByState('wanted')).toBe(0)
  })

  it('结构性判据：全仓没有任何 orchestrate 处理分支——这才是删除入队的理由', async () => {
    // 这条不是行为断言而是**架构断言**，刻意用源码扫描：入队之所以该删，不是"暂时没人
    // 认领"（那会诱人写成"先留着"），而是那行 job 即便被认领也只会立刻 completeError。
    // 谁哪天真的实现了 orchestrator，这条会红，提醒他"入队那一半也要一起加回来"。
    //
    // ⚠️ 必须剥掉注释再扫。第一版没剥，结果被 ingestTrigger.ts 自己头注释里那句引用
    // （解释"执行方无输出"时写下的同一个字符串）匹配到而变红——那是**假阳性**：
    // 一段解释性散文不是一个处理分支。剥注释后判据锁的才是真正的代码行。
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const srcRoot = fileURLToPath(new URL('..', import.meta.url))

    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p)
      }
    }
    walk(srcRoot)

    /** 去掉块注释与行注释，只留可执行代码。 */
    const codeOf = (f: string) =>
      readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')

    const handlesBranch = (needle: string) => files.filter((f) => codeOf(f).includes(needle))

    // 阳性对照：同一套扫描器**必须**能在活代码里抓到 find_subtitle 的处理分支。
    // 抓不到就说明扫描器根本没工作（或注释剥除把代码也剥没了），此时下面那条
    // "零 orchestrate 分支"的绿毫无意义。
    expect(handlesBranch("taskType === 'find_subtitle'").length,
      '扫描器失效——连 find_subtitle 分支都没抓到').toBeGreaterThan(0)

    expect(handlesBranch("taskType === 'orchestrate'"),
      'orchestrate 处理分支出现了——入队那一半也该一起恢复，见 ingestTrigger.ts 头注释').toEqual([])
  })

  it('log line fires only when changed=true; ingest() throwing propagates (no catch inside the trigger — 调用方 owns fault isolation)', async () => {
    const log = vi.fn()
    const tickSilent = makeIngestTrigger(makeDeps({ ingest: async () => ingestResult({ changed: false }), log }))
    await tickSilent()
    expect(log).not.toHaveBeenCalled()

    const tickLogs = makeIngestTrigger(makeDeps({ ingest: async () => ingestResult({ changed: true }), log }))
    await tickLogs()
    expect(log).toHaveBeenCalledTimes(1)

    const tickThrows = makeIngestTrigger(makeDeps({ ingest: async () => { throw new Error('boom') } }))
    await expect(tickThrows()).rejects.toThrow('boom')
  })
})
