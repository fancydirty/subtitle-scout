# Async verification UX & API design patterns

**Date:** 2026-07-29
**Context:** subtitle-scout is adding per-subtitle timing-alignment verification. Reference source is
an embedded subtitle track (63.7% of items) or audio decode (~14s/file locally, not viable on
cloud-mounted files). Results surface as a per-episode-row badge + detail panel + one-click
"correct timing" action.

**Status:** IN PROGRESS — see Progress log. Findings are appended after every search batch, so a
truncated file still tells you what was covered.

**Labeling convention:** `[FACT]` = directly sourced with URL. `[INFERENCE]` = my reasoning from
sourced facts. `[ASSUMPTION]` = unverified, needs checking.

---

## Progress log

| # | Batch | Status | Notes |
|---|-------|--------|-------|
| 0 | Skeleton created | done | file + structure in place |
| 1 | Q1: Jellyfin trickplay/chapter-image generation + Immich ML job queue | done | strong primary sources: jellyfin issues #14558, #12974, #11730; immich docs/FAQ, discussions #3625, #21733, issue #17830 |
| 2 | Q1: Bazarr/*arr per-item expensive checks + first Q3 signals | done | Bazarr wiki performance-tuning page is the key source; maintainer explicitly refused bulk retro-sync. Also found subsyncarr backup behaviour → feeds Q3 |
| 3 | Q2: alert-fatigue thresholds + linter severity models | done | NNG video, squareops 3-layer framework, Biome/Dart/stylelint severity semantics. Best find: hudochenkov's "severity by whether the fix changes behaviour" rule |
| 4 | Q2 diagnosis-vs-score + Q3 confirm-vs-undo | done | NNG confirmation-dialog article is the primary source for Q3. Q2: found a real tension — literature says "don't show raw numbers", NOT "hide uncertainty". Flagged below; PO principle needs refining, not adopting wholesale |
| 5 | Q3 backups in subtitle tools + idempotency prior art | done | bazarr #1715 = the canonical "it modified files I told it not to" complaint. Sanity's `_migrations` idempotence-marker is a near-exact fit for our problem |
| 6 | Q4 useSyncExternalStore per-row subscriptions + React Query reconciliation | done | philparsons.co.uk write-up is near-exact prior art (100-row list, per-item subscribe, perf traces). react.dev + reactwg/react-18#86 for the primary API semantics |
| 7 | Executive summary, 28 design decisions (D1–D28), 11 risks (R1–R11) | done | **RESEARCH COMPLETE.** All four questions answered. One open product disagreement flagged at D11/R7 needing a PO decision |

---

## Executive summary

**Compute timing:** go hybrid and tiered — verify eagerly on import using the cheap embedded-track
reference, offer an opt-in off-hours backfill, and never run the expensive audio-decode path
unattended or on cloud-mounted files; Jellyfin, Immich, and Bazarr all converged on
eager-on-arrival plus an off-hours sweep, and Bazarr's maintainer flatly refused a library-wide audio
sync because it would *"overload your server for a couple of days"*. Because our router is weaker than
the Celeron NAS and Pi 4 boxes where Immich users had to serialize everything, the only safe default is
a **global** in-flight budget of 1 enforced at claim time — per-job-type limits are documented as
insufficient. **Score presentation:** never show a number; show a diagnosis with its evidence and a
next action ("runs 8.3s late · matched 412/430 cues at a constant shift"), say *nothing* when a
subtitle is aligned, key badge severity to **fixability rather than offset magnitude**, and group a
season's shared offset into one finding instead of thirteen badges. One caveat the product owner must
rule on: the literature's dominant warning is against *silent* false confidence and automation bias, so
"never show a raw number" is well supported but "hide all uncertainty" is not — happily, staying silent
on aligned rows satisfies both, since silence claims nothing while a green "aligned 0.94" makes a
promise we can't keep. **Safety rule:** a timing shift is perfectly reversible, so ship an undo toast
and a durable "restore original" instead of a confirmation dialog — but *earn* that by writing backups
atomically (temp+rename, never truncate in place), refusing to touch subtitles we didn't install, and
guarding against double-application with a corrections ledger, a content-hash check, and ideally by
re-verifying immediately before correcting so the guard tests the real post-condition.

---

## Q1 when to compute

### Jellyfin — trickplay & chapter images (closest analogue to our problem)

Jellyfin's trickplay generation is *structurally identical* to our problem: an expensive per-item
ffmpeg pass producing derived data that is nice-to-have, not required for the core feature.

**[FACT] The settings surface Jellyfin converged on** (per-library + global), from the NixOS options
mirror of Jellyfin's trickplay config
(https://kiriwalawren.github.io/nixflix/reference/jellyfin/system/trickplayOptions/) and the
per-library UI reported by users:

| Setting | Meaning | Why it exists |
|---|---|---|
| `Enable trickplay` (per library) | master off switch, **per library** | users with libraries where it's pointless |
| `Extract trickplay images during the library scan` | **eager vs. deferred** toggle | decouples ingest latency from derived-data cost |
| `scanBehavior: NonBlocking \| Blocking` | non-blocking default: "add media to the library before trickplay generation is done" | ingest must never be gated on derived data |
| `processPriority` (default `BelowNormal`) | OS-level nice value for the ffmpeg child | "If you notice slowdown while generating trickplay images but don't want to fully stop their generation, try lowering this as well as the thread count" |
| `processThreads` (default `1`) | ffmpeg `-threads` | hard cap on parallelism inside one job |
| `qscale` / `jpegQuality` / `interval` | quality/cost dial | let users trade fidelity for time |
| Scheduled task `Generate Trickplay Images` w/ cron trigger | the batch backfill path | run at 3am |
| `Save trickplay images next to media` | sidecar vs. internal storage | user control over where derived artifacts land |

Plus a **global** knob: `Maximum number of parallel tasks during library scans`, whose in-app help
text is itself an admission of the failure mode — *"Setting this to 0 will choose a limit based on
your systems core count. WARNING: Setting this number too high may cause issues with network file
systems; if you encounter problems lower this number."*
(https://www.reddit.com/r/jellyfin/comments/1qy4ts5/extremely_low_cpu_utilization_during_library_scan/)

**[FACT] What users actually complain about** — this is the important part, because it tells us which
defaults are wrong:

1. **It never finishes.** A user reports being *"at 92.8% after almost exactly 228 hours of trickplay
   file generation"* (~9.5 days), config dir grown from ~30 GB to 76 GB.
   (https://forum.jellyfin.org/printthread.php?tid=5846). Another: 200 episodes took ~10 hours, so a
   10K-episode library was *"No way ... gonna be done this year"*
   (https://www.reddit.com/r/jellyfin/comments/1pjoinu/trickplay_images_not_generating/)
2. **Idle CPU pegged, and the cause is invisible.** *"Disabling chapter image extraction dropped my
   idle CPU from 60% to 5%. That feature is a silent killer on large libraries."*
   (https://jellywatch.app/blog/fix-jellyfin-high-cpu-usage-2026) Also
   https://github.com/jellyfin/jellyfin/issues/12974 — "More memory and CPU Usage after enabling
   TrickPlay" — CPU/RAM spike *in idle state* after merely enabling it.
3. **The expensive task runs even when disabled.** https://github.com/jellyfin/jellyfin/issues/14558
   — scheduled TrickPlay task burns CPU for hours despite trickplay being disabled on every library.
   *"It's just a basic fanless file server ... it causes unnecessary slowdown in generating TrickPlay
   images that we have no need for."* Sibling bug:
   https://github.com/jellyfin/jellyfin/issues/11730 (generated during scan despite the
   during-scan option being off).
4. **A single bad file poisons the run.** *"came down to a particular video file which caused chapter
   image extraction to fail, saw memory and swap usage reach 100% and then CPU usage spiked to
   100%"*
   (https://www.reddit.com/r/jellyfin/comments/1ov42nd/unable_to_scan_library_jellyfin_eats_all_cpu_and/)
5. **Partial results are confusing, not neutral.** *"Half my library now has trickplay, half of it
   doesn't"* — user has no way to see or reason about coverage
   (https://www.reddit.com/r/jellyfin/comments/1pjoinu/trickplay_images_not_generating/).
6. **Users give up entirely.** *"I kept getting timeout errors and just had to disable trickplay
   altogether"* / *"I continue to just live without — it's really not a huge loss."* (same thread)

**[INFERENCE] Lessons for subtitle-scout:**
- The pattern mature tools converged on is **hybrid**: eager-on-ingest is an *opt-in toggle*, the
  default path is a deferred/scheduled backfill, and ingest is never blocked (`NonBlocking` default).
- Complaint #3 (task runs even when the feature is off) is the single most damaging class of bug for
  trust on weak hardware. Our claim-loop must check the enable flag **at claim time**, not just at
  enqueue time.
- Complaint #2 says: the user must be able to *attribute* CPU load to this feature. Our SSE trace
  already gives us this for free — we should surface "verification is running, N remaining" in the UI
  rather than making it invisible background work.
- Complaint #5 says: **coverage must be a first-class visible number**, not something you infer from
  which rows have badges. "312/400 verified, 88 pending" beats silent partial state.
- Complaint #4 says: per-item failures must be isolated, recorded, and **not retried forever**.
- Complaint #1 quantifies the danger: at ~14s/file our audio-decode path on 400 items ≈ 1.6h
  sequential — tolerable — but the same math on a 10K-item library is ~39h. The *cheap* path
  (embedded track, 63.7%) is what makes this viable at all.

### Immich / PhotoPrism — job queue design and backpressure on weak hardware

**[FACT] Immich's model** (https://docs.immich.app/administration/system-settings/): a **per-job-type
concurrency setting**. Official framing: *"With higher concurrency, the host will work on more assets
in parallel; this advice improves throughput, not latency ... it will make Smart Search jobs process
more quickly, but it won't make searching faster."* That's a useful distinction to inherit — batch
throughput and interactive latency are separate goals with separate mechanisms.

**[FACT] Immich's official low-power guidance** (https://docs.immich.app/FAQ/): *"The initial backup
is the most intensive due to the number of jobs running."* Remedies they recommend, in order:
lower per-job concurrency **to 1**; reduce transcoding threads to 1–2; **swap to a smaller/cheaper
model** (`buffalo_s` instead of `buffalo_l`) accepting lower quality; apply container-level resource
constraints *last* ("only apply these constraints after taking some of the measures here").

**[FACT] Concurrency is a footgun, and maintainers say so.** In
https://github.com/immich-app/immich/discussions/21733, a user with a 65-core/50GB box had set
thumbnail/metadata concurrency to **1000** and had to dial back to **5** to get jobs unstuck.
Maintainer `bo0tzz` responds: *"we often see people set it way too high which definitely causes
problems. Even on a fairly powerful system the numbers don't go as high as you'd expect, especially
on slower storage."* Docs cap advice at *"should still not be above 16 in most cases"* even with a
GPU (https://immich.app/docs/features/ml-hardware-acceleration/).

**[FACT] Per-job concurrency is insufficient — the real problem is *cross-job* saturation.**
https://github.com/immich-app/immich/discussions/3625 ("[Feature] Global Job Concurrency") states it
precisely: *"On low powered systems, the concurrency setting is not enough to guarantee proper
resource use since importing photos will start (for example) generating thumbnails, smart search,
face detection, and facial recognition. **Even if each job is marked to have no concurrency, each of
these will run**, impacting whole system performance."* The requested design is a **priority queue**
with (a) a whole-system thread budget, (b) per-job-type priority ordering, (c) a per-job **weight**
representing relative cost. Corroborated by https://github.com/immich-app/immich/issues/17830 where
Face Detection and Face Recognition each at concurrency 1 still jointly peg the CPU, and pausing one
doesn't release resources.

**[FACT] Users manually serialize jobs to survive.** On a DS918+ (Celeron quad 1.5GHz), a user
reports Immich *"quickly crashed my wimpy Celeron"* at defaults; the fix was setting all concurrency
to 1 except metadata, and they then ask for an explicit **linear one-job-at-a-time order**, pausing
and starting queues by hand
(https://www.reddit.com/r/immich/comments/1rkn4et/order_of_operations_job_queue/). Another
Pi 4 datapoint: *"the limit for a Pi 4 seems to be 3 concurrent Thumbnail jobs (everything else
suspended)"* (discussions #3625). The ecosystem workaround for ingest is
`immich-go --pause-immich-jobs=true` — **pause the derived-data queue during bulk ingest, resume
after** — described as *"makes the processing possible in lower end cpus"* (reddit thread above).

**[FACT] Offload is a recognized escape hatch.** Immich supports remote ML workers, and users ask for
per-worker concurrency because their NAS can't do the work but an occasionally-powered desktop can
(https://github.com/immich-app/immich/discussions/23584).

**[INFERENCE] Lessons for subtitle-scout:**
- Our router is *below* a Celeron DS918+ and a Pi 4 in capability. The Immich evidence says the only
  safe default is **global concurrency 1** for the expensive path — a single serialized verification
  worker, never a per-job-type fan-out.
- Adopt the discussions #3625 design directly: our `jobs` table should carry a **priority** and a
  **cost weight**, and the claim-loop should enforce a **global** in-flight budget across job types,
  not per-type limits. We already have a claim-loop; this is a small change to the claim query.
- Immich's "use a cheaper model" remedy maps exactly onto our two reference paths: **embedded
  subtitle track = the `buffalo_s` cheap path; audio decode = the `buffalo_l` expensive path.** The
  right default is cheap-only, with audio decode opt-in — which conveniently matches the 63.7%
  coverage figure.
- `--pause-immich-jobs` is prior art for a **"pause verification" button** and for auto-pausing the
  verification queue while a user-initiated foreground action (search, download, correct-timing) is
  running. Interactive latency must preempt batch throughput.
- Immich's own framing ("improves throughput, not latency") is the copy we should steal for our
  settings help text.

### Bazarr / Sonarr — the closest domain match, and the most useful precedent

Bazarr's sync feature is *exactly* our expensive path: extract audio, detect speech, align subtitles.

**[FACT] Bazarr's own docs describe the cost in the same terms we're worried about.** From the Bazarr
wiki's Performance Tuning page (https://wiki.bazarr.media/Additional-Configuration/Performance-Tuning/):
*"Settings => Subtitles => Automatic Subtitles Synchronization. To synchronize subtitles, Bazarr may
need to extract audio track to detect speech fragments and align subtitles accordingly. **It may
result in massive network and CPU usage.**"* It is listed on the performance-tuning page as a thing
to turn **off** for weak hardware. Note "network" — that's the cloud-mount problem, called out by the
upstream project.

**[FACT] Same page: disk indexing defaults toward "don't scan".** *"Settings => Scheduler => Disk
Indexing. Change the settings to Manually to Disable it. This means Bazarr won't scan your drive for
existing subtitles and only knows about subtitles that Bazarr added."* So the recommended posture on
constrained hardware is: **know only about what you did yourself; don't sweep the library.**

**[FACT] Bazarr's scheduler collapses overlapping runs rather than queueing them.** The same page
tells users to lengthen search intervals when they see:
`Execution of job "Update movies list from Radarr (trigger: interval[0:05:00], ...)" skipped:
maximum number of running instances reached (1)`. That is a **max-1-instance-per-job-type guard with
drop-on-overlap semantics** — prior art for how not to pile up duplicate sweeps.

**[FACT] The eager-vs-scheduled split, stated by the maintainer's design.** *"Sync happens during the
download process or manually one by one afterwards."*
(https://www.reddit.com/r/bazarr/comments/jcwvf2/syncing_previously_downloaded_subtitles/) There is
**no bulk retroactive sync**, deliberately. In that thread a user explains the reasoning:
*"I suspect morpheus65535 probably wants to keep Bazarr streamlined — going back more than 30 days
would put a big strain on a lot of containers/jails running it today — and keep the built-in sync for
new and recent downloads."* And when asked directly for a library-wide sync button, the answer was
blunt: *"No, that doesn't exist and it would probably overload your server for a couple of days. You
really want to trigger something like this from a webui?"*
(https://www.reddit.com/r/bazarr/comments/s7wcra/automatic_subtitles_synchronization_does_not_work/)

**[INFERENCE] This is the single most important finding for Q1.** The most mature tool in our exact
domain looked at "run the expensive alignment across the whole library" and **refused to ship it**,
because the failure mode is a multi-day server meltdown triggered by one button. Two consequences:

1. **On-import (eager) for the cheap path is the settled design.** Do the work once, at the moment new
   material arrives, when the user already expects activity and the batch size is 1.
2. **A "verify entire library" button is a loaded gun.** If we ship one — and we probably should,
   since our cheap embedded-track path is genuinely cheap, unlike Bazarr's audio-only path — it must
   be rate-limited, resumable, cancellable, and show remaining count/ETA. Bazarr's answer was "don't
   ship it"; ours can be "ship it, but only the cheap path runs unattended, and it is a *queue*, not
   a *loop*."

**[INFERENCE] Our structural advantage over Bazarr:** Bazarr has only the expensive path (audio).
We have a cheap path for 63.7% of items (embedded track — a demux + parse, no decode). That's why we
can offer library-wide verification where Bazarr couldn't. The design should make that asymmetry
explicit rather than averaging the two paths into one "verify" job.

**[FACT] Ecosystem tools fill Bazarr's retro-sync gap with an explicit cron + skip-already-done
design.** `subsyncarr` runs on cron over the library, and the two questions its users immediately ask
are the two questions we must answer:
*"if the cron job runs will it bypass the ones that it already worked on or will it go through all of
them again?"* and *"is there a way to make it so the new synced file will overwrite the main file?"*
(https://www.reddit.com/r/selfhosted/comments/1i92p5q/introducing_subsyncarr_fix_outofsync_subtitles/).
The tool's answer to the second: a `Save location` choice of *"Overwrite existing subtitle"* vs
*"Save next to video with the same filename"* — and *"It will also backup your existing subtitles
before overwriting them."* → carried into Q3.

**[FACT] Whisper-style generation cost, for calibration.** A community setup guide reports Bazarr's
audio-to-subtitle path at *"A 45-minute episode takes 10-15 minutes to transcribe on a decent GPU,
longer on CPU ... This is a last resort, not a primary solution."*
(https://mustafa.net/2026/07/20/bazarr-sonarr-integration-complete-setup-guide/)
**[INFERENCE]** Our ~14s audio-decode figure is ~50x cheaper than that, which is genuinely good news
— our "expensive" path is much cheaper than the thing the ecosystem already calls a last resort. The
binding constraint for us is not CPU-seconds per item but **I/O on cloud-mounted files**, where the
14s becomes unbounded.

### Q1 synthesis — the convergent pattern

**[INFERENCE]** Across Jellyfin, Immich, and Bazarr, four tools independently converged on the same
shape. Stated as a pattern:

1. **Never block ingest on derived data.** (Jellyfin `NonBlocking` default; Bazarr's list-update runs
   independently of sync.) The row appears immediately, unverified.
2. **Eager-on-arrival is the primary path**, because batch size is 1 and the user expects activity.
   (Bazarr: sync during download. Jellyfin: "extract during library scan" toggle.)
3. **Scheduled/backfill is the secondary path, and it is opt-in or off-hours**, never a default
   foreground sweep. (Jellyfin: cron'd scheduled task, users told to move it to 3am. Bazarr: disk
   indexing default "Manually". Immich: pause queue during bulk ingest.)
4. **Cheap tier by default, expensive tier opt-in.** (Immich: `buffalo_s` vs `buffalo_l`; Bazarr:
   audio sync listed as a thing to disable; Jellyfin: `qscale`/interval dials.)

**User-facing settings the mature tools all expose** — this is close to the exact settings list we
should ship:
- master enable/disable, scoped as narrowly as the tool's data model allows (per-library in Jellyfin)
- an **eager-on-import** toggle, separate from the master toggle
- a **schedule** for the backfill (cron/interval, or "Manually" = never)
- a **concurrency/thread cap** (Immich per-job; Jellyfin `processThreads` + global parallel-tasks)
- a **process priority / nice** dial (Jellyfin `processPriority: BelowNormal` default)
- a **quality-vs-cost tier** selector (Immich model choice; ours = embedded-track-only vs allow-audio)
- a **pause/resume** control for the running queue (Immich jobs UI; `--pause-immich-jobs`)
- where derived artifacts are written (Jellyfin "save next to media")


---

## Q2 score presentation

### The product owner's principle is correct, and the literature supports it

**[FACT] NN/g's framing of the dashboard problem is exactly ours.** Their alert-fatigue piece:
*"Dashboards that monitor vast masses of data should guide users' attention to critical values but
not by flashing endless alerts without prioritization."*
(https://www.nngroup.com/videos/alert-fatigue-user-interfaces/) The operative words are *guide
attention* and *prioritization* — not *report all measurements*.

**[FACT] The canonical actionability test.** From practitioner consensus on alert design: *"Alerts
should be actionable. For each alert ask, 'what do we DO when we get this alert?' If the answer isn't
clear, delete the alert."*
(https://www.reddit.com/r/Monitoring/comments/1sjapem/alert_fatigue_is_getting_out_of_control/)
Restated for us: **a badge that doesn't imply an action shouldn't be a badge.**

**[FACT] The three-layer framework — page / ticket / log — with explicit volume targets.** From
https://squareops.com/blog/reducing-alert-fatigue-framework/:

| Layer | Meaning | Target share of volume |
|---|---|---|
| Page | drop everything, needs human now | **< 5%** |
| Ticket | fix during business hours | ~30% |
| Log | recorded, **notifies nobody**, consulted only during investigation | **~65%** |

Their key sentence: *"These alerts show up on dashboards and in runbooks. Engineers consult them when
investigating a page or ticket, but they never generate notifications."* And the tuning rule: *"Any
alert rule that fires more than 5 times per month without resulting in human action should be tuned,
downgraded to a ticket, or removed entirely."* Also relevant to a per-row badge: they call out
**flapping** as *"the single worst contributor to on-call fatigue"* and target **zero** flapping in
the top layer.

**[INFERENCE] Mapping the three-layer framework onto our badge:**
- **Log layer (~65%, no visual noise):** aligned subtitles. The score is *computed and stored*, shown
  in the detail panel when the user goes looking, but **produces no badge on the row**.
- **Ticket layer (~30%, quiet visible marker):** correctable offset. A badge, no color alarm, with the
  fix attached.
- **Page layer (<5%, loud):** not applicable to a subtitle manager — nothing here warrants
  interrupting the user. **[INFERENCE]** Our top severity should be the equivalent of "ticket",
  never "page". There is no such thing as a subtitle emergency.
- **Flapping = zero:** a row must not oscillate between aligned/offset across re-verifications. This
  is an argument for **hysteresis** on the threshold (see recommendations) and for not re-verifying
  unchanged files.

### Linters are the best prior art for "continuous evidence → discrete actionable state"

Linters solve precisely our problem: internally they have graded confidence and many possible
findings; externally they expose a **small ordered set of severities** and are judged on *noise*.

**[FACT] Severity ladders converge on 3–4 levels, with the lowest being non-alarming by
construction.** Dart's analyzer: `info` = *"An informational message that doesn't cause analysis to
fail"*; `warning` = doesn't fail *unless* configured to; `error` = fails
(https://dart.dev/tools/analysis). Biome: `error` / `warn` / `info`, where *"The 'info' severity won't
affect the exit status code of the CLI, even when --error-on-warnings is passed"*
(https://biomejs.dev/linter/). Biome also ships `--diagnostic-level` so users can **raise the floor**
and see less (https://github.com/biomejs/biome/discussions/550).

**[FACT] Oxlint's category names are a semantic model worth copying verbatim** — they encode
*confidence*, not just importance (https://lobehub.com/skills/delexw-claude-code-misc-oxlint):
`correctness` = *"Definitely-wrong code"* (error) · `suspicious` = *"Probably-wrong code"* (warn) ·
`pedantic` / `style` = off by default. The project's stated design goal: *"It prioritizes high-signal
correctness checks by default — things that are incorrect, unsafe, or useless — so teams can adopt it
without drowning in false positives."*

**[FACT] The single most transferable rule I found — severity keyed to whether acting on it changes
behaviour.** Aleksey Hudochenkov (https://hudochenkov.com/posts/linter-severity-levels/):
*"Use the 'error' severity level when fixing violation will change how your code works. Using the
'warning' severity level when fixing a violation will not change how your code works. **If the linter
rule has an auto-fix — use the 'warning' level.**"*

**[INFERENCE] This inverts a naive reading of our problem and is the crux of Q2.** Our
"correct timing" action is an auto-fix. By this rule, a correctable offset is a **warning, not an
error** — precisely *because* we can fix it. The loud/red treatment should be reserved for the case
we *cannot* fix: unparseable subtitle, no reference available, or drift too complex for a linear
shift. So the badge severity is driven by **fixability, not by magnitude of the offset.** A 40-second
offset that we can correct with one click is *less* alarming than a 2-second drift we can't.

**[FACT] Safe vs. unsafe fixes are a first-class, separately-configurable concept.** Biome:
*"rules might emit code fixes that are safe or unsafe. Biome allows configuring a safe fix to be
treated as unsafe and vice-versa. You can also turn the code fix off entirely."* Oxlint splits the
CLI flags: `--fix` for safe fixes, `--fix-dangerously` for unsafe, with agent guidance *"Avoid
--fix-dangerously unless the user explicitly asks for it."* RSigma's linter encodes it in the type
system — `FixDisposition::Safe | Unsafe`, and *"only Safe fixes are applied by ... --fix and by LSP
code actions"* (https://rsigma.io/developers/linter-and-lsp/).

**[INFERENCE]** We should adopt `FixDisposition` explicitly. A constant offset measured against an
embedded reference track = **safe fix**, eligible for one-click and for bulk "fix all". A shift
inferred from audio decode, or a case with drift/rescale, = **unsafe fix**, requiring the detail
panel and an explicit per-item confirmation. This gives us a principled answer to "when do we need a
confirm dialog" that ties into Q3.

**[FACT] Suppression is expected, and its identifiers become a permanent API.** Every linter surveyed
supports per-item suppression (`// oxlint-ignore`, `# noqa: <id>`, `eslint-disable-next-line`,
`errors: {rule: ignore}`). RSigma warns: *"The string ID must be lower_snake_case and stable; never
rename it once shipped (users put it in `# noqa: <id>` comments)."*

**[INFERENCE]** Users will have subtitles we flag that they consider fine — e.g. deliberately offset
subs, or a release where our reference track is itself wrong. We need a **per-item "ignore /
accept as-is" action** that survives re-verification, and our reason codes (e.g.
`constant_offset`, `drift`, `no_reference`) must be **stable identifiers**, because they'll end up in
the DB and possibly in user-visible filters.

**[FACT] Low-noise is a marketed differentiator, not a nicety.** *"Ascent Lint RTL linter is low
noise, it only reports errors and warnings that are real. Other lint tools can generate a lot of
garbage, which makes it hard to sort through."* — and the vendor pairs it with *"easy waiving and
other status tracking"* (https://www.realintent.com/rtl-linting-ascent-lint/). Bicep goes further and
ships a rule **defaulting to Off** purely on false-positive grounds: `use-resource-id-functions`
*"defaults to Off because of potential false positives"*
(https://deepwiki.com/Azure/bicep/10.2-linter-configuration).

**[INFERENCE]** Precedent for our riskiest sub-feature: if audio-decode-derived offsets prove noisy,
shipping them **default-off** is a legitimate, well-precedented choice rather than an admission of
failure.

### Threshold and hysteresis guidance

**[FACT] Duration/persistence requirements are the standard anti-flap tool**, but with a caveat.
Tuning outcomes listed by squareops include *"add a duration requirement (alert only if the condition
persists for 10 minutes)"*. Counter-guidance warns against over-reliance: durations *"can hide fast,
damaging spikes or produce long tailing alerts that confuse responders"*
(https://beefed.ai/en/low-noise-actionable-alerting). Practitioners also cite **flood protection,
duplicate suppression, and "only alert if the issue persists for more than five minutes"** as
standard mechanisms (r/Monitoring thread above).

**[FACT] Group by root cause, not by symptom.** *"the middle ground you're looking for exists but
it's not about tuning, it's about grouping alerts by root cause instead of by symptom. one underlying
issue firing 40 notifications is a correlation problem not a threshold problem."* (r/Monitoring)

**[INFERENCE] This is directly applicable and probably our best UX lever.** If a whole season was
downloaded from one release group and all 13 episodes are +8.3s late, that is **one** finding with 13
affected files, not 13 badges. Surface it as a season/series-level card — *"13 episodes in Season 3
share a +8.3s offset — likely a different release"* — with one bulk fix. This also fixes the
"400 rows all screaming" scale problem, and it's the same correlation insight the monitoring people
arrived at independently.

**[FACT] Alert-fatigue is a documented safety failure, not just an annoyance.** The UX StackExchange
answer on notification thresholds points to *"Never cry wolf"*, a chapter of *Set Phasers on Stun*,
*"which discusses a case where prison guards were desensitized by frequent false alarms, habituating
themselves to ignore the alarm"*, and notes the phenomenon is studied in healthcare, aviation, and
autonomous vehicles
(https://ux.stackexchange.com/questions/123963/are-there-guidelines-on-the-timing-and-frequency-of-notifications).
That answer also gives a usable definition of legitimacy: *"the only appropriate notifications are
those that notify the user of something that has occurred the moment it has occurred and is something
which they want (opted-in) or need to be notified about."*

**[FACT] Scaling from one alert to many is where designs break.** *"a single alert might be
well-designed, but displaying ten of them on one screen would quickly overwhelm users, causing them
to miss critical information"*
(https://thedesignersfieldguide.substack.com/p/how-to-design-to-alert-users-without).
**[INFERENCE]** Our design must be evaluated at N=400 rows with a realistic hit rate, not on a single
mocked row. If 36% of items lack an embedded reference, a naive design produces ~144 "unknown" badges
— which is worse than showing nothing. **"Not verified" must be visually silent.**

---

### Diagnosis instead of score — strongly supported, with one caveat the PO should hear

The research question asked whether there are "strong opinions on showing a *diagnosis* instead of a
*score*". Yes — this is close to consensus in the AI/ML UX literature. But the consensus is
**"don't show raw numbers," not "don't communicate uncertainty."** That distinction matters, and I
think it slightly refines the product owner's principle rather than confirming it wholesale.

**[FACT] Raw numbers are actively harmful because users mis-map them.**
*"A raw '0.73 confidence' is usually meaningless. Users interpret it as '73% correct,' which is
rarely what it actually means."* — and the prescription: ***"Your UI should map uncertainty to a
decision, not a number."***
(https://medium.com/@Modexa/the-confidence-ui-pattern-that-users-actually-trust-ff27e1a8a956)
Same conclusion elsewhere: *"Surface a plain-language confidence indicator adjacent to the AI output.
**Not a percentage; that number carries no intuitive meaning for most users.** Use a label such as
'Based on limited data' or 'High confidence, 3 sources verified' that connects the signal to
something the user can evaluate independently."*
(https://reloadux.com/blog/ai-uncertainty-trust-design-framework/) And: *"Show users a signal of
confidence **without requiring them to understand probability** ... The goal is appropriate trust
calibration, not statistical literacy."*
(https://www.institutepm.com/knowledge-hub/ai-ux-design-patterns)

**[FACT] The recommended replacement is exactly "diagnosis + evidence + next step".**
*"Users don't need a philosophical essay. They need a reason that changes their behavior ...
A warning without an action is just anxiety."* (Modexa, above). The parallel piece prescribes
*"label + reason + next steps + safe defaults"* and **evidence cards** over prose —
*"Users trust receipts more than rhetoric"* — with a worked example whose shape is startlingly close
to what we want:
```
Decision: Refund ₹1,499
Confidence: Likely
Evidence: - Order #91876 (created 10:42 AM)
          - Payment provider: matched charge ID
Conflicts: - Two orders share same name
```
(https://medium.com/@1nick1patel1/confidence-ui-how-agents-admit-uncertainty-and-still-win-34f0c2fb67e7)

**[INFERENCE]** Our detail panel should be an evidence card, not a score readout:
```
Diagnosis: Subtitle runs 8.3s late for the whole file
Evidence:  Reference: embedded English track (eng, SubRip)
           Matched 412 of 430 cues at a constant +8.3s shift
           No drift detected (shift stable across the file)
Likely cause: subtitle made for a different release
Fix:       Shift all cues −8.3s  [Correct timing]
```
Note this contains all the information a score would, expressed as evidence. The "0.94" never
appears, but "matched 412 of 430 cues" is *more* informative and requires no probability literacy.

**[FACT] The blast-radius rule for how visible uncertainty should be.** *"If the user asked for 'a
summary,' don't distract them with uncertainty mechanics. But if the agent is about to: send an email,
change production config, delete data ... you must surface confidence clearly. A simple rule:
**The higher the blast radius, the more visible the uncertainty UI.**"* (1nick1patel1, above)

**[INFERENCE]** This resolves where uncertainty belongs in our UI: **not on the row** (browsing, zero
blast radius) but **in the correction confirmation** (mutating a user file, real blast radius). The
row says "offset +8.3s · correctable"; the moment the user clicks fix, we show what we matched and how
confident we are, because that's the decision point.

**[FACT] Three-level ordinal labels, defined once and kept stable.** *"Instead of numeric confidence,
use three levels that users can actually understand: Confident — 'I have strong evidence.' Likely —
'best guess based on partial evidence.' Uncertain — 'I need more info, or this is high risk.'"* plus
*"Confidence labels only work if users learn what they mean. Add a tiny 'What does this mean?'
explainer that's consistent across the product ... **Keep it stable. Don't change definitions every
sprint.**"* (1nick1patel1)

**[FACT] ⚠️ The caveat — the literature's dominant warning is the *opposite* of the PO's stated fear.**
The named failure mode across every source is **hidden** uncertainty, not displayed uncertainty:
- *"The biggest UX mistake in AI products is presenting uncertain outputs with the same visual
  confidence as certain ones. When AI is wrong and users trusted the output without question, they
  lose trust permanently."* (institutepm)
- *"Silent high confidence: The model produces a result with 65% confidence but the interface shows no
  signal; the user acts assuming the certainty were 100%."* — listed as failure mode #1, and:
  *"The highest-risk UX failure is a confident-looking AI that is wrong without warning, giving users
  no recourse."* (reloadux)
- *"Trust in AI is not built by hiding uncertainty; it is built by making uncertainty legible and
  actionable."* (reloadux)
- NN/G's Page Laubheimer, quoted: *"Establishing trust with users requires acknowledging AI's limits
  and fallibility."*
  (https://altersquare.medium.com/designing-interfaces-around-uncertain-ai-outputs-c9478dc08e72)
- Nielsen (UX Tigers), on the mechanism: *"AI systems are probabilistic. Hiding this uncertainty is
  dishonest and erodes trust."* (https://www.uxtigers.com/post/think-time-ux)
- Automation bias is the named harm: *"automation bias causes users to follow AI recommendations even
  when the AI is wrong, especially when the interface shows no visible signal of doubt."* (reloadux,
  citing Nielsen/UX Tigers 2025)

**[INFERENCE] My honest read, stated plainly because the PO principle is load-bearing.** "Users want
certainty, not '80% likely correct'" is **right about the format and wrong as an absolute.** The
defensible version of the principle is:

> Never show a raw number. Always show a diagnosis, its evidence, and the next action. Where we are
> genuinely unsure, say so in words tied to a cause ("no reference track available — can't check
> this one") rather than either (a) a number or (b) silence that implies verification happened.

The failure the literature warns about maps onto a concrete risk for us: if we badge a row "aligned"
based on a weak reference and we're wrong, the user trusts a broken subtitle and loses faith in the
whole feature. Suppressing "aligned" to *silence* (per Q2's log layer) neatly sidesteps this — silence
claims nothing, whereas a green "aligned 0.94" badge makes a promise we can't keep. **So the
"say nothing when good" rule is well-founded, but its justification is honesty, not anxiety-avoidance.**

**[INFERENCE] Where uncertainty must be visible regardless:** the ~36% with no embedded reference.
These are neither aligned nor broken — they're *unchecked*. Both the alert-fatigue evidence (don't
badge 144 rows) and the honesty evidence (don't imply we verified) point the same way: **no per-row
badge, but an honest aggregate** — "147 items couldn't be checked (no reference track)" with a link
to a filtered view and the opt-in audio-decode escalation. That is the "missing fallback state"
failure mode averted: *"When confidence drops below a useful threshold, the interface shows nothing or
fails silently instead of triggering a human-review prompt."* (reloadux)

**[FACT] Language framing matters measurably.** *"'AI is unsure' reads as a failure. 'Limited data
available for this recommendation' reads as useful context. The second framing keeps the user in
control without undermining the system's credibility."* (reloadux)
**[INFERENCE]** So: not "couldn't verify (low confidence)" but "no reference track in this file — add
one or check against audio".

---

## Q3 mutation safety

### Confirm vs. undo — the guidance is unambiguous and it favors undo

**[FACT] NN/G's rule, from their confirmation-dialog article**
(https://www.nngroup.com/articles/confirmation-dialog/): *"Use a confirmation dialog before committing
to actions with serious consequences — such as destroying users' work or costing large amounts of
money. In particular, consider a confirmation dialog before actions that cannot be undone. (Though as
mentioned, **do try your best to offer undo — a key component of another usability heuristic, user
control and freedom — in order to reduce anxiety and allow users to recover from major problems**.)"*
They also name the core tension explicitly: *"There is admittedly a tension between guidelines #1 and
#2: you want to warn against serious consequences, but you don't want to warn so often that the
warning is overlooked and the answer becomes an automated behavior."* And on the heaviest pattern
(type-to-confirm, as MailChimp does for deleting a list): *"Such a heavy-handed confirmation dialog
should be reserved for the most serious cases. **(An even better design would provide the user with
the opportunity to undo this destructive action.)**"*

**[FACT] All three major design systems converge, per a survey of their guidance**
(https://grokipedia.com/page/confirmation_dialog): NN/G — *"reserved for high-stakes actions with
serious, irreversible consequences ... applying them selectively ... as overuse leads to habitual
dismissal and reduced attentiveness."* Material Design — *"using confirmation dialogs only for urgent
decisions that block app functionality, opting for less intrusive elements like snackbars for routine
notifications."* Apple HIG — *"advising alerts for uncommon destructive actions while **avoiding them
for undoable or frequent tasks** to minimize user frustration."*

**[FACT] The friction ladder.** *"the amount of friction should be proportional to how much damage the
action can do and how hard it is to reverse ... Design the friction as a ladder — no confirmation,
simple confirmation, explicit-consequence confirmation, type-to-confirm — and place each action on the
rung its real risk earns."* Plus the anti-pattern: *"When every destructive action wears the same
generic confirmation, users cannot tell the reversible from the catastrophic, and they either
over-worry about trivial actions or under-worry about fatal ones."*
(https://www.saasui.design/blog/saas-destructive-actions-confirmation-ux-patterns)

**[FACT] Same source, the direct answer to our question:** *"A confirmation dialog interrupts the user
before the action to ask permission; an undo lets the action happen instantly and offers a short
window to reverse it. **For anything genuinely reversible, undo is almost always the better
experience** ... Reserve blocking confirmation for actions you genuinely cannot offer an undo for."*
And the belt-and-braces recommendation: *"For higher-stakes reversible actions, back the transient
toast with a durable path to recovery: a trash or archive that holds deleted items for a period so a
user who missed the toast can still restore from a dedicated view. **The combination — instant action,
a generous undo toast, and a trash as the long-tail fallback** — covers both the immediate slip and
the regret that surfaces ten minutes later."*

**[INFERENCE] Verdict for "correct timing": no confirmation dialog, undo instead — conditional on us
making it genuinely reversible.** A timing shift is *perfectly* reversible: it's a pure arithmetic
operation on timestamps, and we know the delta we applied. Per every source above, gating a reversible
action behind a modal is the wrong call and trains dismissal habits. The engineering obligation is to
earn that by making revert real (backup + DB record), not to substitute a dialog for durability.

**[INFERENCE] Where a confirmation *is* warranted** — per the friction ladder, tied to Q2's
`FixDisposition`:
- safe fix (embedded reference, constant offset, high cue-match count) → **no dialog, undo toast**
- unsafe fix (audio-derived, drift/rescale, low match count) → **explicit-consequence confirmation**
  showing the evidence card, because here the *diagnosis itself* may be wrong — a different class of
  risk than a mis-click
- **bulk** "fix all 13 episodes" → explicit-consequence confirmation naming the count and scope, per
  NN/G's specificity guidance (their MailChimp example's power comes from *"the name of the list and
  (probably more important) the number of subscribers"*)
- never type-to-confirm. Nothing here earns that rung.

**[FACT] Undo windows must be generous and durably backed.** *"An undo is only as good as its window
and its visibility ... a toast that vanishes in a second is no safety net."* (saasui)
**[INFERENCE]** In our case the user may not even discover the mistake until they next *watch* the
episode — hours or days later. A toast is therefore necessary but wholly insufficient; the durable
revert path is the real safety mechanism. This is a stronger argument for backups than in the typical
SaaS delete case, because **our feedback loop is uniquely long**.

**[FACT] Physical layout matters — don't put the fix next to anything destructive.** NN/G:
*"Confirmatory and destructive actions should be far apart from each other; use additional redundant
visual signals to differentiate between them"*, calling proximity of consequential and benign options
*"one of the top 10 application design mistakes that we've seen year after year. It occurs all the
time — **in tables**, dropdown menus, confirmation dialogs, error messages, and wizards."* Their
positive example is Grammarly, which *"uses color, icons, text size, and alignment to differentiate
the confirmatory action (the spelling suggestion) and the potentially destructive action (Add to
dictionary)."* They also endorse deliberately exploiting Fitts's Law: *"It's okay to leverage Fitts'
Law and make it a little harder to select the consequential option."*
(https://www.nngroup.com/articles/proximity-consequential-options/)
**[INFERENCE]** Directly relevant: we are putting a mutating action **in a table row** with 400
siblings, likely near "delete subtitle" / "re-download". Keep "Correct timing" visually and spatially
distinct from any delete affordance; do not place both in the same undifferentiated `⋯` menu at the
same size.

**[FACT] Spellcheck is the cited cautionary tale, and it's our closest UI analogue.** NN/G's article
opens with Firefox's spellcheck placing the spelling suggestion immediately adjacent to *"add the
misspelled option to the dictionary"* — one click apart, one benign and one polluting persistent
state. **[INFERENCE]** Our "ignore this / accept as-is" (from Q2's suppression finding) is exactly
Firefox's "add to dictionary": it writes durable state from a row-level menu. It must be
differentiated from "correct timing", and it should itself be reversible.

**[FACT] Confirmation copy must state the object, the magnitude, and the recoverability.** *"'Are you
sure?' protects nothing because it carries no information — the user already clicked, and a vague
prompt just asks them to click again."* The prescribed shape names object + quantity + reversibility +
ripple effects, e.g. *"Delete project Q3 Roadmap? This permanently deletes 248 tasks and removes
access for 3 members. This cannot be undone."* (saasui) Corroborated by NN/G's guidance to *"restate
the user's request"* and by UX Psychology: *"Yes/No or vague options should be avoided and the choice
should be reinforced in the button text (e.g., Delete account)"*
(https://uxpsychology.substack.com/p/how-to-design-better-destructive).
**[INFERENCE]** Our bulk-confirm copy: *"Shift 13 subtitles in Season 3 by −8.3s? Original files are
backed up and this can be undone."* — and the button reads **"Shift 13 subtitles"**, not "OK".

**[FACT] Never auto-focus the destructive action; keep the safe path the default.** *"the safe choice
should be the easy default ... the destructive button should never be the auto-focused,
Enter-to-confirm default for a high-stakes action, or you have built a trap that a stray keypress
springs"* (saasui). Apple HIG is noted as *"consider making cancel default in destructive cases"*
(https://ux.stackexchange.com/questions/132530/affirmative-action-button-on-right-dismissive-on-left-unless-affirmative).

**[FACT] Offer a way to stop asking.** NN/G: *"Consider a customization option that allows the user to
bypass future routine confirmations. (See the Do not ask me again about converting documents checkbox
from Microsoft Word ...)"* — and they endorse temporary educational confirmations for new features
*"even though these effects are not serious. Such confirmations ought to be temporary, and you should
offer users a way to avoid them."*
**[INFERENCE]** Good fit for a self-hosted power-user tool: a "don't ask again for safe corrections"
checkbox, and an admin setting to auto-correct safe offsets unattended once the user trusts it.

### What subtitle tools actually do about backups — and the complaints

**[FACT] The canonical complaint: the tool modified files the user believed were off-limits.**
https://github.com/morpheus65535/bazarr/issues/1715 — *"Bazarr downloads and overwrites
existing/manually downloaded subtitles regardless of setting."* The reporter's mental model is stated
explicitly and is worth quoting because it's the model our users will have too: *"Keep the checkbox
for 'Upgrade Manually Downloaded or Translated Subtitles' **unchecked**, which in my mind should mean
'Leave existing subtitle files for which there is no download record, alone'"* and *"Subtitles
imported into Radarr/Sonarr as part of the release imported, should be treated as 'manually
downloaded' and be left alone by Bazarr. This does not happen."* 21 comments. Their workaround was to
disable the entire upgrade feature.

**[FACT] Second instance of the same class of complaint, with the "my subs were better" angle.**
https://www.reddit.com/r/bazarr/comments/t2sejs/subtitle_overwrite_when_movie_extension_change/ —
a user transcodes mp4→mkv and Bazarr re-downloads and overwrites: *"I find it irritating because most
of my subtitles come from the source and are **perfectly synced and without ads**, and I certainly
don't want to risk getting a new one that might not fit."* Note the bystander comment revealing the
expected contract: *"I thought bazarr left original files alone? I thought it only kept track of files
it downloaded or you added through the bazarr UI... am I wrong?"* Maintainer morpheus65535 explains
the mechanism (Sonarr/Radarr create a new file id on extension change and delete leftovers, so Bazarr
treats it as new) — i.e. **the identity of "the file" changed, and provenance tracking was keyed to
something unstable.**

**[INFERENCE] Two hard requirements fall out of this:**
1. **Provenance is the load-bearing concept, and our users' default assumption is "don't touch what
   you didn't create."** We must record, per subtitle, whether subtitle-scout installed it or found it
   pre-existing, and default to **not mutating pre-existing files** without explicit per-item consent.
   This is *more* conservative than Bazarr and directly addresses its top complaint.
2. **Don't key provenance to the video path or extension.** Bazarr's bug is precisely that. Key it to
   the subtitle file's own content hash plus a stable media id.

**[FACT] The community's stock advice for batch subtitle fixes is "back up first" — i.e. the tools
don't do it for you.** On running Subtitle Edit's fix tools across a library: *"Subtitle Edit will let
you do batches of all those fixes and save the file in place. **However, it would be a good idea to
backup your subs first.**"*
(https://www.reddit.com/r/bazarr/comments/16l39zv/running_fix_tools_against_all_sub_files/)

**[FACT] Subtitle Edit's safety model is autosave snapshots + an explicit Revert**, i.e. multiple
layers (https://subtitleedit.net/recovering-lost-subtitle-edits-in-subtitle-edit/):
- timestamped snapshot history — *"A list of previous save states will appear, allowing you to choose
  to download or 'Restore' a version from an hour ago or even the previous day. **This is the ultimate
  recovery method for when you accidentally save over a good file with bad data**"*
- `File > Revert` — *"instantly reloads the last manually saved version of the file from your hard
  drive, discarding all changes made during the current, corrupted session. This is often faster and
  cleaner than repeatedly using the Undo function to reverse automated changes"*
- an explicit acknowledgement that **the in-memory undo stack is bounded and insufficient**: *"If you
  exceed this during a long session, you cannot undo back to the very beginning. In this case, your
  only recovery option is to use an Auto-save file from an earlier point"*
- a known failure mode we must design against: *"If Subtitle Edit freezes during export or save, it
  often creates a **0KB file** at the destination."*

**[INFERENCE] Three things to steal:** (a) durable timestamped snapshots beat an undo stack, and are
specifically the answer to "saved over a good file with bad data" — our exact risk; (b) "Revert"
(restore from disk) is a distinct, more useful operation than "Undo" (pop a stack) for
*automated* changes — we want Revert semantics; (c) the 0KB-file failure means we must
**write-temp-then-atomic-rename**, never truncate-and-write in place. Atomic rename also appeared in
the idempotency research as the recommended primitive for file ops.

**[FACT] Web subtitle editors converge on server-side version history.** Amara: *"each time you click
the Save button you save a new version on the server"*, plus crash-recovery prompts and *"Revert to
last saved version"*
(https://support.amara.org/support/solutions/articles/192434-save-your-subtitles). OpenSubtitles
gates replacement by provenance: replacing a subtitle *"can only be done by admins or the original
uploader of the subtitle to prevent misuse or abuse of other peoples work"*
(https://forum.opensubtitles.org/viewtopic.php?t=2773) — **[INFERENCE]** another instance of
provenance governing mutation rights.

**[FACT] Backup-before-overwrite is already the expected behaviour in the adjacent tool.** subsyncarr
offers `Save location` = *"Overwrite existing subtitle"* or *"Save next to video with the same
filename"*, and *"It will also backup your existing subtitles before overwriting them"*
(reddit link in Q1). **[INFERENCE]** So the bar has been set by a hobby tool: backups are table
stakes, and a sibling-file option is expected alongside overwrite.

### Idempotency — preventing double-shift

This is the sharpest technical risk in the feature: apply +8.3s twice and you've made things worse
than when you started, and the second application will *look* successful.

**[FACT] The two canonical mechanisms.** From
https://www.zero-downtime-schema.com/database-migration-fundamentals-tool-selection/idempotent-script-design/:
*"Idempotency is a property of the effect, not the syntax: running the script once and running it N
times must leave the database in the same final state. Two mechanisms achieve it. The first is the
**conditional guard** — DDL that checks for the object before creating it, so a second run sees the
column already present and does nothing. The second is the **version ledger** — a tracking table that
records which migrations have applied, so a runner can skip a completed step entirely and so a retry
cannot double-record."*

**[FACT] Guards must test the exact post-condition, not a proxy.** *"Use specific, reliable checks —
**test for the exact condition your action would create**, not a proxy condition."*
(https://www.commandinline.com/shell-script-idempotency-safe-rerun-patterns/) That source also gives
the file-specific primitives: *"For file operations: atomic rename or write-once paths"* and
*"compare a checksum or diff before overwriting."*

**[FACT] The data-migration analogue is exactly our problem, and the guard is a
"has this already been transformed?" predicate.** *"A naive approach would copy data without checking
if it's already been copied. **Running that twice creates duplicate data or overwrites valid
values.**"* The recommended shape uses a `WHERE` clause that only matches untransformed rows:
*"The WHERE clause ensures the update only runs on rows that haven't been processed yet. If the script
runs again, those rows are already populated and the update does nothing ... For more complex
scenarios, you might need to compare source and target data, or **use a checksum to verify that the
transformation produced the correct result. The principle stays the same: never assume the data is in
its original state.**"*
(https://cicd.ariefw.com/articles/22-2-writing-database-migrations-that-wont-break-when-run-twice/)

**[FACT] When the operation is inherently non-idempotent, write an idempotence marker into the
artifact itself.** Sanity's content-migration docs address the case of an insert that *"inserts a new
member into the array every time it's run, giving different results every time"* — structurally
identical to a repeated time-shift. Their prescription
(https://www.sanity.io/docs/content-lake/important-considerations-for-schema-and-content-migrations):
```js
const idempotenceKey = 'xyz' // should be unique for the migration but never change
// ...
if ((document?._migrations||[]).includes(idempotenceKey)) {
  // Document already migrated, so we can skip
  return
}
return [
  at('members', insert({name: 'Some One'})),
  at('_migrations', setIfMissing([])),
  at('_migrations', insert(idempotenceKey)),
]
```
Two properties worth noting: the marker is **written in the same operation as the change**, and the
key *"should be unique for the migration but **never change**."* Their course adds the complementary
half: *"two approaches: **filtering** only the documents that should be migrated. Adding an
**idempotence key** to skip documents that have already been migrated once"*
(https://www.sanity.io/learn/course/handling-schema-changes-confidently/making-the-content-migration-more-idempotent).

**[FACT] Practitioner consensus: enforce at the task level, persist intent before the side effect.**
From r/devops (https://www.reddit.com/r/devops/comments/1r4u7zr/duplicate_writes_in_multistep_automation_where_do/):
*"I enforce idempotency at the task level, not the orchestrator. Each automation step should be safe
to run multiple times ... For things like 'send notification on deploy', I'll write a state marker
(file, DB record, whatever) that the task checks first. If the marker exists, skip ... **The key
question: what happens if this exact task runs twice in a row? If the answer isn't 'nothing breaks',
add a guard.**"* And on the ledger write itself: *"What helped us was making the ledger write a
**conditional insert on the op_id** so concurrent re-runs don't both execute the side effect"*, plus
*"we persist **intent before the side effect** and record **outcome after**, keyed by stable
run_id + step_id."*

**[INFERENCE] Recommended design — belt, braces, and a third check.** All three sources agree that a
single mechanism is insufficient when the operation is non-idempotent by nature. For us:

1. **Ledger (authoritative).** A `corrections` table: `subtitle_id`, `applied_at`, `delta_ms`,
   `hash_before`, `hash_after`, `backup_path`, `method` (`embedded` | `audio`), `disposition`
   (`safe` | `unsafe`), `reverted_at`. Unique constraint / conditional insert on a stable op id so
   concurrent claims can't both apply. Persist intent (`pending`) before touching the file, outcome
   after — this is what makes a crash mid-write recoverable.
2. **Content guard (defence against out-of-band change).** Before applying, verify the file's current
   hash equals `hash_after` of the last correction (or `hash_before` if never corrected). If it
   matches neither, the file changed underneath us — **refuse and re-verify** rather than shifting
   blind. This is the "never assume the data is in its original state" rule, and it also covers the
   case where the user edited the file in Subtitle Edit meanwhile.
3. **In-file marker (defence against DB loss / portability).** An SRT comment-ish header or, better, a
   sidecar `.subtitle-scout.json` recording the applied delta and a stable key. Rationale: our SQLite
   DB and the user's media library have **different lifetimes** — users rebuild containers, restore
   from snapshots, or move libraries between installs. A DB-only ledger silently loses the fact that a
   shift was already applied, which is exactly the double-shift scenario.
   **[ASSUMPTION]** needs a check: whether an in-band comment survives round-tripping through the
   media players and remuxers our users run. If not, sidecar-only.

**[INFERENCE] Why the true post-condition guard is best of all:** the strongest possible check is not
"did I already apply?" but **"is it aligned now?"** — i.e. re-run verification. If the subtitle now
measures aligned, a shift is a no-op regardless of history. That is the "test for the exact condition
your action would create" rule applied literally, and it's cheap for us on the 63.7% with an embedded
reference. **Verify-then-correct, in one job, atomically** removes the double-shift class of bug
almost entirely — and it also closes the TOCTOU window between a stale verification result displayed
in the UI and the click that acts on it.

---

## Q4 per-row async in React

### The per-row subscription pattern — near-exact prior art found

**[FACT] A write-up that matches our problem almost exactly**, including performance traces:
https://philparsons.co.uk/blog/isolating-react-component-updates-with-usesyncexternalstore/ — a
**100-item list** where individual rows update independently. It first builds the "correct" React
solution (parent holds a `Map` of state, `useCallback` for the handler, `memo` on the row) and then
shows why that's still not enough:

> *"This approach ticks the React performance checkboxes with `memo` on the `ShoppingItem` component
> to skip rendering if the item props don't change and `useCallback` to cache the toggle function, so
> where does it fall short? When you toggle an item, the state in the parent shopping list changes.
> **React reconciles the subtree checking every `ShoppingItem` component for prop changes.** The DOM
> barely changes, but the item mapping and done state lookup happens for every item in the list. In
> this example, the time cost remains negligible, but in a production app with more complex components
> and expensive renders this compounds into significant performance issues."*

The fix is a store with **per-id subscriber sets**, and rows that receive only an `id`:

```js
class Store {
  #items = new Map();
  #doneState = new Map();
  #subscribers = new Map();          // Map<id, Set<callback>>

  getItem(id) { /* merge item data + derived state */ }

  toggleItem(id) {
    this.#doneState.set(id, !this.#doneState.get(id));
    this.#notify(id);                // notify ONLY this id's subscribers
  }

  subscribe(id, cb) {
    this.#subscribers.set(id, (this.#subscribers.get(id) ?? new Set()).add(cb));
    return () => this.#subscribers.get(id)?.delete(cb);
  }

  #notify(id) { this.#subscribers.get(id)?.forEach((cb) => cb()); }
}

function ShoppingItem({ id }) {                  // <- only an id as prop
  const store = use(Context);
  const item = useSyncExternalStore(
    (cb) => store.subscribe(id, cb),
    () => store.getItem(id),
  );
  // ...
}
```
Reported result: *"When you toggle an item, only that specific `ShoppingItem` component re-renders
because only that component subscribes to updates for that item. The rest of the list remains
unaffected"* — with a trace caption confirming *"only one component reconciles."* The author is honest
about the tradeoff: *"This approach requires more code than the parent state version, but the
separation of concerns improves."*

**[INFERENCE]** This is the pattern for us, and it maps cleanly onto our SSE stream: one SSE
connection → one store → `store.applyVerificationResult(subtitleId, result)` → `#notify(subtitleId)` →
exactly one row re-renders. 400 rows, one row's worth of work per event. Crucially the row props stay
`{ id }`, so the list itself never re-renders as results stream in.

**[FACT] The known correctness trap: `getItem(id)` above returns a fresh object each call.** React
compares snapshots with `Object.is`: *"If `getSnapshot` returns a new object or array reference on
every invocation—even if the data inside is identical—React will trigger a re-render"*, and the fix is
*"perform the mutation inside your external store and cache the result, ensuring `getSnapshot` only
returns the pre-calculated, stable reference"*
(https://salivity.github.io/react/article/how-to-optimize-usesyncexternalstore-in-react). React's own
shim warns about this at dev time: *"The result of getSnapshot should be cached to avoid an infinite
loop"* (https://junghyeonsu.com/en/posts/react-use-sync-external-store/).

**[INFERENCE] So the merge in `getItem` must be precomputed, not done per call.** Our store should
hold one frozen, immutable `VerificationState` object per subtitle id and replace it wholesale when an
SSE event arrives. `getSnapshot` becomes `() => this.#state.get(id)` — a stable reference between
events. This is a small but genuinely load-bearing detail; getting it wrong yields an infinite render
loop rather than a subtle slowdown.

**[FACT] `subscribe` identity matters and ours necessarily depends on a prop.** react.dev: *"React
will resubscribe to your store if you pass a different subscribe function between re-renders. If this
causes performance issues and you'd like to avoid resubscribing, move the subscribe function
outside"*, and for the parameterised case: *"wrap `subscribe` into `useCallback` to only resubscribe
when some argument changes"* with the example `useCallback(..., [userId])`
(https://react.dev/reference/react/useSyncExternalStore).
**[INFERENCE]** Since our `subscribe` closes over `id`, it must be `useCallback(cb =>
store.subscribe(id, cb), [store, id])`. With stable `id`s this subscribes once per row for the
lifetime of the row.

**[FACT] There's a built-in selector variant that handles the memoization for you.** From the React 18
working group: *"As a convenience, we will provide a version of the API with automatic support for
memoizing the result of `getSnapshot`"* —
`useSyncExternalStoreWithSelector(subscribe, getSnapshot, getServerSnapshot, selector, isEqual)` — and
the rationale that inline non-memoized selectors otherwise force resubscription: *"If the selector
function is not memoized, this means resubscribing on every new render. This is not only a performance
pitfall, it's one that leaks into user code"* (https://github.com/reactwg/react-18/discussions/86).
**[INFERENCE]** Worth using (`use-sync-external-store/shim/with-selector`) if we want rows to subscribe
to *sub-slices* — e.g. a row's badge re-rendering only when `status` changes but not when `lastCheckedAt`
does. Probably over-engineering for v1; note it as the escape hatch.

**[FACT] Tearing is the reason this hook exists, not just performance.** *"It guarantees that all
components in a render pass see the same, consistent snapshot of the data, even during concurrent
updates, thus preventing tearing"*
(https://www.epicreact.dev/use-sync-external-store-demystified-for-practical-react-development-w5ac0).
**[INFERENCE]** Relevant for us because React 19 + a high-frequency SSE stream is exactly the
concurrent-rendering scenario where a naive `useEffect`+`useState` fan-out can display two rows
computed from different store versions. Using the hook is the correct call, not a micro-optimization.

**[FACT] The documented footgun list** (from
https://dev.to/mehta0007/usesyncexternalstore-the-react-hook-you-didnt-know-you-needed-34mp and the
Medium version): `subscribe` defined inline → infinite resubscription; new objects from `getSnapshot`
→ infinite re-renders; missing cleanup return → *"Memory leak — listeners pile up indefinitely"*;
computing derived state in `getSnapshot` → stale-closure bugs. Also *"`getSnapshot` must be pure and
stable. React calls it frequently. Keep it fast."*
**[INFERENCE]** The memory-leak one matters if we ever virtualize the list — rows unmount and remount
during scroll, so `subscribe` must reliably return its unsubscriber and the store must prune empty
`Set`s from the subscriber `Map`, or a long scrolling session leaks entries for 400 ids.

### Batching — the gap in our stack

**[FACT] The React team's own shim documents that batching is the caller's responsibility.** In the
shim source: *"Because there is no cross-renderer API for batching updates, it's up to the consumer of
this library to wrap their subscription event with `unstable_batchedUpdates`."*
(https://junghyeonsu.com/en/posts/react-use-sync-external-store/)

**[INFERENCE]** This is the one real risk in the per-row design, and it bites precisely in our
scenario. During a library-wide backfill, results arrive in a burst. If each SSE message triggers
`#notify(id)` synchronously, we get one render pass per message. In React 18+ automatic batching
covers updates within the same event-loop task, but SSE messages arrive in **separate** macrotasks, so
each is its own pass. Mitigation: **coalesce in the store, not in React** — buffer incoming events and
flush on a `requestAnimationFrame` or a short (~50–100ms) timer, notifying each affected id once per
flush. This also naturally rate-limits the UI during the burst, which is exactly the "hundreds of rows
each with independent async status" case the question asks about. Cheap to implement, and it keeps the
router's weak CPU from being the bottleneck on the client side too.

### What mature dashboards actually do — stream *and* reconcile

**[FACT] TanStack Query's documented defaults do reconciliation for you.** Stale queries refetch
automatically on: new mount, window refocus, network reconnect, and optional interval. The docs frame
`staleTime` as the primary lever — *"Setting staleTime is the recommended way to avoid excessive
refetches, but you can also customize the points in time for refetches by setting options like
`refetchOnMount`, `refetchOnWindowFocus` and `refetchOnReconnect`"* — and note that
`refetchInterval` *"is independent of the staleTime setting"*
(https://tanstack.com/query/v5/docs/framework/react/guides/important-defaults).

**[FACT] The conditional-polling idiom is explicitly the recommended pattern for job status.**
```js
// BAD: Always polling
refetchInterval: 5000
// GOOD: Conditional polling
refetchInterval: (data) => data?.status === 'processing' ? 5000 : false
```
plus the dashboard shape `staleTime: 5min, refetchInterval: 30s, refetchOnWindowFocus: true`
(https://dev.to/munna_thakur_2019444f0351/mastering-usequery-the-complete-dev-guide-tanstack-react-query-4726).

**[INFERENCE] The answer to "poll, stream, or reconcile on focus" is: all three, with different
jobs.** This is the layering mature dashboards converge on, and it's the honest answer to the
research question:

| Mechanism | Job | Why |
|---|---|---|
| **SSE** (have it) | live per-row patches while the tab is open and work is in flight | lowest latency, no polling cost on a weak CPU |
| **Reconcile on focus/reconnect** | repair missed events | SSE **will** drop — container restart, sleep/wake, proxy timeout. Anything that happened while disconnected is invisible otherwise |
| **Summary endpoint** | the aggregate counts ("312/400 verified, 88 pending") | one cheap query beats deriving totals from 400 client-side rows, and it's what the Q2 coverage requirement needs |
| **Conditional polling** | fallback only when SSE is unavailable/failed, `false` when idle | never poll when nothing is running |

**[INFERENCE] The reconcile-on-focus path is the one most likely to be skipped and most likely to
cause bug reports.** Because our jobs are long (a backfill runs for an hour-plus) and the user closes
the laptop, the common case is: user returns, SSE reconnects, and the UI shows an hour-old snapshot
with rows stuck on "verifying". The fix is a cheap versioned delta endpoint — the SSE stream carries a
monotonic event id, the client records the last id it saw, and on reconnect it asks for everything
since. **[FACT] This is what SSE's own `Last-Event-ID` mechanism is designed for** — worth using the
protocol feature rather than inventing a parallel one. **[ASSUMPTION]** I did not verify whether the
existing subtitle-scout SSE endpoint already emits `id:` fields; if not, that's the smallest change
that makes reconnection correct.

**[INFERENCE] Row status must include a "stale/unknown" state, not just pending/done.** If we can't
distinguish "still verifying" from "we lost the connection and don't know", rows hang forever. The
store should mark in-flight rows as indeterminate on SSE disconnect and let the reconcile pass resolve
them — which is also the Q2 "missing fallback state" failure mode, in the transport layer.

---

## Recommended design decisions

Each decision is opinionated and tied to the evidence above. `D#` for reference.

### Compute timing

**D1. Hybrid, tiered by reference type. Eager-on-import for the embedded-track path; opt-in scheduled
backfill; audio decode never runs unattended.**
Evidence: all four surveyed tools converged on eager-on-arrival + off-hours backfill (Q1 synthesis).
Bazarr specifically refused a library-wide audio sync because *"it would probably overload your server
for a couple of days"*. Our embedded path is cheap enough to do what Bazarr couldn't; our audio path is
not.

**D2. Global concurrency 1 for verification, enforced at claim time, with a cost weight in the `jobs`
table.**
Evidence: Immich discussions #3625 — per-job-type limits are insufficient because job types saturate
the box *jointly*; issue #17830 shows two concurrency-1 jobs pegging a CPU. Users on a Celeron NAS and
a Pi 4 both ended up at effectively-serial config. Our hardware is weaker than both.

**D3. Check the enable flag at claim time, not just at enqueue time.**
Evidence: jellyfin#14558 and #11730 — expensive tasks burning CPU for hours on hardware whose owner
had disabled the feature. This is the fastest way to lose a user's trust on a router.

**D4. Never block library scan/import on verification; rows appear unverified and fill in.**
Evidence: Jellyfin's `scanBehavior` defaults to `NonBlocking` precisely so media lands before derived
data.

**D5. Ship a pause/resume control, and auto-pause the verification queue during user-initiated
foreground work.**
Evidence: `immich-go --pause-immich-jobs=true` exists because users needed it; Immich's docs frame
concurrency as *"improves throughput, not latency"* — interactive latency needs its own mechanism.

**D6. Settings to ship** (mirroring the convergent list in Q1): master enable; verify-on-import
toggle; backfill schedule incl. "Manually" = never; reference tier (`embedded only` / `allow audio
decode`) defaulting to embedded-only; concurrency cap default 1; process priority default below-normal;
pause/resume. **[INFERENCE]** Skip a "quality" dial — unlike JPEG quality, alignment scoring has no
useful cheap/expensive tradeoff beyond the reference-tier choice.

**D7. Cloud-mounted files: detect and exclude from audio decode entirely, don't just deprioritize.**
Evidence: Bazarr's own docs warn the audio-extract path causes *"massive network and CPU usage"*. A
14s local decode is unbounded over a network mount. **[INFERENCE]** Treat "no local file" the same as
"no reference": honest unchecked state, not a slow attempt.

### Score presentation

**D8. Three visible states, and "aligned" is silent.**
`aligned` → **no badge** (log layer, ~65% of volume per the three-layer framework); `offset ·
correctable` → quiet badge with the fix attached (ticket layer); `can't fix / can't check` → distinct
non-alarming marker. Nothing is ever "page" severity — there is no subtitle emergency.
Evidence: squareops three-layer volume targets; NN/G *"guide users' attention to critical values"*;
the actionability test (*"If the answer isn't clear, delete the alert"*).

**D9. Severity is keyed to fixability, not to offset magnitude.**
A large correctable offset is *less* alarming than a small uncorrectable drift.
Evidence: hudochenkov — *"Use 'error' when fixing will change how your code works ... If the linter
rule has an auto-fix — use the 'warning' level."*

**D10. Never show a number as a score. Show a diagnosis + evidence + next action.**
Not "0.94" but *"runs 8.3s late · matched 412/430 cues at a constant shift · no drift"*. Counts and
deltas are units the user can reason about; a normalized score is not.
Evidence: *"Your UI should map uncertainty to a decision, not a number"*; *"Not a percentage; that
number carries no intuitive meaning."*

**D11. ⚠️ Refine the product-owner principle rather than adopting it literally.** Ship:
*never a raw number; always diagnosis + evidence + action; where genuinely unsure, say so in words
tied to a cause.* Do **not** ship "hide all uncertainty" — the literature's #1 named failure is
**silent** false confidence, and automation bias is the documented harm. Note that "say nothing when
aligned" satisfies both principles at once: silence claims nothing, whereas a green "aligned 0.94"
badge makes a promise we can't keep. **This needs an explicit decision from the PO, because it's the
one place my research contradicts the stated principle.**

**D12. Group findings by root cause, not per row.** A season sharing one offset is **one** card
("13 episodes in Season 3 share a +8.3s offset — likely a different release") with one bulk fix.
Evidence: *"one underlying issue firing 40 notifications is a correlation problem not a threshold
problem"*; plus the N=400 scaling warning. This is simultaneously the best UX lever and the fix for
badge overload.

**D13. Hysteresis on the threshold + don't re-verify unchanged files.**
Evidence: flapping is *"the single worst contributor"* to fatigue, with a target of zero.

**D14. Per-item "accept as-is" suppression that survives re-verification, with stable reason-code
identifiers.**
Evidence: universal in linters; RSigma — *"never rename it once shipped"*, because IDs leak into user
data.

**D15. The ~36% with no reference get no per-row badge, but an honest aggregate** — *"147 items
couldn't be checked (no reference track)"* — linking to a filtered view + the audio opt-in.
Evidence: both the alert-fatigue math (don't badge 144 rows) and the "missing fallback state" failure
mode point the same way. Frame as cause, not as failure (*"'AI is unsure' reads as a failure"*).

### Mutation safety

**D16. No confirmation dialog for a safe correction. Undo toast + durable revert.**
Evidence: NN/G *"do try your best to offer undo"*; Apple HIG *"avoiding them for undoable or frequent
tasks"*; Material prefers snackbars; saasui *"For anything genuinely reversible, undo is almost always
the better experience."*

**D17. Friction ladder tied to `FixDisposition`:** safe (embedded ref, constant offset, high match
count) → no dialog + undo; unsafe (audio-derived, drift, low match) → explicit-consequence confirm
showing the evidence card; bulk → confirm naming count and scope; **never** type-to-confirm.
Evidence: the ladder + *"match the friction to the blast radius"*; Biome/Oxlint/RSigma all model safe
vs unsafe fixes as first-class and gate auto-apply on it.

**D18. Backups are mandatory and durable — a toast is not a safety net here.**
Write the original to a backup location, keep a timestamped history, record `backup_path` in the DB,
and expose a "restore original" action in the detail panel indefinitely.
Evidence: our feedback loop is uniquely long (the user discovers the problem when they next *watch*);
Subtitle Edit's snapshot history is *"the ultimate recovery method for when you accidentally save over
a good file with bad data"*; subsyncarr already backs up before overwriting, so this is table stakes.

**D19. Atomic write: temp file + rename. Never truncate in place.**
Evidence: Subtitle Edit's *"often creates a 0KB file at the destination"* on interrupted save; *"For
file operations: atomic rename or write-once paths."*

**D20. Provenance governs mutation rights. Default: do not modify subtitles we didn't install.**
Record installed-by-us vs pre-existing; require explicit per-item consent for the latter. Key
provenance to the subtitle's **content hash + stable media id**, never to the video path or extension.
Evidence: bazarr#1715 (21 comments) and the mp4→mkv overwrite thread — both are provenance failures,
and the second is specifically a path-keyed-identity bug. Users' stated default expectation is
*"bazarr left original files alone."*

**D21. Triple-guarded idempotency:** (1) `corrections` ledger with conditional insert on a stable op
id, intent persisted before the write and outcome after; (2) content-hash guard — refuse and re-verify
if the file doesn't match the expected pre/post hash; (3) sidecar marker recording the applied delta,
because the DB and the media library have different lifetimes.
Evidence: the two canonical mechanisms (conditional guard + version ledger); *"never assume the data is
in its original state"*; Sanity's `_migrations` idempotence key for inherently non-idempotent ops;
*"persist intent before the side effect and record outcome after."*

**D22. Best guard of all: verify-then-correct atomically in one job.** The true post-condition is
"is it aligned now?", not "did I already apply?". This kills the double-shift class and closes the
TOCTOU gap between a stale badge and the click.
Evidence: *"test for the exact condition your action would create, not a proxy condition."*

**D23. Keep "Correct timing" spatially and visually separate from delete/re-download; don't bury both
in one undifferentiated `⋯` menu.**
Evidence: NN/G on proximity — a top-10 recurring mistake that *"occurs all the time — in tables"*;
Grammarly-vs-Firefox spellcheck as the negative/positive pair. Our "accept as-is" is structurally
Firefox's "add to dictionary".

### Per-row async

**D24. One SSE connection → one external store with per-id subscriber sets → rows take only `{ id }`
and use `useSyncExternalStore`.**
Evidence: the philparsons 100-row write-up with traces; `memo`+`useCallback` alone still reconciles
every row.

**D25. Store holds one frozen state object per id; `getSnapshot` returns it by reference.** Never
build the object inside `getSnapshot`.
Evidence: `Object.is` comparison; *"The result of getSnapshot should be cached to avoid an infinite
loop."* Getting this wrong is an infinite loop, not a slowdown.

**D26. Coalesce SSE events in the store and flush on rAF / ~50–100ms timer.**
Evidence: the React shim explicitly disclaims batching — *"it's up to the consumer of this library to
wrap their subscription event with unstable_batchedUpdates"* — and SSE messages arrive in separate
macrotasks, so automatic batching won't save us during a backfill burst.

**D27. Layer the transports: SSE for live patches; `Last-Event-ID` reconcile on
focus/reconnect; a summary endpoint for aggregate counts; conditional polling only as fallback
(`refetchInterval: false` when idle).**
Evidence: TanStack's documented refetch triggers and the conditional-polling idiom for
`status === 'processing'`. The reconcile path is the one most likely to be skipped and most likely to
generate "stuck on verifying" reports.

**D28. Rows need an indeterminate/stale state for "SSE dropped, we don't know".**
Evidence: same "missing fallback state" failure mode as D15, applied to the transport.

---

## Risks & unknowns

**R1. [ASSUMPTION] The 63.7% embedded-track figure assumes the embedded track is a trustworthy
reference.** Nothing in this research validates that. If embedded tracks are themselves frequently
misaligned, D8/D10 produce confident wrong diagnoses — the exact automation-bias failure the Q2
literature warns about. **Needs measurement before shipping badges.** Consider a bootstrap phase where
we compute but don't display, and hand-audit a sample.

**R2. [INFERENCE] Cue-match count may not distinguish "aligned" from "different content".** A subtitle
for the wrong episode entirely could produce a plausible-looking constant offset on a subset of cues.
D10's evidence card partially mitigates (a low match count is visible), but the threshold for
"correctable" needs a match-ratio floor, not just an offset stability test. Unvalidated.

**R3. Drift vs. constant offset is the hard case and I did not research detection quality.** The
Jellyfin-adjacent write-up notes *"A constant offset is easy ... Drift is harder, because no single
offset fixes it. You need to rescale."* Our one-click fix is a shift; if we misclassify drift as offset,
we make things worse. D17 routes drift to "unsafe", but *detecting* drift reliably is an open question.

**R4. [ASSUMPTION] Whether an in-file idempotence marker survives the user's toolchain.** SRT has no
real comment syntax; players/remuxers may strip or choke on injected headers. D21's sidecar is the
safer default but adds a file to the user's library — which some users will object to (cf. Jellyfin's
"save trickplay next to media" being a user-visible choice). **Needs a decision + a compatibility test.**

**R5. [ASSUMPTION] Whether the existing SSE endpoint emits `id:` fields.** D27's reconnect correctness
depends on it. Not verified against the codebase in this research.

**R6. The three-layer volume targets (5/30/65%) are from SRE alerting, not from media tools.** I've
mapped them by analogy. If our real distribution is e.g. 50% offset, the "quiet badge" tier is no
longer quiet and D12's grouping becomes load-bearing rather than a nice-to-have. **Measure the actual
distribution early**; it changes the UI.

**R7. D11 is an unresolved product disagreement, not a finding.** I've documented both sides. If the PO
holds the absolute version of the principle, D15's honest-aggregate for unverifiable items is the part
most likely to be cut — and that's the part the literature most strongly supports keeping.

**R8. [INFERENCE] Backups on a low-power router with constrained storage.** D18 wants durable
timestamped history; the device may not have room, and subtitle files are small but 400+ backups plus
history is not free. Needs a retention policy, and "where do backups live" is a settings question
(cf. Jellyfin exposing artifact location). Not researched.

**R9. Per-row subscriptions + virtualization interact.** D24 is validated at 100 rows unvirtualized. At
400+ rows with virtualization, subscribe/unsubscribe churn during scroll is a leak risk (D24's cleanup
note) and the perf profile is untested. Low risk, but unmeasured.

**R10. No primary Sonarr/Radarr source found for their per-episode expensive-check split.** Q1's *arr
findings lean on Bazarr (which is the closer analogue anyway) plus community sources. If the *arr
"analyze on import" internals matter, that's a gap — worth reading the Sonarr source directly rather
than searching.

**R11. Search-derived evidence quality varies.** Q1/Q3 rest largely on primary sources (GitHub issues,
official docs, project wikis). Q2's alert-fatigue thresholds and Q4's batching guidance lean partly on
practitioner blogs; the NN/G, react.dev, TanStack, Biome, Dart, and Sanity citations are primary. Two
Q1 sources (jellywatch.app) are SEO-flavored blogs — I used them only for user-quote color, and the
underlying claims are corroborated by GitHub issues.
