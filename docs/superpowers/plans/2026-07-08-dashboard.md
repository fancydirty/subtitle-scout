# 嵌入式监控页 Dashboard 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 subtitle-scout 加一个嵌入式只读监控页,让人(含非技术者)一眼看到"字幕有没有落盘",并能点开某次运行看 agent 的 4 步工作故事。

**Architecture:** 后端在 daemon(`watch` 进程)内起一个 `node:http` 端点,只读消费现有 `ledger.jsonl` / `journals/` / `queue.json`,把内部决策枚举**在服务端**映射成人话 JSON;前端是独立 `web/` 里的 Vite + React 静态 SPA,轮询这些 JSON 渲染 master–detail 布局。**核心 pipeline / 判断点 / gate 零改动**——dashboard 只新增 `src/dashboard/` 与 `web/`,并在 `cmdWatch` 接一根线。

**Tech Stack:** 后端 `node:http` + 现有 zod/vitest(零新依赖);前端 Vite + React + TypeScript + 纯 CSS(移植已批准样机 `dashboard-v2.html`)+ vitest/@testing-library/react。**不引入** shadcn/Tailwind/Recharts(见"本计划不做")。

**Spec:** `docs/superpowers/specs/2026-07-08-dashboard-design.md`

---

## 关键前置:分支

在 main 上开工前先建分支(subagent-driven-development 要求隔离):

```bash
git checkout -b dashboard
```

后续所有任务在此分支提交。最后一个任务用 finishing-a-development-branch 合并。

---

## 数据契约(所有任务共享,先锁死)

服务端 API 返回的 DTO。**后端产出、前端消费,两侧类型必须一致**。前端在 `web/src/api/types.ts` 重复声明这些类型(跨 package 边界,故意重复)。

```ts
// 决策色调
type Tone = 'ok' | 'muted' | 'skip' | 'fail'

// GET /api/summary
interface SummaryDTO {
  status: 'running'
  todayReady: number      // 今日(本地零点起)download + adopted_local 次数
  totalReady: number      // 窗口内 download + adopted_local 次数
  queuePending: number
  queueDormant: number
  runsInWindow: number
  windowHours: number
}

// GET /api/runs
interface RunsDTO {
  inFlight: InFlightItemDTO[]   // 正在处理(内存态,置顶)
  runs: RunDTO[]                // 已完成(按 ts 倒序)
}
interface InFlightItemDTO { itemId: string; name: string; source: string }
interface RunDTO {
  id: string          // journal 目录名(=story 的 :id);无 journal 时为 ''
  itemId: string
  name: string
  decision: string
  outcomeLabel: string   // 人话
  tone: Tone
  ts: number
  clickable: boolean     // 有 journal 故事可点
}

// GET /api/runs/:id
interface StoryDTO {
  name: string
  decision: string
  outcomeLabel: string
  tone: Tone
  ts: number
  steps: StoryStepDTO[]   // 至多 4 步大白话
  raw: {
    pipelineSteps: { name: string; at: string; data?: unknown }[]
    llmCalls: { point: string; durationMs: number; prompt: string; parsed: unknown }[]
  }
}
interface StoryStepDTO { title: string; detail: string; state: 'done' | 'fail' }

// GET /api/queue
interface QueueDTO {
  pending: QueueItemDTO[]
  dormant: QueueItemDTO[]
}
interface QueueItemDTO { itemId: string; name: string; statusLabel: string; nextRetryAt: number | null }
```

**journal `decision.json` 的真实形状**(读取时按此解构):

```jsonc
{
  "request_id": "...",
  "finished_at": "ISO",
  "decision": {                    // ← 这是 FinalDecision 对象,不是字符串
    "request_id": "...",
    "decision": "download",        // ← 枚举字符串在这里
    "confidence": 0.9,
    "selected": { "assrt_id": 1, "subtitle_name": "...", "language": "...", "format": "..." },
    "reasons": ["season pack: covered 8 episodes"],
    "verification": { "downloaded": true, "path": "...", "bytes": 1, "encoding": "utf-8" }
  },
  "steps": [ { "name": "identify", "at": "ISO" }, { "name": "seasonGraduate", "at": "ISO", "data": { "packId": 642240, "episodes": 8, "needs": 8 } }, ... ],
  "llm_calls": [ { "point": "...", "prompt": "...", "rawText": "...", "parsed": {}, "retries": 0, "durationMs": 1 } ],
  "api_calls": [ ... ]
}
```

**pipeline step 名清单**(story 的 raw tier-2 会展示,step→高光判断会用到):
`identify, cacheLookup, scanOrphans, judgeOrphan, orphanGateResult, cacheHitPositive, planSearch, assrtSearch, candidateFilter, rankCandidates, gate, gateResult, seasonGraduate, seasonPackGate, seasonCircuitBreak, seasonEpisodeFailed, resolveDownloadUrl, download, write, error`

---

## 文件结构

新增(后端,`src/dashboard/`):
- `labels.ts` — 决策枚举 → 人话标签 + 色调;队列状态 → 人话。**人话映射单一事实源。**
- `api.ts` — `buildSummary` / `buildRuns`(纯函数,吃 ledger 事件 + 队列态)。
- `story.ts` — `buildRunStory`(纯函数,吃 journal JSON + 匹配的 ledger run 事件 → 4 步故事)。
- `router.ts` — `handleApiRoute`(纯函数:路由 + token 校验 + id 合法性;deps 注入读取器)。
- `server.ts` — `startDashboard`(node:http:fs 读 ledger/queue/journal、静态托管 web/dist、装配 router deps)。
- `types.ts` — 上述 DTO 类型。
- 各自 `*.test.ts`。

修改(后端接线):
- `src/daemon/watcher.ts` — `inFlight` map 携带 name;新增 `inFlightItems()`。
- `src/cli/index.ts` — `cmdWatch` 在 `DASHBOARD_PORT` 存在时起 dashboard,传 `getInFlight`。

新增(前端,`web/`):独立 package。`package.json` `vite.config.ts` `tsconfig.json` `index.html` `vitest.config.ts` `src/main.tsx` `src/App.tsx` `src/styles.css` `src/api/{types.ts,client.ts,useDashboard.ts}` `src/components/{TopBar,SummaryHeader,ActivityFeed,StoryPanel}.tsx` + 组件测试。

修改(交付):`Dockerfile` `.dockerignore` `docker-compose.yml` `deploy/deploy.sh` `README.md` `docs/.../spec`(补一行链接)。

---

## Task 1: 人话标签映射(labels.ts)

**Files:**
- Create: `src/dashboard/labels.ts`
- Test: `src/dashboard/labels.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/dashboard/labels.test.ts
import { describe, it, expect } from 'vitest'
import { decisionLabel, queueStatusLabel } from './labels.js'

describe('decisionLabel', () => {
  it('maps every decision to plain-language label + tone, no jargon', () => {
    expect(decisionLabel('download')).toEqual({ label: '已下好中文字幕', tone: 'ok' })
    expect(decisionLabel('adopted_local')).toEqual({ label: '整理好了本地已有的字幕', tone: 'ok' })
    expect(decisionLabel('already_exists')).toEqual({ label: '本来就有字幕，跳过', tone: 'skip' })
    expect(decisionLabel('no_safe_match')).toEqual({ label: '暂时没找到合适的中文字幕', tone: 'muted' })
    expect(decisionLabel('ask_user')).toEqual({ label: '需要你确认一下', tone: 'muted' })
    expect(decisionLabel('retry_later')).toEqual({ label: '过阵子再试', tone: 'muted' })
    expect(decisionLabel('error')).toEqual({ label: '出错，稍后重试', tone: 'fail' })
  })
  it('falls back safely on unknown decision without leaking the raw enum', () => {
    expect(decisionLabel('some_new_enum')).toEqual({ label: '已处理', tone: 'muted' })
  })
})

describe('queueStatusLabel', () => {
  it('maps queue states to plain language', () => {
    expect(queueStatusLabel('pending')).toBe('排队等待中')
    expect(queueStatusLabel('dormant')).toBe('多次没找到，暂缓')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dashboard/labels.test.ts`
Expected: FAIL（Cannot find module './labels.js'）

- [ ] **Step 3: 实现**

```ts
// src/dashboard/labels.ts
import type { Tone } from './types.js'

const DECISION_MAP: Record<string, { label: string; tone: Tone }> = {
  download:       { label: '已下好中文字幕', tone: 'ok' },
  adopted_local:  { label: '整理好了本地已有的字幕', tone: 'ok' },
  already_exists: { label: '本来就有字幕，跳过', tone: 'skip' },
  no_safe_match:  { label: '暂时没找到合适的中文字幕', tone: 'muted' },
  ask_user:       { label: '需要你确认一下', tone: 'muted' },
  retry_later:    { label: '过阵子再试', tone: 'muted' },
  error:          { label: '出错，稍后重试', tone: 'fail' },
}

/** 内部决策枚举 → 用户视角人话。未知枚举兜底为中性词，绝不泄漏原始枚举名。 */
export function decisionLabel(decision: string): { label: string; tone: Tone } {
  return DECISION_MAP[decision] ?? { label: '已处理', tone: 'muted' }
}

export function queueStatusLabel(state: 'pending' | 'dormant'): string {
  return state === 'dormant' ? '多次没找到，暂缓' : '排队等待中'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dashboard/labels.test.ts`
Expected: PASS（`types.js` 只是类型导入，编译期擦除，无需该文件存在即可运行 vitest；若 tsc 报错在 Task 引入 types.ts 后消除）

注:`types.ts` 在 Task 4 前尚不存在。本步先内联 `Tone` 以让测试独立通过——把 `import type { Tone } from './types.js'` 暂改为文件内 `type Tone = 'ok' | 'muted' | 'skip' | 'fail'`,Task 4 建 `types.ts` 后再改回 import。

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/labels.ts src/dashboard/labels.test.ts
git commit -m "feat(dashboard): decision→plain-language label mapping"
```

---

## Task 2: 聚合(api.ts — buildSummary / buildRuns)

**Files:**
- Create: `src/dashboard/api.ts`
- Test: `src/dashboard/api.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/dashboard/api.test.ts
import { describe, it, expect } from 'vitest'
import { buildSummary, buildRuns, localMidnight } from './api.js'
import type { LedgerEvent } from '../core/ledger.js'

const run = (over: Partial<Extract<LedgerEvent, { type: 'run' }>>): LedgerEvent => ({
  ts: 1000, type: 'run', itemId: 'i', name: 'Movie', source: 'queue',
  decision: 'download', confidence: 0.9, subtitlePath: '/m/x.ass',
  journalPath: '/cache/journals/i-1000/decision.json', llmProfile: { mode: 'forced-tool' },
  durationMs: 100, llmCalls: 3, assrtCalls: 2, ...over,
})

describe('buildSummary', () => {
  it('counts today (>= local midnight) and window totals + queue', () => {
    const now = Date.parse('2026-07-08T12:00:00+08:00')
    const mid = localMidnight(now)
    const events: LedgerEvent[] = [
      run({ ts: mid + 3600_000, decision: 'download' }),        // today
      run({ ts: mid + 3600_000, decision: 'adopted_local' }),   // today
      run({ ts: mid - 3600_000, decision: 'download' }),        // yesterday
      run({ ts: mid + 100, decision: 'no_safe_match' }),        // today, not ready
    ]
    const s = buildSummary(events, { pending: 24, dormant: 3 }, now)
    expect(s.status).toBe('running')
    expect(s.todayReady).toBe(2)
    expect(s.totalReady).toBe(3)
    expect(s.queuePending).toBe(24)
    expect(s.queueDormant).toBe(3)
    expect(s.runsInWindow).toBe(4)
  })
})

describe('buildRuns', () => {
  it('maps run events to plain-language DTO, newest first, honoring limit', () => {
    const events: LedgerEvent[] = [
      run({ ts: 1, name: 'A', decision: 'download' }),
      run({ ts: 3, name: 'C', decision: 'no_safe_match', journalPath: '/cache/journals/c-3/decision.json' }),
      run({ ts: 2, name: 'B', decision: 'already_exists' }),
      { ts: 5, type: 'queue', event: 'enqueued', itemId: 'q', name: 'Q' }, // ignored
    ]
    const out = buildRuns(events, 2)
    expect(out.map(r => r.name)).toEqual(['C', 'B'])   // ts desc, limited to 2
    expect(out[0]).toMatchObject({ id: 'c-3', outcomeLabel: '暂时没找到合适的中文字幕', tone: 'muted', clickable: true })
  })
  it('marks runs with empty journalPath as not clickable', () => {
    const out = buildRuns([run({ ts: 1, name: 'E', decision: 'error', journalPath: '' })], 10)
    expect(out[0]).toMatchObject({ id: '', clickable: false, tone: 'fail' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dashboard/api.test.ts`
Expected: FAIL（Cannot find module './api.js'）

- [ ] **Step 3: 实现**

```ts
// src/dashboard/api.ts
import type { LedgerEvent } from '../core/ledger.js'
import type { SummaryDTO, RunDTO } from './types.js'
import { decisionLabel } from './labels.js'

type RunEvent = Extract<LedgerEvent, { type: 'run' }>
const READY = new Set(['download', 'adopted_local'])
const WINDOW_HOURS = 168

/** 本地时区当日零点（prod TZ=Asia/Shanghai）。 */
export function localMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** journalPath `/…/journals/<id>/decision.json` → `<id>`；无 journal 返回 ''。 */
function journalIdOf(journalPath: string): string {
  const m = journalPath.match(/journals\/([^/]+)\/decision\.json$/)
  return m ? m[1] : ''
}

export function buildSummary(
  events: LedgerEvent[], queue: { pending: number; dormant: number }, now: number,
): SummaryDTO {
  const runs = events.filter((e): e is RunEvent => e.type === 'run')
  const mid = localMidnight(now)
  return {
    status: 'running',
    todayReady: runs.filter(r => r.ts >= mid && READY.has(r.decision)).length,
    totalReady: runs.filter(r => READY.has(r.decision)).length,
    queuePending: queue.pending,
    queueDormant: queue.dormant,
    runsInWindow: runs.length,
    windowHours: WINDOW_HOURS,
  }
}

export function buildRuns(events: LedgerEvent[], limit: number): RunDTO[] {
  return events
    .filter((e): e is RunEvent => e.type === 'run')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map(r => {
      const { label, tone } = decisionLabel(r.decision)
      const id = journalIdOf(r.journalPath)
      return { id, itemId: r.itemId, name: r.name, decision: r.decision, outcomeLabel: label, tone, ts: r.ts, clickable: id !== '' }
    })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dashboard/api.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/api.ts src/dashboard/api.test.ts
git commit -m "feat(dashboard): buildSummary + buildRuns aggregation"
```

---

## Task 3: 故事映射(story.ts — buildRunStory)

把一次运行的 journal 翻成"认出片 → 找字幕 → 挑最靠谱 → 下好放到位"4 步大白话,外加 tier-2 原始细节。

**Files:**
- Create: `src/dashboard/story.ts`
- Test: `src/dashboard/story.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/dashboard/story.test.ts
import { describe, it, expect } from 'vitest'
import { buildRunStory } from './story.js'

const baseJournal = (over: Record<string, unknown> = {}) => ({
  request_id: 'r', finished_at: 'ISO',
  decision: { request_id: 'r', decision: 'download', confidence: 0.9,
    selected: { assrt_id: 1, subtitle_name: 'Foo.简体.ass', language: 'zh-Hans', format: 'ass' },
    reasons: [], verification: { downloaded: true, path: '/m/x.ass', bytes: 100, encoding: 'utf-8' } },
  steps: [ { name: 'identify', at: 't' }, { name: 'planSearch', at: 't' },
    { name: 'assrtSearch', at: 't', data: { q: 'Foo' } }, { name: 'candidateFilter', at: 't', data: { raw: 5, kept: 3 } },
    { name: 'rankCandidates', at: 't', data: { count: 3 } }, { name: 'gate', at: 't' },
    { name: 'download', at: 't' }, { name: 'write', at: 't' } ],
  llm_calls: [ { point: 'identify', prompt: 'P', rawText: 'R', parsed: { title: 'Foo' }, retries: 0, durationMs: 12 } ],
  api_calls: [],
  ...over,
})
const ledgerEvent = { name: 'Foo (2020)', decision: 'download', ts: 1000 }

describe('buildRunStory', () => {
  it('renders a 4-step plain-language story for a single-episode download', () => {
    const s = buildRunStory(baseJournal(), ledgerEvent as any)
    expect(s.name).toBe('Foo (2020)')
    expect(s.outcomeLabel).toBe('已下好中文字幕')
    expect(s.steps).toHaveLength(4)
    expect(s.steps.map(x => x.title)).toEqual(['认出这部片', '去字幕站找了一圈', '挑了最靠谱的那份', '下好并放到位'])
    expect(s.steps.every(x => x.state === 'done')).toBe(true)
    expect(s.steps[3].detail).toContain('Jellyfin')
  })

  it('highlights whole-season coverage when seasonGraduate present', () => {
    const journal = baseJournal({
      steps: [ { name: 'identify', at: 't' }, { name: 'planSearch', at: 't' },
        { name: 'seasonGraduate', at: 't', data: { packId: 642240, episodes: 8, needs: 8 } },
        { name: 'seasonPackGate', at: 't', data: { commit: 8, dropped: 8 } },
        { name: 'write', at: 't' } ],
      decision: { ...baseJournal().decision, reasons: ['season pack: covered 8 episodes'] },
    })
    const s = buildRunStory(journal, ledgerEvent as any)
    expect(s.steps[1].detail).toContain('整季')
    expect(s.steps[3].detail).toContain('8 集')
  })

  it('marks the failing step for no_safe_match', () => {
    const journal = baseJournal({
      decision: { request_id: 'r', decision: 'no_safe_match', confidence: null, selected: null, reasons: [], verification: null },
      steps: [ { name: 'identify', at: 't' }, { name: 'planSearch', at: 't' },
        { name: 'assrtSearch', at: 't', data: { q: 'Foo' } }, { name: 'candidateFilter', at: 't', data: { raw: 0, kept: 0 } },
        { name: 'gate', at: 't' } ],
    })
    const s = buildRunStory(journal, { name: 'Foo', decision: 'no_safe_match', ts: 1 } as any)
    expect(s.tone).toBe('muted')
    const fail = s.steps.find(x => x.state === 'fail')
    expect(fail).toBeTruthy()
    expect(fail!.detail).not.toMatch(/gate|no_safe_match|升格|映射/) // 无黑话
  })

  it('exposes tier-2 raw pipeline steps + llm calls', () => {
    const s = buildRunStory(baseJournal(), ledgerEvent as any)
    expect(s.raw.pipelineSteps.map(x => x.name)).toContain('assrtSearch')
    expect(s.raw.llmCalls[0]).toMatchObject({ point: 'identify', durationMs: 12 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dashboard/story.test.ts`
Expected: FAIL（Cannot find module './story.js'）

- [ ] **Step 3: 实现**

```ts
// src/dashboard/story.ts
import type { StoryDTO, StoryStepDTO, Tone } from './types.js'
import { decisionLabel } from './labels.js'

interface JournalStep { name: string; at: string; data?: unknown }
interface JournalLlmCall { point: string; prompt: string; parsed: unknown; durationMs: number }
interface JournalFinalDecision {
  decision: string
  confidence?: number | null
  selected?: { subtitle_name: string; language: string } | null
  reasons?: string[]
  verification?: { downloaded: boolean; path?: string | null } | null
}
interface JournalDoc {
  decision: JournalFinalDecision
  steps: JournalStep[]
  llm_calls: JournalLlmCall[]
}
interface LedgerLike { name: string; decision: string; ts: number }

const has = (steps: JournalStep[], name: string) => steps.find(s => s.name === name)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** 从 journal + 匹配的 ledger 事件合成 4 步大白话故事。失败决策把失败点标 fail。 */
export function buildRunStory(journal: JournalDoc, ledger: LedgerLike): StoryDTO {
  const dec = journal.decision
  const { label, tone } = decisionLabel(dec.decision)
  const steps = journal.steps ?? []
  const success = dec.decision === 'download' || dec.decision === 'adopted_local' || dec.decision === 'already_exists'

  const season = has(steps, 'seasonGraduate')?.data as { episodes?: number } | undefined
  const gate = has(steps, 'seasonPackGate')?.data as { commit?: number } | undefined
  const coveredCount = num(gate?.commit) ?? num(season?.episodes)
  const isSeason = !!season

  const filter = has(steps, 'candidateFilter')?.data as { kept?: number } | undefined
  const kept = num(filter?.kept)

  // 语言人话
  const lang = dec.selected?.language === 'zh-Hant' ? '繁体中文' : '简体中文'

  const out: StoryStepDTO[] = []

  // 1. 认出片
  out.push({ title: '认出这部片', detail: ledger.name, state: 'done' })

  // 2. 找字幕
  if (isSeason) {
    out.push({ title: '去字幕站找了一圈', detail: `找到一份覆盖整季的字幕${coveredCount ? `（共 ${coveredCount} 集）` : ''}，比一集一集找更省事`, state: 'done' })
  } else if (kept === 0) {
    out.push({ title: '去字幕站找了一圈', detail: '没有能对上这部片的字幕', state: 'fail' })
  } else {
    out.push({ title: '去字幕站找了一圈', detail: kept != null ? `找到 ${kept} 个候选` : '找到一些候选', state: 'done' })
  }

  // 3. 挑最靠谱
  if (success) {
    out.push({ title: '挑了最靠谱的那份', detail: dec.selected ? `${lang} · 跟你的片子对得上` : '确认可用', state: 'done' })
  } else {
    // 失败：若前一步已 fail 则第 3 步不再重复 fail，用中性收束
    const alreadyFailed = out.some(s => s.state === 'fail')
    out.push({ title: '挑最靠谱的那份', detail: '没有一份能稳妥对上，为避免下错，这次先不放', state: alreadyFailed ? 'done' : 'fail' })
  }

  // 4. 下好放到位
  if (success) {
    const doneDetail = isSeason && coveredCount
      ? `${coveredCount} 集字幕全部就位，Jellyfin 里已经能看了`
      : dec.decision === 'already_exists' ? '本来就有字幕，这次不用动' : '字幕已就位，Jellyfin 里已经能看了'
    out.push({ title: '下好并放到位', detail: doneDetail, state: 'done' })
  } else {
    out.push({ title: '下好并放到位', detail: '这次没有可放的字幕，过阵子会再帮你试', state: 'done' })
  }

  return {
    name: ledger.name,
    decision: dec.decision,
    outcomeLabel: label,
    tone: tone as Tone,
    ts: ledger.ts,
    steps: out.slice(0, 4),
    raw: {
      pipelineSteps: steps.map(s => ({ name: s.name, at: s.at, data: s.data })),
      llmCalls: (journal.llm_calls ?? []).map(c => ({ point: c.point, durationMs: c.durationMs, prompt: c.prompt, parsed: c.parsed })),
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dashboard/story.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/story.ts src/dashboard/story.test.ts
git commit -m "feat(dashboard): journal→4-step plain-language story"
```

---

## Task 4: 纯路由 + types(router.ts / types.ts)

把 API 路由做成纯函数:注入读取器 deps,处理 `/api/summary` `/api/runs` `/api/runs/:id` `/api/queue`、token 校验、journal id 合法性(防路径穿越)。同时建 `types.ts` 并把 Task 1 内联的 `Tone` 改回 import。

**Files:**
- Create: `src/dashboard/types.ts`, `src/dashboard/router.ts`
- Modify: `src/dashboard/labels.ts`（改回 `import type { Tone }`）
- Test: `src/dashboard/router.test.ts`

- [ ] **Step 1: 建 types.ts**

```ts
// src/dashboard/types.ts
export type Tone = 'ok' | 'muted' | 'skip' | 'fail'

export interface SummaryDTO {
  status: 'running'
  todayReady: number
  totalReady: number
  queuePending: number
  queueDormant: number
  runsInWindow: number
  windowHours: number
}
export interface InFlightItemDTO { itemId: string; name: string; source: string }
export interface RunDTO {
  id: string; itemId: string; name: string; decision: string
  outcomeLabel: string; tone: Tone; ts: number; clickable: boolean
}
export interface RunsDTO { inFlight: InFlightItemDTO[]; runs: RunDTO[] }
export interface StoryStepDTO { title: string; detail: string; state: 'done' | 'fail' }
export interface StoryDTO {
  name: string; decision: string; outcomeLabel: string; tone: Tone; ts: number
  steps: StoryStepDTO[]
  raw: { pipelineSteps: { name: string; at: string; data?: unknown }[]; llmCalls: { point: string; durationMs: number; prompt: string; parsed: unknown }[] }
}
export interface QueueItemDTO { itemId: string; name: string; statusLabel: string; nextRetryAt: number | null }
export interface QueueDTO { pending: QueueItemDTO[]; dormant: QueueItemDTO[] }
```

在 `src/dashboard/labels.ts` 顶部把内联的 `type Tone = ...` 删除,改回:

```ts
import type { Tone } from './types.js'
```

- [ ] **Step 2: 写失败测试**

```ts
// src/dashboard/router.test.ts
import { describe, it, expect } from 'vitest'
import { handleApiRoute, type RouterDeps } from './router.js'

const deps: RouterDeps = {
  summary: () => ({ status: 'running', todayReady: 1, totalReady: 1, queuePending: 0, queueDormant: 0, runsInWindow: 1, windowHours: 168 }),
  runs: () => ({ inFlight: [], runs: [] }),
  story: (id) => (id === 'i-1000' ? { name: 'X', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1, steps: [], raw: { pipelineSteps: [], llmCalls: [] } } : null),
  queue: () => ({ pending: [], dormant: [] }),
}

const call = (pathname: string, opts: { query?: Record<string, string>; token?: string; configuredToken?: string } = {}) =>
  handleApiRoute({ pathname, query: opts.query ?? {}, token: opts.token }, deps, opts.configuredToken)

describe('handleApiRoute', () => {
  it('routes summary/runs/queue', () => {
    expect(call('/api/summary').status).toBe(200)
    expect(call('/api/runs').status).toBe(200)
    expect(call('/api/queue').status).toBe(200)
  })
  it('routes runs/:id and 404s unknown id', () => {
    expect(call('/api/runs/i-1000').status).toBe(200)
    expect(call('/api/runs/nope').status).toBe(404)
  })
  it('rejects path-traversal / illegal journal id with 400', () => {
    expect(call('/api/runs/..%2f..%2fetc').status).toBe(400)   // pre-decoded by server; here raw dots
    expect(call('/api/runs/a/b').status).toBe(404)             // extra segment → not a runs/:id match
    expect(handleApiRoute({ pathname: '/api/runs/a..b', query: {} }, deps).status).toBe(400)
  })
  it('enforces token when configured', () => {
    expect(call('/api/summary', { configuredToken: 's3cret' }).status).toBe(401)
    expect(call('/api/summary', { configuredToken: 's3cret', token: 'wrong' }).status).toBe(401)
    expect(call('/api/summary', { configuredToken: 's3cret', token: 's3cret' }).status).toBe(200)
  })
  it('returns 404 for non-api paths (static handled elsewhere)', () => {
    expect(call('/index.html').status).toBe(404)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/dashboard/router.test.ts`
Expected: FAIL（Cannot find module './router.js'）

- [ ] **Step 4: 实现**

```ts
// src/dashboard/router.ts
import type { SummaryDTO, RunsDTO, StoryDTO, QueueDTO } from './types.js'

export interface RouterDeps {
  summary: () => SummaryDTO
  runs: (limit: number) => RunsDTO
  story: (id: string) => StoryDTO | null
  queue: () => QueueDTO
}
export interface ApiResult { status: number; json: unknown }

const JOURNAL_ID = /^[A-Za-z0-9._-]+$/   // 允许字符集；额外禁止 '..' 片段
const isSafeId = (id: string) => JOURNAL_ID.test(id) && !id.includes('..')

/** 纯 API 路由。token 未配置则不校验;配置了则需精确匹配。id 非法 400,未命中 404。 */
export function handleApiRoute(
  req: { pathname: string; query: Record<string, string>; token?: string },
  deps: RouterDeps,
  configuredToken?: string,
): ApiResult {
  if (configuredToken && req.token !== configuredToken) return { status: 401, json: { error: 'unauthorized' } }

  const { pathname } = req
  if (pathname === '/api/summary') return { status: 200, json: deps.summary() }
  if (pathname === '/api/queue') return { status: 200, json: deps.queue() }
  if (pathname === '/api/runs') {
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 200)
    return { status: 200, json: deps.runs(limit) }
  }
  const m = pathname.match(/^\/api\/runs\/([^/]+)$/)
  if (m) {
    const id = m[1]
    if (!isSafeId(id)) return { status: 400, json: { error: 'bad id' } }
    const story = deps.story(id)
    return story ? { status: 200, json: story } : { status: 404, json: { error: 'not found' } }
  }
  return { status: 404, json: { error: 'not found' } }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/dashboard/router.test.ts src/dashboard/labels.test.ts`
Expected: PASS（labels 改回 import 后仍通过）

- [ ] **Step 6: 提交**

```bash
git add src/dashboard/types.ts src/dashboard/router.ts src/dashboard/router.test.ts src/dashboard/labels.ts
git commit -m "feat(dashboard): pure API router + shared DTO types"
```

---

## Task 5: HTTP 服务 + 静态托管(server.ts)

装配:fs 读 ledger/queue/journal → 喂 api/story → router;静态托管 web/dist;内容类型;token 从 query/header 取。

**Files:**
- Create: `src/dashboard/server.ts`
- Test: `src/dashboard/server.test.ts`

- [ ] **Step 1: 写失败测试**（真实起 http，用 fetch 打）

```ts
// src/dashboard/server.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { startDashboard } from './server.js'

let server: Server | undefined
afterEach(() => server?.close())

function fixtureCache(): string {
  const root = mkdtempSync(join(tmpdir(), 'dash-'))
  const led = [
    { ts: 2000, type: 'run', itemId: 'i', name: 'Overflow', source: 'queue', decision: 'download', confidence: 0.9, subtitlePath: '/m/x.ass', journalPath: join(root, 'journals/i-2000/decision.json'), llmProfile: { mode: 'forced-tool' }, durationMs: 1, llmCalls: 1, assrtCalls: 1, error: null },
  ].map(e => JSON.stringify(e)).join('\n')
  mkdirSync(join(root, 'journals/i-2000'), { recursive: true })
  writeFileSync(join(root, 'ledger.jsonl'), led)
  writeFileSync(join(root, 'journals/i-2000/decision.json'), JSON.stringify({
    request_id: 'r', finished_at: 't',
    decision: { request_id: 'r', decision: 'download', confidence: 0.9, selected: { assrt_id: 1, subtitle_name: 'S', language: 'zh-Hans', format: 'ass' }, reasons: [], verification: { downloaded: true, path: '/m/x.ass' } },
    steps: [{ name: 'identify', at: 't' }], llm_calls: [], api_calls: [],
  }))
  const dist = join(root, 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>scout</title>')
  return root
}

async function start(cacheRoot: string, token?: string): Promise<{ base: string }> {
  server = await startDashboard({ cacheRoot, port: 0, token, distDir: join(cacheRoot, 'dist'), getInFlight: () => [] })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}` }
}

describe('startDashboard', () => {
  it('serves summary/runs/story from real files', async () => {
    const root = fixtureCache()
    const { base } = await start(root)
    expect((await (await fetch(`${base}/api/summary`)).json()).status).toBe('running')
    const runs = await (await fetch(`${base}/api/runs`)).json()
    expect(runs.runs[0]).toMatchObject({ name: 'Overflow', outcomeLabel: '已下好中文字幕', id: 'i-2000' })
    const story = await (await fetch(`${base}/api/runs/i-2000`)).json()
    expect(story.steps[0].title).toBe('认出这部片')
  })
  it('serves static index.html at /', async () => {
    const root = fixtureCache()
    const { base } = await start(root)
    const res = await fetch(`${base}/`)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('scout')
  })
  it('rejects api without token when configured (401)', async () => {
    const root = fixtureCache()
    const { base } = await start(root, 's3cret')
    expect((await fetch(`${base}/api/summary`)).status).toBe(401)
    expect((await fetch(`${base}/api/summary?token=s3cret`)).status).toBe(200)
  })
  it('rejects journal id path-traversal (400)', async () => {
    const root = fixtureCache()
    const { base } = await start(root)
    expect((await fetch(`${base}/api/runs/..%2f..%2fpackage`)).status).toBe(400)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: FAIL（Cannot find module './server.js'）

- [ ] **Step 3: 实现**

```ts
// src/dashboard/server.ts
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { URL } from 'node:url'
import { Ledger } from '../core/ledger.js'
import { PrefetchQueue } from '../daemon/queue.js'
import { buildSummary, buildRuns } from './api.js'
import { buildRunStory } from './story.js'
import { handleApiRoute, type RouterDeps } from './router.js'
import { queueStatusLabel } from './labels.js'
import type { InFlightItemDTO, QueueDTO } from './types.js'

export interface DashboardOpts {
  cacheRoot: string
  port: number
  token?: string
  distDir: string
  getInFlight: () => InFlightItemDTO[]
}

const WINDOW_MS = 168 * 3600_000
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.map': 'application/json',
}

function readStory(cacheRoot: string, id: string, now: number) {
  const path = join(cacheRoot, 'journals', id, 'decision.json')
  if (!existsSync(path)) return null
  let journal: any
  try { journal = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  // 用 ledger 补 name/ts;缺失则回退
  const { events } = new Ledger(join(cacheRoot, 'ledger.jsonl')).read(now - WINDOW_MS)
  const ev = events.find(e => e.type === 'run' && e.journalPath.includes(`/journals/${id}/`)) as any
  const ledger = ev ? { name: ev.name, decision: ev.decision, ts: ev.ts } : { name: id, decision: journal?.decision?.decision ?? 'error', ts: 0 }
  try { return buildRunStory(journal, ledger) } catch { return null }
}

function buildQueue(cacheRoot: string): QueueDTO {
  let q: PrefetchQueue
  try { q = new PrefetchQueue(join(cacheRoot, 'queue.json')) } catch { return { pending: [], dormant: [] } }
  // PrefetchQueue 无导出 entries 的公开访问器;经 queue.json 直读
  const file = join(cacheRoot, 'queue.json')
  let entries: any[] = []
  try { entries = JSON.parse(readFileSync(file, 'utf8')).entries ?? [] } catch { /* 无文件 */ }
  const map = (e: any) => ({ itemId: e.itemId, name: e.name, statusLabel: queueStatusLabel(e.state), nextRetryAt: e.nextRetryAt ?? null })
  return {
    pending: entries.filter(e => e.state === 'pending').map(map),
    dormant: entries.filter(e => e.state === 'dormant').map(map),
  }
}

function serveStatic(distDir: string, pathname: string): { status: number; body: Buffer; type: string } {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const full = normalize(join(distDir, rel))
  if (!full.startsWith(normalize(distDir))) return { status: 403, body: Buffer.from('forbidden'), type: 'text/plain' }
  const target = existsSync(full) && extname(full) ? full : join(distDir, 'index.html') // SPA 回退
  if (!existsSync(target)) return { status: 404, body: Buffer.from('not found'), type: 'text/plain' }
  return { status: 200, body: readFileSync(target), type: CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' }
}

/** 启动只读监控 HTTP 端点。port=0 让内核分配（测试用）。 */
export function startDashboard(opts: DashboardOpts): Promise<Server> {
  const { cacheRoot, port, token, distDir, getInFlight } = opts
  const deps: RouterDeps = {
    summary: () => {
      const now = Date.now()
      const { events } = new Ledger(join(cacheRoot, 'ledger.jsonl')).read(now - WINDOW_MS)
      let qsize = { pending: 0, dormant: 0 }
      try { qsize = new PrefetchQueue(join(cacheRoot, 'queue.json')).size() } catch { /* 无队列 */ }
      return buildSummary(events, qsize, now)
    },
    runs: (limit) => {
      const now = Date.now()
      const { events } = new Ledger(join(cacheRoot, 'ledger.jsonl')).read(now - WINDOW_MS)
      return { inFlight: getInFlight(), runs: buildRuns(events, limit) }
    },
    story: (id) => readStory(cacheRoot, id, Date.now()),
    queue: () => buildQueue(cacheRoot),
  }

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = decodeURIComponent(url.pathname)
      if (pathname.startsWith('/api/')) {
        const reqToken = url.searchParams.get('token') ?? (req.headers['x-dashboard-token'] as string | undefined)
        const query: Record<string, string> = {}
        url.searchParams.forEach((v, k) => { query[k] = v })
        const result = handleApiRoute({ pathname, query, token: reqToken ?? undefined }, deps, token)
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.json))
        return
      }
      const s = serveStatic(distDir, pathname)
      res.writeHead(s.status, { 'content-type': s.type })
      res.end(s.body)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
  return new Promise(resolve => server.listen(port, () => resolve(server)))
}
```

> 注:`api/runs/..%2f..` 经 `decodeURIComponent` 变 `/api/runs/../..`,`pathname.match(/^\/api\/runs\/([^/]+)$/)` 因含 `/` 不匹配 `runs/:id`,落到 404?测试要 400。修正:server 里对 `/api/` 分支解码前先判 `runs/:id`。**改用**:在 router 里对已解码的单段 id 判 `..`;此处 `%2f` 解码成 `/` 会让整体不匹配单段正则 → 返回 404。为满足 400 语义,在 server 的 static 前不解码 path 传给 router 之前,保留 `url.pathname`(未 decode)做匹配,再对捕获的 id 做 `decodeURIComponent` 后 `isSafeId`。见下修订。

- [ ] **Step 3b: 修订 path 处理以正确 400 路径穿越**

把 server 中 API 分支改为用**未解码** `url.pathname` 匹配,并把解码后的 id 交给 router 校验:

```ts
      const rawPath = url.pathname   // 未解码
      if (rawPath.startsWith('/api/')) {
        const reqToken = url.searchParams.get('token') ?? (req.headers['x-dashboard-token'] as string | undefined)
        const query: Record<string, string> = {}
        url.searchParams.forEach((v, k) => { query[k] = v })
        // runs/:id 的 id 单独解码后交给 router 的合法性校验（%2f→/ 会被 isSafeId 拒为 400）
        const m = rawPath.match(/^\/api\/runs\/(.+)$/)
        const pathname = m ? `/api/runs/${decodeURIComponent(m[1])}` : rawPath
        const result = handleApiRoute({ pathname, query, token: reqToken ?? undefined }, deps, token)
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.json))
        return
      }
      const s = serveStatic(distDir, decodeURIComponent(url.pathname))
```

router 的 `isSafeId` 已拒含 `/` 与 `..` 的 id → `..%2f..%2fpackage` 解码为 `../../package` → `isSafeId` false → 400。✔

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: PASS（4 项）

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "feat(dashboard): http server + static hosting + fs data wiring"
```

---

## Task 6: in-flight 暴露 + 接入 watch 循环

Watcher 内存态 → dashboard 的 `getInFlight`,并在 `cmdWatch` 起服务。

**Files:**
- Modify: `src/daemon/watcher.ts`（inFlight 携带 name;新增 `inFlightItems()`）
- Modify: `src/cli/index.ts`（cmdWatch 起 dashboard）
- Test: `src/daemon/watcher.test.ts`（补 inFlightItems 用例）

- [ ] **Step 1: 写失败测试**（追加到现有 watcher.test.ts）

```ts
// 追加至 src/daemon/watcher.test.ts —— 参照文件顶部现有 makeDeps/fixtures 写法
import { describe, it, expect } from 'vitest'
// （若文件已 import 这些则勿重复）

it('inFlightItems() reports currently-processing items with names', async () => {
  // 用一个会挂起的 runJob 观察 in-flight 窗口
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const w = makeWatcher({   // ← 复用文件内已有的 watcher 工厂/deps 构造；若无则内联构造 deps
    runJob: async () => { await gate; return { decision: 'download', journalPath: '/j', stats: { durationMs: 1, llmCalls: 0, apiCalls: 0 } } },
    getItem: async () => ({ Id: 'x1', Name: 'Overflow S1E1', Type: 'Episode', MediaStreams: [] }) as any,
  })
  const p = (w as any).maybeProcess('x1', 'queue')
  // 让出事件循环，等 maybeProcess 进入 runJob 挂起
  await new Promise(r => setTimeout(r, 0))
  const items = w.inFlightItems()
  expect(items).toEqual([{ itemId: 'x1', name: 'Overflow S1E1', source: 'queue' }])
  release(); await p
  expect(w.inFlightItems()).toEqual([])
})
```

> 说明给实现者:watcher.test.ts 顶部已有构造 `Watcher` 的辅助(参照现有 head-of-line / skip 用例的 deps 搭建方式)。复用它;上面 `makeWatcher` 是占位名,替换为文件里实际的构造方式,只需覆盖 `runJob` 与 `getItem`,其余 deps 用现有默认。断言目标不变:in-flight 期间 `inFlightItems()` 返回 `{itemId,name,source}`,完成后为空。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/daemon/watcher.test.ts`
Expected: FAIL（`inFlightItems is not a function`）

- [ ] **Step 3: 改 Watcher**

`src/daemon/watcher.ts`:把 `inFlight` 的值类型从 `'playback' | 'queue'` 改为携带 name:

```ts
  private inFlight = new Map<string, { source: 'playback' | 'queue'; name: string }>()
```

`maybeProcess` 入口设置(初始 name = itemId,拿到 item 后更新):

```ts
    this.inFlight.set(itemId, { source, name: itemId })
```

拿到 item 后(在 `const item = await this.deps.jellyfin.getItem(itemId)` 之后)补一行:

```ts
      this.inFlight.get(itemId)!.name = item.Name
```

`playbackBusy()` 内的遍历改为读 `.source`:

```ts
  private playbackBusy(): boolean {
    for (const v of this.inFlight.values()) if (v.source === 'playback') return true
    return false
  }
```

新增公开方法:

```ts
  /** 当前正在处理的条目（内存态，供只读监控展示真实 in-flight，不落盘、不伪造）。 */
  inFlightItems(): { itemId: string; name: string; source: 'playback' | 'queue' }[] {
    return [...this.inFlight.entries()].map(([itemId, v]) => ({ itemId, name: v.name, source: v.source }))
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/daemon/watcher.test.ts`
Expected: PASS（含新用例;既有用例不受影响——inFlight 仅内部用法变更）

- [ ] **Step 5: 接入 cmdWatch**

`src/cli/index.ts`:顶部加 import:

```ts
import { startDashboard } from '../dashboard/server.js'
```

在 `cmdWatch` 里、构造 `watcher` 之后、`for(;;)` 循环之前,插入:

```ts
  const dashPort = Number(process.env.DASHBOARD_PORT) || 0
  if (dashPort > 0) {
    const distDir = join(new URL('../..', import.meta.url).pathname, 'web', 'dist')
    await startDashboard({
      cacheRoot,
      port: dashPort,
      token: process.env.DASHBOARD_TOKEN || undefined,
      distDir,
      getInFlight: () => watcher.inFlightItems(),
    })
    console.log(`dashboard on http://0.0.0.0:${dashPort}${process.env.DASHBOARD_TOKEN ? ' (token required)' : ''}`)
  }
```

> `distDir`:运行期 `src/cli/index.ts` 位于 `<app>/src/cli/`,`../..` 回到 `<app>/`,拼 `web/dist`。生产镜像里 `web/dist` 与 `src` 同级(见 Task 12)。

- [ ] **Step 6: 类型检查 + 全量测试**

Run: `npm run check && npm test`
Expected: tsc 0 错;全部测试 PASS

- [ ] **Step 7: 提交**

```bash
git add src/daemon/watcher.ts src/daemon/watcher.test.ts src/cli/index.ts
git commit -m "feat(dashboard): expose watcher in-flight + start server in watch loop"
```

---

## Task 7: 前端脚手架(web/)

独立 Vite React 包 + 设计令牌 CSS(移植已批准样机,改桌面宽 master–detail)。

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/vitest.config.ts`, `web/src/main.tsx`, `web/src/styles.css`, `web/src/App.tsx`, `web/src/smoke.test.tsx`

- [ ] **Step 1: web/package.json**

```json
{
  "name": "subtitle-scout-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.3",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "jsdom": "^26.0.0",
    "typescript": "^6.0.3",
    "vite": "^7.0.0",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: 配置文件**

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()], build: { outDir: 'dist' } })
```

`web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/setupTests.ts'] },
})
```

`web/src/setupTests.ts`:
```ts
import '@testing-library/jest-dom'
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "jsx": "react-jsx", "strict": true, "skipLibCheck": true, "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

`web/index.html`:
```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>subtitle-scout</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 3: styles.css（移植样机 + 桌面 master–detail）**

```css
/* web/src/styles.css —— 设计令牌移植自已批准样机 dashboard-v2.html，布局改桌面宽 master–detail */
:root{
  --base:#0C0D0F; --card:#151619; --card2:#1a1c20; --line:#242629;
  --text:#F2F3F5; --muted:#9a9ea4; --faint:#63676c;
  --accent:#2DD4BF; --green:#54d883; --red:#e06c6c; --amber:#d8b054;
  --sans:-apple-system,'SF Pro Display','PingFang SC','Noto Sans SC',system-ui,sans-serif;
  --mono:'SF Mono',ui-monospace,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--base);color:var(--text);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.5}
.shell{max-width:1180px;margin:0 auto;padding:0 32px}
/* 顶栏 */
.bar{display:flex;align-items:center;justify-content:space-between;padding:24px 0 0}
.word{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:600;letter-spacing:.2px}
.word .d{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--accent),#1e9e8f);display:grid;place-items:center;color:#04211d;font-weight:800;font-size:13px}
.stat{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13.5px}
.live{width:7px;height:7px;border-radius:50%;background:var(--green);position:relative}
.live::after{content:'';position:absolute;inset:-4px;border-radius:50%;background:var(--green);opacity:.4;animation:p 2.4s infinite}
@keyframes p{0%{transform:scale(.5);opacity:.5}70%{transform:scale(2);opacity:0}100%{opacity:0}}
/* 冷峻大标题 */
.head{padding:40px 0 8px}
.head .big{font-size:34px;font-weight:600;letter-spacing:-.5px}
.head .big em{font-style:normal;color:var(--accent)}
.head .sub{color:var(--muted);font-size:15px;margin-top:8px}
/* master–detail 两栏 */
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:24px;padding:24px 0 8px;align-items:start}
@media (max-width:900px){ .grid{grid-template-columns:1fr} }
.slab{font-size:12.5px;color:var(--faint);font-weight:600;letter-spacing:.3px;margin:0 2px 12px}
/* 活动流 */
.feed{display:flex;flex-direction:column;gap:8px}
.item{background:var(--card);border-radius:14px;padding:14px 16px;display:flex;align-items:center;gap:13px;cursor:pointer;transition:.16s;border:1px solid transparent}
.item:hover{background:var(--card2)}
.item.sel{border-color:var(--line);background:var(--card2)}
.item.noclick{cursor:default}
.poster{width:34px;height:48px;border-radius:7px;background:linear-gradient(160deg,#2b3037,#191c20);flex-shrink:0}
.imeta{flex:1;min-width:0}
.ititle{font-size:15px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.iout{font-size:13px;color:var(--muted);margin-top:3px}
.iout.ok{color:var(--green)}
.iout.fail{color:var(--red)}
.iout.working{color:var(--accent)}
.itime{color:var(--faint);font-size:12px;font-family:var(--mono);flex-shrink:0}
.wdot{width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block;margin-right:6px;animation:p 1.3s infinite}
/* 故事面板 */
.panel{background:var(--card);border-radius:16px;padding:22px 24px;min-height:220px}
.panel.empty{display:grid;place-items:center;color:var(--faint);font-size:14px}
.ptitle{font-size:18px;font-weight:600}
.pout{font-size:14px;margin-top:6px}
.pout.ok{color:var(--green)} .pout.fail{color:var(--red)} .pout.muted{color:var(--muted)} .pout.skip{color:var(--muted)}
.steps{position:relative;padding-left:24px;margin-top:18px}
.st{position:relative;padding:9px 0}
.st::before{content:'';position:absolute;left:6px;top:20px;bottom:-2px;width:2px;background:var(--line)}
.st:last-child::before{display:none}
.sn{position:absolute;left:0;top:2px;width:14px;height:14px;border-radius:50%;border:2px solid var(--green);background:var(--card2);display:grid;place-items:center}
.sn.fail{border-color:var(--red)}
.sn svg{width:8px;height:8px;stroke:var(--green);stroke-width:3;fill:none}
.sn.fail svg{stroke:var(--red)}
.sttl{font-size:14px;font-weight:500}
.sre{font-size:13px;color:var(--muted);margin-top:2px}
.peek{margin-top:16px;font-size:12.5px;color:var(--faint);cursor:pointer;user-select:none}
.raw{margin-top:10px;background:#0f1012;border-radius:10px;padding:12px 14px;max-height:280px;overflow:auto;font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:pre-wrap}
/* 次级链接 */
.foot{display:flex;gap:24px;padding:28px 0 40px;color:var(--faint);font-size:13px}
.foot button{background:none;border:none;color:var(--faint);font:inherit;cursor:pointer}
.foot button:hover{color:var(--muted)}
.foot button.on{color:var(--accent)}
/* 队列次级视图 */
.qlist{display:flex;flex-direction:column;gap:6px;padding:8px 0 0}
.qrow{display:flex;justify-content:space-between;background:var(--card);border-radius:10px;padding:10px 14px;font-size:13.5px}
.qrow .qs{color:var(--faint);font-size:12.5px}
```

- [ ] **Step 4: main.tsx + 占位 App + 冒烟测试**

`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
```

`web/src/App.tsx`（占位，Task 10 补全）:
```tsx
export function App() {
  return <div className="shell"><div className="head"><div className="big">subtitle-scout</div></div></div>
}
```

`web/src/smoke.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { App } from './App.js'
it('renders app shell', () => {
  render(<App />)
  expect(screen.getByText('subtitle-scout')).toBeInTheDocument()
})
```

- [ ] **Step 5: 装依赖 + 跑冒烟测试 + 构建**

```bash
cd web && npm install
npx vitest run
npm run build
```
Expected: 冒烟测试 PASS;`web/dist/index.html` 生成

- [ ] **Step 6: 提交**

```bash
cd .. && git add web/ && git commit -m "feat(web): scaffold Vite React SPA + design tokens"
```

---

## Task 8: 前端 API 客户端 + 轮询 hook

**Files:**
- Create: `web/src/api/types.ts`, `web/src/api/client.ts`, `web/src/api/useDashboard.ts`
- Test: `web/src/api/useDashboard.test.tsx`

- [ ] **Step 1: types.ts（复制后端 DTO，故意跨 package 重复）**

```ts
// web/src/api/types.ts —— 必须与 src/dashboard/types.ts 保持一致
export type Tone = 'ok' | 'muted' | 'skip' | 'fail'
export interface SummaryDTO { status: 'running'; todayReady: number; totalReady: number; queuePending: number; queueDormant: number; runsInWindow: number; windowHours: number }
export interface InFlightItemDTO { itemId: string; name: string; source: string }
export interface RunDTO { id: string; itemId: string; name: string; decision: string; outcomeLabel: string; tone: Tone; ts: number; clickable: boolean }
export interface RunsDTO { inFlight: InFlightItemDTO[]; runs: RunDTO[] }
export interface StoryStepDTO { title: string; detail: string; state: 'done' | 'fail' }
export interface StoryDTO { name: string; decision: string; outcomeLabel: string; tone: Tone; ts: number; steps: StoryStepDTO[]; raw: { pipelineSteps: { name: string; at: string; data?: unknown }[]; llmCalls: { point: string; durationMs: number; prompt: string; parsed: unknown }[] } }
export interface QueueItemDTO { itemId: string; name: string; statusLabel: string; nextRetryAt: number | null }
export interface QueueDTO { pending: QueueItemDTO[]; dormant: QueueItemDTO[] }
```

- [ ] **Step 2: client.ts（token 从自身 URL query 透传）**

```ts
// web/src/api/client.ts
import type { SummaryDTO, RunsDTO, StoryDTO, QueueDTO } from './types.js'

const token = () => new URLSearchParams(location.search).get('token')
function q(path: string): string {
  const t = token()
  return t ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : path
}
async function get<T>(path: string): Promise<T> {
  const res = await fetch(q(path))
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}
export const api = {
  summary: () => get<SummaryDTO>('/api/summary'),
  runs: () => get<RunsDTO>('/api/runs'),
  story: (id: string) => get<StoryDTO>(`/api/runs/${encodeURIComponent(id)}`),
  queue: () => get<QueueDTO>('/api/queue'),
}
```

- [ ] **Step 3: useDashboard.ts（轮询 summary+runs）**

```ts
// web/src/api/useDashboard.ts
import { useEffect, useState, useCallback } from 'react'
import { api } from './client.js'
import type { SummaryDTO, RunsDTO } from './types.js'

const POLL_MS = 12_000

export function useDashboard() {
  const [summary, setSummary] = useState<SummaryDTO | null>(null)
  const [runs, setRuns] = useState<RunsDTO | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.summary(), api.runs()])
      setSummary(s); setRuns(r); setError(null)
    } catch (e) { setError(String(e)) }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { summary, runs, error, refresh }
}
```

- [ ] **Step 4: 写测试（mock fetch）**

```tsx
// web/src/api/useDashboard.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { vi, afterEach } from 'vitest'
import { useDashboard } from './useDashboard.js'

function Probe() {
  const { summary, runs } = useDashboard()
  return <div>{summary ? `today ${summary.todayReady}` : 'loading'}{runs ? ` runs ${runs.runs.length}` : ''}</div>
}
afterEach(() => vi.restoreAllMocks())

it('loads summary + runs on mount', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes('summary')
      ? { status: 'running', todayReady: 7, totalReady: 7, queuePending: 0, queueDormant: 0, runsInWindow: 1, windowHours: 168 }
      : { inFlight: [], runs: [{ id: 'a', itemId: 'i', name: 'X', decision: 'download', outcomeLabel: 'ok', tone: 'ok', ts: 1, clickable: true }] },
  })) as any)
  render(<Probe />)
  await waitFor(() => expect(screen.getByText('today 7 runs 1')).toBeInTheDocument())
})
```

- [ ] **Step 5: 跑测试**

```bash
cd web && npx vitest run src/api/useDashboard.test.tsx
```
Expected: PASS

- [ ] **Step 6: 提交**

```bash
cd .. && git add web/src/api && git commit -m "feat(web): api client + polling hook"
```

---

## Task 9: 组件(TopBar / SummaryHeader / ActivityFeed / StoryPanel)

**Files:**
- Create: `web/src/components/TopBar.tsx`, `SummaryHeader.tsx`, `ActivityFeed.tsx`, `StoryPanel.tsx`, `relTime.ts`
- Test: `web/src/components/ActivityFeed.test.tsx`, `StoryPanel.test.tsx`

- [ ] **Step 1: relTime.ts + TopBar + SummaryHeader**

`web/src/components/relTime.ts`:
```ts
export function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return '刚刚'
  const m = Math.floor(s / 60); if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60); if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
```

`web/src/components/TopBar.tsx`:
```tsx
export function TopBar() {
  return (
    <div className="bar">
      <div className="word"><div className="d">S</div>subtitle-scout</div>
      <div className="stat"><span className="live" />运行中</div>
    </div>
  )
}
```

`web/src/components/SummaryHeader.tsx`:
```tsx
import type { SummaryDTO } from '../api/types.js'
export function SummaryHeader({ s }: { s: SummaryDTO | null }) {
  if (!s) return <div className="head"><div className="big">正在读取…</div></div>
  return (
    <div className="head">
      <div className="big">今天下好了 <em>{s.todayReady}</em> 部字幕</div>
      <div className="sub">{s.queuePending} 部在排队等待 · 后台持续留意新入库</div>
    </div>
  )
}
```

- [ ] **Step 2: ActivityFeed.tsx**

```tsx
// web/src/components/ActivityFeed.tsx
import type { RunsDTO, RunDTO } from '../api/types.js'
import { relTime } from './relTime.js'

interface Props { data: RunsDTO | null; now: number; selectedId: string | null; onSelect: (r: RunDTO) => void }

export function ActivityFeed({ data, now, selectedId, onSelect }: Props) {
  if (!data) return <div className="feed"><div className="slab">最近</div></div>
  return (
    <div>
      <div className="slab">最近</div>
      <div className="feed">
        {data.inFlight.map(it => (
          <div className="item working noclick" key={`f-${it.itemId}`}>
            <div className="poster" />
            <div className="imeta">
              <div className="ititle">{it.name}</div>
              <div className="iout working"><span className="wdot" />正在找字幕…</div>
            </div>
            <div className="itime">进行中</div>
          </div>
        ))}
        {data.runs.map(r => (
          <div
            key={`r-${r.id || r.itemId}-${r.ts}`}
            className={`item${r.clickable ? '' : ' noclick'}${selectedId === r.id && r.id ? ' sel' : ''}`}
            onClick={() => r.clickable && onSelect(r)}
          >
            <div className="poster" />
            <div className="imeta">
              <div className="ititle">{r.name}</div>
              <div className={`iout ${r.tone}`}>{r.tone === 'ok' ? '✓ ' : ''}{r.outcomeLabel}</div>
            </div>
            <div className="itime">{relTime(r.ts, now)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: StoryPanel.tsx**

```tsx
// web/src/components/StoryPanel.tsx
import { useState } from 'react'
import type { StoryDTO } from '../api/types.js'

const Check = ({ fail }: { fail: boolean }) => (
  <div className={`sn${fail ? ' fail' : ''}`}>
    {fail
      ? <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
      : <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>}
  </div>
)

export function StoryPanel({ story, loading }: { story: StoryDTO | null; loading: boolean }) {
  const [showRaw, setShowRaw] = useState(false)
  if (loading) return <div className="panel empty">读取运行详情…</div>
  if (!story) return <div className="panel empty">选择左侧一次运行，查看它的工作过程</div>
  return (
    <div className="panel">
      <div className="ptitle">{story.name}</div>
      <div className={`pout ${story.tone}`}>{story.tone === 'ok' ? '✓ ' : ''}{story.outcomeLabel}</div>
      <div className="steps">
        {story.steps.map((st, i) => (
          <div className="st" key={i}>
            <Check fail={st.state === 'fail'} />
            <div className="sttl">{st.title}</div>
            <div className="sre">{st.detail}</div>
          </div>
        ))}
      </div>
      <div className="peek" onClick={() => setShowRaw(v => !v)}>
        {showRaw ? '▾ 收起原始细节' : '▸ 想看它每一步的原始细节？点这里'}
      </div>
      {showRaw && (
        <div className="raw">{JSON.stringify({ steps: story.raw.pipelineSteps, llm: story.raw.llmCalls }, null, 2)}</div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 组件测试**

`web/src/components/ActivityFeed.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { ActivityFeed } from './ActivityFeed.js'
import type { RunsDTO } from '../api/types.js'

const data: RunsDTO = {
  inFlight: [{ itemId: 'w', name: 'Overflow S1E2', source: 'queue' }],
  runs: [
    { id: 'a-1', itemId: 'a', name: '招魂', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1000, clickable: true },
    { id: '', itemId: 'b', name: '寻踪迷镇', decision: 'no_safe_match', outcomeLabel: '暂时没找到合适的中文字幕', tone: 'muted', ts: 900, clickable: false },
  ],
}

it('shows in-flight working row + plain-language outcomes, no jargon', () => {
  render(<ActivityFeed data={data} now={2000} selectedId={null} onSelect={() => {}} />)
  expect(screen.getByText('正在找字幕…')).toBeInTheDocument()
  expect(screen.getByText('✓ 已下好中文字幕')).toBeInTheDocument()
  expect(screen.getByText('暂时没找到合适的中文字幕')).toBeInTheDocument()
  expect(screen.queryByText(/no_safe_match|升格|gate|映射/)).toBeNull()
})

it('fires onSelect only for clickable runs', () => {
  const onSelect = vi.fn()
  render(<ActivityFeed data={data} now={2000} selectedId={null} onSelect={onSelect} />)
  fireEvent.click(screen.getByText('招魂'))
  fireEvent.click(screen.getByText('寻踪迷镇'))
  expect(onSelect).toHaveBeenCalledTimes(1)
})
```

`web/src/components/StoryPanel.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { StoryPanel } from './StoryPanel.js'
import type { StoryDTO } from '../api/types.js'

const story: StoryDTO = {
  name: 'Overflow · 第 1 季', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1,
  steps: [
    { title: '认出这部片', detail: 'Overflow', state: 'done' },
    { title: '去字幕站找了一圈', detail: '找到一份覆盖整季的字幕（共 8 集）', state: 'done' },
    { title: '挑了最靠谱的那份', detail: '简体中文 · 跟你的片子对得上', state: 'done' },
    { title: '下好并放到位', detail: '8 集字幕全部就位，Jellyfin 里已经能看了', state: 'done' },
  ],
  raw: { pipelineSteps: [{ name: 'seasonGraduate', at: 't' }], llmCalls: [{ point: 'identify', durationMs: 12, prompt: 'P', parsed: {} }] },
}

it('renders empty state, then story steps, then toggles raw tier-2', () => {
  const { rerender } = render(<StoryPanel story={null} loading={false} />)
  expect(screen.getByText(/选择左侧一次运行/)).toBeInTheDocument()
  rerender(<StoryPanel story={story} loading={false} />)
  expect(screen.getByText('下好并放到位')).toBeInTheDocument()
  expect(screen.getByText(/8 集字幕全部就位/)).toBeInTheDocument()
  expect(screen.queryByText(/seasonGraduate/)).toBeNull()          // tier-2 默认隐藏
  fireEvent.click(screen.getByText(/原始细节/))
  expect(screen.getByText(/seasonGraduate/)).toBeInTheDocument()   // 展开后可见
})
```

- [ ] **Step 5: 跑测试**

```bash
cd web && npx vitest run src/components
```
Expected: PASS

- [ ] **Step 6: 提交**

```bash
cd .. && git add web/src/components && git commit -m "feat(web): topbar, summary, activity feed, story panel"
```

---

## Task 10: App 组装(master–detail + 次级视图)

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// web/src/App.test.tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { vi, afterEach } from 'vitest'
import { App } from './App.js'

const summary = { status: 'running', todayReady: 3, totalReady: 3, queuePending: 2, queueDormant: 0, runsInWindow: 3, windowHours: 168 }
const runs = { inFlight: [], runs: [{ id: 'a-1', itemId: 'a', name: '招魂', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1000, clickable: true }] }
const story = { name: '招魂', decision: 'download', outcomeLabel: '已下好中文字幕', tone: 'ok', ts: 1000,
  steps: [{ title: '认出这部片', detail: '招魂', state: 'done' }], raw: { pipelineSteps: [], llmCalls: [] } }

afterEach(() => vi.restoreAllMocks())
function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () =>
      url.includes('/api/summary') ? summary :
      url.includes('/api/runs/a-1') ? story :
      url.includes('/api/runs') ? runs :
      { pending: [], dormant: [] },
  })) as any)
}

it('shows summary + feed, and loads story on feed click', async () => {
  mockFetch()
  render(<App />)
  await waitFor(() => expect(screen.getByText(/今天下好了/)).toBeInTheDocument())
  expect(screen.getByText('招魂')).toBeInTheDocument()
  expect(screen.getByText(/选择左侧一次运行/)).toBeInTheDocument()   // 未选时空态
  fireEvent.click(screen.getByText('招魂'))
  await waitFor(() => expect(screen.getByText('认出这部片')).toBeInTheDocument())
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd web && npx vitest run src/App.test.tsx
```
Expected: FAIL（占位 App 无这些文本）

- [ ] **Step 3: 实现 App.tsx**

```tsx
// web/src/App.tsx
import { useEffect, useState } from 'react'
import { useDashboard } from './api/useDashboard.js'
import { api } from './api/client.js'
import type { RunDTO, StoryDTO, QueueDTO } from './api/types.js'
import { TopBar } from './components/TopBar.js'
import { SummaryHeader } from './components/SummaryHeader.js'
import { ActivityFeed } from './components/ActivityFeed.js'
import { StoryPanel } from './components/StoryPanel.js'

export function App() {
  const { summary, runs } = useDashboard()
  const [selected, setSelected] = useState<RunDTO | null>(null)
  const [story, setStory] = useState<StoryDTO | null>(null)
  const [loadingStory, setLoadingStory] = useState(false)
  const [tab, setTab] = useState<'feed' | 'queue'>('feed')
  const [queue, setQueue] = useState<QueueDTO | null>(null)
  const now = Date.now()

  const onSelect = async (r: RunDTO) => {
    setSelected(r); setStory(null); setLoadingStory(true)
    try { setStory(await api.story(r.id)) } catch { setStory(null) } finally { setLoadingStory(false) }
  }

  useEffect(() => {
    if (tab === 'queue' && !queue) api.queue().then(setQueue).catch(() => setQueue({ pending: [], dormant: [] }))
  }, [tab, queue])

  return (
    <div className="shell">
      <TopBar />
      <SummaryHeader s={summary} />

      {tab === 'feed' ? (
        <div className="grid">
          <ActivityFeed data={runs} now={now} selectedId={selected?.id ?? null} onSelect={onSelect} />
          <StoryPanel story={story} loading={loadingStory} />
        </div>
      ) : (
        <QueueView q={queue} />
      )}

      <div className="foot">
        <button className={tab === 'feed' ? 'on' : ''} onClick={() => setTab('feed')}>最近</button>
        <button className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>
          队列 {summary ? summary.queuePending : ''}
        </button>
      </div>
    </div>
  )
}

function QueueView({ q }: { q: QueueDTO | null }) {
  if (!q) return <div className="qlist"><div className="slab">队列</div>读取中…</div>
  const all = [...q.pending, ...q.dormant]
  return (
    <div>
      <div className="slab" style={{ marginTop: 16 }}>队列 · {all.length} 部等待中</div>
      <div className="qlist">
        {all.length === 0 && <div className="qrow">队列是空的，一切都跟上了</div>}
        {all.map(it => (
          <div className="qrow" key={it.itemId}>
            <span>{it.name}</span><span className="qs">{it.statusLabel}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量前端测试 + 构建**

```bash
cd web && npx vitest run && npm run build
```
Expected: 全部 PASS;`web/dist` 构建成功

- [ ] **Step 5: 提交**

```bash
cd .. && git add web/src/App.tsx web/src/App.test.tsx && git commit -m "feat(web): master-detail app shell + queue secondary view"
```

---

## Task 11: Docker 多阶段 + compose + deploy + 文档

**Files:**
- Modify: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `deploy/deploy.sh`, `README.md`, `docs/superpowers/specs/2026-07-08-dashboard-design.md`

- [ ] **Step 1: Dockerfile 多阶段（构建 web/dist，最终镜像含 src + web/dist + 生产依赖）**

```dockerfile
# Dockerfile
# 阶段 1：构建前端静态资源
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# 阶段 2：运行时（tsx 跑后端，托管 web/dist）
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=web /web/dist ./web/dist
ENV NODE_ENV=production
CMD ["npx", "tsx", "src/cli/index.ts", "watch"]
```

> `startDashboard` 的 `distDir` 在 Task 6 解析为 `<app>/web/dist`——与此处 COPY 目标一致。

- [ ] **Step 2: .dockerignore（放行 web 源，排除其 node_modules/dist）**

在 `.dockerignore` 追加两行(现有内容保留):

```
web/node_modules
web/dist
```

> 现有 `.dockerignore` 无 `web` 条目,故 web 源默认进构建上下文;上面两行排除其本地产物,让阶段 1 干净构建。

- [ ] **Step 3: docker-compose.yml（加端口 + env）**

在 `subtitle-scout` service 的 `environment:` 下加:

```yaml
      DASHBOARD_PORT: ${DASHBOARD_PORT:-8099}
      DASHBOARD_TOKEN: ${DASHBOARD_TOKEN:-}
```

并给该 service 加 `ports`(与 `environment`/`volumes` 同级):

```yaml
    ports:
      - "${DASHBOARD_PORT:-8099}:${DASHBOARD_PORT:-8099}"
```

- [ ] **Step 4: deploy.sh（rsync 带上 web 源）**

在 `deploy/deploy.sh` 的 rsync `--include` 列表中,`--exclude='*'` 之前加一行 web 源(排除本地 node_modules/dist):

```bash
  --include='web/' --include='web/src/***' --include='web/package.json' \
  --include='web/index.html' --include='web/vite.config.ts' --include='web/tsconfig.json' \
```

> 只送 web 源与配置,router 上 Docker 阶段 1 现装现构建。`web/node_modules`、`web/dist` 不进 `--include` 即被 `--exclude='*'` 拦下。

- [ ] **Step 5: README + spec 补一段**

在 `README.md` 末尾加一节:

```markdown
## 监控页（可选）

设 `DASHBOARD_PORT`(compose 默认 8099)后,`watch` 进程会在该端口起一个只读监控页:
一眼看到今天下好多少字幕、最近每部片的结果,点开任一次运行可看 agent 的 4 步工作过程。
可选 `DASHBOARD_TOKEN`:设了则需带 `?token=<值>` 访问(家庭 LAN 低风险,给个开关)。
访问:`http://<host>:8099/`(设了 token 则 `http://<host>:8099/?token=<值>`)。
```

在 spec `docs/superpowers/specs/2026-07-08-dashboard-design.md` 末尾"影响面"段后追加一行:

```markdown
实现计划:`docs/superpowers/plans/2026-07-08-dashboard.md`。
```

- [ ] **Step 6: 本地构建自检(不部署)**

```bash
docker build -t scout-dash-check . 2>&1 | tail -5
```
Expected: `naming to docker.io/library/scout-dash-check` 成功(阶段 1 构建 web、阶段 2 拷 dist 无误)。若本机无 docker,跳过并在 Task 12 由 controller 在 router 上验证。

- [ ] **Step 7: 提交**

```bash
git add Dockerfile .dockerignore docker-compose.yml deploy/deploy.sh README.md docs/superpowers/specs/2026-07-08-dashboard-design.md
git commit -m "build(dashboard): multi-stage web build, compose port, deploy web source"
```

---

## Task 12: Controller 真实验证 + 部署 + 合并（主循环执行）

**由主循环(持凭据)执行,非子代理。**

- [ ] **Step 1: 全量测试 + 类型检查**

```bash
npm run check && npm test && (cd web && npx vitest run)
```
Expected: 后端 tsc 0 错、后端全测 PASS、前端全测 PASS。

- [ ] **Step 2: 部署到软路由**

```bash
bash deploy/deploy.sh
```
Expected: rsync 成功、router 上 `docker compose build`(含 web 阶段)+ `up -d` 成功、`docker compose ps` 显示 subtitle-scout Up。
> 注意 CF 隧道对大输出偶发瞬断("Connection closed"),重跑即可;必要时分步 ssh。确认 `.env` 里已配 `DASHBOARD_PORT`(如 8099),需要鉴权则配 `DASHBOARD_TOKEN`。

- [ ] **Step 3: 用 verify skill 做运行期验证**

调用 `verify` skill,在浏览器打开 `http://<router-host>:<DASHBOARD_PORT>/`(带 token 则附 `?token=`),逐条核对:
1. **首屏平静**:顶栏"● 运行中"、冷峻大标题(今天下好 N 部)、左活动流 + 右故事面板并排(桌面宽,非窄栏)。
2. **活动流人话正确**:每行是"✓ 已下好中文字幕 / 暂时没找到合适字幕 / 本来就有字幕,跳过"等,**无任何内部术语**(升格/gate/映射/no_safe_match/pipeline 步名)。
3. **点开一次成功运行**(优先此前 Overflow 整季那次,若仍在 90 天 journal 保留内)→ 右面板显示 4 步故事,整季场景含"覆盖整季的字幕(共 8 集)""8 集字幕全部就位"。
4. **Tier-2**:点"▸ 原始细节"展开显示真实管线步/llm(等宽、限高、静音色);默认收起。
5. **in-flight**(若正好有条目在处理)显示"正在找字幕…"脉冲;完成态是静态绿勾,无伪造 spinner。
6. **/api/runs/坏id** 返回 400/404,不泄漏文件路径;设了 token 时无 token 访问 /api/summary 返回 401。
7. **队列次级视图**:点底部"队列 N"切换,列出等待条目 + 人话状态。

用 verify skill 的 PASS/FAIL 结构报告,附首屏截图 + 一次故事展开截图 + 一次 API JSON 响应。

- [ ] **Step 4: 修正验证暴露的问题**（若有）

若发现术语泄漏、布局窄、故事步不对等,回到对应 Task 修复→重测→重新部署,直至 Step 3 全绿。

- [ ] **Step 5: 收尾合并**

用 `finishing-a-development-branch` skill:验证 `npm test` + 前端测试全绿 → 选"合并回 main 本地" → 合并 dashboard 分支 → 删分支。合并后 `bash deploy/deploy.sh` 确认生产运行最新。

- [ ] **Step 6: 更新记忆**

更新 `~/.claude/projects/.../memory/project-subtitle-scout-status.md`(dashboard 已交付上线)与 `compact-resume-dashboard.md`(标记完成,下一步指向开源就绪 backlog)。

---

## 本计划不做（YAGNI / 留后续）

- **Recharts 图表 / 统计页(决策分布 donut、趋势 area)**:spec 明确降级为次级、非首屏;为守"第一眼做减法"MVP 先不做,后续单独一版加。
- **shadcn/ui、Tailwind**:MVP 用纯 CSS(移植已批准样机)即达同等观感,少一堆构建配置面。
- **自托管 Noto Sans SC 子集 woff2**:MVP 用系统字体栈(`PingFang SC`/`Noto Sans SC` fallback,受众多为 macOS/Windows 自带 CJK),honor"禁 CDN";子集内嵌留 v2 打磨。
- **live SSE 流式逐步**:MVP 回放 + 12s 轮询;"边跑边看每一步"留 v2。
- **"▷ 重放"再动画按钮、设置编辑 UI、多用户鉴权**:spec 已划出范围外。
- **ledger schema 变更**:不加 coveredEpisodes 字段;整季集数从 story 读 journal 现算,保后端核心零改动。

---

## Self-Review（写完自检）

**Spec 覆盖**:
- 技术形态(Vite React 静态 SPA + daemon HTTP + JSON API 复用 report/Ledger/queue)→ Task 1–7、11。✔(report.ts 的 formatReport 是 CLI 专用文本格式;dashboard 复用的是底层 Ledger.read/PrefetchQueue,聚合逻辑在 api.ts 重写为 JSON——与 spec"复用 report.ts 聚合逻辑"意图一致,底层数据源同源。)
- 视觉方向(暗色 #0C0D0F、teal #2DD4BF、光影分层)→ Task 7 styles.css。✔
- 简洁哲学①渐进披露 → 首屏仅顶栏+标题+feed+故事+次级链接,图表不做;②零黑话 → labels.ts + 三处 no-jargon 断言(Task 1/3/9);③冷峻文案 → 标签与故事文案已去暖萌;④桌面 master–detail → grid 两栏 1180px,900px 以下收单列。✔
- Hero 4 步故事 + Tier-2 → Task 3(后端)+ Task 9 StoryPanel。✔
- in-flight 真实态不伪造 → Task 6 getInFlight + Task 9 working 行(完成态静态绿勾)。✔
- MVP=回放、无 SSE、无重放按钮 → 本计划不做已列。✔
- 数据与 API(summary/runs/runs:id/queue + 人话映射服务端 + 坏行/缺文件容错 + 可选 token)→ Task 2/3/4/5。✔(Ledger.read 已跳坏行;readStory 缺文件返回 null。)
- 测试(前端组件态 + 后端 handler + token + 容错;controller 真实核对)→ 每 Task 均含 + Task 12。✔

**占位扫描**:无 TBD/TODO;每步含完整代码或确切命令。✔

**类型一致**:`Tone`/`SummaryDTO`/`RunDTO`/`RunsDTO`/`StoryDTO`/`StoryStepDTO`/`QueueDTO`/`QueueItemDTO`/`InFlightItemDTO` 在 `src/dashboard/types.ts`(Task 4)定义,前端 `web/src/api/types.ts`(Task 8)镜像;`handleApiRoute`/`RouterDeps`/`startDashboard`/`DashboardOpts`/`inFlightItems()` 签名跨 Task 一致;`buildSummary(events,queue,now)`/`buildRuns(events,limit)`/`buildRunStory(journal,ledger)` 三处调用点(server.ts)与定义一致。✔

**已知取舍(实现者留意)**:
- Task 1 Step 4 的 `Tone` 内联→Task 4 改回 import,是刻意的两步(让 labels 测试先独立通过)。
- server.ts 直读 `queue.json` 的 `entries`(PrefetchQueue 未导出条目访问器);若后续给 PrefetchQueue 加 `entries()` 访问器更佳,但 MVP 直读可接受(格式稳定、坏文件已 try/catch)。
