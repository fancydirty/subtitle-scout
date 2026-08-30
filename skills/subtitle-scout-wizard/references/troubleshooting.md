# Troubleshooting — decision trees

Symptom → check command → branch. Work top-down; every branch ends in an action or an
honest "this source stays off, here is the cost" report to the user.

## 1. Container won't start / dashboard unreachable

Check: `docker compose ps` and `docker compose logs --tail 100 subtitle-scout`

- **Image pull fails / hangs (ghcr.io blocked or slow)** → pull through the mirror and
  retag (same digest as upstream):
  ```bash
  docker pull ghcr.1ms.run/fancydirty/subtitle-scout:latest
  docker tag ghcr.1ms.run/fancydirty/subtitle-scout:latest ghcr.io/fancydirty/subtitle-scout:latest
  docker compose up -d
  ```
- **Port already in use** (`bind: address already in use`) → set `DASHBOARD_PORT` in
  `.env` to a free port and `docker compose up -d` again; the compose maps
  `${DASHBOARD_PORT:-8099}` on both sides.
- **Synology/DSM: mount error or cache DB not created** → DSM's Docker does **not**
  auto-create bind-mount host directories the way standard Linux Docker does. Run
  `mkdir -p cache` next to `docker-compose.yml` **before** `docker compose up -d`.
- **Container up but page won't load** → check the firewall for the port; from the
  server itself try `curl -s http://localhost:8099/api/v2/auth/status` (any JSON = the
  app is alive, the problem is network-side).
- **Crash loop and you need diagnostics** → doctor works without a running container:
  `docker compose run --rm --no-deps subtitle-scout node dist/cli/index.js doctor`

## 2. TMDB validate red (the mainland-China ladder)

Symptom: `setup/validate target=tmdb` → `Connection problem`/timeout, or doctor's tmdb
line reports a network error, or identification always times out. On mainland networks
`api.themoviedb.org` is DNS-poisoned/blocked; `image.tmdb.org` is flaky.

First: if the error is `Invalid credentials`, it's the key, not the network — re-check
the pasted key. For network errors on mainland deployments, walk this ladder. These are
**deployment-layer env vars** (compose `environment` or `.env`) — the only exception to
"nothing goes in .env"; they are network infrastructure, not credentials. Each change
needs `docker compose up -d` to recreate the container.

1. **Zero-cost first try — official legacy domain**:
   ```yaml
   environment:
     TMDB_BASE_URL: https://api.tmdb.org/3
   ```
   `api.tmdb.org` is TMDB's official legacy domain, currently reachable from most
   mainland regions without a proxy (no guarantee). Fixes the API, not images.
2. **Recommended — self-hosted reverse proxy (fixes API + images with one domain)**:
   needs a free Cloudflare account + a personal domain. **A custom domain is mandatory**
   — `*.workers.dev` is itself blocked in mainland China.
   - Deploy the template that ships in this repo:
     `npx wrangler deploy docs/tmdb-proxy-worker.js --name tmdb-proxy --compatibility-date 2026-08-01`
     (or paste the file into a new Worker in the Cloudflare dashboard)
   - Bind the custom domain: Worker → Settings → Domains & Routes → Custom domain
   - Point Scout at it:
     ```yaml
     environment:
       TMDB_BASE_URL: https://tmdb.example.com/3
       TMDB_IMAGE_BASE_URL: https://tmdb.example.com
     ```
3. **Existing local proxy** (Clash / sing-box): only TMDB traffic goes through it:
   ```yaml
   environment:
     TMDB_PROXY_URL: http://192.168.1.2:7890
   ```
4. **Do NOT recommend**: public third-party TMDB mirrors (the user's API key transits a
   stranger's server, and they keep dying) or hosts-file IP pinning (IPs rotate).

Image side: posters broken but identification works → set `TMDB_IMAGE_BASE_URL`
(step 2 covers it; a `{path}` placeholder in the value is substituted with the full
image path).

## 3. Per-source validate failures

Always re-run `POST /api/v2/setup/validate` after each fix; a source that never went
green is **not configured** — report the coverage cost instead of silently moving on.

| Target | Common cause → action |
|---|---|
| `llm` / `translate` | `Not found` → base URL or model name wrong (URL usually ends `/v1`; all three fields from the same provider). `Invalid credentials` → key. Timeout on `translate` is 45 s — thinking models can be slow but a hard timeout usually means wrong base URL. Mainland: OpenAI/Gemini/Claude endpoints are blocked — use DeepSeek/DashScope/etc. |
| `assrt` | Token is on https://assrt.net/usercp.php (32 alphanumerics). Rate limit ~5/min — a burst of validates can 429; wait a minute. |
| `opensubtitles` | Key must come from an **API consumer** on opensubtitles.**com** (not .org, not the account password). Copy exactly — the key is case-sensitive, and the consumer name itself allows letters/digits only. If username/password are stored too, they must match the same account. |
| `jimaku` | Key from https://jimaku.cc/account. Freshly created keys work immediately; `Invalid credentials` = copy error. |
| `subhd` / `zimuku` | Reachability probes — failure means the site is blocked/throttled from this host or is down. Nothing to configure; retry later or accept the source stays off. |
| `r3sub` | **#1 cause: email not verified.** The probe performs a real login; unverified accounts cannot log in. Have the user click the verification mail, then re-validate. Second cause: password typo (test by logging into forum.r3sub.com manually). |
| `subdl` | Key comes from https://subdl.com/panel/api (a single token) — not the account password. Free tier is sufficient; no key form has spaces. |
| `tmdb` | See section 2. |

## 4. Engine gated / "nothing is happening"

Check: `GET /api/v2/health`

- `workPermitted:false` — the daemon skips whole rounds. Look at its two conjuncts:
  - `setupSatisfied:false` → the bootstrap gate: TMDB key + LLM triple are not all
    resolvable (`GET /api/v2/setup/status` → `bootstrapComplete:false` says the same
    thing). Fix per `credentials.md`, validate to green — no restart needed, the next
    round picks it up.
  - `engineEnabled:false` → the user (or a previous session) turned the master switch
    off. `PUT /api/v2/settings {"engine_enabled":"true"}` — but ask the user first; it
    may be off on purpose.
- `workPermitted:true` but idle → check `lastInspectAt`/`nextInspectAt`; trigger
  `POST /api/v2/library/inspect` (409 = a round is already running — that IS activity).
- `503` on scan/inspect → the watch daemon isn't running in this container (or is still
  starting). `docker compose logs` to see why; normal `docker compose up -d` runs watch.

## 5. Scan finds 0 files

Check: `GET /api/v2/health` → `roots[]`, and `GET /api/v2/settings/roots`

- **No roots configured** (`roots: []`) → add one (api.md, roots section).
- **`roots[].ok:false`** → read `lastError` — usually the path doesn't exist inside the
  container. Remember the mapping: host `/mnt/media/Movies` is container
  `/hostroot/mnt/media/Movies`; the API accepts host paths and maps them, but a compose
  that replaced the default `/:/hostroot` mount with a narrower one must actually mount
  the directory. Verify with `GET /api/v2/fs/list?path=<root>` — a 400 tells you exactly
  what's wrong (missing / not a dir / permission denied).
- **`roots[].ok:null`** → never scanned yet (or stale verdict) — trigger a scan
  (`POST /api/v2/library/scan`) and re-check; don't read null as either good or bad.
- **Root green but library empty** → the directory may genuinely hold no video files, or
  everything sits under another root's subtree. `docker compose exec subtitle-scout
  node dist/cli/index.js doctor` reports media-roots and mount capabilities.
- **Read-only mount** → doctor says "not writable": remove an accidental `:ro` flag in
  compose, or fix host directory permissions. Read-only network shares can't take
  sidecar files at all — say so honestly.

## 6. Synology/DSM specifics (both bites are known and documented)

- **`mkdir cache` first** — see section 1. Without it the SQLite DB has no home.
- **EXDEV on realign (directory reorganization)** — Scout moves folders with atomic
  `rename` and never falls back to copying. Every DSM *shared folder* is its own btrfs
  subvolume, so a cross-shared-folder move always fails with `EXDEV` and is skipped
  (`abandon`, logged — no data harmed). Fix: keep the archive dir
  (`REALIGN_ARCHIVE_ROOT`, default = parent of the library root) inside the **same
  shared folder** as the library it serves. The same same-filesystem rule applies to any
  NAS with per-share filesystems.

## 7. When lost: doctor, then logs

```bash
docker compose exec subtitle-scout node dist/cli/index.js doctor
docker compose logs --tail 200 subtitle-scout
```
Doctor covers TMDB / ASSRT / OpenSubtitles / zimuku / LLM / roots / mounts / DB / stuck
jobs in one pass (subhd and TRANSLATE_* are currently outside its probe scope). For a
specific run's decisions: `GET /api/v2/runs`, then
`GET /api/v2/workflow/runs/<id>/trace`.
