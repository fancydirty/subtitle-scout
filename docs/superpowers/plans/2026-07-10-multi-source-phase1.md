# Multi-Source Phase 1 Implementation Plan (Provider Abstraction + subtitle-fetch CLI + OpenSubtitles + Mock Library)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **IRON LAW:** every implementer subagent works in an ISOLATED git worktree (`git worktree add`). Tasks are strictly sequential — task N+1 starts from the merged result of task N. Never run two implementers against the same working directory.

**Goal:** Break the ASSRT monopoly: provider-neutral `SubtitleCandidate` flows through the whole pipeline, ALL provider access goes through a single aggregate CLI (`subtitle-fetch`), OpenSubtitles + ASSRT gems ship as new sources, and a mock media library makes full e2e runnable on OrbStack with zero NAS/router dependency.

**Architecture:** (spec: `docs/design/2026-07-10-multi-source-subtitle-design.md`, Design Decisions 5 & 6) Main pipeline never calls provider adapters in-process — it spawns `subtitle-fetch` (search) and `subtitle-fetch resolve` (download-URL resolution) as subprocesses, reading `SubtitleCandidate[]` JSON from stdout and relaying NDJSON `api_call` events from stderr into the journal. Provider adapters (assrt + assrt-gems + opensubtitles) live inside the CLI behind a registry. Phase 2 will only ADD zimuku/subf2m adapters + the anti-bot sidecar.

**Tech Stack:** Node 22 ESM, TypeScript 6 (run via tsx, no compile step), zod v4, vitest v4 (co-located `*.test.ts`), better-sqlite3, ffmpeg (fixtures only).

**Key existing shapes (read these files before starting):**
- `src/core/schemas.ts` — `AssrtSub` (line ~110), `RankDecisionSchema` (~94), `FinalDecisionSchema` (~147)
- `src/core/pipeline.ts` — `PipelineDeps` (~26), search stage (~155), download stage (~321)
- `src/adapters/providers/assrt.ts` — `AssrtClient` (search/detail/quota), `MinIntervalLimiter`, disk cache
- `src/core/gate.ts`, `src/core/cache.ts`, `src/agent/rankCandidates.ts` — the ASSRT-shaped consumers
- `src/v2/db.ts` migrations array, `src/v2/executor.ts` `makeRunEpisode`
- `.env` already holds working `OPENSUBTITLES_API_KEY` / `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD`

**Live-verified OpenSubtitles facts (do NOT rediscover):** base `https://api.opensubtitles.com/api/v1`; headers `Api-Key` + `User-Agent: subtitlescout v0.2.0` on every request; `languages` param MUST be lowercase (`zh-cn,zh-tw`) and redirects must be followed; `POST /download {file_id}` works WITHOUT user auth in dev_mode, consumes quota, returns `{link, remaining, reset_time_utc}`; the link GET returns a **bare UTF-8 .srt, NOT a zip**; `POST /login` → `{token, base_url, user:{allowed_downloads:20}}`.

---

## Task 1: Neutral candidate types + ASSRT converter (purely additive)

**Files:**
- Modify: `src/core/schemas.ts` (append after `AssrtSub` block)
- Modify: `src/adapters/providers/assrt.ts` (append converter)
- Test: `src/core/schemas.candidate.test.ts` (new), `src/adapters/providers/assrt.toCandidate.test.ts` (new)

- [ ] **Step 1: Write failing tests**

`src/core/schemas.candidate.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { SubtitleCandidateSchema, candidateKey, parseCandidateKey } from './schemas.js'

describe('SubtitleCandidate', () => {
  it('parses a minimal candidate and defaults fileList to []', () => {
    const c = SubtitleCandidateSchema.parse({ provider: 'assrt', providerId: '673114' })
    expect(c.fileList).toEqual([])
    expect(c.videoName ?? null).toBeNull()
  })
  it('rejects unknown providers', () => {
    expect(() => SubtitleCandidateSchema.parse({ provider: 'subhd', providerId: 'x' })).toThrow()
  })
  it('candidateKey/parseCandidateKey roundtrip', () => {
    expect(candidateKey({ provider: 'assrt', providerId: '673114' })).toBe('assrt:673114')
    expect(parseCandidateKey('opensubtitles:7174766')).toEqual({ provider: 'opensubtitles', providerId: '7174766' })
    expect(parseCandidateKey('garbage')).toBeNull()
    expect(parseCandidateKey('subhd:1')).toBeNull()
  })
})
```

`src/adapters/providers/assrt.toCandidate.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { toCandidate } from './assrt.js'
import { AssrtSearchResponseSchema } from '../../core/schemas.js'

describe('toCandidate', () => {
  it('converts a real ASSRT search sub to a neutral candidate', () => {
    const resp = AssrtSearchResponseSchema.parse(
      JSON.parse(readFileSync('fixtures/assrt/search-matrix.json', 'utf8')))
    const sub = resp.sub.subs[0]
    const c = toCandidate(sub)
    expect(c.provider).toBe('assrt')
    expect(c.providerId).toBe(String(sub.id))
    expect(c.fileList.map(f => f.name)).toEqual(sub.filelist.map(f => f.f))
    expect(c.fileList.every((f, i) => f.index === i)).toBe(true)
  })
  it('joins array native_name with " / "', () => {
    const c = toCandidate({ id: 1, native_name: ['黑客帝国', '骇客任务'], filelist: [] } as never)
    expect(c.nativeName).toBe('黑客帝国 / 骇客任务')
  })
})
```

- [ ] **Step 2: Run tests, verify FAIL** — `npx vitest run src/core/schemas.candidate.test.ts src/adapters/providers/assrt.toCandidate.test.ts` → FAIL (`SubtitleCandidateSchema` not exported).

- [ ] **Step 3: Implement.** Append to `src/core/schemas.ts` (after the ASSRT schema block):

```ts
// ---------- Provider-neutral candidate (multi-source) ----------
export const PROVIDERS = ['assrt', 'opensubtitles'] as const
export type ProviderName = (typeof PROVIDERS)[number]

export const SubtitleFileSchema = z.object({
  index: z.number().int(),
  name: z.string(),
})
export type SubtitleFile = z.infer<typeof SubtitleFileSchema>

export const SubtitleCandidateSchema = z.object({
  provider: z.enum(PROVIDERS),
  providerId: z.string(),
  videoName: z.string().nullish(),
  nativeName: z.string().nullish(),
  /** provider 原始语言描述（assrt: lang.desc；opensubtitles: 'zh-CN' 等），仅供 LLM 参考 */
  language: z.string().nullish(),
  subtype: z.string().nullish(),
  releaseSite: z.string().nullish(),
  uploadDate: z.string().nullish(),
  fileList: z.array(SubtitleFileSchema).default([]),
})
export type SubtitleCandidate = z.infer<typeof SubtitleCandidateSchema>

export interface CandidateRef { provider: ProviderName; providerId: string; fileIndex: number | null }

export function candidateKey(c: { provider: string; providerId: string }): string {
  return `${c.provider}:${c.providerId}`
}
export function parseCandidateKey(key: string): { provider: ProviderName; providerId: string } | null {
  const i = key.indexOf(':')
  if (i <= 0) return null
  const provider = key.slice(0, i)
  if (!(PROVIDERS as readonly string[]).includes(provider)) return null
  return { provider: provider as ProviderName, providerId: key.slice(i + 1) }
}
```

Append to `src/adapters/providers/assrt.ts`:
```ts
import type { SubtitleCandidate } from '../../core/schemas.js'   // add to existing imports

export function toCandidate(sub: AssrtSub): SubtitleCandidate {
  const native = Array.isArray(sub.native_name) ? sub.native_name.join(' / ') : sub.native_name
  return {
    provider: 'assrt',
    providerId: String(sub.id),
    videoName: sub.videoname ?? sub.filename ?? null,
    nativeName: native ?? null,
    language: sub.lang?.desc ?? null,
    subtype: sub.subtype ?? null,
    releaseSite: sub.release_site ?? null,
    uploadDate: null,
    fileList: sub.filelist.map((f, i) => ({ index: i, name: f.f })),
  }
}
```
(`AssrtSub` is already imported in assrt.ts via schemas; adjust the import line accordingly.)

- [ ] **Step 4: Run tests, verify PASS**; then full gate: `npx tsc --noEmit && npx vitest run` → all green (this task is additive; nothing else changed).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(schemas): provider-neutral SubtitleCandidate + assrt toCandidate converter"`

---

## Task 2: ASSRT gems — `similar` + `searchByFilename` on AssrtClient (additive)

**Files:**
- Modify: `src/adapters/providers/assrt.ts` (two methods)
- Test: `src/adapters/providers/assrt.test.ts` (extend existing test file; read it first to reuse its mock-fetch helper pattern)

- [ ] **Step 1: Write failing tests** (adapt to the file's existing mock style — it constructs `AssrtClient` with `fetchImpl` and a temp `cacheDir`; follow the same pattern):

```ts
it('similar() calls /sub/similar with id and parses like search', async () => {
  const calls: string[] = []
  const client = makeClient(url => {                     // reuse/extend the file's helper
    calls.push(url)
    return okJson({ status: 0, sub: { subs: [{ id: 99, filelist: [] }] } })
  })
  const resp = await client.similar(673114)
  expect(calls[0]).toContain('/sub/similar')
  expect(calls[0]).toContain('id=673114')
  expect(resp.sub.subs[0].id).toBe(99)
})

it('searchByFilename() passes is_file=1 and the raw filename', async () => {
  const calls: string[] = []
  const client = makeClient(url => { calls.push(url); return okJson({ status: 0, sub: { subs: [] } }) })
  await client.searchByFilename('Peacemaker.S01E08.1080p.WEB.h264.mkv')
  expect(calls[0]).toContain('is_file=1')
  expect(calls[0]).toContain(encodeURIComponent('Peacemaker.S01E08.1080p.WEB.h264.mkv'))
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/adapters/providers/assrt.test.ts`

- [ ] **Step 3: Implement** — add next to `search()` in `AssrtClient`:
```ts
/** ASSRT 白捡增益①：传命中 id 返最多 5 条相似字幕（免费召回扩展）。 */
similar(id: number) {
  return this.call('sub/similar', { id: String(id) }, AssrtSearchResponseSchema)
}
/** ASSRT 白捡增益②：整文件名精确模式兜底查询。 */
searchByFilename(filename: string) {
  return this.call('sub/search', { q: filename, is_file: '1', filelist: '1', no_muxer: '1' }, AssrtSearchResponseSchema)
}
```

- [ ] **Step 4: Run tests → PASS; `npx tsc --noEmit && npx vitest run` → green.**

- [ ] **Step 5: Commit** — `git commit -am "feat(assrt): gems endpoints — /sub/similar recall expansion + is_file filename fallback"`

---

## Task 3: OpenSubtitles client + adapter conversion (additive)

**Files:**
- Create: `src/adapters/providers/opensubtitles.ts`
- Create: `fixtures/opensubtitles/search-peacemaker-s1.json` (trimmed real response, below)
- Test: `src/adapters/providers/opensubtitles.test.ts`

- [ ] **Step 1: Create the fixture** `fixtures/opensubtitles/search-peacemaker-s1.json` (shape from the live 2026-07-10 smoke test; two entries suffice):
```json
{
  "total_pages": 1, "total_count": 2, "per_page": 50, "page": 1,
  "data": [
    { "id": "6324806", "type": "subtitle", "attributes": {
        "subtitle_id": "6324806", "language": "zh-CN", "download_count": 7302,
        "hearing_impaired": false, "fps": 23.976, "votes": 0, "ratings": 0.0,
        "from_trusted": false, "upload_date": "2022-02-18T08:20:12Z",
        "release": "peacemaker.2022.s01e01.1080p.web.h264-cakes.chs",
        "feature_details": { "feature_id": 944572, "feature_type": "Episode",
          "year": 2022, "title": "A Whole New Whirled", "movie_name": "Peacemaker - S01E01",
          "imdb_id": 14184232, "season_number": 1, "episode_number": 1, "parent_imdb_id": 13146488 },
        "files": [ { "file_id": 7174766, "cd_number": 1, "file_name": "peacemaker.2022.s01e01.1080p.web.h264-cakes.chs.srt" } ] } },
    { "id": "6324807", "type": "subtitle", "attributes": {
        "subtitle_id": "6324807", "language": "zh-CN", "download_count": 3738,
        "upload_date": "2022-02-18T08:21:00Z",
        "release": "Peacemaker.2022.S01E02.Best.Friends.For.Never.1080p.HMAX.WEB-DL",
        "feature_details": { "feature_type": "Episode", "season_number": 1, "episode_number": 2, "parent_imdb_id": 13146488 },
        "files": [ { "file_id": 7174767, "cd_number": 1, "file_name": "Peacemaker.S01E02.chs.srt" } ] } }
  ]
}
```

- [ ] **Step 2: Write failing tests** `src/adapters/providers/opensubtitles.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { OpenSubtitlesClient, osToCandidates } from './opensubtitles.js'

const fixture = JSON.parse(readFileSync('fixtures/opensubtitles/search-peacemaker-s1.json', 'utf8'))
const okJson = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

function makeClient(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenSubtitlesClient>[0]> = {}) {
  return new OpenSubtitlesClient({ apiKey: 'k', appUserAgent: 'subtitlescout v0.2.0', fetchImpl, ...extra })
}

describe('OpenSubtitlesClient.search', () => {
  it('builds episode query with lowercase languages and parent_imdb_id', async () => {
    const urls: string[] = []
    const client = makeClient(((url: string, init: RequestInit) => { urls.push(String(url)); return okJson(fixture) }) as never)
    const resp = await client.search({ parentImdbId: 13146488, season: 1, episode: 1, languages: ['zh-cn', 'zh-tw'] })
    expect(urls[0]).toContain('parent_imdb_id=13146488')
    expect(urls[0]).toContain('season_number=1')
    expect(urls[0]).toContain('languages=zh-cn%2Czh-tw')
    expect(urls[0]).not.toMatch(/zh-CN/)
    expect(resp.data.length).toBe(2)
  })
  it('sends Api-Key + User-Agent headers on every request', async () => {
    let headers: Record<string, string> = {}
    const client = makeClient(((url: string, init: RequestInit) => { headers = init.headers as never; return okJson(fixture) }) as never)
    await client.search({ query: 'Peacemaker', languages: ['zh-cn'] })
    expect(headers['Api-Key']).toBe('k')
    expect(headers['User-Agent']).toBe('subtitlescout v0.2.0')
  })
})

describe('OpenSubtitlesClient.resolveDownload', () => {
  it('POSTs /download with file_id, no Bearer when no credentials (dev_mode)', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const client = makeClient(((url: string, init: RequestInit) => {
      captured = { url: String(url), init }
      return okJson({ link: 'https://www.opensubtitles.com/download/ABC', file_name: 'e1.srt', remaining: 99, reset_time_utc: '2026-07-10T23:59:58.000Z' })
    }) as never)
    const r = await client.resolveDownload(7174766)
    expect(captured!.url).toContain('/download')
    expect((captured!.init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(JSON.parse(String(captured!.init.body))).toEqual({ file_id: 7174766 })
    expect(r.link).toContain('/download/ABC')
    expect(r.remaining).toBe(99)
  })
  it('logs in once and attaches Bearer when credentials given', async () => {
    const calls: string[] = []
    const client = makeClient(((url: string, init: RequestInit) => {
      calls.push(String(url))
      if (String(url).endsWith('/login')) return okJson({ token: 'JWT1', base_url: 'api.opensubtitles.com', user: { allowed_downloads: 20, vip: false } })
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer JWT1')
      return okJson({ link: 'L', file_name: 'f.srt', remaining: 19, reset_time_utc: '' })
    }) as never, { username: 'u', password: 'p' })
    await client.resolveDownload(1)
    await client.resolveDownload(2)
    expect(calls.filter(u => u.endsWith('/login')).length).toBe(1) // token cached in-memory
  })
})

describe('osToCandidates', () => {
  it('yields one candidate per file with providerId = file_id', () => {
    const cands = osToCandidates(fixture)
    expect(cands.length).toBe(2)
    expect(cands[0]).toMatchObject({
      provider: 'opensubtitles', providerId: '7174766',
      videoName: 'peacemaker.2022.s01e01.1080p.web.h264-cakes.chs',
      language: 'zh-CN', fileList: [],
    })
  })
})
```

- [ ] **Step 3: Run, verify FAIL** (module not found).

- [ ] **Step 4: Implement** `src/adapters/providers/opensubtitles.ts`:
```ts
import { z } from 'zod'
import type { SubtitleCandidate } from '../../core/schemas.js'

const BASE = 'https://api.opensubtitles.com/api/v1'

export const OsSearchResponseSchema = z.object({
  total_count: z.number().default(0),
  data: z.array(z.object({
    id: z.string(),
    attributes: z.object({
      subtitle_id: z.string().optional(),
      language: z.string().nullish(),
      release: z.string().nullish(),
      upload_date: z.string().nullish(),
      download_count: z.number().nullish(),
      feature_details: z.object({
        season_number: z.number().nullish(),
        episode_number: z.number().nullish(),
        year: z.number().nullish(),
        title: z.string().nullish(),
      }).passthrough().nullish(),
      files: z.array(z.object({
        file_id: z.number(),
        file_name: z.string().nullish(),
      })).default([]),
    }).passthrough(),
  })).default([]),
})
export type OsSearchResponse = z.infer<typeof OsSearchResponseSchema>

const OsDownloadResponseSchema = z.object({
  link: z.string(),
  file_name: z.string().nullish(),
  remaining: z.number().nullish(),
  reset_time_utc: z.string().nullish(),
})
const OsLoginResponseSchema = z.object({
  token: z.string(),
  base_url: z.string().nullish(),
  user: z.object({ allowed_downloads: z.number().nullish(), vip: z.boolean().nullish() }).nullish(),
})

export interface OsClientOpts {
  apiKey: string
  appUserAgent: string
  username?: string
  password?: string
  fetchImpl?: typeof fetch
  onApiCall?: (r: { endpoint: string; params: Record<string, unknown>; status: number | null; durationMs: number; error?: string }) => void
}
export interface OsSearchParams {
  imdbId?: number; parentImdbId?: number
  season?: number; episode?: number
  query?: string; year?: number
  languages: string[]   // MUST be lowercase, e.g. ['zh-cn','zh-tw']
}

export class OpenSubtitlesClient {
  private fetchImpl: typeof fetch
  private token: string | null = null
  constructor(private opts: OsClientOpts) { this.fetchImpl = opts.fetchImpl ?? fetch }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { 'Api-Key': this.opts.apiKey, 'User-Agent': this.opts.appUserAgent }
    if (json) h['Content-Type'] = 'application/json'
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  private async request<T>(endpoint: string, init: RequestInit, schema: z.ZodType<T>, params: Record<string, unknown>): Promise<T> {
    const t0 = Date.now()
    let status: number | null = null
    try {
      const res = await this.fetchImpl(`${BASE}${endpoint}`, { ...init, redirect: 'follow' })
      status = res.status
      if (!res.ok) throw new Error(`opensubtitles ${endpoint} HTTP ${res.status}`)
      const body = await res.json()
      this.opts.onApiCall?.({ endpoint: `os${endpoint}`, params, status, durationMs: Date.now() - t0 })
      return schema.parse(body)
    } catch (e) {
      this.opts.onApiCall?.({ endpoint: `os${endpoint}`, params, status, durationMs: Date.now() - t0, error: String(e) })
      throw e
    }
  }

  private async ensureLogin(): Promise<void> {
    if (this.token || !this.opts.username || !this.opts.password) return
    const r = await this.request('/login',
      { method: 'POST', headers: this.headers(true), body: JSON.stringify({ username: this.opts.username, password: this.opts.password }) },
      OsLoginResponseSchema, { username: this.opts.username })
    this.token = r.token
  }

  async search(p: OsSearchParams): Promise<OsSearchResponse> {
    const q = new URLSearchParams()
    if (p.parentImdbId != null) q.set('parent_imdb_id', String(p.parentImdbId))
    else if (p.imdbId != null) q.set('imdb_id', String(p.imdbId))
    if (p.season != null) q.set('season_number', String(p.season))
    if (p.episode != null) q.set('episode_number', String(p.episode))
    if (p.query && p.parentImdbId == null && p.imdbId == null) q.set('query', p.query)
    if (p.year != null && p.query) q.set('year', String(p.year))
    q.set('languages', p.languages.map(l => l.toLowerCase()).join(','))
    return this.request(`/subtitles?${q}`, { method: 'GET', headers: this.headers() }, OsSearchResponseSchema, Object.fromEntries(q))
  }

  /** 消耗配额的一步。dev_mode（无账号密码）下免 JWT 直接可用。 */
  async resolveDownload(fileId: number): Promise<z.infer<typeof OsDownloadResponseSchema>> {
    await this.ensureLogin()
    return this.request('/download',
      { method: 'POST', headers: this.headers(true), body: JSON.stringify({ file_id: fileId }) },
      OsDownloadResponseSchema, { file_id: fileId })
  }
}

/** OS 一个 subtitle 通常一个文件：providerId = file_id，fileList 留空（单文件 provider）。 */
export function osToCandidates(resp: OsSearchResponse): SubtitleCandidate[] {
  const out: SubtitleCandidate[] = []
  for (const item of resp.data) {
    const a = item.attributes
    for (const f of a.files) {
      out.push({
        provider: 'opensubtitles',
        providerId: String(f.file_id),
        videoName: a.release ?? f.file_name ?? null,
        nativeName: null,
        language: a.language ?? null,
        subtype: 'srt',
        releaseSite: null,
        uploadDate: a.upload_date ?? null,
        fileList: [],
      })
    }
  }
  return out
}
```

- [ ] **Step 5: Run tests → PASS; `npx tsc --noEmit && npx vitest run` → green.**

- [ ] **Step 6: Commit** — `git commit -am "feat(providers): OpenSubtitles REST client + neutral candidate conversion"`

---

## Task 4: `subtitle-fetch` aggregate CLI (search + resolve, registry, NDJSON events)

**Files:**
- Create: `src/cli/fetchLib.ts` (testable core: registry + orchestration, NO process.exit / no arg parsing)
- Create: `src/cli/subtitle-fetch.ts` (thin bin wrapper: parseArgs + env → adapters → stdout/stderr/exit codes)
- Test: `src/cli/fetchLib.test.ts`

**Contract (from spec):**
```bash
# search (default subcommand):
tsx src/cli/subtitle-fetch.ts --query "爱，死亡和机器人 第3季" --query "Love Death Robots S03" \
  --imdb tt9561862 --season 3 --episode 1 --year 2022 --filename "LDR.S03E01.mkv" --format json
# stdout → SubtitleCandidate[] JSON;  stderr → NDJSON events;  exit 0 (even if empty)
# resolve:
tsx src/cli/subtitle-fetch.ts resolve --provider assrt --id 673114 --file-index 3
# stdout → {"url": "...", "filename": "..."};  exit 0;  exit 1 + {"error": ...} on stderr on failure
```
stderr NDJSON events: `{"event":"api_call","provider":"assrt","endpoint":"sub/search","status":0,"durationMs":812}` and `{"event":"provider_error","provider":"opensubtitles","message":"..."}`.
`--deep` is accepted but enables nothing in Phase 1 (zimuku/subf2m arrive in Phase 2).

- [ ] **Step 1: Write failing tests** `src/cli/fetchLib.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { runSearch, runResolve, type FetchAdapter, type FetchArgs } from './fetchLib.js'
import type { SubtitleCandidate } from '../core/schemas.js'

const cand = (provider: 'assrt' | 'opensubtitles', id: string): SubtitleCandidate =>
  ({ provider, providerId: id, videoName: null, nativeName: null, language: null,
     subtype: null, releaseSite: null, uploadDate: null, fileList: [] })

function adapter(name: string, opts: Partial<FetchAdapter> = {}): FetchAdapter {
  return {
    name,
    enabled: () => true,
    search: async () => [cand('assrt', `${name}-1`)],
    resolve: async () => ({ url: `https://dl/${name}` }),
    ...opts,
  }
}

describe('runSearch', () => {
  const args: FetchArgs = { queries: ['q1'], deep: false }
  it('merges results from all enabled adapters', async () => {
    const r = await runSearch(args, [adapter('a'), adapter('b')], () => {})
    expect(r.map(c => c.providerId).sort()).toEqual(['a-1', 'b-1'])
  })
  it('skips disabled adapters', async () => {
    const r = await runSearch(args, [adapter('a'), adapter('b', { enabled: () => false })], () => {})
    expect(r.map(c => c.providerId)).toEqual(['a-1'])
  })
  it('fail-soft: one adapter throwing does not kill the run, emits provider_error', async () => {
    const events: unknown[] = []
    const r = await runSearch(args, [
      adapter('boom', { search: async () => { throw new Error('cf block') } }),
      adapter('ok'),
    ], e => events.push(e))
    expect(r.map(c => c.providerId)).toEqual(['ok-1'])
    expect(events).toContainEqual(expect.objectContaining({ event: 'provider_error', provider: 'boom' }))
  })
  it('dedupes identical provider:providerId across adapters', async () => {
    const dup = cand('assrt', 'same')
    const r = await runSearch(args, [
      adapter('a', { search: async () => [dup] }),
      adapter('b', { search: async () => [dup] }),
    ], () => {})
    expect(r.length).toBe(1)
  })
})

describe('runResolve', () => {
  it('dispatches to the adapter owning the provider', async () => {
    const r = await runResolve({ provider: 'assrt', providerId: '1', fileIndex: 0 },
      [adapter('assrt'), adapter('opensubtitles')])
    expect(r.url).toBe('https://dl/assrt')
  })
  it('throws when no adapter owns the provider', async () => {
    await expect(runResolve({ provider: 'opensubtitles', providerId: '1', fileIndex: null }, [adapter('assrt')]))
      .rejects.toThrow(/no adapter/)
  })
})
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** `src/cli/fetchLib.ts`:
```ts
import { candidateKey, type CandidateRef, type SubtitleCandidate } from '../core/schemas.js'

export interface FetchArgs {
  queries: string[]
  imdb?: string          // tt9561862 or bare digits
  year?: number
  season?: number
  episode?: number
  filename?: string
  languages?: string[]   // lowercase; default ['zh-cn','zh-tw']
  deep: boolean
}
export type FetchEvent =
  | { event: 'api_call'; provider: string; endpoint: string; status: number | null; durationMs: number; error?: string }
  | { event: 'provider_error'; provider: string; message: string }

export interface FetchAdapter {
  name: string   // must equal the ProviderName it emits ('assrt' | 'opensubtitles')
  enabled: (args: FetchArgs, env: NodeJS.ProcessEnv) => boolean
  search: (args: FetchArgs, emit: (e: FetchEvent) => void) => Promise<SubtitleCandidate[]>
  resolve: (ref: CandidateRef, emit: (e: FetchEvent) => void) => Promise<{ url: string; filename?: string }>
}

export async function runSearch(
  args: FetchArgs, adapters: FetchAdapter[], emit: (e: FetchEvent) => void, env = process.env,
): Promise<SubtitleCandidate[]> {
  const enabled = adapters.filter(a => a.enabled(args, env))
  const results = await Promise.all(enabled.map(a =>
    a.search(args, emit).catch(e => {
      emit({ event: 'provider_error', provider: a.name, message: String(e) })
      return [] as SubtitleCandidate[]
    })))
  const byKey = new Map<string, SubtitleCandidate>()
  for (const c of results.flat()) if (!byKey.has(candidateKey(c))) byKey.set(candidateKey(c), c)
  return [...byKey.values()]
}

export async function runResolve(
  ref: CandidateRef, adapters: FetchAdapter[], emit: (e: FetchEvent) => void = () => {},
): Promise<{ url: string; filename?: string }> {
  const adapter = adapters.find(a => a.name === ref.provider)
  if (!adapter) throw new Error(`no adapter for provider ${ref.provider}`)
  return adapter.resolve(ref, emit)
}
```

- [ ] **Step 4: Run fetchLib tests → PASS.**

- [ ] **Step 5: Implement the bin wrapper** `src/cli/subtitle-fetch.ts` (wires real adapters; keep ALL logic thin — orchestration lives in fetchLib, provider mechanics in the clients):
```ts
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { toCandidate } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient, osToCandidates } from '../adapters/providers/opensubtitles.js'
import { runSearch, runResolve, type FetchAdapter, type FetchArgs, type FetchEvent } from './fetchLib.js'
import { parseCandidateKey, type CandidateRef } from '../core/schemas.js'

const emit = (e: FetchEvent) => process.stderr.write(JSON.stringify(e) + '\n')
const imdbDigits = (s: string | undefined) => s ? Number(s.replace(/^tt/, '')) : undefined

function buildAdapters(): FetchAdapter[] {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const adapters: FetchAdapter[] = []

  if (process.env.ASSRT_TOKEN) {
    const client = new AssrtClient({
      token: process.env.ASSRT_TOKEN,
      cacheDir: join(cacheRoot, 'assrt-responses'),
      onApiCall: r => emit({ event: 'api_call', provider: 'assrt', ...r }),
    })
    adapters.push({
      name: 'assrt',
      enabled: () => true,
      search: async (args) => {
        const byId = new Map<number, ReturnType<typeof toCandidate>>()
        for (const q of args.queries.slice(0, 2)) {
          const resp = await client.search(q)
          for (const s of resp.sub.subs) if (!byId.has(s.id)) byId.set(s.id, toCandidate(s))
        }
        // gems: 有命中→similar 扩召回；零命中→整文件名兜底
        if (byId.size > 0) {
          const top = [...byId.keys()][0]
          try {
            const sim = await client.similar(top)
            for (const s of sim.sub.subs) if (!byId.has(s.id)) byId.set(s.id, toCandidate(s))
          } catch { /* gems 失败不影响主结果 */ }
        } else if (args.filename) {
          const byFile = await client.searchByFilename(args.filename)
          for (const s of byFile.sub.subs) byId.set(s.id, toCandidate(s))
        }
        return [...byId.values()]
      },
      resolve: async (ref) => {
        const detail = await client.detail(Number(ref.providerId))
        const sub = detail.sub.subs.find(s => String(s.id) === ref.providerId) ?? detail.sub.subs[0]
        if (!sub) throw new Error(`assrt detail ${ref.providerId} returned no subs`)
        const entry = ref.fileIndex != null ? sub.filelist[ref.fileIndex] : undefined
        const url = entry?.url ?? sub.url
        if (!url) throw new Error(`assrt ${ref.providerId} has no download url`)
        return { url, filename: entry?.f ?? sub.filename ?? undefined }
      },
    })
  }

  if (process.env.OPENSUBTITLES_API_KEY) {
    const client = new OpenSubtitlesClient({
      apiKey: process.env.OPENSUBTITLES_API_KEY,
      appUserAgent: 'subtitlescout v0.2.0',
      username: process.env.OPENSUBTITLES_USERNAME,
      password: process.env.OPENSUBTITLES_PASSWORD,
      onApiCall: r => emit({ event: 'api_call', provider: 'opensubtitles', ...r }),
    })
    adapters.push({
      name: 'opensubtitles',
      enabled: () => true,
      search: async (args) => {
        const languages = args.languages ?? ['zh-cn', 'zh-tw']
        const imdb = imdbDigits(args.imdb)
        const resp = await client.search(args.season != null
          ? { parentImdbId: imdb, season: args.season, episode: args.episode, query: imdb ? undefined : args.queries[0], year: args.year, languages }
          : { imdbId: imdb, query: imdb ? undefined : args.queries[0], year: args.year, languages })
        return osToCandidates(resp)
      },
      resolve: async (ref) => {
        const r = await client.resolveDownload(Number(ref.providerId))
        return { url: r.link, filename: r.file_name ?? undefined }
      },
    })
  }
  return adapters
}

async function main() {
  const isResolve = process.argv[2] === 'resolve'
  const rawArgs = isResolve ? process.argv.slice(3) : process.argv.slice(2)
  if (isResolve) {
    const { values } = parseArgs({ args: rawArgs, options: {
      provider: { type: 'string' }, id: { type: 'string' }, 'file-index': { type: 'string' },
    } })
    const parsed = parseCandidateKey(`${values.provider}:${values.id}`)
    if (!parsed) { process.stderr.write(JSON.stringify({ error: `unknown provider ${values.provider}` }) + '\n'); process.exit(1) }
    const ref: CandidateRef = { ...parsed, fileIndex: values['file-index'] != null ? Number(values['file-index']) : null }
    const out = await runResolve(ref, buildAdapters(), emit)
    process.stdout.write(JSON.stringify(out) + '\n')
    return
  }
  const { values } = parseArgs({ args: rawArgs, options: {
    query: { type: 'string', multiple: true }, imdb: { type: 'string' }, year: { type: 'string' },
    season: { type: 'string' }, episode: { type: 'string' }, filename: { type: 'string' },
    languages: { type: 'string' }, deep: { type: 'boolean', default: false }, format: { type: 'string', default: 'json' },
  } })
  const args: FetchArgs = {
    queries: values.query ?? [],
    imdb: values.imdb, year: values.year ? Number(values.year) : undefined,
    season: values.season ? Number(values.season) : undefined,
    episode: values.episode ? Number(values.episode) : undefined,
    filename: values.filename,
    languages: values.languages?.split(',').map(s => s.trim().toLowerCase()),
    deep: values.deep!,
  }
  const candidates = await runSearch(args, buildAdapters(), emit)
  process.stdout.write(JSON.stringify(candidates) + '\n')
}

main().catch(e => { process.stderr.write(JSON.stringify({ error: String(e) }) + '\n'); process.exit(1) })
```

- [ ] **Step 6: Manual smoke (real network, uses .env)** — run and eyeball:
```bash
npx tsx src/cli/subtitle-fetch.ts --query "Peacemaker" --imdb tt13146488 --season 1 --episode 1 --format json 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const a=JSON.parse(s);console.log(a.length, a.map(c=>c.provider+":"+c.providerId).slice(0,5))})'
```
Expected: nonzero count including `opensubtitles:*` entries (and any assrt hits). Do NOT run resolve against opensubtitles here (saves quota); resolve is covered in Task 9 live e2e.

- [ ] **Step 7: `npx tsc --noEmit && npx vitest run` → green. Commit** — `git commit -am "feat(cli): subtitle-fetch aggregate CLI — adapter registry, search+resolve, NDJSON events, assrt gems + opensubtitles"`

---

## Task 5: Core neutralization — RankDecision/gate/cache/rank/maps/FinalDecision switch to `SubtitleCandidate`

This is the big coordinated refactor. Everything compiles at the end of THIS task (not mid-way); pipeline still talks to ASSRT in-process here — the subprocess bridge lands in Task 6. Work through the files in the order below, then fix compile errors until `tsc --noEmit` is clean.

**Files:**
- Modify: `src/core/schemas.ts` (`RankDecisionSchema`, `FinalDecisionSchema.selected`, `LooseEpisodesMapSchema`)
- Modify: `src/core/gate.ts`, `src/core/cache.ts`
- Modify: `src/agent/rankCandidates.ts`, `src/agent/mapSeasonPack.ts`, `src/agent/mapLooseEpisodes.ts`
- Modify: `src/core/pipeline.ts` (types + candidate conversion at the deps.assrt boundary)
- Modify: every failing test (`gate.test.ts`, `cache.test.ts`, `rankCandidates.test.ts`, `pipeline.test.ts`, `src/dashboard/story.test.ts`, others surfaced by vitest)

- [ ] **Step 1: schemas.ts — RankDecision goes neutral.** Replace `assrt_id`/`file_index`/`rejected[].assrt_id`:
```ts
export const RankDecisionSchema = z.object({
  decision: z.enum(['download', 'ask_user', 'no_safe_match']),
  /** "<provider>:<providerId>"，与 prompt 里 candidates[].id 完全一致 */
  candidate_id: z.string().nullish(),
  file_index: looseNumeric(z.number().int()),
  identity_match: IdentityMatchSchema,
  confidence: z.preprocess(
    v => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v),
    z.number().min(0).max(1),
  ),
  reasons: z.array(z.string()),
  rejected: z.array(z.object({ candidate_id: z.string(), reason: z.string() })),
}).refine(v => v.decision !== 'download' || (v.candidate_id != null && v.candidate_id !== ''), {
  message: 'candidate_id required when decision=download',
})
```
`FinalDecisionSchema.selected`: replace `assrt_id: z.number()` with
```ts
  selected: z.object({
    provider: z.string(),
    provider_id: z.string(),
    subtitle_name: z.string(),
    language: z.string(),
    format: z.string(),
  }).nullish(),
```
`LooseEpisodesMapSchema` assignments: `sub_id` (numeric) → `candidate_id: z.string()`.
`SeasonMapSchema` keeps `filelist_index` (it indexes into ONE candidate's fileList — already neutral).

- [ ] **Step 2: cache.ts — neutral positive entry + legacy migration on read:**
```ts
export type CacheEntry =
  | { kind: 'positive'; provider: ProviderName; providerId: string; fileIndex: number | null; confidence: number }
  | { kind: 'negative'; reason: string }
```
In `get()`, after JSON.parse and before the TTL check, migrate legacy entries so a year of positive cache survives the refactor:
```ts
const e = stored.entry as CacheEntry & { assrt_id?: number; file_index?: number | null }
if (e.kind === 'positive' && e.assrt_id != null && (e as { providerId?: string }).providerId == null) {
  stored.entry = { kind: 'positive', provider: 'assrt', providerId: String(e.assrt_id), fileIndex: e.file_index ?? null, confidence: e.confidence }
}
```
Add a test in `src/core/cache.test.ts`: write a legacy-shaped JSON file directly into the cache dir, `get()` returns the migrated neutral shape.

- [ ] **Step 3: gate.ts — match by candidateKey.** `GateResult.candidate?: SubtitleCandidate`; signature `runGate(rank, candidates: SubtitleCandidate[], identity, prefs)`. Replace the two ASSRT lines:
```ts
const candidate = candidates.find(c => candidateKey(c) === rank.candidate_id)
if (!candidate) failures.push(`candidate_id ${rank.candidate_id} is not in this search's candidate set`)
if (candidate && candidate.fileList.length > 0) {
  if (rank.file_index == null || rank.file_index < 0 || rank.file_index >= candidate.fileList.length) {
    failures.push(`file_index ${rank.file_index} out of range for filelist of ${candidate.fileList.length}`)
  }
}
```
Identity-verdict switch logic below is untouched. Update `gate.test.ts` fixtures from `{ id, filelist: [...] }` AssrtSub shapes to neutral candidates (`{ provider: 'assrt', providerId: '123', fileList: [{index:0,name:'a.srt'}], ... }`) and `assrt_id: 123` → `candidate_id: 'assrt:123'`.

- [ ] **Step 4: rankCandidates.ts — neutral input + prompt update.**
`isGraphicOnly(c: SubtitleCandidate)`: same logic, fields renamed (`c.fileList.map(f => f.name)`, `c.subtype` unchanged). `compactCandidates(candidates: SubtitleCandidate[])`:
```ts
return candidates.slice(0, MAX_CANDIDATES).map(c => {
  const files = c.fileList.map(f => f.name)
  const shown = files.slice(0, MAX_FILELIST_ENTRIES)
  return {
    id: candidateKey(c),                    // ← LLM 引用的就是这个字符串
    provider: c.provider,
    videoname: c.videoName, native_name: c.nativeName,
    lang: c.language, subtype: c.subtype, release_site: c.releaseSite,
    filelist: shown,
    ...(files.length > shown.length ? { filelist_truncated: files.length - shown.length } : {}),
  }
})
```
Prompt line 1: `'Choose the best Chinese subtitle for this media from ASSRT candidates, or refuse.'` → `'Choose the best Chinese subtitle for this media from multi-source candidates (fields: id = "<provider>:<providerId>"), or refuse.'`
Add one line after the file_index paragraph: `'Report candidate_id as the candidate\'s id string EXACTLY as shown (e.g. "assrt:673114" or "opensubtitles:7174766").'`
The `rejected[]` instruction stays, field name is now `candidate_id`. Everything else in the prompt (identity verdict rules, thresholds) is provider-agnostic — DO NOT touch it.
Update `rankCandidates.test.ts` accordingly (compact projection asserts `id: 'assrt:...'`).

- [ ] **Step 5: mapSeasonPack.ts / mapLooseEpisodes.ts** — input types `AssrtSub`→`SubtitleCandidate` (`filelist`→`fileList`, `f`→`name`, `id`→`candidateKey(c)` in prompts); `mapLooseEpisodes` prompt + schema now report `candidate_id` strings. Update their tests.

- [ ] **Step 6: pipeline.ts — internal switch (bridge comes in Task 6).** Keep `deps.assrt.{search,detail}` for now but convert at the boundary:
  - search loop: `for (const s of resp.sub.subs) { const c = toCandidate(s); if (!byKey.has(candidateKey(c))) byKey.set(candidateKey(c), c) }` — `byId: Map<number, AssrtSub>` → `byKey: Map<string, SubtitleCandidate>`.
  - cache-hit path: cached entry now carries `{provider, providerId, fileIndex}`; detail call becomes `deps.assrt.detail(Number(cached.providerId))` (all legacy cache entries are assrt), synthesized rank uses `candidate_id: candidateKey(cached)`.
  - download stage: `rank.candidate_id` → `parseCandidateKey`; assrt detail lookup by `String(s.id) === parsed.providerId`; `cache.put(..., { kind: 'positive', provider: parsed.provider, providerId: parsed.providerId, fileIndex: rank.file_index ?? null, confidence: rank.confidence })`.
  - `finish(...)` selected block: `{ provider: parsed.provider, provider_id: parsed.providerId, subtitle_name, language, format }`.
  - season graduation/sweep: `pickSeasonPack`/`shouldGraduate` take `SubtitleCandidate` (`fileList.length`); sweep assignments carry `candidate_id`, per-episode detail call `deps.assrt.detail(Number(parseCandidateKey(a.candidate_id)!.providerId))`.

- [ ] **Step 7: Chase the compiler.** `npx tsc --noEmit` — fix every remaining error (expected: `src/dashboard/story.ts`/`story.test.ts` touching `selected.assrt_id` → `selected.provider_id`; `src/cli/index.ts` type-level fallout; grep to be sure):
```bash
grep -rn "assrt_id\|AssrtSub\|file_index" src/ --include='*.ts' | grep -v test | grep -v schemas.ts | grep -v assrt.ts
```
Goal: outside `schemas.ts` (ASSRT response schemas stay — they describe ASSRT's wire format) and `adapters/providers/assrt.ts`, NO source file mentions `AssrtSub` or `assrt_id` anymore.

- [ ] **Step 8: Update every failing test to the neutral shapes.** `npx vitest run` → green. This includes `src/dashboard/story.test.ts` (`selected.assrt_id` → `provider_id`) and `src/core/pipeline.test.ts` (mock `deps.assrt` responses stay ASSRT-shaped — the pipeline converts internally, so mocks need no change; only assertions on rank/cache/selected shapes change).

- [ ] **Step 9: Commit** — `git commit -am "refactor(core): provider-neutral candidate flows through rank/gate/cache/pipeline — assrt_id eliminated outside adapter"`

---

## Task 6: ProviderPort bridge — pipeline spawns subtitle-fetch (Design Decision 5)

**Files:**
- Create: `src/core/providerPort.ts` (interface + subprocess implementation)
- Create: `fixtures/fetch-stub.mjs` (test stub executable)
- Modify: `src/core/pipeline.ts` (`PipelineDeps.assrt` → `PipelineDeps.providers: ProviderPort`)
- Modify: `src/cli/index.ts` (`assemble()` wires `makeCliProviderPort`; `AssrtClient` construction moves OUT of assemble — the CLI subprocess owns it now; `doctor.ts` keeps its own direct client)
- Test: `src/core/providerPort.test.ts`; update `src/core/pipeline.test.ts` mocks

- [ ] **Step 1: Write failing tests** `src/core/providerPort.test.ts` — uses a stub script instead of the real CLI:

`fixtures/fetch-stub.mjs`:
```js
#!/usr/bin/env node
// echoes canned candidates on stdout + one api_call event on stderr; `resolve` mode returns a URL
const isResolve = process.argv[2] === 'resolve'
process.stderr.write(JSON.stringify({ event: 'api_call', provider: 'assrt', endpoint: 'sub/search', status: 0, durationMs: 5 }) + '\n')
if (isResolve) {
  process.stdout.write(JSON.stringify({ url: 'https://dl.example/x.zip', filename: 'x.zip' }) + '\n')
} else {
  process.stdout.write(JSON.stringify([{ provider: 'assrt', providerId: '1', videoName: 'V', nativeName: null, language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [] }]) + '\n')
}
```

```ts
import { describe, it, expect } from 'vitest'
import { makeCliProviderPort } from './providerPort.js'

const stub = ['node', 'fixtures/fetch-stub.mjs']

describe('makeCliProviderPort', () => {
  it('search: spawns CLI, parses stdout candidates, relays stderr api_call events', async () => {
    const events: unknown[] = []
    const port = makeCliProviderPort({ command: stub, onEvent: e => events.push(e) })
    const cands = await port.search({ queries: ['q'], deep: false })
    expect(cands.length).toBe(1)
    expect(cands[0].provider).toBe('assrt')
    expect(events).toContainEqual(expect.objectContaining({ event: 'api_call', provider: 'assrt' }))
  })
  it('resolveDownload: passes provider/id/file-index argv, parses url', async () => {
    const port = makeCliProviderPort({ command: stub })
    const r = await port.resolveDownload({ provider: 'assrt', providerId: '1', fileIndex: 2 })
    expect(r.url).toBe('https://dl.example/x.zip')
  })
  it('rejects with stderr error JSON when CLI exits nonzero', async () => {
    const port = makeCliProviderPort({ command: ['node', '-e', 'process.stderr.write(JSON.stringify({error:"boom"})+"\\n");process.exit(1)'] })
    await expect(port.search({ queries: [], deep: false })).rejects.toThrow(/boom/)
  })
})
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** `src/core/providerPort.ts`:
```ts
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { SubtitleCandidateSchema, type CandidateRef, type SubtitleCandidate } from './schemas.js'
import type { FetchEvent } from '../cli/fetchLib.js'

export interface ProviderSearchArgs {
  queries: string[]
  imdb?: string; year?: number; season?: number; episode?: number
  filename?: string; languages?: string[]
  deep: boolean
}
export interface ProviderPort {
  search: (args: ProviderSearchArgs) => Promise<SubtitleCandidate[]>
  resolveDownload: (ref: CandidateRef) => Promise<{ url: string; filename?: string }>
}

const ResolveOutSchema = z.object({ url: z.string(), filename: z.string().optional() })
const here = dirname(fileURLToPath(import.meta.url))
/** 默认命令：npx tsx <repo>/src/cli/subtitle-fetch.ts（容器与本机同构，无编译步） */
const DEFAULT_COMMAND = ['npx', 'tsx', resolve(here, '../cli/subtitle-fetch.ts')]

export function makeCliProviderPort(opts: {
  command?: string[]
  onEvent?: (e: FetchEvent) => void
  timeoutMs?: number
} = {}): ProviderPort {
  const command = opts.command ?? DEFAULT_COMMAND
  const timeoutMs = opts.timeoutMs ?? 180_000   // assrt 限速 15s/查 ×2 + gems + OS，宽松上限

  function run(argv: string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const [bin, ...pre] = command
      const child = spawn(bin, [...pre, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderrTail = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`subtitle-fetch timeout after ${timeoutMs}ms`)) }, timeoutMs)
      child.stdout.on('data', d => { stdout += d })
      let stderrBuf = ''
      child.stderr.on('data', d => {
        stderrBuf += d
        let nl: number
        while ((nl = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, nl).trim(); stderrBuf = stderrBuf.slice(nl + 1)
          if (!line) continue
          stderrTail = line
          try {
            const parsed = JSON.parse(line)
            if (parsed.event) opts.onEvent?.(parsed as FetchEvent)
          } catch { /* 非 JSON 行照单忽略（如 npx 噪音） */ }
        }
      })
      child.on('error', e => { clearTimeout(timer); reject(e) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code === 0) resolvePromise(stdout)
        else reject(new Error(`subtitle-fetch exit ${code}: ${stderrTail}`))
      })
    })
  }

  return {
    async search(args) {
      const argv: string[] = []
      for (const q of args.queries) argv.push('--query', q)
      if (args.imdb) argv.push('--imdb', args.imdb)
      if (args.year != null) argv.push('--year', String(args.year))
      if (args.season != null) argv.push('--season', String(args.season))
      if (args.episode != null) argv.push('--episode', String(args.episode))
      if (args.filename) argv.push('--filename', args.filename)
      if (args.languages?.length) argv.push('--languages', args.languages.join(','))
      if (args.deep) argv.push('--deep')
      argv.push('--format', 'json')
      const out = await run(argv)
      return z.array(SubtitleCandidateSchema).parse(JSON.parse(out))
    },
    async resolveDownload(ref) {
      const argv = ['resolve', '--provider', ref.provider, '--id', ref.providerId]
      if (ref.fileIndex != null) argv.push('--file-index', String(ref.fileIndex))
      const out = await run(argv)
      return ResolveOutSchema.parse(JSON.parse(out))
    },
  }
}
```

- [ ] **Step 4: Run providerPort tests → PASS.**

- [ ] **Step 5: Switch the pipeline seam.** In `src/core/pipeline.ts`:
  - `PipelineDeps`: delete `assrt: { search; detail }`; add `providers: ProviderPort`. Delete the `SearchResponse`/`DetailResponse` type aliases and the `toCandidate` conversion (Task 5's boundary shim) — candidates now arrive neutral.
  - Search stage: replace the per-query assrt loop with ONE port call (the CLI runs all adapters + gems internally):
```ts
journal.step('providerSearch', { queries: queries.map(q => q.q) })
const searched = await deps.providers.search({
  queries: queries.map(q => q.q),
  imdb: ctx.media.provider_ids?.Imdb ?? ctx.media.provider_ids?.imdb,
  year: identity.year ?? ctx.media.year ?? undefined,
  season: identity.season ?? ctx.media.season ?? undefined,
  episode: identity.episode ?? ctx.media.episode ?? undefined,
  filename: ctx.media.filename,
  deep: false,
})
candidates = filterGraphicOnly(searched)
journal.step('candidateFilter', { raw: searched.length, kept: candidates.length })
```
  (keep `maxApiCallsPerJob` field on deps but it now only caps alias-harvest re-searches; note this in a comment.)
  - Alias-harvest re-search: `deps.providers.search({ queries: aliasQueries, deep: false, filename: ctx.media.filename })`.
  - Cache-hit path: no more detail-resynthesis — go straight to resolve:
```ts
journal.step('cacheHitPositive', cached)
const url = await deps.providers.resolveDownload({ provider: cached.provider, providerId: cached.providerId, fileIndex: cached.fileIndex })
```
  then jump into the shared download/write code with `url.url` / `url.filename` (restructure the download block into a small local `async function fetchAndWrite(ref, subtitleName)` so cache-hit and rank paths share it).
  - Download stage: `deps.providers.resolveDownload(parsedRef)` replaces `deps.assrt.detail(...)` + filelist url picking; `artifactFilename = resolved.filename ?? candidate.fileList[rank.file_index ?? -1]?.name ?? 'subtitle.srt'`.
  - Season sweep: per assignment `deps.providers.resolveDownload({ provider, providerId, fileIndex: assignment.filelist_index })`.
  - Journal: keep step names `resolveDownloadUrl`, `download`, `write`; the old `assrtSearch` step is replaced by `providerSearch` — run `grep -rn "assrtSearch" src/dashboard/` and update any label mapping that references it.

- [ ] **Step 6: Rewire `src/cli/index.ts` `assemble()`** — remove the `AssrtClient` construction + `assrt:` block from `makeDeps`; add:
```ts
import { makeCliProviderPort } from '../core/providerPort.js'
// in makeDeps():
providers: makeCliProviderPort({
  onEvent: e => {
    if (e.event === 'api_call') journalRef?.apiCall({ endpoint: e.endpoint, params: { provider: e.provider }, status: e.status, durationMs: e.durationMs, error: e.error })
  },
}),
```
(`doctor.ts` keeps constructing its own `AssrtClient` for the health check — do not touch it.)
**Also verify writeSubtitle handles a bare-.srt artifact** (OpenSubtitles path): read `src/files/subtitleWriter.ts`; if it detects zip by magic bytes and falls through to raw for non-zip, add a test proving `.srt` bytes pass through; if it assumes zip unconditionally, add the non-zip branch (raw bytes + `artifactFilename` extension) with test.

- [ ] **Step 7: Update `src/core/pipeline.test.ts`** — replace mock `deps.assrt` with a mock `providers: ProviderPort` returning neutral candidates directly (fixtures: convert the ASSRT-shaped mocks with `toCandidate` inline in the test, or hand-write neutral candidates). `npx tsc --noEmit && npx vitest run` → green.

- [ ] **Step 8: Real-network integration smoke** (uses .env; ASSRT + OS live):
```bash
npx tsx -e '
import { makeCliProviderPort } from "./src/core/providerPort.js"
const port = makeCliProviderPort()
const cands = await port.search({ queries: ["Peacemaker 2022"], imdb: "tt13146488", season: 1, episode: 1, deep: false })
console.log(cands.length, "candidates;", [...new Set(cands.map(c => c.provider))])
'
```
Expected: `>0 candidates; [ 'assrt', 'opensubtitles' ]` (assrt may be 0 hits for this show — the provider LIST may then only show opensubtitles; that is fine, assert count > 0).

- [ ] **Step 9: Commit** — `git commit -am "feat(pipeline): all provider access through subtitle-fetch subprocess — ProviderPort bridge, unified path (Design Decision 5)"`

---

## Task 7: SQLite provider_ref migration + repo/dashboard updates

**Files:**
- Modify: `src/v2/db.ts` (append migration to the migrations array)
- Modify: `src/v2/libraryRepo.ts` (`markCovered` param), callers found by grep
- Test: `src/v2/db.test.ts` (or create `src/v2/migration.test.ts`)

- [ ] **Step 1: Write failing migration test** — open a temp db with the OLD schema version containing a subtitles row (`assrt_sub_id=673114`) and a blacklist row, run `openDb` (executes new migration), assert:
```ts
it('migrates assrt_sub_id to provider_ref', () => {
  // seed: run all migrations EXCEPT the new one (instantiate db at previous schema_version, insert rows via raw SQL)
  // then openDb(path) again → migration runs
  const sub = db.prepare('SELECT provider_ref FROM subtitles WHERE id = 1').get()
  expect(sub.provider_ref).toBe('assrt:673114')
  const bl = db.prepare('SELECT provider_ref, filename FROM blacklist').get()
  expect(bl.provider_ref).toBe('assrt:99')
})
```
(Look at how existing `db.test.ts` seeds versions — follow its pattern for "open at version N, reopen to migrate".)

- [ ] **Step 2: Append the migration** to the migrations array in `src/v2/db.ts`:
```sql
ALTER TABLE subtitles ADD COLUMN provider_ref TEXT;
UPDATE subtitles SET provider_ref = 'assrt:' || assrt_sub_id WHERE assrt_sub_id IS NOT NULL;
CREATE TABLE blacklist_v2 (
  provider_ref TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
  reason TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(provider_ref, filename)
);
INSERT INTO blacklist_v2 SELECT 'assrt:' || assrt_sub_id, filename, reason, created_at FROM blacklist;
DROP TABLE blacklist;
ALTER TABLE blacklist_v2 RENAME TO blacklist;
```
(Old `subtitles.assrt_sub_id` column stays in place — SQLite column drops are expensive and the column is now simply unwritten. `runs.assrt_calls` column name also stays; it now counts ALL provider calls — add a `-- counts all provider api calls since multi-source` comment.)

- [ ] **Step 3: Update writers/readers.** `libraryRepo.markCovered(itemId, subtitlePath, source, providerRef?: string)` — INSERT uses `provider_ref` instead of `assrt_sub_id`. Find every caller and blacklist consumer:
```bash
grep -rn "markCovered\|assrt_sub_id\|blacklist" src/ --include='*.ts' | grep -v test | grep -v db.ts
```
Update each site: numeric assrt id → `candidateKey(...)` string (in the executor the value comes from the pipeline result's `selected.provider + ':' + selected.provider_id`, threaded via `onCovered`/completion params — follow the existing data flow, keep signatures otherwise intact). Blacklist matching before rank now compares `candidateKey(candidate)` against `provider_ref`.

- [ ] **Step 4: `npx tsc --noEmit && npx vitest run` → green. Commit** — `git commit -am "feat(v2): provider_ref migration — subtitles/blacklist keyed by provider-neutral ref"`

---

## Task 8: Mock media library — fixtures generator + docker-compose.local.yml (Design Decision 6)

**Files:**
- Create: `scripts/gen-mock-library.sh`
- Create: `docker-compose.local.yml`
- Modify: `README.md` (short "Local dev / e2e" section) — keep to ~15 lines, match README's existing tone

- [ ] **Step 1: Write the generator** `scripts/gen-mock-library.sh`:
```bash
#!/usr/bin/env bash
# 生成 mock 媒体库：1 秒黑屏微型真视频（ffprobe 可探测，Jellyfin 正常刮削）。
# 用法: scripts/gen-mock-library.sh [outdir]   # 默认 fixtures/media
set -euo pipefail
OUT="${1:-fixtures/media}"
V="-f lavfi -i color=black:s=320x240:d=1 -c:v libx264 -pix_fmt yuv420p -y -loglevel error"

clip() { mkdir -p "$(dirname "$OUT/$1")"; ffmpeg $V "$OUT/$1"; }
clip_with_chi() {  # 内嵌 chi 字幕轨 → 测“已带中字跳过”负路径
  mkdir -p "$(dirname "$OUT/$1")"
  SRT=$(mktemp /tmp/mock-XXXX.srt)
  printf '1\n00:00:00,000 --> 00:00:01,000\n占位中文字幕\n' > "$SRT"
  ffmpeg -f lavfi -i color=black:s=320x240:d=1 -i "$SRT" \
    -map 0:v -map 1:s -c:v libx264 -pix_fmt yuv420p -c:s srt \
    -metadata:s:s:0 language=chi -y -loglevel error "$OUT/$1"
  rm -f "$SRT"
}

# —— 西剧（OpenSubtitles 主场；Peacemaker 是 ASSRT 已证零结果剧）——
for e in 1 2 3; do clip "TV/Peacemaker (2022)/Season 01/Peacemaker (2022) S01E0${e} 1080p.mkv"; done
for e in 1 2; do clip "TV/Young Sheldon (2017)/Season 01/Young Sheldon (2017) S01E0${e} 1080p.mkv"; done
# —— 华语路径（ASSRT 主场）——
for e in 1 2; do clip "TV/Love, Death & Robots (2019)/Season 03/Love, Death & Robots (2019) S03E0${e} 1080p.mkv"; done
# —— 负路径：自带内嵌中字，应判 embedded/skip ——
clip_with_chi "Movies/The Wandering Earth (2019)/The Wandering Earth (2019) 1080p.mkv"
# —— 负路径：国产片（SKIP_CHINESE_ORIGIN）——
clip "Movies/Hero (2002)/Hero (2002) 1080p.mkv"

echo "mock library written to $OUT:"
find "$OUT" -name '*.mkv' | sort
```
`chmod +x scripts/gen-mock-library.sh`. Add `fixtures/media/` to `.gitignore` (generated, not committed — the SCRIPT is the fixture).

- [ ] **Step 2: Run it, verify** — `scripts/gen-mock-library.sh && ffprobe -v error -show_streams "fixtures/media/Movies/The Wandering Earth (2019)/The Wandering Earth (2019) 1080p.mkv" | grep -A2 codec_type=subtitle` → shows the `chi` subtitle stream. All files < 50KB each.

- [ ] **Step 3: Write** `docker-compose.local.yml` (model on the existing `docker-compose.bundle.yml` — read it first; key differences: build scout from local source instead of ghcr image, mount `fixtures/media`, isolated cache dir):
```yaml
# OrbStack 本地全链路测试栈：Jellyfin + 本地构建 scout + mock 媒体库。
# 先跑 scripts/gen-mock-library.sh；首次起 Jellyfin 要过设置向导拿 API key（见 scripts/dev-jellyfin.sh）。
services:
  jellyfin:
    image: ghcr.io/jellyfin/jellyfin:latest
    ports: ["8096:8096"]
    volumes:
      - jellyfin-config-local:/config
      - ./fixtures/media:/media:ro
  subtitle-scout:
    build: .
    depends_on: [jellyfin]
    environment:
      JELLYFIN_URL: http://jellyfin:8096
      JELLYFIN_API_KEY: ${JELLYFIN_API_KEY}
      LLM_BASE_URL: ${LLM_BASE_URL}
      LLM_API_KEY: ${LLM_API_KEY}
      LLM_MODEL: ${LLM_MODEL}
      ASSRT_TOKEN: ${ASSRT_TOKEN}
      TMDB_API_KEY: ${TMDB_API_KEY}
      OPENSUBTITLES_API_KEY: ${OPENSUBTITLES_API_KEY}
      OPENSUBTITLES_USERNAME: ${OPENSUBTITLES_USERNAME}
      OPENSUBTITLES_PASSWORD: ${OPENSUBTITLES_PASSWORD}
      SUBTITLE_SCOUT_CACHE_DIR: /cache
      MEDIA_PATH_MAPPINGS: /media=/media
      MEDIA_ROOTS: /media
      DASHBOARD_PORT: "8099"
    ports: ["8099:8099"]
    volumes:
      - ./fixtures/media:/media          # 可写：sidecar 要落盘
      - ./cache-local:/cache
volumes:
  jellyfin-config-local:
```
Note the asymmetry is intentional: jellyfin mounts media read-only, scout mounts it writable (sidecar writes). Verify env var names against `docker-compose.yml` current passthrough list; keep identical naming.

- [ ] **Step 4: Validate compose file parses** — `docker compose -f docker-compose.local.yml config >/dev/null && echo OK`.

- [ ] **Step 5: README section** — under a `## Local development` heading: generate fixtures → `docker compose -f docker-compose.local.yml up -d` → Jellyfin wizard at `localhost:8096` (add `/media` as libraries, create API key) → set `JELLYFIN_API_KEY` in `.env` → restart scout → dashboard at `localhost:8099`.

- [ ] **Step 6: Commit** — `git commit -am "feat(dev): mock media library generator + docker-compose.local.yml — full e2e on OrbStack, zero NAS dependency (Design Decision 6)"`

---

## Task 9: Controller live e2e on OrbStack + Phase 1 sign-off (main loop runs this, NOT a subagent)

The controller (holding credentials + OrbStack) executes; this is the acceptance gate for the whole branch.

- [ ] **Step 1:** `scripts/gen-mock-library.sh` → `docker compose -f docker-compose.local.yml up -d --build` → complete Jellyfin wizard (libraries: `/media/TV` as Shows, `/media/Movies` as Movies) → API key into `.env` → `docker compose -f docker-compose.local.yml up -d subtitle-scout`.
- [ ] **Step 2: Acceptance checklist:**
  1. Reconcile mirrors all mock items; Peacemaker/Young Sheldon episodes become `wanted` jobs; Wandering Earth → `embedded`; Hero → skipped (Chinese origin).
  2. Peacemaker S01E01–03 jobs complete `done` with `provider: "opensubtitles"` in journal `selected` + real `.srt` sidecars on the fixtures volume (spot-check content is Chinese).
  3. LDR S03 exercises the ASSRT path end-to-end (season pack expected: journal shows providerSearch → rank → download with `provider: "assrt"`).
  4. Journals show `providerSearch` step + `api_call` entries relayed from the CLI (both providers), quota fields sane.
  5. Dashboard renders runs with no `assrt_id`-shaped leakage; SQLite `subtitles.provider_ref` populated (`sqlite3 cache-local/scout.db "SELECT provider_ref, path FROM subtitles"`).
  6. `subtitle-fetch resolve --provider opensubtitles` consumed quota exactly once per download (`remaining` decrements in journal api_call events).
  7. Kill + restart scout container mid-run: no crash, leases reaped, jobs resume.
- [ ] **Step 3:** Fix anything found (loop back to the owning task's code with a fix subagent), re-run.
- [ ] **Step 4:** Final adversarial code review of the whole branch (opus reviewer), addressing findings; then merge via superpowers:finishing-a-development-branch. Production NAS deploy stays FROZEN until user says go (spec: monitor-24h rollout plan).

---

## Self-Review Notes (done at plan time)

- **Spec coverage:** spec Phase-1 tasks 1–6 → Tasks 1+5; task 7 (OpenSubtitles) → Tasks 3+4; task 8 (planSearch provider dispatch) → superseded: structured args (`imdb/season/episode`) go to the CLI directly, OS needs no LLM queries, `planSearch` prompt untouched — this implements the spec's intent (IMDB exact match skips LLM planning) with less code; tasks 9–10 (fan-out + gems) → Tasks 2+4+6; tasks 11–12 (live test + sign-off) → Task 9. Design Decision 5 (unified CLI path) → Tasks 4+6. Design Decision 6 (mock library) → Task 8.
- **Deviations from spec, intentional:** (a) no deprecated `assrt_id` alias period — the neutral switch happens atomically inside Task 5 with tests, and the decision cache migrates on read instead; (b) `resolve` subcommand added to the CLI (spec's CLI contract only covered search) — required by Decision 5, since download-URL resolution is provider logic and must not live in-process.
- **Known risks for implementers:** `npx tsx` spawn adds ~1s per CLI call — acceptable (pipeline is minutes-scale, spec Decision 5). ASSRT 15s rate limiter now lives inside a short-lived subprocess; per-invocation limiting still holds within one search (2 queries + gems in one process), and the daemon's `concurrency.searching=1` keeps cross-process bursts impossible; `resolve` calls are single-shot. If ASSRT 429s appear in Task 9, add a shared rate-limit lockfile — do NOT preemptively build it (YAGNI).
