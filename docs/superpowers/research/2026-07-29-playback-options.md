# Playback / Preview Options for subtitle-scout (2026-07-29)

**Status:** COMPLETE (all 7 sections written; see Progress log for what was and wasn't verified)

**Question being answered:** should subtitle-scout ship in-product playback/preview, and if so, what technical shape?

**Constraints recap (from the brief, not researched):**
- Runs in Docker on iStoreOS/OpenWrt low-power x86 home router. No transcoding headroom.
- Library: 4K HEVC/H.265 REMUX + DTS-HD MA / TrueHD; plus 1080p WEB-DL H.264 (usually AAC/AC3/E-AC3).
- Subtitles: `.srt` + `.ass` (heavy styled/typeset Chinese fansub).
- Jellyfin dependency was deliberately removed (`docs/design/2026-07-16-de-jellyfin-design.md`).
- Frontend: React + Vite dashboard, 4 tabs (library / workflow / triage / settings).

**Labelling convention used throughout:**
- `[FACT]` — supported by a cited source.
- `[INFER]` — my reasoning from facts; not directly sourced.
- `[UNVERIFIED]` — commonly-repeated claim I could not confirm in this session.

---

## Progress log

| # | Topic | Status |
|---|---|---|
| 0 | Skeleton created | DONE |
| 1 | Lightweight embeddable web players (HEVC/DTS in browser) | **DONE** — verdict: no viable middle ground; DTS-HD is the hard blocker (undecodable in every browser), HEVC is hardware-gated, MKV container unsupported everywhere |
| 2 | How comparable subtitle products (Bazarr et al.) solve "verify a subtitle" | **DONE** — no product in the category embeds a player; Bazarr has no preview at all; Bazarr+ built a before/after sync diff + text editor; Sub-Zero died from media-server coupling |
| 3 | Subtitle preview/verification UI patterns w/o video decode | **DONE** — JASSUB canvas-only `manualRender` needs no `<video>`; ffsubsync is already a scoring oracle with a sub-second no-audio path; CJK font requirement is the main trap |
| 4 | Embedding Jellyfin's playback page / using its API | **DONE** — iframe likely loads (no XFO found, unverified) but breaks on cookies/websocket/base-URL; making it feel native historically required forking jellyfin-web; custom player on its API is strictly worse |
| 5 | Docker-compose "bundled but hidden" heavy dependency pattern | **DONE** — headless Jellyfin provisioning IS proven (Terraform module) but with undocumented ordering, lying health endpoints, sleep-based choreography, and file-edit-only settings |
| 6 | Option comparison table | **DONE** — 10 options (A–J) scored on effort / router CPU / % library / maintenance / 2nd-product visibility |
| 7 | Recommendation + open questions | **DONE** — verdict: do NOT build playback; build a verification suite (~2 weeks). 11 open questions, 4 of them blocking measurements |

**Not covered / deliberately out of scope:** Subliminal's UI (inferred CLI-only, unverified);
ASS.js feature parity; alass accuracy benchmarks; Jellyfin deep-link route stability. All are
listed in Open Questions.

Append-only notes on process: each research batch appends to its section and updates this table.

---

## Executive summary

**No. Do not build playback — build verification instead.** Browser playback of this specific
library is blocked at the codec-licensing layer, not the effort layer: DTS-HD MA / TrueHD cannot
be decoded by *any* browser on *any* platform, Chromium ships no HEVC software decoder by
deliberate patent policy (so HEVC works only if the *viewer's* GPU supports it), and MKV is
unsupported in `<video>` everywhere — Jellyfin itself still has an open 2026 bug where this
causes silent 0 ms playback failures. There is no middle ground between `<video>` and a
transcoding server; every candidate (mpv.js, WebChimera, WebCodecs, libav.js, video.js, Shaka,
mpegts.js, "jellyfin-web's player standalone") either is dead, adds no codecs, or would need
the router to transcode. Meanwhile the category leader, Bazarr, has deliberately shipped **no
player and no preview** for ~8 years — its answer is match-scoring plus automated ffsubsync
sync, and when its fork finally addressed verification it built a **before/after timing diff and
a text editor, not video**; and Sub-Zero, the subtitle tool that *did* embed itself in a media
server, was killed by that server's roadmap. The owner's real concern is legitimate but is fully
solvable without playback: **ffsubsync run as a sync-confidence scorer** (sub-second when an
embedded or sibling subtitle serves as reference, and it already exposes a trustworthiness
score), **JASSUB rendering styled `.ass` on a bare canvas with no `<video>` element at all**,
optional server-side still frames, and a Bazarr+-style diff view. That package costs ~2 weeks,
uses near-zero router CPU, works on **100%** of the library, and requires no second product —
versus 3–8 weeks for a bundled/hidden Jellyfin that covers barely half the library and whose
failure mode is degrading the user's home network. The de-Jellyfin refactor was correct; don't
reverse it.

---

## 1. Lightweight embeddable web players (HEVC / DTS without a media server)

### 1.1 The blunt answer

**There is no middle ground that plays this library.** The gap between `<video>` and a
transcoding media server is not a gap in *libraries* — it is a gap in *codec licensing and
container support in browser engines*. Every candidate below fails on at least one of
{HEVC video, DTS-HD/TrueHD audio, MKV container}. The described library trips all three
simultaneously.

Three independent blockers, each sufficient on its own:

**(a) HEVC decode is hardware-gated and never software-fallback in Chromium.** `[FACT]`
Chromium ships *no* HEVC software decoder, deliberately, to avoid patent liability. Playback
only works if the OS/GPU exposes a hardware HEVC decoder (VideoToolbox on macOS, D3D11VA on
Windows 8+, VAAPI on Linux/ChromeOS, MediaCodec on Android 5+).
- "H265 decoding only works when your PC has a GPU or a hardware decoder, they haven't
  embedded a software decoder inside Chrome in order not to infringe patents."
  — mediamtx maintainer, 2025-05 — https://github.com/bluenviron/mediamtx/discussions/4396
- "Software decoding of HEVC is not possible in Chrome/Chromium, you can only decode using
  VAAPI." — https://unix.stackexchange.com/questions/798697/is-it-possible-to-play-hevc-h265-content-in-chromium
- Chromium's own Intent-to-Ship for HEVC in WebRTC: "we will not provide a software
  implementation to fall back to" — https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c
- Support matrix (which profiles, which GPUs, which Chrome versions):
  https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding
- Failure mode is silent: "When HEVC playback fails, the browser usually returns
  canPlayType() as an empty string with no clearer error."
  — https://www.testmuai.com/learning-hub/hevc-compatible-browsers/
- Empirical 1M+ session dataset: "For practical purposes: HEVC decoding works on Apple
  devices and Chrome on non-Windows platforms. It does not work on Edge or Firefox."
  — https://webcodecsfundamentals.org/datasets/codec-analysis-2026/
  (Note: this is *decode via WebCodecs*, measured from Jan 2026 onward.)

`[INFER]` For subtitle-scout this means: HEVC direct-play in-browser is a *client-machine
lottery*. A Mac or a Windows box with a modern iGPU wins; a Linux desktop without VAAPI
configured, or Firefox anywhere, loses. You cannot ship this as a reliable feature. And note
the server (the router) is irrelevant to this — the decode happens client-side — so this is
the one blocker that *isn't* about the router's CPU.

**(b) 4K REMUX HEVC is often Main10 / high bit-depth / very high bitrate.** `[INFER, partially
sourced]` Chromium only supports a subset of HEVC profiles, varying by GPU generation and
Chrome version (Rext/4:2:2/4:4:4 needs Chrome ≥117–137 depending on vendor; NVIDIA Rext only
from Chrome 137 + driver ≥572.16) — source: StaZhu guide above. REMUX bitrates (50–120 Mbps)
also mean the file must be delivered over LAN from the router at full rate, which is a
throughput question, not a transcode question.

**(c) DTS-HD MA / TrueHD audio is not decodable in ANY browser, at all, on any platform.**
`[FACT]` Browser audio support is limited to AAC/MP3/Opus/FLAC/Vorbis (+PCM). AC-3, E-AC-3,
DTS, DTS-HD, TrueHD are absent for licensing reasons.
- "Chrome: Supports H.264/VP8/VP9 (video) and AAC/MP3/Opus (audio). … If your MKV uses
  unsupported codecs (e.g., AC3 audio, HEVC video), browsers will fail to play it… Codec
  Licensing: AC3, DTS, and HEVC require paid licenses. Browsers avoid these to reduce costs."
  — https://www.tutorialpedia.org/blog/how-to-playback-mkv-video-in-web-browser/
- Same conclusion from a 2026 write-up: MKVs "love to carry things browsers struggle with:
  HEVC video, multiple audio tracks, DTS/AC-3 surround audio, and embedded subtitles."
  — https://onlineplayer.app/en/blog/play-mkv-in-browser

`[INFER]` **This is the decisive blocker, and it's worse than the HEVC one.** Unlike HEVC,
there is *no* hardware/platform path that rescues DTS-HD in a browser. Any in-browser
playback of this library requires **audio transcode on the server** — i.e. exactly the
ffmpeg process the router cannot afford. Even "direct play the video, just fix the audio" is
a per-stream ffmpeg invocation.

**(d) MKV container is not supported by `<video>` in any browser.** `[FACT]`
- Firefox: tracked as WONTFIX-ish meta bug —
  https://bugzilla.mozilla.org/show_bug.cgi?id=1422891
- Chromium: partially works when set via `HTMLMediaElement.src` but is not a supported path
  and breaks per-file (same Bugzilla thread, comment 54; and
  https://www.reddit.com/r/firefox/comments/1by8cxx/transcode_matroska_files_or_use_an_external_or/)
- **Highly relevant real-world evidence:** jellyfin-web ships `mkv` in Chrome's
  `DirectPlayProfiles`, the server then DirectPlays a raw `.mkv`, and Chrome fails **silently
  at 0 ms with no error in UI or server log** — even for H.264+AAC content that Chrome can
  decode. Open bug, filed 2026-03, jellyfin-web 10.11.6 / Chrome 145:
  https://github.com/jellyfin/jellyfin-web/issues/7651
  `[INFER]` This is worth internalising: *the category leader, with years of device-profile
  engineering, still gets browser container negotiation wrong in 2026.* That is the
  maintenance burden being signed up for.

### 1.2 Candidate-by-candidate verdicts

| Candidate | Status 2026 | Verdict for subtitle-scout |
|---|---|---|
| bare `<video>` | — | Plays 1080p WEB-DL H.264 **only if** remuxed to MP4 and audio is AAC. Fails on MKV container, fails on AC3/E-AC3, fails on all 4K HEVC+DTS. `[FACT]` |
| **libmpv / mpv.js** | **Dead for browsers.** mpv.js was a **PPAPI/Pepper** plugin; PPAPI + NaCl are deprecated and command-line plugin loading is being removed from Chromium (https://issues.chromium.org/issues/40151562, https://www.chromium.org/developers/npapi-deprecation/). Only usable inside **Electron**, not a web page. | Not an option. Would require shipping a desktop app, which contradicts "web dashboard". `[FACT]` |
| **WebChimera / WebChimera.js** | **Abandoned.** Maintainer confirmed the project is "suspended… many chances it will be deprecated soon" (2017), and it was Node/Electron-bound anyway — https://gitter.im/RSATom/WebChimera?at=596f6aa076a757f808271517 | Not an option. `[FACT]` |
| **WebCodecs (native)** | Real and shipping (Chromium, Firefox 130+ desktop, Safari 26 full). But: no demuxer (need MP4Box.js/jswebm — MKV demux is a DIY problem), no DRM, and `isConfigSupported()` for HEVC returns false exactly where hardware is absent. https://developer.mozilla.org/en-US/docs/Web/API/VideoDecoder/isConfigSupported_static | Doesn't solve HEVC (same hardware gate) and **cannot decode DTS-HD/TrueHD at all**. Also you'd be writing an A/V sync engine. Not viable. `[FACT + INFER]` |
| **libav.js / libavjs-webcodecs-polyfill** | Real, actively maintained, genuinely can software-decode more codecs in WASM (https://github.com/Yahweasel/libav.js/, https://github.com/ennuicastr/libavjs-webcodecs-polyfill). Author's own performance note is explicitly about **audio**: "the performance of audio en- and decoding is much faster than real time… The author regularly uses libav.js in live audio systems." **No equivalent claim is made for video.** | `[INFER, strong]` This is the most interesting-looking option and it is a trap. Software-decoding 4K HEVC at 24 fps in WASM on a client browser is not realistic — WASM SIMD gets you within ~2-3x of native at best, and native software HEVC 4K decode already needs several modern cores. Conceivably usable to decode *a few seconds around one subtitle cue* (see §3 for why that's the actually-interesting idea), not for playback. Also: shipping an HEVC/DTS decoder in your product is precisely the patent exposure Google avoided. |
| **ffmpeg.wasm** | Real but is a *transcoder*, single-shot, extremely slow (roughly an order of magnitude slower than native), large WASM payload. | Not a player. Same patent point. `[INFER]` |
| **video.js / Shaka Player / hls.js / dash.js** | All real and healthy — but they are **MSE/HLS/DASH orchestration layers**. They do not add codecs. They require the server to hand them fMP4/TS segments in browser-supported codecs. | These are *what you'd use in front of a transcoder*, not an alternative to one. Zero help on the codec problem. `[FACT]` |
| **mpegts.js** | Real (MPEG-TS → MSE remux, for live streams). Remux only; codecs must already be browser-supported. | No help: DTS-HD/TrueHD still undecodable, HEVC still hardware-gated. `[FACT]` |
| **jellyfin-web's player as standalone component** | jellyfin-web's `htmlVideoPlayer` is **not** a decoder — it's a DeviceProfile builder + `<video>`/HLS driver that negotiates with a Jellyfin **server** that runs ffmpeg. Extracting it without the server extracts nothing useful. (And see bug #7651: even the real thing mis-negotiates MKV.) | Not a standalone player. Its value *is* the server behind it. `[FACT + INFER]` |

### 1.3 What that leaves

`[INFER]` Only two architectures can actually play the described library in a browser:

1. **Server-side transcode/remux** (= what Jellyfin/Emby/Plex are). Minimum viable version:
   video `-c:v copy` + audio `-c:a aac` + HLS fMP4 segmenting. Video copy is cheap; audio
   transcode of TrueHD/DTS-HD 7.1 is *not free but is far cheaper than video transcode*.
   BUT: it only works when the client can decode the HEVC video stream, which is the
   client-lottery from (a). For a 4K HEVC Main10 REMUX to a Linux-Firefox client you are
   back to full video transcode, which the router cannot do. `[INFER]`
2. **Hand off to a native player on the client** (mpv/VLC/IINA/Infuse) via a URL, an
   `.m3u`/`.strm`, or a custom protocol handler. Zero server CPU, plays 100% of the library,
   plays `.ass` with libass properly. Cost: it is not "in the product's UI".

Notably, option 2 plays **more** of the library than option 1 does, with **less** engineering
and **zero** router CPU. That asymmetry drives the recommendation.

`[INFER]` A third architecture avoids playback entirely — verify subtitles without decoding
video. That's §3, and it's where the actual product value is.

## 2. How comparable subtitle-focused products solve subtitle verification

**Headline finding: the category leader does NOT have a player, does NOT have a subtitle
preview, and after ~8 years and thousands of users has not built one.** Instead it invests in
*automated scoring and automated sync*, and expects the user to verify in their own player.

### 2.1 Bazarr (the closest analogue)

`[FACT]` Bazarr has no in-app playback and no subtitle preview. Direct user question and
answer, r/bazarr 2024-09:
> Q: "Is there a tool in Bazaar that allows me to preview a movie and see the subtitles that
> Bazarr pulled down to see if it is the right one and timed properly? Or do I have to keep
> and back and forth between my video playback app and Bazarr to tweak it?"
> A: "There isn't a way to check your subtitles like you describe inside of bazarr. … I think
> you'd need to be watching the video to check the subtitles for sync issues."
— https://www.reddit.com/r/bazarr/comments/1fqadr2/how_to_confirm_you_have_the_right_subtitle_set/

`[INFER]` Note the shape of the answer: the community's response to "how do I verify" is not
"here's the preview feature", it's "go watch it in your player" — *and users accept that*.
The follow-up complaint in that same thread is not "I wish Bazarr had a player", it's "the
sync feature doesn't work as well" (i.e. the demand is for **better automated sync**, not for
playback).

What Bazarr *does* offer for inspecting/verifying a subtitle: `[FACT]`
- **A numeric match score** computed from release-name/metadata matching (release group,
  resolution, source, year, codec) with a configurable threshold below which it keeps looking.
  — https://bytesized-hosting.com/guides/bazarr-automatic-subtitles-for-your-seedbox-media-library
  and https://www.reddit.com/r/bazarr/comments/yft0x6/how_does_bazarr_find_match_and_sync_foreign/
- **Manual Search** — a list of candidate subtitles per item with their scores/attributes, so
  the user picks rather than previews. — https://v3.quickbox.io/docs/applications/media-management/bazarr
- **Automated sync via `ffsubsync`** ("Automatic subtitle synchronization and timing
  correction using ffsubsync") — same source; ffsubsync attribution confirmed by maintainer-
  adjacent community answer in the reddit thread above.
- **Per-item "Tools"** actions (sync, translate, etc.) operating on the file, not a preview.
- Community workarounds swap in `sc0ty/subsync` for better accuracy via the custom
  post-processing command hook —
  https://www.reddit.com/r/bazarr/comments/1hr19ug/using_ffsubsync_or_sc0tys_subsync/

`[FACT]` The **Bazarr+ fork** (v2.4 "Prism") is the one place in this ecosystem that built
something preview-like — and notably it is a **text-vs-text side-by-side diff, not video**:
> "Multi-engine synchronization with side-by-side output comparison… When the editor sync
> finishes, the `SyncOutputCompareModal` shows the produced output next to the original side
> by side, so you can confirm the timing improved before committing to it."
It also has a **subtitle editor** ("From the subtitle editor, on a single subtitle"), embedded-
track scoring at 100%, and combined bilingual/trilingual output.
— https://lavx.github.io/bazarr/guides/subtitle-processing.html

`[INFER]` This is the most directly transferable pattern found in the whole research pass:
when the leading fork finally addressed "let me verify before committing", it built
**before/after timing comparison + a text editor**, not a video player. And it's especially
apt for subtitle-scout, whose LLM-translation feature has exactly the same "did this output
get better or worse?" problem.

### 2.2 Sub-Zero (Plex plugin) — cautionary tale about coupling to a media server

`[FACT]` Sub-Zero was *the* Plex subtitle plugin. Its repo now opens with
"THIS PLUGIN IS DEPRECATED, PLEASE USE BAZARR!" and the maintainer notes it survives only
"as long as Plex Inc. supports agents", with a changelog full of entries like "fix Plex agent
integration; Plex Inc removed certain attributes".
— https://github.com/pannal/Sub-Zero.bundle

`[FACT]` Plex ended official plugin support in 2018, which broke the plugin's UI entirely;
users had to run a **separate third-party app (Kitana)** just to reach its manual-search UI.
— https://www.cogipas.com/plex-plugins-still-working/ ; corroborated across
r/PleX threads (e.g. "working fine, just need Kitana if you want to manually search or update
subtitles") — https://www.reddit.com/r/PleX/comments/da1o1t/subzero_plugin_is_this_the_end_announced_a_year/

`[INFER]` **This is the single strongest historical argument for subtitle-scout's de-Jellyfin
decision.** The subtitle tool that embedded itself inside a media server got killed by the
media server's roadmap, and the tool that stayed a standalone sidecar (Bazarr) won the
category. Re-coupling to Jellyfin would be replaying Sub-Zero's mistake with a different
host. Jellyfin is friendlier than Plex Inc., but it still owns its own web UI, auth model,
and API surface (see §4 for concrete breakage).

### 2.3 Direction of integration in the wild: player → subtitle tool, not the reverse

`[FACT]` The integration people actually build is a **plugin inside the player that calls the
subtitle tool's API** — e.g. `enoch85/bazarr-jellyfin`: "Instead of navigating to Bazarr's web
UI, users can search and download subtitles directly from Jellyfin's native subtitle
interface." Flow: Jellyfin plugin → POST to Bazarr → Bazarr writes `.srt` next to the video →
library refresh → subtitle appears in the player.
— https://github.com/enoch85/bazarr-jellyfin

`[INFER]` Two takeaways. (1) The verification surface is *the player the user already has*,
and the correct product move is to make your subtitle land there fast and be easy to
re-trigger from there — not to become a player. (2) If subtitle-scout wants "playback next to
the subtitle", the cheap version is a **thin API + sidecar-file convention** (which the
de-Jellyfin refactor already produced) plus optionally a small Jellyfin/Emby plugin, which
costs far less than owning a player.

`[FACT]` Also note the same repo documents a real coupling cost: if Bazarr sits behind an auth
proxy (Authentik/Authelia/Keycloak), the plugin "cannot authenticate with OAuth2 — it only has
an API key", requiring nginx/Traefik rules to bypass auth on `/api/`. `[INFER]` Auth
pass-through between two web apps is a recurring, non-trivial tax — directly relevant to §4.

### 2.4 Subliminal

`[INFER, low-confidence — not separately searched this pass]` Subliminal is a CLI/library
(and Bazarr vendors a patched fork of it, visible as `custom_libs/subliminal_patch/providers/…`
in Bazarr tracebacks — https://github.com/morpheus65535/bazarr/issues/3187). A CLI has no
preview UI by construction. Flagged in Open Questions rather than asserted.

### 2.5 Summary signal

`[INFER]` Across the entire comparable set, **zero products in the subtitle-manager category
embed a video player.** The verification strategies that exist are, in descending order of
adoption: (1) automated release-name match scoring, (2) automated audio-based sync
(ffsubsync/subsync), (3) text-level before/after comparison + a subtitle editor (Bazarr+),
(4) "open it in your own player". If the category leader deliberately does not build a
player, and its fork's answer to verification was a diff modal, that is about as clear a
signal as this kind of research produces.

## 3. Subtitle preview / verification UI patterns (no video decode)

**This is where the leverage is.** Everything below runs today, costs near-zero router CPU,
plays 100% of the library (because it never touches the video stream), and is directly aligned
with subtitle-scout's stated core value.

### 3.1 Rendering styled `.ass`/`.ssa` in the browser — SOLVED, and it works WITHOUT video

`[FACT]` **JASSUB** (`ThaUnknown/jassub`) is the current best-maintained libass→WASM wrapper.
libass compiled via Emscripten, WebGL-accelerated, multithreaded via SharedArrayBuffer with
automatic single-thread fallback. npm 1.8.6, last published ~2 months before this research.
- https://github.com/ThaUnknown/jassub , https://www.npmjs.com/package/jassub

`[FACT] `**The critical capability: canvas-only mode with manual time control — no `<video>`
element at all.** From the JASSUB README:
```js
const instance = new JASSUB({ canvas: document.querySelector('canvas'), subUrl: './tracks/sub.ass' })
await instance.ready
instance.manualRender({ expectedDisplayTime: performance.now(), width: 1920, height: 1080, mediaTime: 10.20 })
```
SubtitlesOctopus has the same escape hatch (`instance.setCurrentTime(15)` against a bare
canvas) — https://github.com/libass/JavascriptSubtitlesOctopus

`[INFER]` **This is the whole preview feature.** You can render a pixel-accurate,
fully-typeset `.ass` frame — karaoke tags, `\pos`, `\t` transforms, `\fad`, ASS drawings, the
whole fansub styling apparatus — at any timestamp, in the dashboard, with zero video decode,
zero transcode, zero router CPU, and it works identically for a 4K HEVC REMUX and a 1080p
WEB-DL because *the video is never opened*. Combine with a still frame extracted server-side
(see §3.2) and you have a "what will this actually look like" preview that is strictly better
than what Bazarr offers and cheaper than any playback path.

Landscape notes:
- `libass/JavascriptSubtitlesOctopus` — the original; still the reference implementation.
  Jellyfin maintains its own fork, `@jellyfin/libass-wasm` (4.2.4), with a `renderAhead`
  option. https://www.npmjs.com/package/@jellyfin/libass-wasm
- `Arnavion/libjass` — **archived**; author's own postmortem says the DOM-based approach "is a
  dead end" and recommends SubtitlesOctopus instead. Don't use.
  https://github.com/Arnavion/libjass
- `ASS.js` (`weizhenye/ASS`) — DOM/CSS-based alternative, offloads fonts to the browser.
  `[UNVERIFIED]` feature completeness vs libass.
- `@youka/libass-wasm` (6 years old) and `biliblitz/libass-wasm` — stale/niche forks.

`[FACT]` **CJK font trap — read this before implementing.** libass-based renderers need actual
font files; they do not use the browser's font stack. jellyfin-web issue #1670 documents
exactly this failure for a Chinese-subtitle user:
> "SubtitlesOctopus is ported from libass and relies on font files. This breaks the display of
> CJK characters since Jellyfin doesn't provide any CJK fonts by default… But CJK font files
> are HUGE. A complete experience requires GBs of locally installed font resources and even
> minified versions take up to 10MB+."
— https://github.com/jellyfin/jellyfin-web/issues/1670

`[INFER]` For a product whose subtitles are "many `.ass` with styled/typeset effects, Chinese
fansub", this is a **first-class design constraint, not a footnote**. Mitigations to evaluate:
(a) many fansub `.ass` ship with **embedded/attached fonts inside the MKV** — extracting
attachments server-side with ffmpeg (`-dump_attachment`) is cheap and is the correct fix, and
it's the same mechanism Jellyfin's `fonts:` option consumes; (b) ship one subset CJK WOFF2 as
fallback; (c) serve fonts from the container rather than bundling in the JS payload. Note
router→browser LAN transfer makes a 10 MB font far less painful here than it is for Jellyfin
over the internet.

### 3.2 Server-side still-frame extraction — the cheap half of "preview"

`[INFER, not directly sourced — verify before committing]` `ffmpeg -ss <t> -i file.mkv
-frames:v 1 out.jpg` with `-ss` **before** `-i` (input seeking) decodes only from the nearest
keyframe, so cost is roughly "decode a fraction of a GOP + one JPEG encode", not "decode the
movie". On a low-power x86 box this is plausibly sub-second to a few seconds for 4K HEVC and
is a **one-shot batch job, not a sustained realtime load** — categorically different from
transcoding. This is the one place where spending router CPU is defensible. **Flagged as the
top thing to benchmark on the actual hardware** (see Open Questions).

`[INFER]` Composite: extracted still frame (server, `<img>`) + JASSUB canvas overlay at the
same `mediaTime` (client) = a real "subtitle over the actual frame" preview at ~0 sustained
CPU. Pick timestamps from the subtitle's own cue list (e.g. cue #10, #middle, #last) so the
frames are guaranteed to have dialogue on them.

### 3.3 Automated sync verification WITHOUT playing anything — ffsubsync as a *scorer*

This is the most under-exploited finding in the whole document.

`[FACT]` ffsubsync's algorithm: discretize both the reference audio and the subtitle into 10 ms
windows; label each window speech/not (VAD for audio, "is any cue on screen" for subtitles);
find the shift maximising `(#ref 1s matched with sub 1s) − (#ref 1s matched with sub 0s)` via
FFT convolution, O(n log n).
— https://github.com/smacke/ffsubsync , https://deepwiki.com/smacke/ffsubsync

`[FACT]` **It emits a quality score and can refuse to act on it** — i.e. it is already a
verification oracle, not just a fixer:
> "`--skip-sync-on-low-quality` leaves the subtitles unmodified when the alignment looks
> untrustworthy—an anti-correlated score (`--min-score`, default 0.0) or an implausibly large
> offset (`--quality-max-offset-seconds`, default 30)."
— https://pypi.org/project/ffsubsync/

`[FACT]` **Two cost tiers, and the cheap one is nearly free:**
- Reference = a **subtitle file** (`.srt/.ass/.ssa/.sub`): "ffsubsync derives the speech signal
  straight from the reference's on/off subtitle timings. **No audio is extracted**, so this is
  the fastest path (typically **under a second**)."
- Reference = **embedded text-subtitle stream in the container**: the default detector
  `subs_then_webrtc` "first tries to use an embedded text-subtitle stream from the reference,
  and only falls back to the WebRTC audio VAD if no usable embedded subtitles are found" —
  described as "a perfect speech signal — far cheaper and often more accurate than running a
  VAD over the audio."
- Reference = **audio/video**: needs ffmpeg audio extraction; "usually finishes in 20 to 30
  seconds" (on normal desktop hardware).
— https://ffsubsync.readthedocs.io/_/downloads/en/latest/pdf/ , https://github.com/smacke/ffsubsync

`[FACT]` Cost-reduction knobs for weak hardware: `--max-duration-seconds N` (only first N
seconds); `--multi-segment-sync` sampling N short segments across the timeline
(`--segment-count`, default 8; `--skip-intro-outro`; `--parallel-workers`) — which still
detects framerate mismatch because each segment keeps its true timeline position;
`--extract-audio-first`. Also `--split-penalty` for alass-style piecewise alignment (handles
commercial-break cuts / director's cuts where one global offset can't work).
`[INFER]` `--multi-segment-sync --skip-intro-outro` is close to purpose-built for the
router-CPU constraint: it turns "decode the whole audio track" into "decode ~8 short windows".

`[FACT]` Two more directly-usable properties:
- **Programmatic API with progress callback**: `ffsubsync.run(args, progress_handler=...)`,
  args built via `make_parser()`, `ProgressInfo.fraction` → drives a real progress bar in the
  workflow tab. Handler exceptions are logged and swallowed, never abort the sync.
- **Robust legacy-encoding handling** — `--encoding infer` tries cchardet → charset_normalizer
  → chardet, decodes with `errors="replace"`. Explicitly called out as something "ffsubsync
  does well compared to other subtitle sync tools". `[INFER]` For Chinese fansub subs (GBK /
  Big5 / UTF-16-BOM in the wild) this is a meaningful free win.
- Official Docker image: `ghcr.io/smacke/ffsubsync:latest`.
- Supports SRT, ASS/SSA, WebVTT, MicroDVD.

`[INFER]` **The product idea this unlocks:** a per-subtitle "sync confidence" badge in the
triage tab. Run ffsubsync in *measure-don't-modify* mode against the best available reference
(preferring an embedded text-sub track or an already-trusted sibling subtitle — the sub-second
path — falling back to segment-sampled audio VAD). Surface: detected offset, framerate ratio,
alignment score, and whether a piecewise split was needed. That answers "is this subtitle
actually right for this file?" *without ever decoding video, without a player, and without the
user leaving the dashboard* — which is precisely the user need behind the reddit question in
§2.1, and it's a need Bazarr does not currently meet.

### 3.4 Alternatives / adjacent tools (from ffsubsync's own README)

`[FACT]` — https://github.com/smacke/ffsubsync
- `kaegi/alass` — Rust, dynamic-programming alignment; handles split/piecewise desync natively.
  `[INFER]` Single static binary, no Python/PyTorch → attractive for a small container.
- `sc0ty/subsync` — speech-to-text + word-morpheme matching. Community reports "95+% correct"
  vs ffsubsync, wired into Bazarr via the custom post-process command hook
  (https://www.reddit.com/r/bazarr/comments/1hr19ug/using_ffsubsync_or_sc0tys_subsync/).
  `[INFER]` Heavier (needs per-language speech models — one commenter couldn't locate the
  Japanese model) — likely too heavy for the router.
- `tympanix/subsync` (neural), `oseiskar/autosubsync` (spectrogram + logistic regression),
  `pums974/srtsync` (WebRTC VAD + FFT cross-correlation).
- ffsubsync's own `--vad` options: `webrtc` (default), `auditok` (better on low-quality audio),
  `silero` (neural, needs PyTorch — `[INFER]` **avoid on the router**, PyTorch is enormous),
  and `fused:{intersection,union,weighted}`.

`[INFER]` Recommendation within this space: **ffsubsync (webrtc/auditok VAD only, no torch
extra) as primary, alass as the piecewise/second-opinion engine.** That mirrors Bazarr+'s
multi-engine + side-by-side comparison design (§2.1), which is independent evidence the
pattern is right.

### 3.5 Waveform alignment display

`[UNVERIFIED / INFER]` No dedicated tool was found in this pass for "subtitle-vs-audio-waveform
alignment visualisation" as a library. Building it is not hard in principle — ffsubsync already
computes both binary speech vectors, so plotting *those two vectors overlaid* (rather than a
true waveform) is a near-free byproduct of §3.3 and is arguably a **better** visualisation than
a waveform: it shows exactly what the aligner saw and why it scored what it did. Subtitle
editors (Aegisub, Subtitle Edit) are the desktop prior art for waveform+cue editing.
`[INFER]` Extracting/serving a real downsampled waveform for a whole 2-hour DTS-HD track does
require decoding the audio track — cheaper than video but not free; the speech-vector plot
avoids that entirely if you're already running the aligner.

### 3.6 Net assessment of §3

`[INFER]` The combination — JASSUB canvas preview + server-side still frames + ffsubsync-as-
scorer with confidence badges + a Bazarr+-style before/after diff for sync and for LLM
translation output — delivers essentially the *entire user-facing benefit* of "let me verify
this subtitle quickly," at a small fraction of the cost of any playback option, on 100% of the
library, with no second product for the user to learn.

## 4. Embedding Jellyfin playback inside another app

### 4.1 iframe embedding — mechanically possible, practically miserable

`[FACT]` Framing is controlled by the embedded app's `X-Frame-Options` / CSP
`frame-ancestors`. If neither header is sent, framing is allowed by default:
> "If this header is not sent, and the website has not implemented any other mechanisms to
> restrict embedding (such as the `frame-ancestors` CSP directive), then the browser will allow
> other sites to embed this document."
— https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Frame-Options

`[INFER, medium confidence]` I found **no evidence that jellyfin-web itself sends
`X-Frame-Options` or `frame-ancestors`**, and considerable circumstantial evidence that it does
not: people routinely embed Jellyfin in Organizr / Homarr / gethomepage dashboards via iframe
widgets, and the failures they report are *not* framing-refusal errors. Do not treat this as
settled — **verify with one `curl -I` against the target Jellyfin build before designing around
it** (Open Questions). Note also that a reverse proxy in front of Jellyfin may add these
headers even if Jellyfin doesn't.

`[FACT]` What actually breaks in the wild when people iframe Jellyfin:
- **Mixed content / reverse-proxy base-URL problems.** Organizr + Jellyfin: "Jellyfin just
  won't work, unless opened in a new window… `Blocked loading mixed active content
  "http://{sub}.{domain}/jellyfin/"`". Moderator diagnosis: incomplete nginx config, missing a
  separate `location` for **Jellyfin's websocket**, and base-URL misconfiguration.
  — https://forum.jellyfin.org/t-jellyfin-organizr-iframe
  `[INFER]` Jellyfin's web client depends on a websocket for session/state; any embedding must
  proxy that correctly, and it's a classic silent-failure source.
- **Cross-origin cookie/session death.** The mirror-image case (Jellyseerr framed inside
  Jellyfin) shows the generic problem precisely: "I can see the login page but I can't connect,
  error 401 unauthorized… the problem was due to cookies and probably to the sharing of cookies
  between domains". API-key auth "works but the connection is auto on the Owner account, not
  usable as I'm sharing the server". — https://github.com/seerr-team/seerr/issues/455
  `[INFER]` This is the auth pass-through problem in a nutshell, and it now has a *structural*
  cause: modern hardening guidance is to set auth cookies `SameSite=Lax`/`Strict` precisely
  "so they aren't sent in cross-site iframe requests"
  (https://www.iframeaudit.com/). Cross-origin iframe + cookie session is a fight against the
  direction the platform is moving.
- **Navigation/back-button/deep-link coordination** is a known irritant: Organizr issue
  "open existing jellyfin tab (iframe)" — clicking an item opens a new tab instead of reusing
  the frame. — https://github.com/causefx/Organizr/issues/1633
- `[FACT]` The one project that made Jellyfin↔Jellyseerr iframe integration look seamless did
  it by **forking and rebuilding jellyfin-web** with overwritten `home.html` + injected CSS,
  then replacing the `jellyfin-web` directory on the server.
  — https://github.com/matthijsvrenswoude/IframeJellySeerr
  `[INFER]` That is an upgrade-blocking, unmaintainable coupling. Strong evidence that "make
  the iframe feel native" costs a fork.

`[INFER]` Verdict on iframing jellyfin-web: it will *probably load*, and it will *definitely*
look and feel like a second product bolted into a tab — different visual language, its own
login, its own navigation, its own back-button semantics. It fails the stated goal ("the user
never learns a second product exists") on UX grounds even where it succeeds technically.

### 4.2 Deep-linking

`[UNVERIFIED]` I did not confirm the exact 10.11-era deep-link route in this pass. The commonly
cited forms are `/web/index.html#!/details?id=<itemId>` and `/web/#/video?id=<itemId>`.
`[INFER]` These are hash-route internals of a SPA with no stability guarantee across versions —
jellyfin-web has changed routing conventions before. Depending on them is a maintenance
liability. Verify against the pinned version and expect breakage on upgrade.

### 4.3 Using Jellyfin's API to build your own player UI

`[FACT]` Auth model (three forms, all via the `Authorization: MediaBrowser …` header):
API key (`Token="<apikey>", Client=…, Device=…, DeviceId=…, Version=…`), user access token
(same shape), or client-info-only for the pre-login handshake. An `ApiKey` **query parameter**
exists for when the header can't be used, with the explicit warning "Avoid using this option if
possible. Never use the ApiKey query parameter and the Authorization header at the same time."
— https://gist.github.com/nielsvanvelzen/ea047d9028f676185832e51ffaf12a6f
`[INFER]` For a `<video src=…>` or HLS URL you cannot set headers, so you're forced onto the
discouraged query-param path (or a proxy that re-adds the header).

`[FACT] ` **Security bug worth knowing before you architect around stream URLs:** Jellyfin's
`/Videos/{itemId}/stream.mkv?Static=true&…&api_key=…` returns media **even when the API key is
invalid** — the server logs `"CustomAuthentication" was not authenticated. Failure message:
"Invalid token."` and then serves the content anyway. Reported to affect direct-stream
endpoints (`/Videos`, `/Audio`). — https://github.com/jellyfin/jellyfin/issues/13777
`[INFER]` Two implications: (a) don't rely on Jellyfin's stream endpoint as an authorization
boundary; (b) if subtitle-scout proxies these URLs to its own users, it inherits the exposure.

`[INFER]` The deeper problem with "use Jellyfin's API, build our own player": **it does not
avoid any of §1's constraints.** `PlaybackInfo` + HLS gives you browser-compatible segments
only because *Jellyfin's ffmpeg transcodes/remuxes them on the server*. So this option (i) still
requires the full Jellyfin container running on the router, (ii) still burns router CPU for the
DTS-HD→AAC transcode, (iii) still hits the client HEVC hardware lottery, and (iv) now also
requires you to write and maintain a player, a DeviceProfile negotiator, and subtitle
rendering. You'd be reimplementing jellyfin-web's hardest component while keeping every one of
its costs. And recall §1: jellyfin-web's own DeviceProfile logic is *currently broken* for MKV
in Chrome (jellyfin-web#7651). **This is the worst option on the board** — maximum effort,
maximum coupling, no benefit over just iframing.

### 4.4 Net assessment of §4

`[INFER]` Ranked, least-bad first:
1. **Deep-link out to Jellyfin in a new tab** (if the user happens to have one). Trivial,
   honest, zero coupling. But requires the user to know Jellyfin exists — exactly what the
   owner wants to avoid.
2. **iframe** — probably loads, feels foreign, auth/websocket/deep-link fragility, and making
   it feel native historically cost a jellyfin-web fork.
3. **Custom player on Jellyfin's API** — all the costs of #2 plus reimplementing the hardest
   part of jellyfin-web. Not recommended under any scenario.

## 5. Docker-compose "bundled but hidden" dependency pattern

### 5.1 Can Jellyfin's first-run be automated headlessly? YES — and it's been done publicly

`[FACT]` **The best single source found in this research**: a Terraform/OpenTofu module that
provisions Jellyfin from a cold container to fully-configured, no GUI:
— https://www.reddit.com/r/jellyfin/comments/1qaerkw/fully_automated_jellyfin_setup_with_sso_rbac/
(2026-01; links a Jellyfin module, OIDC module, and example config)

What it automates: `[FACT]`
- "the Startup wizard completion (including the quirky user creation step)"
- plugin installation (DLNA, SSO-Auth), library creation with templated metadata options,
  SSO config, role→library RBAC mapping.

Its documented gotchas — **read these as the real cost estimate**: `[FACT]`
- **"Startup wizard quirk: `GET /Startup/User` must be called before `POST` (creates internal
  user — completely undocumented!)."**
- "Docker networking: Container can't reach host IP — use `host-gateway` in `extra_hosts`."
- "Plugin activation restart: Currently uses a fixed 1-minute `time_sleep` after restart. Not
  elegant, but reliable. The `/health` and `/System/Ping` endpoints return too early (before
  Jellyfin even started to 'restart')."
- "Proper library IDs aren't available until after the restart completes… if the restart is not
  carried out before retrieving the libraries + their IDs, **one random library always lacks an
  ID**."
- "**Jellyfin's actual defaults don't match what the API docs claim!**" (re: library options
  templates)

`[FACT]` A second, independent confirmation from the Jellyfin forum — an unattended
configuration script that: sets language, adds `StartupUser` with admin/pass, marks startup
complete, generates an API key if absent, configures network settings, installs the LDAP plugin
+ restarts, configures LDAP, creates 2 libraries with options. Notably: network settings are
"a nasty bit of **file replacement**, can't be done though API".
— https://forum.jellyfin.org/t-jellyfin-unattended-configuration

`[FACT]` Supporting pieces exist: `--nowebclient` and `--noautorunwebapp` ("Run headless if
startup wizard is complete") server flags
(https://old.jellyfin.org/docs/plugin-api/Jellyfin.Server.StartupOptions.html), and an
agent-oriented CLI wrapper `unbraind/jellyfin-cli` with `jf setup --server … --api-key …`
(https://github.com/unbraind/jellyfin-cli).

`[INFER]` So the honest answer to "can it be provisioned invisibly?" is: **yes, and the
community has proven it — but the proof is simultaneously the bill.** Undocumented ordering
requirements, sleep-based restart choreography because health endpoints lie, docs that don't
match runtime defaults, at least one setting only reachable by editing config files. This
provisioning script becomes a permanent part of subtitle-scout's maintenance surface, and every
Jellyfin minor release is a chance for it to silently break at *first-run for a new user* —
the worst possible place to have a bug.

### 5.2 Resource cost, upgrade coupling, ports

`[INFER — not sourced this pass; needs measurement]`
- **Idle footprint**: a Jellyfin container idles at a few hundred MB RSS and does periodic
  library scans / metadata fetches / image extraction. On a low-power x86 router with a modest
  RAM budget this is not free, and it competes with subtitle-scout's own LLM/provider work.
- **Load footprint**: the moment anyone presses play on a DTS-HD 4K REMUX, ffmpeg wants to
  transcode. On this hardware that is a failed playback + a pegged CPU + possibly a degraded
  router. **The failure mode isn't "slow video", it's "the user's home network gets worse."**
  That is a much worse product outcome than "we don't have playback."
- **Upgrade coupling**: you now pin and ship someone else's server. Their schema migrations,
  their breaking API changes, their CVEs, on your release cadence. See also §2.2 (Sub-Zero) for
  where this road ends.
- **Port exposure**: 8096/8920 either exposed (user discovers the second product — defeats the
  purpose) or kept on an internal compose network and reverse-proxied through subtitle-scout
  (more proxy surface, websocket proxying, and the §4.1 cookie/base-URL problems).
- **Storage**: a second metadata/image cache duplicating what subtitle-scout already knows from
  TMDB.

### 5.3 The "bundled but hidden" pattern generally

`[INFER]` Projects do bundle heavy dependencies in compose (databases, Redis, search engines,
headless browsers) and it works well when the dependency is **stateless-ish, invisible, and
has no competing UI**. Jellyfin fails all three: it is stateful (its own DB + library model
that must be kept reconciled with subtitle-scout's), it has a *full competing web UI and login*,
and it wants to own the library concept — the very thing subtitle-scout's de-Jellyfin refactor
extracted. `[INFER]` Bundling Postgres is invisible. Bundling Jellyfin is bundling a
**second product**, and reconciliation between two library models is a permanent source of bugs
the 7-phase refactor was specifically undertaken to eliminate.

### 5.4 Honest counter-case

`[INFER]` For fairness: **if** the target user's clients were all Apple devices (Safari
+ VideoToolbox HEVC) and **if** the audio were AAC/AC3 rather than DTS-HD, and **if** the
router had QuickSync with a working VAAPI HEVC path, a bundled Jellyfin doing
`-c:v copy -c:a aac` HLS would work acceptably. The stated library and hardware negate all
three conditions simultaneously. This option isn't bad in the abstract; it's bad *here*.

## Option comparison table

Library composition assumed for the "% playable" column: 4K HEVC REMUX w/ DTS-HD MA or TrueHD
(call it ~50%), 1080p WEB-DL H.264 w/ AAC or E-AC3 (~50%, of which maybe half is AAC). Effort
estimates are `[INFER]` and assume one competent developer already fluent in the codebase.

| # | Option | Effort | Router CPU | % of library actually playable/previewable | Maintenance burden | User must know about a 2nd product? |
|---|---|---|---|---|---|---|
| A | **No playback; deep-link / "copy path" / `.strm` handoff to user's own player** | ~0.5–1 day | **Zero** | **100%** (mpv/VLC play everything incl. styled `.ass` via libass) | Near-zero | No (their player is already theirs) |
| B | **JASSUB `.ass`/`.srt` preview on canvas, no video** | ~2–4 days | **Zero** (client-side WASM) | **100%** of subtitles; 0% of video | Low — one npm dep; CJK font sourcing is the real work | No |
| C | **B + server-side ffmpeg still-frame extraction** (subtitle rendered over a real frame) | +2–3 days | Low, **bursty one-shot** (needs benchmarking) | ~100%, assuming ffmpeg can seek+decode 1 frame of HEVC in reasonable time | Low-moderate (ffmpeg invocation, cache, cleanup) | No |
| D | **ffsubsync/alass as a sync-confidence scorer + before/after diff** | ~4–7 days | Low if using embedded-subtitle or sibling-subtitle reference (sub-second); moderate with `--multi-segment-sync` audio VAD | **100%** (never decodes video; audio VAD path decodes audio only) | Moderate (two engines, scoring thresholds, queueing) | No |
| E | `<video>` direct play, no transcode | ~1–2 days | Zero (just serves bytes) | **~10–25%** at best — only 1080p H.264 + AAC, **and** only after MP4 remux since MKV fails in `<video>` (jellyfin-web#7651) | Low but constant "why won't this file play" support load | No |
| F | Server-side remux/transcode built in-house (video copy + audio→AAC + HLS) | ~3–6 weeks | **High per stream**; DTS-HD 7.1→AAC is real work, and 4K HEVC→H.264 fallback is impossible on this box | ~50–70% *if* the client wins the HEVC hardware lottery; less on Firefox/Linux clients | **High** — you now own a transcoding media server | No |
| G | Bundle Jellyfin hidden in compose + iframe its player | ~2–4 weeks (mostly provisioning + proxy) | **High** (idle scans + per-stream ffmpeg) | ~50–70%, same client lottery as F | **High** — headless provisioning script vs. undocumented API ordering, plus proxy/websocket/cookie plumbing, plus upgrade coupling | **Effectively yes** — different look, own login, own nav; and any breakage surfaces as Jellyfin |
| H | Bundle Jellyfin + build custom player on its API | ~4–8 weeks | High (same as G) | ~50–70%, same lottery | **Highest** — all of G plus owning DeviceProfile negotiation & subtitle rendering | Yes (leaks on every error) |
| I | WASM software decode in browser (libav.js / ffmpeg.wasm) | ~4–8 weeks R&D | Zero server, **brutal client CPU** | `[INFER]` ~0% for realtime 4K HEVC; possibly viable for short clips only | High + novel patent exposure (shipping HEVC/DTS decoders) | No |
| J | mpv.js / WebChimera embedded player | N/A | N/A | N/A | **Impossible** — PPAPI/NPAPI removed from Chromium; WebChimera abandoned | N/A |

`[INFER]` The table's shape is the finding: **A+B+C+D together cost roughly 2 weeks, use
almost no router CPU, cover 100% of the library, and require no second product — while F/G/H
cost 3–8 weeks, degrade the user's home network under load, and cover barely half the library.**
The "cheap" options aren't a compromise here; they dominate on every axis that matters.

## Recommendation

**Do not build playback. Build verification.** The evidence points one way, and it is not close.

### The case against building playback

1. `[FACT]` **DTS-HD MA / TrueHD cannot be decoded by any browser on any platform.** Roughly
   half the library is therefore un-direct-playable *by physics of codec licensing*, not by
   effort. Any in-browser playback of those files mandates server-side audio transcode on a box
   explicitly described as not transcoding-capable.
2. `[FACT]` **HEVC in Chromium is hardware-only, with no software fallback, by deliberate
   patent-avoidance policy** — so even a perfect server-side remux leaves playback dependent on
   the viewer's GPU and browser. Firefox and Edge users, and Linux users without VAAPI, lose.
   Failure is silent (`canPlayType()` returns `""`).
3. `[FACT]` **MKV is unsupported in `<video>` everywhere**, and Jellyfin — with years of
   device-profile engineering — *still* ships a Chrome DirectPlayProfile that causes silent
   0 ms playback failure with no error in UI or logs (jellyfin-web#7651, open, 2026-03). That
   is the maintenance reality of this problem space.
4. `[FACT]` **The category leader deliberately has no player and no preview**, after ~8 years.
   Bazarr's answer to "how do I verify?" is scoring + ffsubsync + "watch it in your player,"
   and the community accepts that. When its fork finally addressed verification, it built a
   **before/after text diff and a subtitle editor** — not video.
5. `[FACT]` **Sub-Zero is the cautionary precedent**: the subtitle tool that lived inside a
   media server was killed by that media server's roadmap ("THIS PLUGIN IS DEPRECATED, PLEASE
   USE BAZARR"), while the standalone sidecar won the category. Re-coupling to Jellyfin is
   replaying that with a friendlier host.
6. `[INFER]` **The worst-case outcome is not "no video" — it's "the router got slow."** A user
   pressing play on a 4K REMUX and degrading their own home network is a far more damaging
   product experience than a dashboard that honestly says "open in your player."
7. `[INFER]` **Playback is not the product.** The stated core value is acquisition + quality
   (TMDB identification, multi-provider search, LLM translation). Every week spent on
   transcoding is a week not spent on the thing that has no competitor.

### What to build instead (ordered)

`[INFER]` A "verification suite" that beats Bazarr at the actual user need, and costs ~2 weeks:

1. **Handoff, done well** (~1 day). Per-item: copy-path, `file://`/SMB/NFS URI, an
   `mpv://`-style or `.strm`/`.m3u` download, and — *if and only if* the user has configured a
   Jellyfin/Emby/Plex base URL in settings — a deep link. Optional, user-supplied, never
   bundled. This is the honest 100%-coverage playback answer.
2. **Sync-confidence badge** (~4–7 days, the highest-value item). ffsubsync in
   *measure-don't-modify* mode. Prefer the sub-second reference paths (embedded text-sub track,
   or a sibling subtitle already trusted); fall back to `--multi-segment-sync --skip-intro-outro`
   audio VAD. Surface detected offset, framerate ratio, alignment score, and whether piecewise
   split was needed. Use `--vad=webrtc`/`auditok` only — **no PyTorch/silero on the router**.
   Add `alass` as a second engine for split/piecewise cases. This directly answers the reddit
   question from §2.1 that Bazarr cannot.
3. **JASSUB canvas preview** (~2–4 days). Render the actual styled `.ass` at N cue timestamps
   with `manualRender()`, no `<video>` element. Budget the CJK font work explicitly: extract
   MKV-attached fonts server-side with ffmpeg (`-dump_attachment`) — the correct fix for fansub
   files — plus one subset CJK WOFF2 fallback.
4. **Still-frame backdrop** (~2–3 days, *after benchmarking* — see Open Questions). `ffmpeg -ss`
   input-seek + `-frames:v 1`, cached. Composite the JASSUB canvas over it. Gate this behind a
   settings toggle so it can be disabled on weak hardware.
5. **Before/after diff for sync AND for LLM translation** (~2–3 days). Copy Bazarr+'s
   `SyncOutputCompareModal` pattern. `[INFER]` This is doubly valuable for subtitle-scout
   because LLM translation output has exactly the same "is this better or worse?" review need,
   and no existing product solves it.

### If the owner insists on in-product playback anyway

`[INFER]` The least-bad path, in this order, and only with eyes open:
- Ship option **E** (`<video>` for the 1080p H.264+AAC subset, with server-side MP4 remux —
  `-c copy`, cheap) behind a label that honestly says *"preview supported for some files"*,
  plus option **A** for everything else. This gets a real player in the UI for perhaps 10–25%
  of the library at low cost and near-zero CPU. Explicitly do **not** attempt to grow it into F.
- Do **not** bundle Jellyfin. If the user already runs one, offer a settings field for its URL
  and deep-link out. That inverts the coupling in the direction §2.3 shows the ecosystem
  actually uses (player → subtitle tool), and it keeps the de-Jellyfin refactor's win intact.

### One-line verdict

`[INFER]` The de-Jellyfin refactor was correct and should not be reversed. The owner's real
concern — "users can't verify a subtitle without deploying another product" — is legitimate and
is **fully solvable without any playback at all**, more cheaply and with better library
coverage, via ffsubsync scoring + JASSUB preview + honest handoff.

## Open questions

**Blocking / must-measure before committing to anything above:**
1. **How long does `ffmpeg -ss <t> -i <4K HEVC REMUX> -frames:v 1 out.jpg` actually take on the
   real iStoreOS box?** Gates option C. Test cold cache, mid-file seek, both HEVC 4K and H.264
   1080p. If it's >5 s, drop C and ship B alone.
2. **How long does ffsubsync's audio-VAD path take on the same box** for a 2-hour DTS-HD track,
   with and without `--multi-segment-sync --skip-intro-outro`? Gates the fallback tier of
   option D. (The embedded-subtitle path is documented as sub-second and is safe regardless.)
3. **What fraction of the library actually has an embedded text-subtitle track** to use as a
   free ffsubsync reference? This single number determines whether D is nearly-free or
   moderately expensive. Answerable from existing scan data — check before designing.
4. **Does the target Jellyfin build send `X-Frame-Options` / CSP `frame-ancestors`?** One
   `curl -I` settles §4.1's main `[INFER]`. Only matters if G is still on the table.

**Product / scoping:**
5. What does "verify" actually mean to the owner — *"is this the right subtitle for this file"*
   (→ option D solves it) or *"is the translation any good"* (→ option 5, the diff view) or
   *"does the typesetting render correctly"* (→ option B)? These are three different features
   and the answer changes the priority order. **Worth asking directly before building.**
6. What fraction of users are expected to already run *any* media player/server? If it's high,
   option A is nearly sufficient on its own.

**Unresolved research gaps:**
7. **Subliminal's UI/verification surface** — inferred to be CLI-only (§2.4) but not separately
   verified.
8. **ASS.js (`weizhenye/ASS`)** feature completeness vs libass — relevant because it uses the
   browser font stack and would sidestep the CJK font problem entirely. Worth 30 minutes;
   could materially simplify option B.
9. **alass** benchmarked/qualitative accuracy vs ffsubsync on Chinese fansub `.ass` — the
   only evidence found was ffsubsync's own README listing it and community preference for
   `sc0ty/subsync` ("95+% correct"), which is too heavy for the router.
10. **Jellyfin deep-link route stability** across 10.10→10.11 (§4.2) — unverified; only matters
    for the optional settings-field deep-link in the recommendation.
11. **Real waveform rendering cost** vs the proposed speech-vector plot (§3.5) — no library
    prior art found for browser subtitle/waveform alignment views; may be worth a second pass
    if the owner specifically wants a waveform.
