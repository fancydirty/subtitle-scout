# v3 find-subtitle worker — live acceptance checklist

Run manually, NOT part of `npm test`/CI. Requires: a real `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`
(see `.env.example`), at least one real provider credential (`ASSRT_TOKEN` or
`OPENSUBTITLES_API_KEY` or `ZIMUKU_ENABLED=true`), and a real media directory containing at
least one video file genuinely missing a Chinese subtitle that is known to be findable.

1. [ ] Pick one real episode or movie file with NO existing Chinese subtitle, on a real subtitle
       site, that a human has manually confirmed is findable (search the site yourself first).
2. [ ] Run `npx tsx scripts/live-accept-find-subtitle.ts --video <path> --title <title> --year <year> [--season N --episode N]`.
3. [ ] Confirm the script's printed decision is `installed` (or a defensible `no_safe_match`/
       `retry_later` with a reason a human would find reasonable on inspection).
4. [ ] If `installed`: confirm a real `.srt`/`.ass` file now sits next to the video, open it,
       and manually confirm it is really the correct episode/movie's Chinese subtitle (not just
       "a file exists").
5. [ ] Confirm the media directory's `.subtitle-staging/<jobId>/` directory is gone after the
       run (cleanup on both success and failure paths).
6. [ ] Note in this file (as a dated log entry appended below) the step count the run took
       (`stepCount` printed by the script) — this is raw data for eventually setting a
       production `stepCountIs()` cap; the spec is explicit that no cap is set until enough
       real runs have been observed.
7. [ ] Re-run once against a video that should legitimately produce `no_safe_match` (nothing
       findable) and confirm no file gets installed and the reason is honest, not a hopeful guess.

## Known deviation from the original plan draft

`scripts/live-accept-find-subtitle.ts`'s adapter construction (`buildAdapters()` inside the
script) is NOT imported from `src/cli/subtitle-fetch.ts` even though that file already has an
equivalent (unexported) `buildAdapters()`. `subtitle-fetch.ts` calls `main().catch(...)`
unconditionally at module scope with no import guard — importing anything from it would run its
CLI `main()` (parsing `process.argv`, hitting the network) as a side effect of merely loading
this script. The script below mirrors the same real client construction
(`AssrtClient`/`OpenSubtitlesClient`/`ZimukuClient` + their adapter factories) instead of
reimporting it.

The plan's original literal Task 7 script also called `new ZimukuClient()` with zero arguments
and `new OpenSubtitlesClient({ apiKey: ... })` with only `apiKey` — neither typechecks against
the real constructors (`ZimukuClientOpts` requires `sessionStore`+`solve`; `OsClientOpts`
requires `appUserAgent`), confirmed by reading `src/adapters/providers/zimuku.ts` and
`src/adapters/providers/opensubtitles.ts` directly. Fixed in the script committed here.

## Run log

(append one dated entry per run: date, scenario, decision, step count, pass/fail)
