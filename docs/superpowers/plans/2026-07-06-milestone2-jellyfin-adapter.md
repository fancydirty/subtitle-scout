# Milestone 2 (Phase A) Implementation Plan: Jellyfin Adapter + Watch Mode

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Coding tasks → **sonnet-5 subagents**；Task 1（环境+录制）与 Task 8（真实 e2e）由 controller 主循环执行。

**Goal:** subtitle-scout 从单发 CLI 进化为常驻 sidecar：轮询 Jellyfin 发现"正在播放且缺中文字幕"的媒体，自动跑 M1 流水线，字幕落到视频同目录，refresh 后验证字幕流出现。

**Architecture:** 新增 JellyfinClient（zod loose schema，fixture 可测）、mediaContext 映射、触发条件纯函数、watcher 轮询循环；CLI 子命令化（run/run-item/watch）。M1 核心唯一改动：`runPipeline` 增加可选 `journalDir`（默认=outDir，完全向后兼容）。

**Tech Stack:** 既有栈。零新生产依赖。开发环境：OrbStack Docker 跑 jellyfin/jellyfin 官方镜像 + ffmpeg 假视频。

**Spec:** `docs/superpowers/specs/2026-07-06-milestone2-jellyfin-adapter-design.md`

**子代理必读事实：**

- NodeNext ESM，本地 import 带 `.js`。测试 `npx vitest run <file>`。当前 79 测试全绿，不许破坏。
- M1 模式先例：外部 API 的 zod schema 一律 loose/passthrough，**以 `fixtures/jellyfin/` 里录制的真实响应为 ground truth**——计划里的字段形状是良好近似，与录制数据冲突时以录制数据为准并在报告说明。
- Jellyfin 认证：所有请求带 header `X-Emby-Token: <api key>`。
- `MediaContextSchema`（src/core/schemas.ts）是流水线入口类型，本里程碑不改它。

---

## File Structure

```
fixtures/jellyfin/                 # Task 1 录制：sessions-playing.json, items-detail.json,
                                   #   item-after-refresh.json
src/adapters/players/
├── jellyfin.ts                    # schemas + JellyfinClient
└── jellyfin.test.ts
src/core/
├── mediaContext.ts                # buildMediaContext + parsePathMappings
├── mediaContext.test.ts
└── pipeline.ts                    # +journalDir 可选参数（唯一 M1 改动）
src/daemon/
├── triggers.ts                    # needsChineseSubtitle 等纯函数
├── triggers.test.ts
├── watcher.ts                     # Watcher 类：tick/去重/冷却/优雅退出
└── watcher.test.ts
src/cli/index.ts                   # 子命令化
scripts/dev-jellyfin.sh            # OrbStack 开发环境一键起（Task 1 产出）
```

---

### Task 1（Controller 执行，不派子代理）: OrbStack Jellyfin 环境 + 真实响应录制

**Files:**
- Create: `scripts/dev-jellyfin.sh`, `fixtures/jellyfin/*.json`

- [ ] **Step 1: 生成 fixture 媒体**

```bash
mkdir -p /tmp/scout-media/movies/"The Matrix (1999)"
ffmpeg -f lavfi -i color=black:s=640x360:d=30 -f lavfi -i anullsrc -c:v libx264 -t 30 -pix_fmt yuv420p -c:a aac -shortest \
  "/tmp/scout-media/movies/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264.mkv"
```

- [ ] **Step 2: 起 Jellyfin 容器**

```bash
docker run -d --name scout-jellyfin -p 8096:8096 \
  -v /tmp/scout-jellyfin-config:/config \
  -v /tmp/scout-media:/media \
  jellyfin/jellyfin:latest
```

- [ ] **Step 3: 完成初始化向导 + 建库 + 拿 API key**

通过 Startup API 或浏览器完成：管理员用户、媒体库 Movies 指向 /media/movies、
生成 API key（Dashboard → API Keys 或 POST /Auth/Keys）。把 `JELLYFIN_URL=http://localhost:8096`
和 `JELLYFIN_API_KEY` 追加进本地 `.env`（gitignored）。

- [ ] **Step 4: 录制真实响应**

浏览器里播放那部假电影，期间：

```bash
source .env
curl -s "http://localhost:8096/Sessions" -H "X-Emby-Token: $JELLYFIN_API_KEY" \
  | python3 -m json.tool > fixtures/jellyfin/sessions-playing.json
# 从 sessions 里取 NowPlayingItem.Id，再：
curl -s "http://localhost:8096/Items?ids=<ITEMID>&fields=Path,ProviderIds,MediaStreams,OriginalTitle" \
  -H "X-Emby-Token: $JELLYFIN_API_KEY" | python3 -m json.tool > fixtures/jellyfin/items-detail.json
```

同时录一份停止播放后的 sessions（空 NowPlayingItem 场景）到 `sessions-idle.json`。
手动放一个字幕文件到电影目录、POST refresh、再录 item → `item-after-refresh.json`
（验证 MediaStreams 出现外挂字幕流的真实形状），录完删掉该字幕还原。

- [ ] **Step 5: 固化 dev 脚本 + 提交**

`scripts/dev-jellyfin.sh` 写入上面 Step 1-2 的可重复版本（存在即跳过）。脱敏检查
fixtures（无 API key 泄漏；Jellyfin 响应里通常无 token，确认后提交）：

```bash
git add scripts/dev-jellyfin.sh fixtures/jellyfin/ && git commit -m "chore: jellyfin dev env script and recorded API fixtures"
```

---

### Task 2: JellyfinClient（src/adapters/players/jellyfin.ts）

**Files:**
- Create: `src/adapters/players/jellyfin.ts`, `src/adapters/players/jellyfin.test.ts`

- [ ] **Step 1: 写失败测试** `src/adapters/players/jellyfin.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { JellyfinClient, JellyfinSessionsSchema, JellyfinItemsResponseSchema } from './jellyfin.js'

const sessionsFixture = readFileSync('fixtures/jellyfin/sessions-playing.json', 'utf8')
const idleFixture = readFileSync('fixtures/jellyfin/sessions-idle.json', 'utf8')
const itemsFixture = readFileSync('fixtures/jellyfin/items-detail.json', 'utf8')

function makeClient(responses: string[]) {
  let i = 0
  const fetchImpl = vi.fn(async () => new Response(responses[Math.min(i++, responses.length - 1)]))
  return { client: new JellyfinClient({ baseUrl: 'http://jf:8096', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl }
}

describe('schemas ground truth', () => {
  it('parses recorded playing sessions', () => {
    const sessions = JellyfinSessionsSchema.parse(JSON.parse(sessionsFixture))
    const playing = sessions.filter(s => s.NowPlayingItem)
    expect(playing.length).toBeGreaterThan(0)
    expect(playing[0].NowPlayingItem!.Name).toBeTruthy()
  })
  it('parses recorded idle sessions (no NowPlayingItem)', () => {
    const sessions = JellyfinSessionsSchema.parse(JSON.parse(idleFixture))
    expect(Array.isArray(sessions)).toBe(true)
  })
  it('parses recorded item detail with Path and MediaStreams', () => {
    const r = JellyfinItemsResponseSchema.parse(JSON.parse(itemsFixture))
    expect(r.Items[0].Path).toBeTruthy()
    expect(Array.isArray(r.Items[0].MediaStreams)).toBe(true)
  })
})

describe('JellyfinClient', () => {
  it('getSessions sends token header and parses', async () => {
    const { client, fetchImpl } = makeClient([sessionsFixture])
    const sessions = await client.getSessions()
    expect(sessions.length).toBeGreaterThan(0)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('http://jf:8096/Sessions')
    expect((init.headers as Record<string, string>)['X-Emby-Token']).toBe('k')
  })
  it('getItem fetches by id with fields', async () => {
    const { client, fetchImpl } = makeClient([itemsFixture])
    const item = await client.getItem('anyid')
    expect(item.Path).toBeTruthy()
    expect(String(fetchImpl.mock.calls[0][0])).toContain('ids=anyid')
  })
  it('getItem throws when item not found', async () => {
    const { client } = makeClient([JSON.stringify({ Items: [], TotalRecordCount: 0 })])
    await expect(client.getItem('nope')).rejects.toThrow(/not found/i)
  })
  it('refreshItem POSTs to /Items/{id}/Refresh', async () => {
    const { client, fetchImpl } = makeClient([''])
    await client.refreshItem('abc')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/Items/abc/Refresh')
    expect(init.method).toBe('POST')
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/adapters/players/jellyfin.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/adapters/players/jellyfin.ts`

```ts
import { z } from 'zod'

// 实录 ground truth：fixtures/jellyfin/。字段形状与录制冲突时以录制为准。
export const JellyfinMediaStreamSchema = z.object({
  Type: z.string(),
  Language: z.string().nullish(),
  Codec: z.string().nullish(),
  IsExternal: z.boolean().nullish(),
  DisplayTitle: z.string().nullish(),
  Index: z.number().nullish(),
}).loose()
export type JellyfinMediaStream = z.infer<typeof JellyfinMediaStreamSchema>

export const JellyfinItemSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  OriginalTitle: z.string().nullish(),
  Type: z.string(),
  Path: z.string().nullish(),
  ProductionYear: z.number().nullish(),
  RunTimeTicks: z.number().nullish(),
  ProviderIds: z.record(z.string(), z.string()).nullish(),
  SeriesName: z.string().nullish(),
  ParentIndexNumber: z.number().nullish(),
  IndexNumber: z.number().nullish(),
  MediaStreams: z.array(JellyfinMediaStreamSchema).nullish(),
  ProductionLocations: z.array(z.string()).nullish(),
}).loose()
export type JellyfinItem = z.infer<typeof JellyfinItemSchema>

export const JellyfinSessionSchema = z.object({
  Id: z.string(),
  UserName: z.string().nullish(),
  NowPlayingItem: JellyfinItemSchema.nullish(),
}).loose()
export const JellyfinSessionsSchema = z.array(JellyfinSessionSchema)
export type JellyfinSession = z.infer<typeof JellyfinSessionSchema>

export const JellyfinItemsResponseSchema = z.object({
  Items: z.array(JellyfinItemSchema).default([]),
  TotalRecordCount: z.number().nullish(),
}).loose()

export interface JellyfinClientOpts {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  onApiCall?: (r: { endpoint: string; params: Record<string, unknown>; status: number | null; durationMs: number; error?: string }) => void
}

const ITEM_FIELDS = 'Path,ProviderIds,MediaStreams,OriginalTitle,ProductionLocations'

export class JellyfinClient {
  private fetchImpl: typeof fetch
  constructor(private opts: JellyfinClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async call(method: 'GET' | 'POST', path: string): Promise<unknown> {
    const t0 = Date.now()
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
        method,
        headers: { 'X-Emby-Token': this.opts.apiKey },
      })
      this.opts.onApiCall?.({ endpoint: path, params: {}, status: res.status, durationMs: Date.now() - t0 })
      if (!res.ok) throw new Error(`jellyfin ${method} ${path}: HTTP ${res.status}`)
      const text = await res.text()
      return text ? JSON.parse(text) : null
    } catch (e) {
      this.opts.onApiCall?.({ endpoint: path, params: {}, status: null, durationMs: Date.now() - t0, error: String(e) })
      throw e
    }
  }

  async getSessions(): Promise<JellyfinSession[]> {
    return JellyfinSessionsSchema.parse(await this.call('GET', '/Sessions'))
  }

  async getItem(itemId: string): Promise<JellyfinItem> {
    const raw = await this.call('GET', `/Items?ids=${encodeURIComponent(itemId)}&fields=${ITEM_FIELDS}`)
    const r = JellyfinItemsResponseSchema.parse(raw)
    const item = r.Items[0]
    if (!item) throw new Error(`jellyfin item not found: ${itemId}`)
    return item
  }

  async refreshItem(itemId: string): Promise<void> {
    await this.call('POST', `/Items/${encodeURIComponent(itemId)}/Refresh`)
  }
}
```

zod v4 透传注意：本仓库现用 `.passthrough()`（见 src/core/schemas.ts）——若 `.loose()` 不存在按仓库先例改，语义不变。

- [ ] **Step 4: 确认通过 + 全量回归** — `npm run check && npm test` — 全绿。
- [ ] **Step 5: 提交**

```bash
git add src/adapters/players/
git commit -m "feat: jellyfin client with recorded-fixture schemas"
```

---

### Task 3: MediaContext 构造（src/core/mediaContext.ts）

**Files:**
- Create: `src/core/mediaContext.ts`, `src/core/mediaContext.test.ts`

- [ ] **Step 1: 写失败测试** `src/core/mediaContext.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildMediaContext, parsePathMappings } from './mediaContext.js'
import { JellyfinItemsResponseSchema } from '../adapters/players/jellyfin.js'

const item = JellyfinItemsResponseSchema.parse(
  JSON.parse(readFileSync('fixtures/jellyfin/items-detail.json', 'utf8')),
).Items[0]

describe('parsePathMappings', () => {
  it('parses comma-separated pairs', () => {
    expect(parsePathMappings('/media=/mnt/nas,/tv=/mnt/tv')).toEqual([
      { from: '/media', to: '/mnt/nas' }, { from: '/tv', to: '/mnt/tv' },
    ])
  })
  it('empty/undefined → identity (empty list)', () => {
    expect(parsePathMappings(undefined)).toEqual([])
    expect(parsePathMappings('')).toEqual([])
  })
})

describe('buildMediaContext', () => {
  it('maps a recorded movie item to a valid MediaContext', () => {
    const ctx = buildMediaContext(item, [])
    expect(ctx.media.title).toBe(item.Name)
    expect(ctx.media.type).toBe('movie')
    expect(ctx.media.path).toBe(item.Path)
    expect(ctx.media.filename).toBe(item.Path!.split('/').pop())
    expect(ctx.trigger).toBe('playback_start')
    expect(ctx.request_id).toContain(item.Id)
  })
  it('applies path mapping by longest prefix', () => {
    const ctx = buildMediaContext(item, [{ from: '/media', to: '/mnt/nas_media' }])
    expect(ctx.media.path.startsWith('/mnt/nas_media')).toBe(true)
  })
  it('maps episode fields', () => {
    const ep = { ...item, Type: 'Episode', SeriesName: 'Severance', ParentIndexNumber: 2, IndexNumber: 3 }
    const ctx = buildMediaContext(ep, [])
    expect(ctx.media.type).toBe('episode')
    expect(ctx.media.season).toBe(2)
    expect(ctx.media.episode).toBe(3)
    expect(ctx.media.title).toBe('Severance') // 剧集用剧名做主标题，集名放不进 schema 就丢弃
  })
  it('lowercases provider id keys and converts runtime ticks', () => {
    const withIds = { ...item, ProviderIds: { Imdb: 'tt0133093', Tmdb: '603' }, RunTimeTicks: 81_600_000_000 }
    const ctx = buildMediaContext(withIds, [])
    expect(ctx.media.provider_ids).toEqual({ imdb: 'tt0133093', tmdb: '603' })
    expect(ctx.media.runtime_minutes).toBe(136)
  })
  it('collects existing subtitle streams', () => {
    const withSub = { ...item, MediaStreams: [
      { Type: 'Subtitle', Language: 'eng', Codec: 'subrip', IsExternal: true },
      { Type: 'Audio', Language: 'eng', Codec: 'aac' },
    ] }
    const ctx = buildMediaContext(withSub, [])
    expect(ctx.media.existing_subtitles).toEqual([{ language: 'eng', format: 'subrip', source: 'external' }])
  })
  it('throws on item without Path', () => {
    expect(() => buildMediaContext({ ...item, Path: null }, [])).toThrow(/path/i)
  })
})
```

- [ ] **Step 2: 确认失败**。 **Step 3: 实现** `src/core/mediaContext.ts`

```ts
import { basename, dirname } from 'node:path'
import { MediaContextSchema, type MediaContext } from './schemas.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'

export interface PathMapping { from: string; to: string }

export function parsePathMappings(raw: string | undefined): PathMapping[] {
  if (!raw) return []
  return raw.split(',').filter(Boolean).map(pair => {
    const [from, to] = pair.split('=')
    if (!from || !to) throw new Error(`invalid MEDIA_PATH_MAPPINGS pair: ${pair}`)
    return { from, to }
  })
}

export function mapPath(path: string, mappings: PathMapping[]): string {
  // 最长前缀优先，避免 /media 抢了 /media2 的活
  const hit = [...mappings].sort((a, b) => b.from.length - a.from.length)
    .find(m => path.startsWith(m.from))
  return hit ? hit.to + path.slice(hit.from.length) : path
}

const TICKS_PER_MINUTE = 600_000_000

export function buildMediaContext(item: JellyfinItem, mappings: PathMapping[]): MediaContext {
  if (!item.Path) throw new Error(`jellyfin item ${item.Id} has no Path`)
  const path = mapPath(item.Path, mappings)
  const isEpisode = item.Type === 'Episode'
  return MediaContextSchema.parse({
    request_id: `jf-${item.Id}-${Date.now()}`,
    trigger: 'playback_start',
    media: {
      type: isEpisode ? 'episode' : 'movie',
      path,
      filename: basename(path),
      title: isEpisode ? (item.SeriesName ?? item.Name) : item.Name,
      original_title: item.OriginalTitle ?? null,
      year: item.ProductionYear ?? null,
      season: item.ParentIndexNumber ?? null,
      episode: item.IndexNumber ?? null,
      runtime_minutes: item.RunTimeTicks ? Math.round(item.RunTimeTicks / TICKS_PER_MINUTE) : null,
      provider_ids: Object.fromEntries(
        Object.entries(item.ProviderIds ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      production_locations: item.ProductionLocations ?? [],
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

export function mediaDir(ctx: MediaContext): string {
  return dirname(ctx.media.path)
}
```

注意：`preferences: {}` 依赖 MediaContextSchema 的字段级 default——若 zod 要求
preferences 对象内字段全给，检查 schema（各字段均有 .default，空对象应可 parse）；
若不行，改为显式传默认值，语义不变。

- [ ] **Step 4: 通过 + 回归**。 **Step 5: 提交**

```bash
git add src/core/mediaContext.ts src/core/mediaContext.test.ts
git commit -m "feat: jellyfin item to MediaContext mapping with path mappings"
```

---

### Task 4: 触发条件（src/daemon/triggers.ts）

**Files:**
- Create: `src/daemon/triggers.ts`, `src/daemon/triggers.test.ts`

- [ ] **Step 1: 写失败测试** `src/daemon/triggers.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { needsChineseSubtitle, isTriggerableType, CHINESE_LANG_TAGS } from './triggers.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'

const base = { Id: 'x', Name: 'M', Type: 'Movie', Path: '/m/x.mkv' } as JellyfinItem
const sub = (lang: string, codec = 'subrip', ext = true) =>
  ({ Type: 'Subtitle', Language: lang, Codec: codec, IsExternal: ext })

describe('isTriggerableType', () => {
  it('movie/episode yes, others no', () => {
    expect(isTriggerableType('Movie')).toBe(true)
    expect(isTriggerableType('Episode')).toBe(true)
    expect(isTriggerableType('Audio')).toBe(false)
    expect(isTriggerableType('Trailer')).toBe(false)
  })
})

describe('needsChineseSubtitle', () => {
  it('true when no subtitle streams at all', () => {
    expect(needsChineseSubtitle({ ...base, MediaStreams: [] }, true)).toBe(true)
  })
  it('false when chi text subtitle exists', () => {
    for (const lang of ['chi', 'zho', 'chs', 'zh-Hans', 'zh']) {
      expect(needsChineseSubtitle({ ...base, MediaStreams: [sub(lang)] }, true)).toBe(false)
    }
  })
  it('true when only non-Chinese subs exist', () => {
    expect(needsChineseSubtitle({ ...base, MediaStreams: [sub('eng'), sub('jpn')] }, true)).toBe(true)
  })
  it('PGS Chinese counts as missing when treatPgsAsMissing', () => {
    const pgs = { Type: 'Subtitle', Language: 'chi', Codec: 'PGSSUB', IsExternal: false }
    expect(needsChineseSubtitle({ ...base, MediaStreams: [pgs] }, true)).toBe(true)
    expect(needsChineseSubtitle({ ...base, MediaStreams: [pgs] }, false)).toBe(false)
  })
  it('undefined language does not count as Chinese', () => {
    expect(needsChineseSubtitle({ ...base, MediaStreams: [sub(undefined as never)] }, true)).toBe(true)
  })
})
```

- [ ] **Step 2: 确认失败**。 **Step 3: 实现** `src/daemon/triggers.ts`

```ts
import type { JellyfinItem } from '../adapters/players/jellyfin.js'

export const CHINESE_LANG_TAGS = /^(chi|zho|chs|cht|zh)([-_].*)?$/i
const IMAGE_SUB_CODECS = /pgs|vobsub|dvdsub|dvbsub/i

export function isTriggerableType(type: string): boolean {
  return type === 'Movie' || type === 'Episode'
}

/** 判断是否缺可用中文字幕。treatPgsAsMissing=true 时图形字幕不算数。 */
export function needsChineseSubtitle(item: JellyfinItem, treatPgsAsMissing: boolean): boolean {
  const subs = (item.MediaStreams ?? []).filter(s => s.Type === 'Subtitle')
  const chinese = subs.filter(s => s.Language && CHINESE_LANG_TAGS.test(s.Language))
  const usable = treatPgsAsMissing
    ? chinese.filter(s => !s.Codec || !IMAGE_SUB_CODECS.test(s.Codec))
    : chinese
  return usable.length === 0
}
```

- [ ] **Step 4: 通过 + 回归**。 **Step 5: 提交**

```bash
git add src/daemon/triggers.ts src/daemon/triggers.test.ts
git commit -m "feat: playback trigger conditions (type + missing-chinese-subtitle)"
```

---

### Task 5: runPipeline 增加 journalDir（唯一 M1 改动）

**Files:**
- Modify: `src/core/pipeline.ts`
- Test: `src/core/pipeline.test.ts`（追加）

- [ ] **Step 1: 追加失败测试到** `src/core/pipeline.test.ts`

```ts
  it('writes decision.json to journalDir when provided, subtitle to outDir', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const journalDir = mkdtempSync(join(tmpdir(), 'jr-'))
    const deps = makeDeps()
    const result = await runPipeline(deps, ctx, outDir, journalDir)
    expect(result.decision).toBe('download')
    expect(existsSync(join(journalDir, 'decision.json'))).toBe(true)
    expect(existsSync(join(outDir, 'decision.json'))).toBe(false)
    expect(result.subtitlePath!.startsWith(outDir)).toBe(true)
  })
```

- [ ] **Step 2: 确认失败**。 **Step 3: 实现**

`src/core/pipeline.ts`：签名 `runPipeline(deps, ctx, outDir)` → `runPipeline(deps, ctx, outDir, journalDir: string = outDir)`；`finish` 内 `journal.finish(..., outDir)` → `journal.finish(..., journalDir)`。其他一律不动。

- [ ] **Step 4: 通过 + 回归（80 测试）**。 **Step 5: 提交**

```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts
git commit -m "feat: optional journalDir keeps decision.json out of media folders"
```

---

### Task 6: Watcher（src/daemon/watcher.ts）

**Files:**
- Create: `src/daemon/watcher.ts`, `src/daemon/watcher.test.ts`

- [ ] **Step 1: 写失败测试** `src/daemon/watcher.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Watcher, type WatcherDeps } from './watcher.js'
import { JellyfinSessionsSchema, JellyfinItemsResponseSchema } from '../adapters/players/jellyfin.js'

const sessions = JellyfinSessionsSchema.parse(JSON.parse(readFileSync('fixtures/jellyfin/sessions-playing.json', 'utf8')))
const item = JellyfinItemsResponseSchema.parse(JSON.parse(readFileSync('fixtures/jellyfin/items-detail.json', 'utf8'))).Items[0]
// 保证测试确定性：让 fixture item 不含中文字幕流
const cleanItem = { ...item, MediaStreams: (item.MediaStreams ?? []).filter(s => s.Type !== 'Subtitle') }

function makeDeps(over: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    jellyfin: {
      getSessions: vi.fn(async () => sessions),
      getItem: vi.fn(async () => cleanItem),
      refreshItem: vi.fn(async () => {}),
    },
    runJob: vi.fn(async () => ({ decision: 'download' as const, subtitlePath: '/m/x.zh-Hans.ass', journalPath: '/j/decision.json' })),
    verify: vi.fn(async () => true),
    pathMappings: [],
    treatPgsAsMissing: true,
    cooldownMinutes: 30,
    log: () => {},
    ...over,
  }
}

describe('Watcher.tick', () => {
  it('triggers a job for a playing item without Chinese subs', async () => {
    const deps = makeDeps()
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.jellyfin.getItem).toHaveBeenCalled()
    expect(deps.runJob).toHaveBeenCalledTimes(1)
    expect(deps.jellyfin.refreshItem).toHaveBeenCalled()
    expect(deps.verify).toHaveBeenCalled()
  })

  it('skips items already in cooldown after processing', async () => {
    const deps = makeDeps()
    const w = new Watcher(deps)
    await w.tick()
    await w.tick()
    expect(deps.runJob).toHaveBeenCalledTimes(1) // 冷却期内不重复
  })

  it('skips when item already has Chinese subtitle', async () => {
    const withZh = { ...cleanItem, MediaStreams: [{ Type: 'Subtitle', Language: 'chi', Codec: 'subrip', IsExternal: true }] }
    const deps = makeDeps({ jellyfin: { getSessions: vi.fn(async () => sessions), getItem: vi.fn(async () => withZh), refreshItem: vi.fn(async () => {}) } })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).not.toHaveBeenCalled()
  })

  it('dedupes concurrent processing of the same item (in-flight)', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const runJob = vi.fn(async () => { await gate; return { decision: 'download' as const, journalPath: 'j' } })
    const deps = makeDeps({ runJob })
    const w = new Watcher(deps)
    const t1 = w.tick()
    const t2 = w.tick() // 第一次还没完成
    release()
    await Promise.all([t1, t2])
    expect(runJob).toHaveBeenCalledTimes(1)
  })

  it('does not refresh when job decides no_safe_match', async () => {
    const deps = makeDeps({ runJob: vi.fn(async () => ({ decision: 'no_safe_match' as const, journalPath: 'j' })) })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.jellyfin.refreshItem).not.toHaveBeenCalled()
  })

  it('a failing job does not poison future ticks for other items', async () => {
    const deps = makeDeps({ runJob: vi.fn(async () => { throw new Error('boom') }) })
    const w = new Watcher(deps)
    await expect(w.tick()).resolves.toBeUndefined() // 不抛出
  })
})
```

- [ ] **Step 2: 确认失败**。 **Step 3: 实现** `src/daemon/watcher.ts`

```ts
import type { JellyfinItem, JellyfinSession } from '../adapters/players/jellyfin.js'
import { buildMediaContext, mediaDir, type PathMapping } from '../core/mediaContext.js'
import { isTriggerableType, needsChineseSubtitle } from './triggers.js'
import type { MediaContext } from '../core/schemas.js'

export interface WatcherJobResult {
  decision: string
  subtitlePath?: string
  journalPath: string
}

export interface WatcherDeps {
  jellyfin: {
    getSessions: () => Promise<JellyfinSession[]>
    getItem: (id: string) => Promise<JellyfinItem>
    refreshItem: (id: string) => Promise<void>
  }
  /** 跑一次流水线：调用方（CLI）负责组装 runPipeline 及 journalDir */
  runJob: (ctx: MediaContext, outDir: string, itemId: string) => Promise<WatcherJobResult>
  /** refresh 后验证中文字幕流出现（带内部轮询重试） */
  verify: (itemId: string) => Promise<boolean>
  pathMappings: PathMapping[]
  treatPgsAsMissing: boolean
  cooldownMinutes: number
  log: (msg: string) => void
}

export class Watcher {
  private inFlight = new Set<string>()
  private cooldownUntil = new Map<string, number>()

  constructor(private deps: WatcherDeps) {}

  async tick(): Promise<void> {
    let sessions: JellyfinSession[]
    try {
      sessions = await this.deps.jellyfin.getSessions()
    } catch (e) {
      this.deps.log(`sessions poll failed: ${String(e)}`)
      return
    }
    const nowPlaying = sessions.map(s => s.NowPlayingItem).filter((i): i is JellyfinItem => !!i)
    await Promise.all(nowPlaying.map(i => this.maybeProcess(i.Id)))
  }

  private async maybeProcess(itemId: string): Promise<void> {
    if (this.inFlight.has(itemId)) return
    const until = this.cooldownUntil.get(itemId)
    if (until && Date.now() < until) return
    this.inFlight.add(itemId)
    try {
      const item = await this.deps.jellyfin.getItem(itemId)
      if (!isTriggerableType(item.Type)) return
      if (!needsChineseSubtitle(item, this.deps.treatPgsAsMissing)) return

      const ctx = buildMediaContext(item, this.deps.pathMappings)
      this.deps.log(`processing ${item.Name} (${itemId})`)
      const result = await this.deps.runJob(ctx, mediaDir(ctx), itemId)
      this.deps.log(`${item.Name}: ${result.decision}`)

      if (result.decision === 'download') {
        await this.deps.jellyfin.refreshItem(itemId)
        const visible = await this.deps.verify(itemId)
        this.deps.log(`${item.Name}: subtitle ${visible ? 'visible in jellyfin' : 'NOT visible yet'}`)
      }
    } catch (e) {
      this.deps.log(`item ${itemId} failed: ${String(e)}`)
    } finally {
      this.inFlight.delete(itemId)
      this.cooldownUntil.set(itemId, Date.now() + this.deps.cooldownMinutes * 60_000)
    }
  }

  /** 供优雅退出：还有任务在跑吗 */
  busy(): boolean { return this.inFlight.size > 0 }
}
```

- [ ] **Step 4: 通过 + 回归**。 **Step 5: 提交**

```bash
git add src/daemon/
git commit -m "feat: session-polling watcher with in-flight dedup and cooldown"
```

---

### Task 7: CLI 子命令化（run / run-item / watch）

**Files:**
- Modify: `src/cli/index.ts`

- [ ] **Step 1: 重构** `src/cli/index.ts`

保持现有 `run` 行为逐字不变，抽出公共组装，新增两个子命令。完整结构：

```ts
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MediaContextSchema, type MediaContext } from '../core/schemas.js'
import { runPipeline, type PipelineDeps, type PipelineResult } from '../core/pipeline.js'
import type { Journal } from '../core/journal.js'
import { DecisionCache } from '../core/cache.js'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { downloadDirect } from '../adapters/download/direct.js'
import { createLlmRuntime } from '../agent/runtime.js'
import { ProfileStore } from '../agent/profile.js'
import { identifyMedia } from '../agent/identifyMedia.js'
import { planSearch } from '../agent/planSearch.js'
import { rankCandidates } from '../agent/rankCandidates.js'
import { JellyfinClient } from '../adapters/players/jellyfin.js'
import { parsePathMappings } from '../core/mediaContext.js'
import { buildMediaContext, mediaDir } from '../core/mediaContext.js'
import { Watcher } from '../daemon/watcher.js'
import { CHINESE_LANG_TAGS } from '../daemon/triggers.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`missing required env var: ${name}`); process.exit(2) }
  return v
}

interface Assembled {
  deps: (journalHook?: (j: Journal) => void) => PipelineDeps
  cacheRoot: string
}

async function assemble(): Promise<Assembled> {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  let extraBody: Record<string, unknown> | undefined
  if (process.env.LLM_EXTRA_BODY) {
    try { extraBody = JSON.parse(process.env.LLM_EXTRA_BODY) } catch {
      console.error(`LLM_EXTRA_BODY is not valid JSON: ${process.env.LLM_EXTRA_BODY}`)
      process.exit(2)
    }
  }
  const profileStore = new ProfileStore(join(cacheRoot, 'llm-profiles'))
  let journalRef: Journal | null = null
  const llm = await createLlmRuntime({
    baseUrl: requireEnv('LLM_BASE_URL'),
    apiKey: requireEnv('LLM_API_KEY'),
    model: requireEnv('LLM_MODEL'),
    extraBody,
  }, profileStore, undefined, info => journalRef?.step('llm_profile_healed', info))
  const assrt = new AssrtClient({
    token: requireEnv('ASSRT_TOKEN'),
    cacheDir: join(cacheRoot, 'assrt-responses'),
    onApiCall: r => journalRef?.apiCall(r),
  })
  const deps = (journalHook?: (j: Journal) => void): PipelineDeps => ({
    journalReady: j => { journalRef = j; j.step('llm_profile', llm.profileInfo()); journalHook?.(j) },
    identify: c => identifyMedia(llm, c),
    plan: (c, id) => planSearch(llm, c, id),
    rank: (c, id, cands) => rankCandidates(llm, c, id, cands),
    assrt: { search: q => assrt.search(q), detail: id => assrt.detail(id) },
    download: url => downloadDirect(url),
    cache: new DecisionCache(join(cacheRoot, 'decisions')),
    maxApiCallsPerJob: 4,
  })
  return { deps, cacheRoot }
}

function applyConfidenceOverride(ctx: MediaContext) {
  if (process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE) {
    const v = Number(process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE)
    if (Number.isFinite(v) && v >= 0 && v <= 1) ctx.preferences.auto_download_min_confidence = v
    else console.error(`ignoring invalid AUTO_DOWNLOAD_MIN_CONFIDENCE: ${process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE}`)
  }
}

function exitCodeFor(decision: PipelineResult['decision']): number {
  if (decision === 'download' || decision === 'already_exists') return 0
  if (decision === 'error') return 2
  return 1
}

function makeJellyfin(): JellyfinClient {
  return new JellyfinClient({ baseUrl: requireEnv('JELLYFIN_URL'), apiKey: requireEnv('JELLYFIN_API_KEY') })
}

async function verifyChineseSubtitle(jf: JellyfinClient, itemId: string): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    const item = await jf.getItem(itemId)
    const found = (item.MediaStreams ?? []).some(s =>
      s.Type === 'Subtitle' && s.IsExternal && s.Language && CHINESE_LANG_TAGS.test(s.Language))
    if (found) return true
    await new Promise(r => setTimeout(r, 10_000))
  }
  return false
}

async function cmdRun(contextPath: string, outDir: string) {
  const ctx = MediaContextSchema.parse(JSON.parse(readFileSync(contextPath, 'utf8')))
  applyConfidenceOverride(ctx)
  const { deps } = await assemble()
  const result = await runPipeline(deps(), ctx, outDir)
  console.log(JSON.stringify({ decision: result.decision, subtitle: result.subtitlePath ?? null, journal: result.journalPath, fromCache: result.fromCache ?? false }, null, 2))
  process.exit(exitCodeFor(result.decision))
}

async function cmdRunItem(itemId: string) {
  const { deps, cacheRoot } = await assemble()
  const jf = makeJellyfin()
  const mappings = parsePathMappings(process.env.MEDIA_PATH_MAPPINGS)
  const item = await jf.getItem(itemId)
  const ctx = buildMediaContext(item, mappings)
  applyConfidenceOverride(ctx)
  const journalDir = join(cacheRoot, 'journals', `${itemId}-${Date.now()}`)
  const result = await runPipeline(deps(), ctx, mediaDir(ctx), journalDir)
  if (result.decision === 'download') {
    await jf.refreshItem(itemId)
    const visible = await verifyChineseSubtitle(jf, itemId)
    console.log(JSON.stringify({ decision: result.decision, subtitle: result.subtitlePath, visibleInJellyfin: visible, journal: result.journalPath }, null, 2))
  } else {
    console.log(JSON.stringify({ decision: result.decision, journal: result.journalPath }, null, 2))
  }
  process.exit(exitCodeFor(result.decision))
}

async function cmdWatch() {
  const { deps, cacheRoot } = await assemble()
  const jf = makeJellyfin()
  const mappings = parsePathMappings(process.env.MEDIA_PATH_MAPPINGS)
  const pollSeconds = Number(process.env.POLL_INTERVAL_SECONDS) || 15
  const watcher = new Watcher({
    jellyfin: {
      getSessions: () => jf.getSessions(),
      getItem: id => jf.getItem(id),
      refreshItem: id => jf.refreshItem(id),
    },
    runJob: async (ctx, outDir, itemId) => {
      applyConfidenceOverride(ctx)
      const journalDir = join(cacheRoot, 'journals', `${itemId}-${Date.now()}`)
      return runPipeline(deps(), ctx, outDir, journalDir)
    },
    verify: id => verifyChineseSubtitle(jf, id),
    pathMappings: mappings,
    treatPgsAsMissing: (process.env.TREAT_PGS_AS_MISSING ?? 'true') !== 'false',
    cooldownMinutes: Number(process.env.ITEM_COOLDOWN_MINUTES) || 30,
    log: msg => console.log(`[watch ${new Date().toISOString()}] ${msg}`),
  })
  console.log(`subtitle-scout watching ${process.env.JELLYFIN_URL} every ${pollSeconds}s`)
  let stopping = false
  const stop = async () => {
    if (stopping) process.exit(1)
    stopping = true
    console.log('shutting down after in-flight jobs...')
    while (watcher.busy()) await new Promise(r => setTimeout(r, 500))
    process.exit(0)
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  for (;;) {
    if (!stopping) await watcher.tick()
    await new Promise(r => setTimeout(r, pollSeconds * 1000))
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      context: { type: 'string' },
      out: { type: 'string', default: './output' },
      'item-id': { type: 'string' },
    },
  })
  const cmd = positionals[0]
  if (cmd === 'run' && values.context) return cmdRun(values.context, values.out!)
  if (cmd === 'run-item' && values['item-id']) return cmdRunItem(values['item-id'])
  if (cmd === 'watch') return cmdWatch()
  console.error('usage: subtitle-scout run --context <json> [--out <dir>] | run-item --item-id <id> | watch')
  process.exit(2)
}

main().catch(e => { console.error(e); process.exit(2) })
```

注意：journalRef 在 assemble 闭包里对多 job 并发是共享的——watch 模式下并发 job 的
apiCall 记录可能串 journal。v1 可接受（journal 主体仍正确），在代码处加一行注释说明；
Milestone 3 若做并发队列再治。

- [ ] **Step 2: 验证**

`npm run check && npm test` 全绿；`npx tsx src/cli/index.ts 2>&1; echo exit=$?` → usage + exit=2；
`npx tsx src/cli/index.ts run --context fixtures/contexts/matrix.json --out $(mktemp -d)`（.env 齐全时）
行为与 M1.5 一致。

- [ ] **Step 3: 提交**

```bash
git add src/cli/index.ts
git commit -m "feat: cli subcommands run/run-item/watch with jellyfin wiring"
```

---

### Task 8（Controller 执行）: 阶段 A 真实端到端 + 文档 + 终审

- [ ] **Step 1: 真实 e2e**

OrbStack Jellyfin 里浏览器播放假《黑客帝国》→ `npx tsx src/cli/index.ts watch` →
观察：触发 → ASSRT 真下载 → 字幕出现在 `/tmp/scout-media/movies/The Matrix (1999)/`
且命名 `The.Matrix.1999.1080p.BluRay.x264.zh-Hans.ass` → refresh → verify 通过 →
journal 落在 cacheRoot/journals/。记录：播放中的 web 客户端能否立刻选到新字幕（实测行为，
写入下方文档）。再验证 run-item 单发与冷却去重（同 item 二次播放 30 分钟内不重复触发）。

- [ ] **Step 2: 文档**

README：新增 watch 模式 quick start（compose 形态预告）、JELLYFIN_* 环境变量表、
客户端刷新行为实测记录。.env.example 追加 JELLYFIN_URL/JELLYFIN_API_KEY/
MEDIA_PATH_MAPPINGS/POLL_INTERVAL_SECONDS/ITEM_COOLDOWN_MINUTES/TREAT_PGS_AS_MISSING。

- [ ] **Step 3: 终审 + 合并**

沿用惯例：opus 终审整个分支（重点：watcher 并发正确性、路径映射安全、
verifyChineseSubtitle 的轮询上限、CLI 三命令行为隔离）→ 修复 → 复核 → 合并 main。

---

## Self-Review 结果（已执行）

- **Spec 覆盖**：轮询 Sessions(T6/T7)、触发五条件（类型 T4、缺中文 T4、负缓存=pipeline 内建、
  in-flight T6、冷却 T6）、JellyfinClient 四方法(T2)、MediaContext 映射含路径/季集/PGS(T3/T4)、
  journalDir(T5)、三子命令+优雅退出(T7)、fixture 录制(T1)、真实 e2e+客户端行为记录(T8)、
  验证轮询 6×10s(T7 verifyChineseSubtitle)。
- **占位符扫描**：无 TBD；T1/T8 为 controller 的探索性步骤，命令均已给出。
- **类型一致性**：JellyfinItem/JellyfinSession(T2) ↔ T3/T4/T6 引用一致；WatcherDeps.runJob
  返回形状与 PipelineResult 兼容（decision/subtitlePath/journalPath）；CHINESE_LANG_TAGS
  在 T4 定义、T7 复用。
