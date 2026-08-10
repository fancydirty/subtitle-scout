# Subtitle Inspector UI/UX Research

**Date:** 2026-07-29
**Status:** IN PROGRESS
**Goal:** Design a subtitle inspector for `subtitle-scout` — verify a downloaded/translated subtitle is correct without playing the video. Entry point lives in the episode list/grid.

Labels used below: `[FACT]` = sourced/verified, `[INFERENCE]` = my reasoning, `[UNVERIFIED]` = plausible but not confirmed.

## Progress log

- `2026-07-29 T0` — File created with skeleton. Nothing researched yet.
- `T1` — **Task 5 DONE (codebase read, highest-confidence section).** Read `web/DESIGN.md` (the binding style contract, 118 lines of 铁律), `theme/scout.ts`, `theme/scout.css`, `styles.css` (1122 lines), `EpisodeRow`, `EpisodeCell`, `SeasonAccordion`, `SeasonGridBody`, `PosterCard`, `FactsRail`, `SeriesHero`, `RemoveRootDialog`, `RerunDialog`, `CommandK`. Three decisive discoveries recorded in §5: (1) DESIGN.md §5 **mandates fixed right panel, explicitly forbids modal**; (2) Astryx `AlertDialog` has **no children slot** — inspector physically cannot be a dialog; (3) precedents already exist for both the right panel (`.wf-rundetail-panel`) and hover-revealed row actions (`.wf-pending-row-actions`). Note: codebase is ~1.8K lines of library+shell TSX, not the ~10K the brief implied.
- Next: search batches for tasks 1–4.

## Executive summary

_TBD_

## 1. Affordance patterns for inspect/verify in dense lists

_TBD_

## 2. GitHub repos with subtitle / timeline-inspection UI

_TBD_

## 3. JASSUB / libass-wasm React integration

_TBD_

## 4. Timing-alignment score visualization

_TBD_

## 5. Design-system-consistent component choices

_TBD_

## Recommended design

_TBD_

## Rejected alternatives

_TBD_

## Open questions

_TBD_
