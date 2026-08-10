# Milestone 4 Implementation Plan: 触发经济学

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 编码任务 → **sonnet-5 子代理**；Task 8 → controller 实操。

**Goal:** 本地字幕收编、新进资源预热队列（含衰减重试/休眠/播放激活）、国产过滤、跳过缓存——流水线入口侧的完整触发经济学。

**Architecture:** 收编作为流水线可注入步骤（`PipelineDeps.adoption`，旧测试零感知）；队列为独立状态机模块（注入时钟，全逻辑可单测）；watcher 增两个独立节拍方法（arrivalsTick/consumeTick），CLI 三定时器驱动；播放优先由 in-flight 来源标记实现。

**Tech Stack:** 既有栈，零新依赖。

**Spec:** `docs/superpowers/specs/2026-07-06-milestone4-trigger-economy-design.md`

**子代理必读事实：** NodeNext ESM（`.js` import）；124 测试全绿不许破坏；zod 透传用 `.passthrough()`；LLM 判断点模式 = `llm.call({name, description, prompt, schema})` 返回 `CallStructuredResult`（见 src/agent/identifyMedia.ts 先例）；watcher 测试用注入 fake deps（见 src/daemon/watcher.test.ts 先例）。

---

## File Structure

```
src/core/schemas.ts          # +adopted_local 枚举、OrphanDecisionSchema
src/core/cache.ts            # NEGATIVE_TTL_DAYS 7→1
src/files/orphanScanner.ts   # 新：扫孤儿字幕 + 内容样本
src/agent/judgeOrphan.ts     # 新：第四判断点
src/core/orphanGate.ts       # 新：收编 gate（纯函数）
src/core/pipeline.ts         # +可选 adoption 依赖 + adoptLocal 步 + bypassNegativeCache 选项
src/daemon/queue.ts          # 新：PrefetchQueue 状态机（水位线/衰减/休眠/激活）
src/daemon/triggers.ts       # +isChineseOrigin
src/daemon/watcher.ts        # +skip-cache、+source 标记、+arrivalsTick/consumeTick、队列联动
src/adapters/players/jellyfin.ts  # +DateCreated 字段、+getRecentItems
src/cli/index.ts             # 接线：adoption 依赖、队列、三定时器、新环境变量
```

---

### Task 1: schemas + 负缓存 TTL

**Files:**
- Modify: `src/core/schemas.ts`, `src/core/cache.ts`
- Test: `src/core/schemas.test.ts`, `src/core/cache.test.ts`（追加）

- [ ] **Step 1: 失败测试**（追加到 schemas.test.ts）

```ts
describe('M4 additions', () => {
  it('FinalDecision accepts adopted_local', () => {
    const d = FinalDecisionSchema.parse({
      request_id: 'r', decision: 'adopted_local',
      confidence: 0.9, selected: null, reasons: ['adopted from orphan'], verification: null,
    })
    expect(d.decision).toBe('adopted_local')
  })
  it('OrphanDecision requires file+language when adopt=true', () => {
    expect(() => OrphanDecisionSchema.parse({
      adopt: true, confidence: 0.9, reasons: [],
    })).toThrow()
    const ok = OrphanDecisionSchema.parse({
      adopt: true, file: 'x.ass', language: 'zh-Hans', confidence: 0.9, reasons: ['chinese content'],
    })
    expect(ok.file).toBe('x.ass')
  })
})
```

追加到 cache.test.ts：

```ts
  it('negative entries default to 24h ttl', () => {
    const c = new DecisionCache(mkdtempSync(join(tmpdir(), 'cache-')))
    c.put(['k24'], { kind: 'negative', reason: 'r' })
    // 写入后立刻可读；过期语义由 expiresAt 决定，直接读文件断言 TTL
    const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    // 用 ESM import 重写此段：从磁盘读出 storedEntry 断言 expiresAt-now ≈ 24h（允差 1min）
  })
```

（实现该测试时用 ESM import 与确定性断言：`expiresAt - Date.now()` 在 `[23.9h, 24.1h]` 区间。）

- [ ] **Step 2: 确认失败。Step 3: 实现**

schemas.ts：`FinalDecisionSchema` 的 decision 枚举加 `'adopted_local'`；新增：

```ts
export const OrphanDecisionSchema = z.object({
  adopt: z.boolean(),
  file: z.string().nullish(),
  language: z.enum(['zh-Hans', 'zh-Hant']).nullish(),
  confidence: z.preprocess(
    v => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v),
    z.number().min(0).max(1),
  ),
  reasons: z.array(z.string()),
}).refine(v => !v.adopt || (v.file != null && v.language != null), {
  message: 'file and language required when adopt=true',
})
export type OrphanDecision = z.infer<typeof OrphanDecisionSchema>
```

cache.ts：`NEGATIVE_TTL_DAYS = 7` → `1`（注释注明 M4 决策：字幕迟到不是没有，播放重试窗口收窄）。

- [ ] **Step 4: 全绿。Step 5: commit** `feat: adopted_local decision, orphan schema, 24h negative ttl`

---

### Task 2: orphanScanner

**Files:**
- Create: `src/files/orphanScanner.ts`, `src/files/orphanScanner.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as iconv from 'iconv-lite'
import { scanOrphans } from './orphanScanner.js'

function dir(files: Record<string, Buffer | string>) {
  const d = mkdtempSync(join(tmpdir(), 'orph-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content)
  return d
}
const VIDEO = 'Tron.Ares.2025.2160p.WEB-DL.mp4'

describe('scanOrphans', () => {
  it('finds mismatched subtitle files with content sample', () => {
    const d = dir({
      [VIDEO]: 'fake video',
      '创：战神.Tron.Ares.中英字幕.ass': '[Script Info]\nTitle: 创：战神 Tron Ares 中英双语\n',
    })
    const orphans = scanOrphans(d, VIDEO)
    expect(orphans.length).toBe(1)
    expect(orphans[0].filename).toBe('创：战神.Tron.Ares.中英字幕.ass')
    expect(orphans[0].sample).toContain('中英双语')
  })
  it('excludes conforming-named subtitles and the video itself', () => {
    const d = dir({
      [VIDEO]: 'v',
      'Tron.Ares.2025.2160p.WEB-DL.zh-Hans.ass': 'conforming',
      'Tron.Ares.2025.2160p.WEB-DL.srt': 'also conforming (no lang tag)',
    })
    expect(scanOrphans(d, VIDEO)).toEqual([])
  })
  it('decodes GB18030 samples', () => {
    const d = dir({
      [VIDEO]: 'v',
      'old.srt': iconv.encode('1\n00:00:01,000 --> 00:00:02,000\n创战纪台词样本内容\n', 'gb18030'),
    })
    const orphans = scanOrphans(d, VIDEO)
    expect(orphans[0].sample).toContain('创战纪')
  })
  it('caps sample length and skips huge/hidden files', () => {
    const d = dir({
      [VIDEO]: 'v',
      '.hidden.ass': 'x',
      'big.ass': 'a'.repeat(10000),
    })
    const orphans = scanOrphans(d, VIDEO)
    expect(orphans.length).toBe(1) // 只有 big.ass；隐藏文件跳过
    expect(orphans[0].sample.length).toBeLessThanOrEqual(500)
  })
})
```

- [ ] **Step 2: 确认失败。Step 3: 实现** `src/files/orphanScanner.ts`

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import chardet from 'chardet'
import * as iconv from 'iconv-lite'

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa']
const SAMPLE_CHARS = 500
const MAX_FILE_BYTES = 5 * 1024 * 1024 // 字幕不会超过这个；超了不是字幕

export interface OrphanSubtitle { filename: string; path: string; sample: string }

/** 扫视频同目录中"命名不符合 Jellyfin 约定"的字幕文件，附解码后的内容头部样本 */
export function scanOrphans(dir: string, videoFilename: string): OrphanSubtitle[] {
  const videoBase = videoFilename.replace(/\.[^.]+$/, '')
  const out: OrphanSubtitle[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    if (!SUBTITLE_EXTS.includes(extname(name).toLowerCase())) continue
    if (name.startsWith(videoBase)) continue // 已符合约定（含带语言标签者）
    const path = join(dir, name)
    try {
      if (statSync(path).size > MAX_FILE_BYTES) continue
      const bytes = readFileSync(path)
      const enc = chardet.detect(bytes)
      const encoding = enc && iconv.encodingExists(String(enc)) ? String(enc) : 'utf-8'
      const sample = iconv.decode(bytes.subarray(0, 4096), encoding).slice(0, SAMPLE_CHARS)
      out.push({ filename: name, path, sample })
    } catch { /* 读不动的文件直接跳过，收编是尽力而为 */ }
  }
  return out
}
```

- [ ] **Step 4: 全绿。Step 5: commit** `feat: orphan subtitle scanner with decoded content samples`

---

### Task 3: judgeOrphan + orphanGate

**Files:**
- Create: `src/agent/judgeOrphan.ts`, `src/core/orphanGate.ts`, `src/core/orphanGate.test.ts`

- [ ] **Step 1: gate 失败测试** `src/core/orphanGate.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { runOrphanGate } from './orphanGate.js'
import type { OrphanDecision } from './schemas.js'

const orphans = [{ filename: 'a.ass', path: '/m/a.ass', sample: 's' }]
const base: OrphanDecision = { adopt: true, file: 'a.ass', language: 'zh-Hans', confidence: 0.92, reasons: ['zh content'] }

describe('runOrphanGate', () => {
  it('passes a valid adoption', () => {
    expect(runOrphanGate(base, orphans, 0.86).ok).toBe(true)
  })
  it('rejects file not in scanned set', () => {
    const r = runOrphanGate({ ...base, file: 'hallucinated.ass' }, orphans, 0.86)
    expect(r.ok).toBe(false)
    expect(r.failures[0]).toMatch(/scanned/)
  })
  it('rejects below-threshold confidence', () => {
    expect(runOrphanGate({ ...base, confidence: 0.5 }, orphans, 0.86).ok).toBe(false)
  })
  it('adopt=false passes through as not-ok without failures', () => {
    const r = runOrphanGate({ adopt: false, confidence: 0.3, reasons: [] }, orphans, 0.86)
    expect(r.ok).toBe(false)
    expect(r.failures).toEqual([])
  })
})
```

- [ ] **Step 2: 确认失败。Step 3: 实现**

`src/core/orphanGate.ts`：

```ts
import type { OrphanDecision } from './schemas.js'
import type { OrphanSubtitle } from '../files/orphanScanner.js'

export interface OrphanGateResult { ok: boolean; failures: string[]; orphan?: OrphanSubtitle }

/** 收编 gate：LLM 只提议，代码验证。不过就放弃收编走 ASSRT，绝不误收。 */
export function runOrphanGate(
  decision: OrphanDecision, orphans: OrphanSubtitle[], minConfidence: number,
): OrphanGateResult {
  if (!decision.adopt) return { ok: false, failures: [] }
  const failures: string[] = []
  const orphan = orphans.find(o => o.filename === decision.file)
  if (!orphan) failures.push(`file ${decision.file} is not in the scanned orphan set`)
  if (decision.confidence < minConfidence) failures.push(`confidence ${decision.confidence} below ${minConfidence}`)
  return failures.length ? { ok: false, failures } : { ok: true, failures: [], orphan }
}
```

`src/agent/judgeOrphan.ts`（无单测，判断点惯例；接线由 Task 4 集成测试覆盖）：

```ts
import { OrphanDecisionSchema, type MediaIdentity, type OrphanDecision } from '../core/schemas.js'
import type { OrphanSubtitle } from '../files/orphanScanner.js'
import type { LlmRuntime } from './runtime.js'
import type { CallStructuredResult } from './llm.js'

export async function judgeOrphan(
  llm: LlmRuntime, identity: MediaIdentity, videoFilename: string, orphans: OrphanSubtitle[],
): Promise<CallStructuredResult<OrphanDecision>> {
  const prompt = [
    'A media folder contains subtitle files whose names do not match the video, so the media',
    'server cannot associate them. Decide whether ONE of them is a CHINESE subtitle for THIS video.',
    'Rules: adopt=true only if the file is clearly for this exact movie/episode AND contains',
    'Chinese (Simplified → zh-Hans, Traditional → zh-Hant; bilingual counts, pick the Chinese variant).',
    'A wrongly adopted subtitle is worse than downloading a fresh one — when unsure, adopt=false.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `video filename: ${videoFilename}`,
    `orphan files (name + content sample): ${JSON.stringify(orphans.map(o => ({ file: o.filename, sample: o.sample })))}`,
  ].join('\n')
  return llm.call({
    name: 'report_orphan_decision',
    description: 'Report whether to adopt a local orphan subtitle', prompt, schema: OrphanDecisionSchema,
  })
}
```

- [ ] **Step 4: 全绿。Step 5: commit** `feat: orphan adoption judgment point and deterministic gate`

---

### Task 4: pipeline adoptLocal 步 + bypassNegativeCache

**Files:**
- Modify: `src/core/pipeline.ts`
- Test: `src/core/pipeline.test.ts`（追加）

- [ ] **Step 1: 失败测试**（追加；复用现有 makeDeps/ctx；fixture 目录构造孤儿文件）

```ts
describe('adoptLocal step', () => {
  function adoptionDeps(outDir: string, judge: PipelineDeps['adoption'] extends infer A ? A extends object ? A['judge'] : never : never) {
    writeFileSync(join(outDir, '乱名字幕.ass'), '[Script Info]\nTitle: matrix zh\n')
    return {
      scan: (dir: string, video: string) => scanOrphans(dir, video),
      judge,
      read: (p: string) => readFileSync(p),
    }
  }

  it('adopts a local orphan and never touches ASSRT', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'adopt-'))
    const judge = vi.fn(async () => ({
      parsed: { adopt: true, file: '乱名字幕.ass', language: 'zh-Hans' as const, confidence: 0.93, reasons: ['zh sample'] },
      rawText: '', prompt: 'p', retries: 0, durationMs: 1,
    }))
    const deps = makeDeps({ adoption: adoptionDeps(outDir, judge) })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('adopted_local')
    expect(existsSync(join(outDir, 'The.Matrix.1999.1080p.BluRay.x264.zh-Hans.ass'))).toBe(true)
    expect(existsSync(join(outDir, '乱名字幕.ass'))).toBe(true) // 原件不动
    expect(deps.assrt.search).not.toHaveBeenCalled()
    expect(deps.plan).not.toHaveBeenCalled()
  })

  it('falls through to ASSRT when judge declines', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'adopt-'))
    const judge = vi.fn(async () => ({
      parsed: { adopt: false, confidence: 0.2, reasons: ['not this movie'] },
      rawText: '', prompt: 'p', retries: 0, durationMs: 1,
    }))
    const deps = makeDeps({ adoption: adoptionDeps(outDir, judge) })
    const result = await runPipeline(deps, ctx, outDir)
    expect(result.decision).toBe('download') // 走了 ASSRT 黄金路径
  })

  it('bypassNegativeCache forces a fresh run', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const cache = new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-')))
    cache.put(['id:imdb:tt0133093:S-:E-'], { kind: 'negative', reason: 'stale' })
    const deps = makeDeps({ cache })
    const result = await runPipeline(deps, ctx, outDir, outDir, { bypassNegativeCache: true })
    expect(result.decision).toBe('download')
    expect(deps.assrt.search).toHaveBeenCalled()
  })
})
```

（import 需补 `scanOrphans`、`writeFileSync`、`readFileSync`。）

- [ ] **Step 2: 确认失败。Step 3: 实现**

pipeline.ts 改动点：

1. `PipelineDeps` 增：

```ts
  /** 本地孤儿字幕收编（可选；未注入则跳过该步） */
  adoption?: {
    scan: (dir: string, videoFilename: string) => OrphanSubtitle[]
    judge: (ctx: MediaContext, id: MediaIdentity, orphans: OrphanSubtitle[]) => Promise<CallStructuredResult<OrphanDecision>>
    read: (path: string) => Buffer
  }
```

2. 签名：`runPipeline(deps, ctx, outDir, journalDir = outDir, opts: { bypassNegativeCache?: boolean } = {})`。
3. 负缓存分支加条件：`if (cached?.kind === 'negative' && !opts.bypassNegativeCache)`。
   注意 bypass 时 `cached` 若为 negative 应视为 null 继续全流程（`if (opts.bypassNegativeCache && cached?.kind === 'negative') cached = null`）。
4. 在 `cacheLookup` 之后、`cached?.kind === 'positive'` 分支之前插入（仅当无 positive 命中且注入了 adoption）：

```ts
    if (!cached && deps.adoption) {
      journal.step('scanOrphans')
      const orphans = deps.adoption.scan(dirname(ctx.media.path), ctx.media.filename)
      if (orphans.length > 0) {
        journal.step('judgeOrphan', { count: orphans.length })
        const judged = await deps.adoption.judge(ctx, identity, orphans)
        journal.llmCall({ point: 'judgeOrphan', prompt: judged.prompt, rawText: judged.rawText, parsed: judged.parsed, retries: judged.retries, durationMs: judged.durationMs })
        const ogate = runOrphanGate(judged.parsed, orphans, ctx.preferences.auto_download_min_confidence)
        journal.step('orphanGateResult', ogate)
        if (ogate.ok && ogate.orphan) {
          const written = await writeSubtitle({
            artifact: deps.adoption.read(ogate.orphan.path),
            artifactFilename: ogate.orphan.filename,
            videoFilename: ctx.media.filename,
            langTag: judged.parsed.language!,
            outDir,
          })
          if (!written.alreadyExists) {
            return finish('adopted_local', {
              reasons: [`adopted local subtitle: ${ogate.orphan.filename}`, ...judged.parsed.reasons],
              confidence: judged.parsed.confidence,
              subtitlePath: written.path, bytes: written.bytes, encoding: written.encoding,
            })
          }
        }
      }
    }
```

import 增：`dirname`（node:path）、`runOrphanGate`、`OrphanSubtitle`、`OrphanDecision`。
`PipelineResult.decision` 类型已由 FinalDecisionSchema 扩展覆盖——同步扩 PipelineResult 联合类型加 `'adopted_local'`。
watcher 侧：`result.decision === 'download'` 触发 refresh 的判断改为 `['download','adopted_local'].includes(result.decision)`（Task 6 一起改，此处注明）。

- [ ] **Step 4: 全绿。Step 5: commit** `feat: local subtitle adoption step and negative-cache bypass in pipeline`

---

### Task 5: isChineseOrigin + watcher 跳过缓存

**Files:**
- Modify: `src/daemon/triggers.ts`, `src/daemon/watcher.ts`
- Test: `src/daemon/triggers.test.ts`, `src/daemon/watcher.test.ts`（追加）

- [ ] **Step 1: 失败测试**

triggers.test.ts 追加：

```ts
describe('isChineseOrigin', () => {
  it('detects mainland/HK/TW in various spellings', () => {
    for (const loc of ['China', "People's Republic of China", 'Hong Kong', 'Taiwan', '中国', '中国大陆', '香港', '台湾']) {
      expect(isChineseOrigin({ ...base, ProductionLocations: [loc] })).toBe(true)
    }
  })
  it('false for foreign or missing metadata', () => {
    expect(isChineseOrigin({ ...base, ProductionLocations: ['United States of America'] })).toBe(false)
    expect(isChineseOrigin({ ...base, ProductionLocations: [] })).toBe(false)
    expect(isChineseOrigin({ ...base, ProductionLocations: undefined })).toBe(false)
  })
})
```

watcher.test.ts 追加：

```ts
  it('skips Chinese-origin items when configured', async () => {
    const zhItem = { ...cleanItem, ProductionLocations: ['China'] }
    const deps = makeDeps({ skipChineseOrigin: true, jellyfin: { getSessions: vi.fn(async () => sessions), getItem: vi.fn(async () => zhItem), refreshItem: vi.fn(async () => {}) } })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).not.toHaveBeenCalled()
  })

  it('skip-cache suppresses repeated getItem for has-subtitle items', async () => {
    const withZh = { ...cleanItem, MediaStreams: [{ Type: 'Subtitle', Language: 'zh-hans', Codec: 'subrip', IsExternal: true }] }
    const getItem = vi.fn(async () => withZh)
    const deps = makeDeps({ skipCacheMinutes: 5, jellyfin: { getSessions: vi.fn(async () => sessions), getItem, refreshItem: vi.fn(async () => {}) } })
    const w = new Watcher(deps)
    await w.tick(); await w.tick(); await w.tick()
    expect(getItem).toHaveBeenCalledTimes(1)
  })
```

（makeDeps 默认值补 `skipChineseOrigin: true, skipCacheMinutes: 5`；现有测试的 cleanItem 无 ProductionLocations → 不受国产过滤影响。）

- [ ] **Step 2: 确认失败。Step 3: 实现**

triggers.ts：

```ts
const CHINESE_ORIGIN = /china|hong ?kong|taiwan|中国|大陆|香港|台湾|澳门|macao|macau/i

/** 国产内容不需要我们找中文字幕。元数据缺失返回 false（放行触发，宁多查勿漏配）。 */
export function isChineseOrigin(item: JellyfinItem): boolean {
  return (item.ProductionLocations ?? []).some(l => CHINESE_ORIGIN.test(l))
}
```

watcher.ts：`WatcherDeps` 增 `skipChineseOrigin: boolean` 与 `skipCacheMinutes: number`；类内 `private skipUntil = new Map<string, number>()`；`maybeProcess` 在 getItem 之前查 skipUntil，命中且未过期直接 return；在三个"跳过"分支（类型不符、已有字幕、国产）设置 `this.skipUntil.set(itemId, Date.now() + this.deps.skipCacheMinutes * 60_000)`；国产判断插在 needsChineseSubtitle 之前：

```ts
      if (this.deps.skipChineseOrigin && isChineseOrigin(item)) {
        this.skipUntil.set(itemId, Date.now() + this.deps.skipCacheMinutes * 60_000)
        return
      }
```

同时把 refresh 触发条件改为 `if (result.decision === 'download' || result.decision === 'adopted_local')`（Task 4 注明的联动）。

- [ ] **Step 4: 全绿。Step 5: commit** `feat: chinese-origin filter and short-ttl skip cache in watcher`

---

### Task 6: PrefetchQueue 状态机

**Files:**
- Create: `src/daemon/queue.ts`, `src/daemon/queue.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrefetchQueue, RETRY_LADDER_DAYS } from './queue.js'

const file = () => join(mkdtempSync(join(tmpdir(), 'q-')), 'queue.json')
const DAY = 86_400_000

describe('PrefetchQueue', () => {
  it('persists watermark and entries across instances', () => {
    const f = file()
    let now = 1_000_000
    const q1 = new PrefetchQueue(f, () => now)
    q1.setWatermark('2026-07-06T00:00:00Z')
    q1.upsert('item1', 'Movie One')
    const q2 = new PrefetchQueue(f, () => now)
    expect(q2.watermark()).toBe('2026-07-06T00:00:00Z')
    expect(q2.due()?.itemId).toBe('item1')
  })

  it('decay ladder: 1d/2d/4d/8d then dormant', () => {
    const f = file()
    let now = 0
    const q = new PrefetchQueue(f, () => now)
    q.upsert('x', 'X')
    expect(RETRY_LADDER_DAYS).toEqual([1, 2, 4, 8])
    for (const [i, days] of RETRY_LADDER_DAYS.entries()) {
      expect(q.due()?.itemId).toBe('x')
      q.recordFailure('x')
      if (i < RETRY_LADDER_DAYS.length - 1) {
        expect(q.due()).toBeUndefined()          // 未到期
        now += days * DAY + 1
      }
    }
    expect(q.dormantFor('x')).toBe(true)
    now += 100 * DAY
    expect(q.due()).toBeUndefined()              // 休眠永不到期
  })

  it('activate resets a dormant entry to pending', () => {
    const f = file()
    let now = 0
    const q = new PrefetchQueue(f, () => now)
    q.upsert('x', 'X')
    for (let i = 0; i < 4; i++) q.recordFailure('x')
    expect(q.dormantFor('x')).toBe(true)
    q.activate('x')
    expect(q.dormantFor('x')).toBe(false)
    expect(q.due()?.itemId).toBe('x')
  })

  it('remove clears an entry on success; upsert is idempotent', () => {
    const q = new PrefetchQueue(file(), () => 0)
    q.upsert('x', 'X'); q.upsert('x', 'X')
    expect(q.size().pending).toBe(1)
    q.remove('x')
    expect(q.size().pending).toBe(0)
    expect(q.due()).toBeUndefined()
  })

  it('due returns oldest-added first', () => {
    let now = 0
    const q = new PrefetchQueue(file(), () => now)
    q.upsert('a', 'A'); now = 1; q.upsert('b', 'B')
    expect(q.due()?.itemId).toBe('a')
  })
})
```

- [ ] **Step 2: 确认失败。Step 3: 实现** `src/daemon/queue.ts`

```ts
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const RETRY_LADDER_DAYS = [1, 2, 4, 8]
const DAY_MS = 86_400_000

export interface QueueEntry {
  itemId: string
  name: string
  addedAt: number
  attempts: number
  nextRetryAt: number
  state: 'pending' | 'dormant'
}

interface QueueFile { watermark: string | null; entries: QueueEntry[] }

/** 预热队列：水位线 + 衰减重试 + 休眠/激活。注入时钟，全逻辑可测。原子写（tmp+rename）。 */
export class PrefetchQueue {
  private data: QueueFile

  constructor(private file: string, private now: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true })
    this.data = this.load()
  }

  private load(): QueueFile {
    if (!existsSync(this.file)) return { watermark: null, entries: [] }
    try { return JSON.parse(readFileSync(this.file, 'utf8')) } catch { return { watermark: null, entries: [] } }
  }
  private save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }

  watermark(): string | null { return this.data.watermark }
  setWatermark(dateCreated: string) { this.data.watermark = dateCreated; this.save() }

  upsert(itemId: string, name: string) {
    if (this.data.entries.some(e => e.itemId === itemId)) return
    this.data.entries.push({ itemId, name, addedAt: this.now(), attempts: 0, nextRetryAt: this.now(), state: 'pending' })
    this.save()
  }

  due(): QueueEntry | undefined {
    const now = this.now()
    return this.data.entries
      .filter(e => e.state === 'pending' && e.nextRetryAt <= now)
      .sort((a, b) => a.addedAt - b.addedAt)[0]
  }

  recordFailure(itemId: string) {
    const e = this.data.entries.find(x => x.itemId === itemId)
    if (!e) return
    e.attempts += 1
    if (e.attempts >= RETRY_LADDER_DAYS.length) e.state = 'dormant'
    else e.nextRetryAt = this.now() + RETRY_LADDER_DAYS[e.attempts - 1] * DAY_MS
    this.save()
  }

  remove(itemId: string) {
    this.data.entries = this.data.entries.filter(e => e.itemId !== itemId)
    this.save()
  }

  dormantFor(itemId: string): boolean {
    return this.data.entries.some(e => e.itemId === itemId && e.state === 'dormant')
  }

  activate(itemId: string) {
    const e = this.data.entries.find(x => x.itemId === itemId)
    if (!e) return
    e.state = 'pending'; e.attempts = 0; e.nextRetryAt = this.now()
    this.save()
  }

  size(): { pending: number; dormant: number } {
    return {
      pending: this.data.entries.filter(e => e.state === 'pending').length,
      dormant: this.data.entries.filter(e => e.state === 'dormant').length,
    }
  }
}
```

注意衰减语义与测试一致：第 1 次失败 → 等 `RETRY_LADDER_DAYS[0]`=1 天；第 4 次失败 → dormant。

- [ ] **Step 4: 全绿。Step 5: commit** `feat: prefetch queue with watermark, decay retries, dormancy`

---

### Task 7: watcher/jellyfin/CLI 接线

**Files:**
- Modify: `src/adapters/players/jellyfin.ts`（+DateCreated、+getRecentItems）、`src/daemon/watcher.ts`（arrivalsTick/consumeTick/来源标记/队列联动/休眠激活）、`src/cli/index.ts`（adoption 依赖、队列、三定时器、新 env）
- Test: `src/adapters/players/jellyfin.test.ts`、`src/daemon/watcher.test.ts`（追加）

- [ ] **Step 1: 失败测试**

jellyfin.test.ts 追加：

```ts
  it('getRecentItems queries by DateCreated desc', async () => {
    const { client, fetchImpl } = makeClient([itemsFixture])
    await client.getRecentItems(50)
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('sortBy=DateCreated')
    expect(url).toContain('includeItemTypes=Movie,Episode')
    expect(url).toContain('limit=50')
  })
```

watcher.test.ts 追加（makeDeps 增默认 `queue: new PrefetchQueue(join(mkdtempSync(join(tmpdir(), 'wq-')), 'q.json'))`、`getRecentItems: vi.fn(async () => [cleanItem])`；import PrefetchQueue）：

```ts
describe('arrivals & queue consumption', () => {
  it('arrivalsTick enqueues new items past the watermark', async () => {
    const deps = makeDeps()
    const withDate = { ...cleanItem, DateCreated: '2026-07-06T12:00:00Z' }
    deps.jellyfin.getRecentItems = vi.fn(async () => [withDate])
    const w = new Watcher(deps)
    await w.arrivalsTick()
    expect(deps.queue.size().pending).toBe(1)
    expect(deps.queue.watermark()).toBe('2026-07-06T12:00:00Z')
    await w.arrivalsTick() // 水位线之后不再重复入队
    expect(deps.queue.size().pending).toBe(1)
  })

  it('consumeTick processes one due entry and removes it on success', async () => {
    const deps = makeDeps()
    deps.queue.upsert(cleanItem.Id, cleanItem.Name)
    const w = new Watcher(deps)
    await w.consumeTick()
    expect(deps.runJob).toHaveBeenCalledTimes(1)
    expect(deps.queue.size().pending).toBe(0)
  })

  it('consumeTick records failure with decay on no_safe_match', async () => {
    const deps = makeDeps({ runJob: vi.fn(async () => ({ decision: 'no_safe_match', journalPath: 'j' })) })
    deps.queue.upsert(cleanItem.Id, cleanItem.Name)
    const w = new Watcher(deps)
    await w.consumeTick()
    expect(deps.queue.size().pending).toBe(1) // 仍在队列，等衰减到期
    expect(deps.queue.due()).toBeUndefined()  // 未到期
  })

  it('consumeTick yields when a playback job is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const runJob = vi.fn(async () => { await gate; return { decision: 'download', journalPath: 'j' } })
    const deps = makeDeps({ runJob })
    deps.queue.upsert('queued-item', 'Q')
    const w = new Watcher(deps)
    const playing = w.tick()            // 播放任务在途
    await new Promise(r => setTimeout(r, 10))
    await w.consumeTick()               // 应让路
    expect(runJob).toHaveBeenCalledTimes(1) // 只有播放那一次
    release(); await playing
  })

  it('playback of a dormant item activates and bypasses negative cache', async () => {
    const deps = makeDeps()
    deps.queue.upsert(cleanItem.Id, cleanItem.Name)
    for (let i = 0; i < 4; i++) deps.queue.recordFailure(cleanItem.Id)
    expect(deps.queue.dormantFor(cleanItem.Id)).toBe(true)
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), cleanItem.Id, expect.objectContaining({ bypassNegativeCache: true }))
    expect(deps.queue.dormantFor(cleanItem.Id)).toBe(false)
  })
})
```

- [ ] **Step 2: 确认失败。Step 3: 实现**

jellyfin.ts：`JellyfinItemSchema` 增 `DateCreated: z.string().nullish()`；

```ts
  async getRecentItems(limit: number): Promise<JellyfinItem[]> {
    const raw = await this.call('GET',
      `/Items?recursive=true&includeItemTypes=Movie,Episode&sortBy=DateCreated&sortOrder=Descending&limit=${limit}&fields=${ITEM_FIELDS},DateCreated`)
    return JellyfinItemsResponseSchema.parse(raw).Items
  }
```

watcher.ts：

- `WatcherDeps` 增：`queue: PrefetchQueue`、`getRecentItems` 挂进 jellyfin 组（`getRecentItems: (limit: number) => Promise<JellyfinItem[]>`）；`runJob` 签名增第 4 参 `opts?: { bypassNegativeCache?: boolean }`。
- in-flight 改带来源：`private inFlight = new Map<string, 'playback' | 'queue'>()`；`playbackBusy()` 判定是否存在 playback 来源在途。
- `maybeProcess(itemId, source: 'playback' | 'queue' = 'playback')`：
  - 播放路径开头：`if (source === 'playback' && this.deps.queue.dormantFor(itemId)) { this.deps.queue.activate(itemId); bypass = true }`
  - 调 runJob 传 `{ bypassNegativeCache: bypass }`；
  - 结果联动：`download`/`adopted_local`/`already_exists` → `queue.remove(itemId)`；
    `no_safe_match`/`ask_user` 且 `source === 'queue'` → `queue.recordFailure(itemId)`；
  - 其余逻辑（冷却/跳过缓存/根白名单/预检）不变，两来源共用。
- 新方法：

```ts
  async arrivalsTick(): Promise<void> {
    try {
      const items = await this.deps.jellyfin.getRecentItems(50)
      const wm = this.deps.queue.watermark()
      const fresh = items.filter(i => i.DateCreated && (!wm || i.DateCreated > wm))
      for (const item of fresh) {
        if (!isTriggerableType(item.Type)) continue
        if (this.deps.skipChineseOrigin && isChineseOrigin(item)) continue
        if (!needsChineseSubtitle(item, this.deps.treatPgsAsMissing)) continue
        this.deps.queue.upsert(item.Id, item.Name)
        this.deps.log(`queued new arrival: ${item.Name}`)
      }
      const newest = items.map(i => i.DateCreated).filter((d): d is string => !!d).sort().pop()
      if (newest && (!wm || newest > wm)) this.deps.queue.setWatermark(newest)
    } catch (e) { this.deps.log(`arrivals poll failed: ${String(e)}`) }
  }

  async consumeTick(): Promise<void> {
    if (this.playbackBusy()) { this.deps.log('prefetch yielding to in-flight playback job'); return }
    const entry = this.deps.queue.due()
    if (!entry) return
    this.deps.log(`prefetching ${entry.name}`)
    await this.maybeProcess(entry.itemId, 'queue')
  }
```

注意首个水位线：空水位线时 fresh = 全部 50 条——**首启会把最近 50 个缺字幕 item 入队**（有界，可接受，spec 的"新增预热"语义；日志说明）。

cli/index.ts：

- `assemble` 的 deps 增 adoption 注入（受 `ADOPT_LOCAL_SUBTITLES` 默认 true 控制）：

```ts
    adoption: (process.env.ADOPT_LOCAL_SUBTITLES ?? 'true') !== 'false' ? {
      scan: (dir, video) => scanOrphans(dir, video),
      judge: (c, id, orphans) => judgeOrphan(llm, id, c.media.filename, orphans),
      read: p => readFileSync(p),
    } : undefined,
```

- cmdWatch：构造 `new PrefetchQueue(join(cacheRoot, 'queue.json'))` 传入 WatcherDeps（含 `getRecentItems: l => jf.getRecentItems(l)`、`skipChineseOrigin`、`skipCacheMinutes`）；runJob 转发第 4 参给 runPipeline 的 opts；主循环三节拍：

```ts
  const arrivalsEvery = (Number(process.env.ARRIVALS_POLL_MINUTES) || 15) * 60_000
  const consumeEvery = (Number(process.env.PREFETCH_INTERVAL_MINUTES) || 10) * 60_000
  let lastArrivals = 0, lastConsume = 0
  for (;;) {
    if (!stopping) {
      await watcher.tick()
      const now = Date.now()
      if (now - lastArrivals >= arrivalsEvery) { lastArrivals = now; await watcher.arrivalsTick() }
      if (now - lastConsume >= consumeEvery) { lastConsume = now; await watcher.consumeTick() }
    }
    await new Promise(r => setTimeout(r, pollSeconds * 1000))
  }
```

- run-item 也传 adoption（已在 assemble deps 内，自动生效）。
- 新 env 全部写进 `.env.example` 与 README 表：`ADOPT_LOCAL_SUBTITLES`、`SKIP_CHINESE_ORIGIN`、`SKIP_CACHE_MINUTES`、`ARRIVALS_POLL_MINUTES`、`PREFETCH_INTERVAL_MINUTES`。

- [ ] **Step 4: 全绿（预计 ~150 测试）。Step 5: commit** `feat: arrivals queue wiring, adoption injection, three-beat watch loop`

---

### Task 8（Controller）: 场景验证 + 部署 + 终审 + 合并

- [ ] OrbStack 场景 a（收编）：给假《黑客帝国》目录塞 `随便什么名字.ass`（中文内容），清缓存，模拟播放 → 期望 `adopted_local`、规范命名副本出现、原件保留、journal 无 ASSRT 调用；
- [ ] OrbStack 场景 b（队列）：ffmpeg 造第二部假电影入库 → arrivalsTick 周期后 queue.json 出现条目与水位线 → 慢消费预热成功；
- [ ] OrbStack 场景 c（衰减）：对一部注定搜不到的假片（乱造标题）验证失败后 `nextRetryAt ≈ +1d`；
- [ ] 单测/回归全绿 + opus 终审整分支（重点：队列状态机边界、水位线时区/字符串比较、收编 gate 绕过可能、三节拍循环阻塞）→ 修复 → 复核；
- [ ] 部署软路由（deploy.sh）+ 观察生产日志（首启水位线会入队最近 50 个缺字幕 item——匀速消费预热你的真实库存新片，正好是功能演示）；
- [ ] README/.env.example/spec 补录 → 合并 main → 更新项目记忆。

---

## Self-Review 结果（已执行）

- **Spec 覆盖**：①收编(T1-T4)、②队列+水位线+剧集天然覆盖(T6/T7)、③国产过滤(T5)、④跳过缓存(T5)、⑤重试双轨=衰减(T6)+24h 负缓存(T1)+休眠激活(T7 bypassNegativeCache 链路)；行为总表七行均有对应实现与测试；SQLite 决策无代码影响。
- **占位符扫描**：Task 1 cache 测试注明"实现时用 ESM 与确定性断言"——已给出具体断言区间，非 TBD。
- **类型一致性**：`OrphanSubtitle`(T2) ↔ gate(T3)/pipeline(T4)；`OrphanDecision`(T1) ↔ judge(T3)/gate(T3)/pipeline(T4)；`PrefetchQueue` API(T6) ↔ watcher(T7) 逐方法核对一致；`runJob` 第 4 参 opts 在 T7 的 watcher 与 CLI 两侧同步。
