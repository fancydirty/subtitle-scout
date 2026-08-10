# Media Subtitle Agent - Product Shape

> ⚠️ **已退役（2026-07-25）**：本文档描述的是 v1 时代的 Jellyfin 集成方案。当前架构已去 Jellyfin 化：
> - 直接扫描磁盘 + TMDB 识别文件，不打任何媒体服务器 API
> - Jellyfin 只是可选播放器（见 docker-compose.bundle.yml），与找字幕主线完全无关
> - 本文档保留作历史参考，新架构见 README.md 和 docs/design/ 下的最新设计文档

## What We Are Building

Build a media-player subtitle agent for Chinese users who watch non-Chinese-origin media.
The product is not "another subtitle downloader"; it is an intelligent matching layer that
reduces two failures:

- humans manually searching, downloading, extracting, renaming, and refreshing subtitles;
- mechanical subtitle providers silently choosing the wrong subtitle or the wrong file inside
  a subtitle pack.

The first user-facing promise should be:

> When a foreign movie or episode has no good Chinese subtitle, your media server quietly finds the best
> Chinese or bilingual subtitle, explains why it chose it, verifies it exists on disk, and makes
> it available with minimal user friction.

Jellyfin is the first integration target, not the product boundary.

## Deployment Shape

The v1 deployment should be a companion sidecar service, not a Jellyfin plugin.

For Docker/iStoreOS deployment, the clean shape is:

- keep Jellyfin as the official image;
- mount persistent `/config`, `/cache`, and media volumes as usual;
- run `subtitle-agent` beside Jellyfin with access to Jellyfin's API and the same media paths;
- keep the ASSRT token in sidecar config/secrets, never in git;
- write subtitle files to the media volume and ask Jellyfin to refresh the item.

Avoid baking user secrets or subtitle logic into the Jellyfin image. A Jellyfin plugin can be a v2
UX layer, but the core matching/downloading engine should stay player-agnostic.

## Runtime Components

### 1. Player Adapter

Responsibilities:

- connect to one media server/player API;
- discover active playback sessions or user-triggered subtitle requests;
- fetch media metadata, file paths, existing subtitle streams, and provider ids;
- map container paths to sidecar filesystem paths;
- request media refresh after subtitle files are written;
- expose adapter-specific capabilities and limitations.

Initial adapter:

- `jellyfin`: session polling, item metadata, media streams, file path, refresh.

Future adapters:

- Emby, Plex, Kodi, Stremio, local folder watcher, Sonarr/Radarr/Bazarr integration.

### 2. Agent/Skill Worker

Responsibilities:

- transform Jellyfin media metadata into ASSRT search strategies;
- evaluate search candidates semantically and structurally;
- choose a specific file inside subtitle packs;
- decide whether the confidence is high enough for auto-download;
- produce a typed decision record, not just a downloaded file.

The worker should live in the sidecar core, behind stable JSON contracts:

```text
player adapter -> subtitle agent core -> provider adapter -> filesystem -> player refresh
```

### 3. Subtitle Provider Adapter

Responsibilities:

- implement one subtitle source API;
- convert agent search strategy into provider-specific calls;
- return normalized candidates and download descriptors;
- expose provider quota/rate-limit information.

Initial provider:

- `assrt`: `user/quota`, `sub/search`, `sub/detail`, and download URLs.

Future providers:

- OpenSubtitles, local archive/index, user-provided subtitle folders, other regional subtitle APIs.

### 4. ASSRT Client

Responsibilities:

- call `user/quota`, `sub/search`, `sub/detail`;
- respect the user's quota. Current token was observed as 5 requests/minute behavior, despite the
  public docs mentioning a default 20/minute;
- cache search/detail responses by media fingerprint and ASSRT subtitle id;
- avoid `detail` calls for every candidate. Use `search?filelist=1` to inspect archive contents
  before spending more quota;
- retry downloads, and surface network/DNS failures explicitly.

### 5. Subtitle File Manager

Responsibilities:

- download direct subtitle files or archive files;
- extract zip/rar/7z when needed;
- choose the best `.srt`, `.ass`, or `.ssa` file;
- normalize encoding when needed;
- write player-compatible names, for example Jellyfin-compatible names:
  - `Movie.zh-Hans.default.ass`
  - `Movie.zh-Hans.srt`
  - `Series S01E01.zh-Hans.ass`
- trigger a media refresh or subtitle refresh through the player adapter after writing.

### 6. Download Egress Layer

Open-source users will run media servers in many different network environments. The project cannot
assume that ASSRT file hosts are reachable from the Jellyfin container, and it also cannot assume
that every user owns a VPS.

Make ASSRT file downloading a pluggable egress layer:

```text
Subtitle decision
  -> download request
  -> egress backend
  -> verified subtitle artifact
```

Backends, in priority order:

- `direct`: Jellyfin plugin or local sidecar downloads from ASSRT directly.
- `local-proxy`: direct download through a user-configured HTTP/SOCKS proxy.
- `remote-relay`: a user-hosted relay service on any reachable network/VPS/NAS.
- `worker-relay`: Cloudflare Worker attempt, useful only when ASSRT accepts Worker egress.
- `manual-assisted`: last-resort flow that gives the user a browser download/action path and then
  imports the file.

Every backend implements the same contract:

- `probe`: can this backend reach ASSRT file hosts now?
- `download`: fetch one selected subtitle file or archive;
- `verify`: return bytes, filename, content type, hash, and error details;
- `cache`: optionally store artifact/metadata in local disk, KV, or R2-compatible storage.

The setup UI should run a capability test and show a clear result:

```text
ASSRT API search/detail: OK
ASSRT file direct download: FAIL fake-ip/no proxy
Cloudflare Worker relay: FAIL upstream 403
Suggested next step: configure local proxy or remote relay
```

This keeps the project universal without pretending one network route works everywhere.

## Trigger Model

Use several triggers with different guarantees.

### Playback-First Default

The default product mode should be on-demand, not full-library scanning.

Reason:

- large Jellyfin libraries can contain thousands of items;
- a full scan would spend ASSRT quota and agent time on media the user may never watch;
- playback intent is the strongest signal that a subtitle is worth finding now.

Flow:

1. user starts playback;
2. player adapter checks local subtitle state;
3. agent normalizes the media identity from player metadata and filename evidence;
4. agent checks local cache using that normalized identity;
5. cache hit: fetch cached decision/artifact and write subtitle without ASSRT API calls;
6. cache miss: enqueue a high-priority ASSRT/agent job;
7. job result is cached whether it succeeds, fails, or has no safe match.

Use negative cache records too, for example `no_safe_match` with a 7-30 day TTL, so repeated plays
do not keep hitting ASSRT for the same media.

### Agent-Mediated Cache Lookup

Cache lookup should not be a mechanical filename equality check. Real media filenames are too messy:

- remux/repack/rerip tags;
- multiple cuts, extended editions, director cuts, IMAX/open-matte versions;
- season packs and episode packs;
- Chinese/English mixed titles;
- release groups and fansub groups;
- multi-version movie folders;
- local renamed files that no longer resemble the release name.

The agent's first job is identity resolution:

```text
raw player item + file path + filename + provider ids + media streams
  -> canonical media identity
  -> cache keys
  -> cache lookup
  -> search strategy if cache misses
```

Use layered cache keys, from strict to fuzzy:

- exact media hash or Jellyfin item id scoped to this server;
- provider ids: IMDb/TMDB/TVDB plus season/episode;
- canonical title/year/type plus season/episode;
- normalized release fingerprint: title, year, cut, source, resolution, release group;
- subtitle-specific compatibility key: format, language, source release, duration/fps when known.

Cache values must include evidence, not only the selected subtitle:

```json
{
  "identity": {
    "type": "movie",
    "title": "The Matrix",
    "year": 1999,
    "provider_ids": {
      "imdb": "tt0133093",
      "tmdb": "603"
    },
    "edition": null
  },
  "source_evidence": {
    "filename": "The.Matrix.1999.1080p.BluRay.x264.mkv",
    "jellyfin_title": "The Matrix",
    "production_locations": ["US", "AU"]
  },
  "decision": {
    "assrt_id": 673114,
    "selected_file": "The.Matrix.1999...zh.ass",
    "confidence": 0.91,
    "compatibility": "likely"
  }
}
```

The agent can reuse a fuzzy cache hit only when the evidence still supports it. For example, a
movie-level subtitle may be reused across two BluRay releases if title/year/runtime are close; an
episode subtitle must match season and episode strictly; a director's cut should not reuse a
theatrical-cut subtitle without manual confirmation.

### Background Scan

Optional path. Scan a small bounded set after library import or on schedule.

Input condition:

- item is a movie or episode;
- no external Chinese subtitle is detected;
- original country/production location is not mainland China, Hong Kong, or Taiwan, unless the user
  chooses to include everything;
- optional: embedded Chinese subtitle exists but is PGS/image-based or marked low priority.

Outcome:

- high confidence: download and attach;
- medium confidence: keep candidates and ask user in plugin UI;
- low confidence: record "no safe match".

Do not scan an entire large library by default. Good bounded scans:

- newly added items from the last N days;
- items in "continue watching";
- items the current user explicitly marks for subtitle search;
- a nightly quota-limited prewarm queue.

### Manual Search

Use Jellyfin's native subtitle search path. This is the escape hatch when auto mode is conservative.

Outcome:

- show ranked ASSRT candidates with reasons;
- let the user download one;
- feed the user's choice back into future scoring.

### Playback Start Fallback

Useful but should not be the primary promise. On playback start, enqueue a high-priority job if no
Chinese subtitle exists.

Important constraint:

- do not assume every Jellyfin client can receive and switch to a newly downloaded subtitle while
  playback is already running;
- reliable UX is "download quickly, refresh item/session where possible, notify user if reselect or
  restart is needed";
- real client tests are required for Web, iOS/Android, TV clients, and Infuse/Kodi-style clients.

### Hard Auto-Match During Playback

Treat as an optimization after testing, not as v1's core contract.

Possible implementation path:

- plugin detects playback start;
- worker downloads a high-confidence subtitle;
- plugin writes file and triggers Jellyfin item refresh;
- plugin attempts session notification;
- client-specific behavior determines whether the subtitle appears immediately.

## Agent Input Contract

The agent should receive a compact, explicit context object:

```json
{
  "request_id": "uuid",
  "trigger": "library_scan | manual_search | playback_start",
  "player": {
    "adapter": "jellyfin",
    "base_url": "http://jellyfin:8096"
  },
  "media": {
    "jellyfin_item_id": "string",
    "type": "movie | episode",
    "path": "/media/Movies/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264.mkv",
    "filename": "The.Matrix.1999.1080p.BluRay.x264.mkv",
    "title": "The Matrix",
    "original_title": "The Matrix",
    "year": 1999,
    "season": null,
    "episode": null,
    "runtime_minutes": 136,
    "provider_ids": {
      "imdb": "tt0133093",
      "tmdb": "603"
    },
    "production_locations": ["US", "AU"],
    "existing_subtitles": [
      {
        "language": "eng",
        "format": "srt",
        "source": "external"
      }
    ],
    "media_streams": []
  },
  "preferences": {
    "language": "zh-Hans",
    "prefer_bilingual": true,
    "allow_traditional": true,
    "allow_machine_translated": false,
    "auto_download_min_confidence": 0.86
  },
  "assrt": {
    "quota_remaining_hint": 4,
    "max_requests_for_this_job": 2
  }
}
```

## Agent Output Contract

The agent should return a decision, not just a filename:

```json
{
  "request_id": "uuid",
  "decision": "download | ask_user | no_safe_match | retry_later",
  "confidence": 0.91,
  "selected": {
    "assrt_id": 673114,
    "subtitle_name": "The.Matrix.1999.RERIP.2160p.BluRay.x265...zh.ass",
    "language": "zh-Hans",
    "format": "ass",
    "release_site": "YYeTs",
    "is_pack": false
  },
  "reasons": [
    "title and year match The Matrix 1999",
    "candidate is bilingual Chinese/English",
    "archive contains a single matching .ass file",
    "release metadata matches BluRay"
  ],
  "rejected": [
    {
      "assrt_id": 606770,
      "reason": "high-quality pack, but contains Matrix trilogy plus Animatrix; requires file-level choice"
    }
  ],
  "verification": {
    "downloaded": true,
    "path": "/media/.../The.Matrix.1999.1080p.BluRay.x264.zh-Hans.ass",
    "bytes": 168960,
    "jellyfin_refresh_requested": true
  }
}
```

## Candidate Scoring

The scoring should combine deterministic signals and agent judgment.

Strong positive signals:

- exact title/year match;
- exact season/episode match;
- ASSRT `videoname` close to media filename;
- subtitle pack contains a filename matching this item, not only the franchise;
- Chinese simplified or bilingual language flags;
- known subtitle group/release site;
- format supported by target clients.

Strong negative signals:

- pack contains multiple movies/episodes and no specific file match;
- wrong season/episode;
- title only matches a franchise or collection;
- "commentary", "director commentary", "SDH only", or unrelated special-feature subtitle;
- machine translation when user disabled it.

The Matrix smoke test shows why file-level scoring matters: ASSRT id `606770` is a good-looking
Matrix trilogy subtitle pack, but its first subtitle file is for Animatrix. A mechanical downloader
would easily pick the wrong file.

## Verification

A job is only complete when all of these are true:

- ASSRT API status is `0`;
- selected candidate and selected file are recorded;
- file exists on disk and has non-zero bytes;
- file extension is supported by Jellyfin/client target;
- encoding can be read or conversion is recorded;
- Jellyfin refresh was requested;
- the item exposes the subtitle in Jellyfin's stream/subtitle list, verified through API or browser.

## Local Smoke Test on 2026-07-02

Working directory: `/Users/dirtyfancy/projects/subtitle-plugin`.

Created artifacts:

- `scratch/assrt-smoke/quota.json`
- `scratch/assrt-smoke/search-matrix.json`
- `scratch/assrt-smoke/candidate-ranking.json`
- `scratch/assrt-smoke/detail-606770.json`
- `scratch/assrt-smoke/detail-673114.json`

Observed:

- `user/quota` succeeded and reported 4 remaining requests after the run.
- `sub/search` for `The.Matrix.1999.1080p.BluRay.x264` succeeded.
- `sub/detail` succeeded for `606770` and `673114`.
- `673114` contains one promising file:
  `The.Matrix.1999.RERIP.2160p.BluRay.x265.10bit.SDR.DTS-HD.MA.TrueHD.7.1.Atmos-SWTYBLZ.zh.ass`.
- actual file download failed locally because `file0.assrt.net` / `file1.assrt.net` resolve to
  `198.18.*` fake-ip addresses while no local proxy is listening. Curl reaches the fake endpoint
  and receives an empty response.
- OrbStack/Docker inherits the same DNS behavior: an Alpine container resolves `file0.assrt.net`
  to `198.18.*`, and even `docker run --dns=1.1.1.1` still receives fake-ip answers. This points
  to transparent DNS/proxy handling below the container level.

Implication:

- ASSRT API integration is viable;
- download verification must include real DNS/proxy/container-network checks;
- Docker/iStoreOS deployment should use normal DNS or a working proxy path, not a stale fake-ip DNS
  environment.

### Home Network Retest

Later on 2026-07-02, the same Mac on the home network resolved ASSRT hosts differently:

- `api.assrt.net` -> `43.133.211.58`
- `file0.assrt.net` / `file1.assrt.net` -> `glb.cn.assrt.net` -> `43.133.211.58`

ASSRT API and direct file download succeeded:

- `user/quota`: status `0`, quota remaining `4` at test time;
- `sub/detail?id=673114`: status `0`;
- direct download wrote
  `scratch/assrt-smoke/home-direct-673114-The.Matrix.1999.RERIP.2160p.BluRay.x265.10bit.SDR.DTS-HD.MA.TrueHD.7.1.Atmos-SWTYBLZ.zh.ass`;
- downloaded size: `169750` bytes;
- file type: UTF-8 BOM ASS subtitle with YYeTs/Aegisub metadata.

Implication:

- ASSRT file download is not globally broken;
- the earlier failure was caused by the previous network's fake-ip/proxy state;
- direct download should remain the first backend, with capability probing to select fallback only
  when needed.

## Cloudflare Worker Fallback

Cloudflare Workers are a good fit for a controlled cache/control-plane fallback. They may be useful
as a file relay, but this must be proven against ASSRT's file hosts in the target network. They
should not become the agent brain.

Responsibilities:

- accept only signed requests from the Jellyfin plugin/agent;
- allowlist ASSRT file hosts and download path shapes;
- attempt ASSRT direct-download relay from Cloudflare's network when local Jellyfin/Docker networking
  cannot reach them;
- stream the response to Jellyfin instead of buffering unbounded bodies;
- optionally store small subtitle artifacts or decision records in Workers KV.

Do not implement it as `?url=anything`. That would create an open proxy.

### KV Usage

KV is useful for read-heavy caches:

- normalized media fingerprint -> selected ASSRT id and file choice;
- ASSRT id -> detail response;
- ASSRT id + file index/hash -> small subtitle artifact, if policy allows;
- media fingerprint -> negative result with TTL.

KV limits and behavior to design around:

- values can be binary/stream/ArrayBuffer, with a documented 25 MiB maximum per value;
- metadata is limited, so keep rich audit logs elsewhere or compact;
- KV is eventually consistent across regions, so treat it as a cache, not a transaction log.

If subtitle artifacts become large or we want longer-term binary storage, use R2 for artifacts and
KV only for metadata/indexes.

### Cloudflare Access Needed For Development

For local setup/deploy with Wrangler, use a scoped API token, not a global API key.

Minimum useful permissions:

- Account: Account Settings Read;
- Account: Workers Scripts Edit/Write;
- Account: Workers KV Storage Edit/Write;
- User: User Details Read;
- optional Account: Workers Tail Read for live logs;
- optional Zone: Workers Routes Edit/Write only if binding the Worker to a custom domain/route
  instead of using `workers.dev`.

Also needed as non-secret identifiers:

- Cloudflare account id;
- optional zone id and route/domain if using a custom domain.

Runtime secrets:

- plugin-to-Worker shared secret or HMAC key;
- ASSRT token only if the Worker ever calls ASSRT API directly. Prefer keeping ASSRT API calls in
  the local plugin/agent at first. If ASSRT file URLs are source/IP-bound, a Worker fallback may need
  a by-id endpoint that calls `sub/detail` itself.

### Worker Smoke Result

On 2026-07-02, a Worker was deployed at
`https://assrt-subtitle-relay.fancydirty.workers.dev` with KV and shared-secret auth.

Verified:

- `/health` works;
- unauthenticated relay requests return `401`;
- Worker code deploy and TypeScript check pass.

Not verified as working:

- ASSRT file relay. Worker outbound requests to `file0.assrt.net` returned upstream `403 Forbidden`,
  both for locally generated download URLs and for fresh `sub/detail` URLs generated inside the
  Worker.

Current conclusion:

- use Workers/KV for cache and control plane;
- keep ASSRT file download as a pluggable egress: local Jellyfin container if DNS/proxy is fixed,
  iStoreOS sidecar if home network can download, or a small VPS/proxy downloader if ASSRT continues
  blocking Cloudflare Worker egress.

## Open-Source Distribution Strategy

The open-source project should not depend on a project-hosted relay service. A public relay would
create abuse, bandwidth, privacy, and copyright-adjacent operational risk.

Ship these instead:

- Jellyfin plugin package;
- local agent/worker sidecar image;
- optional relay image using the same HMAC auth and ASSRT allowlist rules;
- Docker Compose examples:
  - Jellyfin + plugin + local sidecar;
  - Jellyfin + plugin + configured outbound proxy;
  - Jellyfin + plugin + remote relay URL;
- Cloudflare Worker template for metadata/cache and best-effort relay;
- setup wizard with capability probes and recommended backend selection.

For users with no VPS:

- default to direct download;
- let them configure an existing proxy if they already use one;
- provide a manual-assisted import path for rare failures;
- do not make the whole plugin unusable just because relay is unavailable.

## Recommended Build Plan

1. CLI smoke prototype:
   - read a media-context JSON;
   - call ASSRT search/detail;
   - produce candidate-ranking JSON;
   - download and verify one subtitle;
   - no player dependency yet.

2. Agent core package:
   - define `PlayerAdapter`, `SubtitleProvider`, `DownloadBackend`, and `SubtitleFileManager`;
   - implement ASSRT provider and direct download backend;
   - keep Jellyfin out of the core.

3. Jellyfin sidecar adapter:
   - poll active sessions;
   - fetch item metadata/streams/path;
   - map container paths to sidecar paths;
   - call refresh after subtitle write.

4. Jellyfin dev container:
   - run Jellyfin in OrbStack;
   - mount a tiny media fixture;
   - manually place one known-good subtitle and prove naming/refresh behavior.

5. Agent workflow:
   - local deterministic scorer first;
   - optional LLM/tool skill runner once schemas and fixtures are stable.

6. Auto mode:
   - scheduled scan;
   - confidence thresholds;
   - playback-start high-priority fallback;
   - user notification.

7. Real deployment:
   - iStoreOS Docker Compose;
   - token as secret;
   - DNS/proxy test;
   - Jellyfin client tests for Web and the user's actual playback clients.

8. Optional Jellyfin plugin:
   - configuration UI;
   - manual search UI;
   - audit/decision viewer;
   - calls sidecar/core instead of duplicating logic.
