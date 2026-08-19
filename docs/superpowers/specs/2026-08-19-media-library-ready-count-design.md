# Media Library Ready Count Design

**Date:** 2026-08-19
**Status:** Approved for implementation

## Problem

The media-library poster list currently uses two presentation counters as if they
were a complete coverage model:

```text
covered = subtitledEpisodeCount + embeddedEpisodeCount
```

That is false when the target language is also the work's origin language. The
detail page correctly reports `origin-skip`, but the list page does not expose
that state as a separate counter.

Production evidence with target language `en`:

| Work | Local cells | Embedded | Origin-skip | Current list |
| --- | ---: | ---: | ---: | --- |
| Young Sheldon | 16 | 0 | 16 | `0/16` |
| IT: Welcome to Derry | 8 | 7 | 1 | `7/8` |
| Peacemaker | 16 | 8 | 8 | `8/16` |
| Invasion | 30 | 30 | 0 | `30/30` |

The prior patch subtracted `origin-skip` from `uncoveredEpisodeCount`, but did
not add it to the list numerator. That produced an internally inconsistent
state: `ready + uncovered < local cells`.

## First-Principles Model

The list page must present a partition of local episode cells. Each cell belongs
to exactly one visible bucket, using this precedence:

1. `subtitled`: the aggregate dot is green because a target-language sidecar is present.
2. `embedded`: the aggregate dot is blue because a target-language embedded track is present and no sidecar won.
3. `originLanguage`: the aggregate episode state is `origin-skip`, with no sidecar and no embedded target-language track.
4. `uncovered`: none of the above is true and the cell still needs attention.

The `extra` state is not an episode coverage bucket. Existing behavior keeps
mechanical extras out of `unplacedFileCount`; this change does not make extras
appear as native-language episodes. If a future production case places an extra
in a numbered cell, it must be handled as a separate data-model change rather
than silently counted as ready.

The backend returns the resulting counters directly:

```text
readyEpisodeCount = subtitledEpisodeCount
                    + embeddedEpisodeCount
                    + originLanguageEpisodeCount

```

For normal numbered episode cells, the conservation rule is:

```text
readyEpisodeCount + uncoveredEpisodeCount = onDiskEpisodeCount
```

The frontend must not reconstruct either equation.

## API Contract

Extend `MediaLibraryItemDTO` with:

- `readyEpisodeCount`: total local cells that need no subtitle work.
- `originLanguageEpisodeCount`: local cells resolved because the work origin language equals the target language, without a sidecar or embedded target-language track.

Keep the existing fields and meanings:

- `subtitledEpisodeCount`: target-language sidecar cells only.
- `embeddedEpisodeCount`: target-language embedded-track cells only.
- `uncoveredEpisodeCount`: local cells still needing subtitle attention.

The response shape validator, backend fixtures, and frontend type contract must
include the two new numeric fields. The endpoint remains synchronous and read
only. Target language continues to come from `settingsRepo` through
`resolveTargetLanguages`, so the list and detail pages use the same target.

## Frontend Presentation

The card changes from `字幕 X/Y` to `就绪 X/Y` (English: `Ready X/Y`). The
numerator is `readyEpisodeCount`, not a browser-side sum.

The statistics row displays:

- `已下载 N` / `Downloaded N` always;
- `自带 N` / `Built-in N` only when `embeddedEpisodeCount > 0`;
- `原生 N` / `Native N` only when `originLanguageEpisodeCount > 0`.

The progress bar gets a third segment for native-language cells. Existing
green and blue segments retain their meanings; the native segment uses the
existing `origin-skip` visual token from the detail state palette. The bar is
decorative and the text counters remain the accessible source of truth.

The uncovered warning remains driven solely by the backend's
`uncoveredEpisodeCount`. A fully ready work has no warning line. A work with
origin-language cells but no subtitle files must still show `Downloaded 0` and
`Native N`; it must never call those cells downloaded or built-in.

## Tests and Acceptance

Backend tests must cover:

- 16 `origin-skip` cells with no embedded tracks -> ready 16, native 16, embedded 0, uncovered 0.
- 7 embedded plus 1 origin-skip -> ready 8, embedded 7, native 1, uncovered 0.
- 8 embedded plus 8 origin-skip -> ready 16, embedded 8, native 8, uncovered 0.
- 30 embedded cells -> ready 30, embedded 30, native 0, uncovered 0.
- A covered cell takes precedence over embedded/native display buckets.
- A target-language embedded track takes precedence over origin-native display bucket.
- Existing uncovered, movie, duplicate-directory, and target-language regression tests remain green.

Frontend tests must cover:

- The numerator reads `readyEpisodeCount` from the DTO.
- Native statistics render only when positive and do not alter downloaded/built-in counts.
- The three visible buckets render together without a second frontend calculation.
- The progress bar includes the native segment and remains width-safe at zero values.
- Missing new fields are rejected by the API shape contract, matching other arithmetic DTO fields.

Verification consists of root tests, web tests, TypeScript checks, and a
production API comparison for the four evidence works. The production result
must satisfy the conservation equation and match each detail page's per-cell
states.
