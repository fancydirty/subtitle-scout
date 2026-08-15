# Frontend polish audit (2026-08-15)

Branch: `polish/frontend-mental-load`. Scope: find UI content that leaks internal
implementation details or breaks the product's own language contract, and remove it
for the human user. Method: mechanical JSX-text scan (`tsc` AST walk over
`web/src/**/*.tsx`), i18n key drift scan, and test audit.

## Baseline decisions preserved

- The checkpoint commit carries the in-flight auth redo (db v40), single-select
  language wizard, and removal of the decision-history section from the activity
  page. All suites green before this pass.
- DESIGN.md's technical mono readouts (topbar freshness, paths, decision words) are
  kept. They are intentional product decisions; this pass only removes drift from
  the language contract, not the contract itself.
- `/api/v2/runs` stays available; it simply no longer has a daily-driver consumer.

## Findings

### P0-1 Settings chrome is hardcoded English
`SettingsTabsPage` renders `General / Providers / Media / Security / Advanced`,
badges `Not configured`, and `SettingsCard` renders `Configured / Not configured /
Environment`. A Chinese browser gets an English settings shell while every section
inside is Chinese. This is the largest mixed-language surface in the app.

### P0-2 TranslateCard is an English island
Title, description, toggle label, segmented options, model line, field errors,
Save/Test, and the confirmation dialog are hardcoded English. The surrounding
ProviderCard/Zimuku card is localized, so the page reads in two languages.

### P0-3 subhd/zimuku toggle card is English
`Chinese subtitle source`, `Enable subhd`, `No API key required — works out of the
box` are hardcoded even though identical concepts exist elsewhere in the table.

### P0-4 Shared dialog/loading vocabulary is missing
`Cancel` is a literal in four destructive dialogs, `Save`/`Clear` literals in the
vision card, and `loading…` is a literal in five sections while an equivalent key
already exists in some places.

### P0-5 Internal secret names are user labels
Provider rows display `TMDB_API_KEY`, `ASSRT_TOKEN`, `TRANSLATE_BASE_URL`, etc.
Those are storage/env identifiers, not product labels. They leak deployment
internals into the primary configuration surface.

### P0-6 Scan interval is asked in milliseconds
`scan_interval_ms` is rendered as a raw millisecond integer with placeholder
`900000`. The only correct answer a human can type is the internal storage unit;
the UI should ask in minutes and convert at the boundary.

### P0-7 Backend English errors surface into Chinese UI
`path is not readable (permission denied?)`, `not a media root`, `path does not
exist`, etc. are appended to Chinese prefixes in settings/dir-browser/remove-root.
They are correct technical strings, but the Chinese presentation should map the
known set to Chinese while preserving the raw string for unknown errors and logs.

### P0-8 Login throttling was misreported
`LoginPage` collapsed every non-network failure into "wrong password", including the
backend's 429 throttling response. A locked-out user was being told their password
was wrong. The 429 path now has its own message.

### P0-9 Command trigger overpromised search
`Find anything` / `搜索` opened a four-item page switcher, not a search box.
Trigger is now `Go to…` / `跳转`, matching what the panel can actually do.

### P1-0 Topbar freshness line
`watching /Volumes/… · scanned 2m ago · 531 files` is intentionally technical
(DESIGN.md §0/§7) and is not changed. The `offline` / `loading…` fallback words
are translated because those are state labels, not the technical readout.

### P1-1 Advanced/deploy tab
Raw env keys stay visible in the Advanced tab, but the tab and its badges are now
localized. This keeps the power-user surface while removing accidental exposure
from the default visual language.

## Implemented in this pass

- Added `common_*`, settings tab/badge, TranslateCard, secret-label and a11y keys to
  both i18n tables; replaced every hardcoded settings chrome string.
- Added `settings/secretLabels.ts`: `SecretName -> TKey` single map; ProviderCard and
  TranslateCard render human labels and keep the raw env key only as a tooltip.
- Scan interval is now displayed/edited in minutes; conversion to `scan_interval_ms`
  happens only at the PUT boundary.
- Added `lib/errorText.ts`: zh mappings for the known backend error contract.
  en and unknown errors are passed through unchanged. Wired into all settings pages,
  wizard save/test paths, EngineBanner, and the three data pages.
- Login now distinguishes 429 throttling from invalid credentials.

## Round 2 — user-corrected direction (2026-08-15)

The first pass still kept too much agent-facing chrome. The user decision is now
the single standard: **Jellyfin/Jellyseerr/Plex logic for non-technical humans**.

- Topbar technical readout (`watching /path · scanned … · files`) removed;
  `workflow/pending` polling removed from the shell.
- cmd-k page switcher removed entirely (it had no search capability).
- Advanced/Deploy tab removed; env source labels, raw env keys, and deploy
  readout removed from the UI. Configured is just configured.
- Media folders are a plain Unix-style path input (`/Users/me/Movies`), not a
  directory browser. Submit validates existence; a missing path shows
  "directory does not exist" and keeps the input value.
- Backend policy changed: settings page is the only source for settings,
  provider credentials, provider flags, target languages, and media roots.
  `makeAdapterConfigResolver` / setup status now ignore env. env helpers stay
  only for one-shot CLI commands without a db.

## Verification

- `cd web && npm test` — 82 files / 932 tests green.
- `npm test` — 145 files / 3328 tests green (plus 3 skipped / 27 skipped).
- `npm run check` — full repo typecheck green.
- `cd web && npm run build` — production build green.
