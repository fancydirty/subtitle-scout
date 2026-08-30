# Subtitle Scout container API — operator's manual

Every request shape in this file was verified against the actual route implementation in
`src/dashboard/server.ts` / `src/dashboard/router.ts` (verification anchors are in HTML
comments next to each endpoint). Do not invent endpoints that are not listed here.

## Conventions

Set these once and every curl below is copy-paste runnable:

```bash
export SCOUT_URL="http://<host>:8099"        # dashboard base URL (port = DASHBOARD_PORT, default 8099)
export SCOUT_API_KEY="<32-hex api key>"      # shown once at the end of the admin-creation wizard
```

<!-- verified: server.ts:544-556 (unified auth front gate: cookie / x-api-key header / ?apikey= query / legacy token) -->
Authentication — two equivalent channels, pick per situation:

- Header (default for scripts): `-H "x-api-key: $SCOUT_API_KEY"`
- Query (only when headers are impossible, e.g. SSE/EventSource): `?apikey=$SCOUT_API_KEY`

All `/api/*` paths require auth except the four `auth` bootstrap endpoints noted below.
Unauthorized → `401 {"error":"unauthorized"}`; before the admin account exists →
`401 {"error":"setup required"}`. Legacy deployments may also use `?token=` /
`x-dashboard-token` with `DASHBOARD_TOKEN` — do not use that for new setups.

All bodies are JSON (`content-type: application/json`); malformed JSON → 400, body over
1 MB → 413. <!-- verified: server.ts:385-407 readJsonBodyOrFail -->

### Path mapping rule (`/hostroot`)

The default compose mounts the host filesystem root at `/hostroot` inside the container.
API endpoints that take paths (`roots`, `fs/list`) accept **host absolute paths** and map
them internally; responses show host paths back. You may pass either
`/mnt/media/Movies` or `/hostroot/mnt/media/Movies` — both resolve to the same root.
<!-- verified: files/hostrootPath.ts:19-33 toContainerPath/toHostPath; apiV2.ts:368 addMediaRoot calls toContainerPath -->

---

## Auth

### GET /api/v2/auth/status — probe (no auth required)

<!-- verified: server.ts:589-595 -->
```bash
curl -s "$SCOUT_URL/api/v2/auth/status" -H "x-api-key: $SCOUT_API_KEY"
```
→ `200 {"initialized": bool, "authenticated": bool, "tmdbImageBase": string|null}`

- `initialized:false` → no admin account yet; send the user to the browser wizard.
- Call it **with** the key the user handed you: `authenticated:true` proves the key works
  (this is the takeover check in step 4 of the flow).

### POST /api/v2/auth/setup — create admin (agent MUST NOT call this)

<!-- verified: server.ts:598-614; auth.ts:215 MIN_PASSWORD_LEN=10 -->
Body `{"username": "...", "password": "..."}` (password ≥ 10 chars). Returns
`200 {"ok":true, "apiKey":"..."}` once; `403 {"error":"already initialized"}` after.
Listed only so you understand the flow: the **user** completes this in their browser —
passwords never pass through the agent. Ask the user to copy the API key shown on the
final wizard screen and paste it back to you.

### GET /api/v2/auth/security — re-read the API key (authed)

<!-- verified: server.ts:655-664 -->
```bash
curl -s "$SCOUT_URL/api/v2/auth/security" -H "x-api-key: $SCOUT_API_KEY"
```
→ `200 {"username": "...", "apiKey": "..."}`

### POST /api/v2/auth/regenerate-api-key

<!-- verified: server.ts:682-687 -->
Rotates the key; old key stops working immediately. → `200 {"apiKey":"<new>"}`.

### Forgotten password (CLI, not HTTP)

```bash
docker compose exec subtitle-scout node dist/cli/index.js auth reset
```
Clears admin credentials; next browser visit re-enters the creation wizard.
<!-- verified: cli/index.ts:983 USAGE, README "auth reset" -->

---

## Setup & credentials

### GET /api/v2/setup/status — bootstrap completeness

<!-- verified: router.ts:185; setupApi.ts:99-158 buildSetupStatus; setupApi.test.ts covers shape -->
```bash
curl -s "$SCOUT_URL/api/v2/setup/status" -H "x-api-key: $SCOUT_API_KEY"
```
→ `200` with:
```json
{
  "bootstrapComplete": false,
  "tmdb":  {"satisfied": false, "source": "none|db", "masked": null},
  "llm":   {"satisfied": false, "source": "none|db", "model": null},
  "providers": {
    "assrt": {"satisfied":false,"source":"none","masked":null},
    "opensubtitles": {"satisfied":false,"source":"none","hasUsername":false,"masked":null},
    "jimaku": {"satisfied":false,"source":"none","masked":null},
    "subhd":  {"enabled":false,"source":"none"},
    "zimuku": {"enabled":false,"source":"none","captchaReady":false},
    "r3sub":  {"satisfied":false,"source":"none","masked":null},
    "subdl":  {"satisfied":false,"source":"none","masked":null}
  },
  "roots": {"count": 0},
  "engineEnabled": true
}
```
`bootstrapComplete` = TMDB key present AND LLM triple complete. While it is `false` the
engine is gated — the daemon skips every inspection round. `r3sub.satisfied` requires
**both** email and password.

### GET /api/v2/setup/providers — per-provider rows

<!-- verified: router.ts:186; setupApi.ts:301-312 buildProviders -->
→ `200 {"providers":[{"id","secrets":[{name,set,source,masked}],"lastTest":{ok,at,error?}|null,"quota":{resetAt,observedAt}|null,"kind":"infra|source","languages":"*"|["zh"]|null}, ...]}`
Useful to see which secret names each provider expects and the last validate result.

### PUT /api/v2/settings/secrets — store one credential

<!-- verified: server.ts:730-744; setupApi.ts:166-188 putSecret; whitelist secrets.ts:9-19 SECRET_NAMES -->
```bash
curl -s -X PUT "$SCOUT_URL/api/v2/settings/secrets" \
  -H "x-api-key: $SCOUT_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"TMDB_API_KEY","value":"<key>"}'
```
- → `200 {"ok":true,"name":"TMDB_API_KEY","action":"set"}`
- Empty string value = **delete**: `{"name":"...","value":""}` → `action:"deleted"`.
- Unknown name → `400 {"ok":false,"error":"unknown secret name"}`.

`name` must be one of the 18 whitelisted secret names (exact spelling):
`TMDB_API_KEY` · `LLM_BASE_URL` `LLM_API_KEY` `LLM_MODEL` · `ASSRT_TOKEN` ·
`OPENSUBTITLES_API_KEY` `OPENSUBTITLES_USERNAME` `OPENSUBTITLES_PASSWORD` ·
`JIMAKU_API_KEY` · `R3SUB_EMAIL` `R3SUB_PASSWORD` · `SUBDL_API_KEY` ·
`TRANSLATE_BASE_URL` `TRANSLATE_API_KEY` `TRANSLATE_MODEL` ·
`ZIMUKU_VISION_BASE_URL` `ZIMUKU_VISION_API_KEY` `ZIMUKU_VISION_MODEL`

Secrets live **only** in the database via this endpoint. Putting them in `.env` or
compose `environment` has no effect (the daemon only reads the DB).

### POST /api/v2/setup/validate — probe one target (test-before-store)

<!-- verified: server.ts:748-760; setupApi.ts:316 VALIDATE_TARGETS, 469-495 validateSetupTarget -->
```bash
# test a credential BEFORE storing it (pass it inline):
curl -s -X POST "$SCOUT_URL/api/v2/setup/validate" \
  -H "x-api-key: $SCOUT_API_KEY" -H 'content-type: application/json' \
  -d '{"target":"tmdb","credentials":{"TMDB_API_KEY":"<candidate-key>"}}'

# re-test whatever is already stored (omit credentials):
curl -s -X POST "$SCOUT_URL/api/v2/setup/validate" \
  -H "x-api-key: $SCOUT_API_KEY" -H 'content-type: application/json' \
  -d '{"target":"opensubtitles"}'
```
`target` must be one of exactly 10 values:
`tmdb` `llm` `translate` `assrt` `opensubtitles` `jimaku` `subhd` `zimuku` `r3sub` `subdl`

- Unknown target → `400 {"ok":false,"error":"unknown validate target"}`.
- Probe ran (pass or fail) → always `200`:
  - pass: `{"ok":true, "detail": "..."}` (detail optional)
  - fail: `{"ok":false, "error":"<classified reason>", "detail":"<next-step hint>"}`
  - not configured: `{"ok":false, "error":"<target> is not configured"}`
- `credentials` keys use the same 18-name whitelist; non-whitelisted keys are ignored.
- Validation does **not** store anything. Workflow: validate with inline credentials →
  green → PUT the secret. `subhd`/`zimuku` need no credentials (pure reachability probe).
- Probe timeout 10 s (`translate`: 45 s — thinking models are slow; do not misread the
  wait as a hang).

---

## Behavior settings

### GET /api/v2/settings

<!-- verified: router.ts:116; apiV2.ts:147-166 SETTINGS_KEYS + buildSettings -->
→ `200` object with these keys (string or `null` when unset) plus `engineEnabled: bool`:
`target_languages`, `hardsub_mode`, `trace_retention_days`, `scan_interval_ms`,
`ai_translate_enabled`, `translate_after_attempts`, `engine_enabled`,
`provider:SUBHD_ENABLED`, `provider:ZIMUKU_ENABLED`

### PUT /api/v2/settings

<!-- verified: server.ts:714-726; apiV2.ts:259-327 updateSettings (zod value schemas, all-or-nothing) -->
```bash
curl -s -X PUT "$SCOUT_URL/api/v2/settings" \
  -H "x-api-key: $SCOUT_API_KEY" -H 'content-type: application/json' \
  -d '{"target_languages":"zh","provider:SUBHD_ENABLED":"true"}'
```
All values are **strings**. Value rules (any invalid entry → whole request `400`, nothing
written):

| key | allowed values |
|---|---|
| `target_languages` | comma-separated BCP-47 codes, e.g. `"zh"`, `"zh,en"` |
| `hardsub_mode` | `"off"` / `"agent"` / `"aggressive"` |
| `trace_retention_days`, `scan_interval_ms` | positive integer string |
| `ai_translate_enabled`, `engine_enabled` | `"true"` / `"false"` |
| `translate_after_attempts` | integer string 1–99 (hand-off-to-translation threshold) |
| `provider:SUBHD_ENABLED`, `provider:ZIMUKU_ENABLED` | `"true"` / `"false"` |

Success → `200` with the full refreshed settings object. Changing `target_languages`
triggers a whole-library re-judgement in the same transaction — expect follow-up activity.

---

## Media roots (guarded directories)

### GET /api/v2/settings/roots

<!-- verified: router.ts:118-120 (paths mapped back to host form); settingsRepo.ts:72-76 MediaRoot -->
→ `200 [{"path":"/mnt/media/Movies","type":"...","addedAt": 1725000000000}, ...]`

### GET /api/v2/fs/list?path=… — browse directories before adding

<!-- verified: router.ts:122-127; apiV2.ts:236-251 listMediaSubdirs -->
```bash
curl -s "$SCOUT_URL/api/v2/fs/list?path=/mnt/media" -H "x-api-key: $SCOUT_API_KEY"
```
→ `200 {"dirs":["Movies","TV"]}` (subdirectory names only) or
`400 {"error":"path does not exist" | "path is not a directory" | "path is not readable (permission denied?)" | "path must be an absolute path"}`

### POST /api/v2/settings/roots — add a root

<!-- verified: server.ts:783-827; apiV2.ts:359-404 addMediaRoot -->
```bash
curl -s -X POST "$SCOUT_URL/api/v2/settings/roots" \
  -H "x-api-key: $SCOUT_API_KEY" -H 'content-type: application/json' \
  -d '{"path":"/mnt/media/Movies"}'
```
→ `200 {"ok":true}` (also auto-queues a scan) or `400 {"error":"..."}`.
Rules enforced server-side: absolute path, must exist, must be a directory, must not
overlap (parent or child) an existing root. Adding the same root twice is idempotent 200.

### DELETE /api/v2/settings/roots?path=…

<!-- verified: server.ts:789-810 (query param, not body); settingsRepo RemoveRootResult -->
```bash
curl -s -X DELETE "$SCOUT_URL/api/v2/settings/roots?path=/mnt/media/Movies" \
  -H "x-api-key: $SCOUT_API_KEY"
```
→ `200 {"episodes":N,"movies":N,"series":N,"parked":N,"files":N}` (cascade-cleanup counts)
or `404 {"error":"not a media root"}` / `400` when `path` missing.
**Destructive** (removes the library records under that root) — requires explicit user
consent first.

---

## Health, triggers, results

### GET /api/v2/health — "is anything going to happen?"

<!-- verified: server.ts:1031-1071 HealthDTO; currents scoutEvents.ts:135-140; unidentifiedHealth.ts:61-69; stalledJobsHealth.ts:68-80; health.test.ts -->
```bash
curl -s "$SCOUT_URL/api/v2/health" -H "x-api-key: $SCOUT_API_KEY"
```
→ `200`:
```json
{
  "lastInspectAt": 1725000000000,
  "nextInspectAt": 1725086400000,
  "workPermitted": true,
  "engineEnabled": true,
  "setupSatisfied": true,
  "roots": [{"path":"/mnt/media/Movies","ok":true,"lastError":null,"lastCheckedAt":1725000000000}],
  "unidentified": {"dirCount": 0, "dirs": []},
  "stalledJobs": {"count": 0, "overdueMs": null},
  "currents": {"identify": null, "subtitle": null, "translate": null}
}
```
- `workPermitted` = `engineEnabled && setupSatisfied`. `false` → the daemon skips whole
  rounds. If `setupSatisfied:false`, TMDB or the LLM triple is missing (the gated state).
- `roots[].ok` is **three-state**: `true`/`false`/`null` (null = never scanned yet, or
  verdict stale). Treat `null` as unknown, never as OK.
- `currents` = per-workbench live snapshots (`null` = that workbench idle). Non-null slot
  carries `{kind,title,index,total,workId,...,lastStep}` — poll this to narrate progress.

### POST /api/v2/library/scan — quick mechanical scan

<!-- verified: server.ts:835-860 -->
→ `200 {"ok":true}` queued; `503` when the watch daemon isn't running/ready.

### POST /api/v2/library/inspect — full inspection round (use for first-run)

<!-- verified: server.ts:865-894 -->
```bash
curl -s -X POST "$SCOUT_URL/api/v2/library/inspect" -H "x-api-key: $SCOUT_API_KEY"
```
→ `200 {"ok":true}` queued · `409 {"error":"already running"}` · `503` daemon not
ready/not running. After queueing, poll `/api/v2/health` for `currents` and
`lastInspectAt` movement.

### GET /api/v2/notifications — "what was found" feed

<!-- verified: server.ts:946-955; notificationsRepo.ts:78-100 FoundGroup -->
→ `200` array of groups (one week window, newest first):
`[{"workId","title","season":1|null,"episodes":[3,5,7],"latestAt","via":"fetch|translate|mixed","mediaType":"tv|movie|unknown","chineseTitle","backdropPath"}]`
Movies: `season:null`, `episodes:[]`. This is the honest "first results" report source.

### GET /api/v2/runs?limit=50&offset=0 — decision history

<!-- verified: router.ts:103-107; apiV2.ts:91-107 buildRuns -->
→ `200 [{"id","jobId","startedAt","finishedAt","decision","detail","journalPath"}]`
Single-run tool trace: `GET /api/v2/workflow/runs/<id>/trace` → `{"events":[...]}`.
<!-- verified: router.ts:153-157 -->

### GET /api/v2/events — SSE stream (optional, for live narration)

<!-- verified: server.ts:1087-1190; ?apikey= required because EventSource cannot set headers -->
```bash
curl -N "$SCOUT_URL/api/v2/events?apikey=$SCOUT_API_KEY"
```
Long-lived `text/event-stream` with `activity`/`progress`/`found`/`health` events and
`: ping` keepalives. `503` if the event bus isn't wired (dashboard-only process). Prefer
polling `/health` + `/notifications` for scripted checks; use SSE only when tailing.

---

## Doctor (CLI health check, runs inside the container)

<!-- verified: cli/index.ts:983,1019 cmdDoctor; README "起完先体检：doctor" -->
```bash
docker compose exec subtitle-scout node dist/cli/index.js doctor
```
Checks TMDB / ASSRT / OpenSubtitles / zimuku / LLM / media roots writable / mount
capabilities / database / stuck jobs. `✓` pass, `✗` fail (fix and re-run), `⊘` skipped
optional. If the container is not running (e.g. crash-looping):
```bash
docker compose run --rm --no-deps subtitle-scout node dist/cli/index.js doctor
```
