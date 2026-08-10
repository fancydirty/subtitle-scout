# Milestone 5b: 匹配准确率修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复生产实证的三类匹配准确率 bug——rank 病态保守毙掉可用字幕、裸标题查询埋老片、缺中文片名上下文——让外语片能稳定找到靠谱中文字幕。

**Architecture:** 三味药全在既有四判断点流水线内，零新特性、零新配额敏感路径。(A) 在 rank 之前加一个纯函数格式硬过滤剔除全图形字幕，并校准 rank prompt 的决策门槛；(B) 重写 planSearch prompt 为"标题+年份"策略，pipeline 改为跑前 2 条查询取并集去重（不再第一条非空就停）；(C) 给 JellyfinClient 加 `getChineseTitle`（RemoteSearch zh-CN，失败静默），把中文名与简介注入 MediaContext 供 identify/planSearch 用。

**Tech Stack:** TypeScript NodeNext ESM、Zod v4、Vitest、Vercel AI SDK v6（判断点不动签名）、Jellyfin REST（RemoteSearch）、ASSRT API。

**Spec:** `docs/superpowers/specs/2026-07-07-milestone5b-match-accuracy-design.md`

---

## File Structure

改动集中在既有文件，无新增模块：

- `src/agent/rankCandidates.ts` — 新增导出纯函数 `isGraphicOnly` / `filterGraphicOnly`；`MAX_CANDIDATES` 12→15；rank prompt 三条硬规则校准。
- `src/agent/rankCandidates.test.ts` — 新增格式硬过滤单测。
- `src/core/pipeline.ts` — search 段改为"前 2 条查询并集去重 + 格式硬过滤"，区分"搜不到"与"仅图形字幕"两种 no_safe_match。
- `src/core/pipeline.test.ts` — 新增并集去重 / 图形过滤的流水线测试。
- `src/agent/planSearch.ts` — prompt 重写为"标题+年份"策略，消费 `ctx.media.alternative_titles`。
- `src/agent/identifyMedia.ts` — prompt 纳入 `alternative_titles` + `overview`。
- `src/adapters/players/jellyfin.ts` — `call()` 支持可选 JSON body；`JellyfinItemSchema` 加 `Overview`；`ITEM_FIELDS` 加 `Overview`；新增 `JellyfinRemoteSearch*` schema 与 `getChineseTitle()`。
- `src/adapters/players/jellyfin.test.ts` — 新增 `getChineseTitle` 单测（成功/空结果/报错静默/无 provider id）。
- `src/core/schemas.ts` — `MediaContextSchema.media` 加 `alternative_titles: string[]` 与 `overview: string | null`。
- `src/core/mediaContext.ts` — `buildMediaContext` 新增可选 `enrichment` 参数，产出 `alternative_titles` / `overview`。
- `src/core/mediaContext.test.ts` — 新增 enrichment 映射单测。
- `src/daemon/watcher.ts` — `WatcherDeps.jellyfin` 接口加 `getChineseTitle`；`maybeProcess` 取中文名后传入 `buildMediaContext`。
- `src/daemon/watcher.test.ts` — 更新 fake jellyfin 补 `getChineseTitle`。
- `src/cli/index.ts` — `makeJellyfin` 用法处接线 `getChineseTitle`；`cmdRunItem` 与 watcher 装配传 enrichment。

---

## Task 1: 格式硬过滤纯函数 + MAX_CANDIDATES 15

**Files:**
- Modify: `src/agent/rankCandidates.ts:7`（`MAX_CANDIDATES`）与文件顶部（新增纯函数）
- Test: `src/agent/rankCandidates.test.ts`

背景：ASSRT 候选的 `filelist` 是文件名数组（`{ f: string }[]`），零结果时可能为空数组。本产品只处理文本字幕（srt/ass/ssa）。判定规则（保守，宁可漏剔不可误杀）：候选含任一文本扩展名 → 可用（保留，即便包内还有图形文件，rank 会挑文本 file_index）；否则若 filelist 全非文本且命中图形签名（PGS 的 `.sup`，或 VobSub 的 `.idx`+`.sub` 成对）→ 剔除；孤立 `.sub`（可能是 MicroDVD 文本）或未知扩展 → 不剔，交 rank 判；filelist 为空时仅当 `subtype` 明确图形（pgs/vobsub）才剔。`subtype` 为 `None`/缺失**绝不**作为剔除依据（常是特效 ass）。

- [ ] **Step 1: 写失败测试**

在 `src/agent/rankCandidates.test.ts` 顶部 import 增补，并追加 describe 块：

```typescript
import { compactCandidates, filterGraphicOnly, isGraphicOnly, MAX_CANDIDATES, MAX_FILELIST_ENTRIES } from './rankCandidates.js'
```

```typescript
function subWithFiles(id: number, files: string[], subtype: string | null = null): AssrtSub {
  return {
    id, videoname: `v${id}`, native_name: null, release_site: null, subtype,
    lang: { desc: '简', langlist: null }, filename: null, size: null,
    filelist: files.map(f => ({ f })),
  } as unknown as AssrtSub
}

describe('isGraphicOnly', () => {
  it('keeps candidates that contain any text subtitle', () => {
    expect(isGraphicOnly(subWithFiles(1, ['movie.chs.srt']))).toBe(false)
    expect(isGraphicOnly(subWithFiles(2, ['movie.ass']))).toBe(false)
    expect(isGraphicOnly(subWithFiles(3, ['movie.ssa']))).toBe(false)
  })
  it('keeps mixed packs that contain at least one text file', () => {
    expect(isGraphicOnly(subWithFiles(4, ['movie.sup', 'movie.chs.srt']))).toBe(false)
  })
  it('rejects PGS-only (.sup) packs', () => {
    expect(isGraphicOnly(subWithFiles(5, ['movie.sup']))).toBe(true)
  })
  it('rejects VobSub .idx+.sub pairs', () => {
    expect(isGraphicOnly(subWithFiles(6, ['movie.idx', 'movie.sub']))).toBe(true)
  })
  it('does NOT reject a lone .sub (may be MicroDVD text)', () => {
    expect(isGraphicOnly(subWithFiles(7, ['movie.sub']))).toBe(false)
  })
  it('does NOT reject on subtype=None with empty filelist (often effect ass)', () => {
    expect(isGraphicOnly(subWithFiles(8, [], 'None'))).toBe(false)
    expect(isGraphicOnly(subWithFiles(9, [], null))).toBe(false)
  })
  it('rejects empty filelist only when subtype is explicitly graphic', () => {
    expect(isGraphicOnly(subWithFiles(10, [], 'PGS'))).toBe(true)
    expect(isGraphicOnly(subWithFiles(11, [], 'VobSub'))).toBe(true)
  })
})

describe('filterGraphicOnly', () => {
  it('removes graphic-only candidates and preserves order', () => {
    const cands = [
      subWithFiles(1, ['a.chs.srt']),
      subWithFiles(2, ['b.sup']),
      subWithFiles(3, ['c.ass']),
    ]
    const out = filterGraphicOnly(cands)
    expect(out.map(c => c.id)).toEqual([1, 3])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/rankCandidates.test.ts`
Expected: FAIL — `filterGraphicOnly`/`isGraphicOnly` is not exported.

- [ ] **Step 3: 实现纯函数并改常量**

在 `src/agent/rankCandidates.ts` 顶部（`import` 之后、`MAX_CANDIDATES` 定义处）：把 `export const MAX_CANDIDATES = 12` 改为 `export const MAX_CANDIDATES = 15`，并在 `compactCandidates` 之前插入：

```typescript
const TEXT_SUB_EXT = /\.(srt|ass|ssa)$/i
const GRAPHIC_SUBTYPE = /pgs|vobsub|pgssub/i

/**
 * 候选是否"仅图形字幕"（本产品只处理文本字幕）。保守判定：
 * - 含任一文本扩展名 → 可用（false），即便包内混有图形文件；
 * - 全非文本且命中图形签名（PGS .sup，或 VobSub .idx+.sub 成对）→ 剔除（true）；
 * - 孤立 .sub / 未知扩展 → 不剔（交 rank）；
 * - filelist 为空时仅当 subtype 明确图形才剔。subtype=None/缺失从不作为剔除依据。
 */
export function isGraphicOnly(c: AssrtSub): boolean {
  const names = c.filelist.map(f => f.f)
  if (names.some(n => TEXT_SUB_EXT.test(n))) return false
  if (names.length > 0) {
    const hasSup = names.some(n => /\.sup$/i.test(n))
    const hasIdx = names.some(n => /\.idx$/i.test(n))
    const hasSub = names.some(n => /\.sub$/i.test(n))
    return hasSup || (hasIdx && hasSub)
  }
  return !!c.subtype && GRAPHIC_SUBTYPE.test(c.subtype)
}

/** 剔除仅图形字幕的候选，保序。 */
export function filterGraphicOnly(candidates: AssrtSub[]): AssrtSub[] {
  return candidates.filter(c => !isGraphicOnly(c))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/rankCandidates.test.ts`
Expected: PASS（含既有 `compactCandidates` 三例——`caps candidate count` 用导入常量 `MAX_CANDIDATES`，自动跟随 15）。

- [ ] **Step 5: 提交**

```bash
git add src/agent/rankCandidates.ts src/agent/rankCandidates.test.ts
git commit -m "feat(rank): graphic-only format hard filter + MAX_CANDIDATES 15"
```

---

## Task 2: pipeline 并集召回 + 格式过滤接入

**Files:**
- Modify: `src/core/pipeline.ts:131-148`（search 段）
- Test: `src/core/pipeline.test.ts`

背景：现状 search 段"第一条非空查询就 break"（`pipeline.ts:143`），会停在噪声查询上。改为跑**前 2 条查询**、按 assrt id 并集去重，再 `filterGraphicOnly`，最后区分两种空集：原始候选非空但全图形 → 理由"仅存图形字幕"；原始就搜不到 → "no candidates"。配额不变：search ≤ 2 + detail 1 = 3 ≤ `maxApiCallsPerJob`(4)。

- [ ] **Step 1: 写失败测试**

在 `src/core/pipeline.test.ts` 顶部补 import：

```typescript
import { filterGraphicOnly } from '../agent/rankCandidates.js'
```

追加两个用例到 `describe('runPipeline', ...)` 内。第一个断言并集去重跑了两条查询；第二个断言全图形候选走"仅图形" no_safe_match。注意 rank 的 fake 里 `assrt_id: 673114` 对应 detail fixture，第一个用例让两条查询各返回一条不同 id、rank 选其中之一：

```typescript
it('unions first two queries, dedups by id, does not stop at first non-empty', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'out-'))
  const searchA = AssrtSearchResponseSchema.parse({
    status: 0, sub: { subs: [{ id: 673114, videoname: 'A', filelist: [{ f: 'a.srt' }] }] },
  })
  const searchB = AssrtSearchResponseSchema.parse({
    status: 0, sub: { subs: [
      { id: 673114, videoname: 'A-dup', filelist: [{ f: 'a.srt' }] },
      { id: 800000, videoname: 'B', filelist: [{ f: 'b.ass' }] },
    ] },
  })
  const search = vi.fn()
    .mockResolvedValueOnce(searchA)
    .mockResolvedValueOnce(searchB)
  const rank = vi.fn(async (_c: unknown, _id: unknown, cands: { id: number }[]) => ({
    parsed: {
      decision: 'download' as const, assrt_id: 673114, file_index: 0,
      confidence: 0.91, reasons: ['union'], rejected: [],
      _seen: cands.map(c => c.id),
    }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
  }))
  const deps = makeDeps({
    plan: vi.fn(async () => ({
      parsed: { queries: [
        { q: 'title 1999', reason: 'year' },
        { q: 'title bluray', reason: 'broad' },
      ] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'plan prompt',
    })),
    assrt: { search, detail: vi.fn(async () => detailResp) },
    rank: rank as unknown as PipelineDeps['rank'],
  })
  const result = await runPipeline(deps, ctx, outDir)
  expect(search).toHaveBeenCalledTimes(2)             // 不再第一条非空就停
  expect(result.decision).toBe('download')
  // rank 收到并集去重后的候选：673114 + 800000（673114 不重复）
  const seen = (rank.mock.results[0].value as any).parsed._seen as number[]
  expect(seen.sort()).toEqual([673114, 800000])
})

it('graphic-only candidates yield no_safe_match with graphic reason', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'out-'))
  const graphicResp = AssrtSearchResponseSchema.parse({
    status: 0, sub: { subs: [{ id: 900001, videoname: 'G', filelist: [{ f: 'g.sup' }] }] },
  })
  const deps = makeDeps({
    assrt: { search: vi.fn(async () => graphicResp), detail: vi.fn(async () => detailResp) },
  })
  const result = await runPipeline(deps, ctx, outDir)
  expect(result.decision).toBe('no_safe_match')
  const journal = JSON.parse(readFileSync(join(outDir, 'decision.json'), 'utf8'))
  expect(JSON.stringify(journal.decision.reasons)).toContain('图形字幕')
  expect(deps.rank).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/pipeline.test.ts`
Expected: FAIL — 现状只调 search 一次（`search` 被调 1 次而非 2 次），图形候选未过滤会走到 rank。

- [ ] **Step 3: 改 pipeline search 段**

把 `src/core/pipeline.ts` 的 136–148 行（`candidates = []` 到第一个空集 `return finish` 之间）替换为：

```typescript
      // 跑前 2 条查询，按 assrt id 并集去重（ASSRT 单条查询受上传时间偏置，并集提召回）
      const queries = planResult.parsed.queries.slice(0, 2)
      const byId = new Map<number, AssrtSub>()
      let apiCalls = 0
      for (const q of queries) {
        if (apiCalls >= deps.maxApiCallsPerJob) break
        journal.step('assrtSearch', { q: q.q })
        const resp = await deps.assrt.search(q.q)
        apiCalls++
        for (const s of resp.sub.subs) if (!byId.has(s.id)) byId.set(s.id, s)
      }
      const raw = [...byId.values()]
      candidates = filterGraphicOnly(raw)
      journal.step('candidateFilter', { raw: raw.length, kept: candidates.length })
      if (candidates.length === 0) {
        const reason = raw.length > 0
          ? '仅存图形字幕，本产品处理文本字幕'
          : 'no candidates from any search query'
        deps.cache.put(keys, { kind: 'negative', reason })
        return finish('no_safe_match', { reasons: [reason] })
      }
```

并在 `src/core/pipeline.ts` 顶部 import 增补：

```typescript
import { filterGraphicOnly } from '../agent/rankCandidates.js'
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/pipeline.test.ts`
Expected: PASS（既有 golden path 仍绿——其 plan fixture 只有 1 条 query，`slice(0,2)` 取到 1 条，search 调 1 次；rank/detail 不变）。

- [ ] **Step 5: 提交**

```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts
git commit -m "feat(pipeline): union first-2 queries + graphic-only filter before rank"
```

---

## Task 3: rank prompt 三条硬规则校准

**Files:**
- Modify: `src/agent/rankCandidates.ts:36-52`（`prompt` 数组）

背景：实证根因 A——rank 以"分辨率/来源不匹配、sup 格式"为由毙掉可用 srt/ssa 中字。校准决策门槛：格式可用范围明确、来源差异非拒绝理由、存在可用中字时倾向 download。**惯例：判断点 prompt 不写断言单测，靠 controller 真实验证**（见 Task 8）。保留既有的 pack `file_index`、剧集季集必须匹配、truncation 边界等硬约束。

- [ ] **Step 1: 替换 prompt 数组**

把 `src/agent/rankCandidates.ts` 中 `const prompt = [ ... ].join('\n')` 整段替换为：

```typescript
  const prompt = [
    'Choose the best Chinese subtitle for this media from ASSRT candidates, or refuse.',
    'A WRONG subtitle is worse than NO subtitle — but refusing a usable one is also a failure.',
    '',
    'FORMAT — which candidates are usable:',
    '- Text subtitles (srt / ass / ssa, including those extensions inside filelist) are ALL usable.',
    '- subtype=None or missing is NOT a reason to reject — it is usually an effect/styled .ass.',
    '- Only truly graphic-only packs (PGS .sup, VobSub .idx+.sub) are unusable, and those have',
    '  already been filtered out before you see them; assume every candidate here has text.',
    '',
    'MATCHING — what is and is NOT a rejection reason:',
    '- Resolution / source (BluRay vs WEB-DL) / codec / release-group differences are NOT rejection',
    '  reasons. The same film\'s subtitle timing is generally interchangeable across these.',
    '- REAL risks that justify rejection: director\'s-cut vs theatrical runtime gaps, and for episodes',
    '  a season/episode mismatch (season AND episode must match exactly).',
    '- If a candidate is a pack (filelist has multiple files), you MUST pick the specific file_index',
    '  whose filename matches THIS media. A trilogy pack whose files are other movies is a trap.',
    '',
    'DECISION THRESHOLD:',
    '- When a candidate is format-usable + contains Chinese + title/year matches, prefer decision=download.',
    '- Prefer an imperfect source over going empty-handed.',
    '- decision=no_safe_match ONLY when no usable Chinese text subtitle exists.',
    '- decision=ask_user when a match is plausible but genuinely ambiguous.',
    `- User preferences: ${JSON.stringify(ctx.preferences)}`,
    '',
    'file_index is the 0-based index into the candidate\'s filelist array; null for non-pack candidates.',
    'If the filelist was truncated (filelist_truncated present), only pick from the shown entries.',
    'List every seriously-considered-but-rejected candidate in rejected[] with a concrete reason.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `media filename: ${ctx.media.filename}`,
    `candidates: ${JSON.stringify(compact)}`,
  ].join('\n')
```

- [ ] **Step 2: 跑全量测试确认无回归**

Run: `npx vitest run`
Expected: PASS（prompt 是纯字符串拼接，`compactCandidates` 测试与 gate 逻辑不受影响）。

- [ ] **Step 3: 提交**

```bash
git add src/agent/rankCandidates.ts
git commit -m "feat(rank): calibrate decision threshold — source diff not a rejection reason"
```

---

## Task 4: planSearch"标题+年份"策略重写

**Files:**
- Modify: `src/agent/planSearch.ts`（整个 `prompt`）

背景：实证根因 B——裸标题按上传时间排序埋老片、超具体 release 文件名让噪声排前。改为强制带年份、中文名优先、禁超具体文件名查询。消费 Task 6 引入的 `ctx.media.alternative_titles`（含中文名）。SearchPlanSchema 已允许 1–3 条，无需改 schema。**prompt 改动无断言单测，靠 controller 验证。**

- [ ] **Step 1: 重写 prompt**

把 `src/agent/planSearch.ts` 中 `const prompt = [ ... ].join('\n')` 整段替换为：

```typescript
  const alt = ctx.media.alternative_titles.length ? ctx.media.alternative_titles.join(', ') : 'none'
  const year = identity.year ?? ctx.media.year ?? 'unknown'
  const prompt = [
    'Plan 2-3 search queries for ASSRT (assrt.net), a Chinese-language subtitle site.',
    'ASSRT sorts results by upload time, so a bare title buries an older film under newer',
    'same-name releases. ALWAYS include the year to disambiguate.',
    '',
    'Query priority (generate in this order):',
    '1. "<Chinese title> <year>" when a Chinese/alternative title is known — ASSRT is a Chinese site,',
    '   so this is the strongest query.',
    '2. "<original/English title> <year>".',
    '3. "<original/English title>" as a fallback (no year).',
    'For a series film you may use the common Chinese numbered title (e.g. "招魂4 2025").',
    '',
    'DO NOT generate hyper-specific release-filename queries (full scene names with codec/group);',
    'they push noise to the top of ASSRT\'s time-sorted results.',
    'The pipeline runs the first two queries and unions the results, so make the first two count.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `chinese/alternative titles: ${alt}`,
    `year: ${year}`,
    `filename: ${ctx.media.filename}`,
  ].join('\n')
```

- [ ] **Step 2: 跑全量测试确认无回归**

Run: `npx vitest run`
Expected: PASS（planSearch 无专属断言单测；pipeline 测试用注入的 fake plan，不受真实 prompt 影响）。

- [ ] **Step 3: 提交**

```bash
git add src/agent/planSearch.ts
git commit -m "feat(plan): title+year query strategy, chinese-title priority, no release-filename queries"
```

---

## Task 5: JellyfinClient.getChineseTitle

**Files:**
- Modify: `src/adapters/players/jellyfin.ts`（`call` 加 body、`JellyfinItemSchema` 加 `Overview`、`ITEM_FIELDS`、新 schema、新方法）
- Test: `src/adapters/players/jellyfin.test.ts`

背景：实证根因 C——ASSRT 是中文站，缺中文片名上下文。Jellyfin `POST /Items/RemoteSearch/Movie`（或 `/Series`）带 `MetadataLanguage: zh-CN` + provider_ids 实测可取中文译名（tmdb=937941 → 「寻踪迷镇」）。**失败/无 provider id/非 Movie|Series 一律静默返回 null，绝不阻塞主流程。** Episode 出于 scope 返回 null（其 provider id 是集级、系列名检索另需 series id，本里程碑不做；剧集极少需中文名消歧）。

- [ ] **Step 1: 写失败测试**

在 `src/adapters/players/jellyfin.test.ts` 追加。用注入的 `fetchImpl` fake（现有测试已用此模式）。注意：文件顶部已 `import { JellyfinClient, ... } from './jellyfin.js'` 与 `vi`——**不要重复 import**，只把 `JellyfinItem` 类型加到那一行现有 import（`import { JellyfinClient, JellyfinSessionsSchema, JellyfinItemsResponseSchema, type JellyfinItem } from './jellyfin.js'`）。断言四种情形：

```typescript
function movieItem(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: 'x1', Name: 'Shelby Oaks', Type: 'Movie', ProductionYear: 2024,
    ProviderIds: { Tmdb: '937941' }, ...overrides,
  } as JellyfinItem
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, text: async () => JSON.stringify(body) } as unknown as Response
}

describe('getChineseTitle', () => {
  it('returns the first zh-CN RemoteSearch result name', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ Name: '寻踪迷镇', ProductionYear: 2024 }]))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem())).toBe('寻踪迷镇')
    const [, init] = fetchImpl.mock.calls[0]
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/Items/RemoteSearch/Movie')
    expect((init as RequestInit).method).toBe('POST')
    const sent = JSON.parse((init as RequestInit).body as string)
    expect(sent.SearchInfo.MetadataLanguage).toBe('zh-CN')
    expect(sent.SearchInfo.ProviderIds).toEqual({ Tmdb: '937941' })
  })
  it('returns null on empty results', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem())).toBeNull()
  })
  it('returns null silently on HTTP error (never throws)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem())).toBeNull()
  })
  it('returns null without calling when item has no provider ids', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ Name: 'x' }]))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem({ ProviderIds: {} }))).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('returns null for non-movie/series types', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ Name: 'x' }]))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem({ Type: 'Episode' }))).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/adapters/players/jellyfin.test.ts`
Expected: FAIL — `getChineseTitle` 不存在。

- [ ] **Step 3: 实现**

3a. `call` 支持可选 body。把 `src/adapters/players/jellyfin.ts` 的 `private async call` 签名与 fetch 调用改为：

```typescript
  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const t0 = Date.now()
    const url = `${this.opts.baseUrl}${path}`
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          'X-Emby-Token': this.opts.apiKey,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const durationMs = Date.now() - t0
      this.opts.onApiCall?.({ endpoint: path, params: {}, status: res.status, durationMs })
      if (!res.ok) throw new Error(`jellyfin ${method} ${path}: HTTP ${res.status}`)
      const text = await res.text()
      return text ? JSON.parse(text) : null
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith('jellyfin '))) {
        this.opts.onApiCall?.({ endpoint: path, params: {}, status: null, durationMs: Date.now() - t0, error: String(e) })
      }
      throw e
    }
  }
```

3b. `JellyfinItemSchema` 加 `Overview` 字段（在 `DateCreated` 行后、`.passthrough()` 前）：

```typescript
  DateCreated: z.string().nullish(),
  Overview: z.string().nullish(),
}).passthrough()
```

3c. `ITEM_FIELDS` 加 `Overview`：

```typescript
const ITEM_FIELDS = 'Path,ProviderIds,MediaStreams,OriginalTitle,ProductionLocations,Overview'
```

3d. 在 `JellyfinItemsResponseSchema` 之后新增 RemoteSearch schema：

```typescript
export const JellyfinRemoteSearchResultSchema = z.object({
  Name: z.string().nullish(),
  ProductionYear: z.number().nullish(),
}).passthrough()
export const JellyfinRemoteSearchSchema = z.array(JellyfinRemoteSearchResultSchema)
```

3e. 在 `JellyfinClient` 类内（`getRecentItems` 之后）新增方法：

```typescript
  /**
   * 用 Jellyfin 的 zh-CN RemoteSearch 取中文译名。失败/无 provider id/非 Movie|Series
   * 一律静默返回 null——Jellyfin 刮削不可达即等价于此，绝不阻塞主流程。
   */
  async getChineseTitle(item: JellyfinItem): Promise<string | null> {
    const endpoint = item.Type === 'Movie' ? 'Movie' : item.Type === 'Series' ? 'Series' : null
    if (!endpoint) return null
    const providerIds = item.ProviderIds ?? {}
    if (Object.keys(providerIds).length === 0) return null
    try {
      const body = {
        SearchInfo: {
          Name: item.Name,
          Year: item.ProductionYear ?? undefined,
          ProviderIds: providerIds,
          MetadataLanguage: 'zh-CN',
        },
        ItemId: item.Id,
      }
      const raw = await this.call('POST', `/Items/RemoteSearch/${endpoint}`, body)
      const results = JellyfinRemoteSearchSchema.parse(raw)
      const name = results[0]?.Name?.trim()
      return name && name.length > 0 ? name : null
    } catch {
      return null
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/adapters/players/jellyfin.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/adapters/players/jellyfin.ts src/adapters/players/jellyfin.test.ts
git commit -m "feat(jellyfin): getChineseTitle via zh-CN RemoteSearch (silent-null on failure)"
```

---

## Task 6: MediaContext 增字段 + buildMediaContext enrichment

**Files:**
- Modify: `src/core/schemas.ts:28-45`（`media` 对象）
- Modify: `src/core/mediaContext.ts:25-56`（`buildMediaContext`）
- Test: `src/core/mediaContext.test.ts`

背景：把中文名与简介带进上下文供 identify/planSearch 消费。`alternative_titles` 仅收 `getChineseTitle` 结果（去重、排除与 title/original_title 相同者）；`overview` 取 `item.Overview`。`buildMediaContext` 保持同步纯函数，网络调用（getChineseTitle）由调用方在外面做完再以 `enrichment` 传入。

- [ ] **Step 1: 写失败测试**

在 `src/core/mediaContext.test.ts` 追加。注意：文件顶部已 `import { buildMediaContext, ... } from './mediaContext.js'`——**不要重复 import `buildMediaContext`**；只需新增一行类型 import `import type { JellyfinItem } from '../adapters/players/jellyfin.js'`（现有 import 的是 `JellyfinItemsResponseSchema`，类型未引，故这行是新增的）：

```typescript
function baseMovie(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: 'm1', Name: 'Shelby Oaks', Type: 'Movie', Path: '/media/movies/Shelby Oaks (2024)/x.mkv',
    ProductionYear: 2024, OriginalTitle: 'Shelby Oaks', Overview: 'A woman searches for her sister.',
    ...overrides,
  } as JellyfinItem
}

describe('buildMediaContext enrichment', () => {
  it('sets overview from item.Overview and defaults alternative_titles to []', () => {
    const ctx = buildMediaContext(baseMovie(), [])
    expect(ctx.media.overview).toBe('A woman searches for her sister.')
    expect(ctx.media.alternative_titles).toEqual([])
  })
  it('adds a distinct chinese title to alternative_titles', () => {
    const ctx = buildMediaContext(baseMovie(), [], { chineseTitle: '寻踪迷镇' })
    expect(ctx.media.alternative_titles).toEqual(['寻踪迷镇'])
  })
  it('drops a chinese title equal to the display or original title', () => {
    const ctx = buildMediaContext(baseMovie(), [], { chineseTitle: 'Shelby Oaks' })
    expect(ctx.media.alternative_titles).toEqual([])
  })
  it('tolerates missing Overview and null enrichment', () => {
    const ctx = buildMediaContext(baseMovie({ Overview: null }), [], { chineseTitle: null })
    expect(ctx.media.overview).toBeNull()
    expect(ctx.media.alternative_titles).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/mediaContext.test.ts`
Expected: FAIL — `overview`/`alternative_titles` 不在解析后的 ctx 上，enrichment 第 3 参不被接受。

- [ ] **Step 3a: schema 加字段**

在 `src/core/schemas.ts` 的 `media: z.object({ ... })` 内，`existing_subtitles` 定义之后、`media` 对象闭合前插入：

```typescript
    alternative_titles: z.array(z.string()).default([]),
    overview: z.string().nullish(),
```

- [ ] **Step 3b: buildMediaContext 接 enrichment**

把 `src/core/mediaContext.ts` 的 `buildMediaContext` 改为：

```typescript
export function buildMediaContext(
  item: JellyfinItem,
  mappings: PathMapping[],
  enrichment: { chineseTitle?: string | null } = {},
): MediaContext {
  if (!item.Path) throw new Error(`jellyfin item ${item.Id} has no Path`)
  const path = mapPath(item.Path, mappings)
  const isEpisode = item.Type === 'Episode'
  const title = isEpisode ? (item.SeriesName ?? item.Name) : item.Name
  const alternative_titles = [enrichment.chineseTitle]
    .filter((t): t is string =>
      !!t && t.trim().length > 0 && t !== title && t !== item.OriginalTitle)
  return MediaContextSchema.parse({
    request_id: `jf-${item.Id}-${Date.now()}`,
    trigger: 'playback_start',
    media: {
      type: isEpisode ? 'episode' : 'movie',
      path,
      filename: basename(path),
      title,
      original_title: item.OriginalTitle ?? null,
      year: item.ProductionYear ?? null,
      season: item.ParentIndexNumber ?? null,
      episode: item.IndexNumber ?? null,
      runtime_minutes: item.RunTimeTicks ? Math.round(item.RunTimeTicks / TICKS_PER_MINUTE) : null,
      provider_ids: Object.fromEntries(
        Object.entries(item.ProviderIds ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      production_locations: item.ProductionLocations ?? [],
      alternative_titles,
      overview: item.Overview ?? null,
      existing_subtitles: (item.MediaStreams ?? [])
        .filter(s => s.Type === 'Subtitle')
        .map(s => ({
          language: s.Language ?? 'und',
          format: s.Codec ?? 'unknown',
          source: s.IsExternal ? 'external' : 'embedded',
        })),
    },
    preferences: {},
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/mediaContext.test.ts`
Expected: PASS。既有 `buildMediaContext` 测试（不传第 3 参）仍绿——`enrichment` 默认 `{}`，`alternative_titles` 默认 `[]`。

- [ ] **Step 5: 提交**

```bash
git add src/core/schemas.ts src/core/mediaContext.ts src/core/mediaContext.test.ts
git commit -m "feat(context): alternative_titles + overview fields with enrichment param"
```

---

## Task 7: 接线 enrichment 到 watcher / cli，identify prompt 消费

**Files:**
- Modify: `src/daemon/watcher.ts:15-38`（`WatcherDeps.jellyfin`）与 `:100`（`buildMediaContext` 调用）
- Modify: `src/daemon/watcher.test.ts`（fake jellyfin 补 `getChineseTitle`）
- Modify: `src/cli/index.ts:151`（`cmdRunItem`）与 `:216-221`（watcher 装配 jellyfin）
- Modify: `src/agent/identifyMedia.ts`（prompt 纳入两个新信号）

背景：把 `getChineseTitle` 拉进 watcher 的 jellyfin 依赖接口，`maybeProcess` 在通过类型/国产/缺字幕三关后、`buildMediaContext` 前取中文名。cli 的 `cmdRunItem` 与 watch 装配同样接线。identify prompt 读 `alternative_titles`/`overview`。

- [ ] **Step 1: watcher 接口 + 调用点**

7a. `src/daemon/watcher.ts` 的 `WatcherDeps.jellyfin` 接口加一行（在 `getRecentItems` 后）：

```typescript
    getRecentItems: (limit: number) => Promise<JellyfinItem[]>
    getChineseTitle: (item: JellyfinItem) => Promise<string | null>
```

7b. `src/daemon/watcher.ts` 的 `maybeProcess` 里把第 100 行

```typescript
      const ctx = buildMediaContext(item, this.deps.pathMappings)
```

替换为：

```typescript
      const chineseTitle = await this.deps.jellyfin.getChineseTitle(item).catch(() => null)
      const ctx = buildMediaContext(item, this.deps.pathMappings, { chineseTitle })
```

- [ ] **Step 2: 更新 watcher 测试的 fake jellyfin**

在 `src/daemon/watcher.test.ts` 中，所有构造 `WatcherDeps.jellyfin` 的 fake 对象补一行 `getChineseTitle: async () => null`。用编辑器全局查找 `getRecentItems:` 在每个 fake jellyfin 处补齐。运行以定位：

Run: `npx vitest run src/daemon/watcher.test.ts`
Expected（改前）：FAIL/类型报错——fake 缺 `getChineseTitle`。逐处补 `getChineseTitle: async () => null,` 后重跑 Expected: PASS。

- [ ] **Step 3: cli 接线**

7c. `src/cli/index.ts` 的 `cmdRunItem` 里把

```typescript
  const item = await jf.getItem(itemId)
  const ctx = buildMediaContext(item, mappings)
```

替换为：

```typescript
  const item = await jf.getItem(itemId)
  const chineseTitle = await jf.getChineseTitle(item).catch(() => null)
  const ctx = buildMediaContext(item, mappings, { chineseTitle })
```

7d. `src/cli/index.ts` 的 `cmdWatch` 中 `new Watcher({ jellyfin: { ... } })` 的 jellyfin 块补一行（在 `getRecentItems` 后）：

```typescript
      getRecentItems: l => jf.getRecentItems(l),
      getChineseTitle: item => jf.getChineseTitle(item),
```

- [ ] **Step 4: identify prompt 消费新信号**

`src/agent/identifyMedia.ts` 的 prompt 数组里，在 `` `provider ids: ...` `` 行之后、`` `runtime minutes: ...` `` 行之前插入两行：

```typescript
    `chinese/alternative titles: ${m.alternative_titles.length ? m.alternative_titles.join(', ') : 'none'}`,
    `overview: ${m.overview ?? 'none'}`,
```

- [ ] **Step 5: 跑全量测试确认通过**

Run: `npx vitest run`
Expected: PASS（全绿）。

- [ ] **Step 6: typecheck + 构建确认无类型漏接**

Run: `npx tsc --noEmit`
Expected: 无输出（成功）。

- [ ] **Step 7: 提交**

```bash
git add src/daemon/watcher.ts src/daemon/watcher.test.ts src/cli/index.ts src/agent/identifyMedia.ts
git commit -m "feat: wire getChineseTitle through watcher/cli, feed titles+overview to identify"
```

---

## Task 8: Controller 真实验证 + 部署 + 台账对比（主循环执行）

**Files:** 无代码改动——真实环境验证、部署、观测。此任务由主循环持凭据执行，不派子代理。

背景：M5b 的正确性无自动 ground truth，靠真实 ASSRT/Jellyfin 验证。软路由队列里 The Conjuring: Last Rites / The Astronaut / Shelby Oaks 三部处 +14h 衰减重试倒计时，部署后**自动用新逻辑复战**。预期：招魂系列翻案 download、Shelby 干净休眠（真无文本中字）。

- [ ] **Step 1: 本地 OrbStack 冒烟——单片真实跑**

对 OrbStack Jellyfin 里一部外语片跑 `run-item`，确认 getChineseTitle 取到中文名、planSearch 出年份查询、pipeline 并集不早停。命令（补真实 itemId）：

```bash
cd ~/projects/subtitle-plugin
npx tsx src/cli/index.ts run-item <itemId>
```

Expected：stdout 的 decision 为 download（若该片 ASSRT 有可用文本中字）；`journal` 指向的 `decision.json` 中 `llm_calls` 里 planSearch 的 query 含年份、rank 的 prompt 含新决策门槛措辞。若取到中文名，identify 的 prompt 应含 `chinese/alternative titles:`。

- [ ] **Step 2: 招魂 Last Rites 定向复现（实证根因 A/B 的回归）**

对招魂第一部（2013）或 Last Rites 手动构造 context 或用其 itemId 跑，确认修复前被误杀的可用 srt/ssa 这次进 download 或至少进 rank 视野未被"来源不匹配"毙掉。查 journal 的 `candidateFilter` step（raw vs kept）与 rank 的 rejected[]。

Run: `npx tsx src/cli/index.ts run-item <conjuring-itemId>`
Expected：decision=download，或 journal 显示候选进入 rank 且拒绝理由不再是分辨率/来源/sup 误判。

- [ ] **Step 3: 全量测试 + typecheck 最终确认**

```bash
npx vitest run && npx tsc --noEmit
```

Expected：全绿、无类型错误。

- [ ] **Step 4: 部署软路由**

```bash
cd ~/projects/subtitle-plugin
bash deploy/deploy.sh
```

部署脚本 rsync 源码到软路由并在路由上重建容器。部署后确认容器起来：

```bash
ssh media-router-tunnel 'docker ps --filter name=subtitle-scout'
```

Expected：`subtitle-scout` 容器 Up。

- [ ] **Step 5: 观察三部失败片自动复战 + 台账对比**

部署后三部片在下一个衰减重试 tick 自动用新逻辑重跑。次日（或倒计时到点后）拉台账对比修复前后决策分布：

```bash
ssh media-router-tunnel 'docker exec subtitle-scout npx tsx src/cli/index.ts report --since 24h'
```

Expected：招魂系列出现 `download`（修复前是 no_safe_match）；Shelby Oaks 若真无文本中字则维持 no_safe_match 并进休眠——这是正确结果，不是回归。用 `report` 的决策分组与失败明细逐条核对 journal。

- [ ] **Step 6: 收尾**

三部片验收结论确认后，用 `superpowers:finishing-a-development-branch` 合并 M5b 分支回 main，更新 `compact-resume-m5b.md` / `project-subtitle-scout-status.md` 记忆为"M5b 已合并 + 验收结果"。

---

## Self-Review

**Spec coverage（逐节核对）：**
- A. 格式硬过滤 → Task 1（`filterGraphicOnly`，None 不误杀、全图形剔除）+ Task 2（pipeline 接入、干净 no_safe_match 理由）。✅
- A. rank prompt 三条硬规则 → Task 3（格式可用范围、来源差异非拒绝理由、决策门槛倾向 download）。✅
- B. planSearch 策略 → Task 4（2-3 条标题+年份、中文名优先、禁超具体查询）。✅
- B. pipeline 并集召回 + MAX_CANDIDATES 15 → Task 2（前 2 条并集去重）+ Task 1（常量 15）。✅
- C. getChineseTitle → Task 5（RemoteSearch zh-CN、失败静默、缓存留待未来——见下"偏差"）。✅
- C. MediaContext 增字段 + identify/planSearch 消费 → Task 6（schema+build）+ Task 7（identify prompt + planSearch 已在 Task 4 消费 alternative_titles）。✅
- 测试节：格式硬过滤/并集去重/getChineseTitle fixture/MediaContext 映射单测均覆盖；判断点 prompt 无断言单测（惯例）→ Task 3/4 明确标注靠 controller。✅
- 不做什么（分页/TMDB 直连/OCR）→ 计划未触碰，符合。✅

**与 spec 的有意偏差（已在任务内说明）：**
1. spec 提到 getChineseTitle 结果"按 itemId 进内存缓存避免重复调用"。计划**未实现该缓存**：watcher 对同一 item 有 cooldown（默认 30min）不会高频重复，cli 单次执行即退出，收益极低而增复杂度——YAGNI 暂缓。若未来 watch 高频重跑再加。
2. spec 写 getChineseTitle "或 /Series"；计划对 Episode 直接返回 null（集级 provider id 不足以做系列检索），Movie/Series 覆盖，剧集非本次 bug 域。

**Placeholder 扫描：** 无 TBD/TODO；每个代码步给了完整代码与确切命令、预期输出。✅

**类型一致性：** `isGraphicOnly`/`filterGraphicOnly`（Task 1）在 Task 2 pipeline import 使用，名字一致；`getChineseTitle`（Task 5）签名 `(item: JellyfinItem) => Promise<string | null>` 在 Task 7 watcher 接口/cli/enrichment 一致；`buildMediaContext` 第 3 参 `{ chineseTitle?: string | null }`（Task 6）在 Task 7 两处调用一致；`alternative_titles`/`overview` 字段名在 schema/build/identify/plan 全一致。✅
