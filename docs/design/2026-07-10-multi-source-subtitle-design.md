# Multi-Source Subtitle Acquisition Design

**Date:** 2026-07-10  
**Status:** Draft for User Review  
**Context:** v2 state machine + media-library dashboard shipped. Current pain: 120 "unavailable" episodes because ASSRT genuinely lacks them. Strategy: expand beyond ASSRT to ALL usable sources ("能用上的都要用上，体现开源的强大"). Core insight: AI-era anti-bot targets the agent itself; the counter is also an agent — putting a browser inside the container as a breaking-through medium is acceptable.

---

## Design Principles

1. **One source at a time** — fully finish one provider (test + verify correct) before touching the next.
2. **Single aggregate CLI, two-level command** — NOT one CLI per site (that's dumb). One `subtitle-fetch` command that aggregates. Default invocation returns all sources that need NO browser anti-bot (fast). Only when the default returns nothing does the agent add `--deep` to invoke browser-mediated anti-bot sources. Agent mental burden = two steps max, like `git log` vs `git log --all`.
3. **Local testing first (OrbStack)** — purpose is "破防拿到字幕" not "为资源拿字幕"; get anti-bot working locally before deploying to NAS.
4. **Multimodal for captcha** — even simple digit captchas need multimodal vision model (we have company provider with no quota anxiety).
5. **Provider abstraction precedes integration** — refactor away `AssrtSub` / `assrt_id`焊死 first, then integrate new sources into clean interface.
6. **User-provided keys, we only offer the choice** — OpenSubtitles requires a user's own API key (we don't ship one; for testing we buy our own). Same principle as TMDB: recommend + support, don't provide the data source.
7. **Language separation** — aggregate CLI is TS (shares `SubtitleCandidate`/schemas/llm.ts with main codebase). Anti-bot sidecar is Python (Camoufox's official binding is Python/Playwright, most mature), but it's an HTTP black box — language is fully transparent to agent and main program, which only ever call `/solve`. No language mixing on the agent decision path.

---

## Architecture Overview

### Three Layers

```
┌─────────────────────────────────────────────────────────┐
│ subtitle-scout main (TS/Node, Vercel AI SDK)            │
│  - Scheduler: jobs/runs state machine                   │
│  - Provider abstraction: SubtitleCandidate interface    │
│  - Existing LLM agents: planSearch / rankCandidates     │
└────────────┬────────────────────────────────────────────┘
             │ CLI invocation (子进程 spawn)
             ↓
┌─────────────────────────────────────────────────────────┐
│ subtitle-fetch  (单一聚合 CLI, TS)                       │
│                                                          │
│  默认 (无 --deep): 聚合无需破防的源，秒回               │
│    ├─ ASSRT (search + gems: /similar, is_file)          │
│    └─ OpenSubtitles (REST, 用户自备 key)                │
│                                                          │
│  --deep (默认空结果时才追加): 动用浏览器破防源          │
│    ├─ zimuku   ─┐                                        │
│    └─ subf2m   ─┴─→ 走 sidecar HTTP                     │
│                                                          │
│  内部按 provider adapter 分派；统一输出 SubtitleCandidate[] │
└────────────┬────────────────────────────────────────────┘
             │ HTTP (仅 --deep 破防源)
             ↓
┌─────────────────────────────────────────────────────────┐
│ Anti-Bot Sidecar (独立容器 Python, OrbStack 本地测试)   │
│  - Camoufox (headful Firefox + Xvfb)                    │
│  - 单浏览器实例 + 多标签页池 (共享指纹/cookie/session)  │
│  - Vision LLM (多模态读数字验证码，替代 ddddocr)        │
│  - FlareSolverr (可选前置，纯 CF 快路)                  │
│  - 暴露 HTTP API: /solve {url,action} → {cookies,html}  │
└─────────────────────────────────────────────────────────┘
             │ network
             ↓
┌─────────────────────────────────────────────────────────┐
│ Subtitle Sites (zimuku/subf2m/OpenSubtitles/ASSRT)      │
└─────────────────────────────────────────────────────────┘
```

### The Aggregate CLI Contract

```bash
# 默认：无需破防的源聚合，秒回
subtitle-fetch --query "爱，死亡和机器人" --year 2022 --season 3 --imdb tt9561862 --format json
# → [ ...ASSRT candidates, ...OpenSubtitles candidates ]  (JSON array to stdout)

# 空结果时，agent 追加 --deep：动用浏览器破防源
subtitle-fetch --query "爱，死亡和机器人" --year 2022 --season 3 --deep --format json
# → [ ...zimuku candidates, ...subf2m candidates ]  (via sidecar)
```

Agent decision loop:
1. Run `subtitle-fetch <args>` (no `--deep`) — cheap, no browser.
2. If output is `[]` (or below quality threshold after rank), re-run with `--deep`.
3. Feed merged candidates into existing `rankCandidates`.

Internally the CLI holds a per-provider adapter registry (borrowing OpenCLI's pluggable-adapter shape, but as one binary not N binaries). `--deep` simply toggles which adapters are enabled.

### Provider Classification (by anti-bot need)

| Provider | Anti-Bot? | Integration Phase | Notes |
|----------|-----------|-------------------|-------|
| **OpenSubtitles.com** | ❌ No (official REST API) | Phase 1 | Best for Western shows (Young Sheldon, True Detective, Peacemaker S1); IMDB exact match → skip LLM query planning; **user-provided key** (`OPENSUBTITLES_API_KEY`, optional — provider disabled if absent, same model as TMDB); free registered user **20 downloads/day** (live-verified 2026-07-10: `/login` returns `allowed_downloads: 20`), VIP 1000/day; /login → JWT, /search → /download (charged on download, not search). We buy our own key for testing. |
| **ASSRT gems** | ❌ No (existing stable API) | Phase 1 | Two white-pickup endpoints: `/sub/similar` (pass hit id → 5 similar subs, free recall expansion), `is_file=1` (filename fallback query). No IMDB query capability confirmed. |
| **zimuku** | ✅ Yes (yunsuo cloud-lock + digit captcha) | Phase 2 | Largest Chinese increment; Bazarr `zimuku.py` reference; domain drift (srtku.com / zimuku.org / zmk.pw) → must configurable `base_url`; digit captcha → vision LLM |
| **subf2m.co** | ✅ Yes (CF + occasional captcha) | Phase 2 | Native IMDB search; less captcha than zimuku; Bazarr has impl |

**Excluded:** SubHD (anti-crawl hell), B站/爱优腾 reverse (DRM + legal + account-ban + open-source compliance triple-mine).

### Responsibility Boundaries

- **Sidecar**: ONLY "get the page" (execute JS, pass CF, solve captcha, return cookie + HTML). Zero subtitle business logic. Python container, HTTP black box — its language never touches the agent path.
- **Aggregate CLI (`subtitle-fetch`, TS)**: Parse args → dispatch to enabled provider adapters (default = no-anti-bot set; `--deep` = also anti-bot set) → each adapter [calls sidecar if needed] → parse HTML/JSON → merge into `SubtitleCandidate[]` → output JSON to stdout. Agent reads stdout, zero internal knowledge of how any provider or the sidecar works.
- **Main program**: Invoke `subtitle-fetch` as subprocess (retry with `--deep` on empty), parse JSON, feed into existing `rankCandidates` flow.

---

## Data Model: Provider-Neutral Abstraction

### Before (ASSRT-焊死)

```ts
// schemas.ts RankDecisionSchema
{
  decision: 'download',
  assrt_id: 12345,        // ← ASSRT-specific
  file_index: 0,          // ← ASSRT filelist index
  confidence: 0.92,
}

// assrt.ts
type AssrtSub = { id, videoname, native_name, filelist, ... }
```

**Problem:** `assrt_id` / `file_index` / `AssrtSub` spread across schemas.ts, pipeline.ts, rankCandidates.ts, gate.ts, executor.ts. Adding OpenSubtitles/zimuku requires forking all of these.

### After (Provider-Neutral)

```ts
// schemas.ts — new unified candidate
export type SubtitleCandidate = {
  provider: 'assrt' | 'opensubtitles' | 'zimuku' | 'subf2m'
  providerId: string           // ASSRT id / OpenSubtitles file_id / zimuku download token
  videoName: string | null     // display name (e.g. "Love.Death.Robots.S03E01.1080p")
  nativeName: string | null    // original Chinese title if available
  language: string             // 'zh-Hans' | 'zh-Hant' | 'en' etc.
  uploadDate?: string
  fileList: SubtitleFile[]     // may be empty for single-file providers
}

export type SubtitleFile = {
  index: number                // 0 for single-file
  name: string                 // filename
  size?: number
}

// RankDecisionSchema
{
  decision: 'download',
  candidate: {                 // ← replaces assrt_id + file_index
    provider: 'opensubtitles',
    providerId: 'abc123',
    fileIndex: 0,
  },
  identity_match: 'confirmed',
  confidence: 0.92,
}
```

### Download Flow (Provider-Agnostic)

```ts
// executor.ts (conceptual)
async function executeDownload(decision: RankDecision): Promise<void> {
  const { provider, providerId, fileIndex } = decision.candidate
  
  // Dispatch to provider adapter
  const adapter = getProviderAdapter(provider)
  const downloadUrl = await adapter.resolveDownloadUrl(providerId, fileIndex)
  
  // Existing: fetch + unzip + write (unchanged)
  const zipBuffer = await fetch(downloadUrl).then(r => r.arrayBuffer())
  // ... rest same
}

// adapters/providers/assrt.ts
class AssrtAdapter implements ProviderAdapter {
  async resolveDownloadUrl(providerId: string, fileIndex: number): Promise<string> {
    const detail = await this.getDetail(parseInt(providerId))
    return detail.sub.subs[0].filelist[fileIndex].url
  }
}

// adapters/providers/opensubtitles.ts
class OpenSubtitlesAdapter implements ProviderAdapter {
  async resolveDownloadUrl(providerId: string, fileIndex: number): Promise<string> {
    // POST /download with file_id, returns {link, remaining_downloads}
    const res = await this.apiCall('/download', { file_id: parseInt(providerId) })
    return res.link
  }
}
```

**Migration note:** `rankCandidates.ts` prompt is already provider-agnostic (refers to "candidates" generically). `planSearch.ts` needs per-provider query semantics (ASSRT = Chinese title variants; OpenSubtitles = IMDB id if available, else title+year).

---

## Implementation Phases

### Phase 1: Provider Abstraction + No-Anti-Bot Sources

**Goal:** Refactor `SubtitleCandidate` abstraction + integrate OpenSubtitles + ASSRT gems, with ZERO anti-bot work. Prove abstraction works before touching sidecar.

#### Tasks (严格顺序，一次一个验收)

1. **Refactor schemas.ts**
   - Add `SubtitleCandidate` / `SubtitleFile` types
   - Change `RankDecisionSchema.candidate` from `{assrt_id, file_index}` to `{provider, providerId, fileIndex}`
   - Keep `assrt_id` / `file_index` as deprecated aliases during migration (populate both), remove after Phase 1 verified

2. **Refactor adapters/providers/assrt.ts**
   - Add `toCandidate(sub: AssrtSub): SubtitleCandidate` converter
   - Modify `search()` to return `SubtitleCandidate[]` instead of `AssrtSub[]`
   - Implement `AssrtAdapter.resolveDownloadUrl(providerId, fileIndex)` (wraps existing `getDetail`)

3. **Update pipeline.ts search stage**
   - Change `const results: AssrtSub[]` → `const candidates: SubtitleCandidate[]`
   - Pass `SubtitleCandidate[]` to `rankCandidates`

4. **Update rankCandidates.ts**
   - Input: `SubtitleCandidate[]` (was `AssrtSub[]`)
   - Output: `RankDecision.candidate` (was `assrt_id + file_index`)
   - Prompt already provider-agnostic, no LLM changes needed

5. **Update executor.ts download stage**
   - Replace direct ASSRT detail call with provider adapter dispatch
   - Test: download ASSRT subtitle via new path, verify bit-identical to old path

6. **Verify Phase 1 ASSRT-only**: Run full pipeline on 5 test shows, confirm downloads succeed, compare journals to pre-refactor baseline

7. **Add OpenSubtitles adapter** (`adapters/providers/opensubtitles.ts`)
   - Implement `OpenSubtitlesAdapter.search(imdbId?, title, year, season?, episode?)` → `SubtitleCandidate[]`
   - Implement `OpenSubtitlesAdapter.resolveDownloadUrl(file_id)` → download link
   - **API detail (from official docs, verified 2026-07-10):**
     - Base URL: `https://api.opensubtitles.com/api/v1`
     - Headers (ALL requests): `Api-Key: <key>`, `User-Agent: subtitle-scout v<version>`
     - `POST /login` body `{username, password}` → `{token, base_url, user: {allowed_downloads, vip}}`. **Switch to returned `base_url` for all subsequent requests**; if `base_url == "vip-api.opensubtitles.com"`, JWT required on every request.
     - `GET /subtitles?parent_imdb_id=<id>&season_number=<s>&episode_number=<e>&languages=zh-cn,zh-tw` (episodes) or `?imdb_id=<id>&languages=zh-cn,zh-tw` (movies). **languages MUST be lowercase** (uppercase `zh-CN` → 301 redirect loop; live-verified 2026-07-10). Use `curl -L`-equivalent (follow redirects) regardless. **No download quota consumed.** Response: `data[].attributes.files[].file_id`.
     - `POST /download` body `{file_id}` (requires both `Api-Key` + `Authorization: Bearer <JWT>` unless dev_mode) → `{link, remaining, reset_time_utc}`. **Quota consumed here, NOT on actual file GET.** `link` is temporary (3h valid); GET returns the **bare UTF-8 .srt directly — NOT a ZIP** (live-verified 2026-07-10; unlike ASSRT, no unzip step).
   - **Dev mode**: Set consumer to "Under Development" in https://www.opensubtitles.com/en/consumers → **100 downloads/day without user auth**. Production: user provides `OPENSUBTITLES_USERNAME` + `OPENSUBTITLES_PASSWORD` (env vars) for login, or skip provider if absent.
   - Env: `OPENSUBTITLES_API_KEY` (required for this provider), `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD` (optional; if missing, disable download—search still works in dev_mode)

8. **Update planSearch.ts**: Add provider dispatch logic
   - If `provider_ids.imdb` exists → OpenSubtitles IMDB exact query (skip LLM planning for this provider)
   - Else → existing LLM Chinese-title-variant logic for ASSRT
   - Return `{provider, queries}[]` array instead of flat `queries[]`

9. **Update pipeline.ts**: Fan-out to multiple providers
   - `const allCandidates = await Promise.all([assrtAdapter.search(...), osAdapter.search(...)])`
   - Merge into single `SubtitleCandidate[]`, pass to `rankCandidates` (LLM sees all sources together, picks best)

10. **ASSRT gems integration** (`adapters/providers/assrt.ts` additions)
    - Add `searchSimilar(assrtId: number)` → calls `/sub/similar`, converts to `SubtitleCandidate[]`
    - Add `searchByFilename(filename: string)` → calls `/sub/search?is_file=1`, converts to candidates
    - Hook into pipeline: after main ASSRT search, if results > 0, call `searchSimilar` on top hit for recall expansion; if results === 0, call `searchByFilename` as final fallback

11. **Phase 1 live test (OrbStack local)**
    - Pick 3 Western shows (Young Sheldon / True Detective / Peacemaker S1) + 2 Chinese shows
    - Run daemon, verify OpenSubtitles hits for Western, ASSRT for Chinese, ASSRT gems fires on zero-result fallback
    - Check journals: `decision.candidate.provider` correctly logged

12. **Phase 1 sign-off**: User reviews journals + downloaded subtitles, confirms abstraction works before Phase 2

---

### Phase 2: Anti-Bot Sidecar + zimuku/subf2m

**Goal:** Build sidecar container + CLI tools for anti-bot sources. OrbStack local testing only (no NAS deployment yet).

#### Anti-Bot Sidecar Spec

**Container:** `subtitle-scout-antibot` (独立于主 `subtitle-scout` 容器)

**Stack:**
- **Base:** `ubuntu:22.04` or `debian:bookworm` (arm64 support)
- **Browser:** Camoufox (Firefox-based anti-detect, compile-level fingerprint spoofing)
  - Install: fetch pre-built Camoufox binary for arm64 (check daijro/camoufox releases)
  - Xvfb for headful mode in headless container (`Xvfb :99 -screen 0 1920x1080x24`)
  - Playwright-python (Camoufox's official binding) to drive browser
  - **Concurrency model: single browser instance + tab pool (BrowserContext with multiple pages)** — NOT multiple browser instances. Tabs share fingerprint/cookie/session, lower RAM. Requests queue if all tabs busy.
- **Captcha solver:** Vision LLM (Claude Haiku 4.5 multimodal for simple digit captchas)
  - API call to main program's LLM runtime (company provider, no quota anxiety)
  - Input: screenshot of captcha image element
  - Output: recognized digits as string
- **Optional:** FlareSolverr (pre-filter for plain Cloudflare challenges, faster than full Camoufox)

**API Design:**

```typescript
// HTTP POST /solve
{
  url: string,
  action: 'get_html' | 'solve_captcha',
  selector?: string,          // CSS selector for captcha image (solve_captcha only)
  waitForSelector?: string,   // wait for element after page load
}

// Response
{
  success: boolean,
  cookies: Cookie[],          // for action=get_html
  html: string,               // for action=get_html
  captchaText?: string,       // for action=solve_captcha
  screenshot?: string,        // base64 PNG (debugging)
  error?: string,
}
```

**Deployment (OrbStack local testing):**
- `docker-compose.local.yml` adds `antibot` service, exposes port 9000
- Main program env: `ANTIBOT_SIDECAR_URL=http://antibot:9000` (container network) or `http://localhost:9000` (host testing)

#### The Aggregate CLI (Replaces Per-Provider CLIs)

**Location:** `src/cli/subtitle-fetch.ts` (single entry point, compiled to `dist/cli/subtitle-fetch.js`)

**Interface:**

```bash
# Default: aggregate NO-anti-bot sources (ASSRT + OpenSubtitles + ASSRT gems), instant
subtitle-fetch --query "爱，死亡和机器人" --year 2022 --season 3 --imdb tt9561862 --format json
# → [ ...ASSRT candidates, ...OpenSubtitles candidates, ...ASSRT gems ]

# Empty result or below quality threshold → agent retries with --deep
subtitle-fetch --query "..." --year 2022 --season 3 --deep --format json
# → [ ...zimuku candidates (via sidecar), ...subf2m candidates (via sidecar) ]

# Output: JSON array of SubtitleCandidate to stdout (all sources merged)
[
  {"provider": "assrt", "providerId": "12345", ...},
  {"provider": "opensubtitles", "providerId": "file_abc", ...},
  {"provider": "zimuku", "providerId": "dl_token_xyz", ...}
]

# Errors: JSON to stderr + exit code 1
{"error": "Captcha solve failed on zimuku", "details": "..."}
```

**Internal architecture (inspired by OpenCLI's pluggable adapters):**

```typescript
// src/cli/subtitle-fetch.ts
import { parseArgs } from 'node:util'
import type { SubtitleCandidate } from '../core/schemas.js'

// Provider adapter interface
interface ProviderAdapter {
  enabled(args: FetchArgs, deep: boolean): boolean  // is this adapter active for this invocation?
  search(args: FetchArgs): Promise<SubtitleCandidate[]>
}

// Adapters registry
const ADAPTERS: ProviderAdapter[] = [
  assrtAdapter,           // enabled: !deep (default set)
  assrtGemsAdapter,       // enabled: !deep
  openSubtitlesAdapter,   // enabled: !deep && env.OPENSUBTITLES_API_KEY exists
  zimukuAdapter,          // enabled: deep  (anti-bot set)
  subf2mAdapter,          // enabled: deep
]

async function main() {
  const { values } = parseArgs({
    options: {
      query: { type: 'string' },
      year: { type: 'string' },
      season: { type: 'string' },
      imdb: { type: 'string' },
      deep: { type: 'boolean', default: false },
      format: { type: 'string', default: 'json' },
    },
  })

  const args: FetchArgs = { query: values.query!, year: values.year, season: values.season, imdb: values.imdb }
  const enabledAdapters = ADAPTERS.filter(a => a.enabled(args, values.deep!))

  // Fan-out: run all enabled adapters concurrently
  const results = await Promise.all(enabledAdapters.map(a => a.search(args).catch(err => {
    console.error(JSON.stringify({ provider: a.name, error: err.message }))
    return []  // fail-soft: one provider's failure doesn't kill the whole CLI
  })))

  // Merge + output
  const candidates = results.flat()
  console.log(JSON.stringify(candidates, null, 2))
}
```

**Anti-bot adapters (zimuku/subf2m)** internally call the sidecar HTTP `/solve` endpoint, same flow as the old per-provider CLI examples. Default adapters (ASSRT/OpenSubtitles) never touch the sidecar.

#### Tasks (Phase 2, 严格顺序)

1. **Build sidecar Dockerfile** (`deploy/antibot/Dockerfile`)
   - Python base, install Xvfb, Camoufox, Playwright-python
   - Expose Flask/FastAPI HTTP server on port 9000
   - `/solve` endpoint: handle `get_html` (navigate in tab + return HTML + cookies) and `solve_captcha` (screenshot → LLM → text)
   - Tab pool: pre-warm 2 tabs (BrowserContext), queue requests if busy

2. **Test sidecar locally (OrbStack)**
   - `docker build -t subtitle-scout-antibot deploy/antibot`
   - `docker run -p 9000:9000 subtitle-scout-antibot`
   - `curl -X POST http://localhost:9000/solve -d '{"url":"https://httpbin.org/html","action":"get_html"}'` → verify returns HTML
   - `curl -X POST http://localhost:9000/solve -d '{"url":"https://zimuku.org","action":"get_html"}'` → verify passes yunsuo (check HTML for actual content, not block page)

3. **Extend aggregate CLI with zimuku adapter** (`src/cli/subtitle-fetch.ts`)
   - Add `zimukuAdapter: ProviderAdapter` to registry, `enabled: (_, deep) => deep`
   - Implement `zimukuAdapter.search()`: call sidecar → parse HTML (Bazarr zimuku.py selectors) → return `SubtitleCandidate[]`
   - Test standalone: `subtitle-fetch --query "爱，死亡和机器人" --deep --format json` → verify zimuku candidates in output

4. **Integrate zimuku into pipeline**
   - Modify `pipeline.ts` to invoke `subtitle-fetch --deep` on empty default result
   - Test: run daemon on 1 Chinese show known to exist on zimuku, verify candidate appears in journal with `provider: "zimuku"`

5. **Extend aggregate CLI with subf2m adapter** (same pattern as zimuku)

6. **Integrate subf2m into pipeline**

7. **Phase 2 live test (OrbStack local)**
   - Pick 3 Chinese shows (at least one with captcha on zimuku)
   - Run daemon, verify default → `--deep` fallback flow working
   - Check sidecar logs: tab reuse working, captcha solve success rate
   - Check journals: all 4 providers firing (ASSRT, OpenSubtitles, zimuku, subf2m), LLM `rankCandidates` picking best across sources

8. **Phase 2 sign-off**: User reviews multi-source results, confirms anti-bot working locally

---

## Migration & Rollout Strategy

1. **Phase 1 merge to main**: After user sign-off, merge provider abstraction + OpenSubtitles + ASSRT gems
   - Deploy to NAS production (existing ASSRT flow unchanged, OpenSubtitles optional via env flag)
   - Monitor for 24h: verify no regressions on existing ASSRT-only flow

2. **Phase 2 OrbStack testing only**: Do NOT deploy sidecar to NAS until local testing complete
   - User validates zimuku/subf2m quality on local machine first
   - Decision point: if anti-bot sources produce too many false positives, may backlog indefinitely; if quality good, proceed to NAS deployment

3. **NAS deployment (future, not in this spec)**
   - Add `antibot` service to production `docker-compose.yml` on NAS
   - Env flag: `ENABLE_ANTIBOT_PROVIDERS=true` (default false, manual flip after validation)
   - Soft launch: enable for 10 test shows only, human review downloads for 1 week

---

## Success Metrics

**Phase 1 (provider abstraction):**
- Zero regression: existing ASSRT flow produces identical downloads to pre-refactor
- OpenSubtitles coverage: at least 50% of Western shows (Young Sheldon, True Detective, Peacemaker) get candidates
  - **Pre-verified 2026-07-10 (live smoke test with real key, dev_mode):** Peacemaker S1 = 8 zh-CN subs covering E1–E7 (the ASSRT-zero show!); Young Sheldon S1 = 44; True Detective S1 = 26. Download chain end-to-end verified: `/download` without user auth in dev_mode → link → bare UTF-8 .srt with correct Simplified Chinese content. `remaining=99/100`, resets daily UTC midnight.
- ASSRT gems recall: at least 10% of zero-result searches get candidates from `/sub/similar` or `is_file=1`

**Phase 2 (anti-bot sources):**
- Sidecar uptime: >95% successful `/solve` calls (no crash, no CF block)
- Captcha solve rate: >90% success on zimuku digit captchas
- Quality: download top-ranked zimuku/subf2m subtitle for 10 test episodes, human verify: <20% mismatch rate (if >20%, backlog anti-bot sources, Phase 1 still ships)

---

## Out of Scope (Explicitly Deferred)

- **Dashboard v3 activity feed**: Backlogged, design research done (three time layers), will resume after subtitle acquisition stable
- **Ask-user flow for uncertain candidates**: Backlogged (M-3 audit Minor), low priority now that identity 3-state verdict covers most cases
- **Season-pack graduation logic**: Already implemented in v2, not changed in this spec
- **TMDB alternative_titles full integration**: Queued but not blocking multi-source (Phase 1 works with existing getChineseTitle zh-TW ladder)
- **NAS deployment of anti-bot sidecar**: Phase 2 delivers OrbStack-local testing only; NAS deployment separate decision after user validates quality

---

## Design Decisions (User Confirmed)

1. **OpenSubtitles = user-provided key** — We only offer the choice (env `OPENSUBTITLES_API_KEY` optional, provider disabled if absent, same model as TMDB). For testing we buy our own. Free registered tier 20 downloads/day (live-verified), VIP $3/month = 1000/day. User decides whether to pay. Test account credentials installed in .env (`OPENSUBTITLES_USERNAME`/`OPENSUBTITLES_PASSWORD`); production login path live-verified 2026-07-10 (200 → JWT, `allowed_downloads: 20`, `base_url` unchanged for non-VIP).

2. **Anti-bot provider quality bar** — If zimuku/subf2m produce >20% mismatch in Phase 2 testing, ship Phase 1 only (OpenSubtitles + ASSRT gems) and backlog anti-bot indefinitely. Quality gate stands.

3. **Language separation resolved** — Aggregate CLI is **TS** (shares `SubtitleCandidate`/schemas/llm.ts with main codebase, consistency). Anti-bot sidecar is **Python** (Camoufox's official binding, most mature) but it's an HTTP black box — language never touches agent path.

4. **Sidecar concurrency model clarified** — **Single browser instance + tab pool (BrowserContext with multiple pages)**, NOT multiple browser instances. Tabs share fingerprint/cookie/session, lower RAM. Requests queue if all tabs busy. Address resource limits at NAS deployment phase if needed (current spec: tab pool of 2 for OrbStack testing).

---

**Next Step:** User reviews this spec. If approved, invoke `writing-plans` skill to break Phase 1 into concrete implementation tasks (TDD, isolated worktree per implementer, adversarial code review). Phase 2 spec remains design-only until Phase 1 ships.
