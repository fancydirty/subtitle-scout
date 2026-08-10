# subtitle-scout Milestone 1: CLI Golden Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per user request, coding tasks are executed by **sonnet-5 subagents**.

**Goal:** 给定一个 MediaContext JSON，跑通「LLM 识别媒体 → 缓存 → LLM 搜索策略 → ASSRT 搜索 → LLM 候选排序 → 纯代码 gate → 下载 → 解压/转码 → Jellyfin 命名落盘 → decision.json」全链路 CLI。

**Architecture:** 固定流水线状态机（纯代码）+ 3 个 LLM 结构化判断点（AI SDK tool 强制模式，绝不用 json_schema mode——MiMo 会静默忽略）。LLM 只输出 decision，执行全在 orchestrator；下载/写盘不作为 tool 暴露。依赖注入使 pipeline 可用 fake 测试。

**Tech Stack:** Node 22, TypeScript strict (NodeNext), `ai@^7` + `@ai-sdk/openai-compatible@^3`, `zod@^4`, `adm-zip`, `chardet` + `iconv-lite`, `vitest@^4`, `tsx`, `dotenv`.

**Spec:** `docs/superpowers/specs/2026-07-06-milestone1-cli-golden-path-design.md`

**关键已实测事实（子代理必读）：**

1. MiMo (`mimo-v2.5`) 的 `response_format: json_schema` **静默忽略 schema**。结构化输出必须走 tool 强制调用（`toolChoice: { type: 'tool', toolName }`）。
2. mimo-v2.5 是 reasoning 模型：先产 `reasoning_content` 再产正文/tool call。`maxOutputTokens` 必须 ≥ 4000。
3. ASSRT search 响应里 `filelist` 字段可能是 `{}`（空对象）也可能是 `[{s,f}]` 数组。schema 两种都要接受。
4. ASSRT detail 的 `filelist` 每项含时效 `url`；**永不缓存 URL**，只缓存下载后的文件。
5. ASSRT 全部响应先看 JSON `status`（0 = 成功），HTTP 码不可靠。
6. 实测配额 5 次/分钟 → 客户端限速 4 次/分钟。
7. 真实响应样例在 `fixtures/assrt/`（Task 1 会从 scratch 拷入）。测试类型时照着真数据写，不要脑补字段。

---

## File Structure

```
src/
├── core/
│   ├── schemas.ts        # 全部 Zod schema + 推断类型（唯一类型来源）
│   ├── schemas.test.ts
│   ├── cache.ts          # DecisionCache：本地 JSON 文件正/负缓存
│   ├── cache.test.ts
│   ├── journal.ts        # Journal：步骤/LLM 调用/API 调用审计，写 decision.json
│   ├── journal.test.ts
│   ├── gate.ts           # 纯函数硬校验 agent 输出
│   ├── gate.test.ts
│   ├── pipeline.ts       # runPipeline(deps, context) 状态机
│   └── pipeline.test.ts
├── agent/
│   ├── llm.ts            # makeModel() + callStructured()（tool 强制 + 重试）
│   ├── llm.test.ts
│   ├── identifyMedia.ts  # 判断点①（prompt + callStructured 薄封装）
│   ├── planSearch.ts     # 判断点②
│   └── rankCandidates.ts # 判断点③
├── adapters/
│   ├── providers/
│   │   ├── assrt.ts      # AssrtClient + RateLimiter + 响应磁盘缓存
│   │   └── assrt.test.ts
│   └── download/
│       ├── direct.ts     # downloadDirect(url) + 重试
│       └── direct.test.ts
├── files/
│   ├── subtitleWriter.ts # zip/编码/命名/落盘
│   └── subtitleWriter.test.ts
└── cli/
    └── index.ts          # run --context x.json --out ./out
worker/                   # 封存的 CF Worker（从根目录移入）
fixtures/
├── contexts/matrix.json
└── assrt/{search-matrix.json, detail-673114.json}
scripts/e2e-smoke.sh      # 手动端到端（真 API）
```

每个文件一个职责；测试与源码同目录。`schemas.ts` 是唯一类型来源，其他文件只 import 推断类型，杜绝签名漂移。

---

### Task 1: 仓库重组 + 工具链

**Files:**
- Move: `src/index.ts` → `worker/src/index.ts`, `src/worker-configuration.d.ts` → `worker/src/worker-configuration.d.ts`, `wrangler.jsonc` → `worker/wrangler.jsonc`
- Modify: `package.json`, `tsconfig.json`
- Create: `worker/tsconfig.json`, `vitest.config.ts`, `.env.example`, `fixtures/contexts/matrix.json`, `fixtures/assrt/`（拷贝）

- [ ] **Step 1: 移动 worker 文件**

```bash
mkdir -p worker/src fixtures/contexts fixtures/assrt scripts
git mv src/index.ts worker/src/index.ts
git mv src/worker-configuration.d.ts worker/src/worker-configuration.d.ts
git mv wrangler.jsonc worker/wrangler.jsonc
cp scratch/assrt-smoke/search-matrix.json fixtures/assrt/search-matrix.json
cp scratch/assrt-smoke/detail-673114.json fixtures/assrt/detail-673114.json
```

注意检查 `worker/wrangler.jsonc` 里的 `main` 字段路径改为 `src/index.ts`（相对 worker/ 目录）。

- [ ] **Step 2: 重写 package.json**

```json
{
  "name": "subtitle-scout",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "check": "tsc --noEmit",
    "test": "vitest run",
    "cli": "tsx src/cli/index.ts",
    "worker:deploy": "wrangler deploy -c worker/wrangler.jsonc",
    "worker:dev": "wrangler dev -c worker/wrangler.jsonc"
  }
}
```

然后安装依赖（会重建 dependencies/devDependencies 字段）：

```bash
npm i ai @ai-sdk/openai-compatible zod adm-zip chardet iconv-lite dotenv
npm i -D typescript tsx vitest @types/node @types/adm-zip wrangler @cloudflare/workers-types
```

- [ ] **Step 3: tsconfig 拆分**

根 `tsconfig.json`（只管 src/）：

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`worker/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 4: .env.example 与 fixture context**

`.env.example`：

```
LLM_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
LLM_API_KEY=
LLM_MODEL=mimo-v2.5
ASSRT_TOKEN=
AUTO_DOWNLOAD_MIN_CONFIDENCE=0.86
SUBTITLE_SCOUT_CACHE_DIR=
```

`fixtures/contexts/matrix.json`：

```json
{
  "request_id": "fixture-matrix-001",
  "trigger": "manual_search",
  "media": {
    "type": "movie",
    "path": "/media/Movies/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264.mkv",
    "filename": "The.Matrix.1999.1080p.BluRay.x264.mkv",
    "title": "The Matrix",
    "original_title": "The Matrix",
    "year": 1999,
    "season": null,
    "episode": null,
    "runtime_minutes": 136,
    "provider_ids": { "imdb": "tt0133093", "tmdb": "603" },
    "production_locations": ["US", "AU"],
    "existing_subtitles": [{ "language": "eng", "format": "srt", "source": "external" }]
  },
  "preferences": {
    "language": "zh-Hans",
    "prefer_bilingual": true,
    "allow_traditional": true,
    "allow_machine_translated": false,
    "auto_download_min_confidence": 0.86
  }
}
```

- [ ] **Step 5: 验证 + 提交**

Run: `npm run check && npx tsc --noEmit -p worker && npm test`
Expected: check 通过；vitest 报 "No test files found"（还没有测试，退出码非零没关系，本步只看 tsc）。

```bash
git add -A && git commit -m "chore: restructure repo for subtitle-scout sidecar, park worker code"
```

---

### Task 2: core/schemas.ts

**Files:**
- Create: `src/core/schemas.ts`, `src/core/schemas.test.ts`

- [ ] **Step 1: 写失败测试** `src/core/schemas.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MediaContextSchema, MediaIdentitySchema, SearchPlanSchema,
  RankDecisionSchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema,
} from './schemas.js'

describe('MediaContextSchema', () => {
  it('accepts the matrix fixture', () => {
    const raw = JSON.parse(readFileSync('fixtures/contexts/matrix.json', 'utf8'))
    const ctx = MediaContextSchema.parse(raw)
    expect(ctx.media.title).toBe('The Matrix')
    expect(ctx.media.season).toBeNull()
  })
  it('rejects unknown media type', () => {
    const raw = JSON.parse(readFileSync('fixtures/contexts/matrix.json', 'utf8'))
    raw.media.type = 'music'
    expect(() => MediaContextSchema.parse(raw)).toThrow()
  })
})

describe('ASSRT response schemas', () => {
  it('parses recorded search response incl. empty-object filelist', () => {
    const raw = JSON.parse(readFileSync('fixtures/assrt/search-matrix.json', 'utf8'))
    const r = AssrtSearchResponseSchema.parse(raw)
    expect(r.status).toBe(0)
    expect(r.sub.subs.length).toBeGreaterThan(0)
    // 录制数据同时含 {} 和数组两种 filelist，全都得能过
    expect(r.sub.subs.some(s => s.filelist.length === 0)).toBe(true)
    expect(r.sub.subs.some(s => s.filelist.length > 0)).toBe(true)
  })
  it('parses recorded detail response with per-file urls', () => {
    const raw = JSON.parse(readFileSync('fixtures/assrt/detail-673114.json', 'utf8'))
    const r = AssrtDetailResponseSchema.parse(raw)
    expect(r.sub.subs[0].url).toMatch(/^http/)
    expect(r.sub.subs[0].filelist[0].url).toMatch(/^http/)
  })
})

describe('agent output schemas', () => {
  it('RankDecision requires assrt_id when decision=download', () => {
    expect(() => RankDecisionSchema.parse({
      decision: 'download', confidence: 0.9, reasons: ['x'], rejected: [],
    })).toThrow()
  })
  it('SearchPlan caps at 3 queries', () => {
    expect(() => SearchPlanSchema.parse({
      queries: [{ q: 'a', reason: 'r' }, { q: 'b', reason: 'r' }, { q: 'c', reason: 'r' }, { q: 'd', reason: 'r' }],
    })).toThrow()
  })
  it('MediaIdentity roundtrips', () => {
    const id = MediaIdentitySchema.parse({
      canonical_title: 'The Matrix', year: 1999, type: 'movie',
      season: null, episode: null, edition: null,
      confidence: 0.95, evidence: ['filename contains 1999'],
    })
    expect(id.type).toBe('movie')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/schemas.test.ts`
Expected: FAIL — cannot resolve `./schemas.js`

- [ ] **Step 3: 实现** `src/core/schemas.ts`

```ts
import { z } from 'zod'

// ---------- 输入 ----------
export const MediaContextSchema = z.object({
  request_id: z.string(),
  trigger: z.enum(['library_scan', 'manual_search', 'playback_start']),
  media: z.object({
    type: z.enum(['movie', 'episode']),
    path: z.string(),
    filename: z.string(),
    title: z.string(),
    original_title: z.string().nullish(),
    year: z.number().int().nullish(),
    season: z.number().int().nullish(),
    episode: z.number().int().nullish(),
    runtime_minutes: z.number().nullish(),
    provider_ids: z.record(z.string(), z.string()).default({}),
    production_locations: z.array(z.string()).default([]),
    existing_subtitles: z.array(z.object({
      language: z.string(),
      format: z.string(),
      source: z.string(),
    })).default([]),
  }),
  preferences: z.object({
    language: z.enum(['zh-Hans', 'zh-Hant']).default('zh-Hans'),
    prefer_bilingual: z.boolean().default(true),
    allow_traditional: z.boolean().default(true),
    allow_machine_translated: z.boolean().default(false),
    auto_download_min_confidence: z.number().min(0).max(1).default(0.86),
  }),
})
export type MediaContext = z.infer<typeof MediaContextSchema>

// ---------- 判断点输出 ----------
export const MediaIdentitySchema = z.object({
  canonical_title: z.string(),
  original_title: z.string().nullish(),
  year: z.number().int().nullish(),
  type: z.enum(['movie', 'episode']),
  season: z.number().int().nullish(),
  episode: z.number().int().nullish(),
  edition: z.string().nullish(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
})
export type MediaIdentity = z.infer<typeof MediaIdentitySchema>

export const SearchPlanSchema = z.object({
  queries: z.array(z.object({
    q: z.string().min(1),
    reason: z.string(),
  })).min(1).max(3),
})
export type SearchPlan = z.infer<typeof SearchPlanSchema>

export const RankDecisionSchema = z.object({
  decision: z.enum(['download', 'ask_user', 'no_safe_match']),
  assrt_id: z.number().int().nullish(),
  file_index: z.number().int().nullish(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  rejected: z.array(z.object({ assrt_id: z.number().int(), reason: z.string() })),
}).refine(v => v.decision !== 'download' || v.assrt_id != null, {
  message: 'assrt_id required when decision=download',
})
export type RankDecision = z.infer<typeof RankDecisionSchema>

// ---------- ASSRT 响应（宽松：只锁我们用的字段） ----------
// 实测：search 的 filelist 可能是 {} 或 [{s,f}]；detail 的 filelist 项带 url。
const FileListSchema = z.preprocess(
  v => (Array.isArray(v) ? v : []),
  z.array(z.object({ s: z.string().optional(), f: z.string(), url: z.string().optional() })),
)
const AssrtSubSchema = z.object({
  id: z.number().int(),
  videoname: z.string().nullish(),
  native_name: z.union([z.string(), z.array(z.string())]).nullish(),
  release_site: z.string().nullish(),
  subtype: z.string().nullish(),
  lang: z.object({
    desc: z.string().nullish(),
    langlist: z.record(z.string(), z.boolean()).nullish(),
  }).nullish(),
  filename: z.string().nullish(),
  size: z.number().nullish(),
  url: z.string().optional(),
  filelist: FileListSchema.default([]),
}).loose()
export type AssrtSub = z.infer<typeof AssrtSubSchema>

export const AssrtSearchResponseSchema = z.object({
  status: z.number(),
  sub: z.object({ subs: z.array(AssrtSubSchema).default([]) }).default({ subs: [] }),
})
export const AssrtDetailResponseSchema = AssrtSearchResponseSchema
export const AssrtQuotaResponseSchema = z.object({
  status: z.number(),
  user: z.object({ quota: z.number() }).optional(),
})

// ---------- 最终 decision ----------
export const FinalDecisionSchema = z.object({
  request_id: z.string(),
  decision: z.enum(['download', 'ask_user', 'no_safe_match', 'retry_later', 'already_exists', 'error']),
  confidence: z.number().nullish(),
  selected: z.object({
    assrt_id: z.number(),
    subtitle_name: z.string(),
    language: z.string(),
    format: z.string(),
  }).nullish(),
  reasons: z.array(z.string()).default([]),
  verification: z.object({
    downloaded: z.boolean(),
    path: z.string().nullish(),
    bytes: z.number().nullish(),
    encoding: z.string().nullish(),
  }).nullish(),
})
export type FinalDecision = z.infer<typeof FinalDecisionSchema>
```

注意：zod v4 下对象透传用 `.loose()`；若安装版本 API 不同（`passthrough()`），以编译错误为准修正，但**必须保留透传语义**（ASSRT 字段多变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/schemas.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/core/schemas.ts src/core/schemas.test.ts
git commit -m "feat: core zod schemas grounded on recorded ASSRT responses"
```

---

### Task 3: core/journal.ts

**Files:**
- Create: `src/core/journal.ts`, `src/core/journal.test.ts`

- [ ] **Step 1: 写失败测试** `src/core/journal.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal } from './journal.js'

describe('Journal', () => {
  it('records steps, llm calls, api calls and writes decision.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const j = new Journal('req-1')
    j.step('identify', { note: 'started' })
    j.llmCall({ point: 'identifyMedia', prompt: 'p', rawText: 'r', parsed: { ok: true }, retries: 0, durationMs: 12 })
    j.apiCall({ endpoint: 'sub/search', params: { q: 'matrix' }, status: 0, durationMs: 30 })
    const out = j.finish({
      request_id: 'req-1', decision: 'no_safe_match',
      confidence: null, selected: null, reasons: ['none matched'], verification: null,
    }, dir)
    const written = JSON.parse(readFileSync(out, 'utf8'))
    expect(written.decision.decision).toBe('no_safe_match')
    expect(written.steps.length).toBe(1)
    expect(written.llm_calls[0].point).toBe('identifyMedia')
    expect(written.api_calls[0].endpoint).toBe('sub/search')
    expect(written.request_id).toBe('req-1')
  })
})
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run src/core/journal.test.ts` — Expected: FAIL (module not found)

- [ ] **Step 3: 实现** `src/core/journal.ts`

```ts
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FinalDecision } from './schemas.js'

export interface LlmCallRecord {
  point: string
  prompt: string
  rawText: string
  parsed: unknown
  retries: number
  durationMs: number
  error?: string
}
export interface ApiCallRecord {
  endpoint: string
  params: Record<string, unknown>
  status: number | null
  durationMs: number
  error?: string
}

export class Journal {
  private steps: Array<{ name: string; at: string; data?: unknown }> = []
  private llmCalls: LlmCallRecord[] = []
  private apiCalls: ApiCallRecord[] = []
  constructor(private requestId: string) {}

  step(name: string, data?: unknown) {
    this.steps.push({ name, at: new Date().toISOString(), data })
  }
  llmCall(r: LlmCallRecord) { this.llmCalls.push(r) }
  apiCall(r: ApiCallRecord) { this.apiCalls.push(r) }

  finish(decision: FinalDecision, outDir: string): string {
    mkdirSync(outDir, { recursive: true })
    const path = join(outDir, 'decision.json')
    writeFileSync(path, JSON.stringify({
      request_id: this.requestId,
      finished_at: new Date().toISOString(),
      decision,
      steps: this.steps,
      llm_calls: this.llmCalls,
      api_calls: this.apiCalls,
    }, null, 2))
    return path
  }
}
```

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/core/journal.test.ts` — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/journal.ts src/core/journal.test.ts
git commit -m "feat: decision journal with llm/api audit records"
```

---

### Task 4: core/cache.ts

**Files:**
- Create: `src/core/cache.ts`, `src/core/cache.test.ts`

- [ ] **Step 1: 写失败测试** `src/core/cache.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DecisionCache, cacheKeys } from './cache.js'
import type { MediaIdentity } from './schemas.js'

const identity: MediaIdentity = {
  canonical_title: 'The Matrix', original_title: 'The Matrix', year: 1999,
  type: 'movie', season: null, episode: null, edition: null,
  confidence: 0.95, evidence: [],
}

describe('cacheKeys', () => {
  it('builds id-based and title-based keys', () => {
    const keys = cacheKeys(identity, { imdb: 'tt0133093' })
    expect(keys).toContain('id:imdb:tt0133093:S-:E-')
    expect(keys).toContain('title:the matrix|1999|movie|S-|E-')
  })
  it('includes season/episode for episodes', () => {
    const keys = cacheKeys({ ...identity, type: 'episode', season: 1, episode: 3 }, {})
    expect(keys[0]).toContain('S1')
    expect(keys[0]).toContain('E3')
  })
})

describe('DecisionCache', () => {
  it('stores and retrieves a positive entry by any key', () => {
    const c = new DecisionCache(mkdtempSync(join(tmpdir(), 'cache-')))
    c.put(['id:imdb:tt0133093:S-:E-', 'title:the matrix|1999|movie|S-|E-'],
      { kind: 'positive', assrt_id: 673114, file_index: 0, confidence: 0.91 })
    const hit = c.get('title:the matrix|1999|movie|S-|E-')
    expect(hit?.kind).toBe('positive')
  })
  it('expires negative entries after ttl', () => {
    const c = new DecisionCache(mkdtempSync(join(tmpdir(), 'cache-')))
    c.put(['k1'], { kind: 'negative', reason: 'no match' }, -1) // 已过期
    expect(c.get('k1')).toBeNull()
  })
  it('returns null on miss', () => {
    const c = new DecisionCache(mkdtempSync(join(tmpdir(), 'cache-')))
    expect(c.get('nope')).toBeNull()
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/core/cache.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/core/cache.ts`

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { MediaIdentity } from './schemas.js'

export type CacheEntry =
  | { kind: 'positive'; assrt_id: number; file_index: number | null; confidence: number }
  | { kind: 'negative'; reason: string }

interface StoredEntry { entry: CacheEntry; expiresAt: number }

const NEGATIVE_TTL_DAYS = 7
const POSITIVE_TTL_DAYS = 365

export function cacheKeys(identity: MediaIdentity, providerIds: Record<string, string>): string[] {
  const se = `S${identity.season ?? '-'}:E${identity.episode ?? '-'}`
  const keys: string[] = []
  for (const [prov, id] of Object.entries(providerIds)) {
    keys.push(`id:${prov}:${id}:${se}`)
  }
  const t = identity.canonical_title.toLowerCase().trim()
  keys.push(`title:${t}|${identity.year ?? '-'}|${identity.type}|S${identity.season ?? '-'}|E${identity.episode ?? '-'}`)
  return keys
}

export class DecisionCache {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }) }

  private pathFor(key: string): string {
    return join(this.dir, createHash('sha1').update(key).digest('hex') + '.json')
  }

  get(key: string): CacheEntry | null {
    const p = this.pathFor(key)
    if (!existsSync(p)) return null
    const stored: StoredEntry = JSON.parse(readFileSync(p, 'utf8'))
    if (Date.now() > stored.expiresAt) return null
    return stored.entry
  }

  put(keys: string[], entry: CacheEntry, ttlDays?: number) {
    const days = ttlDays ?? (entry.kind === 'negative' ? NEGATIVE_TTL_DAYS : POSITIVE_TTL_DAYS)
    const stored: StoredEntry = { entry, expiresAt: Date.now() + days * 86_400_000 }
    for (const key of keys) writeFileSync(this.pathFor(key), JSON.stringify(stored, null, 2))
  }
}
```

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/core/cache.test.ts` — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/cache.ts src/core/cache.test.ts
git commit -m "feat: layered-key decision cache with negative TTL"
```

---

### Task 5: adapters/providers/assrt.ts

**Files:**
- Create: `src/adapters/providers/assrt.ts`, `src/adapters/providers/assrt.test.ts`

- [ ] **Step 1: 写失败测试** `src/adapters/providers/assrt.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient, MinIntervalLimiter } from './assrt.js'

const searchFixture = readFileSync('fixtures/assrt/search-matrix.json', 'utf8')
const detailFixture = readFileSync('fixtures/assrt/detail-673114.json', 'utf8')

function makeClient(responses: string[]) {
  let i = 0
  const fetchImpl = vi.fn(async () => new Response(responses[Math.min(i++, responses.length - 1)]))
  const client = new AssrtClient({
    token: 'test-token',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    limiter: new MinIntervalLimiter(0), // 测试不等待
    cacheDir: mkdtempSync(join(tmpdir(), 'assrt-')),
  })
  return { client, fetchImpl }
}

describe('AssrtClient', () => {
  it('search parses recorded fixture and passes filelist+no_muxer params', async () => {
    const { client, fetchImpl } = makeClient([searchFixture])
    const r = await client.search('The.Matrix.1999')
    expect(r.sub.subs.length).toBeGreaterThan(0)
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/sub/search')
    expect(url).toContain('filelist=1')
    expect(url).toContain('no_muxer=1')
    expect(url).toContain('token=test-token')
  })

  it('detail returns download urls', async () => {
    const { client } = makeClient([detailFixture])
    const r = await client.detail(673114)
    expect(r.sub.subs[0].url).toMatch(/^http/)
  })

  it('throws AssrtApiError on non-zero status even with HTTP 200', async () => {
    const { client } = makeClient([JSON.stringify({ status: 30900, sub: { subs: [] } })])
    await expect(client.search('x')).rejects.toThrow(/30900/)
  })

  it('serves identical search from disk cache without second fetch', async () => {
    const { client, fetchImpl } = makeClient([searchFixture])
    await client.search('The.Matrix.1999')
    await client.search('The.Matrix.1999')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('MinIntervalLimiter', () => {
  it('spaces calls by the interval', async () => {
    const limiter = new MinIntervalLimiter(50)
    const t0 = Date.now()
    await limiter.wait(); await limiter.wait()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/adapters/providers/assrt.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/adapters/providers/assrt.ts`

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  AssrtSearchResponseSchema, AssrtDetailResponseSchema, AssrtQuotaResponseSchema,
} from '../../core/schemas.js'
import type { z } from 'zod'

const BASE = 'https://api.assrt.net/v1'
const RESPONSE_CACHE_TTL_MS = 24 * 3600_000
// 实测配额 5/min，留余量:15s 间隔 = 4/min
export const DEFAULT_MIN_INTERVAL_MS = 15_000

export class AssrtApiError extends Error {
  constructor(public status: number, endpoint: string) {
    super(`ASSRT ${endpoint} returned status ${status}`)
  }
}

export class MinIntervalLimiter {
  private last = 0
  constructor(private intervalMs: number) {}
  async wait() {
    const now = Date.now()
    const delta = now - this.last
    if (delta < this.intervalMs) await new Promise(r => setTimeout(r, this.intervalMs - delta))
    this.last = Date.now()
  }
}

export interface AssrtClientOpts {
  token: string
  fetchImpl?: typeof fetch
  limiter?: MinIntervalLimiter
  cacheDir: string
  onApiCall?: (r: { endpoint: string; params: Record<string, unknown>; status: number | null; durationMs: number; error?: string }) => void
}

export class AssrtClient {
  private fetchImpl: typeof fetch
  private limiter: MinIntervalLimiter
  constructor(private opts: AssrtClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.limiter = opts.limiter ?? new MinIntervalLimiter(DEFAULT_MIN_INTERVAL_MS)
    mkdirSync(opts.cacheDir, { recursive: true })
  }

  private cachePath(endpoint: string, params: Record<string, string>) {
    const key = createHash('sha1').update(endpoint + JSON.stringify(params)).digest('hex')
    return join(this.opts.cacheDir, `${key}.json`)
  }

  private async call<T>(endpoint: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const cacheFile = this.cachePath(endpoint, params)
    if (existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < RESPONSE_CACHE_TTL_MS) {
      return schema.parse(JSON.parse(readFileSync(cacheFile, 'utf8')))
    }
    await this.limiter.wait()
    const qs = new URLSearchParams({ token: this.opts.token, ...params })
    const t0 = Date.now()
    try {
      const res = await this.fetchImpl(`${BASE}/${endpoint}?${qs}`)
      const json = await res.json() as { status?: number }
      const status = typeof json.status === 'number' ? json.status : null
      this.opts.onApiCall?.({ endpoint, params, status, durationMs: Date.now() - t0 })
      if (status !== 0) throw new AssrtApiError(status ?? -1, endpoint)
      writeFileSync(cacheFile, JSON.stringify(json))
      return schema.parse(json)
    } catch (e) {
      if (!(e instanceof AssrtApiError)) {
        this.opts.onApiCall?.({ endpoint, params, status: null, durationMs: Date.now() - t0, error: String(e) })
      }
      throw e
    }
  }

  quota() { return this.call('user/quota', {}, AssrtQuotaResponseSchema) }
  search(q: string) {
    return this.call('sub/search', { q, filelist: '1', no_muxer: '1' }, AssrtSearchResponseSchema)
  }
  detail(id: number) {
    return this.call('sub/detail', { id: String(id) }, AssrtDetailResponseSchema)
  }
}
```

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/adapters/providers/assrt.test.ts` — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/providers/
git commit -m "feat: ASSRT client with rate limiting, disk cache, status-field errors"
```

---

### Task 6: adapters/download/direct.ts

**Files:**
- Create: `src/adapters/download/direct.ts`, `src/adapters/download/direct.test.ts`

- [ ] **Step 1: 写失败测试** `src/adapters/download/direct.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { downloadDirect } from './direct.js'

describe('downloadDirect', () => {
  it('returns bytes on success', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('subtitle content')))
    const r = await downloadDirect('http://file0.assrt.net/x.ass', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.bytes.toString()).toBe('subtitle content')
    expect(r.bytes.length).toBeGreaterThan(0)
  })
  it('retries once on failure then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response(Buffer.from('ok')))
    const r = await downloadDirect('http://x/y.ass', { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(r.bytes.toString()).toBe('ok')
  })
  it('throws after exhausting retries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 403 }))
    await expect(downloadDirect('http://x/y.ass', { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 1 }))
      .rejects.toThrow(/403/)
  })
  it('rejects empty bodies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(Buffer.alloc(0)))
    await expect(downloadDirect('http://x/y.ass', { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 1 }))
      .rejects.toThrow(/empty/i)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/adapters/download/direct.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/adapters/download/direct.ts`

```ts
export interface DownloadResult { bytes: Buffer; contentType: string | null }
export interface DownloadOpts { fetchImpl?: typeof fetch; retries?: number; retryDelayMs?: number }

export async function downloadDirect(url: string, opts: DownloadOpts = {}): Promise<DownloadResult> {
  const { fetchImpl = fetch, retries = 1, retryDelayMs = 2000 } = opts
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url)
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length === 0) throw new Error('download returned empty body')
      return { bytes, contentType: res.headers.get('content-type') }
    } catch (e) {
      lastError = e
      if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs))
    }
  }
  throw lastError
}
```

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/adapters/download/direct.test.ts` — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/download/
git commit -m "feat: direct download backend with retry and empty-body guard"
```

---

### Task 7: files/subtitleWriter.ts

**Files:**
- Create: `src/files/subtitleWriter.ts`, `src/files/subtitleWriter.test.ts`

- [ ] **Step 1: 写失败测试** `src/files/subtitleWriter.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import * as iconv from 'iconv-lite'
import { writeSubtitle } from './subtitleWriter.js'

const outDir = () => mkdtempSync(join(tmpdir(), 'subw-'))

describe('writeSubtitle', () => {
  it('writes a plain utf-8 srt with Jellyfin naming', async () => {
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n你好\n'),
      artifactFilename: 'sub.srt',
      videoFilename: 'The.Matrix.1999.1080p.BluRay.x264.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    expect(r.path).toBe(join(dir, 'The.Matrix.1999.1080p.BluRay.x264.zh-Hans.srt'))
    expect(existsSync(r.path)).toBe(true)
    expect(r.encoding).toBe('utf-8')
  })

  it('extracts the requested file from a zip by name', async () => {
    const zip = new AdmZip()
    zip.addFile('wrong.ass', Buffer.from('WRONG'))
    zip.addFile('right.ass', Buffer.from('[Script Info]\nTitle: right\n'))
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: zip.toBuffer(),
      artifactFilename: 'pack.zip',
      selectFileName: 'right.ass',
      videoFilename: 'Movie.2020.mkv',
      langTag: 'zh-Hans',
      outDir: dir,
    })
    expect(readFileSync(r.path, 'utf8')).toContain('Title: right')
    expect(r.path.endsWith('Movie.2020.zh-Hans.ass')).toBe(true)
  })

  it('converts GB18030 to utf-8 and records original encoding', async () => {
    const gbk = iconv.encode('1\n00:00:01,000 --> 00:00:02,000\n黑客帝国经典台词测试字幕内容\n', 'gb18030')
    const dir = outDir()
    const r = await writeSubtitle({
      artifact: gbk, artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    })
    expect(readFileSync(r.path, 'utf8')).toContain('黑客帝国')
    expect(r.encoding?.toLowerCase()).not.toBe('utf-8')
  })

  it('refuses to overwrite an existing file', async () => {
    const dir = outDir()
    writeFileSync(join(dir, 'Movie.zh-Hans.srt'), 'existing')
    const r = await writeSubtitle({
      artifact: Buffer.from('new'), artifactFilename: 'sub.srt',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: dir,
    })
    expect(r.alreadyExists).toBe(true)
    expect(readFileSync(join(dir, 'Movie.zh-Hans.srt'), 'utf8')).toBe('existing')
  })

  it('throws UnsupportedArchiveError for rar', async () => {
    await expect(writeSubtitle({
      artifact: Buffer.from('Rar!\x1a\x07'), artifactFilename: 'pack.rar',
      videoFilename: 'Movie.mkv', langTag: 'zh-Hans', outDir: outDir(),
    })).rejects.toThrow(/unsupported archive/i)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/files/subtitleWriter.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/files/subtitleWriter.ts`

```ts
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import AdmZip from 'adm-zip'
import chardet from 'chardet'
import * as iconv from 'iconv-lite'

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa']

export class UnsupportedArchiveError extends Error {
  constructor(ext: string) { super(`unsupported archive format: ${ext} (only zip in v1)`) }
}

export interface WriteSubtitleInput {
  artifact: Buffer
  artifactFilename: string
  /** zip 包内要选的文件名（来自 ASSRT filelist[file_index].f）；非 zip 忽略 */
  selectFileName?: string
  videoFilename: string
  langTag: 'zh-Hans' | 'zh-Hant'
  outDir: string
}
export interface WriteSubtitleResult {
  path: string
  bytes: number
  encoding: string | null
  alreadyExists: boolean
}

function pickFromZip(buf: Buffer, selectFileName?: string): { name: string; data: Buffer } {
  const zip = new AdmZip(buf)
  const entries = zip.getEntries().filter(e =>
    !e.isDirectory &&
    SUBTITLE_EXTS.includes(extname(e.entryName).toLowerCase()) &&
    !basename(e.entryName).startsWith('.'))
  if (entries.length === 0) throw new Error('zip contains no subtitle files')
  const chosen = selectFileName
    ? entries.find(e => basename(e.entryName) === basename(selectFileName))
    : entries[0]
  if (!chosen) throw new Error(`selected file not found in zip: ${selectFileName}`)
  return { name: basename(chosen.entryName), data: chosen.getData() }
}

export async function writeSubtitle(input: WriteSubtitleInput): Promise<WriteSubtitleResult> {
  const artifactExt = extname(input.artifactFilename).toLowerCase()
  let subtitleName: string
  let data: Buffer

  if (artifactExt === '.zip') {
    ({ name: subtitleName, data } = pickFromZip(input.artifact, input.selectFileName))
  } else if (SUBTITLE_EXTS.includes(artifactExt)) {
    subtitleName = input.artifactFilename
    data = input.artifact
  } else {
    throw new UnsupportedArchiveError(artifactExt)
  }

  // 编码归一化：非 UTF-8 转 UTF-8，记录原编码
  const detected = chardet.detect(data)
  let encoding = detected ? String(detected).toLowerCase() : null
  if (encoding && encoding !== 'utf-8' && encoding !== 'ascii' && iconv.encodingExists(encoding)) {
    data = Buffer.from(iconv.decode(data, encoding), 'utf8')
  } else if (encoding === 'ascii') {
    encoding = 'utf-8' // ascii 是 utf-8 子集
  }

  const videoBase = input.videoFilename.replace(/\.[^.]+$/, '')
  const outName = `${videoBase}.${input.langTag}${extname(subtitleName).toLowerCase()}`
  mkdirSync(input.outDir, { recursive: true })
  const outPath = join(input.outDir, outName)

  if (existsSync(outPath)) {
    return { path: outPath, bytes: 0, encoding, alreadyExists: true }
  }
  writeFileSync(outPath, data)
  return { path: outPath, bytes: data.length, encoding, alreadyExists: false }
}
```

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/files/subtitleWriter.test.ts` — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/files/
git commit -m "feat: subtitle writer with zip extraction, encoding normalization, no-overwrite"
```

---

### Task 8: agent/llm.ts

**Files:**
- Create: `src/agent/llm.ts`, `src/agent/llm.test.ts`

**背景：** 结构化输出必须走 tool 强制模式（MiMo 忽略 json_schema）。AI SDK v5+ 的 tool 定义用 `inputSchema`，强制调用用 `toolChoice: { type: 'tool', toolName }`，结果在 `result.toolCalls[0].input`。如果安装的 `ai@7` 属性名有出入，以 `node_modules/ai` 的类型定义为准调整，但**语义不得变**：必须强制 tool、必须 Zod 校验、校验失败带错误重试一次。

- [ ] **Step 1: 写失败测试** `src/agent/llm.test.ts`

用 AI SDK 自带的 mock provider（`ai/test` 的 `MockLanguageModelV3`；若该导出名在 ai@7 中不同，查 `node_modules/ai/dist` 的 test 导出并对应调整——mock 的意义就是锁住我们对 SDK 的用法）：

```ts
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { MockLanguageModelV3 } from 'ai/test'
import { callStructured } from './llm.js'

const schema = z.object({ title: z.string(), year: z.number() })

function mockModelReturningToolCall(args: object) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: 'tool-calls',
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      content: [{
        type: 'tool-call', toolCallId: 'c1', toolName: 'report',
        input: JSON.stringify(args),
      }],
      warnings: [],
    }),
  })
}

describe('callStructured', () => {
  it('returns parsed object from forced tool call', async () => {
    const model = mockModelReturningToolCall({ title: 'The Matrix', year: 1999 })
    const r = await callStructured({
      model, name: 'report', description: 'report result',
      prompt: 'identify', schema,
    })
    expect(r.parsed).toEqual({ title: 'The Matrix', year: 1999 })
    expect(r.retries).toBe(0)
  })

  it('retries once when output fails schema, then surfaces error', async () => {
    const model = mockModelReturningToolCall({ title: 'The Matrix' }) // 缺 year
    await expect(callStructured({
      model, name: 'report', description: 'd', prompt: 'p', schema,
    })).rejects.toThrow(/schema/i)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/agent/llm.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/agent/llm.ts`

```ts
import { generateText, tool, type LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { z } from 'zod'

export interface LlmConfig { baseUrl: string; apiKey: string; model: string }

export function makeModel(cfg: LlmConfig): LanguageModel {
  const provider = createOpenAICompatible({ name: 'subtitle-scout-llm', baseURL: cfg.baseUrl, apiKey: cfg.apiKey })
  return provider(cfg.model)
}

export interface CallStructuredOpts<S extends z.ZodType> {
  model: LanguageModel
  name: string
  description: string
  prompt: string
  schema: S
  maxOutputTokens?: number
}
export interface CallStructuredResult<T> {
  parsed: T
  rawText: string
  retries: number
  durationMs: number
}

export class StructuredOutputError extends Error {}

/**
 * 强制单 tool 调用的结构化输出。绝不使用 response_format:json_schema——
 * MiMo 会静默忽略 schema（2026-07-06 实测）。
 */
export async function callStructured<S extends z.ZodType>(
  opts: CallStructuredOpts<S>,
): Promise<CallStructuredResult<z.infer<S>>> {
  const t0 = Date.now()
  let lastError = ''
  for (let attempt = 0; attempt <= 1; attempt++) {
    const prompt = attempt === 0
      ? opts.prompt
      : `${opts.prompt}\n\nYour previous answer failed validation:\n${lastError}\nCall the tool again with a corrected, complete argument object.`
    const result = await generateText({
      model: opts.model,
      prompt,
      tools: { [opts.name]: tool({ description: opts.description, inputSchema: opts.schema }) },
      toolChoice: { type: 'tool', toolName: opts.name },
      // mimo-v2.5 是 reasoning 模型，预算必须留足
      maxOutputTokens: opts.maxOutputTokens ?? 4000,
    })
    const call = result.toolCalls[0]
    if (!call) { lastError = 'no tool call was produced'; continue }
    const parsed = opts.schema.safeParse(call.input)
    if (parsed.success) {
      return { parsed: parsed.data, rawText: result.text, retries: attempt, durationMs: Date.now() - t0 }
    }
    lastError = parsed.error.message
  }
  throw new StructuredOutputError(`schema validation failed after retry: ${lastError}`)
}
```

注意：AI SDK 的 `tool({inputSchema})` + 强制 toolChoice 本身会做一层校验，无效参数可能直接抛 `InvalidToolInputError` 而不是给我们残缺对象——如果测试因此表现不同（reject 来自 SDK 而非我们的 `safeParse`），把 SDK 的该错误 catch 住并走同样的重试路径，语义不变。

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/agent/llm.test.ts` — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/llm.ts src/agent/llm.test.ts
git commit -m "feat: forced-tool structured LLM calls with validation retry"
```

---

### Task 9: 三个判断点（identifyMedia / planSearch / rankCandidates）

**Files:**
- Create: `src/agent/identifyMedia.ts`, `src/agent/planSearch.ts`, `src/agent/rankCandidates.ts`

这三个是 `callStructured` 的薄封装：组 prompt、传 schema、把结果和 journal 记录返回。不写单测（测它即测模型；schema 校验已在 Task 2/8 覆盖），靠 Task 11 的 pipeline 集成测试和 e2e 冒烟验证接线。

- [ ] **Step 1: 实现 identifyMedia** `src/agent/identifyMedia.ts`

```ts
import type { LanguageModel } from 'ai'
import { MediaIdentitySchema, type MediaContext, type MediaIdentity } from '../core/schemas.js'
import { callStructured, type CallStructuredResult } from './llm.js'

export async function identifyMedia(
  model: LanguageModel, ctx: MediaContext,
): Promise<CallStructuredResult<MediaIdentity>> {
  const m = ctx.media
  const prompt = [
    'You are a media librarian. Identify the exact movie or TV episode from the evidence below.',
    'Be precise about edition/cut (director\'s cut, extended, remaster) if the filename indicates one.',
    '',
    `player title: ${m.title}`,
    `original title: ${m.original_title ?? 'unknown'}`,
    `year: ${m.year ?? 'unknown'}`,
    `type hint: ${m.type}`,
    `season/episode: S${m.season ?? '-'} E${m.episode ?? '-'}`,
    `filename: ${m.filename}`,
    `full path: ${m.path}`,
    `provider ids: ${JSON.stringify(m.provider_ids)}`,
    `runtime minutes: ${m.runtime_minutes ?? 'unknown'}`,
    '',
    'Report canonical_title in the title\'s original language, list concrete evidence strings,',
    'and give confidence in [0,1]. If season/episode are present they MUST be echoed exactly.',
  ].join('\n')
  return callStructured({
    model, name: 'report_identity',
    description: 'Report the identified media', prompt, schema: MediaIdentitySchema,
  })
}
```

- [ ] **Step 2: 实现 planSearch** `src/agent/planSearch.ts`

```ts
import type { LanguageModel } from 'ai'
import { SearchPlanSchema, type MediaContext, type MediaIdentity, type SearchPlan } from '../core/schemas.js'
import { callStructured, type CallStructuredResult } from './llm.js'

export async function planSearch(
  model: LanguageModel, ctx: MediaContext, identity: MediaIdentity,
): Promise<CallStructuredResult<SearchPlan>> {
  const prompt = [
    'Plan search queries for ASSRT (assrt.net), a Chinese subtitle search API.',
    'Return 1-3 queries ordered precise-to-broad. They will run in order and stop at the first that yields usable candidates.',
    'Good precise query: the release filename without extension. Good broad query: "<title> <year>" or "<title> S01E03".',
    'ASSRT indexes mostly English release names and Chinese titles; prefer the original-language title over translations.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `filename: ${ctx.media.filename}`,
  ].join('\n')
  return callStructured({
    model, name: 'report_search_plan',
    description: 'Report ordered ASSRT search queries', prompt, schema: SearchPlanSchema,
  })
}
```

- [ ] **Step 3: 实现 rankCandidates** `src/agent/rankCandidates.ts`

```ts
import type { LanguageModel } from 'ai'
import {
  RankDecisionSchema, type MediaContext, type MediaIdentity, type AssrtSub, type RankDecision,
} from '../core/schemas.js'
import { callStructured, type CallStructuredResult } from './llm.js'

export async function rankCandidates(
  model: LanguageModel, ctx: MediaContext, identity: MediaIdentity, candidates: AssrtSub[],
): Promise<CallStructuredResult<RankDecision>> {
  const compact = candidates.map(c => ({
    id: c.id,
    videoname: c.videoname,
    native_name: c.native_name,
    lang: c.lang?.desc,
    subtype: c.subtype,
    release_site: c.release_site,
    filelist: c.filelist.map(f => f.f),
  }))
  const prompt = [
    'Choose the best Chinese subtitle for this media from ASSRT candidates, or refuse.',
    'A WRONG subtitle is worse than NO subtitle. Rules:',
    '- For episodes, season AND episode must match exactly.',
    '- If a candidate is a pack (filelist has multiple files), you MUST pick the specific file_index',
    '  whose filename matches THIS media. A trilogy pack whose files are other movies is a trap.',
    '- Prefer: bilingual or zh-Hans; ass/srt; matching source (BluRay/WEB-DL) and release group.',
    `- User preferences: ${JSON.stringify(ctx.preferences)}`,
    '- If nothing is clearly safe, decision=no_safe_match. If plausible but uncertain, decision=ask_user.',
    'file_index is the 0-based index into the candidate\'s filelist array; null for non-pack candidates.',
    'List every seriously-considered-but-rejected candidate in rejected[] with a concrete reason.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `media filename: ${ctx.media.filename}`,
    `candidates: ${JSON.stringify(compact)}`,
  ].join('\n')
  return callStructured({
    model, name: 'report_rank_decision',
    description: 'Report the chosen subtitle or refusal', prompt, schema: RankDecisionSchema,
  })
}
```

- [ ] **Step 4: 类型检查 + 提交**

Run: `npm run check` — Expected: 通过

```bash
git add src/agent/
git commit -m "feat: three agent judgment points as thin structured-call wrappers"
```

---

### Task 10: core/gate.ts

**Files:**
- Create: `src/core/gate.ts`, `src/core/gate.test.ts`

- [ ] **Step 1: 写失败测试** `src/core/gate.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { runGate } from './gate.js'
import type { AssrtSub, MediaIdentity, RankDecision, MediaContext } from './schemas.js'

const identity: MediaIdentity = {
  canonical_title: 'The Matrix', original_title: null, year: 1999, type: 'movie',
  season: null, episode: null, edition: null, confidence: 0.95, evidence: [],
}
const prefs: MediaContext['preferences'] = {
  language: 'zh-Hans', prefer_bilingual: true, allow_traditional: true,
  allow_machine_translated: false, auto_download_min_confidence: 0.86,
}
const candidates = [
  { id: 673114, videoname: 'The.Matrix.1999', filelist: [{ f: 'a.zh.ass' }] },
  { id: 606770, videoname: 'Matrix Trilogy', filelist: [{ f: 'animatrix.ass' }, { f: 'matrix1.ass' }] },
] as unknown as AssrtSub[]

const base: RankDecision = {
  decision: 'download', assrt_id: 673114, file_index: 0,
  confidence: 0.91, reasons: ['match'], rejected: [],
}

describe('runGate', () => {
  it('passes a valid download decision', () => {
    const r = runGate(base, candidates, identity, prefs)
    expect(r.ok).toBe(true)
  })
  it('rejects assrt_id not in candidate set', () => {
    const r = runGate({ ...base, assrt_id: 999999 }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures[0]).toMatch(/assrt_id/)
  })
  it('rejects out-of-range file_index', () => {
    const r = runGate({ ...base, file_index: 5 }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.failures[0]).toMatch(/file_index/)
  })
  it('downgrades to ask_user below confidence threshold', () => {
    const r = runGate({ ...base, confidence: 0.7 }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('ask_user')
  })
  it('passes through non-download decisions untouched', () => {
    const r = runGate({ ...base, decision: 'no_safe_match', assrt_id: null, file_index: null }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures).toEqual([])
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/core/gate.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/core/gate.ts`

```ts
import type { AssrtSub, MediaIdentity, MediaContext, RankDecision } from './schemas.js'

export interface GateResult {
  ok: boolean
  /** ok=false 时的降级 decision */
  decision: 'download' | 'ask_user' | 'no_safe_match'
  failures: string[]
  candidate?: AssrtSub
}

/** 纯代码硬校验 agent 的排序输出。任何一条不过就绝不落盘。 */
export function runGate(
  rank: RankDecision,
  candidates: AssrtSub[],
  identity: MediaIdentity,
  prefs: MediaContext['preferences'],
): GateResult {
  if (rank.decision !== 'download') {
    return { ok: false, decision: rank.decision, failures: [] }
  }
  const failures: string[] = []
  const candidate = candidates.find(c => c.id === rank.assrt_id)
  if (!candidate) failures.push(`assrt_id ${rank.assrt_id} is not in this search's candidate set`)

  if (candidate && candidate.filelist.length > 0) {
    if (rank.file_index == null || rank.file_index < 0 || rank.file_index >= candidate.filelist.length) {
      failures.push(`file_index ${rank.file_index} out of range for filelist of ${candidate.filelist.length}`)
    }
  }

  if (identity.type === 'episode' && (identity.season == null || identity.episode == null)) {
    failures.push('episode media without resolved season/episode cannot be auto-downloaded')
  }

  if (failures.length > 0) return { ok: false, decision: 'no_safe_match', failures }

  if (rank.confidence < prefs.auto_download_min_confidence) {
    return {
      ok: false, decision: 'ask_user',
      failures: [`confidence ${rank.confidence} below threshold ${prefs.auto_download_min_confidence}`],
    }
  }
  return { ok: true, decision: 'download', failures: [], candidate }
}
```

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/core/gate.test.ts` — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/gate.ts src/core/gate.test.ts
git commit -m "feat: deterministic gate validating agent decisions before any disk write"
```

---

### Task 11: core/pipeline.ts

**Files:**
- Create: `src/core/pipeline.ts`, `src/core/pipeline.test.ts`

- [ ] **Step 1: 写失败测试** `src/core/pipeline.test.ts`

全 fake 依赖的集成测试（无网络、无真 LLM）：

```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPipeline, type PipelineDeps } from './pipeline.js'
import { MediaContextSchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema } from './schemas.js'
import { DecisionCache } from './cache.js'

const ctx = MediaContextSchema.parse(JSON.parse(readFileSync('fixtures/contexts/matrix.json', 'utf8')))
const searchResp = AssrtSearchResponseSchema.parse(JSON.parse(readFileSync('fixtures/assrt/search-matrix.json', 'utf8')))
const detailResp = AssrtDetailResponseSchema.parse(JSON.parse(readFileSync('fixtures/assrt/detail-673114.json', 'utf8')))

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    identify: vi.fn(async () => ({
      parsed: {
        canonical_title: 'The Matrix', original_title: 'The Matrix', year: 1999,
        type: 'movie' as const, season: null, episode: null, edition: null,
        confidence: 0.95, evidence: ['filename'],
      }, rawText: '', retries: 0, durationMs: 1,
    })),
    plan: vi.fn(async () => ({
      parsed: { queries: [{ q: 'The.Matrix.1999.1080p.BluRay.x264', reason: 'release name' }] },
      rawText: '', retries: 0, durationMs: 1,
    })),
    rank: vi.fn(async () => ({
      parsed: {
        decision: 'download' as const, assrt_id: 673114, file_index: 0,
        confidence: 0.91, reasons: ['exact match'], rejected: [],
      }, rawText: '', retries: 0, durationMs: 1,
    })),
    assrt: {
      search: vi.fn(async () => searchResp),
      detail: vi.fn(async () => detailResp),
    },
    download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\nTitle: t\n'), contentType: 'text/plain' })),
    cache: new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-'))),
    maxApiCallsPerJob: 4,
    ...overrides,
  }
}

describe('runPipeline', () => {
  it('golden path: downloads, writes subtitle + decision.json, exit download', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps()
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('download')
    expect(existsSync(result.subtitlePath!)).toBe(true)
    expect(result.subtitlePath).toContain('The.Matrix.1999.1080p.BluRay.x264.zh-Hans')
    const journal = JSON.parse(readFileSync(join(outDir, 'decision.json'), 'utf8'))
    expect(journal.llm_calls.length).toBe(3)
    expect(journal.decision.decision).toBe('download')
  })

  it('gate failure: bogus assrt_id yields no_safe_match, nothing written', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({
      rank: vi.fn(async () => ({
        parsed: {
          decision: 'download' as const, assrt_id: 999999, file_index: null,
          confidence: 0.99, reasons: ['hallucinated'], rejected: [],
        }, rawText: '', retries: 0, durationMs: 1,
      })),
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('no_safe_match')
    expect(result.subtitlePath).toBeUndefined()
    expect(deps.download).not.toHaveBeenCalled()
  })

  it('caches negative results and skips ASSRT on second run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({
      rank: vi.fn(async () => ({
        parsed: { decision: 'no_safe_match' as const, assrt_id: null, file_index: null, confidence: 0.3, reasons: ['nothing safe'], rejected: [] },
        rawText: '', retries: 0, durationMs: 1,
      })),
    })
    await runPipeline(deps, ctx, mkdtempSync(join(tmpdir(), 'out-')))
    const second = await runPipeline(deps, ctx, outDir)
    expect(second.decision).toBe('no_safe_match')
    expect(second.fromCache).toBe(true)
    expect(deps.assrt.search).toHaveBeenCalledTimes(1) // 只有第一次
  })

  it('tries the next query when the first yields zero candidates', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const empty = { status: 0, sub: { subs: [] } }
    const deps = makeDeps({
      plan: vi.fn(async () => ({
        parsed: { queries: [{ q: 'weird exact', reason: 'r' }, { q: 'The Matrix 1999', reason: 'r' }] },
        rawText: '', retries: 0, durationMs: 1,
      })),
      assrt: {
        search: vi.fn(async (q: string) => (q === 'weird exact' ? empty : searchResp)),
        detail: vi.fn(async () => detailResp),
      },
    })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('download')
    expect(deps.assrt.search).toHaveBeenCalledTimes(2)
  })

  it('llm error surfaces as error decision with journal written', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const deps = makeDeps({ identify: vi.fn(async () => { throw new Error('LLM down') }) })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('error')
    expect(existsSync(join(outDir, 'decision.json'))).toBe(true)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/core/pipeline.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/core/pipeline.ts`

```ts
import type { z } from 'zod'
import {
  type MediaContext, type MediaIdentity, type SearchPlan, type RankDecision,
  type AssrtSub, AssrtSearchResponseSchema, AssrtDetailResponseSchema,
} from './schemas.js'
import type { CallStructuredResult } from '../agent/llm.js'
import { Journal } from './journal.js'
import { DecisionCache, cacheKeys, type CacheEntry } from './cache.js'
import { runGate } from './gate.js'
import { writeSubtitle } from '../files/subtitleWriter.js'
import type { DownloadResult } from '../adapters/download/direct.js'

type SearchResponse = z.infer<typeof AssrtSearchResponseSchema>
type DetailResponse = z.infer<typeof AssrtDetailResponseSchema>

export interface PipelineDeps {
  identify: (ctx: MediaContext) => Promise<CallStructuredResult<MediaIdentity>>
  plan: (ctx: MediaContext, id: MediaIdentity) => Promise<CallStructuredResult<SearchPlan>>
  rank: (ctx: MediaContext, id: MediaIdentity, cands: AssrtSub[]) => Promise<CallStructuredResult<RankDecision>>
  assrt: {
    search: (q: string) => Promise<SearchResponse>
    detail: (id: number) => Promise<DetailResponse>
  }
  download: (url: string) => Promise<DownloadResult>
  cache: DecisionCache
  maxApiCallsPerJob: number
}

export interface PipelineResult {
  decision: 'download' | 'ask_user' | 'no_safe_match' | 'retry_later' | 'already_exists' | 'error'
  subtitlePath?: string
  journalPath: string
  fromCache?: boolean
}

export async function runPipeline(
  deps: PipelineDeps, ctx: MediaContext, outDir: string,
): Promise<PipelineResult> {
  const journal = new Journal(ctx.request_id)
  const finish = (
    decision: PipelineResult['decision'],
    extra: { reasons?: string[]; confidence?: number | null; subtitlePath?: string; bytes?: number; encoding?: string | null; fromCache?: boolean } = {},
  ): PipelineResult => {
    const journalPath = journal.finish({
      request_id: ctx.request_id, decision,
      confidence: extra.confidence ?? null, selected: null,
      reasons: extra.reasons ?? [],
      verification: extra.subtitlePath
        ? { downloaded: true, path: extra.subtitlePath, bytes: extra.bytes ?? null, encoding: extra.encoding ?? null }
        : null,
    }, outDir)
    return { decision, subtitlePath: extra.subtitlePath, journalPath, fromCache: extra.fromCache }
  }

  try {
    // 1. identify
    journal.step('identify')
    const idResult = await deps.identify(ctx)
    journal.llmCall({ point: 'identifyMedia', prompt: '(see agent)', rawText: idResult.rawText, parsed: idResult.parsed, retries: idResult.retries, durationMs: idResult.durationMs })
    const identity = idResult.parsed

    // 2. cache lookup（精确 key 命中即信任；v1 无模糊复用）
    journal.step('cacheLookup')
    const keys = cacheKeys(identity, ctx.media.provider_ids)
    let cached: CacheEntry | null = null
    for (const k of keys) { cached = deps.cache.get(k); if (cached) break }
    if (cached?.kind === 'negative') {
      return finish('no_safe_match', { reasons: [`negative cache: ${cached.reason}`], fromCache: true })
    }

    // 3. search（缓存命中 positive 时跳过 plan/search/rank，直接用缓存的选择）
    let rank: RankDecision
    let candidates: AssrtSub[]
    if (cached?.kind === 'positive') {
      journal.step('cacheHitPositive', cached)
      const detail = await deps.assrt.detail(cached.assrt_id)
      candidates = detail.sub.subs
      rank = { decision: 'download', assrt_id: cached.assrt_id, file_index: cached.file_index, confidence: cached.confidence, reasons: ['cache hit'], rejected: [] }
    } else {
      journal.step('planSearch')
      const planResult = await deps.plan(ctx, identity)
      journal.llmCall({ point: 'planSearch', prompt: '(see agent)', rawText: planResult.rawText, parsed: planResult.parsed, retries: planResult.retries, durationMs: planResult.durationMs })

      candidates = []
      let apiCalls = 0
      for (const q of planResult.parsed.queries) {
        if (apiCalls >= deps.maxApiCallsPerJob) break
        journal.step('assrtSearch', { q: q.q })
        const resp = await deps.assrt.search(q.q)
        apiCalls++
        if (resp.sub.subs.length > 0) { candidates = resp.sub.subs; break }
      }
      if (candidates.length === 0) {
        deps.cache.put(keys, { kind: 'negative', reason: 'no candidates from any query' })
        return finish('no_safe_match', { reasons: ['no candidates from any search query'] })
      }

      journal.step('rankCandidates', { count: candidates.length })
      const rankResult = await deps.rank(ctx, identity, candidates)
      journal.llmCall({ point: 'rankCandidates', prompt: '(see agent)', rawText: rankResult.rawText, parsed: rankResult.parsed, retries: rankResult.retries, durationMs: rankResult.durationMs })
      rank = rankResult.parsed
    }

    // 4. gate
    journal.step('gate')
    const gate = runGate(rank, candidates, identity, ctx.preferences)
    journal.step('gateResult', gate)
    if (!gate.ok) {
      if (gate.decision === 'no_safe_match' && !cached) {
        deps.cache.put(keys, { kind: 'negative', reason: gate.failures.join('; ') || 'agent declined' })
      }
      return finish(gate.decision, { reasons: gate.failures.length ? gate.failures : rank.reasons, confidence: rank.confidence })
    }

    // 5. resolve download URL（detail 的时效 URL）
    journal.step('resolveDownloadUrl')
    const detail = cached?.kind === 'positive'
      ? { sub: { subs: candidates } }
      : await deps.assrt.detail(rank.assrt_id!)
    const sub = detail.sub.subs.find(s => s.id === rank.assrt_id) ?? detail.sub.subs[0]
    if (!sub) return finish('error', { reasons: ['detail response contained no subs'] })
    const fileEntry = rank.file_index != null ? sub.filelist[rank.file_index] : undefined
    const url = fileEntry?.url ?? sub.url
    if (!url) return finish('error', { reasons: ['no download url in detail response'] })

    // 6. download + write
    journal.step('download', { url: url.slice(0, 80) })
    const dl = await deps.download(url)
    const artifactFilename = fileEntry?.f ?? sub.filename ?? 'subtitle.srt'
    journal.step('write')
    const written = await writeSubtitle({
      artifact: dl.bytes,
      artifactFilename,
      selectFileName: fileEntry?.f,
      videoFilename: ctx.media.filename,
      langTag: ctx.preferences.language,
      outDir,
    })
    if (written.alreadyExists) return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten'] })

    // 7. cache + finish
    if (!cached) {
      deps.cache.put(keys, { kind: 'positive', assrt_id: rank.assrt_id!, file_index: rank.file_index ?? null, confidence: rank.confidence })
    }
    return finish('download', {
      reasons: rank.reasons, confidence: rank.confidence,
      subtitlePath: written.path, bytes: written.bytes, encoding: written.encoding,
      fromCache: cached?.kind === 'positive',
    })
  } catch (e) {
    journal.step('error', { message: String(e) })
    return finish('error', { reasons: [String(e)] })
  }
}
```

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/core/pipeline.test.ts` — Expected: PASS（5 个用例）

注意第三个用例（负缓存跳过 ASSRT）要求 pipeline 在负缓存命中时**不调 search**——上面实现已满足；download URL 来自 fixture 的真实 detail 响应，`deps.download` 是 fake 所以不会真联网。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm test` — Expected: 全部 PASS

```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts
git commit -m "feat: fixed pipeline state machine with cache, gate, and audit journal"
```

---

### Task 12: cli/index.ts

**Files:**
- Create: `src/cli/index.ts`

- [ ] **Step 1: 实现** `src/cli/index.ts`

```ts
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { readFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaContextSchema } from '../core/schemas.js'
import { runPipeline, type PipelineDeps } from '../core/pipeline.js'
import { DecisionCache } from '../core/cache.js'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { downloadDirect } from '../adapters/download/direct.js'
import { makeModel } from '../agent/llm.js'
import { identifyMedia } from '../agent/identifyMedia.js'
import { planSearch } from '../agent/planSearch.js'
import { rankCandidates } from '../agent/rankCandidates.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`missing required env var: ${name}`); process.exit(2) }
  return v
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      context: { type: 'string' },
      out: { type: 'string', default: './output' },
    },
  })
  if (positionals[0] !== 'run' || !values.context) {
    console.error('usage: subtitle-scout run --context <media-context.json> [--out <dir>]')
    process.exit(2)
  }

  const ctx = MediaContextSchema.parse(JSON.parse(readFileSync(values.context, 'utf8')))
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const model = makeModel({
    baseUrl: requireEnv('LLM_BASE_URL'),
    apiKey: requireEnv('LLM_API_KEY'),
    model: requireEnv('LLM_MODEL'),
  })
  if (process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE) {
    ctx.preferences.auto_download_min_confidence = Number(process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE)
  }
  const assrt = new AssrtClient({
    token: requireEnv('ASSRT_TOKEN'),
    cacheDir: join(cacheRoot, 'assrt-responses'),
  })

  const deps: PipelineDeps = {
    identify: c => identifyMedia(model, c),
    plan: (c, id) => planSearch(model, c, id),
    rank: (c, id, cands) => rankCandidates(model, c, id, cands),
    assrt: { search: q => assrt.search(q), detail: id => assrt.detail(id) },
    download: url => downloadDirect(url),
    cache: new DecisionCache(join(cacheRoot, 'decisions')),
    maxApiCallsPerJob: 4,
  }

  const result = await runPipeline(deps, ctx, values.out!)
  console.log(JSON.stringify({
    decision: result.decision,
    subtitle: result.subtitlePath ?? null,
    journal: result.journalPath,
    fromCache: result.fromCache ?? false,
  }, null, 2))

  if (result.decision === 'download' || result.decision === 'already_exists') process.exit(0)
  if (result.decision === 'error') process.exit(2)
  process.exit(1) // no_safe_match / ask_user / retry_later
}

main().catch(e => { console.error(e); process.exit(2) })
```

- [ ] **Step 2: 无凭据烟测（验证参数解析与报错路径）**

Run: `npx tsx src/cli/index.ts run --context fixtures/contexts/matrix.json 2>&1; echo "exit=$?"`
Expected: `missing required env var: LLM_BASE_URL`，`exit=2`

Run: `npm run check && npm test`
Expected: 全部通过

- [ ] **Step 3: 提交**

```bash
git add src/cli/
git commit -m "feat: CLI entry with env config and exit-code contract"
```

---

### Task 13: 端到端冒烟脚本（手动，真 API）

**Files:**
- Create: `scripts/e2e-smoke.sh`

- [ ] **Step 1: 写脚本** `scripts/e2e-smoke.sh`

```bash
#!/usr/bin/env bash
# 手动端到端冒烟：真调 LLM + ASSRT + 真下载。消耗 ASSRT 配额，不进 CI。
# 前置：.env 已配好 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/ASSRT_TOKEN
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=$(mktemp -d)
echo "output dir: $OUT"
# 用独立缓存目录，保证真实走 API 而不是吃旧缓存
SUBTITLE_SCOUT_CACHE_DIR=$(mktemp -d) npx tsx src/cli/index.ts run \
  --context fixtures/contexts/matrix.json --out "$OUT"
echo "--- decision.json ---"
python3 -m json.tool "$OUT/decision.json" | head -40
echo "--- files ---"
ls -la "$OUT"
file "$OUT"/*.ass "$OUT"/*.srt 2>/dev/null || true
```

```bash
chmod +x scripts/e2e-smoke.sh
```

- [ ] **Step 2: 真跑一次（需要 .env）**

先创建本地 `.env`（已在 .gitignore）：从 `~/projects/token(1).txt` 取 `XIAOMI_API_KEY` 填入 `LLM_API_KEY`；`LLM_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1`；`LLM_MODEL=mimo-v2.5`；`ASSRT_TOKEN` 用用户提供的 token。

Run: `./scripts/e2e-smoke.sh`
Expected: exit 0；输出目录出现 `The.Matrix.1999.1080p.BluRay.x264.zh-Hans.ass`（或 .srt）非零字节；decision.json 含 3 条 llm_calls、若干 api_calls、decision=download。

若 ASSRT 配额触顶（status 30900 系），等 1 分钟重跑。若 LLM/网络瞬时 TLS 错误，重跑（家庭网络实测有偶发抖动）。

- [ ] **Step 3: 提交**

```bash
git add scripts/e2e-smoke.sh
git commit -m "chore: manual e2e smoke script (real LLM + ASSRT)"
```

---

### Task 14: README + 收尾

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 README**

```markdown
# subtitle-scout

当你在 Jellyfin 里点开一部没有中文字幕的外语片，subtitle-scout 自动找到、
验证并放好最合适的中文字幕。它不是又一个字幕下载器——它是一层带判断力的
匹配智能：宁可不下，也不下错。

## 状态

Milestone 1（CLI 黄金路径）已完成：给定媒体上下文 JSON，完成
识别 → 搜索 → 排序 → 校验 → 下载 → 落盘 全链路。
Jellyfin sidecar（自动监听播放）在 Milestone 2。

## 快速试用

```bash
cp .env.example .env   # 填入 LLM 与 ASSRT 凭据
npm install
npx tsx src/cli/index.ts run --context fixtures/contexts/matrix.json --out ./output
```

输出：`output/<视频名>.zh-Hans.ass` + `output/decision.json`（完整决策审计：
选了谁、为什么、拒了谁、每次 LLM/API 调用的原文）。

Exit code：`0` 成功；`1` 没有安全匹配（正常结果）；`2` 出错。

## 配置

| 环境变量 | 说明 |
|---|---|
| `LLM_BASE_URL` | 任意 OpenAI 兼容端点（官方 API、new-api/one-api 网关、Ollama…） |
| `LLM_API_KEY` | 上述端点的 key |
| `LLM_MODEL` | 模型名 |
| `ASSRT_TOKEN` | [assrt.net](https://assrt.net) API token |
| `AUTO_DOWNLOAD_MIN_CONFIDENCE` | 自动下载置信度阈值，默认 0.86 |
| `SUBTITLE_SCOUT_CACHE_DIR` | 缓存目录，默认 `~/.subtitle-scout/cache` |

## 设计

见 `docs/product-shape.md` 与 `docs/superpowers/specs/`。核心原则：

- 固定流水线 + LLM 只在岔路口做判断，输出全部过 Zod + 纯代码 gate;
- LLM 无权直接下载/写盘；
- 错字幕比没字幕伤害大。
```

- [ ] **Step 2: 全量验证 + 提交**

Run: `npm run check && npm test`
Expected: 全部通过

```bash
git add README.md
git commit -m "docs: README for milestone 1"
```

---

## Self-Review 结果（已执行）

- **Spec 覆盖**：schemas(Task 2)、journal(3)、cache(4)、ASSRT client 限速/缓存/status(5)、direct 下载(6)、zip/编码/命名/不覆盖/rar 拒绝(7)、tool 强制 + 重试 + 4000 token(8)、三判断点(9)、gate 五条规则(10)、流水线含负缓存/查询递进/单任务 API 上限(11)、CLI 环境变量与 exit code(12)、e2e 冒烟(13)。спec 中「配额耗尽 → retry_later」在 v1 简化为 AssrtApiError → error 路径 + journal 记录，Milestone 2 引入队列时再区分——此为有意偏离，不是遗漏。
- **占位符扫描**：无 TBD/TODO；Task 8/9 的「以安装版本类型为准」是给定 SDK 版本漂移风险下的显式适配指令，附带了不可变语义约束。
- **类型一致性**：`CallStructuredResult`(8) 被 9/11 引用一致；`CacheEntry`(4) 与 pipeline(11) 一致；`AssrtSub.filelist` 统一经 preprocess 为数组(2)，gate(10) 与 writer(7) 均按数组处理。
```
