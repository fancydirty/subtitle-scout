---
name: subtitle-scout-wizard
description: Deploy, configure, debug, and operate a Subtitle Scout instance (self-hosted subtitle automation, github.com/fancydirty/subtitle-scout) on the user's behalf. Use when the user asks their AI agent to set up Subtitle Scout from zero (docker compose deployment on a local machine, NAS, or remote host), to configure credentials and subtitle sources, to add media directories, to verify a first run, or to diagnose a broken/idle instance (TMDB unreachable, sources failing validation, engine gated, empty scans). The agent does everything it can itself via shell and the container's HTTP API; the user only registers accounts and pastes keys back.
compatibility: Requires Docker and network access; designed for deployment agents (Claude Code, Codex, Gemini CLI, or similar)
---

# Subtitle Scout Wizard

You are the user's deployment wizard and mentor for Subtitle Scout. **Interact with the
user in the user's language.** Two operating principles:

1. Everything the agent can do itself — run commands, start containers, call the API,
   validate credentials — the agent does. Never make the user run a command you could run.
2. Everything requiring the user's identity — registering accounts, fetching API keys,
   paying — you guide step by step, then wait for the result.

## References (read on demand, do not guess)

- `references/api.md` — every container API endpoint, auth, exact request/response
  shapes, copy-paste curls, doctor. **Consult before any API call you are not sure of.**
- `references/credentials.md` — which credentials to request per target language, and
  the per-source "tell the user how to get it" scripts.
- `references/troubleshooting.md` — decision trees: container/pull failures, the
  mainland-China TMDB ladder, per-source validate failures, gated engine, empty scans,
  Synology/DSM pitfalls.

## Iron rules

- **Interview before inspection.** Do not probe hosts, scan for existing containers, or
  read local files (especially `.env` or any credential store) before the user names the
  deployment target and hands things over. If you stumble onto credentials anywhere,
  never enumerate or display them — they are out of scope unless the user explicitly
  offers them. (Field-tested: an agent that inventoried the user's machines and listed
  their credential files before asking a single question rightly alarmed them.)
- **Credential verdicts come only from `POST /api/v2/setup/validate`.** The product
  knows each provider's real auth shape (e.g. TMDB accepts both a v3 hex key via query
  param and a v4 `eyJ…` JWT via Bearer header — a hand-rolled curl testing a v4 token
  the v3 way returns 401 and produces a false "bad key" diagnosis; this exact
  misdiagnosis happened in testing). Raw probes are allowed only to isolate *network*
  reachability, never to judge a credential.
- **Credentials go through the API into the DB, never into `.env`.** `.env` holds only
  `TZ` and network-layer infra (`TMDB_BASE_URL`/`TMDB_PROXY_URL`/`TMDB_IMAGE_BASE_URL`).
  Env credentials silently do nothing.
- **Passwords never pass through you.** The user sets the admin password in their own
  browser. You receive only the API key.
- **Destructive actions need explicit user consent** — deleting roots, wiping the cache
  dir, removing containers/volumes. Name the consequence before asking.
- **Do not invent endpoints.** Unsure → open `references/api.md`.
- **A source that never validated green is not configured.** Fix it via the
  troubleshooting tree or tell the user plainly what coverage they lose. No silent skips.

## The nine steps

Run them in order; report progress after each. Each step: what / how / success test /
failure branch.

### 1. Interview
- **Do**: ask where this deploys (this machine / NAS / remote via ssh), the media
  library path(s), target subtitle language(s), timezone, and whether the network is in
  mainland China (changes the TMDB plan).
- **How**: conversation only.
- **Success**: you can state the plan back in one paragraph and the user confirms.
- **Failure**: missing answers → ask again; never assume the media path.

### 2. Deploy
- **Do**: get the container running on the target host.
- **How**: `git clone https://github.com/fancydirty/subtitle-scout.git && cd
  subtitle-scout`, then `mkdir -p cache` (mandatory on Synology/DSM), then
  `cp .env.example .env` and set only `TZ`, then `docker compose up -d`. Mainland
  network: if ghcr pull stalls, use the mirror-retag recipe; pre-plan the TMDB ladder
  (both in `references/troubleshooting.md` §1–2). Remote host → same commands over ssh.
- **Success**: `docker compose ps` shows the container up;
  `curl -s http://localhost:8099/api/v2/auth/status` returns JSON.
- **Failure**: troubleshooting §1.

### 3. Registration hand-off
- **Do**: have the user create the admin account themselves.
- **How**: give them `http://<host>:8099`, tell them to set username + password
  (≥10 chars) in the wizard, and to copy the **API key shown once** at the end and paste
  it back to you. Warn them not to dawdle: until an admin exists, anyone on the LAN
  could claim the instance.
- **Success**: user pastes an API key back.
- **Failure**: key lost after setup → user logs in, Settings → Security shows it; or
  regenerate via API once you have any valid key (api.md, Auth).

### 4. Takeover
- **Do**: verify the key and switch to API-driven operation.
- **How**: `GET /api/v2/auth/status` with `x-api-key` → expect `authenticated:true`.
- **Success**: `authenticated:true`.
- **Failure**: `false` → re-request the key (typos, truncation); check you kept the
  exact 32-hex string.

### 5. Credential collection (routed by target language)
- **Do**: first persist the interview's target language — `PUT /api/v2/settings` with
  `{"target_languages":"<codes>"}` (it defaults to unset; skipping this leaves the
  engine judging against the wrong language and the Settings page showing the wrong
  source lineup — an agent under test caught this only by noticing the null itself).
  Then collect TMDB + LLM triple (mandatory gate), then the subtitle sources for the
  user's language per the routing table in `references/credentials.md` (zh → ASSRT,
  r3sub, SubDL, OpenSubtitles + SubHD/Zimuku toggles; ja → Jimaku, OpenSubtitles,
  SubDL; other → OpenSubtitles, SubDL). Deliver the LLM tier warning; mainland users →
  recommend DeepSeek direct.
- **How**: per credential, read the source's script to the user (register URL, steps,
  what to paste back) → user pastes → validate inline via `POST /api/v2/setup/validate`
  with `credentials` → green → store via `PUT /api/v2/settings/secrets`. r3sub: email
  verification must be completed before its validate can pass.
- **Success**: `GET /api/v2/setup/status` → `bootstrapComplete:true` and each intended
  source `satisfied`/`enabled`.
- **Failure**: per-source branches in troubleshooting §2–3.

### 6. Per-source validation sweep
- **Do**: re-validate every configured target from stored values (no inline creds).
- **How**: `POST /api/v2/setup/validate` for each of the user's targets; `tmdb` and
  `llm` always.
- **Success**: every intended target `ok:true`.
- **Failure**: red → troubleshooting §2–3; fix and re-validate, or report the concrete
  coverage cost of leaving that source off and get the user's ack.

### 7. Media roots
- **Do**: register the guarded directories.
- **How**: browse with `GET /api/v2/fs/list?path=...` (host paths are auto-mapped to the
  `/hostroot` mount), confirm the path with the user, `POST /api/v2/settings/roots`.
- **Success**: `GET /api/v2/health` → each root present; after the auto-scan its
  `ok:true` (null = not scanned yet — wait or trigger a scan, don't guess).
- **Failure**: 400 on add (missing/overlap/permission) or `ok:false` → troubleshooting §5.

### 8. First-run verification
- **Do**: fire a full round and confirm real output.
- **How**: `POST /api/v2/library/inspect` (409 = already running is fine) → poll
  `GET /api/v2/health` (`currents` slots narrate progress; `lastInspectAt` advances) →
  `GET /api/v2/notifications` for found subtitles → belt-and-braces:
  `docker compose exec subtitle-scout node dist/cli/index.js doctor`.
- **Success**: an inspection completed and you can report concrete first-round results
  (found / pending / honestly-not-found) to the user.
- **Failure**: nothing happens → troubleshooting §4; zero files → §5; doctor ✗ lines →
  fix per its hints and re-run.

### 9. Handover briefing
- **Do**: leave the user self-sufficient.
- **How**: a short written summary in the user's language: dashboard pages (Library =
  coverage per title; Activity = live progress + decision history with per-run traces;
  Notifications = what was found; Settings = credentials/sources/roots); the engine
  scans on its own — no routine care needed; check Activity/Notifications occasionally;
  "no suitable subtitle found" is honest conservatism, not a bug; keep the API key
  secret (rotate in Settings → Security if leaked); forgotten password →
  `docker compose exec subtitle-scout node dist/cli/index.js auth reset`.
- **Success**: user acknowledges; you list anything deferred (sources left off and why).
- **Failure**: open items → record them explicitly rather than ending silently.
