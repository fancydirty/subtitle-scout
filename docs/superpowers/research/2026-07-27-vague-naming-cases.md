# Vague / pathological media naming cases — minimum-necessary-evidence research

**Status:** IN PROGRESS (written incrementally; safe to read partial)
**Date:** 2026-07-27
**Purpose:** Feed a controlled experiment measuring subtitle-scout's agent's *minimum necessary evidence* for identifying a video file, and to draw an honest SOLVABLE / IMPOSSIBLE boundary.

## Progress log

- [x] 1a. Jellyfin + Plex user failure reports (first pass) — DONE, see Cases group A/B/C
- [ ] 1b. Emby / Kodi / TinyMediaManager specific failure reports
- [x] 2. *arr ecosystem hard cases — DONE (episode-ordering / anime numbering), see Group F. Remaining sub-angle: dailies + miniseries + multi-ep concatenation, partially covered.
- [x] 3. Release-group / PT / Chinese scene conventions — DONE, see Group H
- [x] 5. Duration-misleading cases — DONE, see Group G
- [x] 4. Structurally ambiguous cases — DONE, see Groups I and J
- [x] 6. Genuinely-impossible cases (zero information) — DONE, see Group J
- [x] 7. Synthesis: taxonomy, candidate test cases, refusal set — DONE

## Summary of distinct failure mechanisms

**This is the taxonomy section — the most reusable output of this research.** 16 mechanisms, grouped by the *nature* of the evidence defect. The grouping matters more than the individual entries, because the four top-level classes have **different correct product responses**.

### Class 1 — Evidence is present but obscured (agent should succeed; a regex fails)
These are the cases where an LLM has a genuine structural advantage. All SOLVABLE.

| # | Mechanism | Canonical example | Where signal lives |
|---|---|---|---|
| M1 | Title absent from filename, present in ancestor dir | `2026.2160p.iT.WEB-DL...mkv` | parent/grandparent dir |
| M2 | Title corrupted — letter injection, mojibake, truncation | `招z魂z4`, `H）后丨室（2026）`, `铁.` | filename (recoverable) |
| M3 | Title polluted by edition/quality modifiers | `Blade Runner Final Cut.mkv` | filename |
| M4 | Number in title mistaken for the year | `Blade Runner 2049 (2017)`, `Wonder Woman 1984` | filename |
| M8 | Non-ASCII / typographic chars in title | `8½ (1963)`, `π`, `WALL·E` | filename |
| M15 | Title in original language / romanisation, not DB primary | `Muhtesem.Yuzyil.S01E15`, `Gisaengchung.2019` | filename |
| M16 | Title corrupted by filesystem-illegal characters | `50-50` (=`50/50`), `MASH` (=`M*A*S*H`) | filename (deterministic corruption) |
| — | Locale-specific structure markers | `庆余年.第二季.第01集` | filename |
| — | Bracket-soup / fansub tags | `[诸神字幕组][莉可丽丝][01]` | filename (dense, but parser prior says "noise") |

### Class 2 — Evidence is genuinely insufficient to *choose*, but the answer exists in TMDB
The candidate space contains the right answer; the path doesn't narrow to one. **Correct response: refuse, and tell the user renaming WOULD help.**

| # | Mechanism | Canonical example | What would resolve it |
|---|---|---|---|
| M5 | Short/common title that is a substring of other titles | `Mother.mkv`, `Burning.mkv`, `Super.mkv` | year |
| M6 | Same title, different year (remake/reboot) | `The Amityville Horror`, `The Thing`, `Halloween` ×3 | year (runtime is useless — they cluster) |
| M7 | Same title AND same year | (see Open questions) | runtime + language, else nothing but an explicit ID |
| M14 | Ancestor dir supplies a *wrong* title (franchise container) | `/饥饿游戏系列/output.mkv` | the real title; parent dir actively misleads |

### Class 3 — Evidence is irreducibly two-valued (nobody can resolve it from the path)
**This class is the important discovery.** The information is present but denotes two things. No renaming by the user fixes it, because the user faces the same ambiguity. **Correct response: neither "agent's job" nor "user must rename" — this needs content inspection or an explicit user choice. The product's binary framing does not cover this.**

| # | Mechanism | Canonical example | Why unresolvable |
|---|---|---|---|
| M9 | Bare episode number: absolute or seasonal? | `[Group] Anime - 102.mkv` | `102` = S01E02 or absolute #102 |
| M12a | Absolute numbering resets per season (AniDB) vs continuous (TVDB) | `[Group] Ansatsu Kyoushitsu - 01.mkv` | S01E01 or S02E01 |
| M12b | Alternate ordering: aired / DVD / production / international | `The Repair Shop S10E20`, Pokémon, Poirot | one token, different episodes per ordering |
| M12c | Metadata authorities disagree on season boundaries | `Cardcaptor Sakura S02E01` (TVDB S1–3 = AniDB S1) | "correct" is authority-relative |
| M12d | Specials/OVA ordering is arbitrary and unstable over time | `[Group] Show - OVA.mkv`, `Show - 13.5.mkv` | TMDB S0 vs IMDb season-append; TVDB reshuffles |

### Class 4 — The answer is not in the candidate space at all
**Correct response: "this doesn't look like a commercial release." Telling the user to rename is WRONG ADVICE here — no rename helps.** This is the distinction I'd most want the product to get right.

| # | Mechanism | Canonical example |
|---|---|---|
| M11a | Home video | `Christmas 2010.mp4`, `Jack's Diary.mkv` |
| M11b | Camera-original filename | `IMG_1234.MOV`, `DSC00123.MP4`, `GOPR0123.MP4` |
| M11c | Placeholder / transcoder-default / hash name | `output.mkv`, `1.mp4`, `Untitled.mp4`, `新建文件夹/output.mkv` |
| M11d | Real but non-TMDB-catalogued content | `2024 Monaco Grand Prix - Race.mkv`, podcasts, conference talks, YouTube rips |

### Cross-cutting: mechanisms that corrupt the *second evidence line* rather than the title
These don't fit the four classes because they attack verification, not identification. **These are the findings most specific to subtitle-scout's design.**

| # | Mechanism | Effect on the runtime check |
|---|---|---|
| M10a | Alternate cuts; TMDB stores ONE runtime per record | Runtime **fails against the correct answer**. Deltas up to 129 min observed. |
| M10b | Split files (CD1/CD2, 上/下) | Runtime ≈ half the true value → fails against correct answer |
| M10c | Multi-episode concatenation | Runtime ≈ 2× → but here the mismatch is *informative* (correctly signals a double) |
| M10d | Trailers / samples / extras | Runtime ≪ → mismatch correctly signals "not the feature" |
| M10e | PAL speedup (4%), credits in/out, Criterion banners, ad breaks | Systematic ±5% noise floor; TV ad-breaks give ~36% |
| M13 | Internally contradictory evidence | Dir says `S02`, file says `S01E15` (real, sourced) — must *adjudicate*, not extract |

**The single most actionable design conclusion:** runtime *agreement* is meaningful positive evidence; runtime *disagreement* is weak negative evidence and must **never alone** defeat a strong title match — because M10a/M10b make it fail precisely on correct answers. The agent must reason about *why* runtime differs (labelled cut? part file? trailer? double episode?) rather than applying a threshold. M10c/M10d vs M10a/M10b is the sharpest available test of that reasoning.

### An evidence dimension missing from subtitle-scout's stated set
The stated raw evidence is: directory names in path, filename, duration, embedded subtitle languages, parsed season/episode hints. **Sibling filenames in the same directory are absent, and they are the sole disambiguator for M9, and a necessary input for M13, M10b, M10c, and G3.** I'd treat adding sibling context as the highest-value evidence-dimension change suggested by this research.

> **Follow-up note (2026-07-27, skill-hardening pass):** Partly satisfied *implicitly*, not by new plumbing. In a full unidentified run, `buildUnidentifiedTargets` (`src/cli/unidentifiedFindSubtitle.ts`) batches every eligible parked path into ONE worker task, and `findSubtitleWorker.ts`'s unidentified `targetsBlock` renders each as its own line carrying a relative `dir:` segment. So parked siblings *in the same directory* are already collectively visible to the agent as sibling target lines sharing a `dir:` value — enough to resolve M9's absolute-vs-seasonal question by reading across them. `identifyMediaSkill.ts` was updated to teach the agent to use exactly this existing visibility. What remains genuinely absent (deferred — would need fs I/O in the currently-zero-I/O target builder, a new schema field, and worker rendering, and it rubs against the sandbox discipline): a true `readdir(dirName)` listing that would also surface *already-identified*, *ineligible-parked*, and *non-video* neighbours, which M13/M10b/G3 sometimes need. Logged as the honest gap; not built tonight.


## Cases

### Group A — Title polluted by edition / quality modifiers (M3)

**A1. Edition modifier absorbed into the title**
- Pattern: `Movies/Blade Runner Final Cut.mkv`, `Highlander.1986.Directors.Cut.1080p.mkv`, `The Wicker Man Uncut.avi`
- Sourced: Jellyfin issue #14598 lists the exact modifier set that breaks identification: `remastered`, `digitally.remastered`, `uncut`, `unrated`, `limited`, `theatrical`, `extended`, `extended.cut`, `directors.cut`, `dc`, `recut`, `bootleg`. Source: https://github.com/jellyfin/jellyfin/issues/14598
- Failure mechanism: title corrupted (padded), not absent.
- Where the real signal lives: filename — the title *is* present, just with trailing noise. Duration may additionally be *misleading* here (extended cut runtime ≠ TMDB canonical runtime). This case sits at the intersection of M3 and M10.
- Minimum human evidence: filename alone. A human strips "Final Cut" trivially.
- **Verdict: SOLVABLE.** Notably an LLM agent should be *strictly better* than Jellyfin here — this is a mechanical-tokenizer weakness, not an information deficit. Good "agent beats scraper" demo case, but low research value as a boundary probe. Its value is in the **runtime-mismatch interaction**: Blade Runner Final Cut is 117 min vs the 1982 theatrical 116 min; but e.g. `Apocalypse Now Redux` is 202 min vs 147 min theatrical — a runtime-based second-evidence check would *reject the correct answer*. That is the interesting failure.
- Sourced advice from Plex community that the correct shape is `Blade Runner (1982) – Final Cut.mkv`, i.e. edition label *after* title+year: https://www.positioniseverything.net/how-to-fix-plex-showing-the-wrong-movie-or-tv-show/

### Group B — Number-in-title vs year confusion (M4)

**B1. Sequel whose title ends in a 4-digit number**
- Pattern: `Movies/Blade Runner 2049 (2017).mkv` → identified as `Blade Runner (1982)`
- Sourced, with the reporter and a Jellyfin community moderator independently confirming: "Movies with the year in the name can throw off the file parser when it is constructing the query for metadata. I had exactly the same problem with Bladerunner and Bladerunner 2049. To reinforce this point, `Wonder Woman 1984 (2020).mkv` failed to identify for me as well." Source: https://forum.jellyfin.org/t-problem-with-media-identification
- Failure mechanism: structure ambiguous (the year-extraction regex is greedy/ambiguous), title effectively corrupted.
- Where the real signal lives: filename — both title and year are present and unambiguous *to a reader*.
- Minimum human evidence: filename alone.
- **Verdict: SOLVABLE.** Again an LLM should trivially beat the regex. Worth including as a control that confirms the agent doesn't inherit mechanical-parser pathologies.
- Harder variant worth testing: `2012.2009.1080p.BluRay.x264.mkv` — is `2012` the title and `2009` the year, or is `2012` the year? Only world knowledge (Emmerich's *2012* released 2009) resolves it. Related to the already-solved `2012` case but adds a competing year token.

**B2. Title that is a bare ordinal/number phrase**
- Pattern: `Movies/A Christmas No. 1 (2021)/A Christmas No. 1 (2021).mkv` → matched as `10 Hours for Christmas` (Portuguese `10 Horas para o Natal`); `Movies/50-50 (2011)/50-50 (2011).mp4` → matched as `ZRok: 50 godina`
- Sourced: https://github.com/jellyfin/jellyfin/issues/15525
- Note also `50-50` vs the canonical TMDB title `50/50` — the filesystem cannot contain `/`, so the **title is corrupted by filesystem constraints**. This is a distinct and important sub-mechanism (see B3).
- **Verdict: SOLVABLE** — `50/50 (2011)` is inferable from `50-50 (2011)` by any human; runtime 100 min would confirm.

**B3. Title corrupted by filesystem-illegal characters (NEW sub-mechanism, my synthesis + sourced example)**
- Characters that cannot appear in a path on Windows/most NAS shares: `/ \ : * ? " < > |`. Any title containing them is *necessarily* mangled on disk.
- Real affected titles: `50/50` (2011) → `50-50`, `Face/Off` (1997) → `Face-Off` or `FaceOff`, `M*A*S*H` → `MASH` or `M.A.S.H`, `Mission: Impossible` → `Mission Impossible`, `8: The Mormon Proposition`, `Se7en` (stylised, not illegal, but a spelling trap), `WALL·E` (interpunct) → `WALL-E` / `WALL E` / `WALLE`.
- Sourced datapoint: `Movies/WALL-E (2008)/WALL-E (2008).mp4` was matched to `Walls Have Ears` (Polish `Ściany mają uszy`). Source: https://github.com/jellyfin/jellyfin/issues/15525
- Failure mechanism: title corrupted — but corrupted **deterministically and reversibly** by a known substitution set.
- **Verdict: SOLVABLE.** Very high-value test case class because the corruption is systematic, unavoidable (not user error), and requires exactly the kind of fuzzy-title world knowledge an LLM has and a regex doesn't.

**B4. Non-ASCII / typographic characters in title (M8)**
- Pattern: `Movies/8½ (1963)/8½ (1963).mkv` → identified as `Interpol Code 8` (`国際秘密警察 指令第８号`)
- Sourced: https://github.com/jellyfin/jellyfin/issues/15525 — the reporter notes that a *manual* search for `8½` + `1963` returns the correct film first, so the information was present; the automatic pipeline destroyed it.
- Also sourced, less specific: a Jellyfin user reports German umlauts / `ß` in filenames caused files to not be recognised at all. Source: https://www.reddit.com/r/jellyfin/comments/1smowlk/movies_are_not_being_recognized_by_jellyfin/
- Related known-solved case: `π`.
- **Verdict: SOLVABLE.**

### Group C — Short / common-word titles that are substrings of other titles (M5)

**C1. The substring-swallow**
- Sourced examples, all real user reports where the *correct* filename still produced a wrong match:
  - `Burning (2018)` → matched `Burning Sands`
  - `Mother (2009)` → matched `Mother and Child`
  - `Super (2010)` → matched `Super 8`
  - `Fino a prova contraria (1999)` → matched `L'angolo rosso - Colpevole fino a prova contraria (1997)`
  - `The Rescue` → matched `Paw Patrol` (presumably *PAW Patrol: The Movie* or a *Rescue* variant)
  - `The Dark Knight` → matched a Korean film (reporter's phrasing: "Korean brokeback mountain")
  - Sources: https://www.reddit.com/r/jellyfin/comments/jiojzk/is_there_a_way_to_fix_jellyfin_pulling_metadata/ and https://github.com/jellyfin/jellyfin/issues/15525
- Failure mechanism: title ambiguous — the title string is a legitimate prefix/substring of many works, and popularity ranking in the search index does not favour the user's film.
- Where the real signal lives: **the year** (all these cases had a year in the filename and the scraper ignored it), plus runtime as a third check.
- Minimum human evidence: title + year. Title alone genuinely underdetermines `Mother` (2009 Bong Joon-ho) vs `Mother` (2017 Aronofsky, actually `mother!`) vs `Mother` (many others).
- **Verdict: SOLVABLE with year; AMBIGUOUS-BY-DESIGN without year.** This is a strong candidate for a graded evidence-ablation test: give the agent `Mother.mkv` with no year and no runtime → should refuse or ask; give `Mother.2009.mkv` → should get Bong Joon-ho; give `Mother.mkv` + duration 129 min → should be able to narrow.
- **This is arguably the single most valuable mechanism found so far**, because it is the case where the *user did everything right* and identification still fails, and where the two-evidence bar is exactly the right tool.

### Group D — Same title, different year (M6) / same title AND year (M7)

**D1. Remake / franchise year collision**
- Pattern: two sibling directories `Movies/The Amityville Horror (1979)/` and `Movies/The Amityville Horror (2005)/`, each containing a same-named file. Sourced: both got matched to the 1979 film. Reporter adds that the same happened across `Nightmare on Elm Street`, `Friday the 13th`, `Halloween`. Source: https://github.com/jellyfin/jellyfin/issues/15525
- Also `The Thing (1982)` vs `The Thing (2011)`. Source: https://www.positioniseverything.net/how-to-fix-plex-showing-the-wrong-movie-or-tv-show/
- Failure mechanism: title ambiguous; resolvable by year.
- Extra wrinkle specific to horror franchises: `Halloween (2018)` is *both* a sequel and a title-reuse of `Halloween (1978)`, and `Halloween` (2007 Rob Zombie remake) exists too — three works, one title, and TMDB disambiguates only by year. Runtime is a weak discriminator (all ~91–106 min).
- **Verdict: SOLVABLE with year. IMPOSSIBLE from title+runtime alone** for tight franchises — runtimes cluster too closely. Good probe for whether the agent *knows* when runtime is a useless second evidence line.

**D2. Same title, same year, different works (M7)**
- Sourced: a Plex forum thread exists specifically for this: "What About: Movies with same title AND same release year but completely different movies?" The community answer is unanimous — *only* an explicit imdb/tmdb ID in the filename can resolve it. Source: https://forums.plex.tv/t/what-about-movies-with-same-title-and-same-release-year-but-completely-different-movies/796641
- Corroborating: "The same problem is with Movies/Shows named exactly the same AND released in the same year. This is very rare... The only way to address this is to use force matching through the ID." Source: https://www.reddit.com/r/PleX/comments/1d1l1uk/the_problem_is_not_my_naming_convention/
- Failure mechanism: title ambiguous *and* the disambiguating dimension (year) is degenerate.
- Where the real signal lives: **runtime and embedded subtitle languages become the only discriminators.** If work A is a 95-min US indie and work B is a 78-min Spanish doc, runtime + a `spa` subtitle track resolves it.
- **Verdict: BORDERLINE — SOLVABLE only if runtime/language differ materially.** This is the most interesting place to test whether the agent correctly falls back from year to runtime+language, and correctly refuses when those also collide.
- _My inference, needs a concrete example pair:_ I have not yet found a named same-title-same-year pair. Logged in Open questions.

### Group E — Title absent from filename, present only in ancestor dir (M1)

Already in the known-solvable baseline (`2026.2160p.iT.WEB-DL...mkv`). One sourced escalation worth noting: multiple Jellyfin threads confirm the *scanner* falls back to using the raw filename as the title when the metadata search fails, producing library entries literally named after the release string. Sources: https://www.reddit.com/r/jellyfin/comments/1owwciq/file_name_is_used_as_title_instead_of_movie_name/ — this is the observable signature of total identification failure in these tools, useful as a comparison baseline.

### Group F — Episode-numbering / ordering ambiguity (M9)

This whole group is a **different kind of problem from movie identification**, and it deserves flagging as such: identifying *the series* is usually easy, but identifying *which episode* is where the impossibility lives. If subtitle-scout's job includes episode-level identification (it must, since it fetches subtitles), this is the highest-density source of genuinely-hard cases found so far.

**F1. Bare episode number: absolute or seasonal? (the `102` problem)**
- Pattern: `[SubGroup] Some Anime - 102 [1080p].mkv`
- Sourced, and stated flatly by the Sonarr team: "Because Sonarr has no reliable way to determine the difference between 102 being S01E02 or absolute 102 given that filename, so it goes with the original implementation, which is treating it like its S01E02". Source: https://forums.sonarr.tv/t/anime-absolute-numbering-issue/4186
- Failure mechanism: **structure ambiguous** — the number is genuinely two-valued.
- Where the real signal lives: **outside the filename.** Resolvers: (a) the series' known season structure — if the show only ever had 1 season of 26 eps, `102` cannot be S01E02-as-3-digits and must be absolute... except the show doesn't have 102 episodes either, so it *is* S01E02; (b) sibling files in the same directory — if the folder also contains `101`, `103`... `126` and nothing above, it's absolute-within-season-1; if it contains `102, 103, ..., 112, 201, 202`, it's SxxEyy packed; (c) TMDB/TVDB season table cross-check (subtitle-scout already has this as its "season table" second evidence).
- Minimum human evidence: **the sibling file listing** plus the TMDB season table. A human looking at *one file in isolation* also cannot resolve this.
- **Verdict: SOLVABLE — but ONLY with directory-sibling context.** This is a critical finding: it identifies an **evidence dimension that subtitle-scout's stated raw-evidence set does not include**. The listed evidence is "directory names in its path, the file name, the duration, embedded subtitle languages, parsed season/episode hints" — *sibling filenames in the same directory* are absent. For episode-numbering ambiguity, siblings are frequently the *only* disambiguator. Strongly recommend adding it as a testable evidence dimension.

**F2. Absolute numbering that resets per season (AniDB) vs continuous (TVDB) vs scene**
- Sourced: "AniDB resets the absolute numbering between each season because it considers each season its own show." The XEM moderation guide gives the concrete disambiguator — release-group *aliases*: `[Release group] Ansatsu Kyoushitsu - 01 (1080p)` maps to S01E01 while `[Release group] Ansatsu Kyoushitsu S2 - 01 (1080p)` maps to S02E01. Source: https://wiki.servarr.com/sonarr/xem-guide
- So for `Ansatsu Kyoushitsu - 01`, `01` is S01E01; for the second-season release, `01` is S02E01. **Identical episode-number token, different meaning, disambiguated only by an `S2` marker that may or may not be present.**
- Failure mechanism: structure ambiguous, with the ambiguity arising from a *disagreement between metadata authorities* rather than from bad naming.
- Note the ecosystem-level admission of defeat: an entire third-party database (TheXEM, thexem.de) exists purely to hold hand-curated mappings between TVDB / AniDB / scene numbering. Confirmed by multiple sources including Sonarr's own FAQ links.
- **Verdict: SOLVABLE only when a season marker exists in the path. Otherwise IMPOSSIBLE without external mapping data.** If a file is `[Group] Ansatsu Kyoushitsu - 01.mkv` and the directory gives no season, and the show has an S1 E01 and an S2 E01, no evidence in the path resolves it. Duration will not help (both ~24 min). Embedded subtitle language will not help. **This is a genuine IMPOSSIBLE case that is NOT the user's fault and NOT a "no information" case** — it's the "information is present but two-valued" case. Distinct from Group J (zero information). I'd call this mechanism **M12 — irreducibly two-valued structure**.

**F3. Long-running anime where absolute numbering exceeds any plausible season/episode reading**
- Pattern: `[Erai-raws] One Piece - 1085 [1080p].mkv`
- My reasoning, not sourced: `1085` cannot be parsed as SxxEyy in any sane way, so it is unambiguously absolute. The disambiguation is easy *precisely because* the number is large.
- **Verdict: SOLVABLE.** Useful as the *easy* pole of an F1/F3 pair — same shape, opposite difficulty, and the difference is purely magnitude. Good probe for whether the agent reasons about magnitude or just pattern-matches.

**F4. Specials / season 0 with no absolute number**
- Sourced: users report Sonarr simply cannot handle anime specials; "Episode does not have an absolute episode number" is the failure, and the accepted resolution in the thread was literally *give up on automation*: "sonarr does not work with anime specials really well. the best it to grab them yourself. and then manual import them." Sources: https://www.reddit.com/r/sonarr/comments/l9rsdz/sonar_anime_episode_does_not_have_an_absolute/ and https://www.reddit.com/r/sonarr/comments/fmlm0z/episode_does_not_have_an_absolute_episode_number/
- Additional sourced complication: TVDB *reclassifies* items between specials and main-season over time (they made a decision to remove movies from specials), which retroactively invalidates any numbering-based mapping. Source: https://github.com/Sonarr/Sonarr/issues/6547 — the reporter: "multiple shows suddenly getting reordered every few weeks. Anecdotally, I have never seen this behavior work in a way that makes sense, it is incorrect every single time."
- Pattern examples: `Anime/Specials/[Group] Show - OVA.mkv`, `Show/Season 00/Show - S00E03 - Recap.mkv`, `[Group] Show - SP01.mkv`, `[Group] Show - 13.5.mkv` (the `.5` episode convention — recap/interlude episodes)
- Failure mechanism: structure ambiguous + the authoritative structure is *unstable over time*.
- Where the signal lives: the word `OVA` / `SP` / `Special` / `NCOP` / `NCED` / `PV` / `Recap` in the filename, and `Season 00` / `Specials` in the parent dir. These are strong signals — a human reads them instantly.
- **Verdict: SOLVABLE at the "this is a special, not a main-season episode" level. Often IMPOSSIBLE at the "which special" level**, because specials frequently have no number at all and TMDB/TVDB special ordering is arbitrary and unstable.
- The `13.5` convention is a nice sharp test: `[Group] Show - 13.5.mkv` — mechanically this parses as episode 13, or as a decimal, or as a version marker; only genre knowledge tells you it's an interlude episode.

**F5. Number-word in the title colliding with season parsing**
- Sourced, with a real filename: `[EMBER] Re-Zero kara Hajimeru Isekai Seikatsu S2E21 [Episode-46] [1080p] [HEVC WEBRip] (Re-Zero - Starting Life in Another World)` — Sonarr read `Zero` in the title as season 0 and *rejected the import* with "Season number 0 was unexpected considering the folder name". Source: https://github.com/Sonarr/Sonarr/issues/4355
- Note this filename is a beautiful natural test artifact: it contains **three competing episode identifiers** — `S2E21`, `Episode-46` (absolute), and a title containing a number-word — plus a parenthesised English alias of the romaji title. All the information needed is there; only the mechanical parser fails.
- Failure mechanism: title/structure interference.
- **Verdict: SOLVABLE.** High-value case: an LLM should read this correctly and effortlessly, and it's a real filename from a real release group. Recommended test case.

**F6. Both seasonal and absolute keys present, in either order**
- Sourced, real filenames from Kaleido-subs: `[Kaleido-subs] Blue Archive the Animation - 06 (S01E06) - (WEB 1080p HEVC x265 10-bit E-AC3 2.0) [4F14C2AE]` vs `[Kaleido-subs] Blue Archive the Animation - S01E06 - 06 - (...)`. Sonarr uses whichever appears *first*, giving different results for semantically identical files. Source: https://github.com/Sonarr/Sonarr/issues/7246
- The same issue contains a valuable authority-disagreement example: **Cardcaptor Sakura** — MAL/AniDB consider it 1 season of 70 episodes with the sequel as season 2; TVDB considers it S1–S3 for those 70 episodes and S4 for the sequel. So `Cardcaptor Sakura - S02E01` means completely different episodes depending on which authority you ask.
- **Verdict: F6 filename-order case is SOLVABLE (trivially, for an LLM). The Cardcaptor Sakura authority-disagreement case is IMPOSSIBLE to resolve "correctly" in the abstract** — correctness is authority-relative. Since subtitle-scout verifies against **TMDB**, the right behaviour is to resolve in TMDB's numbering and be explicit about it. Worth testing whether the agent notices that a seasonal number can be authority-dependent. _(Note: TMDB's TV numbering is a third scheme again, distinct from both TVDB and AniDB — I did not verify TMDB's Cardcaptor Sakura layout; logged in Open questions.)_

**F7. Alternate ordering: aired vs DVD vs production vs international**
- Sourced concrete case: **The Repair Shop** — TVDB aired order says S10 has 34 eps and S11 has 20; the BBC (the actual broadcaster) and NZBGeek both say S10 has 14 and S11 has 40. Source: https://github.com/Sonarr/Sonarr/issues/7732
- Sourced concrete case: **Pokémon** — aired order is the official Japanese ordering; DVD order and International order are the American localisation groupings and differ. Source: https://www.reddit.com/r/sonarr/comments/zep2mp/change_series_sort_order_from_aired_to_dvd_order/
- Classic additional cases named by users: **Agatha Christie's Poirot** (same thread), and the canonical example not found in these sources but well known: **Firefly** (aired order vs intended order).
- Failure mechanism: structure ambiguous — a single `S10E20` token denotes different episodes under different orderings.
- Where the signal lives: **nowhere in the file.** The release group chose an ordering and did not record which.
- **Verdict: IMPOSSIBLE to resolve reliably from path evidence alone; SOLVABLE only probabilistically** (e.g. runtime, or matching the subtitle content, or knowing that a given release group follows a given convention). This is M12 again — irreducibly ambiguous, no user renaming would fix it either, because the user has the same problem. **Important product implication: this is a case that is neither "agent's job" nor "user must rename" — it's "must be resolved by content inspection or explicit user choice."** That's a third category the product's binary framing may not cover.

**F8. Multi-episode files (concatenated)**
- Patterns: `Show - S01E01-E02.mkv`, `Show - 1x01x02.mkv`, `Show.S01E01E02.mkv`, `Show - S01E01-02.mkv`, and the raw case `Show - S01E01.mkv` where the file actually contains two episodes.
- Sourced observation of the underlying real-world cause: XEM mappings routinely need "a single episode on the Scene side ... linked to one or two episodes on the TVDB side", i.e. the scene releases a 48-min file that TVDB counts as two episodes. Source: https://wiki.servarr.com/sonarr/xem-guide
- Also sourced from a user: "if the shows you're talking about are currently airing, you're bound to get 'E01 is actually E01-E02' errors." Source: https://www.reddit.com/r/sonarr/comments/1b2lsvp/aired_vs_dvd_orders_reliably_grabbing_cartoon/
- **Where the signal lives: DURATION.** This is the one place where runtime is a *strong, correct* signal and not a red herring — a 24-min-per-episode anime with a 47-min file is unambiguously a double. This is the positive counterpart to Group G below.
- **Verdict: SOLVABLE via duration.** Strongly recommended test case, because it's the case that *justifies* the runtime evidence dimension. Design: `[Group] Show - 01.mkv`, duration 47:12, TMDB says episodes are ~24 min → correct answer is "this is E01+E02".


### Group G — Duration actively MISLEADS (M10)

This is the group most directly threatening to subtitle-scout's design, because runtime is one of only three second-evidence lines. **Finding: runtime is far less reliable than it appears, and the unreliability is systematic, not occasional.**

**G1. Alternate cuts, and the fact that TMDB usually has only ONE runtime**
- The critical sourced insight, from a Plex user: "The problem is not with Plex, it's that **The Movie Database and IMDB often don't have a separate listing for different cuts** so Plex doesn't understand they are basically two separate movies... Unless the alternate version has a listing in IMDB or TMDB for Plex to match to, it's always going to assume it's the normal version." Source: https://www.reddit.com/r/PleX/comments/9fg0fs/cant_seem_to_have_both_theatrical_cut_and/
- **This is the key structural fact.** TMDB stores one canonical runtime per movie record. If the user's file is an alternate cut, the runtime check will *fail against the correct answer*. A naive "runtime must match within N minutes" rule therefore produces **false negatives on correctly-identified films**, which is worse than a false positive because it pushes a solvable file into the "cannot identify / user must rename" bucket — precisely the error the product must not make.
- Sourced magnitudes of the runtime delta (from a r/movies thread enumerating theatrical→extended differences). These are large enough to break any tolerance window:
  - *Until the End of the World*: 158 min (US theatrical) / 179 (European) / **287 min** (director's cut) — a 129-min delta
  - *Once Upon a Time in America*: 139 → 229 → 251 min
  - *Heaven's Gate*: 149 → 216 min (Criterion restoration)
  - *Das Boot*: 149 → 208 min director's cut → ~293 min miniseries version (a 59-min and then a ~145-min delta)
  - *Apocalypse Now*: 147 → 202 min (Redux)
  - *Watchmen*: 162 → 215 min
  - *Kingdom of Heaven*: 144 → 193 min
  - *Alexander*: 175 → 214 min (Final Cut)
  - *Troy*: 163 → 196 min
  - *The Hateful Eight*: 168 → 188 min
  - *Léon / The Professional*: ~90 → ~133 min
  - *Greed* (1924): 143 min theatrical vs a 239-min reconstruction
  - Sources: https://www.reddit.com/r/movies/comments/1451ofl/what_are_some_films_with_the_largest_runtime/ and https://collider.com/movie-directors-cuts-much-longer-than-theatrical/
- **Verdict on the *file*: SOLVABLE** (the title is present). **Verdict on the *runtime check*: the runtime check is unsound as a hard gate.** Recommended experiment design: `Das.Boot.1981.Directors.Cut.1080p.BluRay.mkv` with duration 208 min against a TMDB record showing 149 min. The correct agent behaviour is to identify Das Boot (1981) *and explain that the runtime mismatch is attributable to the labelled director's cut* — i.e. use the filename's own edition tag to excuse the runtime deviation. An agent that refuses because runtime doesn't match has failed. This is one of the most valuable test cases in this document.

**G2. Runtime is contaminated even for the *same* cut**
- Sourced: "runtime can be messed with based on source media (eg, **criterion collection always adds a 2 second banner**)". Source: https://www.reddit.com/r/PleX/comments/1jfpfk8/finding_what_movies_i_have_are_theatrical_or/
- Sourced: "if the duration is not greatly different then **including or omitting the credits** can complicate matters." Source: https://www.reddit.com/r/PleX/comments/10jsf78/how_do_you_keep_track_of_movie_versions_extended/
- My synthesis of additional systematic contaminants (not individually sourced, but well-established in the encoding community — flagging as **inference**):
  - **PAL speedup**: film shot at 24 fps transferred to 25 fps PAL runs **4% shorter**. A 120-min film becomes ~115 min. This is a systematic ~4% bias affecting a huge fraction of European DVD-sourced rips. A 4% window is large relative to the ~2–5 min tolerance one would naively pick.
  - **NTSC 3:2 pulldown / 23.976 vs 24 fps**: a 0.1% difference — negligible, mentioned only for completeness.
  - Distributor logos, MPAA cards, and fansub-group opening credits padding the head of the file.
  - Rips that **cut the credits** to save space (common in older, size-constrained releases) — biases the *other* direction.
  - TV rips including or excluding commercial breaks: a "22-min" US sitcom episode file may be 22 min (broadcast-cut) or 30 min (with ads) — a **36% difference on the same episode**.
- **Verdict: runtime supports a tolerance of roughly ±5% plus a possible large one-sided excess, not a tight window.** Concretely I'd say: runtime agreement is meaningful *positive* evidence; runtime *disagreement* is weak negative evidence and must never alone defeat a strong title match. Worth testing explicitly.

**G3. Double-length premieres / finales**
- My reasoning + partial sourcing. The F8 finding (a single scene file mapping to two TVDB episodes) is the sourced mechanism. The specific "double-length premiere" case is its cousin: TMDB lists S01E01 and S01E02 as separate ~43-min records, but the show *aired* as one 86-min pilot and the file reflects that.
- **The trap is that G3 and F8 are indistinguishable from a runtime-only view, and both are indistinguishable from "this is a movie, not an episode".** A 86-min file in a TV directory could be: a double episode, a feature-length pilot that TMDB records as one 86-min episode, or a TV movie.
- **Verdict: SOLVABLE only with the sibling listing + the TMDB season table.** Reinforces the F1 conclusion that sibling filenames are a necessary evidence dimension.

**G4. Runtime coincidence pointing at the wrong work**
- My reasoning, unsourced: the space of feature runtimes is dense. Between 85 and 130 min there are tens of thousands of films, so a runtime match at ±2 min is worth very few bits of evidence *on its own*. It is only discriminating **conditional on a small candidate set** (e.g. 3 same-titled films). Runtime is therefore a good *tiebreaker* and a bad *identifier*.
- Corollary for the two-evidence bar: "name matches AND runtime matches" is much weaker than it sounds when the name match is fuzzy, because a fuzzy-name candidate pool of 50 films will contain several with the right runtime by chance. **Recommend testing an adversarial case**: a corrupted title whose nearest-neighbour wrong candidate happens to share a runtime with the right answer.

### Group H — Chinese-language / PT-site conventions (M1, M2, M13)

Sourced from Chinese-language media-server guides, which document real PT-site (private tracker) filenames.

**H1. Bilingual folder / English-only file (the "title language split")**
- Real sourced directory structure from a PT download:
  ```
  /Media/TV/
  ├─猎罪图鉴.Under.the.Skin.S01.2022.2160p.WEB-DL.H265.60fps.DDP5.1-HHWEB/
  │   Under.the.Skin.S01E01.2022.2160p.WEB-DL.H265.60fps.DDP5.1-HHWEB.mkv
  │   ...
  ├─Under.the.Skin.S02.2022.COMPLET.4K.WEB-DL.DDP5.1.HEVC-NGB/
  │   Under.the.Skin.S01E15.2022.4K.WEB-DL.DDP5.1.HEVC-NGB.mkv
  ```
  Source: https://blog.myhs.cc/archives/1735472836515
- Three distinct problems visible in this one real example:
  1. **The Chinese title exists only in the grandparent directory**; the file itself carries only the English/romanised title. So the Chinese title (`猎罪图鉴`) is only recoverable from an ancestor. Same mechanism as the known-solved case, but here it's *bilingual redundancy*, which is actually helpful.
  2. **The second directory has NO Chinese title at all** — English only.
  3. **The season number in the file contradicts the season number in the directory**: the folder says `S02`, the file says `S01E15`. This is a real, sourced, in-the-wild contradiction. A release group packaged season 2 with filenames still saying S01. **Which do you trust?**
- Failure mechanism for #3: **M13 — internally contradictory evidence.** This is a mechanism not in my earlier list and not in the prompt's list. The path contains two authoritative-looking claims that disagree.
- Where the signal lives: both places, in conflict. Resolution requires the TMDB season table (does S1 even have 15 episodes? if S1 has 20 and S2 has 28, `S01E15` is internally plausible and the conflict is real) plus the sibling listing (if the folder contains `S01E15`–`S01E28` and S1 only had 20 episodes, the folder's `S02` is right and the files are misnumbered).
- **Verdict: SOLVABLE, but only with sibling listing + season table.** Excellent test case — it's real, it's sourced, and it forces the agent to *adjudicate between conflicting evidence* rather than just extract evidence. Recommended.

**H2. Bracket-only filenames — the total-erasure case**
- Sourced, and this is an important *hard rule* in the Plex scanner: "文件夹和文件名中若存在中括号，中括号内的部分会被 Plex 忽略。例如，若文件夹或文件名中包含 [01]，这个 01 是无法被识别的，**如果一个文件夹或文件名所有的内容都被放在了中括号内，那么 Plex 将会忽略这个项目**，这个文件夹或文件将无法入库。很多动漫资源的命名都存在这个问题" — i.e. Plex ignores bracketed content, and **if the entire name is bracketed the item is skipped entirely**; the source notes this afflicts a great many anime releases. Source: https://zhuanlan.zhihu.com/p/613453094
- Pattern: `[诸神字幕组][莉可丽丝][01][1080p][简繁内封].mp4` — this is the known-solved fansub-bracket case, but the sourced detail explains *why* it's catastrophic for mechanical scrapers: the convention of putting everything in brackets collides with the convention of treating brackets as ignorable metadata. The information density is high; the parser's prior is that brackets are noise.
- **Verdict: SOLVABLE** (already verified in baseline). Worth noting the mechanism explanation for the writeup.

**H3. Chinese season markers not in SxxExx form**
- Sourced: MoviePilot users maintain regex preprocessing rules specifically to convert Chinese season notation to standard form — "通过正则表达式对种子名/文件名进行'预处理'，将不规范的命名（如中文的'第x季'）强制转换为标准格式（SxEx），彻底解决刮削匹配失败的问题" ("...to definitively solve scraping match failure"). Source: https://hi.keba.host/archives/MOVIEPILOT-Rules
- Patterns: `第二季`, `第2季`, `第二部`, `第10集`, `全20集`, `上部`/`下部`, `番外篇`, and for Japanese releases `第2期`, `2nd Season`, `Season 2` written in kanji.
- Example realistic path: `国产剧/庆余年 第二季/庆余年.第二季.第01集.4K.HDR.mp4`
- Failure mechanism: title/structure present but in a locale-specific encoding the parser doesn't know.
- **Verdict: SOLVABLE, trivially, for an LLM.** Good control case demonstrating agent > regex. Note that `上部`/`下部` (part 1/part 2) for a single film is a *different* case — see H5.
- Additional wrinkle worth testing: `第2期` in Japanese anime means "season 2", but `2期` can also be written where the actual TMDB season number differs (because TMDB may fold a split-cour season into one season while the Japanese broadcast calls the second cour "2期"). This is the **split-cour problem** — genuinely ambiguous. _(Inference; not directly sourced.)_

**H4. TMDB vs IMDB special-episode numbering divergence (Chinese-source confirmation of F4)**
- Sourced and precise: "TMDB数据源将所有特别篇的一整季视为第零季，这点和IMDB数据源有所不同，IMDB数据源有时候会将特别篇作为某一季的最后一集顺延+1编号，例如夏目友人帐的OVA特别篇" — TMDB puts all specials in season 0; IMDB sometimes appends a special as the next episode of a season, +1. Named example: **夏目友人帳 (Natsume Yūjin-chō) OVA specials**. The author's conclusion: "因此针对SP、OVA、OAD这类特别篇就没有一个泛用性的规则可言，只能根据番剧去TMDB网站查询数据确定具体剧集" — there is *no general rule* for SP/OVA/OAD; you must look each one up on TMDB individually. Source: https://zhuanlan.zhihu.com/p/1982529192244572959
- This independently corroborates F4 from a completely different ecosystem (Chinese fnOS/Emby users vs English Sonarr users), which raises my confidence that **specials are a genuine hard boundary, not a tooling artifact.**
- **Verdict: "which special is this" is IMPOSSIBLE from path evidence alone in the general case.** Strong candidate for the refusal set.

**H5. Collection directories mixing multiple films (multi-work directory)**
- Sourced real example of the anti-pattern:
  ```
  /电影
     /灰影人 (2022)
        The Gray Man (2022).mp4
     /饥饿游戏系列                 ← "The Hunger Games series" — a franchise folder
        /饥饿游戏1
           The.Hunger.Games.2012.mkv
        /饥饿游戏2:星火燎原
        /饥饿游戏3:嘲笑鸟(上)
        /饥饿游戏4:嘲笑鸟(下)
        青春年少 (1998).mkv        ← an UNRELATED film loose in the franchise folder
  ```
  Source: https://zhuanlan.zhihu.com/p/613453094
- Two distinct problems, both sourced in this one tree:
  1. **Franchise-level intermediate directory** (`饥饿游戏系列`) — the parent dir names the *franchise*, not the work. If the file were bare, inheriting the parent's title would give you the wrong film (the franchise, not entry 3). And note `嘲笑鸟(上)` / `(下)` = Mockingjay Part 1 / Part 2 — the `(上)`/`(下)` convention distinguishes them, and dropping it makes them indistinguishable.
  2. **`青春年少 (1998).mkv` sitting loose inside the franchise folder** — an unrelated film (Wes Anderson's *Rushmore*) in the Hunger Games directory. **This breaks parent-directory inheritance completely**: the strategy "if the filename lacks a title, use the parent directory" would misidentify it. Here the filename happens to carry its own title so it's fine, but the general lesson is that **parent-directory evidence can be actively wrong, not merely absent.**
- Failure mechanism: **M14 — misleading ancestor directory.** The path contains a plausible-looking title that belongs to a *different* work. This is more dangerous than M1 (title absent) because it supplies a confident wrong answer.
- **Verdict: This is the sharpest test of evidence discipline in the whole document.** Design: `/电影/饥饿游戏系列/output.mkv`, duration 137 min. The parent dir says "Hunger Games series". Does the agent claim *The Hunger Games* (2012, 142 min) — plausible! — or does it correctly note that "series" is a franchise container and it cannot tell which entry, or whether it's even a Hunger Games film at all? **Correct answer: refuse, or at most report low-confidence franchise-level identification.** Highly recommended test case.

**H6. The `.5` / part-split / CD1-CD2 family**
- Chinese conventions: `上`/`下`, `上部`/`下部`, `CD1`/`CD2`, `A/B`, `part1`/`part2`, `1of2`/`2of2`.
- Sourced advice from Plex community for the Western equivalent: "the parts need to be named in a way Plex understands. Use the same movie name and year, followed by part labels such as cd1 and cd2". Source: https://www.positioniseverything.net/how-to-fix-plex-showing-the-wrong-movie-or-tv-show/
- **The runtime interaction is the interesting part**: `某电影.2003.CD1.avi` has a duration of ~60 min for a 120-min film. **A runtime check on a split file will fail against the correct answer**, exactly as in G1 but for a different reason. And it's ambiguous with "this is a TV episode" (60 min) and with "this is a different, shorter film".
- Where the signal lives: the `CD1` token, and the sibling `CD2` file.
- **Verdict: SOLVABLE, requires the CD1 token to be recognised as a part-marker AND ideally the sibling. IMPOSSIBLE if the marker is absent** (e.g. `movie_a.avi` / `movie_b.avi`, or the genuinely bad `1.avi` / `2.avi`). Recommended test case: supply `CD1` and duration 61 min against a TMDB record of 122 min — correct behaviour is to identify the film and note the runtime is ~half because it's part 1 of 2. This is a second, independent probe of the same "don't let runtime veto a good title match" lesson as G1.

### Group I — Regional / alternate / original-language titles (M15)

**I1. The release is named in the original language; TMDB's primary title is English (or vice versa)**
- Sourced, with an excellent worked example: a bug report against AIOStreams describes exactly this. For **Muhteşem Yüzyıl** (English title *The Magnificent Century*, IMDb tt1848220, original language Turkish), releases are named only in Turkish, so searching by the English title returns nothing. Source: https://github.com/Viren070/AIOStreams/issues/1030
- The same issue documents **three separate normalisation failures** stacked on top of each other, which is a superb specification of the real difficulty:
  1. TMDB exposes the original title as `original_name` for TV but `original_title` for movies — code reading only one field silently gets the English fallback.
  2. A German-oriented umlaut map (`ü`→`ue`) applied globally turns Turkish `Yüzyıl` into `Yuezyil`, but actual releases use `Yuzyil` (`ü`→`u`).
  3. Turkish dotless `ı` (U+0131) is a base letter that NFD does not decompose, so even after fixing #2 you get `yuzyıl`, not `yuzyil`.
  - Net: `Muhteşem Yüzyıl` → must normalise to `muhtesem yuzyil` to match real releases.
- Failure mechanism: **M15 — title present but in a different naming authority's language/romanisation than the target database's primary key.**
- Where the signal lives: the filename, in a form that requires *language-aware* transliteration rather than generic ASCII-folding.
- **Verdict: SOLVABLE, and this is a category where an LLM has a genuine structural advantage** over any normalisation pipeline, because it knows that `Muhtesem Yuzyil` is *The Magnificent Century* without needing a transliteration table. Strongly recommended test case class. Concrete candidates:
  - `Muhtesem.Yuzyil.S01E15.1080p.WEB-DL.mkv` → *Muhteşem Yüzyıl* / *The Magnificent Century*
  - Romanised Japanese: `Sen.to.Chihiro.no.Kamikakushi.2001.mkv` → *Spirited Away* (TMDB English title)
  - Romanised Korean: `Gisaengchung.2019.1080p.mkv` → *Parasite*
  - Romanised Chinese (pinyin, no tones, no spaces): `wolianglegehaorenxiaohuolang.mkv` — pinyin run together is a real convention and *much* harder
  - Cantonese romanisation: the Kodi thread above surfaces `Cheung foh` as the IMDb "original title" for the film whose TMDB original title is `鎗火` (*The Mission*, 1999) — so **three** competing title forms for one film: Chinese characters, Cantonese romanisation, English release title. Source: https://forum.kodi.tv/showthread.php?tid=370862

**I2. TMDB's own title data is inconsistent / the "original title" is not what you think**
- Sourced and important for calibrating expectations of the verification step: TMDB staff state plainly, "**The only exact title matching we do is with the original title.** Beyond that Solr is simply trying its best to match. However, more closely matched alternative and translated titles boost the score." Source: https://www.themoviedb.org/talk/52602185760ee33385213c0d
- Sourced: TMDB's alternative-titles field is *policy-restricted* — "The alternative title section should only be used for titles that are different from the original and translated titles. It should not be used to list all the different translations." A Radarr user managing 900+ foreign films complains that this makes TMDB an unreliable source of regional AKAs and that IMDb is better. Source: https://www.reddit.com/r/radarr/comments/oqv0r5/alternative_titles_and_tmdb/
- Sourced TMDB API quirk: when a film's original language is X and no translation to X exists, the API returns the correct `original_title` in X but an **English `title`** — so `title` and `original_title` can be in different languages in ways that depend on translation coverage, not on any stable rule. Source: https://www.themoviedb.org/talk/5c313f1b9251416451708548
- Sourced clarification of the general rule: "`title` is only used if different from `original title`." Source: same thread.
- **Implication for subtitle-scout's "name must match" evidence line: "the name" is not a single value.** For a foreign work there are at minimum: original-language title, romanisation(s), TMDB English `title`, TMDB `original_title`, TMDB alternative titles (incomplete by policy), and per-country release titles. A name-match check must query across this set, and **the two-evidence bar should count "matches any recognised title variant" as a name match, not "matches the primary title".**
- **Verdict: this is a design finding rather than a case.** Worth an explicit test: a file named with a regional AKA that is *not* in TMDB's alternative-titles list. That is genuinely **IMPOSSIBLE via TMDB lookup alone** even though an LLM might know the AKA from pretraining — an interesting split between "the agent knows" and "the agent can verify". Flagging as an important subtlety for the experiment: **the agent may correctly identify a work it cannot verify under the two-evidence bar.**

**I3. Film sharing a title with the TV series it spun off / spun from**
- My synthesis; I did not find a dedicated sourced thread for this exact framing, but the ingredients are sourced (the same-name trap, and the Plex note that "Years are only necessary for shows if you have multiple shows with the same name, e.g. Doctor Who, which currently has three different programs" — source: https://www.reddit.com/r/PleX/comments/1ei4rw9/plex_fixed_the_fix_match_option_after_telling_me/).
- Concrete real examples (my knowledge, unsourced in this research):
  - *Fargo* — 1996 Coen film vs 2014– FX series
  - *M\*A\*S\*H* — 1970 film vs 1972 series (plus the filesystem-illegal `*` from B3, stacking two mechanisms)
  - *Buffy the Vampire Slayer* — 1992 film vs 1997 series
  - *Westworld* — 1973 film vs 2016 series
  - *Friday Night Lights* — 2004 film vs 2006 series
  - *The Rig* (2010 film vs 2023 series) — already in the known-solved baseline
- Where the signal lives: **the presence or absence of an SxxEyy token, and the duration.** A 43-min file is an episode; a 98-min file is the film. Directory depth also helps (`Fargo/Season 01/` vs `Fargo (1996)/`).
- **Verdict: SOLVABLE — this is the case where duration is genuinely load-bearing and correct.** The film/series distinction is one of the few places where a runtime check does real work. Recommended as the positive control for the runtime evidence dimension, paired against G1 as the negative control.
- Sharp variant: `Fargo.mkv` with duration 51 min. Now runtime is *between* typical episode and typical film lengths, and there's no season marker. Correct answer: cannot determine; ask or refuse.

### Group J — Genuinely no information (M11)

The key sourced observation is that **the media-server ecosystem has explicitly given up on identifying these**, and provides dedicated non-identifying library types for them. That is strong external corroboration of an "impossible" verdict.

**J1. Home videos — the ecosystem's own admission of impossibility**
- Sourced: Jellyfin's answer to "Where to put home videos?" is to use a library type that **does not attempt metadata lookup at all**. A community moderator: "The Movies library type assumes actual movies. It is trying to do a metadata lookup and, obviously, not finding a match. Try the mixed library type or music videos library type." Another: "actually the correct content type is 'Photos' for this use". Source: https://forum.jellyfin.org/t-where-to-put-home-videos
- Sourced: Jellyfin has a library type literally named **"Home Movies and Photos"**, and there is an open bug that it *still tries to identify* the media — the reporter's framing is instructive: "Home Movies and Photos **still tries to identify media that should be unidentifyable**." Source: https://github.com/jellyfin/jellyfin/issues/15978
- Sourced: Plex's equivalent is the "Personal Media" metadata agent, and the docs say explicitly: "**The media can be named any way you like. The name of the file is what will appear in the Plex App.**" i.e. no identification is attempted; the filename *is* the identity. Example from the Plex docs:
  ```
  /Home Videos
     Picnic in the Park.m4v
     Playing with the dog.mkv
     Visiting our friends.mov
  ```
  Source: https://support.plex.tv/articles/200265246-personal-media-movies/
- Sourced real user examples of home-video filenames that broke a Movies library: `Christmas 2010`, `Jack's Diary`. The user's own framing is exactly the boundary this research is about: "I'm guessing that Jellyfin wants all titles in the form 'Title (date)', **but these are not commercial films.**" Source: https://forum.jellyfin.org/t-where-to-put-home-videos
- **Verdict: IMPOSSIBLE, and importantly impossible for a reason different from all other cases: the work does not exist in TMDB at all.** There is no correct answer to find. This is a distinct failure mode — **not "insufficient evidence to choose among candidates" but "the correct answer is not in the candidate space."**
- **This distinction matters enormously for the product.** Telling a user "rename this file" is *wrong advice* for a home video — no rename will make it identifiable, because it isn't a catalogued work. The honest output is "this does not appear to be a commercial release." **Recommend the experiment include home-video cases specifically to test whether the agent distinguishes "I can't tell which work this is" from "this isn't a catalogued work at all."** I'd argue that distinction is the single most product-relevant finding in this document.

**J2. Camera-generated filenames**
- Patterns (from the prompt, and standard across devices — my knowledge, well-established):
  - `IMG_1234.MOV`, `IMG_1234.mp4` — iOS
  - `DSC00123.MP4`, `DSCN0123.MOV` — Sony / Nikon
  - `MVI_4567.MOV` — Canon
  - `100_0123.MP4`, `PXL_20240115_143022.mp4` — Google Pixel
  - `VID_20240115_143022.mp4` — generic Android
  - `GOPR0123.MP4`, `GX010123.MP4` — GoPro
  - `C0001.MP4` — Sony XAVC
  - `20240115_143022.mp4`
  - `MAH00123.MP4` — Panasonic
- Where the signal lives: **the embedded timestamp in some of them** (`PXL_20240115_143022`, `VID_20240115_...`) tells you a capture date, which *confirms* it's a personal recording but does not identify a work. Also EXIF/QuickTime metadata (creation date, GPS, camera model) would confirm "camera original", but that's not in subtitle-scout's evidence list.
- **Verdict: IMPOSSIBLE. And these are the *cleanest* impossible cases** because the filename form is a positive, recognisable signature of "camera original", not merely an absence of information. **This is a valuable asymmetry: the agent can be *confident* that these are unidentifiable**, rather than merely unable to identify them. Recommend testing that the agent expresses high confidence in its refusal here, versus low confidence / hedging on genuinely ambiguous cases like `Mother.mkv`.

**J3. Degenerate / placeholder filenames**
- Patterns: `1.mp4`, `video.mp4`, `output.mkv`, `Untitled.mp4`, `新建文件夹/output.mkv` ("New Folder/output.mkv"), `未命名.mp4`, `download.mp4`, `final.mp4`, `final_v2_FINAL.mp4`, `test.mkv`, `a.mkv`
- Hash-named: `a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5.mkv`, `[BitTorrent infohash].mp4`, `f7d3c9e2.mp4`
- Transcoder/tool defaults: `output.mkv` (ffmpeg convention), `handbrake_output.m4v`, `Encode_1.mp4`, `Title01.mkv` / `title_t00.mkv` (MakeMKV disc-rip default — **note this one leaks a little information: it tells you the source was an optical disc**), `VTS_01_1.VOB`, `BDMV/STREAM/00001.m2ts`
- **Verdict: IMPOSSIBLE — with one nuance.** `output.mkv` in a *bare* directory is genuinely zero-information. But `Title01.mkv` / `00001.m2ts` tell you "disc rip", and a disc rip of a 142-min film inside a directory named anything at all becomes partially tractable. **The information content of a placeholder filename is not always exactly zero, and the interesting experimental question is whether the agent correctly extracts the residual bits (source type, duration) without over-reaching to a guess.**
- The `新建文件夹/output.mkv` case is the true floor: parent directory carries no information ("New Folder" is the Windows default), filename carries no information, so the *only* evidence is duration + embedded subtitle languages. A 142-min file with a `chi` and an `eng` subtitle track is... some Chinese-subtitled 142-min film. That is thousands of candidates. **IMPOSSIBLE.**

**J4. Characterising the shape of "no information" precisely**
My synthesis. A file is genuinely unidentifiable when *all* of the following hold:
1. **No title token anywhere in the path** — no component of the path contains a string that is, or plausibly corrupts to, a work title. Note the path includes *all* ancestors, so this requires checking up to the library root.
2. **No structural token** — no year, no SxxEyy, no episode number, no franchise/series word.
3. **Duration is non-diagnostic** — i.e. it falls in a dense region of the runtime distribution (roughly 80–130 min for films, 20–25 or 40–50 min for episodes). A duration of, say, 3 min 40 s or 9 h 20 m *is* diagnostic in the weak sense of ruling out most commercial features.
4. **Embedded subtitle/audio languages don't narrow to a small set** — a single `eng` track narrows nothing. An unusual combination (`isl` + `fao`) would narrow a lot.
5. **No sibling context** — the directory contains no other files whose names carry information that could propagate.
6. **(The decisive one) There is no reason to believe the work is catalogued at all.**
- Conditions 1–5 give "insufficient evidence"; condition 6 gives "wrong candidate space". **These should produce different messages to the user.** For 1–5 the honest message is "cannot identify — renaming with title and year would fix this". For 6 it is "this doesn't look like a commercial release — no rename will help."

### Group K — Miscellaneous sourced mechanisms worth recording

**K1. Non-commercial-but-catalogued content**
- Sourced example of the pain: a Jellyfin user serves "recorded Motorsports events and Educational streams" and finds the library "still tries to identify media that shouldn't be identified". Source: https://github.com/jellyfin/jellyfin/issues/15978
- This is a *third* category between "commercial release" and "home video": content that is real, public, dated, and named — e.g. `2024 Monaco Grand Prix - Race.mkv`, `Lex Fridman Podcast #401.mp4`, a conference talk, a YouTube download `Some Video Title [dQw4w9WgXcQ].webm` (note: yt-dlp's default naming **embeds the YouTube ID**, which is a perfect identifier for a work that TMDB does not contain).
- **Verdict: IMPOSSIBLE *via TMDB*, but not unidentifiable in principle.** Again the honest answer is "not a TMDB-catalogued work", not "rename it". Sports and podcasts are large real categories in self-hosted libraries. Worth at least one test case.

**K2. Trailers, samples, and extras masquerading as the main feature**
- My synthesis; standard scene conventions: `Sample/movie-sample.mkv`, `movie.trailer.mp4`, `Featurettes/`, `Extras/`, `Behind The Scenes/`, `-trailer.mkv` / `-featurette.mkv` (Plex/Jellyfin extras suffixes), `movie.CD1.sample.avi`
- Duration is the giveaway: a 47-second or 2-minute file whose name matches a 130-minute film is a trailer or sample, not the film.
- **Verdict: SOLVABLE via duration, and this is a case where a runtime *mismatch* should correctly cause the agent to change its answer** (from "this is the film" to "this is a trailer for the film"). Nicely complementary to G1, where a runtime mismatch should *not* change the answer. **A test pair of G1 and K2 would directly probe whether the agent reasons about *why* runtime differs rather than applying a threshold.** I consider this one of the strongest experiment designs in this document.




## Candidate test cases for the experiment

Shortlist of 16 cases, ordered by research value. Each is designed to probe a specific evidence dimension or boundary.

### Tier 1 — Boundary probes (the most important)

**T1. Das Boot director's cut — runtime mismatch must NOT veto correct title**
- Path: `Movies/Das.Boot.1981.Directors.Cut.1080p.BluRay.mkv`
- Evidence: filename (title + year + edition label), duration 208 min
- TMDB canonical runtime: 149 min (theatrical)
- Expected: identify as *Das Boot* (1981), note runtime matches director's cut (~208 min), not theatrical
- What it tests: M10a — agent must reason about *why* runtime differs, not apply a threshold
- Failure mode to catch: agent refuses because 208 ≠ 149

**T2. Trailer — runtime mismatch SHOULD change the answer**
- Path: `Movies/Das Boot (1981)/Das.Boot.1981-trailer.mkv`
- Evidence: filename (title + year + `-trailer` suffix), duration 2 min 18 s
- Expected: identify as a *trailer for* Das Boot (1981), not the film itself
- What it tests: K2 — agent must distinguish "edition runtime mismatch" (T1) from "trailer runtime mismatch" (T2)
- Failure mode to catch: agent identifies it as the film

**T3. Franchise container directory — agent must refuse, not guess**
- Path: `/电影/饥饿游戏系列/output.mkv`
- Evidence: parent dir = "Hunger Games series" (franchise, not a work), filename = nothing, duration 137 min
- Expected: refuse / report cannot identify which Hunger Games entry (or whether it's even one)
- What it tests: M14 — misleading ancestor directory
- Failure mode to catch: agent claims *The Hunger Games* (2012, 142 min) because runtime is close

**T4. Anime special — series identifiable, episode not**
- Path: `Anime/夏目友人帳/[Group] Natsume Yuujinchou - OVA.mkv`
- Evidence: series title in parent dir + filename, `OVA` token, duration 24 min
- Expected: identify series as *Natsume's Book of Friends*, report cannot determine which OVA/special
- What it tests: M12d / H4 — specials are impossible at episode level
- Failure mode to catch: agent assigns a specific S00Exx number

**T5. Bare episode number — absolute or seasonal?**
- Path: `Anime/Sword Art Online/[SubsPlease] Sword Art Online - 102 [1080p].mkv`
- Evidence: series title in parent + filename, episode number `102`, duration 24 min
- TMDB: SAO S1 has 25 eps, S2 has 24 eps, S3 has 47 eps — no season has 102 episodes
- Expected: identify series, identify episode as S04E26 (absolute #102 in the TMDB ordering) — but only if the agent uses the TMDB season table; otherwise should flag ambiguity
- What it tests: F1 / M9 — requires TMDB season table to resolve
- Failure mode to catch: agent guesses S01E02

**T6. Internally contradictory season evidence**
- Path: `TV/猎罪图鉴.Under.the.Skin.S02.2022.4K/Under.the.Skin.S01E15.2022.4K.mkv`
- Evidence: parent dir says S02, filename says S01E15, series title present in both
- Expected: identify series as *Under the Skin* (猎罪图鉴, 2022), flag the S01/S02 contradiction, resolve using TMDB season table (S1 has 20 eps, so S01E15 is plausible; but the folder says S02 — agent should note the conflict and state which it trusts and why)
- What it tests: M13 — internally contradictory evidence
- Failure mode to catch: agent silently picks one without noting the conflict

### Tier 2 — Solvable cases that verify the agent beats mechanical parsers

**T7. Re-Zero filename with three competing identifiers**
- Path: `TV/Re-Zero/[EMBER] Re-Zero kara Hajimeru Isekai Seikatsu S2E21 [Episode-46] [1080p] [HEVC WEBRip] (Re-Zero - Starting Life in Another World).mkv`
- Evidence: everything — series title (romaji + English alias), S2E21, absolute #46, quality tags
- Expected: *Re:Zero − Starting Life in Another World* S02E21 (= absolute episode 46)
- What it tests: F5 — number-word in title, multiple competing identifiers; LLM should trivially beat the regex that read `Zero` as season 0

**T8. Filesystem-illegal character corruption**
- Path: `Movies/Face-Off (1997)/Face-Off.1997.1080p.BluRay.mkv`
- Evidence: filename `Face-Off` (canonical title is `Face/Off`), year 1997, duration 138 min
- Expected: *Face/Off* (1997)
- What it tests: M16 / B3 — deterministic filesystem corruption; LLM knows `Face-Off` = `Face/Off`

**T9. Short common-word title — year present**
- Path: `Movies/Mother (2009)/Mother.2009.1080p.mkv`
- Evidence: title `Mother`, year 2009, duration 129 min
- Expected: *Mother* (2009, Bong Joon-ho) — TMDB runtime 129 min confirms
- What it tests: M5 with year present — should succeed

**T10. Short common-word title — year absent, runtime present**
- Path: `Movies/Mother/Mother.mkv`
- Evidence: title `Mother`, no year, duration 129 min
- Expected: narrow to *Mother* (2009) as the best candidate (129 min matches), but express uncertainty — there are other films named *Mother*
- What it tests: M5 without year — runtime as a weak tiebreaker; agent should not refuse outright but should hedge

**T11. Turkish romanisation**
- Path: `TV/Muhtesem.Yuzyil.S01E15.1080p.WEB-DL.mkv`
- Evidence: romanised Turkish title, S01E15, quality tags
- Expected: *Muhteşem Yüzyıl* (*The Magnificent Century*) S01E15
- What it tests: M15 — original-language romanisation; LLM world knowledge bridges the gap

**T12. Multi-episode double — runtime as positive signal**
- Path: `Anime/Attack on Titan/[Erai-raws] Shingeki no Kyojin - 01 [1080p].mkv`
- Evidence: series title (Japanese), episode `01`, duration 47 min 12 s
- TMDB: AoT S1 episodes are ~24 min each
- Expected: identify as *Attack on Titan* S01E01+E02 (double episode / special premiere)
- What it tests: F8 / M10c — runtime as a *correct* positive signal for multi-episode

**T13. Blade Runner 2049 — number-in-title year confusion**
- Path: `Movies/Blade Runner 2049 (2017)/Blade.Runner.2049.2017.mkv`
- Evidence: title `Blade Runner 2049`, year `2017`
- Expected: *Blade Runner 2049* (2017) — not *Blade Runner* (1982)
- What it tests: M4 — LLM should not confuse `2049` with the year

**T14. CD1 split file — runtime ~half, part marker present**
- Path: `Movies/Schindler's List (1993)/Schindlers.List.1993.CD1.avi`
- Evidence: title, year, `CD1` marker, duration 97 min
- TMDB runtime: 195 min
- Expected: *Schindler's List* (1993), part 1 of 2 — runtime is ~half because it's a split file
- What it tests: M10b / H6 — split file; runtime mismatch must not veto correct answer

### Tier 3 — Impossible cases (agent should refuse)

**T15. Camera-original filename**
- Path: `Videos/IMG_4821.MOV`
- Evidence: iOS camera filename, no other context, duration 3 min 42 s
- Expected: refuse — this is a personal recording, not a catalogued work; no rename will help
- What it tests: M11b — camera-original; agent should express *confident* refusal, not hedged uncertainty

**T16. Franchise container with zero-information filename**
- Path: `/饥饿游戏系列/output.mkv` (same as T3 but without the duration hint)
- Evidence: franchise dir name, placeholder filename, duration unknown
- Expected: refuse — cannot identify which entry, or whether it's even a Hunger Games film
- What it tests: M14 + M11c combined — the hardest possible case

## Cases where the agent SHOULD refuse

Characterised as precisely as possible. Three distinct sub-types with different correct explanations to the user.

### Refusal type R1 — "Insufficient evidence; renaming WOULD help"
The work exists in TMDB; the path just doesn't narrow to one candidate.

- `Mother.mkv` with no year and no runtime (M5 without any second evidence)
- `output.mkv` in a directory named after a real film, but the directory name is a franchise container (M14)
- `[Group] Ansatsu Kyoushitsu - 01.mkv` where the show has both S1E01 and S2E01 and no season marker exists anywhere in the path (M12a)
- Any file where title + year + runtime all match two different works (M7 — same title, same year, similar runtime)

Correct message: "I cannot identify this file from the available evidence. Adding the year (and for TV, the season number) to the filename or directory would allow identification."

### Refusal type R2 — "Irreducibly ambiguous; no rename fixes it"
The information is present but two-valued; the user faces the same ambiguity.

- `The Repair Shop S10E20.mkv` — which ordering? (M12b)
- `[Group] Show - OVA.mkv` where the show has multiple OVAs with no numbering (M12d)
- A file whose season/episode number is valid under two different metadata authorities (M12c)

Correct message: "This file's episode identity is ambiguous because different databases number episodes differently. Please specify which episode this is, or use a database ID in the filename."

### Refusal type R3 — "Not a catalogued work; no rename helps"
The work does not exist in TMDB.

- `IMG_4821.MOV`, `DSC00123.MP4`, `GOPR0123.MP4` (M11b — camera originals)
- `Christmas 2010.mp4`, `Jack's Diary.mkv` (M11a — home videos)
- `2024 Monaco Grand Prix - Race.mkv` (M11d — real but non-TMDB content)
- `output.mkv` in a directory with no title information (M11c — placeholder)

Correct message: "This does not appear to be a commercial release. Subtitle-scout works with films and TV series catalogued in TMDB; home videos and personal recordings cannot be identified."

**The R1/R3 distinction is the most product-critical finding in this document.** Telling an R3 user to "rename the file" is actively wrong advice. The agent must distinguish "I can't tell which work" from "this isn't a catalogued work."

## Open questions / what I could not determine

1. **Concrete same-title-same-year pair (M7):** I could not find a named real-world example of two different films with identical title AND identical release year. The Plex forum thread confirms the problem exists but gives no example. Needed for a T-tier test case.

2. **TMDB's Cardcaptor Sakura season layout:** The Sonarr issue cites TVDB's numbering (S1–S3 for 70 eps, S4 for the sequel). I did not verify how TMDB numbers it. Since subtitle-scout verifies against TMDB, this matters for whether F6's authority-disagreement case is actually impossible or merely hard.

3. **PAL speedup prevalence in current rips:** The 4% speedup is well-established for DVD-era rips. I did not find data on how common it is in current WEB-DL / streaming rips, which are the dominant source for modern libraries. If it's rare in current content, it may not be worth a dedicated test case.

4. **Split-cour anime and TMDB season numbering:** I noted the `第2期` / split-cour problem (H3) as an inference. I did not verify a specific example where TMDB folds a split-cour into one season while the Japanese broadcast and release groups treat them as separate. A concrete example would strengthen this as a test case.

5. **Scope of subtitle-scout's episode-level identification:** The research assumes subtitle-scout must identify *which episode* (not just which series) because it fetches subtitles. If the product only needs series-level identification for some use cases, several Group F cases move from "important" to "out of scope." Worth clarifying before designing the experiment.

6. **Whether sibling-file context is in scope for the experiment:** I identified sibling filenames as a missing evidence dimension (F1, M9). Whether the experiment should test with vs without sibling context, or whether adding sibling context is a product decision to make first, is an open design question.

**Status:** COMPLETE — all 7 sub-topics covered. File is safe to use as experiment input.

