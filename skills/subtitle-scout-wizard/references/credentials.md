# Credentials — what to ask for, per target language

The agent stores every credential via `PUT /api/v2/settings/secrets` and tests it via
`POST /api/v2/setup/validate` (see `api.md`). **Never write credentials to `.env` or
compose** — the daemon reads only the database; env credentials silently do nothing.
Test-before-store: validate with inline `credentials` first, PUT only on green.

## Required for every deployment (the bootstrap gate)

The engine stays gated (`setup/status → bootstrapComplete:false`, no work happens) until
both of these are in:

| | secret names | notes |
|---|---|---|
| **TMDB** | `TMDB_API_KEY` | Identifies every file. v3 32-char key or v4 Read Access Token both work. |
| **LLM triple** | `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Any OpenAI-compatible endpoint. All three from the **same provider**; base URL usually ends with `/v1`. |

### LLM model-tier warning (tell the user up front)

The agent pipeline is long multi-step tool-calling. Models below roughly the
flash/mini tier (local 3B-class, nano-class) do **not** fail loudly — they confidently
fabricate, which surfaces as misidentified media, not errors. Recommended starting
points: `deepseek-v4-flash` (api.deepseek.com, current value baseline), Alibaba
`qwen3.5-plus` (DashScope), or any current mini/flash-class frontier model. If matching
quality is poor later, suspect the model tier before anything else.

**Mainland China users**: recommend DeepSeek direct (`https://api.deepseek.com/v1`) —
reachable without a proxy, as are DashScope/Kimi/GLM/MiniMax. OpenAI / Gemini / Claude
official APIs are blocked in mainland China.

### Optional infra

- **Translate triple** (`TRANSLATE_BASE_URL/_API_KEY/_MODEL`): a separate (often
  stronger) model for the AI-translation workbench. Falls back unused if absent.
  Validate target: `translate` (45 s timeout — thinking models are slow).
- **Zimuku vision triple** (`ZIMUKU_VISION_*`): optional vision-model fallback for
  zimuku's captcha. Only relevant when zimuku is enabled.

## Subtitle sources — route by the user's target language

Source-to-language mapping (from the single source of truth, `src/core/sourceRegistry.ts`
SOURCE_REGISTRY): OpenSubtitles and SubDL serve **every** language; the rest are
language-specific.

| Target language | Ask for (keyed) | Toggles (no credential) |
|---|---|---|
| Chinese (`zh`, incl. `zh-Hant`) | ASSRT, r3sub, SubDL, OpenSubtitles | SubHD, Zimuku (`PUT /api/v2/settings` with `provider:SUBHD_ENABLED` / `provider:ZIMUKU_ENABLED` = `"true"`; off by default, gray-area ToS — mention that before enabling) |
| Japanese (`ja`) | Jimaku, OpenSubtitles, SubDL | — |
| Any other language | OpenSubtitles, SubDL | — |

Every source is optional, but skipping OpenSubtitles/SubDL costs the widest-coverage
international catalogs — advise configuring them regardless of language. All accounts
below are free.

---

## Per-source scripts — what to tell the user

Each entry: where to register, what to fetch, what to paste back. The agent then stores
(`PUT secrets`) and validates (`POST setup/validate`) — the user never touches the API.

### TMDB (required) — validate target `tmdb`

1. Sign up at https://www.themoviedb.org/signup and confirm the email.
2. Open https://www.themoviedb.org/settings/api (avatar → Settings → API). If it shows a
   permission page, sign in and open the same URL again.
3. Request a **Developer** key; application name can be `Subtitle Scout`.
4. Paste back the **API Key (v3 auth)** (32 chars) or the v4 Read Access Token.

Mainland China: `api.themoviedb.org` is blocked — registration may need a VPN, and the
container needs a reachability fix. See the TMDB section of `troubleshooting.md`.

### ASSRT — `ASSRT_TOKEN`, validate target `assrt`

Primary professional Chinese catalog. Strongly recommended for Chinese targets.

1. Register at https://assrt.net/user/register.xml (the homepage has no sign-up link;
   the form advises against QQ mail).
2. Log in, open https://assrt.net/usercp.php (用户面板).
3. Paste back the 32-char alphanumeric API token shown on that page.

Expectation to set: quota is ~5 req/min (Scout auto-throttles) and ASSRT's coverage of
Western titles is limited — "no suitable subtitle found" there is normal, not a fault.

### OpenSubtitles — `OPENSUBTITLES_API_KEY` (+ optional username/password), target `opensubtitles`

1. Register at https://www.opensubtitles.com (use .com, not the retired .org).
2. Open https://www.opensubtitles.com/en/consumers (sign in first if redirected).
3. Click **NEW CONSUMER** — the name may contain **letters and digits only** (e.g.
   `subtitlescout`; no spaces/hyphens). No VIP needed. Ticking "Under development"
   raises the dev-period quota.
4. Paste back the API key (gear icon on the new row shows/copies it).

Optional: also paste the account **username + password** (`OPENSUBTITLES_USERNAME` /
`OPENSUBTITLES_PASSWORD`) for the logged-in download tier (~20/day free). Searching and
validation don't consume download quota.

### Jimaku — `JIMAKU_API_KEY`, validate target `jimaku`

Not a Chinese catalog: it feeds the translation agent **Japanese source subtitles**.
Worth it for anime/Japanese-origin libraries.

1. Register/log in at https://jimaku.cc/login.
2. Generate an API key at https://jimaku.cc/account; paste it back.

### r3sub — `R3SUB_EMAIL` + `R3SUB_PASSWORD`, validate target `r3sub`

Official Traditional Chinese tracks from Taiwan releases. Chinese targets only.

1. Register on the forum: https://forum.r3sub.com/entry/register
2. **Verify the email — this is mandatory.** Unverified accounts cannot log in, and the
   validate probe (a real login) will fail. Do not proceed until the user confirms the
   verification mail was clicked.
3. Paste back the **same email and password**. Store both (satisfied only as a pair).

Note: some releases there are Blu-ray bitmap subs (`.sup`) only — Scout honestly skips
those; that's expected behavior.

### SubDL — `SUBDL_API_KEY`, validate target `subdl`

Subscene's practical successor; useful for every target language.

1. Register a **free** account at https://subdl.com (email verification).
2. Copy the API key from https://subdl.com/panel/api; paste it back.

Free tier is enough: 2000 searches/day, downloads via the 300/day-per-IP anonymous pool.
Paid "Pro" only matters for multi-IP server farms.

### SubHD / Zimuku — no credentials, validate targets `subhd` / `zimuku`

Chinese-focused, key-less, **off by default**. Enable via
`PUT /api/v2/settings {"provider:SUBHD_ENABLED":"true"}` (same for ZIMUKU) only after
telling the user about the terms-of-service caveat (see SECURITY.md in the repo).
Validation is a pure reachability probe — some networks block or throttle these sites.

---

## Security discipline

- Never echo a pasted credential back in full; refer to it by name or masked form.
- Never put credentials in git, issues, screenshots, or `.env`.
- If a key leaks: rotate at the provider (TMDB settings/api, ASSRT usercp, OpenSubtitles
  consumers, Jimaku account, SubDL panel; r3sub → change the forum password), then PUT
  the new value.
