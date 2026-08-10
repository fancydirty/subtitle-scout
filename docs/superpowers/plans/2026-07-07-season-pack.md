# Season-Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当处理某集且 rank 选中整季字幕包、该季 ≥2 集缺中字时,把包的 filelist 安全映射到各集并一次写下整季 sidecar。

**Architecture:** 逐集触发不变;pipeline 在 rank+gate 之后加"升格"分支:枚举季集(Jellyfin)→ LLM 批量映射包文件→集(读文件名,不用正则)→ 确定性 gate 按 `SxxExx` 集合 join + 逐项校验 + verify-then-commit → 逐集直连下载+写 sidecar → 回调 refresh/dequeue。映射失败逐项软跳、缺集不串号、0 提交回退单集。

**Tech Stack:** TypeScript NodeNext ESM(`.js` imports)、Zod v4、Vercel AI SDK forced-tool、Vitest、ASSRT、Jellyfin。

**Spec:** `docs/superpowers/specs/2026-07-07-season-pack-design.md`

---

## File Structure

- `src/core/episode.ts`(新) — `formatEpisodeCode(season, ep)`;`SeasonEpisode` 类型。
- `src/core/schemas.ts`(改) — `SeasonMapSchema` + `PipelineResult.coveredEpisodes`(在 pipeline.ts 内定义,schema 只加 SeasonMap)。
- `src/core/seasonPackGate.ts`(新) — `runSeasonPackGate`(纯函数,防灾核心)。
- `src/adapters/players/jellyfin.ts`(改) — `getSeasonEpisodes` + `SeriesId` 字段。
- `src/agent/mapSeasonPack.ts`(新) — 第 5 个 LLM 判断点。
- `src/core/pipeline.ts`(改) — 季分支 + `shouldGraduate` + `PipelineDeps.seasonPack` 可选依赖 + `PipelineResult.coveredEpisodes`。
- `src/cli/index.ts`(改) — 装配注入 `seasonPack` 依赖(含 path 映射 + onCovered 的 refresh/dequeue)。
- 各自 `.test.ts` + `fixtures/assrt/detail-season-pack.json`(新)。

---

## Task 1: episode.ts(formatEpisodeCode + SeasonEpisode 类型)

**Files:**
- Create: `src/core/episode.ts`
- Test: `src/core/episode.test.ts`

背景:季集需要一个规范的 `SxxExx` 字符串做集合 join 的 key。动画可能上千集(One Piece),集号补零到 2 位但允许更多位(不截断)。

- [ ] **Step 1: 写失败测试**

`src/core/episode.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { formatEpisodeCode } from './episode.js'

describe('formatEpisodeCode', () => {
  it('pads season and episode to 2 digits', () => {
    expect(formatEpisodeCode(2, 1)).toBe('S02E01')
    expect(formatEpisodeCode(1, 13)).toBe('S01E13')
  })
  it('does not truncate 3-4 digit episode numbers (long-running anime)', () => {
    expect(formatEpisodeCode(1, 1050)).toBe('S01E1050')
  })
  it('handles season 0 (specials)', () => {
    expect(formatEpisodeCode(0, 5)).toBe('S00E05')
  })
})
```

- [ ] **Step 2:** `npx vitest run src/core/episode.test.ts` — FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/core/episode.ts`:
```typescript
/** 规范集号 SxxExx。集号补零到至少 2 位但不截断（上千集动画如 One Piece E1050）。 */
export function formatEpisodeCode(season: number, episode: number): string {
  const s = String(season).padStart(2, '0')
  const e = String(episode).padStart(2, '0')
  return `S${s}E${e}`
}

/** 一季中的一集（由 PlayerAdapter 枚举给出，路径已映射为本地）。 */
export interface SeasonEpisode {
  itemId: string
  seasonNumber: number
  episodeNumber: number
  episodeCode: string
  videoPath: string      // 本地路径（已过 MEDIA_PATH_MAPPINGS）
  videoFilename: string
  needsChinese: boolean
}
```

- [ ] **Step 4:** `npx vitest run src/core/episode.test.ts` — PASS。

- [ ] **Step 5: 提交**
```bash
git add src/core/episode.ts src/core/episode.test.ts
git commit -m "feat(episode): formatEpisodeCode + SeasonEpisode type"
```

---

## Task 2: seasonPackGate 纯函数(防灾核心)

**Files:**
- Create: `src/core/seasonPackGate.ts`
- Test: `src/core/seasonPackGate.test.ts`

背景:对 LLM 映射输出做**集合 join(按 episodeCode，非位置)+ 逐项校验 + verify-then-commit**，产出安全提交集。这是防"整季串号"的关键，充分单测。

`SeasonMap`(Task 3 schema 的推断类型)形状：`{ pairs: {filelist_index, episode_code, confidence, reason}[], unmapped_files: number[], reasons: string[] }`。为避免 Task 顺序耦合，本任务用局部结构类型接收（不 import schema）。

- [ ] **Step 1: 写失败测试**

`src/core/seasonPackGate.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { runSeasonPackGate } from './seasonPackGate.js'
import type { SeasonEpisode } from './episode.js'

function ep(n: number, needs = true): SeasonEpisode {
  return { itemId: `it${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E${String(n).padStart(2,'0')}`,
    videoPath: `/media/tv/Show/Season 2/Show.S02E${String(n).padStart(2,'0')}.mkv`,
    videoFilename: `Show.S02E${String(n).padStart(2,'0')}.mkv`, needsChinese: needs }
}
const seasonEps = [ep(1), ep(2), ep(3)]
const filelist = [
  { f: 'Show.S02E01.chs.ass', url: 'http://a/1' },
  { f: 'Show.S02E02.chs.ass', url: 'http://a/2' },
  { f: 'Show.S02E03.chs.ass', url: 'http://a/3' },
  { f: 'readme.txt', url: 'http://a/r' },
]

describe('runSeasonPackGate', () => {
  it('commits valid pairs joined by episode_code (not position)', () => {
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', confidence: 0.95, reason: 'x' },
      { filelist_index: 1, episode_code: 'S02E02', confidence: 0.95, reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps, minConfidence: 0.86 })
    expect(r.commit.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02'])
    expect(r.commit.find(c => c.episodeCode === 'S02E01')!.downloadUrl).toBe('http://a/1')
    expect(r.commit.find(c => c.episodeCode === 'S02E01')!.videoFilename).toBe('Show.S02E01.mkv')
  })
  it('a missing episode leaves it uncovered without shifting others', () => {
    // pack has E01, E03 but LLM (wrongly or not) only maps those two; E02 stays uncovered, E03 stays E03
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', confidence: 0.9, reason: 'x' },
      { filelist_index: 2, episode_code: 'S02E03', confidence: 0.9, reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps, minConfidence: 0.86 })
    expect(r.commit.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E03'])
  })
  it('drops pairs whose episode_code is not in the Jellyfin season set', () => {
    const map = { pairs: [{ filelist_index: 0, episode_code: 'S02E99', confidence: 0.99, reason: 'special' }], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps, minConfidence: 0.86 })
    expect(r.commit).toEqual([])
    expect(r.dropped.some(d => /not in season/i.test(d.reason))).toBe(true)
  })
  it('drops out-of-range filelist_index and non-subtitle extensions', () => {
    const map = { pairs: [
      { filelist_index: 99, episode_code: 'S02E01', confidence: 0.9, reason: 'x' },
      { filelist_index: 3, episode_code: 'S02E02', confidence: 0.9, reason: 'x' }, // readme.txt
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps, minConfidence: 0.86 })
    expect(r.commit).toEqual([])
  })
  it('dedups a duplicate episode_code keeping highest confidence', () => {
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', confidence: 0.70, reason: 'lo' },
      { filelist_index: 1, episode_code: 'S02E01', confidence: 0.95, reason: 'hi' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps, minConfidence: 0.60 })
    expect(r.commit.length).toBe(1)
    expect(r.commit[0].filelistIndex).toBe(1)
  })
  it('drops pairs below the confidence threshold', () => {
    const map = { pairs: [{ filelist_index: 0, episode_code: 'S02E01', confidence: 0.5, reason: 'x' }], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps, minConfidence: 0.86 })
    expect(r.commit).toEqual([])
  })
  it('only covers episodes that still need Chinese (skips already-subbed)', () => {
    const eps = [ep(1, true), ep(2, false)]
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', confidence: 0.9, reason: 'x' },
      { filelist_index: 1, episode_code: 'S02E02', confidence: 0.9, reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: eps, minConfidence: 0.86 })
    expect(r.commit.map(c => c.episodeCode)).toEqual(['S02E01'])
  })
})
```

- [ ] **Step 2:** `npx vitest run src/core/seasonPackGate.test.ts` — FAIL(模块不存在)。

- [ ] **Step 3: 实现** `src/core/seasonPackGate.ts`:
```typescript
import { basename } from 'node:path'
import type { SeasonEpisode } from './episode.js'

const SUBTITLE_EXT = /\.(srt|ass|ssa)$/i

export interface SeasonMapPair { filelist_index: number; episode_code: string; confidence: number; reason: string }
export interface SeasonMapLike { pairs: SeasonMapPair[]; unmapped_files?: number[]; reasons?: string[] }
export interface SeasonPackFile { f: string; url?: string }

export interface SeasonPackCommitItem {
  episodeCode: string
  filelistIndex: number
  filename: string
  downloadUrl: string
  videoPath: string
  videoFilename: string
}
export interface SeasonPackGateResult {
  commit: SeasonPackCommitItem[]
  dropped: { episodeCode?: string; filelistIndex?: number; reason: string }[]
}

export interface SeasonPackGateInput {
  map: SeasonMapLike
  filelist: SeasonPackFile[]
  seasonEpisodes: SeasonEpisode[]
  minConfidence: number
}

/**
 * 按 episodeCode 集合 join（非位置对齐）+ 逐项校验 + verify-then-commit，产出安全提交集。
 * 防"整季串号"：缺集只是该 code 未覆盖，不会让其余集下滑。逐项软失败进 dropped[]，绝不整批作废。
 */
export function runSeasonPackGate(input: SeasonPackGateInput): SeasonPackGateResult {
  const { map, filelist, seasonEpisodes, minConfidence } = input
  // 仅覆盖仍缺中字的集：集合 join 的 key -> SeasonEpisode
  const needSet = new Map<string, SeasonEpisode>()
  for (const e of seasonEpisodes) if (e.needsChinese) needSet.set(e.episodeCode, e)

  const commit: SeasonPackCommitItem[] = []
  const dropped: SeasonPackGateResult['dropped'] = []
  const bestByCode = new Map<string, { pair: SeasonMapPair; item: SeasonPackCommitItem }>()

  for (const pair of map.pairs ?? []) {
    const tag = { episodeCode: pair.episode_code, filelistIndex: pair.filelist_index }
    if (pair.filelist_index < 0 || pair.filelist_index >= filelist.length) {
      dropped.push({ ...tag, reason: `filelist_index out of range` }); continue
    }
    const file = filelist[pair.filelist_index]
    if (!SUBTITLE_EXT.test(file.f)) { dropped.push({ ...tag, reason: `not a subtitle file: ${file.f}` }); continue }
    if (!file.url) { dropped.push({ ...tag, reason: `no download url for ${file.f}` }); continue }
    const episode = needSet.get(pair.episode_code)
    if (!episode) { dropped.push({ ...tag, reason: `episode_code not in season (or already subbed): ${pair.episode_code}` }); continue }
    if (pair.confidence < minConfidence) { dropped.push({ ...tag, reason: `confidence ${pair.confidence} < ${minConfidence}` }); continue }
    const item: SeasonPackCommitItem = {
      episodeCode: pair.episode_code, filelistIndex: pair.filelist_index,
      filename: basename(file.f), downloadUrl: file.url,
      videoPath: episode.videoPath, videoFilename: episode.videoFilename,
    }
    const prev = bestByCode.get(pair.episode_code)
    if (!prev || pair.confidence > prev.pair.confidence) {
      if (prev) dropped.push({ episodeCode: prev.pair.episode_code, filelistIndex: prev.pair.filelist_index, reason: 'duplicate episode_code, kept higher confidence' })
      bestByCode.set(pair.episode_code, { pair, item })
    } else {
      dropped.push({ ...tag, reason: 'duplicate episode_code, kept higher confidence' })
    }
  }
  for (const { item } of bestByCode.values()) commit.push(item)
  return { commit, dropped }
}
```

- [ ] **Step 4:** `npx vitest run src/core/seasonPackGate.test.ts` — PASS(全 7 例)。

- [ ] **Step 5: 提交**
```bash
git add src/core/seasonPackGate.ts src/core/seasonPackGate.test.ts
git commit -m "feat(gate): seasonPackGate — set-join by episode code, verify-then-commit"
```

---

## Task 3: Jellyfin getSeasonEpisodes + SeriesId

**Files:**
- Modify: `src/adapters/players/jellyfin.ts`
- Test: `src/adapters/players/jellyfin.test.ts`
- Create: `fixtures/assrt/detail-season-pack.json`(供后续 pipeline 测试；本任务顺带造）

背景:季升格需枚举该剧该季全部集。当前 episode item 有 `ParentIndexNumber`(季)、`IndexNumber`(集)但无 `SeriesId`。Jellyfin 查季集:`GET /Shows/{SeriesId}/Episodes?season={n}&fields=Path,MediaStreams`。返回 `{Items:[episode...]}`。

- [ ] **Step 1: 写失败测试**

在 `src/adapters/players/jellyfin.test.ts` 追加(复用现有 `jsonResponse`/`movieItem` helper 风格；若无则参考 Task5 里的 fake fetch）:
```typescript
describe('getSeasonEpisodes', () => {
  it('lists a season\'s episodes with codes and needsChinese', async () => {
    const CN = { Type: 'Subtitle', Language: 'zh-Hans', IsExternal: true, Codec: 'ass' }
    const body = { Items: [
      { Id: 'e1', Type: 'Episode', Path: '/media/tv/Show/Season 2/Show.S02E01.mkv', ParentIndexNumber: 2, IndexNumber: 1, MediaStreams: [] },
      { Id: 'e2', Type: 'Episode', Path: '/media/tv/Show/Season 2/Show.S02E02.mkv', ParentIndexNumber: 2, IndexNumber: 2, MediaStreams: [CN] },
    ] }
    const fetchImpl = vi.fn(async () => jsonResponse(body))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const seriesItem = { Id: 'ep-current', Type: 'Episode', SeriesId: 'series-9', ParentIndexNumber: 2, IndexNumber: 3 } as unknown as JellyfinItem
    const eps = await jf.getSeasonEpisodes(seriesItem)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/Shows/series-9/Episodes')
    expect(eps.map(e => e.episodeCode)).toEqual(['S02E01', 'S02E02'])
    expect(eps[0].needsChinese).toBe(true)   // e1 no subs
    expect(eps[1].needsChinese).toBe(false)  // e2 has zh-Hans
    expect(eps[0].videoFilename).toBe('Show.S02E01.mkv')
  })
  it('returns [] when the item has no SeriesId (silent)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getSeasonEpisodes({ Id: 'x', Type: 'Episode' } as unknown as JellyfinItem)).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2:** `npx vitest run src/adapters/players/jellyfin.test.ts` — FAIL。

- [ ] **Step 3: 实现**

3a. `JellyfinItemSchema` 加 `SeriesId`(在 `SeriesName` 行后):
```typescript
  SeriesName: z.string().nullish(),
  SeriesId: z.string().nullish(),
```
3b. `ITEM_FIELDS` 保持不变(getItem 不必带 SeriesId——但 season 枚举需要当前 item 的 SeriesId;确保 getItem 的 fields 含 SeriesId)。把 `ITEM_FIELDS` 改为:
```typescript
const ITEM_FIELDS = 'Path,ProviderIds,MediaStreams,OriginalTitle,ProductionLocations,Overview,SeriesId'
```
3c. 在 `getChineseTitle` 之后新增(复用 `needsChineseSubtitle` 逻辑——从 triggers.ts import,或内联同款正则)。注意:import `formatEpisodeCode` 与 `type SeasonEpisode`：
```typescript
import { formatEpisodeCode, type SeasonEpisode } from '../../core/episode.js'
import { needsChineseSubtitle } from '../../daemon/triggers.js'
```
方法:
```typescript
  /**
   * 枚举该剧该季全部集（含每集 SxxExx 与是否缺中字）。无 SeriesId / 非剧集 / 失败 → 静默返回 []。
   * 路径为 Jellyfin 侧原始路径，调用方负责 MEDIA_PATH_MAPPINGS 映射为本地路径。
   */
  async getSeasonEpisodes(item: JellyfinItem): Promise<SeasonEpisode[]> {
    const seriesId = item.SeriesId
    const season = item.ParentIndexNumber
    if (!seriesId || season == null) return []
    try {
      const raw = await this.call('GET',
        `/Shows/${encodeURIComponent(seriesId)}/Episodes?season=${season}&fields=Path,MediaStreams`)
      const r = JellyfinItemsResponseSchema.parse(raw)
      const out: SeasonEpisode[] = []
      for (const ep of r.Items) {
        if (ep.Type !== 'Episode' || ep.IndexNumber == null || ep.ParentIndexNumber == null || !ep.Path) continue
        out.push({
          itemId: ep.Id,
          seasonNumber: ep.ParentIndexNumber,
          episodeNumber: ep.IndexNumber,
          episodeCode: formatEpisodeCode(ep.ParentIndexNumber, ep.IndexNumber),
          videoPath: ep.Path,
          videoFilename: ep.Path.split('/').pop() ?? ep.Path,
          needsChinese: needsChineseSubtitle(ep, true),
        })
      }
      return out
    } catch {
      return []
    }
  }
```
注意:`needsChineseSubtitle` 第二参 `treatPgsAsMissing` 这里固定 true(与生产默认一致)。若 triggers.ts import 造成循环依赖(triggers 不 import jellyfin 类，仅 import 其 type，应无环)，验证 `npx tsc --noEmit` 通过;若有环则把 needsChineseSubtitle 的判定逻辑内联到本方法。

- [ ] **Step 4:** `npx vitest run src/adapters/players/jellyfin.test.ts` — PASS。

- [ ] **Step 5: 造 season-pack fixture**（供 Task 5 pipeline 测试）。基于真实 ASSRT 季包结构手造 `fixtures/assrt/detail-season-pack.json`:
```json
{ "status": 0, "sub": { "subs": [ { "id": 900900, "videoname": "Show S02 整季", "native_name": "剧 第二季",
  "lang": { "desc": "简体" }, "subtype": "ass", "filelist": [
  { "s": "40KB", "f": "Show.S02E01.chs.ass", "url": "http://file0.assrt.net/pack/900900/1" },
  { "s": "41KB", "f": "Show.S02E02.chs.ass", "url": "http://file0.assrt.net/pack/900900/2" },
  { "s": "42KB", "f": "Show.S02E03.chs.ass", "url": "http://file0.assrt.net/pack/900900/3" } ] } ] } }
```

- [ ] **Step 6: 提交**
```bash
git add src/adapters/players/jellyfin.ts src/adapters/players/jellyfin.test.ts fixtures/assrt/detail-season-pack.json
git commit -m "feat(jellyfin): getSeasonEpisodes (season enumeration) + SeriesId + season-pack fixture"
```

---

## Task 4: mapSeasonPack 判断点(LLM 批量映射)

**Files:**
- Create: `src/agent/mapSeasonPack.ts`
- Modify: `src/core/schemas.ts`（SeasonMapSchema）

背景:LLM 批量读包内文件名，为每个字幕文件配一个该季已知集的 `episode_code`。**prompt-only 判断点，无断言单测**（惯例，靠 controller）。schema 用现有 `looseNumeric` 抵御 MiMo 把数字输出成字符串。

- [ ] **Step 1: schemas.ts 加 SeasonMapSchema**

在 `src/core/schemas.ts` 末尾（`OrphanDecisionSchema` 之后）追加。复用文件顶部已有的 `looseNumeric`:
```typescript
export const SeasonMapSchema = z.object({
  pairs: z.array(z.object({
    filelist_index: looseNumeric(z.number().int()),
    episode_code: z.string(),
    confidence: z.preprocess(
      v => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v),
      z.number().min(0).max(1),
    ),
    reason: z.string(),
  })).default([]),
  unmapped_files: z.array(z.number().int()).default([]),
  reasons: z.array(z.string()).default([]),
})
export type SeasonMap = z.infer<typeof SeasonMapSchema>
```
注意:`looseNumeric` 返回 `number | null | undefined`;seasonPackGate 的 `SeasonMapPair.filelist_index` 是 `number`。为兼容，gate 消费前 pipeline 会 `.filter(p => p.filelist_index != null && p.confidence != null)`（见 Task 5）。或在此把 filelist_index 用非空断言——**采用 pipeline 过滤方案**，gate 保持 `number` 契约不变。

- [ ] **Step 2: 实现** `src/agent/mapSeasonPack.ts`（对照 `src/agent/rankCandidates.ts` 的风格：`llm.call({ name, description, prompt, schema })`）:
```typescript
import type { LlmRuntime } from './runtime.js'
import { SeasonMapSchema, type SeasonMap, type MediaContext, type MediaIdentity } from '../core/schemas.js'
import type { SeasonEpisode } from '../core/episode.js'
import type { CallStructuredResult } from './llm.js'

export async function mapSeasonPack(
  llm: LlmRuntime, ctx: MediaContext, identity: MediaIdentity,
  filelist: { f: string }[], seasonEpisodes: SeasonEpisode[],
): Promise<CallStructuredResult<SeasonMap>> {
  const files = filelist.map((e, i) => ({ index: i, filename: e.f }))
  const episodes = seasonEpisodes
    .filter(e => e.needsChinese)
    .map(e => ({ episode_code: e.episodeCode, video: e.videoFilename }))
  const prompt = [
    'Map each subtitle file in a whole-season subtitle pack to the correct episode.',
    'A WRONG mapping shifts an entire season of subtitles — worse than leaving gaps. Be conservative.',
    '',
    'Read the REAL filenames to decide the episode — you understand "[Grp] Show - 04.chs.ass" is episode 4,',
    '"第3集"=E03, "尝鲜版09"=E09, "[04]"=E04, an "End"/"完"/"Fin" marker = the finale. Do NOT use regex or',
    'suffix tricks — read and judge like a human. Absolute-numbered anime files map to the season episode with',
    'that number.',
    '',
    'For each subtitle file, emit one pair { filelist_index, episode_code, confidence, reason } where episode_code',
    'is EXACTLY one of the known episode_codes listed below. If you are not confident which episode a file is,',
    'put its index in unmapped_files instead of guessing. Only emit pairs you are sure of.',
    'episode_code MUST be copied verbatim from the known list (format SxxExx).',
    '',
    `series: ${identity.canonical_title} ${identity.year ?? ''}`.trim(),
    `known episodes still needing Chinese subs (map ONLY to these): ${JSON.stringify(episodes)}`,
    `subtitle files in the pack: ${JSON.stringify(files)}`,
  ].join('\n')
  return llm.call({
    name: 'report_season_map',
    description: 'Map each season-pack subtitle file to its episode', prompt, schema: SeasonMapSchema,
  })
}
```

- [ ] **Step 3:** `npx vitest run`（全量，确认 schema 加得没破坏）+ `npx tsc --noEmit`。Expected：全绿、无类型错误。

- [ ] **Step 4: 提交**
```bash
git add src/agent/mapSeasonPack.ts src/core/schemas.ts
git commit -m "feat(agent): mapSeasonPack judgment point + SeasonMapSchema"
```

---

## Task 5: pipeline 季分支 + shouldGraduate + PipelineDeps.seasonPack

**Files:**
- Modify: `src/core/pipeline.ts`
- Test: `src/core/pipeline.test.ts`

背景:在 rank+gate 通过（rank 选中 download、assrt_id 有效）之后、现有单集 resolve/download 之前插入升格分支。升格失败/0 提交 → 回落现有单集路径。

`PipelineResult` 加 `coveredEpisodes`；`PipelineDeps` 加可选 `seasonPack`。当前单集路径从 `journal.step('resolveDownloadUrl')` 开始（pipeline.ts 现约第 168 行）。

- [ ] **Step 1: 写失败测试**

在 `src/core/pipeline.test.ts` 追加。用注入的 fake `seasonPack` + fake `mapSeasonPack` 返回，断言逐集 write + onCovered。顶部按需 import `AssrtDetailResponseSchema`（已 import）与 season-pack fixture：
```typescript
import { readFileSync } from 'node:fs'  // 已 import
const seasonDetail = AssrtDetailResponseSchema.parse(JSON.parse(readFileSync('fixtures/assrt/detail-season-pack.json', 'utf8')))
```
```typescript
it('graduates to season mode: writes a sidecar per mapped episode', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'out-'))
  // rank selects the season pack (id 900900); pack filelist has 3 episodes
  const packCandidate = seasonDetail.sub.subs[0]
  const search = vi.fn(async () => AssrtSearchResponseSchema.parse({ status: 0, sub: { subs: [packCandidate] } }))
  const rank = vi.fn(async () => ({
    parsed: { decision: 'download' as const, assrt_id: 900900, file_index: 0, confidence: 0.95, reasons: ['pack'], rejected: [] },
    rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
  }))
  const seasonEps = [
    { itemId: 'e1', seasonNumber: 2, episodeNumber: 1, episodeCode: 'S02E01', videoPath: join(outDir, 'Show.S02E01.mkv'), videoFilename: 'Show.S02E01.mkv', needsChinese: true },
    { itemId: 'e2', seasonNumber: 2, episodeNumber: 2, episodeCode: 'S02E02', videoPath: join(outDir, 'Show.S02E02.mkv'), videoFilename: 'Show.S02E02.mkv', needsChinese: true },
    { itemId: 'e3', seasonNumber: 2, episodeNumber: 3, episodeCode: 'S02E03', videoPath: join(outDir, 'Show.S02E03.mkv'), videoFilename: 'Show.S02E03.mkv', needsChinese: false },
  ]
  const covered: string[] = []
  const deps = makeDeps({
    assrt: { search, detail: vi.fn(async () => seasonDetail) },
    rank: rank as unknown as PipelineDeps['rank'],
    download: vi.fn(async () => ({ bytes: Buffer.from('[Script Info]\n'), contentType: 'text/plain' })),
    seasonPack: {
      enumerate: vi.fn(async () => seasonEps),
      map: vi.fn(async () => ({
        parsed: { pairs: [
          { filelist_index: 0, episode_code: 'S02E01', confidence: 0.95, reason: 'x' },
          { filelist_index: 1, episode_code: 'S02E02', confidence: 0.95, reason: 'x' },
        ], unmapped_files: [], reasons: [] }, rawText: '', retries: 0, durationMs: 1, prompt: 'map prompt',
      })),
      onCovered: vi.fn(async (ep: { episodeCode: string }) => { covered.push(ep.episodeCode) }),
    },
  })
  // ctx must be an episode
  const epCtx = { ...ctx, media: { ...ctx.media, type: 'episode' as const, season: 2, episode: 1 } }
  const result = await runPipeline(deps, epCtx, outDir)
  expect(result.decision).toBe('download')
  expect(result.coveredEpisodes?.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02'])
  expect(covered.sort()).toEqual(['S02E01', 'S02E02'])   // onCovered fired per episode
  expect(existsSync(join(outDir, 'Show.S02E01.zh-Hans.ass'))).toBe(true)
  expect(existsSync(join(outDir, 'Show.S02E02.zh-Hans.ass'))).toBe(true)
  expect(existsSync(join(outDir, 'Show.S02E03.zh-Hans.ass'))).toBe(false)  // e3 didn't need it
})

it('does NOT graduate for a movie (single-episode path unaffected)', async () => {
  // existing golden-path movie test already covers this; assert seasonPack.enumerate not called
  const enumerate = vi.fn(async () => [])
  const deps = makeDeps({ seasonPack: { enumerate, map: vi.fn(), onCovered: vi.fn() } as unknown as PipelineDeps['seasonPack'] })
  await runPipeline(deps, ctx, mkdtempSync(join(tmpdir(), 'out-')))   // ctx is a movie
  expect(enumerate).not.toHaveBeenCalled()
})
```

- [ ] **Step 2:** `npx vitest run src/core/pipeline.test.ts` — FAIL（季分支不存在；coveredEpisodes 未定义）。

- [ ] **Step 3: 实现**

3a. import 增补(pipeline.ts 顶部):
```typescript
import { dirname } from 'node:path'   // 已 import dirname
import { runSeasonPackGate } from './seasonPackGate.js'
import type { SeasonEpisode } from './episode.js'
import type { SeasonMap } from './schemas.js'
```
3b. `PipelineResult` 加字段:
```typescript
export interface PipelineResult {
  decision: 'download' | 'ask_user' | 'no_safe_match' | 'retry_later' | 'already_exists' | 'error' | 'adopted_local'
  subtitlePath?: string
  coveredEpisodes?: { episodeCode: string; subtitlePath: string }[]
  journalPath: string
  fromCache?: boolean
  stats: { durationMs: number; llmCalls: number; apiCalls: number }
}
```
3c. `PipelineDeps` 加可选依赖:
```typescript
  /** 季包升格（可选；未注入则始终走单集）。 */
  seasonPack?: {
    enumerate: (ctx: MediaContext) => Promise<SeasonEpisode[]>
    map: (ctx: MediaContext, id: MediaIdentity, filelist: { f: string }[], eps: SeasonEpisode[]) => Promise<CallStructuredResult<SeasonMap>>
    onCovered: (ep: SeasonEpisode, subtitlePath: string) => void | Promise<void>
  }
```
3d. `finish` 增 coveredEpisodes 透传:把 `finish` 的 extra 类型加 `coveredEpisodes?`，并在返回对象带上:
```typescript
  const finish = (
    decision: PipelineResult['decision'],
    extra: { reasons?: string[]; confidence?: number | null; subtitlePath?: string; bytes?: number; encoding?: string | null; fromCache?: boolean; coveredEpisodes?: { episodeCode: string; subtitlePath: string }[] } = {},
  ): PipelineResult => {
    const journalPath = journal.finish({ /* 不变 */ }, journalDir)
    return { decision, subtitlePath: extra.subtitlePath, coveredEpisodes: extra.coveredEpisodes, journalPath, fromCache: extra.fromCache, stats: { durationMs: Date.now() - t0, ...journal.counts() } }
  }
```
3e. 新增纯函数 `shouldGraduate`（导出，便于单测）在文件底部或顶部:
```typescript
export function shouldGraduate(
  ctx: MediaContext, candidate: AssrtSub | undefined, seasonEpisodes: SeasonEpisode[],
): boolean {
  if (ctx.media.type !== 'episode') return false
  if (!candidate) return false
  const subFiles = candidate.filelist.filter(f => /\.(srt|ass|ssa)$/i.test(f.f))
  if (subFiles.length < 2) return false           // 候选须覆盖多集
  return seasonEpisodes.filter(e => e.needsChinese).length >= 2
}
```
3f. 季分支：在 `runPipeline` 里 **gate 通过之后**（`if (!gate.ok) return ...` 之后）、`journal.step('resolveDownloadUrl')` 之前插入。注意 `candidates` 里选中的候选 = `candidates.find(c => c.id === rank.assrt_id)`:
```typescript
    // 5.season 季包升格（仅 episode + 注入 seasonPack + 候选覆盖多集 + 该季≥2集缺）
    if (deps.seasonPack && ctx.media.type === 'episode' && rank.assrt_id != null) {
      const selected = candidates.find(c => c.id === rank.assrt_id)
      const seasonEpisodes = await deps.seasonPack.enumerate(ctx)
      if (shouldGraduate(ctx, selected, seasonEpisodes)) {
        journal.step('seasonGraduate', { episodes: seasonEpisodes.length, needs: seasonEpisodes.filter(e => e.needsChinese).length })
        const detail = await deps.assrt.detail(rank.assrt_id)
        const packSub = detail.sub.subs.find(s => s.id === rank.assrt_id) ?? detail.sub.subs[0]
        if (packSub) {
          const mapResult = await deps.seasonPack.map(ctx, identity, packSub.filelist, seasonEpisodes)
          journal.llmCall({ point: 'mapSeasonPack', prompt: mapResult.prompt, rawText: mapResult.rawText, parsed: mapResult.parsed, retries: mapResult.retries, durationMs: mapResult.durationMs })
          const pairs = mapResult.parsed.pairs.filter(p => p.filelist_index != null && p.confidence != null) as { filelist_index: number; episode_code: string; confidence: number; reason: string }[]
          const gateRes = runSeasonPackGate({ map: { pairs }, filelist: packSub.filelist, seasonEpisodes, minConfidence: ctx.preferences.auto_download_min_confidence })
          journal.step('seasonPackGate', { commit: gateRes.commit.length, dropped: gateRes.dropped.length })
          if (gateRes.commit.length > 0) {
            const covered: { episodeCode: string; subtitlePath: string }[] = []
            let consecutiveFails = 0
            for (const item of gateRes.commit) {
              if (consecutiveFails >= 3) { journal.step('seasonCircuitBreak', { after: covered.length }); break }
              try {
                const dl = await deps.download(item.downloadUrl)
                const written = await writeSubtitle({
                  artifact: dl.bytes, artifactFilename: item.filename,
                  videoFilename: item.videoFilename, langTag: ctx.preferences.language,
                  outDir: dirname(item.videoPath),
                })
                covered.push({ episodeCode: item.episodeCode, subtitlePath: written.path })
                const epMeta = seasonEpisodes.find(e => e.episodeCode === item.episodeCode)!
                try { await deps.seasonPack.onCovered(epMeta, written.path) } catch { /* 观测/联动不影响主流程 */ }
                consecutiveFails = 0
              } catch (e) {
                consecutiveFails++
                journal.step('seasonEpisodeFailed', { episode: item.episodeCode, message: String(e) })
              }
            }
            if (covered.length > 0) {
              return finish('download', { reasons: [`season pack: covered ${covered.length} episodes`], confidence: rank.confidence, coveredEpisodes: covered, subtitlePath: covered[0].subtitlePath })
            }
          }
        }
        // 季模式 0 覆盖 → 落回单集路径（不 return，继续往下）
      }
    }
```
注意:`AssrtSub` 已在 pipeline.ts import。`writeSubtitle` 已 import。season 分支放在 `if (!gate.ok)` 之后、`// 5. resolve download URL` 之前。

- [ ] **Step 4:** `npx vitest run src/core/pipeline.test.ts` — PASS（含新季模式用例 + movie 不升格用例；既有 golden path 仍绿，因其 ctx 是 movie 不触发）。

- [ ] **Step 5:** 全量 `npx vitest run` + `npx tsc --noEmit` — 全绿。

- [ ] **Step 6: 提交**
```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts
git commit -m "feat(pipeline): season-pack graduation branch + shouldGraduate + coveredEpisodes"
```

---

## Task 6: cli 装配注入 seasonPack 依赖

**Files:**
- Modify: `src/cli/index.ts`

背景:把 `seasonPack` 依赖接进 pipeline。**关键设计**:`seasonPack.enumerate(ctx)` 需要 `JellyfinItem`（含 SeriesId/season），而 pipeline 只有 ctx。**干净解法**:enumerate 闭包捕获 `jf` + `itemId`，内部 `jf.getItem(itemId)` 重取 item（getItem 的 ITEM_FIELDS 已含 SeriesId，见 Task3）——**完全不改 watcher 的 runJob 签名**。enumerate 只在 episode 走到 rank+download 才被调用，这一次额外 getItem 可接受。

**改动**:把 `jf` 与 `mappings` 提到 `assemble()` 内构造一次并从 assemble 返回；`makeDeps` 增可选参 `perRun`，据此挂 seasonPack。

- [ ] **Step 1: assemble 内构造 jf + mappings；makeDeps 接 perRun 挂 seasonPack**

顶部 import 增补:
```typescript
import { mapSeasonPack } from '../agent/mapSeasonPack.js'
import type { SeasonEpisode } from '../core/episode.js'
```
（`mapPath` 从 `../core/mediaContext.js` import——若未 import 则加入该行现有 import。）

在 `assemble()` 顶部（`cacheRoot` 之后）构造单例:
```typescript
  const mappings = parsePathMappings(process.env.MEDIA_PATH_MAPPINGS)
  const jf = new JellyfinClient({ baseUrl: requireEnv('JELLYFIN_URL'), apiKey: requireEnv('JELLYFIN_API_KEY') })
```
`makeDeps` 改签名，在现有返回对象末尾按 perRun 条件加 seasonPack:
```typescript
  const makeDeps = (perRun?: { itemId: string; onCovered: (ep: SeasonEpisode, path: string) => void | Promise<void> }): PipelineDeps => ({
    // ... 现有全部字段不变 ...
    ...(perRun ? {
      seasonPack: {
        enumerate: async () => {
          const item = await jf.getItem(perRun.itemId)
          return (await jf.getSeasonEpisodes(item)).map(e => ({ ...e, videoPath: mapPath(e.videoPath, mappings) }))
        },
        map: (c, id, filelist, eps) => mapSeasonPack(llm, c, id, filelist, eps),
        onCovered: perRun.onCovered,
      },
    } : {}),
  })
```
`assemble` 返回值带上 jf/mappings 供命令处用:`return { makeDeps, cacheRoot, llm, jf, mappings }`。
（现有 `makeJellyfin()` 各处改为复用该 `jf` 单例，或删 makeJellyfin 直接用 assemble 返回的 jf。）

- [ ] **Step 2: cmdRunItem 传 perRun（onCovered=refresh）**

`cmdRunItem` 里取出 `jf`（`const { makeDeps, cacheRoot, llm, jf } = await assemble()`），构造 deps 时传 perRun:
```typescript
  const result = await runPipeline(
    makeDeps({ itemId, onCovered: async (ep) => { await jf.refreshItem(ep.itemId).catch(() => {}) } }),
    ctx, mediaDir(ctx), journalDir)
```
（run-item 无队列，onCovered 仅 refresh。若 `cmdRunItem` 原本用 `makeJellyfin()` 自建 jf，改为用 assemble 返回的 jf 单例，保持同一实例。）

- [ ] **Step 3: cmdWatch 的 runJob 传 perRun（onCovered=队列移除+refresh）**

`cmdWatch` 取出 `jf`（`const { makeDeps, cacheRoot, llm, jf } = await assemble()`）。`runJob` 改为:
```typescript
    runJob: async (ctx, outDir, itemId, opts) => {
      applyConfidenceOverride(ctx)
      const journalDir = join(cacheRoot, 'journals', `${itemId}-${Date.now()}`)
      return runPipeline(
        makeDeps({ itemId, onCovered: async (ep) => { queue.remove(ep.itemId); await jf.refreshItem(ep.itemId).catch(() => {}) } }),
        ctx, outDir, journalDir, opts)
    },
```
（`jf`/`queue` 在 cmdWatch 作用域可见。**不改 watcher.ts / watcher.test.ts**——runJob 签名不变。）

- [ ] **Step 4:** 全量 `npx vitest run` + `npx tsc --noEmit` — 全绿、无类型错误（watcher 签名未变，其测试不受影响）。

- [ ] **Step 5: 提交**
```bash
git add src/cli/index.ts
git commit -m "feat(cli): wire per-run seasonPack deps (getItem-refetch enumerate, onCovered refresh/dequeue)"
```

---

## Task 7: Controller 真实验证 + 部署 + 合并（主循环执行）

**Files:** 无代码改动。主循环持凭据执行。

- [ ] **Step 1: 全量门禁** `npx vitest run && npx tsc --noEmit` — 全绿。

- [ ] **Step 2: 部署软路由** `bash deploy/deploy.sh`；确认容器 Up + watching。

- [ ] **Step 3: 挑一部有整季包的剧真实验证**。在软路由清负缓存后，对一部该季 ≥2 集缺中字、且 ASSRT 有整季包的剧集跑 `run-item`：
```bash
ssh media-router-tunnel "cd /mnt/nvme0n1-4/docker/subtitle-scout && docker exec subtitle-scout npx tsx src/cli/index.ts run-item --item-id <episodeItemId>"
```
Expected：decision=download，journal 有 `seasonGraduate` + `mapSeasonPack` + `seasonPackGate`(commit N) step；NAS 上该季多集 `.zh-Hans.ass` 落地；`coveredEpisodes` 多条。用容器内 node 提取 journal 关键字段（避免大 payload 撑爆隧道）。

- [ ] **Step 4: 安全性抽查**。核对映射正确性：随机抽 2 集，比对 sidecar 文件名的集号与视频集号一致（无串号）；确认缺集/多余特别篇被 gate 正确 drop（journal seasonPackGate.dropped）。

- [ ] **Step 5: 收尾**。`superpowers:finishing-a-development-branch` 合并 `season-pack` 回 main；更新 `project-subtitle-scout-status` 记忆（季包升格已合并 + 真实验收结论）。

---

## Self-Review

**Spec coverage：**
- 触发/升格条件 → Task5 `shouldGraduate`（episode + 注入 + 候选多集 + 该季≥2缺）。✅
- getSeasonEpisodes（player-agnostic，SeriesId）→ Task3。✅
- mapSeasonPack 判断点（LLM 批量读名）→ Task4。✅
- seasonPackGate（集合 join + 逐项校验 + verify-then-commit + dedup + 扩展名 + 置信门槛 + 仅覆盖 needsChinese）→ Task2。✅
- pipeline 季分支（逐集 download+write、prefix-copy、逐项软失败、3连败熔断、0提交回退单集、onCovered refresh/dequeue）→ Task5。✅
- N 次直连 → Task5（每 commit item 的 downloadUrl）。✅
- coveredEpisodes 结果 + journal seasonMap step → Task5。✅
- cli 装配 + 路径映射 + onCovered 队列/refresh → Task6。✅
- formatEpisodeCode（上千集不截断）→ Task1。✅
- 测试（gate 充分单测、shouldGraduate、fixture、pipeline 集成、controller）→ 各 Task。✅
- 不做（季级触发/覆盖度库/OCR/电影）→ 计划未触碰。✅

**已知取舍/风险（计划内已标注）：**
- Task6 的接线难点（getSeasonEpisodes 需 JellyfinItem 而 pipeline 只有 ctx）用"enumerate 闭包内 `jf.getItem(itemId)` 重取"解决——**不改 watcher.runJob 签名、不动 watcher.test.ts**，代价是季升格时每任务多一次 getItem（仅 episode 且走到 rank+download 才发生）。
- `looseNumeric` 使 SeasonMap.filelist_index 为 `number|null`；pipeline 消费前 `.filter(p=>p.filelist_index!=null)` 后断言为 gate 的 `number` 契约（Task5 3f）。
- 无真实 season-pack fixture → Task3 手造一个结构真实的（若 controller 阶段拿到真实 ASSRT 季包 detail，可替换 fixture 更真）。

**Placeholder 扫描：** 无 TBD；每步给完整代码 + 命令。Task6 的接线因涉及签名变更，给了"修正（更干净的接线）"的明确落地方案（per-run 闭包捕获 item），非占位。✅

**类型一致性：** `SeasonEpisode`（episode.ts, Task1）在 gate/jellyfin/pipeline/cli 全一致;`SeasonMap`/`SeasonMapSchema`（Task4）在 mapSeasonPack/pipeline 一致;`runSeasonPackGate` 输入 `{map,filelist,seasonEpisodes,minConfidence}`、输出 `{commit,dropped}`（Task2）在 pipeline（Task5）一致;`PipelineDeps.seasonPack.{enumerate,map,onCovered}` 签名在 pipeline 定义（Task5）与 cli 实现（Task6）一致;`formatEpisodeCode`（Task1）在 jellyfin（Task3）使用。✅
