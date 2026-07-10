# Multi-Source Subtitle Acquisition Design

**Date:** 2026-07-10  
**Status:** Draft for User Review  
**Context:** v2 state machine + media-library dashboard shipped. Current pain: 120 "unavailable" episodes because ASSRT genuinely lacks them. Strategy: expand beyond ASSRT to ALL usable sources ("能用上的都要用上，体现开源的强大"). Core insight: AI-era anti-bot targets the agent itself; the counter is also an agent — putting a browser inside the container as a breaking-through medium is acceptable.

---

## Design Principles

1. **One source at a time** — fully finish one provider (test + verify correct) before touching the next.
2. **CLI-ify subtitle fetching** — agent uses subtitle tools with **zero mental burden**; tool internals handle anti-bot + DOM parsing + data cleaning, return clean structured data to agent as if "using a browser in the terminal" (inspired by OpenCLI's per-site pluggable adapter pattern).
3. **Local testing first (OrbStack)** — purpose is "破防拿到字幕" not "为资源拿字幕"; get anti-bot working locally before deploying to NAS.
4. **Multimodal for captcha** — even simple digit captchas need multimodal vision model (we have company provider with no quota anxiety).
5. **Provider abstraction precedes integration** — refactor away `AssrtSub` / `assrt_id`焊死 first, then integrate new sources into clean interface.

---

## Architecture Overview

### Three Layers

```
┌─────────────────────────────────────────────────────────┐
│ subtitle-scout main (TS/Node)                           │
│  - Scheduler: jobs/runs state machine                   │
│  - Provider abstraction: SubtitleCandidate interface    │
│  - Existing LLM agents: planSearch / rankCandidates     │
└────────────┬────────────────────────────────────────────┘
             │ CLI invocation (子进程 spawn)
             ↓
┌─────────────────────────────────────────────────────────┐
│ Per-Provider CLI Tools (独立可执行 TS 脚本)              │
│  - subtitle-cli-opensubtitles                           │
│  - subtitle-cli-zimuku (需破防)                         │
│  - subtitle-cli-subf2m (需破防)                         │
│  - subtitle-cli-assrt-gems (新端点，无需破防)           │
│                                                          │
│ 职责：query → [破防 sidecar] → parse DOM → 输出 JSON    │
│ 输出格式：SubtitleCandidate[]（统一接口）               │
└────────────┬────────────────────────────────────────────┘
             │ HTTP (仅破防 CLI)
             ↓
┌─────────────────────────────────────────────────────────┐
│ Anti-Bot Sidecar (独立容器，OrbStack 本地测试)          │
│  - Camoufox (headful Firefox + Xvfb)                    │
│  - Vision LLM (多模态读验证码，替代 ddddocr)            │
│  - FlareSolverr (可选前置，纯 CF 快路)                  │
│  - 暴露 HTTP API: /solve {url,action} → {cookies,html}  │
└─────────────────────────────────────────────────────────┘
             │ network
             ↓
┌─────────────────────────────────────────────────────────┐
│ Subtitle Sites (zimuku/subf2m/OpenSubtitles/ASSRT)      │
└─────────────────────────────────────────────────────────┘
```

### Provider Classification (by anti-bot need)

| Provider | Anti-Bot? | Integration Phase | Notes |
|----------|-----------|-------------------|-------|
| **OpenSubtitles.com** | ❌ No (official REST API) | Phase 1 | Best for Western shows (Young Sheldon, True Detective, Peacemaker S1); IMDB exact match → skip LLM query planning; free 10 downloads/day/user, VIP 1000/day; env `OPENSUBTITLES_API_KEY`; /login → JWT, /search → /download (charged on download, not search) |
| **ASSRT gems** | ❌ No (existing stable API) | Phase 1 | Two white-pickup endpoints: `/sub/similar` (pass hit id → 5 similar subs, free recall expansion), `is_file=1` (filename fallback query). No IMDB query capability confirmed. |
| **zimuku** | ✅ Yes (yunsuo cloud-lock + digit captcha) | Phase 2 | Largest Chinese increment; Bazarr `zimuku.py` reference; domain drift (srtku.com / zimuku.org / zmk.pw) → must configurable `base_url`; digit captcha → vision LLM |
| **subf2m.co** | ✅ Yes (CF + occasional captcha) | Phase 2 | Native IMDB search; less captcha than zimuku; Bazarr has impl |

**Excluded:** SubHD (anti-crawl hell), B站/爱优腾 reverse (DRM + legal + account-ban + open-source compliance triple-mine).

### Responsibility Boundaries

- **Sidecar**: ONLY "get the page" (execute JS, pass CF, solve captcha, return cookie + HTML). Zero subtitle business logic.
- **Per-provider CLI**: Take query args → [call sidecar if needed] → parse HTML (fixed XPath/CSS selectors OR LLM-generated rules) → extract subtitle list → output `SubtitleCandidate[]` JSON to stdout. Agent reads stdout, zero internal knowledge of how sidecar works.
- **Main program**: Invoke CLI as subprocess, parse JSON, feed into existing `rankCandidates` flow.

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
   - Implement `OpenSubtitlesAdapter.search(imdbId?, title, year)` → `SubtitleCandidate[]`
   - Implement `OpenSubtitlesAdapter.resolveDownloadUrl(file_id)` → download link
   - API: `POST /login` (api_key → JWT), `GET /subtitles` (query), `POST /download` (file_id → link + quota decrement)
   - Env: `OPENSUBTITLES_API_KEY` (optional; if missing, skip this provider)

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
  - Playwright or patchright-python to drive Camoufox
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

#### Per-Provider CLI Tools

**Location:** `src/cli/subtitle-fetch/` (independent TS scripts, compiled to `dist/cli/subtitle-fetch/`)

**Naming:** `subtitle-cli-{provider}.ts` → `node dist/cli/subtitle-fetch/subtitle-cli-zimuku.js --query "..." --format json`

**Interface (all providers):**

```bash
# Input: query args (vary by provider)
node dist/cli/subtitle-fetch/subtitle-cli-zimuku.js \
  --query "爱，死亡和机器人 第3季" \
  --year 2022 \
  --season 3 \
  --format json

# Output: JSON array of SubtitleCandidate to stdout
[
  {
    "provider": "zimuku",
    "providerId": "dl_token_abc123",
    "videoName": "Love.Death.Robots.S03E01.1080p.WEB-DL",
    "nativeName": "爱，死亡和机器人",
    "language": "zh-Hans",
    "fileList": [{"index": 0, "name": "ldr_s03e01.srt", "size": 12345}]
  }
]

# Errors: JSON to stderr + exit code 1
{"error": "Captcha solve failed", "details": "..."}
```

**Implementation (zimuku example):**

```typescript
// src/cli/subtitle-fetch/subtitle-cli-zimuku.ts
import { parseArgs } from 'node:util'
import { chromium } from 'patchright' // or fetch if sidecar does all browser work

async function main() {
  const { values } = parseArgs({
    options: {
      query: { type: 'string' },
      year: { type: 'string' },
      season: { type: 'string' },
      format: { type: 'string', default: 'json' },
    },
  })

  const antibot = process.env.ANTIBOT_SIDECAR_URL || 'http://localhost:9000'
  
  // Step 1: Get search results page via sidecar
  const searchUrl = `https://zimuku.org/search?q=${encodeURIComponent(values.query!)}`
  const resp = await fetch(`${antibot}/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: searchUrl, action: 'get_html' }),
  })
  const { html, cookies } = await resp.json()

  // Step 2: Parse HTML with cheerio (fixed selectors, learned from Bazarr zimuku.py)
  const $ = cheerio.load(html)
  const candidates: SubtitleCandidate[] = []
  $('.search-result .item').each((i, el) => {
    const title = $(el).find('.title').text().trim()
    const downloadToken = $(el).find('a.download').attr('href')?.match(/dl=([^&]+)/)?.[1]
    if (downloadToken) {
      candidates.push({
        provider: 'zimuku',
        providerId: downloadToken,
        videoName: title,
        nativeName: null, // extract if available
        language: 'zh-Hans', // infer from page
        fileList: [{ index: 0, name: `${title}.srt` }],
      })
    }
  })

  // Step 3: Output JSON
  console.log(JSON.stringify(candidates, null, 2))
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message, stack: err.stack }))
  process.exit(1)
})
```

**Captcha flow (if page requires):**
1. CLI detects captcha presence (e.g. `$('.captcha-img').length > 0`)
2. CLI calls sidecar `POST /solve { action: 'solve_captcha', selector: '.captcha-img' }`
3. Sidecar: screenshot captcha element → send to vision LLM → return recognized text
4. CLI: submit captcha text → retry page fetch

#### Tasks (Phase 2, 严格顺序)

1. **Build sidecar Dockerfile** (`deploy/antibot/Dockerfile`)
   - Install Xvfb, Camoufox, patchright-python
   - Expose Flask/FastAPI HTTP server on port 9000
   - `/solve` endpoint: handle `get_html` (navigate + return HTML + cookies) and `solve_captcha` (screenshot → LLM → text)

2. **Test sidecar locally (OrbStack)**
   - `docker build -t subtitle-scout-antibot deploy/antibot`
   - `docker run -p 9000:9000 subtitle-scout-antibot`
   - `curl -X POST http://localhost:9000/solve -d '{"url":"https://httpbin.org/html","action":"get_html"}'` → verify returns HTML
   - `curl -X POST http://localhost:9000/solve -d '{"url":"https://zimuku.org","action":"get_html"}'` → verify passes yunsuo (check HTML for actual content, not block page)

3. **Build subtitle-cli-zimuku**
   - Implement search flow (call sidecar → parse HTML → output JSON)
   - Test standalone: `node dist/cli/subtitle-fetch/subtitle-cli-zimuku.js --query "爱，死亡和机器人" --format json` → verify JSON output

4. **Integrate zimuku into pipeline**
   - Add `adapters/providers/zimuku.ts` wrapper that spawns CLI subprocess, parses JSON stdout
   - Add to provider fan-out in `pipeline.ts`
   - Test: run daemon on 1 Chinese show known to exist on zimuku, verify candidate appears in journal

5. **Build subtitle-cli-subf2m** (same pattern as zimuku)

6. **Integrate subf2m into pipeline**

7. **Phase 2 live test (OrbStack local)**
   - Pick 3 Chinese shows (at least one with captcha on zimuku)
   - Run daemon, verify zimuku/subf2m candidates merge with ASSRT/OpenSubtitles
   - Check sidecar logs: captcha solve success rate
   - Check journals: all 4 providers firing, LLM `rankCandidates` picking best across sources

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

## Open Questions for User

1. **OpenSubtitles VIP account**: Free tier = 10 downloads/day. For heavy use, should we budget for VIP ($3/month = 1000 downloads/day)? Or acceptable to exhaust free quota and fall back to other sources?

2. **Anti-bot provider quality bar**: If zimuku/subf2m produce >20% mismatch rate in Phase 2 testing, acceptable to ship Phase 1 only (OpenSubtitles + ASSRT gems) and backlog anti-bot indefinitely? Or is "拿到字幕" more important than accuracy (manual review workflow instead)?

3. **CLI tool language**: Current spec uses TS (consistency with main codebase). Alternative: Python (Bazarr reference code directly portable, richer anti-bot ecosystem). Preference?

4. **Sidecar resource limits**: Camoufox + Xvfb can be heavy (500MB+ RAM per instance). For OrbStack local testing, acceptable. For future NAS deployment, may need request queuing (max 2 concurrent browser instances). Address now or defer to NAS deployment phase?

---

**Next Step:** User reviews this spec. If approved, invoke `writing-plans` skill to break Phase 1 into concrete implementation tasks (TDD, isolated worktree per implementer, adversarial code review). Phase 2 spec remains design-only until Phase 1 ships.
