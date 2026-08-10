# Subtitle timing-alignment tooling — deep research

**Date:** 2026-07-29
**Context:** subtitle-scout (Node 26 / TS, Docker on low-power OpenWrt router). Building subtitle verification + timing correction.
**Status:** IN PROGRESS

Legend: `[FACT]` = verified against primary source (source code / issue thread / spec), with URL.
`[INFER]` = my reasoning, not directly sourced. `[UNVERIFIED]` = could not confirm; test needed.

## Progress log

- 2026-07-29 T0 — Created skeleton. Keys located in token.txt (GITHUB_TOKEN, FIRECRAWL_API_KEY, EXA_API_KEY, TAVILY_API_KEY, BRAVE_API_KEY, BRAVE_SEARCH_PAID_API_KEY). Plan: (1) ffsubsync source via GitHub API raw files, (2) ffsubsync issues, (3) alass source + README, (4) npm wrappers, (5) ASS spec / libass / Aegisub on inline timing tags, (6) encoding detection practice, (7) CIFS rename atomicity, (8) Bazarr/Subtitle Edit write strategy.
- T1 — **Q1 largely DONE, and done by EXPERIMENT not just reading.** Pulled full ffsubsync master source tree via GitHub API; downloaded + unzipped the released PyPI wheel (0.5.1, published 2026-07-24) to confirm released==master features; **created a venv, pip-installed ffsubsync 0.5.1, and ran ~12 real invocations** against synthetic SRT/ASS fixtures. Confirmed: sub-vs-sub alignment works, exact offset recovered, offset is available ONLY via stderr log lines, exit codes are misleading, and ASS rewrite drops some sections. Details in Q1 + Q3 below.
- T2 — RESUMED (new agent session). Q1 left intact. Pulled `kaegi/alass` repo metadata, git tree, release assets, and **full `alass-cli/src/main.rs` (543 lines) + `lib.rs`** via GitHub API raw. Have the complete real clap arg definitions and the exact stdout print statements. Confirmed release artifacts = only `alass-linux64` (musl) + `alass-windows64.zip`, newest release **v2.0.0, 2019-10-10**; last commit **2021-04-11**.
- T3 — **Q2 DONE BY EXPERIMENT.** Also pulled `kaegi/subparse` `src/formats/ssa.rs` + `common.rs` + `timetypes.rs` — this is the actual `.ass` writer and the true source of the byte-preservation claim. Then **downloaded the real `alass-linux64` v2.0.0 release binary, verified the ELF is static-musl, and ran ~14 live invocations in `docker alpine:3.20 --platform linux/amd64`** against fixtures incl. a styled Chinese-fansub `.ass` with `[Fonts]`/`[Graphics]`/`[Aegisub Project Garbage]`/karaoke/`\move`/`\fade`, plus CRLF+BOM and GB18030 variants, plus a 700-cue episode for timing. **Preservation claim CONFIRMED with 3 real caveats found (CRLF, BOM, encoding transcode).** Q2 written.
- T4 — NEXT: Q3 (ASS spec inline tag timing semantics from libass/Aegisub, encoding detection in Node, CIFS/rclone rename atomicity, Bazarr/Subtitle Edit backup practice, idempotency), then integration plan + risks.

## Executive summary

_pending_

## Q1 ffsubsync

**Version examined:** master @ 2026-07-29 AND released PyPI `0.5.1` (uploaded 2026-07-24). I verified the released wheel contains the same feature set as master (see "version currency" below) — this matters because most blog posts describe 0.4.x.

Sources:
- Source tree: https://github.com/smacke/ffsubsync
- `ffsubsync/ffsubsync.py` (CLI + sync driver): https://github.com/smacke/ffsubsync/blob/master/ffsubsync/ffsubsync.py
- `ffsubsync/constants.py`: https://github.com/smacke/ffsubsync/blob/master/ffsubsync/constants.py
- `ffsubsync/split_aligner.py`: https://github.com/smacke/ffsubsync/blob/master/ffsubsync/split_aligner.py
- PyPI metadata: https://pypi.org/pypi/ffsubsync/json

### Version currency — important

`[FACT]` The PyPI 0.5.1 wheel (`ffsubsync-0.5.1-py2.py3-none-any.whl`, 65,508 bytes, uploaded 2026-07-24T04:52:49) contains `ffsubsync/split_aligner.py` (9,712 bytes) and a `constants.py` with the split/whisper/quality-gating constants. I confirmed by downloading and unzipping the wheel. So `pip install ffsubsync` gets you the alass-style piecewise aligner, whisper reference mode, PGS reference mode, and the quality gate. **Do not rely on older documentation** — 0.4.x behaviour differs.

### Q1.1 Does it do subtitle-vs-subtitle alignment? — YES, CONFIRMED BY EXECUTION

`[FACT]` This is our primary path (63.7% of items) and it is fully supported. The reference argument is dispatched purely on **file extension**:

```python
# ffsubsync.py :416-426  (make_reference_pipe)
ref_format = _ref_format(args.reference)
if ref_format in SUBTITLE_EXTENSIONS:
    if args.vad is not None:
        logger.warning("Vad specified, but reference was not a movie")
    return make_subtitle_speech_pipeline(fmt=ref_format, ...)
```

`SUBTITLE_EXTENSIONS = ("srt", "ass", "ssa", "sub")` (`constants.py:78`).

**Exact invocation, verified running:**
```
ffs <reference.srt> -i <input.srt> -o <output.srt>
```

`[FACT]` My live test: reference = clean SRT, input = same cues shifted +7.5s late. ffsubsync reported `offset seconds: -7.500`, `framerate scale factor: 1.000`, `score: 59802.000`, and the output file's first cue was restored to exactly `00:00:10,000 --> 00:00:13,000`. Exact recovery.

`[FACT]` A framerate-drift fixture (input timestamps scaled by 25/23.976) yielded `inferred frameratio ratio: 0.959`, `framerate scale factor: 0.959`, `offset seconds: 0.000` — i.e. it correctly diagnosed stretch-not-shift. **This directly answers the Q2 "which of the two diseases" question for ffsubsync: yes, it reports them as two separate numbers.**

`[FACT]` The audio-only VAD deps are NOT exercised on this path — when the reference is a subtitle file it warns and ignores `--vad`. Extraction of the embedded track can be done by ffsubsync itself with `--extract-subs-from-stream` (which just shells `ffmpeg -map 0:s:N -f srt`, `ffsubsync.py:492-535`), but we already extract with ffmpeg, so we don't need that.

### Q1.2 How to get the computed offset out — THE KEY INTEGRATION PROBLEM

`[FACT]` **There is no `--dry-run`, no `--report-only`, and no machine-readable output mode.** I read the entire argparse block (`ffsubsync.py:826-1184`) — no such flag exists. Do not invent one.

`[FACT]` The Python *library* API returns the offset as structured data. `run()` returns a dict:
```python
# ffsubsync.py :798-802
result = {"retval": 0, "offset_seconds": None, "framerate_scale_factor": None}
# ... later, :362-364
result["offset_seconds"] = offset_seconds
result["framerate_scale_factor"] = scale_step.scale_factor
result["sync_was_successful"] = sync_was_successful
```
But `main()` throws all of that away: `return run(parser)["retval"]` (`:1194-1196`). **The CLI discards the offset.**

`[FACT]` So from the CLI the offset is available **only by scraping stderr log lines** (`ffsubsync.py:255-257`):
```
INFO     score: 59802.000
INFO     offset seconds: -7.500
INFO     framerate scale factor: 1.000
```
Format strings are `logger.info("offset seconds: %.3f", offset_seconds)` and `logger.info("framerate scale factor: %.3f", ...)` — 3 decimal places.

`[FACT] ⚠ SCRAPING HAZARD I HIT IN PRACTICE:` logging goes through **`rich`**, which renders to a **table with a right-hand source-location column and HARD-WRAPS long lines to terminal width**. My captured stderr looked like:
```
[16:42:19] INFO     extracting speech segments from reference   ffsubsync.py:734
                    'ref.srt'...
           WARNING  low-quality alignment (framerate deviation  ffsubsync.py:269
```
Note the warning is **truncated mid-sentence** — the reason list was cut off by wrapping. A naive `/offset seconds: ([-\d.]+)/` works for the short offset line, but any longer message is mangled. `[INFER]` Mitigations: set `COLUMNS`/`TERM` env to force a wide non-tty render, or better — **bypass the CLI entirely and drive the Python library** (see integration plan), which gives you the dict directly and no scraping at all.

`[FACT]` `--suppress-output-if-offset-less-than <float>` exists but is NOT a report mode; it suppresses *writing* when offset is below a threshold. Also note the comparison is `offset_seconds >= thresh` on the **signed** value (`:349`), not absolute — so a large *negative* offset is suppressed too. `[INFER]` That looks like a bug; don't rely on this flag.

### Q1.3 `--min-score` / `--skip-sync-on-low-quality` — what they really do

`[FACT]` `--skip-sync-on-low-quality` is the master switch; the three thresholds only apply when it is passed (`ffsubsync.py:259`). Logic (`assess_alignment_quality`, `:155-184`) rejects if ANY of:
| check | flag | default |
|---|---|---|
| `best_score < min_score` | `--min-score` | `0.0` |
| `abs(offset_seconds) > max` | `--quality-max-offset-seconds` | `30.0` |
| `abs(scale_factor - 1.0) > max` | `--max-framerate-deviation` | `0.1` |

`[FACT]` **Score scale: UNNORMALISED and unbounded.** The source says so explicitly (`constants.py:68-71`): *"The score's sign is meaningful even though its magnitude is not, so 0.0 rejects only anti-correlated alignments."* The score is a raw FFT cross-correlation peak — it scales with subtitle count and duration. My runs produced 59802, 58851, 44952, 33642 for comparable fixtures. **You cannot pick a meaningful absolute `--min-score` threshold, and you cannot compare scores between two different episodes.**

`[FACT] ⚠ THE QUALITY GATE IS WEAK — demonstrated.` I fed it a deliberately unrelated reference. Result:
```
score: 33642.345            <- still strongly POSITIVE
offset seconds: 3.030
framerate scale factor: 19.939
WARNING low-quality alignment (framerate deviation ...)
```
A garbage alignment produced a **positive score of 33642**, so `--min-score 0.0` did NOT catch it. Only the absurd framerate deviation (19.9) tripped the gate. **`[INFER]` Implication for us: the score is nearly useless as a confidence signal for a "verification" feature. We must build our own confidence metric** (e.g. compare cue-count, total-speech-duration ratio, and post-shift overlap fraction ourselves) rather than surfacing ffsubsync's score to the user.

`[FACT]` On rejection it does NOT leave the file alone — it **rewrites the file with the original unshifted timings** (`:274-282`, comment: *"write the original (unscaled, unshifted) subtitles unchanged"*). For an ASS input this still round-trips through pysubs2 and therefore still incurs the lossy rewrite documented in Q3. So "skip sync" ≠ "don't touch the file".

### Q1.4 Exit codes — MEASURED, and they are misleading

`[FACT]` Measured directly:
| scenario | exit code |
|---|---|
| successful sync | 0 |
| input subtitle file missing / unreadable | 1 |
| reference file missing | 1 |
| no arguments | 1 |
| **low-quality alignment, sync skipped** | **0** |
| **malformed/garbage input srt** | **0** |

`[FACT]` The reason is structural: `main()` returns `result["retval"]`, and `retval` is only set to 1 by *argument/permission validation* (`:805`). The sync path sets `sync_was_successful` — which is **never folded into `retval`**. Worse, `try_sync` wraps the whole per-file body in `except Exception: sync_was_successful = False; logger.exception(...)` (`:358-360`) and then still returns 0.

**`[INFER]` Conclusion: exit code 0 does NOT mean the subtitles were synced.** Any Node integration that trusts the exit code will silently accept failures. We must verify by (a) parsing the offset line, and/or (b) checking the output file actually changed.

### Q1.5 Runtime requirements & install footprint

`[FACT]` Runtime deps (`requirements.txt`, matches PyPI `requires_dist`):
```
auditok==0.1.5, chardet, charset_normalizer, faust-cchardet, ffmpeg-python,
numpy>=1.12.0, pysubs2>=1.2.0, rich, srt>=3.0.0, tqdm, typing_extensions,
webrtcvad-wheels
```
Optional extra: `torch` (only for `silero`/`fused` VAD). Python: classifiers list 3.6–3.14; `requires_python` is unset. Upstream Dockerfile uses `python:3.14-slim` + `apt install ffmpeg`.

`[FACT] MEASURED FOOTPRINT:` fresh venv + `pip install ffsubsync` → **72 MB** `site-packages`. Breakdown:
```
34M numpy        12M pip         9.2M pygments    3.5M future
2.9M rich        2.3M auditok    1.8M chardet     444K ffsubsync
364K pysubs2     304K cchardet
```
Excluding pip that's ~60 MB. `numpy` alone is 34 MB (half the total). Plus ffmpeg in the image (which we already have).

`[FACT]` `auditok==0.1.5` is a hard **pinned** dep and drags in `future` (3.5 MB) — a Python-2 compat shim, dead weight in 2026. `pygments` (9.2 MB) comes in only via `rich`, purely for log colouring.

`[INFER]` **Slim path assessment.** `numpy` is genuinely required on the sub-vs-sub path (the FFT aligner and the split aligner both use it — `try_sync` calls `np.median`, `split_aligner` uses prefix sums). So numpy cannot be dropped. But `auditok`, `webrtcvad-wheels`, `future`, and arguably `rich`/`pygments`/`tqdm` are **only needed for the audio-VAD path or for pretty output**, which we do not use for the 63.7% embedded-track case. A `pip install --no-deps ffsubsync` followed by installing only `numpy pysubs2 srt chardet charset_normalizer typing_extensions ffmpeg-python` would plausibly land ~40 MB. **`[UNVERIFIED]` I did not test that this actually imports cleanly** — `ffsubsync/__init__.py` may import `speech_transformers` eagerly, which imports `auditok`/`webrtcvad` at module scope. Needs a 5-minute test: build the slim venv and run `ffs ref.srt -i in.srt -o out.srt`. If it fails on import, the fix is either to keep the deps or to vendor/import the two modules we need directly.

### Q1.6 The split (piecewise) aligner — a genuine surprise

`[FACT]` ffsubsync master AND released 0.5.1 ship `--split-penalty`, explicitly described in its own help text as **"Enable alass-style piecewise synchronization"** — offset allowed to change across the timeline to correct commercial breaks, inserted/removed scenes, concatenated discs (`ffsubsync.py:939-954`). Defaults: `DEFAULT_SPLIT_PENALTY = 5.0`, `DEFAULT_SPLIT_LENGTH_PENALTY = 0.25`, `DEFAULT_SPLIT_SUBSAMPLE = 1` (`constants.py:26-39`). Flag is `nargs="?"` with `const=5.0`, `default=None` → **omitted = off, bare flag = 5.0**.

`[FACT]` It does a **joint framerate + split search** (`:296-320`): it scores the piecewise alignment at every candidate framerate scale and keeps the best, rather than trusting the scale the single-offset FFT search picked. When splits are used, the reported single `offset_seconds` becomes `float(np.median(offsets_seconds))` (`:336`) and per-segment offsets are logged via `log_split_segments`.

`[FACT] ⚠ CRITICAL LIMITATION FOR US:` the split path requires reference *speech*:
```python
# ffsubsync.py :285-289
use_split = (split_penalty is not None and not skip_sync
             and reference_speech is not None)
```
`reference_speech` is only populated in the `else` branch at `:241` (`reference_pipe.transform(...)`) — which does run for a subtitle reference too, since a subtitle reference is still a pipeline producing a speech-like array. `[INFER]` So split alignment *should* work sub-vs-sub, but **I did not verify this empirically** and it is the single most valuable feature for our commercial-break cases. Test needed: build a fixture with a mid-file discontinuity and run with `--split-penalty`.

This substantially weakens the usual "use alass for split misalignment" argument — see Q2.

### Q1.7 Other flags worth knowing (all read from argparse, verified present)

| flag | effect |
|---|---|
| `-i/--srtin` (`nargs="*"`) | multiple inputs allowed **only** with `--overwrite-input` (`:590-594`) |
| `--overwrite-input` | overwrite input in place instead of writing new file |
| `--encoding` | input encoding, default `"infer"` |
| `--output-encoding` | default `utf-8`; accepts `"same"` to preserve input encoding ← **important for Q3** |
| `--reference-encoding` | encoding for a subtitle reference |
| `--apply-offset-seconds` | apply a known offset with no alignment; reference may be omitted |
| `--no-fix-framerate` | disable framerate-ratio search entirely |
| `--gss` | golden-section search for a continuous framerate ratio (else only discrete candidates) |
| `--max-offset-seconds` | search bound, default 60 |
| `--strict` | refuse to parse malformed srt |
| `--ffmpeg-path` | where to find ffmpeg/ffprobe |
| `--reference-stream` e.g. `s:0`, `a:3` | pick track in a video reference |
| `--pgs-ref-stream` | use image-based PGS track as reference (no OCR — uses cue timings) |
| `--whisper-weights` | transcribe reference with ffmpeg's whisper filter (needs ffmpeg ≥8.0 `--enable-whisper`) |
| `--extract-subs-from-stream` | extract only, no sync |
| `--vlc-mode`, `--gui-mode`, `--skip-sync` | **hidden** (`argparse.SUPPRESS`) |

`[FACT]` Framerate candidates are only `24/23.976, 25/23.976, 25/24` **and their reciprocals** (`constants.py:9` + `get_framerate_ratios_to_try` `:141-152`), plus a duration-ratio-inferred candidate, plus a continuous one if `--gss`. So the common 23.976↔25 and 24↔25 cases are covered.

`[FACT]` Auto-detection of sibling subtitles: if `-i` is omitted, it globs `<refstem>.srt` / `<refstem>.*.srt` next to the reference and writes `<name>.synced.srt`, skipping `*.synced.srt` for idempotency (`_detect_srtin_from_reference`, `:538-563`). **`[INFER]` We should always pass `-i` and `-o` explicitly to avoid this magic touching files we didn't ask about.**

### Q1.8 Entry points

`[FACT]` Three identical console scripts (`setup.py`): `ffs`, `subsync`, `ffsubsync` → all `ffsubsync:main`. Note `subsync` collides with the unrelated `sc0ty/subsync` project; prefer `ffs` or the full `ffsubsync`.


## Q2 alass comparison

**Version examined:** `master` @ commit `874f02d9` (2021-04-11) for source; **released binary `alass-linux64` from tag `v2.0.0` (2019-10-10)** for all live tests. ⚠ These are **not** the same code — see "release lag" below.

Sources:
- Repo: https://github.com/kaegi/alass
- `alass-cli/src/main.rs`: https://github.com/kaegi/alass/blob/master/alass-cli/src/main.rs
- `alass-cli/src/lib.rs`: https://github.com/kaegi/alass/blob/master/alass-cli/src/lib.rs
- **`kaegi/subparse` `src/formats/ssa.rs`** — the actual `.ass` writer: https://github.com/kaegi/subparse/blob/master/src/formats/ssa.rs
- `kaegi/subparse` `src/formats/common.rs`, `src/timetypes.rs`
- Release asset: https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64
- Issues #17, #29, #40, #43, #44

### Q2.1 Distribution: single static musl binary — CONFIRMED, but amd64 only

`[FACT]` I downloaded the v2.0.0 release asset and parsed the ELF header directly:

| property | value |
|---|---|
| size | **3,032,792 bytes (2.9 MB)** |
| sha256 | `7bd0b9ae7e035d3ba940eacffb21243614df36231d47f21f0b4ce42001ab7fcd` |
| `e_type` | `2` = `ET_EXEC` (**not** PIE/dynamic) |
| `e_machine` | `0x3e` = **x86-64** |
| program headers | `PT_LOAD`×4, `PT_NOTE`, `PT_TLS`, GNU_EH_FRAME/STACK/RELRO — **no `PT_INTERP`** |
| contains `musl` string | yes |
| contains `/lib64/ld-linux` | **no** |
| contains `GLIBC_` | **no** |

No `PT_INTERP` + no `GLIBC_` + `ET_EXEC` = **genuinely statically linked against musl**. This is the ideal case: drop the file in a `FROM scratch`/`alpine`/`distroless` image, `chmod +x`, done. The upstream `Makefile` corroborates: `package_linux64: cargo build --release --target x86_64-unknown-linux-musl`.

`[FACT]` **Release artifacts are ONLY:**
- `alass-linux64` — 3.0 MB, x86-64 musl, 14,142 downloads
- `alass-windows64.zip` — 26 MB (bundles ffmpeg)

`[FACT] ⚠ THERE IS NO ARM/aarch64 RELEASE BUILD.` No `armv7`, no `aarch64`, no `arm64`. I also checked distro packaging:
- Alpine: **not packaged at all.** I grepped the actual `APKINDEX` for `edge/{main,community,testing}` × `{x86_64,aarch64}` — `P:alass` absent in all six.
- Repology reports alass 2.0.0 only in `aur`, `freebsd`, `homebrew`, `nix`, `scoop`, `termux` — no Debian/Ubuntu/Alpine.

`[INFER]` **This is the single biggest deployment question for us.** An OpenWrt router is very likely `aarch64` or `mipsel`, not x86-64. If the target is not amd64 we must **cross-compile in a Docker build stage** (`rustup target add aarch64-unknown-linux-musl` + `cargo build --release`), which turns a 3 MB file-copy into a Rust toolchain build stage. Mitigating factors: the crate has no C deps on our path except `webrtc-vad` (C, but only used for video), and `cargo install alass-cli` is documented. `[UNVERIFIED]` I did not attempt an aarch64-musl cross-build; `webrtc-vad` is a `cc`-built C library and is a **non-optional dependency in `alass-cli/Cargo.toml`** even though we never touch the audio path, so it must still compile for the target. **Test that settles it:** `docker buildx build --platform linux/arm64` with a `rust:alpine` stage running `cargo build --release -p alass-cli`. Do this before committing to alass.

### Q2.2 Release lag: the shipped binary is older than the source

`[FACT]` Newest release **v2.0.0 = 2019-10-10**. Last commit to master = **2021-04-11**. Two feature commits landed after the release and are **NOT in any published binary**:
- `b9450c70` "Implement support for `--audio-index`" (2020-03-04)
- `874f02d9` "Auto detect subtitle encoding" (2021-04-11)

`[FACT]` I confirmed this from the binary itself: real `--help` from v2.0.0 (quoted in full below) **does not contain `--index`**, while `main.rs` on master defines `Arg::with_name("audio-index").long("index")`. Open issue **#56 "Request new release" (2025-08-01) is still open.**

`[INFER]` Consequence: if we want the improved encoding auto-detection we must build from source, not use the release binary. Since we probably have to build from source anyway for ARM, this is less of a blow than it sounds — but **do not read master's `main.rs` and assume the release binary behaves that way.** I made sure every behavioural claim below is from the binary I actually ran.

### Q2.3 Exact CLI — real `--help` output, verbatim

`[FACT]` Captured by running the real v2.0.0 binary (`docker run --platform linux/amd64 alpine:3.20 ./alass-linux64 --help`):

```
alass-cli 2.0.0
Automatic Language-Agnostic Subtitle Synchronization (Command Line Tool)

USAGE:
    alass-linux64 [FLAGS] [OPTIONS] <reference-file> <incorrect-sub-file> <output-file-path>

FLAGS:
    -n, --allow-negative-timestamps    Negative timestamps can lead to problems with the output file, so by default 0
                                       will be written instead. This option allows you to disable this behavior.
    -g, --disable-fps-guessing         disables guessing and correcting of framerate differences between reference file
                                       and input file
    -h, --help                         Prints help information
    -l, --no-split                     synchronize subtitles without looking for splits/breaks - this mode is much
                                       faster
    -V, --version                      Prints version information

OPTIONS:
        --encoding-inc <encoding>                                     Charset encoding of the incorrect subtitle file.
        --encoding-ref <encoding>                                     Charset encoding of the reference subtitle file.
    -i, --interval <integer in milliseconds>
            The smallest recognized time interval, smaller numbers make the alignment more accurate, greater numbers
            make aligning faster. [default: 1]
    -O, --speed-optimization <path>
            (greatly) speeds up synchronization by sacrificing some accuracy; set to 0 to disable speed optimization
            [default: 1]
    -p, --split-penalty <floating point number from 0 to 1000>
            Determines how eager the algorithm is to avoid splitting of the subtitles. 1000 means that all lines will be
            shifted by the same offset, while 0.01 will produce MANY segments with different offsets. Values from 1 to
            20 are the most useful. [default: 7]
    -t, --statistics-required-tag <tag>
            only output statistics containing this tag (you can find the tags in statistics file)

        --sub-fps-inc <floating-point number in frames-per-second>
        --sub-fps-ref <floating-point number in frames-per-second>

ARGS:
    <reference-file>        Path to the reference subtitle or video file
    <incorrect-sub-file>    Path to the incorrect subtitle file
    <output-file-path>      Path to corrected subtitle file

This program works with .srt, .ass/.ssa, .idx and .sub files. The corrected file will have the same format as the
incorrect file.
```

**Subtitle-vs-subtitle invocation** — all three paths are positional and required:
```
alass <reference.srt|.ass|.ssa|.idx|.sub|video> <incorrect.ass> <output.ass>
```

`[FACT]` **Reference type is chosen purely by file extension**, exactly like ffsubsync (`lib.rs`, `InputFileHandler::open`):
```rust
let known_subitle_endings: [&str; 6] = ["srt", "vob", "idx", "ass", "ssa", "sub"];
let extension: Option<&OsStr> = file_path.extension();
for &subtitle_ending in known_subitle_endings.iter() {
    if extension == Some(OsStr::new(subtitle_ending)) {
        return Ok(SubtitleFileHandler::open_sub_file(...).map(InputFileHandler::Subtitle)...);
    }
}
return Ok(VideoFileHandler::open_video_file(...).map(InputFileHandler::Video)...);
```
`[INFER]` So the extension on our extracted reference file matters — we must name the ffmpeg-extracted track `*.srt`, not something extensionless, or alass will try to decode it as a video.

`[FACT]` **Output format cannot differ from input format.** `main.rs` hard-rejects a mismatch:
```rust
if !subparse::is_valid_extension_for_subtitle_format(args.output_file_path.extension(), output_file_format) {
    return Err(TopLevelErrorKind::FileFormatMismatch { ... })
}
```
with the code comment *"this program internally stores the files in a non-destructable way (so formatting is preserved) but has no abilty to convert between formats"*. So `.ass` in → **must** be `.ass` out. Fine for us; we never want conversion.

`[FACT]` **Undocumented debug mode:** passing `_` as the incorrect-sub-file path dumps the reference file's timings as a synthetic `.srt` (`main.rs`: `if args.incorrect_file_path.eq(OsStr::new("_"))`, prints *"input file path was given as '_'"*). Useful for debugging what alass thinks the reference timings are.

### Q2.4 Can we parse the offset out? — YES, and it's better than ffsubsync's

`[FACT]` **There is no `--dry-run` / report-only mode.** Open issue **#29 "diagnostic-mode ?" (2021-01-31) asks for exactly this and is still open** — the requester wanted to script alass over a library and get "in sync" vs "not in sync" per pair, which is *precisely our feature*. Nobody implemented it. Do not invent the flag.

`[FACT]` But the shift **is** printed, and in a much more parseable form than ffsubsync. From `main.rs`:
```rust
println!(
    "shifted block of {} subtitles with length {} by {}",
    shift_group_lines.len(),
    max - min,
    alg_delta_to_delta(shift_group_delta, args.interval)
);
```
and the framerate line:
```rust
println!(
    "info: 'reference file FPS/input file FPS' ratio is {}",
    if let Some(idx) = opt_ratio_idx { desc[idx] } else { "1" }
);
```

`[FACT]` **Real captured output** (constant +7.5 s late, 8 cues), with progress-bar `\r` frames stripped:
```
Guessing framerate ratio...
info: 'reference file FPS/input file FPS' ratio is 1

synchronizing 'fx/in_shift.srt' to reference file 'fx/ref.srt'...

shifted block of 8 subtitles with length 0:02:20.000 by -0:00:07.500
```
Exact recovery of the injected 7.5 s.

`[FACT]` The time format is `[-]H:MM:SS.mmm` — **3-decimal milliseconds**, from `impl Display for Timing` in `subparse/src/timetypes.rs`:
```rust
write!(f, "{}{}:{:02}:{:02}.{:03}",
    if self.0 < 0 { "-" } else { "" }, t.hours(), t.mins_comp(), t.secs_comp(), t.msecs_comp())
```
Note the sign is a prefix on the whole value and the components are absolute — so `-0:00:07.500` means −7.5 s, and a naive parse must apply the leading `-` to the assembled total, not to the hours field.

Suggested parse (`[INFER]`, regex mine):
```
/^shifted block of (\d+) subtitles with length (\S+) by (-?)(\d+):(\d{2}):(\d{2})\.(\d{3})$/
/^info: 'reference file FPS\/input file FPS' ratio is (\S+)$/
```
The fps ratio prints as a **label**, one of `1`, `25/24`, `25/23.976`, `24/25`, `24/23.976`, `23.976/25`, `23.976/24` — a small closed set, so match it as an enum rather than parsing arithmetic.

`[FACT] ⚠ TWO SCRAPING HAZARDS, both hit live:`
1. **Everything goes to stdout, including progress bars — stderr stays empty.** I verified: redirecting `2>` to a file produced a **0-byte** stderr on a successful run. The `pbr` progress bar writes `ProgressBar::new(...)` over `std::io::Stdout` (`lib.rs`: `progress_bar: Option<ProgressBar<std::io::Stdout>>`) and emits **`\r`-separated frames on the same line**, so raw stdout looks like `1 / 6 [====>---] 16.67 % 502.80/s 0s 2 / 6 [...]`. You must split on `\r` as well as `\n`, or filter lines containing `%`. Open issue **#17 "Make it more pipe-friendly"** requests moving messages to stderr — still open.
2. **Errors also print to stdout, not stderr.** A failed run printed `error: parsing subtitle file '...' failed / caused by: ...` on **stdout** while stderr was empty (`print_error_chain` in `lib.rs` uses `println!`). So a Node integration must capture and inspect **stdout** for both success and failure.

`[FACT]` **Exit codes are honest** — unlike ffsubsync. `main()` is:
```rust
fn main() {
    match run() {
        Ok(_) => std::process::exit(0),
        Err(error) => { print_error_chain(error); std::process::exit(1) }
    }
}
```
Measured: success → `0`; undecodable input → `1`. Since every fallible step in `run()` is `?`-propagated, a non-zero exit really does mean "did not produce output". **This is a genuine advantage over ffsubsync's exit code 0 on failure (Q1.4).**

### Q2.5 Split vs stretch: does it tell us which? — PARTIALLY, and this is the nuance

`[FACT]` **Framerate ratio: reported explicitly, as a separate labelled line.** Live test, input timestamps scaled by 25/23.976:
```
info: 'reference file FPS/input file FPS' ratio is 23.976/25
shifted block of 8 subtitles with length 0:02:25.979 by 0:00:00.001
```
Correctly diagnosed as pure stretch (residual shift 1 ms). The mechanism (`main.rs`) is a brute-force search over a **hardcoded 6-element list**:
```rust
let a = 25.; let b = 24.; let c = 23.976;
let ratios = [a / b, a / c, b / a, b / c, c / a, c / b];
let desc = ["25/24", "25/23.976", "24/25", "24/23.976", "23.976/25", "23.976/24"];
```
scored by `align_nosplit(..., overlap_scoring, ...)` per candidate, keeping the best (`guess_fps_ratio` in `lib.rs`). `[INFER]` This covers the NTSC/PAL cases we care about but **cannot detect an arbitrary drift ratio** (e.g. 30/29.97, or a stretch from a non-standard telecine). ffsubsync's `--gss` continuous golden-section search is strictly more general here.

`[FACT]` **Split misalignment: reported as multiple blocks — this is the real win.** Live test, first 4 cues +2 s and last 4 cues +11 s:
```
info: 'reference file FPS/input file FPS' ratio is 24/23.976
shifted block of 4 subtitles with length 0:00:40.000 by -0:00:02.012
shifted block of 4 subtitles with length 0:01:20.000 by -0:00:11.081
```
**Two lines = two segments.** Counting the `shifted block of` lines gives us exactly the "shift" vs "piecewise" classification the UI wants internally: **1 line ⇒ constant shift; ≥2 lines ⇒ split/interval misalignment.** The grouping is `get_subtitle_delta_groups` in `lib.rs`, which merges *consecutive* cues sharing an identical delta after sorting by start time.

`[FACT]` The same fixture with `--no-split` collapses to one wrong global answer, as expected:
```
shifted block of 8 subtitles with length 0:02:29.000 by -0:00:11.131
```

`[FACT] ⚠ A REAL FALSE POSITIVE I HIT:` note the split run reported `ratio is 24/23.976` — **there was no framerate error in that fixture at all**, only a mid-file jump. The fps guesser runs *before* and *independently of* the split aligner, using a non-split alignment; a split discontinuity makes a slight stretch score better than 1.0, so it spuriously "corrects" framerate and then the split deltas absorb the rest (note the ugly `-0:00:02.012` / `-0:00:11.081` instead of clean 2.000/11.000). `[INFER]` **Implication: alass's fps ratio and split blocks are not independent diagnoses.** If we want to tell the user "stretch" vs "shift" we should not trust `ratio` alone when block count > 1. Mitigation: run a second pass with `-g` (fps guessing disabled) and compare; if the split deltas become clean round numbers with `-g`, the fps report was spurious. `[UNVERIFIED]` I did not test whether `-g` actually cleans up that specific fixture — 2-minute test.

### Q2.6 Speed on a low-power CPU — trivially fast, and needs no audio

`[FACT]` **Subtitle-vs-subtitle mode never touches ffmpeg.** Proof by construction: my entire test suite ran in `alpine:3.20` where `which ffmpeg ffprobe` returns **`NO_FFMPEG_PRESENT`**, and every subtitle-vs-subtitle run succeeded. The extension dispatch in `InputFileHandler::open` returns before `VideoFileHandler::open_video_file` is ever reached, so neither `ALASS_FFMPEG_PATH` nor the `webrtc-vad` code executes. The README's "extraction of the audio takes 10 to 20 seconds" applies **only** to a video reference.

`[FACT]` **Measured wall time, 700-cue / 41-minute synthetic episode** (Docker on amd64 emulation, so a pessimistic number):

| mode | real |
|---|---|
| default (fps guess + split search) | **0.47 s** |
| `--no-split` | **0.20 s** |
| `--no-split -g` | **0.05 s** |

`[INFER]` Even allowing an order of magnitude for a weak router CPU, this is **sub-5-seconds per episode** and utterly dominated by our 14 s local audio decode — irrelevant on the subtitle path. Compare: ffsubsync must boot a Python interpreter and `import numpy` (34 MB of shared objects) before doing any work, which on a slow router with cold page cache is plausibly **the dominant cost** and likely *slower* than alass's entire run. `[UNVERIFIED]` I did not measure Python interpreter+numpy import time on the target hardware; worth a one-line `time python -c "import ffsubsync"` on the router.

`[INFER]` Tuning knobs that matter to us: `-i/--interval` (default 1 ms) trades accuracy for speed — since fansub `.ass` timings are centisecond-resolution anyway (see Q2.8), `-i 10` costs us nothing real. `-O/--speed-optimization` (default 1) is already on.

### Q2.7 `.ass` preservation — CLAIM VERIFIED, WITH THREE REAL CAVEATS

This is the load-bearing claim, so I verified it **twice**: by reading the writer, and by running the binary on a hostile fixture.

**Mechanism** `[FACT]`. `subparse/src/formats/ssa.rs` parses an `.ass` file into a `Vec<SsaFilePart>` where:
```rust
enum SsaFilePart {
    /// Spaces, field information, comments, unimportant fields, ...
    Filler(String),
    TimespanStart(TimePoint),
    TimespanEnd(TimePoint),
    Text(String),
}
```
The doc comment on `SsaFile` states the intent outright:
> *Represents a reconstructable `.ssa`/`.ass` file. All unimportant information (for this project) are saved into `SsaFilePart::Filler(...)`, so a timespan-altered file still has the same field etc.*

Every line that is not a `Dialogue:` inside `[Events]` is swallowed whole as `Filler` (including its newline):
```rust
if section_opt.is_none() || section_opt.iter().any(|s| s != "Events") || !trimmed_line.starts_with("Dialogue:") {
    result.push(SsaFilePart::Filler(line));
    result.push(SsaFilePart::Filler("\n".to_string()));
    continue;
}
```
and even *within* a Dialogue line, all non-Start/End/Text fields, plus the leading whitespace, the literal `"Dialogue:"`, the inter-field commas, and the whitespace trimmed off each field, are individually preserved as `Filler` (`parse_fields` + `trim_non_destructive`, which returns `(leading_ws, content, trailing_ws)` so the whitespace can be re-emitted). Serialization is a pure concatenation:
```rust
let result: String = self.v.iter().map(fn_file_part_to_string).collect();
```
So **structurally, only `TimespanStart`/`TimespanEnd` can change.** Note `Text` is *also* held verbatim and `update_subtitle_entries` only overwrites it `if let Some(ref text) = new_entry_ref.line` — and `main.rs` builds entries via `SubtitleEntry::from(timespan)`, which leaves `line` as `None`. **Text is never rewritten.** Override tags are therefore untouched *as bytes*, not merely "parsed and re-emitted identically".

**Empirical confirmation** `[FACT]`. Fixture: 2,002-byte UTF-8 `.ass` containing `[Script Info]` with two `;` fansub comments (incl. Chinese), `[Aegisub Project Garbage]` (7 keys), `[V4+ Styles]` with a Chinese font name `黑体`, a **`[Fonts]` section with a base64 font blob**, a **`[Graphics]` section with a base64 PNG blob**, `[Events]` with a leading `Comment:` credits line (`翻译：A 校对：B 时轴：C`), 8 `Dialogue:` lines using `\fad`, `\blur`, `\bord`, `\move`, `\pos`, `\t(...)`, `\k`/`\kf` karaoke, `\fade`, `\an8`, `\N`, two different styles, and a trailing `Comment:` marker.

Result: **output was also exactly 2,002 bytes**, and `diff -u` showed **only the 8 `Dialogue:` Start/End fields changed**:
```
-Dialogue: 0,0:00:17.50,0:00:20.50,Default,,0,0,0,,{\fad(150,150)\blur0.5\bord1}第一行字幕
+Dialogue: 0,0:00:10.00,0:00:13.00,Default,,0,0,0,,{\fad(150,150)\blur0.5\bord1}第一行字幕
...
-Dialogue: 0,0:01:17.50,0:01:20.50,Default,,0,0,0,,{\k50}ka{\k30}ra{\k45}o{\kf60}ke
+Dialogue: 0,0:01:10.00,0:01:13.00,Default,,0,0,0,,{\k50}ka{\k30}ra{\k45}o{\kf60}ke
```
`[Fonts]`, `[Graphics]`, `[Aegisub Project Garbage]`, both `;` comments, both `Comment:` lines, styles, and **every override tag byte-identical.** Durations preserved (each cue kept its exact length). **The prior finding is correct. Confidence: HIGH — verified from both the writer source and a live byte-diff.**

But I found three things the claim as stated does **not** cover:

`[FACT] ⚠ CAVEAT 1 — CRLF is destroyed on non-Dialogue lines.` I re-ran with a CRLF + UTF-8-BOM fixture (a very common Chinese fansub shape). Input: 2,048 bytes, **43 CRLF line endings**. Output: 2,010 bytes, **8 CRLF line endings** — and the 8 survivors were *exactly the 8 `Dialogue:` lines*. Cause is visible in `parse_dialog_lines`: the non-Dialogue branch pushes a **hardcoded `"\n"`**
```rust
result.push(SsaFilePart::Filler(line));
result.push(SsaFilePart::Filler("\n".to_string()));   // <-- original newl DISCARDED
```
whereas the Dialogue branch correctly preserves the captured ending: `result.push(SsaFilePart::Filler(newl));`. `get_lines_non_destructive` faithfully returns the real `"\r\n"`, and the non-Dialogue path simply throws it away. **So alass silently converts a CRLF `.ass` into a mixed-ending file (LF everywhere except Dialogue lines).** `[INFER]` Cosmetically harmless to libass/VLC/mpv, but it means **the file is not byte-identical outside the timing fields**, so any "did anything unexpected change?" checksum audit must normalize line endings, and a git-tracked library will show noisy diffs.

`[FACT] ⚠ CAVEAT 2 — the UTF-8 BOM is stripped.` Same test: input began `ef bb bf`, output began `5b 53 63` (`[Sc`). The parser does capture the BOM (`split_bom` → `file_parts.push(SsaFilePart::Filler(bom.to_string()))`) so this *looks* intended to round-trip; `[INFER]` the loss is most likely because the byte→string decode step upstream (`encoding_rs` in `parse_bytes`) already consumed the BOM before `parse_inner` saw it, so `split_bom` found nothing. `[UNVERIFIED]` I did not trace `subparse::parse_bytes`'s decode to prove that specific mechanism, but the *observable outcome* — BOM present in, absent out — is measured fact. Impact: low for players; matters if any downstream tool sniffs the BOM to pick an encoding.

`[FACT] ⚠ CAVEAT 3 — encoding is NOT preserved; output is always UTF-8.` I converted the fixture to **GB18030** and ran it. Two findings:
- **Auto-detect failed outright** on v2.0.0: exit code **1**, message `error: parsing subtitle file 'fx/in_gb.ass' failed / caused by: error while decoding subtitle from bytes to string (wrong charset encoding?)`. (Expected — the "Auto detect subtitle encoding" commit `874f02d9` post-dates this release.)
- With `--encoding-inc gb18030` it worked, **but the output was UTF-8**: output bytes were **byte-for-byte identical to the UTF-8 run's output** (I compared the two output files directly: `True`). `to_data()` ends `Ok(result.into_bytes())` on a Rust `String`, which is UTF-8 by definition — **there is no output-encoding option at all** (no `--output-encoding` in `--help`, cf. ffsubsync which has one, including `--output-encoding same`).

`[INFER]` **This is the sharpest edge for our 68%-`.ass` Chinese-fansub library.** Any GB18030/Big5 file we "correct" gets silently transcoded to UTF-8. That is arguably an *improvement*, but it is a content change beyond timings, it will break any player config assuming a legacy codepage, and it makes "we only touch Start/End" false for those files. We must **detect the encoding ourselves before invoking** (Q3), pass `--encoding-inc` explicitly, and **record the original encoding in the DB** so undo can restore it.

`[FACT] ⚠ CAVEAT 4 — centisecond precision is inherent to `.ass`, and alass truncates into it.` The writer formats with `csecs_comp()`:
```rust
format!("{}{}:{:02}:{:02}.{:02}", sign, p.hours(), p.mins_comp(), p.secs_comp(), p.csecs_comp())
```
and `csecs()` is `self.0 / 10` — **integer division, truncating toward zero**, on a millisecond-resolution internal value. So a computed −7.505 s shift lands as a 10 ms-granular timestamp. This is a property of the `.ass` format (which is centisecond by spec), not a bug, but it means **`.ass` round-trips are only accurate to 10 ms** and re-running alass on an already-corrected file can shift it by up to another centisecond. Relevant to idempotency (Q3).

`[FACT]` Corroborating user report: open issue **#44 "Subtitle styling removed" (2022-07-27)** claims italics were lost. `[INFER]` My byte-diff directly contradicts that for `.ass`→`.ass`. The reporter says "when converting subtitles", and since alass **refuses** to change format, the likely explanation is they went `.ass` → `.srt` by a *different* tool in their chain, or their input was `.srt` with `<i>` tags. I could not confirm — the issue has **zero replies** and no sample file. `[UNVERIFIED]` Treat as unreproduced; my test is the stronger evidence.

### Q2.8 Maintenance reality

`[FACT]` `kaegi/alass`:

| metric | value |
|---|---|
| stars | 1,431 |
| forks | 71 |
| **last commit** | **2021-04-11** (`874f02d9`) |
| **last release** | **v2.0.0, 2019-10-10** |
| open issues | **36** (32 issues + 4 PRs) |
| archived? | **no** (but effectively dormant ~5 years) |
| license | **GPL-3.0** |
| oldest open issue | 2019-09-03 |

`[INFER]` **Unmaintained in practice.** 4 open PRs untouched, issue #56 asking for a release open since Aug 2025, and the `--audio-index` + encoding-detection work sitting unreleased for 5 years. The algorithm is a finished bachelor's thesis (thesis + slides are in-repo), not an evolving project — which is a *mild* comfort: a correct, frozen, dependency-free algorithm ages better than a frozen Python app. But there will be no upstream fix if we find a bug.

`[FACT] ⚠ LICENSE IS GPL-3.0.` `alass-cli` is GPL-3.0; `subparse` is MPL-2.0. `[INFER]` Invoking a GPL binary as a **separate process** via `child_process` is the standard arrangement that avoids derivative-work claims (this is how Bazarr and countless media tools ship it) — but *linking* it (e.g. a native Node addon around `alass-core`) would not. If subtitle-scout is ever distributed non-GPL, keep it strictly at the subprocess boundary and ship the binary as a clearly-separate component. ffsubsync is **MIT**, which is materially more permissive. Flagging as a decision input, not legal advice.

`[FACT]` **Forks — is anything more alive?**

| fork | stars | last push | notes |
|---|---|---|---|
| **`SandroHc/ilass`** | 7 | **2025-12-20** | renamed "Intelligent LASS"; **has real releases: `v2.1.0` (2025-08-09)** with `ilass-2.1.0-linux-x86_64.tar.gz`; **0 open issues** |
| `Rassyan/aligner` | 1 | 2026-04-17 | |
| `friedrich-de/alass-with-fix` | 1 | 2026-06-18 | name implies a specific patch |
| `dyphire/alass` | 23 | 2022-02-02 | most-starred fork, but also stale |

`[INFER]` **`SandroHc/ilass` is the only fork with a plausible maintenance story** — it is 4½ years ahead of upstream and actually cuts releases. It is worth evaluating as our actual dependency, *especially* because it may already contain the released encoding auto-detection and possibly newer targets. `[UNVERIFIED]` I did not read ilass's source, diff it against upstream, verify its CLI is compatible, or check whether it publishes an aarch64 artifact (the v2.1.0 asset list shows only linux-x86_64 and win-x86_64, so probably not). **Test: `ilass --help` diff vs `alass --help`, plus re-run my `.ass` byte-diff fixture against it.** Its 7 stars mean approximately nobody is auditing it, so pinning a checksum is essential.

`[FACT]` **No Node/npm wrapper exists.** I searched the npm registry for `alass` — **zero results**. A broader `subtitle sync align` search returned only unrelated packages (`subtitle`, `srt-webvtt`, etc.). There is no maintained JS binding for ffsubsync either.

`[INFER]` **So: `child_process` the binary directly.** This is the right answer anyway — a wrapper would add a supply-chain dependency to save us ~30 lines of `spawn` + regex, and given both tools' output quirks (alass: everything on stdout incl. errors and `\r` progress frames; ffsubsync: `rich`-wrapped stderr) we want full control over stream handling regardless.

### Q2.9 Verdict table

Legend: ✅ good for us / ⚠ caveat / ❌ bad.

| criterion | **alass** (v2.0.0 binary) | **ffsubsync** (0.5.1) |
|---|---|---|
| **deps footprint** | ✅ **2.9 MB single static musl binary**, zero runtime deps; no ffmpeg needed on sub-vs-sub path (proven in an ffmpeg-less Alpine) | ❌ **~60 MB** `site-packages` + Python interpreter; numpy 34 MB unavoidable; needs ffmpeg in image |
| **sub-vs-sub support** | ✅ yes, extension-dispatched, first-class | ✅ yes, extension-dispatched, first-class |
| **machine-readable offset** | ⚠ no JSON/dry-run (issue #29 open), but **one clean regexable line per segment**, `[-]H:MM:SS.mmm`. ⚠ **all on stdout, incl. errors; `\r` progress frames must be stripped** (issue #17 open) | ⚠ no JSON/dry-run either; offset only via **stderr scraping through `rich`, which hard-wraps and truncates longer messages**. ✅ but the Python **library API returns a dict** — no scraping needed if we embed |
| **exit code trustworthy** | ✅ **yes** — `exit(1)` on any propagated error; measured 0/1 correctly | ❌ **no** — measured exit 0 on low-quality-skip *and* on garbage input |
| **framerate detection** | ⚠ detects & **labels** the ratio (`23.976/25`), but only from a **hardcoded 6-candidate list**; ⚠ **produced a spurious ratio on a split-only fixture** | ✅ same 3 ratio pairs + reciprocals, **plus** a duration-inferred candidate **plus continuous `--gss`**; reports `framerate scale factor` as a number; correctly reported stretch-not-shift in live test |
| **split / interval misalignment** | ✅ **core competency**; `--split-penalty` default **on**; **reports one `shifted block of N ... by X` line per segment** → gives us shift-vs-piecewise classification for free | ⚠ `--split-penalty` exists ("alass-style piecewise") but is **off by default**, and per Q1.6 sub-vs-sub split behaviour was **not empirically verified** |
| **.ass preservation** | ✅ **byte-identical outside Start/End — verified by 2,002→2,002-byte diff** incl. `[Fonts]`/`[Graphics]`/Aegisub garbage/karaoke/`\move`. ⚠ but **CRLF→LF on non-Dialogue lines**, ⚠ **BOM stripped**, ❌ **always transcodes output to UTF-8** | ❌ round-trips through **pysubs2 and drops some sections** (per Q1.3/Q1.5 notes); ✅ but has `--output-encoding same` |
| **encoding control** | ⚠ `--encoding-inc/--encoding-ref` in; ❌ **no output-encoding option at all** (always UTF-8); ❌ auto-detect **absent from the released binary** (in master only) | ✅ `--encoding` (default `infer`), `--reference-encoding`, **`--output-encoding` incl. `same`** |
| **speed, sub-vs-sub** | ✅ **0.47 s** for 700 cues w/ split search; **0.05 s** with `--no-split -g` | ⚠ algorithmically fine, but pays Python + numpy import on every invocation — plausibly the dominant cost on a router `[UNVERIFIED]` |
| **timestamp precision** | ⚠ `.ass` output truncated to **centiseconds** (format-inherent) | ⚠ same format limit applies |
| **maintenance** | ❌ **last commit 2021-04-11, last release 2019-10-10**, 36 open issues, unreleased commits, "request a release" open since 2025. ⚠ Only live fork: `SandroHc/ilass` (releases through 2025-08, 7 stars) | ✅ **actively released — 0.5.1 uploaded 2026-07-24**, ships new features (whisper ref, PGS ref, split aligner, quality gate) |
| **ARM / target coverage** | ❌ **x86-64 only**; no aarch64 release, **not in Alpine/Debian at all**; ARM ⇒ must cross-compile (and `webrtc-vad` C dep must build) | ✅ pure Python + numpy — **numpy ships aarch64 manylinux wheels**, so ARM is a non-issue |
| **license** | ⚠ **GPL-3.0** (keep at subprocess boundary) | ✅ MIT |
| **confidence signal** | ❌ **no score emitted at all** — we get offsets but nothing resembling a quality metric | ❌ emits a score, but it is **unnormalised and demonstrably weak** (positive 33,642 on garbage) — also unusable |

**Verdict** `[INFER]`:

**Use alass as the primary aligner for the subtitle-vs-subtitle path (our 63.7%), with ffsubsync retained for the audio-reference path.** Reasoning:

1. **The `.ass` preservation result decides it.** 68% of our library is styled Chinese-fansub `.ass` with embedded fonts. alass provably leaves those bytes alone; ffsubsync provably does not. For a product whose promise is "one-click correction you can trust", silently mangling a fansub's `[Fonts]` blob is a far worse failure than any of alass's caveats.
2. **Footprint fits the router.** 2.9 MB static vs 60 MB + interpreter, and no ffmpeg needed on the subtitle path.
3. **It gives us the shift-vs-stretch/piecewise signal we want internally** (block count + fps label), and its exit code can actually be trusted.
4. **Neither tool provides a usable confidence score**, so we must build our own metric regardless (per Q1.3). That neutralises ffsubsync's only remaining structural advantage here.
5. Keep ffsubsync installed anyway: it's needed for the **local-audio-decode path** (14 s/episode) where there is no embedded reference track, and it has the more general framerate search (`--gss`) if we ever see a non-standard drift.

**Two blocking unknowns before this is final** (both in Risks): the **aarch64 build**, and whether to depend on upstream `alass` v2.0.0 or the more-alive `SandroHc/ilass`.

## Q3 safe rewrite


_pending_

## Recommended integration plan

_pending_

## Risks & unknowns

_pending_
