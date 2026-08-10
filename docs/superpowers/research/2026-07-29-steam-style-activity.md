# Steam-style runtime activity UI for subtitle-scout

Research date: 2026-07-29
Status: COMPLETE

## Progress log

- [x] Q1 Steam download page anatomy — DONE, 2 screenshots inspected pixel-by-pixel + Valve changelog coverage
- [x] Q2 Other media transfer/activity UIs — DONE for Sonarr/Radarr (+complaints), Immich, Netflix; comparison table incl. qBittorrent/Plex/App Store from general knowledge (labelled)
- [x] Q3 Machinery-free copywriting — DONE (Smashing/Bristol/Eleken microcopy rules + NN/G + batch-as-count patterns)
- [x] Q4 Idle state, artwork-forward — DONE (NN/G empty-states article w/ image URLs, uxpatterns.dev 3-variant taxonomy incl. 'completed-state empty state')
- [x] Q5 Indeterminate progress — DONE (NN/G response-time limits, the 'unknown number of remote databases' passage, Adobe spinner guidance, fake-precision)
- [x] Layout anatomy of Steam's download page — DONE (ASCII region diagram + measured proportions)
- [x] Recommended layout for subtitle-scout — DONE (regions, artwork sizes mapped to the repo's real posterUrl/backdropUrl/stillUrl helpers, full Chinese copy strings)
- [x] Vocabulary table — DONE (22 machinery→user-facing mappings)
- [x] Rejected patterns — DONE (11, each with a reason and where possible a source)
- [x] Open questions — DONE (8, incl. one that is measurable from the existing DB)

### Log entries

- `[start]` File created with skeleton.
- `[batch 5]` Read the actual repo (`web/src/api/client.ts`, `web/src/library/PosterThumb.tsx`) to confirm real artwork helpers and TMDB sizes (w400 poster / w1280 backdrop / w300 still) before writing the recommendation. All synthesis sections + executive summary written. RESEARCH COMPLETE.
- `[batch 4]` NN/G 'Designing Empty States in Complex Applications' fetched in full (7 mockup image URLs captured) + uxpatterns.dev empty-states pattern fetched. Q4 written. REMAINING: the 4 synthesis sections (Steam layout anatomy, recommended layout, vocabulary table, rejected patterns, open questions) — all analysis, no further searching strictly required.
- `[batch 3]` NN/G progress-indicator + response-time-limits + long-waits articles; Adobe XD progress essentials; 6 microcopy guides. Q3 and Q5 written. NOTE: Q5 was written out of order (before Q4) because the same search batch covered both.
- `[batch 2]` Sonarr queue screenshot inspected (no artwork, 665-row table, dead Time Left column) + 6 sourced user complaints; Immich jobs page; Netflix downloads screenshot inspected. Q2 written incl. comparison table.
- `[batch 1]` Steam: image search + llm_context on the 2021 redesign. Downloaded and visually inspected `vg247.jpg` (2021 3-section layout) and the 2025 Reddit screenshot (current hero+Up Next layout). Q1 written in full.

## Executive summary

Copy **Steam's downloads page** structure literally: one privileged "now" item occupying ~36% of the viewport with its artwork bleeding full-bleed to the top and left edges, then a `接下来 (n)` section of uniform low-ink rows carrying small capsule artwork, then a `刚刚完成 (n)` section whose rows end in a *useful action* rather than a dismissal — Valve's `▶ Play` becomes our `查看`. The hero:queue artwork size ratio (~5:1) is what encodes "now vs next", which means no badges, no status columns, and no jargon are needed to establish hierarchy. Express all multi-item work as **item counts, never byte-or-fake percentages** (`12 / 47 集`, mirroring Steam's `1 of 2 Items Complete` and Nielsen's `Updating address 3 of 50`), and express the unknowable search phase as Nielsen's own prescription for "searching an unknown number of remote databases" — name the work as it happens (`已试 3 个来源`) plus elapsed time, with a spinner as an explicit last resort. Because Chinese elides the subject, `正在找字幕` describes the work with **no actor at all**, which is the entire solution to "don't expose the agent": the machinery disappears grammatically rather than being hidden. The idle state — which is the most-seen state of this product — is *recent completions rendered with posters in the same geometry as active work*, headed by one honest status line and a **freshness timestamp** (`最近检查 3 分钟前`), because a timestamp is the only cheap element that a crashed system cannot produce, and NN/G documents that a premature or unqualified "nothing here" is the single most trust-destroying empty state you can ship.


## Q1. Steam's download page

### Primary evidence: two screenshots I actually inspected

**(A) Current (2025-era) Steam downloads page** — the most important reference.
`https://preview.redd.it/re-downloading-20-games-is-there-no-way-to-see-total-queue-v0-nn7dkafklz6g1.png?width=992&format=png&auto=webp&s=43c728ec07292efcb7ee53e12a400848e0548961`
(from https://reddit.com/r/Steam/comments/1plejkq/redownloading_20_games_is_there_no_way_to_see)

What is literally on screen (sourced fact — I read the pixels):

- **Hero band, top ~36% of the page.** Left ~40% of the width is the *full-bleed key art of the currently-downloading game* (Clair Obscur: Expedition 33 title treatment). The art is not a small thumbnail in a card — it bleeds to the top and left edges of the content area and fades into the panel.
- The **network throughput sparkline** (green line + blue bar histogram) is drawn *on top of / continuous with* the artwork, occupying the middle of the hero. So the graph and the art share the same band; the art is the graph's background.
- Right side of the hero: a stat trio, small caps label above value:
  `NETWORK 0 B/s` · `PEAK 115.3 MB/s` · `DISK USAGE 338.5 MB/s`, plus a gear icon (settings).
- Below the stats, **two stacked progress bars, each labelled with its own phase and its own unit**:
  - `Downloading complete` — blue, full — `6.3 GB / 6.3 GB` + a small download glyph
  - `Patching files` — green, ~69% — `69%`
- Below that: `Estimated 00:41 remaining` (left) and a large blue **pause** button (right).
- **`Up Next (5)`** — section header, left-aligned, count in parentheses, followed by a thin horizontal rule filling the remaining width, and right-aligned muted status text `Auto-updates enabled`.
- Queue rows, ~100px tall each: landscape **capsule artwork ~168×79** (roughly 2.1:1) at the left; bold white title; muted subtitle line which is *either* the size (`3.8 MB`, `1.3 GB`) *or*, if partially downloaded, `647.7 KB / 63.8 MB DOWNLOADED`; an inline blue `PATCH NOTES` link with a document icon when notes exist. Far right: a per-row download/start button. The first queue row additionally carries `NEXT` + `1% COMPLETE` + a **faded, thin progress bar** — that's the "partially completed shows a faded bar" behaviour Valve documented.

**(B) Older (2021 beta) layout, showing the section taxonomy and the completed state**
`https://assets.vg247.com/current//2021/05/steam_updated_downloads_page_1.jpg`
(from https://www.vg247.com/steam-downloads-page-new-look)

- Top band: `NETWORK` / `DISK` legend + throughput graph, then stat quad `CURRENT 748.5 KB/s` · `PEAK 1.2 MB/s` · `TOTAL 125.5 MB` · `DISK USAGE 1.8 MB/s`, plus `Downloads limited to: 750 KB/s` as an inline actionable link.
- Three sections, each `NAME (count)`:
  - **`QUEUED (1)`** — Dota 2. Capsule art ~160×75. Right side: elapsed/remaining `06:57`, state verb + percent `UPDATING 13%`, a blue bar, and `148.5 MB / 1.1 GB`. A pause button.
  - **`SCHEDULED (1)`** — Destiny 2, size `104.2 MB`, and instead of progress it shows **when it will happen**: `SATURDAY, JUNE 5 2:23 AM`, plus "download now" and "remove" buttons.
  - **`COMPLETED (1)`** — s&box, `60 MB / 60 MB` with the completed total greyed, `COMPLETED: TODAY 9:57 AM`, and — critically — a green **▶ Play** button. The completed row's right-hand affordance is *the next thing the user wants to do*, not a dismissal.
  - `Clear All` button sits on the `COMPLETED` header row, right-aligned.
- Bottom app-wide status bar: `DOWNLOADING` / `1 of 2 Items Complete` with a small aggregate bar — i.e. **batch progress is expressed as an item count, not a byte percentage**.

### Sourced facts from Valve's changelog coverage

From the Sept 2021 client update (out-of-beta) as reported by PC Gamer, Neowin, Windows Central, GamesRadar:

- "When a game/update is actively downloading it will now display the **total progression** completed for the download or update. Previously the progress bar would only display the downloading content progress **but not the disk allocation process**, which would make an update appear completed when it was not." → Valve explicitly fixed a *lying progress bar* by making the bar cover all phases. (https://www.pcgamer.com/steam-now-has-a-better-downloads-page-and-storage-manager/)
- "Any **partially completed** downloads/updates in queue will now show a **faded progress bar** and percent completed next to it to clearly display its current state." → queued-but-partial is a distinct visual state, expressed by *de-saturating* the same bar rather than a different widget.
- "A new **(i) icon** next to the game's title will reveal a tooltip displaying the types of content included in that update. Types consist of Game Content, Downloadable Content, Workshop Content, and Shader Pre-caching. **This icon only appears if the update is not solely game content.**" → progressive disclosure: the technical breakdown is behind a tooltip, and the tooltip *does not exist* when there's nothing unusual to say.
- **Drag-and-drop reordering** of the queue replaced the old "Send to top" button. Users can reorder.
- `Clear All` for completed; `View news` renamed to the plainer **`Patch notes`**.

Sources:
- https://www.pcgamer.com/steam-now-has-a-better-downloads-page-and-storage-manager/
- https://www.neowin.net/news/steams-redesigned-downloads-and-storage-management-pages-launch-out-of-beta/
- https://www.windowscentral.com/steam-overhauls-download-page-and-storage-management-latest-update
- https://www.gamesradar.com/steams-latest-update-improves-download-page-and-storage-management/
- https://www.neowin.net/news/steam-is-getting-a-fancy-new-downloads-page-beta-available-now/

More image URLs (not all individually inspected):
- `https://cdn.neowin.com/news/images/uploaded/2021/07/1627630814_steam_new_downloads_story.jpg`
- `https://i.redd.it/ifrnyiuw7mm71.png` (1887×537 — new download page announcement)
- `https://leveluptalk.com/images/large/blurred/steam_download_queue_management_03_15_2026_5e6f051a-553c-405f-99aa-46bc94fcba8b.webp?width=720&height=720`

### The five transferable lessons from Q1

1. **The current item gets artwork at hero scale, bleeding to the edges.** Everything else gets a small capsule. That size ratio (~full-width backdrop vs 168px capsule) *is* the "now vs next" hierarchy — no badges needed.
2. **Multi-phase work = multiple stacked labelled bars**, each in its own natural unit, not one segmented bar. The phase name is the sentence (`Patching files`), the number is secondary.
3. **Sections are `Name (count)` + rule + right-aligned status text.** The right-aligned slot on the header carries either state (`Auto-updates enabled`) or a bulk action (`Clear All`).
4. **Queue rows have no fake progress.** A queued item shows *size* or *when*, not a 0% bar. Only genuinely-partial items get a bar, and it's faded.
5. **Completed rows end with the next useful action** (▶ Play) and a completion timestamp. Completion is not a dead entry to be swept away; it's a launchpad.

## Q2. Other best-in-class media activity/transfer UIs

### Sonarr / Radarr `Activity → Queue` — closest domain analogue, and a cautionary tale

Inspected: `https://downloads.intercomcdn.com/i/o/641556687/27a890c7ef5d97ac0c3f84fa/activity-queue-sonarr.png` (via https://help.rapidseedbox.com/en/articles/6832517-getting-started-with-sonarr-2025-update)

What's actually on screen (sourced fact — pixels read):
- A **dense data table**. Columns: checkbox, download-status icon, Series, Episode, Episode Title, Quality badge, **Download Client**, Size, Time Left, Progress bar, then two icon buttons (manual import / remove).
- **ZERO artwork.** Not one poster, not one still. 20+ visually identical rows.
- Toolbar above: `Refresh`, `Grab Selected`, `Remove Selected`, `Options`.
- Sidebar shows `Queue` with an orange badge: **`665`**. Footer: `Total records: 665`, pagination `1 / 34`.
- `Time Left` column is `-` for every single row — a column that exists but has nothing to say.
- Progress bars are all ~full and all the same colour, so the bar column conveys nothing at a glance.

Additional Sonarr queue screenshots:
- `https://preview.redd.it/jef1dummc9z51.png?width=882&format=png&auto=webp&s=60ac50082d6901b9ba328eda74932d90ddb5306d`
- `https://www.firesofheaven.org/attachments/sonarr-queue-jpg.96361/`
- `https://user-images.githubusercontent.com/17851196/58369701-f8563f80-7ef5-11e9-8ffd-e4cc78e501ed.png` (Radarr)
- `https://forums-eu-sonarr-tv.s3.dualstack.eu-west-1.amazonaws.com/optimized/2X/c/ca2b7a4ae471c021af2d9ea7380003c60e5ffffa_2_690x232.jpeg`

**What users actually complain about** (sourced):
- *Unbounded queue with no way to comprehend it*: "My queue currently has 700+ items on it. When I go to this window I have a seemingly endless list of items to deal with." Filtering requires 4+ clicks through `Filter > Custom Filters > Add Custom Filter` and you're **forced to name and save a label** just to look at one show. — https://forums.sonarr.tv/t/interactive-queue-filtering/39885
- *Table breaks on real data*: long series + episode names blow past the 450px max-width and "On mobile devices the right-hand controls are completely cut-off." — https://github.com/Sonarr/Sonarr/issues/2595
- *Status strings that only make sense if you know the internals*: queues fill with `Downloaded - Waiting to Import`, and the user's fix was to go mangle labels in the download client. The queue exposed a pipeline stage the user had no mental model for. — https://www.reddit.com/r/sonarr/comments/m15l25/activity_queue_full_with_downloaded_waiting_to/
- *Colour-coded bars with meanings you must hover to learn*: "Is the bar purple or gold? If you hover over it, it can also tell you the possible issue." — https://www.reddit.com/r/sonarr/comments/1d1016z/queued/
- *Doesn't live-update*: refresh button updates internal data but not the DOM; users must hard-reload the page. For a page called "Activity", **it isn't live**. — https://github.com/Sonarr/Sonarr/issues/4805
- Sonarr even has a known issue where missing artwork means "the show is left with no artwork... forever. Which looks ugly in the UI" — https://github.com/Sonarr/Sonarr/issues/3043

**Verdict (inference):** Sonarr's Queue is the exact thing the owner rejected — a table of internal pipeline state, no artwork, jargon columns (`Download Client`), unbounded row count, dead columns. It is the *anti-reference*. Its one good idea: the sidebar count badge as an ambient "there is work" signal.

### Immich — jobs/workers admin page

- `https://docs.immich.app/assets/images/admin-jobs-e6a2cdea8699a26af4424613efef9398.webp` (2068×**7698** — note the aspect ratio: the jobs page is a ~7700px-tall stack of job cards)
- `https://docs.immich.app/administration/jobs-workers`
- `https://github.com/bytePatrol/Immich-Job-Visualizer/raw/main/screenshots/diagnostics.png`

Immich exposes named internal queues (Thumbnail Generation, Metadata Extraction, Smart Search, Face Detection…) each with active/waiting counts and manual trigger buttons. **This is explicitly an admin/machinery surface**, and it generates exactly the failure mode we're avoiding — a stream of user confusion posts about queue internals:
- "My job queues are taking a long time" — https://www.reddit.com/r/immich/comments/1pya5e2/my_job_queues_are_taking_a_long_time/
- "Endless Job Queues?" — https://www.reddit.com/r/immich/comments/1q7o7zl/endless_job_queues/
- "All my Jobs are running but they have been stuck for a few days now. Help please." — https://www.reddit.com/r/immich/comments/1enafv3/all_my_jobs_are_running_but_they_have_been_stuck/

**Lesson (inference):** exposing named worker queues with counts *creates* the "is it stuck or is it done?" anxiety rather than resolving it. A count that doesn't move is indistinguishable from a crash. Immich's job page is a legitimate admin tool but it is **not** an activity view for an end user. If subtitle-scout wants this, it belongs behind a "诊断/Diagnostics" door, not on the activity page.

Immich's *good* pattern by contrast: the mobile backup screen shows the **actual photo thumbnail currently uploading**, plus `n of m` — artwork-forward, count-based.
- `https://preview.redd.it/here-is-another-immichs-progress-update-and-everyone-needs-v0-k32ju7gvi9m91.png?width=237&format=png&auto=webp&s=0548b4577588baaa5245fd4595582f674ffa3767`
- `https://github.com/Nasogaa/immich-drop/raw/master/screenshot.png`

### Netflix downloads — consumer-grade, artwork-forward

Inspected: `https://static0.makeuseofimages.com/wordpress/wp-content/uploads/2024/07/netflix-windows-app-july-2024-showing-downloads.jpg?q=70&fit=crop&w=825&dpr=1`

- The Netflix downloads surface is **poster-grid first**. Rows of ~2:3 portrait posters under plain human headers (`Watch It Again`, `Your Next Watch`). Badges overlay the artwork (`New Season`) rather than sitting in a metadata column.
- The empty/first-run state is not a blank page — it's a modal explaining the download glyph plus a **primary CTA that navigates you to content**: `FIND SOMETHING TO DOWNLOAD`. So Netflix's zero-state answer is "go do the thing", over artwork.
- **Smart Downloads** is the key prior art for invisible automation: Netflix silently deletes a watched episode and downloads the next one. The UI surface is a single toggle plus the *result* (the next episode is simply there). There is no queue, no log, no per-step progress. Users see outcomes, never the mechanism.
  - `https://www.lifewire.com/thmb/yyyYNlROKMtSOB0UbZ7FKQaYVXs=/1500x0/filters:no_upscale():max_bytes(150000):strip_icc()/004_download-netflix-tv-shows-movies-4134207-ae72615710d84d98b47aae13bfd2a000.jpg`
  - `https://static0.makeuseofimages.com/wordpress/wp-content/uploads/2022/10/Netflix-smart-downloads.JPG?q=49&fit=crop&w=825&dpr=2`
  - `https://static0.makeuseofimages.com/wordpress/wp-content/uploads/2022/09/Netflix-Downloads-for-you-toggle-page.jpeg?q=50&fit=crop&w=825&dpr=1.5`
  - `https://www.trustedreviews.com/wp-content/uploads/sites/7/2022/09/How-to-use-Smart-Downloads-on-Netflix-4.jpg`
  - `https://www.cnet.com/wp-content/uploads/sites/2/49d826f9-41f2-4cb5-a4bd-b62c429b8120.jpg?resize=768,432`
  - Sources: https://lifewire.com/download-netflix-tv-shows-movies-4134207 , https://www.trustedreviews.com/how-to/set-up-smart-downloads-on-netflix-4263380
- Per-title download state on mobile is a **small ring/spinner drawn on the artwork itself**, not a separate row with a bar. Progress annotates the poster.

**Lesson:** artwork carries identity; state is a small overlay on the artwork. Netflix never gives automated background work its own log.

### Comparison table

| Product | Artwork? | Size | "Now" hero vs list? | Batch progress | Machinery exposed? |
|---|---|---|---|---|---|
| Steam Downloads | Yes | Hero backdrop full-bleed + 168×79 capsules | **Yes, strong** | `1 of 2 Items Complete` (count) | Only behind (i) tooltip |
| Sonarr/Radarr Queue | **No** | — | No, flat table | none; raw row count `665` | Fully (`Download Client`, import stages) |
| Immich Jobs | No | — | No, stack of queue cards | active/waiting counts | Fully (named workers) |
| Immich mobile backup | Yes | Small thumb of current photo | Weak hero | `n of m` | No |
| Netflix Downloads | **Yes** | 2:3 posters, grid-scale | No — grid of outcomes | none (invisible) | No |
| App Store updates | Yes | ~60px rounded app icon | No — uniform rows | none | No |
| qBittorrent/Transmission | No | — | No, table | aggregate speed in status bar | Fully (peers, trackers, ratio) |
| Plex Dashboard | Yes | Poster/still thumb per stream | Cards, no single hero | n/a | Partially (transcode info) |

## Q3. Communicating work without exposing the machinery

### The governing principle, sourced

> "**Be user-focused, not system-focused: Talk about what the user cares about, not what the system is doing.**"
> — https://www.eleken.co/blog-posts/ux-writing-best-practices

> "As tech specialists, we're often subject to **the curse of knowledge**, and despite our efforts to prioritize users, tech jargon can sneak into our interface copy." … checklist item: "**No tech jargon.** … **1 entity = 1 term.** … Actions are expressed with verbs, not nouns."
> — https://www.smashingmagazine.com/2024/06/how-improve-microcopy-ux-writing-tips-non-ux-writers/

> "**Specific verbs** (such as *connect* or *save*) are more meaningful to users than **generic ones** (such as *configure* or *manage*). … Remove technical terms."
> — https://digital-experience.blogs.bristol.ac.uk/2020/03/13/ux-writing-making-our-microcopy-clear-concise-and-useful/

> "**Be a copycat:** UX content writing isn't about being unique — it's about being understood. Use terminology your users are already familiar with. If everyone calls it a 'cart', don't label it a 'bag'."
> — https://www.eleken.co/blog-posts/ux-writing-best-practices

This last one is the direct rebuttal to "orchestrator/agent/asset": **the user's existing word is 字幕 (subtitle), 剧集 (episode), 找 (find).** Not agent, not asset, not candidate, not orchestrator.

The canonical jargon-removal pattern from every source above is the same shape:
- ❌ "Authentication failed" → ✅ "Incorrect password. Try again."
- ❌ "Invalid input detected" → ✅ "Please enter a valid phone number"
- ❌ "Operation failed: code 458" → ✅ human sentence

Applied to us: ❌ "Agent evaluating candidate release" → ✅ "正在为《XXX》找字幕".

### The verb rule for background work

Sourced guidance on progress copy (https://aiuxplayground.com/skills/ux-writing/, https://faqprime.com/en/write-engaging-ux-microcopy-for-loading-text-free-templates/):
- < 2s: no text
- 2–10s: present-progressive verb + object — `"Saving changes…"`, `"Loading your dashboard…"`
- \> 10s: verb + **expectation setting** — `"Processing your video. This usually takes 1-2 minutes."`
- Count form is explicitly endorsed: `"1 of 5 items loaded"`

So the grammar of an in-flight row is **`<present-progressive verb> + <the user's own object>`** and nothing else. The subject is elided — never "系统/助手/agent 正在…", just "正在…". Eliding the subject is what removes the machinery: Chinese conveniently drops the subject naturally, so `正在找字幕` has no actor at all. **This is a linguistic gift for this exact problem** (inference, but strong).

### How products show ONE action satisfying MANY items

Sourced patterns:
- **Steam**: the app-wide footer reads `DOWNLOADING / 1 of 2 Items Complete` — batch state is an **item count**, never a byte percentage across heterogeneous items. NN/G independently endorses this exact form: *"include a text explanation of the process, for example 'Updating address 3 of 50.'"* (https://www.nngroup.com/articles/progress-indicators/)
- **Netflix Smart Downloads**: the batching (delete watched, fetch next) is **completely invisible**. There is no queue UI at all — only a toggle and the outcome. The user's mental model is "the next episode is ready", not "a background job ran".
- **App Store / Play Store**: `Update All` produces one aggregate progress affordance; the per-app rows collapse into it. The user does not see the dependency resolution.

**Design consequence (inference):** the correct unit for our activity feed is **the outcome for a title/season, not the action taken.** A season pack that fills E01–E24 must be ONE card reading `《XXX》第 1 季 · 24 集字幕已就位`, with the season poster. The fact that this was one download rather than 24 is *machinery* — the user only needs to know the coverage changed for 24 episodes. Never render 24 rows for one action, and never render "matched season pack to 24 episodes".

### Intentional no-ops presented as success, not skip

I found no single canonical article on this, so this is largely **inference from adjacent sourced guidance**:
- Smashing's checklist: "**Avoid or reduce the use of 'not', 'un-', and other negatives**" and "Double negatives increase cognitive load". `已跳过` / `无需处理` / `未处理` are all machine-framed negatives.
- The empty-state formula (https://aiuxplayground.com/skills/ux-writing/) is "what this space is for / why it's empty / how to fill it" — i.e. **explain the state as normal**, don't report it as an absence.
- Steam's precedent: a completed item's affordance is `▶ Play` — the row's tone is "this is ready for you", not "this task terminated".

**Therefore:** items needing nothing should not appear in the activity feed as rows at all in the common case. When they must be surfaced (e.g. after a scan, so the user understands the scan wasn't a no-op), they belong in a **single collapsed positive summary**: `本次扫描中，312 集已有字幕，无需处理` — one line, positive framing, collapsible for detail. Critically: **the same visual language as success (green/neutral dot), never the warning/error language.** The prior research's finding that Bazarr bug reports stem from conflating done-and-fine with stuck-and-broken applies here.

### Anti-patterns: complaints about progress UI being too technical/noisy

Sourced:
- The NN/G contextual-inquiry quote — a user reduced to reading a spinner as a liveness probe: *"If this little globe is spinning, it's still doing something. If I see that globe stops spinning, or it doesn't show up, then I know my software probably crashed."* NN/G's verdict: *"When these details are not provided, even frequent, long-term users become confused and frustrated."* — https://www.nngroup.com/articles/designing-for-waits-and-interruptions/
- Sonarr `Downloaded - Waiting to Import` — a pipeline stage leaked as user-facing status; users respond by editing download-client labels. https://www.reddit.com/r/sonarr/comments/m15l25/activity_queue_full_with_downloaded_waiting_to/
- Sonarr colour-coded bars requiring hover to decode. https://www.reddit.com/r/sonarr/comments/1d1016z/queued/
- Immich named worker queues → recurring "are my jobs stuck?" posts (3 cited in Q2).
- Adobe on spinners: *"this type of progress indicator tends to have negative connotations… users don't like to see only a loading spinner with no indication of progress or time."* — https://blog.adobe.com/en/publish/2016/09/06/xd-essentials-best-practices-for-animated-progress-indicators

## Q5. Progress for indeterminate, non-linear work

### The single most relevant sourced passage in this entire research

Jakob Nielsen, *Response Time Limits*:

> "For operations where **it is unknown in advance how much work has to be done**, it may not be possible to use a percent-done indicator, but it is still possible to provide running progress feedback in terms of the **absolute amount of work done**. For example, **a system searching an unknown number of remote databases could print the name of each database as it is processed.** If this is not possible either, a last resort would be to use a less specific progress indicator in the form of a spinning ball … or any such mechanism that at least indicates that the system is working, even if it does not indicate what it is doing."
> — https://www.nngroup.com/articles/response-times-3-important-limits/

Our provider search **is literally Nielsen's example**: searching an unknown number of remote sources. His prescription — name each source as you process it — maps to `正在查找第 3 个来源` or, better in outcome terms, a last-action line. A spinner is explicitly the **last resort**, ranked below naming the work.

### The determinate/indeterminate thresholds, sourced

From NN/G https://www.nngroup.com/articles/progress-indicators/ and https://www.nngroup.com/articles/response-times-3-important-limits/:
- **< 1s**: no indicator. (Adding one violates "display inertia" — *"flashing changes on the screen so rapidly that the user cannot keep pace or feels stressed"*.)
- **2–9s**: looped/indeterminate indicator is correct; a true percent-done indicator "may be overkill".
- **≥ 10s**: percent-done required, **plus a clearly signposted way to interrupt**. 10s is the limit of held attention.
- **Lower the cutoff when your estimate is uncertain**: *"since you can't always estimate the delay precisely in advance, you may want to lower the cutoff point… The bigger the variability in your estimates, the lower the threshold for showing the more elaborate [percent-done] feedback."*
- **Exception that applies to us**: *"A percent-done indicator **may** be used for actions that take less than 10 seconds, if the action involves processing a **series of documents or registries**, because the user understands that the system is working with a **set number of records**."* → When we have N known gaps, `3 / 47` is legitimate even for fast work, because the denominator is real.
- **Always give an escape hatch**: *"For actions that take a little while, give users the option to stop the process… Otherwise, your design may be hijacking control of the system, leaving the user powerless."*

### When a spinner becomes actively harmful

- *"Only use a spinner for waits between 2 and 10 seconds. **The Trap:** If you use a spinner for a long wait (like 30+ seconds), it has the opposite effect. It becomes a symbol of frustration. The user feels helpless because the spinner just loops forever with no end in sight."* — https://medium.com/design-bootcamp/the-psychology-of-waiting-in-ux-0f0b24cdeb8f
- *"While looped animations… can help users understand that the system is doing something, it's been long-established that they are **not appropriate for waits exceeding 10 seconds**… because a busy-state loop animation doesn't tell users whether it's worth waiting out the process."* — https://www.nngroup.com/articles/designing-for-waits-and-interruptions/
- NN/G's prescription when you can't estimate: *"When reasonably accurate percent-done or time-remaining estimates cannot be provided, **indicate relative progress by providing a list of completed and remaining steps**."* — same URL.

### Avoiding fake precision

- NN/G on the credibility cost of a lying bar: *"A percent-done indicator makes users develop an expectation for how fast the action is being processed. As a result, **changes in speed will be noticed** and will impact user satisfaction: **if the progress moves quickly only to hang on the last percentage remaining, the user will become frustrated and the benefits of showing progress will be negated.**"* — https://www.nngroup.com/articles/progress-indicators/
- Valve's fix is the engineering answer to the same problem: they made the bar cover **disk allocation as well as download** precisely because the old bar "would make an update appear completed when it was not". If your denominator is wrong, don't show a bar — fix the denominator or change the widget.

### The hierarchy to adopt for subtitle-scout (inference, built on the above)

Best → worst representation for our work:
1. **Known denominator, item-counted**: `本次共 47 集待处理 · 已完成 12` + a determinate bar over N. Legitimate because N is real and the user's model is "episodes", not bytes.
2. **Step/source counter**: `正在查找来源（3/5）` — Nielsen's "print the name of each database".
3. **Last-action text that updates**: a live one-line "what just happened" under the current item. Conveys liveness *and* content simultaneously; this is what makes a page feel like an activity view rather than a spinner.
4. **Elapsed time**: `已进行 42 秒` — honest, never wrong, and lets the user judge stuckness themselves.
5. **Bare pulse/spinner**: acceptable only for the sub-10s per-item phase, and only *alongside* a name.
6. **Never**: a synthetic percentage for the search phase. There is no denominator; inventing one destroys trust the first time it stalls at 90%.

For the AI-translation step (slow, minutes-to-hours) NN/G's ≥10s rules bind hard: it needs a real determinate signal (translated-lines / total-lines is a genuine denominator — use it), an expectation-setting line (`通常需要几分钟`), and a visible cancel.

## Q4. Idle state for a converged system

### NN/G, *Designing Empty States in Complex Applications* — the governing source

https://www.nngroup.com/articles/empty-state-interface-design/ (Kate Kaplan, 2021)

> "**Totally empty states cause confusion about how and whether the system is working.** When users encounter an empty panel or screen … they're likely left wondering a myriad of questions: **Is the system finished processing the request? Is content still loading? Did an error occur?** Did I set the wrong filters or parameters?"

That sentence *is* the idle-vs-stuck problem, stated by NN/G. Their guidelines:
- "**Do not default to totally empty states.**"
- "If there is no relevant data to display **after a process has completed**, use the empty space to provide a **system-status message** … that briefly states that no content is available."
- "When a process is running, use **progress indicators** to increase visibility of system status." → *the widget itself distinguishes the two states*: progress indicator = running; status message = converged.
- Use empty states to "provide **direct pathways** for key tasks."

And the most valuable warning for us:

> "A worse, yet equally common scenario … is when the system defaults to a **misleading** system-status message: declaring that there are no items to display, only to replace it with content after the process is completed. … **Inaccurate system-status messages for empty states are particularly harmful.** In the best-case scenario, users wait out the process and discover the relevant content but develop a **severe distrust of and distaste for the application.**"

Image evidence from that article (worth looking at — they are literal before/after mockups of our exact problem):
- `https://media.nngroup.com/media/editor/2021/09/15/empty_state_without_system_message.jpeg` (bad: silent empty table)
- `https://media.nngroup.com/media/editor/2021/09/15/empty_state_with_system_message.jpeg` (good: "There are no records to display for the selected date range")
- `https://media.nngroup.com/media/editor/2021/09/15/empty_state_ui_inaccurate_system_message.jpeg` (the harmful "No records" that later fills in)
- `https://media.nngroup.com/media/editor/2021/09/15/alerts_panel_empty_state_ui_design.png`
- `https://media.nngroup.com/media/editor/2021/09/15/star_favorites_dialog_message_empty_state_interface.jpg`
- `https://media.nngroup.com/media/editor/2021/09/15/powerbi_empty_state_message.jpg`
- `https://media.nngroup.com/media/editor/2021/09/15/loggly_empty_state_message_screen.jpg`

**Direct application:** subtitle-scout must never render "一切就绪 / 没有待办" before the first scan has actually completed. Until we *know* we're converged, the correct state is a running indicator, not a reassuring empty state. Showing "全部就绪" and then filling in 47 items 5 seconds later is the NN/G-documented trust-destroying pattern.

### The taxonomy of empty states — we need the third kind

https://uxpatterns.dev/patterns/user-feedback/empty-states names three variants, and explicitly separates ours out:

| Variant | When | Ours? |
|---|---|---|
| First-use empty state | "expected on day one" | before first scan |
| No-results state | "the system has data, but the current view is empty" | filtered views |
| **Completed-state empty state** | "**Confirms there is nothing left to process.** Use for **inbox zero, cleared queues, or finished workflows**" | **← this is subtitle-scout at rest** |

Their required anatomy for an empty state (all three required):
1. **State message** — "explains why nothing is currently visible"
2. **Supporting detail** — "**clarifies whether the state is first-use, filtered, or already completed**" ← sourced requirement that we must disambiguate the *kind* of idle
3. **Primary action** — "gives users the most useful next step"
(optional: secondary recovery path; supporting visual — "**reinforces the state without replacing the text**")

Their content rules that bind us:
- "**Do not use the same tone for success, warning, and failure states.**"
- "Design **idle, loading, success, and failure states as a family**."
- "Do not rely on **color-only** severity mapping."
- "Do not let placeholders and live content use **completely different geometry**." ← the idle page must not be a structurally different page from the busy page. **This kills the "swap in a stats dashboard when idle" idea**: the idle state should be the same layout with the hero region in a resting state, not a different screen.

### What artwork-rich apps show at rest (sourced + inference)

- **Steam with nothing downloading**: the hero region collapses; the throughput graph flatlines but remains; the sections that have content stay. `COMPLETED (n)` with real capsule artwork and `▶ Play` buttons is what's on screen. **Recently-completed-with-artwork IS Steam's idle content.** (Sourced from the 2021 layout screenshot in Q1, which shows COMPLETED as a first-class peer section with artwork and a launch action.) Steam also keeps `Auto-updates enabled` visible at rest — an ambient statement that the system is *watching*, which is exactly the reassurance a converged system needs.
- **Netflix downloads, nothing to do**: poster grid of what you already have, plus `FIND SOMETHING TO DOWNLOAD` as the primary action. Artwork stays; the CTA points outward to the library. (Inspected screenshot, Q2.)
- **Immich**: at rest the job page shows all queues at `0 active / 0 waiting` — indistinguishable from broken, which is why the "are my jobs stuck?" posts exist. Anti-reference.

**Synthesis (inference):** the idle state's content is **recent completions rendered with artwork, in the same geometry as active work**, topped by one honest status line and a watching-indicator. Not statistics. The difference between this and the rejected ledger is:
- A ledger says *"本月共处理 312 集，成功率 94%"* — aggregate, static, about the system's performance.
- An activity view at rest says *"《XXX》第 1 季 · 24 集字幕已就位 · 2 小时前"* with the poster — **specific, recent, about the user's media**, and clickable through to that title.
The test: **every element on the idle page should be a piece of the user's library with a picture, or one line of status. If it's a number without a poster attached, it's a ledger.**

### Distinguishing idle-because-done from idle-because-stuck

Sourced constraints assembled:
- NN/G: use a progress indicator while running, a status message when complete — *different widgets*, not different text in the same widget.
- uxpatterns.dev: "**Supporting detail** — clarifies whether the state is first-use, filtered, or **already completed**"; "Critical warning or failure → **use a persistent alert or banner**. Keep it visible until the user can acknowledge or recover."
- uxpatterns.dev: "Do not rely on color-only severity mapping" → the distinction must be carried by **words**, not just a dot colour.

**Recommended three-way distinction (inference, built on the above):**

| State | What the user must conclude | Widget | Copy |
|---|---|---|---|
| Converged | "nothing needs doing, and it's watching" | resting status line + timestamp + recent-completions with artwork; no bar | `字幕都齐了 · 最近检查 3 分钟前` |
| Working | "it's doing something right now" | hero with live last-action text + item counter | `正在处理 · 3/47` |
| Blocked | "this needs me" | **persistent banner**, distinct from both | `3 集暂时找不到字幕 · 查看原因` |
| Never-scanned | "it hasn't started yet" | first-use empty state with CTA | `还没扫描过媒体库 · 开始扫描` |

The two load-bearing details:
1. **A freshness timestamp on the idle state is what proves liveness.** `最近检查 3 分钟前` cannot be produced by a crashed system, and it's the cheapest possible answer to "is this thing alive?" A bare `字幕都齐了` cannot distinguish converged from crashed; with the timestamp it can. This is the single highest-value element on the idle page.
2. **Blocked items must never be silently folded into the idle state.** If 3 episodes have no subtitle anywhere, "字幕都齐了" is a lie of exactly the NN/G "misleading system-status message" species. The banner is mandatory.

Also worth noting: because our work is **bursty** (a scan yields dozens, then hours of nothing), the idle page will be the *most-seen* state of this product. It deserves more design attention than the busy state, not less.

## Layout anatomy of Steam's download page

Precise breakdown of the current (2025) page, from the inspected screenshot (992×643 content area). Proportions are measured off that image; treat them as ±3%.

```
┌──────────────────────────────────────────────────────────────────────┐
│ REGION A — HERO / "NOW"                              ~36% of height  │
│ ┌────────────────────────┬───────────────────────────────────────┐   │
│ │ A1 key art, full-bleed │ A3 stat trio (right-aligned, ~30%)    │   │
│ │ ~40% width, bleeds to  │   NETWORK 0 B/s  PEAK 115.3 MB/s      │   │
│ │ top+left edges, fades  │   DISK USAGE 338.5 MB/s        [gear] │   │
│ │ into panel on right    ├───────────────────────────────────────┤   │
│ │                        │ A4 phase bar 1: Downloading complete  │   │
│ │ A2 throughput spark-   │      ████████████████ 6.3 GB / 6.3 GB │   │
│ │ line drawn OVER the    │ A5 phase bar 2: Patching files    69% │   │
│ │ art, ~35% width        │      ███████████░░░░░                 │   │
│ │                        ├───────────────────────────────────────┤   │
│ │                        │ A6 Estimated 00:41 remaining  [ ⏸ ]   │   │
│ └────────────────────────┴───────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────────────┤
│ REGION B — SECTION HEADER                              ~6% of height │
│  Up Next (5) ────────────────────────── Auto-updates enabled         │
├──────────────────────────────────────────────────────────────────────┤
│ REGION C — QUEUE                                      ~58% of height │
│ ┌────────┬─────────────────────────────────┬─────────────┬──────┐    │
│ │capsule │ Title (bold, white, ~17px)      │ NEXT        │ [⬇]  │    │
│ │168×79  │ meta (muted, ~13px) │PATCH NOTES│ 1% COMPLETE │      │    │
│ │(2.1:1) │                                 │ ░░░░░░ faded│      │    │
│ └────────┴─────────────────────────────────┴─────────────┴──────┘    │
│  ...4 more identical rows, ~100px tall each                          │
└──────────────────────────────────────────────────────────────────────┘
```

Region proportions and the reasoning:

| Region | Share | Contents | Why it's shaped that way |
|---|---|---|---|
| A. Hero | ~36% h | one item, full-bleed art, phase bars, ETA, pause | The single item you might act on gets a third of the screen. Art is *scenery*, not a thumbnail. |
| B. Header | ~6% h | `Up Next (5)` + rule + ambient status right | Count answers "how much left?" without scrolling. Right slot = ambient system state or bulk action. |
| C. Queue | ~58% h | N rows, small capsule + title + one meta line | Uniform, scannable, low-ink. No fake progress. |

Key structural observations:
1. **Artwork size ratio hero:queue ≈ 5:1 by width.** That ratio alone encodes "now vs next" — no badge, no colour, no label needed.
2. **The graph lives inside the artwork.** The live-data element and the identity element share one band, which is why the hero reads as *alive* rather than as a static poster.
3. **One item is privileged, N items are uniform.** Steam never renders two heroes.
4. **The right edge is an action column.** Every row's rightmost element is a button; the hero's is pause. Actions are spatially predictable.
5. **The 2021 variant proves the section taxonomy generalises**: `QUEUED` / `SCHEDULED` / `COMPLETED`, each `Name (count)`, each row's right side carrying *the thing appropriate to that state* — progress for queued, a **date** for scheduled, a **timestamp + ▶ Play** for completed. Same row geometry, different right-hand payload. That is the single most portable idea on the page.
6. **Aggregate progress is a count, in a persistent footer**, away from the per-item detail: `DOWNLOADING / 1 of 2 Items Complete`.

## Recommended layout for subtitle-scout

### Regions

```
┌─────────────────────────────────────────────────────────────────────┐
│ A. 现在 (HERO)                                     ~30–36% viewport │
│    backdrop/still full-bleed left ~40%, fades right                 │
│    ┌──────────────────┬────────────────────────────────────────┐    │
│    │ backdropUrl() or │ 《进击的巨人》S1E05                     │    │
│    │ stillUrl() image │ 正在找字幕 · 已试 3 个来源              │    │
│    │ bleeds to top+   │ ─────────────────────────────           │    │
│    │ left edge        │ 本轮进度  12 / 47 集      ████░░░░░░    │    │
│    │                  │ 已进行 42 秒                    [ 暂停 ]│    │
│    └──────────────────┴────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────────┤
│ B. 接下来 (12)  ───────────────────────────  自动检查已开启          │
├─────────────────────────────────────────────────────────────────────┤
│ C. queue rows — still 160×90 (16:9) or poster 60×90 (2:3)           │
│    ┌────────┬──────────────────────────────────┬───────────┐        │
│    │ still  │ 《XXX》S1E06                     │  等待中   │        │
│    │ 160×90 │ 缺中文字幕                        │           │        │
│    └────────┴──────────────────────────────────┴───────────┘        │
├─────────────────────────────────────────────────────────────────────┤
│ D. 刚刚完成 (8)  ────────────────────────────────  [ 清除 ]          │
│    ┌────────┬──────────────────────────────────┬───────────┐        │
│    │ poster │ 《XXX》第 1 季                    │ 2 分钟前  │        │
│    │ 60×90  │ 24 集字幕已就位                   │  [查看]   │        │
│    └────────┴──────────────────────────────────┴───────────┘        │
└─────────────────────────────────────────────────────────────────────┘
```

### Where artwork goes, at what size

Using the repo's real helpers (`web/src/api/client.ts`):

| Slot | Helper | TMDB size | Rendered size | Fallback |
|---|---|---|---|---|
| Hero background | `backdropUrl(backdropPath)` | `w1280` | full-bleed, ~40% width × hero height, `object-fit: cover`, right-edge mask-image fade | if null → `stillUrl(stillPath)`; if that's null → `posterUrl()` blurred; if all null → typographic hero (existing detail-page degradation is already documented as "降级纯排印头部") |
| Episode row | `stillUrl(stillPath)` | `w300` | 160×90 (16:9), radius 4 | → `PosterThumb` 60×90 |
| Season/movie row | `posterUrl(posterPath)` | `w400` | 60×90 (2:3), radius 4 | `PosterThumb`'s existing initial-letter placeholder |
| Completed batch card | `posterUrl(posterPath)` | `w400` | 60×90 | same |

Reuse `PosterThumb` verbatim for the 2:3 slots — it already handles null + `onError` degradation. A new `StillThumb` mirroring it for 16:9 is the only new asset component needed. Episode rows should prefer the **still** (it's the specific episode — more informative and more beautiful than repeating the same poster 24 times); season/movie rows use the poster.

**Non-negotiable:** every row in every region has an image slot. There is no text-only row anywhere on this page. That is the direct fix for error #3.

### Exact user-facing copy strings

Hero, working:
```
正在找字幕
《进击的巨人》第 1 季 第 5 集
已试 3 个来源
本轮进度  12 / 47 集
已进行 42 秒
[ 暂停 ]
```
Hero, translating (the opt-in AI step — never says "AI agent"):
```
正在生成字幕
《XXX》第 2 季 第 3 集
找不到现成字幕，正在翻译
已翻译 340 / 1,120 行 · 通常需要几分钟
[ 停止 ]
```
Hero, idle/converged:
```
字幕都齐了
最近检查 3 分钟前 · 自动检查已开启
[ 立即检查 ]
```
Hero, never scanned:
```
还没扫描过媒体库
扫描后会自动补齐缺失的字幕
[ 开始扫描 ]
```
Blocked banner (persistent, above the hero):
```
3 集暂时找不到字幕        [ 查看 ]
```

Section headers: `接下来 (12)`, `刚刚完成 (8)`. Right-aligned ambient text: `自动检查已开启`. Bulk action: `清除`.

Queue row second lines: `缺中文字幕` / `等待中` / `排队中`.

Completed row second lines — **outcome, never mechanism**:
```
字幕已就位
24 集字幕已就位
中文字幕已就位
```
Timestamp right-aligned via the design system's `Timestamp`: `2 分钟前`. Action: `[ 查看 ]` (mirrors Steam's `▶ Play` — the completed row's affordance is the next useful thing, not a dismissal).

No-op summary, one collapsed line at the bottom of the completed region:
```
另有 312 集本来就有字幕                    ▸
```
Expanding it lists them with artwork. Neutral/success dot, **never** a warning colour, **never** the words 跳过 / 未处理 / 忽略.

### How batch satisfaction is phrased

One action covering E01–E24 renders as **exactly one card**, with the season poster:
```
《进击的巨人》第 1 季
24 集字幕已就位
2 分钟前                        [ 查看 ]
```
Expanding shows the 24 episode rows with stills. The card is the event; the episodes are the detail. Never 24 top-level rows; never any mention of a season pack, a match, a candidate, or a provider.

While in flight, the hero for a batch reads:
```
正在找字幕
《进击的巨人》第 1 季 · 24 集缺字幕
已试 3 个来源
```

### State machine of the hero region

| Condition | Hero shows | Distinguishing element |
|---|---|---|
| Never scanned | first-use empty state + `开始扫描` | CTA present |
| Working | live item + counter + elapsed | moving counter |
| Converged | `字幕都齐了` + freshness timestamp | **timestamp proves liveness** |
| Blocked (any unresolvable) | converged text **plus** persistent banner | banner |

The freshness timestamp is the load-bearing element (see Q4). Never show `字幕都齐了` before the first scan has genuinely completed — NN/G documents that premature "nothing here" is the most trust-destroying empty-state failure.

### Design-system mapping

`AspectRatio` + `Thumbnail` for image slots · `ProgressBar` for the item-counted bar only · `StatusDot` for row state (paired with a word, never colour alone) · `Badge` for `中文` / `简` language tags · `Collapsible` for the no-op summary and batch expansion · `Timestamp` for all relative times · `EmptyState` for never-scanned only · `Skeleton` while the first load resolves — **critically, `Skeleton` not `字幕都齐了`**, so we never render a false converged state · `Carousel` is a candidate for the 刚刚完成 region if we want horizontal poster scroll (Netflix-style) rather than rows.

## Vocabulary table

| Machinery term (must never appear) | User-facing Chinese | Note |
|---|---|---|
| subtitle-finding agent / orchestrator | 正在找字幕 | subject elided — no actor named |
| agent evaluating candidates | 正在找字幕 · 已试 3 个来源 | "candidate" never surfaces |
| mechanical filter / prefilter | (nothing) | internal stage, never shown |
| provider / indexer | 来源 | `已试 3 个来源` |
| candidate / release | (nothing) | collapse to the outcome |
| match / matched | 已就位 | outcome, not judgment |
| season pack | 第 1 季 · 24 集 | describe coverage, not the artifact |
| asset | 海报 / 剧照 | or nothing at all |
| gap / missing coverage | 缺中文字幕 | |
| target language | 中文 | name the actual language |
| embedded track | 内封字幕 | only if it must be said |
| AI translation step | 正在生成字幕 / 正在翻译 | never "AI agent" |
| download + install | 已就位 | one user-visible outcome |
| skipped / no-op | 本来就有字幕 | positive framing |
| queued job / task | 等待中 / 排队中 | |
| scan / reconcile / converge | 检查 | `自动检查已开启` |
| idle / converged | 字幕都齐了 | + freshness timestamp |
| failed / exhausted providers | 暂时找不到字幕 | 暂时 keeps it non-terminal |
| ledger / history / audit | 刚刚完成 | |
| item / entity | 集 / 部 / 季 | the user's own units |

Rules: (1) elide the subject — Chinese lets us describe work with no actor, which is the whole solution to "don't expose the agent"; (2) present-progressive for in-flight, resultative 已…了 for done; (3) 暂时 on every failure so nothing reads as permanent; (4) one term per concept.

## Rejected patterns

**A statistics ledger** (`本月处理 312 集 · 成功率 94% · 平均 8 秒`). Rejected because a ledger reports on *the system* over a *past window*; an activity view shows *the user's media* in *the present*. Aggregates have no artwork to attach to, which is why the previous attempt lost all imagery — the format structurally excludes posters. Sourced support: uxpatterns.dev requires an empty state to have a *state message + supporting detail + primary action*, none of which a stats block provides; and "do not let placeholders and live content use completely different geometry" forbids swapping in a stats dashboard when idle. Test: **a number without a poster attached is a ledger entry.**

**Naming the machinery** (`subtitle agent`, `orchestrator`, `mechanical filter`). Rejected per the sourced microcopy consensus — "be user-focused, not system-focused", "no tech jargon", "use terminology your users are already familiar with". Sonarr's `Downloaded - Waiting to Import` is the documented failure mode.

**A Sonarr-style data table.** Rejected: zero artwork, 665 unbounded rows, a `Download Client` column, a `Time Left` column that reads `-` on every row, 4-click filtering, and it doesn't live-update. Every one of these is sourced from Q2.

**Immich-style named worker queues with counts.** Rejected: generates "are my jobs stuck?" confusion (3 cited threads). A count that doesn't move is indistinguishable from a crash. Belongs behind a diagnostics door.

**A synthetic percentage for the search phase.** Rejected: no denominator exists. NN/G — if a bar "moves quickly only to hang on the last percentage remaining, the user will become frustrated and the benefits of showing progress will be negated." Valve's own fix was to make the denominator honest, not to fake it.

**A bare spinner as the primary in-flight signal.** Rejected: Nielsen ranks it explicitly as a "last resort" below naming the work; Adobe notes spinners "tend to have negative connotations"; and NN/G's contextual inquiry captured a user reduced to using a spinner as a crash detector.

**A chronological event log as the main view.** Rejected: a log is a ledger with timestamps. Same artwork-hostility, and prior research established an empty log reads as "nobody maintains this". Recent completions *with artwork*, capped at ~8, are the activity-view form of the same information.

**Rendering 24 rows for one season-pack action.** Rejected: exposes batching machinery and floods the feed. One card, expandable.

**Showing skipped/no-op items as rows in the feed.** Rejected: they are the majority of items and they are *fine*. Smashing: avoid negatives. One collapsed positive line.

**`字幕都齐了` as the default pre-scan state.** Rejected: NN/G's documented worst case — "declaring that there are no items to display, only to replace it with content" produces "severe distrust of and distaste for the application". Use `Skeleton`, then the truth.

**Two heroes / a split "current work" region.** Rejected: Steam privileges exactly one item. Concurrency is machinery; pick the most advanced item as the hero and let the rest be `接下来`.

**Drag-to-reorder the queue.** Not rejected on principle — Steam has it — but rejected as *out of scope*: the ordering is derived from library scan order and has no user-meaningful semantics yet. Adding reorder implies the user should have an opinion about order, which is a machinery-level concern here.

## Open questions

1. **Is `本轮进度 12 / 47` the right denominator?** It's honest per-scan-burst, but if a new scan starts mid-burst the denominator jumps, which NN/G warns about (users notice speed/scale changes). Alternative: drop the bar entirely and show only `12 / 47`. Needs a decision on whether N is stable.
2. **How long does `刚刚完成` retain items, and does it survive a restart?** I recommend ~8 items / 24h, artwork retained. Steam keeps completions until `Clear All`. Unresolved: is this persisted or in-memory? Affects whether the idle state is empty after a restart — which would be the worst possible outcome given Q4.
3. **What is the hero when idle?** Options: (a) collapse to a slim status bar, (b) keep hero height with the most-recently-completed item's backdrop as scenery. (b) preserves geometry (per uxpatterns.dev) and keeps the page beautiful at rest — which is most of the time — but risks reading as "currently working on this". Leaning (b) with clearly resting typography. Needs a mockup to judge.
4. **Do episode stills actually exist at sufficient coverage?** `stillPath` is available in the schema, but TMDB still coverage for non-Western TV is patchy. If coverage is < ~60% the episode rows will mostly show poster fallbacks, which changes the visual design. **This is measurable from the existing DB and should be measured before designing.**
5. **Where does the diagnostics surface live?** Provider-by-provider detail, rejected candidates, timings — real operators want it. Behind a per-item "查看详情", a global 设置 → 诊断 page, or not at all?
6. **Does the blocked banner need per-item resolution actions** (手动指定字幕 / 用 AI 翻译 / 忽略这一集)? "忽略" is user-initiated so it's legitimate copy, unlike system-side 跳过 — but it introduces a state we then have to represent.
7. **Should the throughput sparkline be copied at all?** Steam's graph is meaningful (bytes/s). Our analogue would be items/minute over a burst, which is mostly a flat line at zero. It might be pure decoration — but it's also what makes Steam's hero feel *alive*. Possible substitute: a subtle animated pulse on the hero art while working. Unresolved.
8. **Mobile/narrow layout is entirely unaddressed here.** Steam's hero+queue split assumes desktop width. Sonarr's documented failure was exactly that its right-hand controls get cut off on mobile.
