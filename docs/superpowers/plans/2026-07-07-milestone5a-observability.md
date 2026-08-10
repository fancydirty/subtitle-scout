# Milestone 5a Implementation Plan: 可观测性

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task 1-5 → **sonnet-5 子代理**；Task 6 → controller 实操。

**Goal:** 运行台账 ledger.jsonl + daemon 日志落盘轮转 + `report` 子命令 + 运维卫生，让"昨晚发生了什么"变成一条命令，根因五分钟可查。

**Architecture:** Ledger/FileLogger/retention 为独立零依赖模块；观测点通过注入回调接入（queue 的 onEvent、watcher 的 onRunComplete），核心模块互不感知 ledger；pipeline 仅追加 stats 到返回值（decision.json 不变）。

**Tech Stack:** 既有栈，零新依赖。

**Spec:** `docs/superpowers/specs/2026-07-07-milestone5a-observability-design.md`

**子代理必读事实：** NodeNext ESM（`.js` import）；154 测试全绿不许破坏；zod 透传 `.passthrough()`；watcher 测试注入 fake deps 先例（src/daemon/watcher.test.ts）；PrefetchQueue 注入时钟先例（src/daemon/queue.ts）。

---

## File Structure

```
src/core/ledger.ts          # LedgerEventSchema + Ledger（append/read/坏行统计）
src/core/fileLogger.ts      # makeFileLogger（按天分文件 + 保留清理）
src/core/retention.ts       # pruneOldDirs（journal 目录保留策略）
src/core/journal.ts         # +counts()
src/core/pipeline.ts        # +PipelineResult.stats
src/daemon/queue.ts         # +onEvent 回调
src/daemon/watcher.ts       # +onRunComplete 回调 + 每日 journal 清理节拍
src/cli/report.ts           # report 聚合与格式化（纯函数可测）
src/cli/index.ts            # ledger/fileLogger/report 接线 + env
docker-compose.yml          # logging 上限
```

---

### Task 1: Ledger

**Files:**
- Create: `src/core/ledger.ts`, `src/core/ledger.test.ts`

- [ ] **Step 1: 失败测试** `src/core/ledger.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger, type LedgerEvent } from './ledger.js'

const file = () => join(mkdtempSync(join(tmpdir(), 'led-')), 'ledger.jsonl')

const runEvent: LedgerEvent = {
  ts: 1000, type: 'run', itemId: 'i1', name: 'Movie', source: 'queue',
  decision: 'download', confidence: 0.9, subtitlePath: '/m/x.ass',
  journalPath: '/j/decision.json', llmProfile: { mode: 'forced-tool' },
  durationMs: 1234, llmCalls: 3, assrtCalls: 2,
}

describe('Ledger', () => {
  it('appends and reads back events', () => {
    const l = new Ledger(file())
    l.append(runEvent)
    l.append({ ts: 2000, type: 'queue', event: 'enqueued', itemId: 'i2', name: 'M2' })
    const r = l.read(0)
    expect(r.events.length).toBe(2)
    expect(r.events[0]).toMatchObject({ type: 'run', decision: 'download' })
    expect(r.badLines).toBe(0)
  })
  it('read filters by since timestamp', () => {
    const l = new Ledger(file())
    l.append(runEvent)                                    // ts 1000
    l.append({ ...runEvent, ts: 5000 })
    expect(l.read(2000).events.length).toBe(1)
  })
  it('skips corrupt lines and counts them', () => {
    const f = file()
    const l = new Ledger(f)
    l.append(runEvent)
    appendFileSync(f, '{corrupt json\n')
    appendFileSync(f, '{"ts":1,"type":"nonsense"}\n')     // schema 不认
    l.append({ ...runEvent, ts: 9000 })
    const r = l.read(0)
    expect(r.events.length).toBe(2)
    expect(r.badLines).toBe(2)
  })
  it('read on missing file returns empty', () => {
    const l = new Ledger(join(mkdtempSync(join(tmpdir(), 'led-')), 'nope.jsonl'))
    expect(l.read(0)).toEqual({ events: [], badLines: 0 })
  })
})
```

- [ ] **Step 2: 确认失败。Step 3: 实现** `src/core/ledger.ts`

```ts
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const LedgerRunEventSchema = z.object({
  ts: z.number(),
  type: z.literal('run'),
  itemId: z.string(),
  name: z.string(),
  source: z.enum(['playback', 'queue', 'cli']),
  decision: z.string(),
  confidence: z.number().nullish(),
  subtitlePath: z.string().nullish(),
  journalPath: z.string(),
  llmProfile: z.object({ mode: z.string(), quirkId: z.string().nullish() }).passthrough(),
  durationMs: z.number(),
  llmCalls: z.number(),
  assrtCalls: z.number(),
  error: z.string().nullish(),
})
export const LedgerQueueEventSchema = z.object({
  ts: z.number(),
  type: z.literal('queue'),
  event: z.enum(['enqueued', 'decayed', 'dormant', 'activated', 'removed']),
  itemId: z.string(),
  name: z.string(),
  attempts: z.number().nullish(),
  nextRetryAt: z.number().nullish(),
})
export const LedgerEventSchema = z.discriminatedUnion('type', [LedgerRunEventSchema, LedgerQueueEventSchema])
export type LedgerEvent = z.infer<typeof LedgerEventSchema>

/** 追加式运行台账。journal 是深度，ledger 是时间线。 */
export class Ledger {
  constructor(private file: string) { mkdirSync(dirname(file), { recursive: true }) }

  append(event: LedgerEvent) {
    appendFileSync(this.file, JSON.stringify(event) + '\n')
  }

  read(sinceMs: number): { events: LedgerEvent[]; badLines: number } {
    if (!existsSync(this.file)) return { events: [], badLines: 0 }
    const events: LedgerEvent[] = []
    let badLines = 0
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = LedgerEventSchema.parse(JSON.parse(line))
        if (parsed.ts >= sinceMs) events.push(parsed)
      } catch { badLines++ }
    }
    return { events, badLines }
  }
}
```

- [ ] **Step 4: 全绿。Step 5: commit** `feat: append-only run ledger with tolerant reader`

---

### Task 2: fileLogger + retention

**Files:**
- Create: `src/core/fileLogger.ts`, `src/core/fileLogger.test.ts`, `src/core/retention.ts`, `src/core/retention.test.ts`

- [ ] **Step 1: 失败测试**

`src/core/fileLogger.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFileLogger } from './fileLogger.js'

describe('makeFileLogger', () => {
  it('writes dated files and rolls over at midnight', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flog-'))
    let now = Date.parse('2026-07-07T10:00:00Z')
    const log = makeFileLogger(dir, 30, () => now)
    log('first')
    now = Date.parse('2026-07-08T01:00:00Z')
    log('second')
    const files = readdirSync(dir).sort()
    expect(files.length).toBe(2)
    expect(readFileSync(join(dir, files[0]), 'utf8')).toContain('first')
    expect(readFileSync(join(dir, files[1]), 'utf8')).toContain('second')
  })
  it('prunes files older than retainDays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flog-'))
    writeFileSync(join(dir, 'watch-2026-01-01.log'), 'old')
    let now = Date.parse('2026-07-07T10:00:00Z')
    const log = makeFileLogger(dir, 30, () => now)
    log('trigger cleanup')
    expect(readdirSync(dir).some(f => f.includes('2026-01-01'))).toBe(false)
  })
})
```

`src/core/retention.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneOldDirs } from './retention.js'

describe('pruneOldDirs', () => {
  it('removes directories older than retainDays, keeps fresh ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'ret-'))
    const oldDir = join(root, 'item-100')
    const newDir = join(root, 'item-200')
    mkdirSync(oldDir); writeFileSync(join(oldDir, 'decision.json'), '{}')
    mkdirSync(newDir); writeFileSync(join(newDir, 'decision.json'), '{}')
    const old = new Date(Date.now() - 100 * 86_400_000)
    utimesSync(oldDir, old, old)
    pruneOldDirs(root, 90)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(newDir)).toBe(true)
  })
  it('tolerates missing root', () => {
    expect(() => pruneOldDirs('/nonexistent/nope', 90)).not.toThrow()
  })
})
```

- [ ] **Step 2: 确认失败。Step 3: 实现**

`src/core/fileLogger.ts`：

```ts
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 86_400_000

/** stdout 之外的持久日志：按天分文件，写入时惰性清理过期文件 */
export function makeFileLogger(dir: string, retainDays: number, now: () => number = Date.now): (msg: string) => void {
  mkdirSync(dir, { recursive: true })
  let lastCleanupDay = ''
  return (msg: string) => {
    const day = new Date(now()).toISOString().slice(0, 10)
    try {
      appendFileSync(join(dir, `watch-${day}.log`), `${new Date(now()).toISOString()} ${msg}\n`)
      if (day !== lastCleanupDay) {
        lastCleanupDay = day
        const cutoff = now() - retainDays * DAY_MS
        for (const f of readdirSync(dir)) {
          const m = f.match(/^watch-(\d{4}-\d{2}-\d{2})\.log$/)
          if (m && Date.parse(m[1]) < cutoff) rmSync(join(dir, f), { force: true })
        }
      }
    } catch { /* 日志失败绝不影响主流程 */ }
  }
}
```

`src/core/retention.ts`：

```ts
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 按 mtime 清理过期子目录（journal 保留策略）。失败静默——清理是尽力而为。 */
export function pruneOldDirs(root: string, retainDays: number, now: () => number = Date.now) {
  if (!existsSync(root)) return
  const cutoff = now() - retainDays * 86_400_000
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    try {
      if (statSync(p).isDirectory() && statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: 全绿。Step 5: commit** `feat: daily file logger and journal retention pruning`

---

### Task 3: 观测点（journal counts / pipeline stats / queue onEvent）

**Files:**
- Modify: `src/core/journal.ts`, `src/core/pipeline.ts`, `src/daemon/queue.ts`
- Test: `src/core/pipeline.test.ts`、`src/daemon/queue.test.ts`（追加）

- [ ] **Step 1: 失败测试**

pipeline.test.ts 追加：

```ts
  it('returns stats with duration and call counts', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const result = await runPipeline(makeDeps(), ctx, outDir)
    expect(result.stats.llmCalls).toBe(3)
    expect(result.stats.apiCalls).toBe(0) // fake assrt 不经过 onApiCall
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0)
  })
```

queue.test.ts 追加：

```ts
  it('emits lifecycle events via onEvent', () => {
    const events: unknown[] = []
    let now = 0
    const q = new PrefetchQueue(file(), () => now, e => events.push(e))
    q.upsert('x', 'X')
    q.recordFailure('x')
    for (let i = 0; i < 4; i++) q.recordFailure('x')
    q.activate('x')
    q.remove('x')
    const kinds = (events as { event: string }[]).map(e => e.event)
    expect(kinds).toEqual(['enqueued', 'decayed', 'decayed', 'decayed', 'decayed', 'dormant', 'activated', 'removed'])
  })
```

（注意衰减语义：前 4 次 recordFailure 是 decayed，第 5 次进 dormant——与 M4 修复后的阶梯一致。）

- [ ] **Step 2: 确认失败。Step 3: 实现**

journal.ts 增：

```ts
  counts(): { llmCalls: number; apiCalls: number } {
    return { llmCalls: this.llmCalls.length, apiCalls: this.apiCalls.length }
  }
```

pipeline.ts：`runPipeline` 顶部 `const t0 = Date.now()`；`PipelineResult` 增 `stats: { durationMs: number; llmCalls: number; apiCalls: number }`；`finish` 返回对象增 `stats: { durationMs: Date.now() - t0, ...journal.counts() }`。

queue.ts：构造器第三参 `private onEvent?: (e: { event: 'enqueued'|'decayed'|'dormant'|'activated'|'removed'; itemId: string; name: string; attempts?: number; nextRetryAt?: number }) => void`；各变迁点调用（upsert→enqueued；recordFailure→decayed 或 dormant（含 attempts/nextRetryAt）；activate→activated；remove→removed，name 从条目取，remove 在删除前取）。回调抛错须捕获忽略（观测不影响主流程）。

- [ ] **Step 4: 全绿。Step 5: commit** `feat: pipeline stats and queue lifecycle events`

---

### Task 4: report 子命令

**Files:**
- Create: `src/cli/report.ts`, `src/cli/report.test.ts`
- Modify: `src/cli/index.ts`（接 report 命令）

- [ ] **Step 1: 失败测试** `src/cli/report.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { parseSince, formatReport } from './report.js'
import type { LedgerEvent } from '../core/ledger.js'

describe('parseSince', () => {
  it('parses 24h and 7d relative to now', () => {
    const now = 1_000_000_000_000
    expect(parseSince('24h', now)).toBe(now - 24 * 3600_000)
    expect(parseSince('7d', now)).toBe(now - 7 * 86_400_000)
  })
  it('parses ISO dates', () => {
    expect(parseSince('2026-07-07', 0)).toBe(Date.parse('2026-07-07'))
  })
  it('throws on garbage', () => {
    expect(() => parseSince('yesterday-ish', 0)).toThrow(/since/i)
  })
})

const run = (over: Partial<Extract<LedgerEvent, { type: 'run' }>>): LedgerEvent => ({
  ts: 1000, type: 'run', itemId: 'i', name: 'Movie', source: 'queue',
  decision: 'download', confidence: 0.9, subtitlePath: null,
  journalPath: '/j/d.json', llmProfile: { mode: 'forced-tool' },
  durationMs: 100, llmCalls: 3, assrtCalls: 2, ...over,
})

describe('formatReport', () => {
  it('aggregates decisions, sources, failures, queue events, and consumption', () => {
    const events: LedgerEvent[] = [
      run({ decision: 'download', name: 'A' }),
      run({ decision: 'adopted_local', name: 'B', source: 'playback', llmCalls: 2, assrtCalls: 0 }),
      run({ decision: 'no_safe_match', name: 'C', error: null }),
      run({ decision: 'error', name: 'D', error: 'boom' }),
      { ts: 1, type: 'queue', event: 'enqueued', itemId: 'q1', name: 'E' },
      { ts: 2, type: 'queue', event: 'decayed', itemId: 'q1', name: 'E', attempts: 1 },
    ]
    const out = formatReport(events, 0, { pending: 3, dormant: 1 })
    expect(out).toContain('download: 1')
    expect(out).toContain('adopted_local: 1')
    expect(out).toContain('no_safe_match: 1')
    expect(out).toContain('error: 1')
    expect(out).toContain('C')                    // 失败明细含名字
    expect(out).toContain('/j/d.json')            // journal 指针
    expect(out).toContain('enqueued: 1')
    expect(out).toContain('pending=3')
    expect(out).toContain('LLM')                  // 资源统计段
    expect(out).toContain('ASSRT')
  })
  it('handles empty ledger', () => {
    expect(formatReport([], 0, { pending: 0, dormant: 0 })).toContain('无记录')
  })
})
```

- [ ] **Step 2: 确认失败。Step 3: 实现** `src/cli/report.ts`

```ts
import type { LedgerEvent } from '../core/ledger.js'

export function parseSince(raw: string, now: number): number {
  const rel = raw.match(/^(\d+)(h|d)$/)
  if (rel) return now - Number(rel[1]) * (rel[2] === 'h' ? 3600_000 : 86_400_000)
  const abs = Date.parse(raw)
  if (!Number.isNaN(abs)) return abs
  throw new Error(`invalid --since value: ${raw} (use 24h / 7d / ISO date)`)
}

type RunEvent = Extract<LedgerEvent, { type: 'run' }>
type QueueEvent = Extract<LedgerEvent, { type: 'queue' }>

export function formatReport(
  events: LedgerEvent[], badLines: number, queueNow: { pending: number; dormant: number },
): string {
  const runs = events.filter((e): e is RunEvent => e.type === 'run')
  const queues = events.filter((e): e is QueueEvent => e.type === 'queue')
  const lines: string[] = []

  if (events.length === 0) return '台账内无记录（指定时间范围内）\n'

  const byDecision = new Map<string, number>()
  const bySource = new Map<string, number>()
  for (const r of runs) {
    byDecision.set(r.decision, (byDecision.get(r.decision) ?? 0) + 1)
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
  }
  lines.push(`== 运行 ${runs.length} 次 ==`)
  for (const [d, n] of byDecision) lines.push(`  ${d}: ${n}`)
  lines.push(`  来源: ${[...bySource].map(([s, n]) => `${s}=${n}`).join(' ')}`)

  const failures = runs.filter(r => ['no_safe_match', 'ask_user', 'error'].includes(r.decision))
  if (failures.length) {
    lines.push(`== 未成功明细 ==`)
    for (const f of failures) {
      lines.push(`  [${f.decision}] ${f.name} (${f.source})${f.error ? ` — ${f.error.slice(0, 80)}` : ''}`)
      lines.push(`      journal: ${f.journalPath}`)
    }
  }

  const byQueueEvent = new Map<string, number>()
  for (const q of queues) byQueueEvent.set(q.event, (byQueueEvent.get(q.event) ?? 0) + 1)
  lines.push(`== 队列 ==`)
  for (const [e, n] of byQueueEvent) lines.push(`  ${e}: ${n}`)
  lines.push(`  当前: pending=${queueNow.pending} dormant=${queueNow.dormant}`)

  const llm = runs.reduce((s, r) => s + r.llmCalls, 0)
  const assrt = runs.reduce((s, r) => s + r.assrtCalls, 0)
  const modes = new Map<string, number>()
  for (const r of runs) modes.set(r.llmProfile.mode, (modes.get(r.llmProfile.mode) ?? 0) + 1)
  lines.push(`== 资源 ==`)
  lines.push(`  LLM 调用: ${llm}（模式: ${[...modes].map(([m, n]) => `${m}=${n}`).join(' ') || '-'}）`)
  lines.push(`  ASSRT 调用: ${assrt}`)
  if (badLines > 0) lines.push(`⚠ 台账坏行: ${badLines}`)
  return lines.join('\n') + '\n'
}
```

cli/index.ts：增 `--since` 选项（`{ type: 'string', default: '24h' }`）与命令分支：

```ts
  if (cmd === 'report') return cmdReport(values.since!)
```

```ts
async function cmdReport(since: string) {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const ledger = new Ledger(join(cacheRoot, 'ledger.jsonl'))
  const sinceMs = parseSince(since, Date.now())
  const { events, badLines } = ledger.read(sinceMs)
  let queueNow = { pending: 0, dormant: 0 }
  try { queueNow = new PrefetchQueue(join(cacheRoot, 'queue.json')).size() } catch { /* 无队列文件 */ }
  process.stdout.write(formatReport(events, badLines, queueNow))
  process.exit(0)
}
```

usage 行更新为四命令。

- [ ] **Step 4: 全绿 + `npx tsx src/cli/index.ts report 2>&1`（无 env 需求，空台账输出"无记录"）。Step 5: commit** `feat: report subcommand summarizing the ledger`

---

### Task 5: 全量接线（watcher onRunComplete / CLI ledger / compose logging / journal 清理节拍 / env）

**Files:**
- Modify: `src/daemon/watcher.ts`, `src/cli/index.ts`, `docker-compose.yml`, `.env.example`, `README.md`
- Test: `src/daemon/watcher.test.ts`（追加）

- [ ] **Step 1: 失败测试**（watcher.test.ts 追加；makeDeps 增默认 `onRunComplete: vi.fn()`）

```ts
  it('reports run completion with source via onRunComplete', async () => {
    const onRunComplete = vi.fn()
    const deps = makeDeps({ onRunComplete })
    const w = new Watcher(deps)
    await w.tick()
    expect(onRunComplete).toHaveBeenCalledWith(expect.objectContaining({
      itemId: cleanItem.Id, source: 'playback', decision: 'download',
    }))
  })

  it('reports queue-source runs', async () => {
    const onRunComplete = vi.fn()
    const deps = makeDeps({ onRunComplete })
    deps.queue.upsert(cleanItem.Id, cleanItem.Name)
    const w = new Watcher(deps)
    await w.consumeTick()
    expect(onRunComplete).toHaveBeenCalledWith(expect.objectContaining({ source: 'queue' }))
  })

  it('prunes journals when the day changes', async () => {
    const pruneJournals = vi.fn()
    const deps = makeDeps({ pruneJournals })
    const w = new Watcher(deps)
    await w.tick()
    await w.tick() // 同一天只清一次
    expect(pruneJournals).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 2: 确认失败。Step 3: 实现**

watcher.ts：
- `WatcherDeps` 增 `onRunComplete?: (r: { itemId: string; name: string; source: 'playback' | 'queue'; result: WatcherJobResult }) => void` 与 `pruneJournals?: () => void`；
- `maybeProcess` 在 runJob 返回后调用 `this.deps.onRunComplete?.({ itemId, name: item.Name, source, result })`（catch 分支的失败也应报告：error 时构造 `{decision:'error', journalPath:''}`——runJob 抛错时没有 journalPath，用空串，ledger 事件的 error 字段带 String(e)。为此 onRunComplete 回调放 try/catch 两处，或统一在 finally 前记录——按 try 内成功路径 + catch 内 error 路径两处调用实现）；
- `tick()` 开头：按天惰性调用 `pruneJournals`（`private lastPruneDay = ''`；当天首个 tick 触发一次）。

cli/index.ts（cmdWatch）：
- 构造 `const ledger = new Ledger(join(cacheRoot, 'ledger.jsonl'))`；
- `const fileLog = makeFileLogger(join(cacheRoot, 'logs'), Number(process.env.LOG_RETAIN_DAYS) || 30)`；log 函数改为 `msg => { const line = `[watch ${new Date().toISOString()}] ${msg}`; console.log(line); fileLog(msg) }`；
- 队列构造传 onEvent：`new PrefetchQueue(qfile, undefined, e => { try { ledger.append({ ts: Date.now(), type: 'queue', ...e }) } catch {} })`（注意 PrefetchQueue 第二参是时钟——传 `undefined` 用默认，第三参回调）；
- WatcherDeps 增 `onRunComplete: r => { try { ledger.append({ ts: Date.now(), type: 'run', itemId: r.itemId, name: r.name, source: r.source, decision: r.result.decision, confidence: null, subtitlePath: r.result.subtitlePath ?? null, journalPath: r.result.journalPath, llmProfile: llm.profileInfo(), durationMs: r.result.stats?.durationMs ?? 0, llmCalls: r.result.stats?.llmCalls ?? 0, assrtCalls: r.result.stats?.apiCalls ?? 0, error: r.result.decision === 'error' ? (r.result.errorMessage ?? null) : null }) } catch {} }`——为此 `WatcherJobResult` 增可选 `stats?: { durationMs: number; llmCalls: number; apiCalls: number }` 与 `errorMessage?: string`，watch 的 runJob 直接透传 PipelineResult（其含 stats）；error 场景 pipeline 的 reasons[0] 即错误摘要，runJob 包装层把它填进 errorMessage；
- `pruneJournals: () => pruneOldDirs(join(cacheRoot, 'journals'), Number(process.env.JOURNAL_RETAIN_DAYS) || 90)`；
- cmdRun / cmdRunItem：完成后各 append 一条 run 事件（source 'cli'，字段同上，name 用 ctx.media.title）。

docker-compose.yml 两服务各加：

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

.env.example 追加：

```
JOURNAL_RETAIN_DAYS=90
LOG_RETAIN_DAYS=30
```

README：env 表加两行；新增一段 "观测与排障"：`subtitle-scout report --since 24h` 示例输出 + "ledger 是时间线，journal 是深度" 一句话 + 日志位置说明。

- [ ] **Step 4: 全绿（~168 测试）+ usage 冒烟。Step 5: commit** `feat: wire ledger, file logs, retention beat and compose log limits`

---

### Task 6（Controller）: 真实验证 + 部署 + 终审 + 合并

- [ ] OrbStack：起 watch（快节拍）→ 模拟一次播放 + 触发一次队列消费 → `report --since 1h` 输出含运行统计/队列事件/资源段；检查 `cache/logs/watch-*.log` 与 `ledger.jsonl` 内容；
- [ ] 终审（opus）：重点 ledger 写入点完备性（成功/失败/cli 三径）、观测代码不影响主流程（全部 try/catch）、report 聚合正确性、retention 误删风险；修复 → 复核；
- [ ] 部署软路由 → `docker exec subtitle-scout npx tsx src/cli/index.ts report --since 24h` 看真实台账（含昨晚 M4 队列消费）——注意：部署前的历史不在台账里，从部署时刻起记录；
- [ ] spec 补验收结果 → 合并 main → 更新记忆。

---

## Self-Review 结果（已执行）

- **Spec 覆盖**：①ledger 双事件类型+写入三径+坏行容忍(T1/T5)、②日志落盘+30 天保留(T2/T5)、③report 全段落+since 解析+空台账(T4)、④compose 上限+journal 90 天清理节拍+两 env(T5)；诚实边界与不做什么无代码项。
- **占位符扫描**：无 TBD；T5 的 onRunComplete 错误路径实现说明具体（两处调用点）。
- **类型一致性**：LedgerEvent(T1) ↔ queue onEvent 字段(T3) ↔ CLI append(T5) 字段逐一对齐（queue 事件缺 ts/type 由 CLI 补齐——见 T5 spread 前置字段）；PipelineResult.stats(T3) ↔ WatcherJobResult.stats(T5)；PrefetchQueue 构造器参数顺序 (file, now?, onEvent?)(T3) 与 CLI 调用(T5) 一致。
