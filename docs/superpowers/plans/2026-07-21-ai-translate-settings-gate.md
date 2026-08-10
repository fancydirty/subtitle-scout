# AI Translate Settings Gate + 2 Fixes — Implementation Plan

> Goal: `ai_translate_enabled` (default off) gates daemon auto-translate; CLI exits after write; jimaku first for ja searches.

## Task 1: settings key + zod + buildSettings

**Files:** `src/dashboard/apiV2.ts`, `src/dashboard/apiV2.test.ts`, `web/src/api/types.ts`

- [ ] Add `'ai_translate_enabled'` to SETTINGS_KEYS; schema `z.enum(['true','false'])`
- [ ] Add key to web `SettingsKey` union
- [ ] Test: write true/false → buildSettings reflects; bad value → 400

## Task 2: daemon gate

**Files:** `src/cli/index.ts`

- [ ] `dispatchTranslate: (tryAutoTranslateCfg() && settingsRepo.get('ai_translate_enabled')==='true') ? ... : undefined`
- [ ] worker claim path: keep `tryAutoTranslateCfg` only (no settings read)

## Task 3: BehaviorSection switch + i18n

**Files:** `web/src/settings/BehaviorSection.tsx`, `web/src/i18n/*`, `web/src/settings/BehaviorSection.test.tsx`

- [ ] Add `AiTranslateRow` switch committing `ai_translate_enabled` ('true'/'false')
- [ ] i18n keys: label/description note (default off; needs TRANSLATE_*; burns quota)
- [ ] Test: row renders, PUT on toggle

## Task 4: CLI exit fix

**Files:** `src/cli/translateItemCommand.ts`

- [ ] `finally { db?.close() }`; after final log, `process.exit(code)` immediately
- [ ] Keep daemon untouched

## Task 5: jimaku-first for ja in runSearch

**Files:** `src/cli/fetchLib.ts`, `src/cli/fetchLib.test.ts`

- [ ] After dedup: if languages has ja prefix, stable-partition jimaku candidates to front
- [ ] Tests: ja order; en/zh unchanged

## Task 6: full suite + commit

- [ ] `npx vitest run` + web tests + tsc; commit (no public push)
