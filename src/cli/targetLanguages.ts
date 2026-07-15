/** Parses TARGET_LANGUAGES (comma-separated BCP-47 primary codes, e.g. "zh,en") into the array
 *  of target subtitle languages. Trims entries and drops empties so "zh, en ,," doesn't produce
 *  stray blank targets. Defaults to ['zh'] when unset/empty — the historical single-target
 *  default (zh was the only shipped configuration pre-A4). Never returns an empty array, so a
 *  primary target (`targetLanguages[0]`) always exists for single-valued consumers
 *  (FindSubtitleTask.targetLanguage). */
export function parseTargetLanguages(raw: string | undefined): string[] {
  const languages = (raw ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0)
  return languages.length > 0 ? languages : ['zh']
}

/** Two distinct jobs one language list used to conflate (A4 spec-review fix):
 *  - `targetLanguages`: which subtitle languages we hunt and count as coverage — drives scanner
 *    rules 2/3 (embedded-stream / disk-sidecar detection) and task construction (the worker's
 *    target language). NEVER weakened by SKIP_CHINESE_ORIGIN.
 *  - `originSkipLanguages`: which original-AUDIO languages suppress an item entirely — drives
 *    scanner rule 0 (authoritative TMDB origin gate) and its Chinese heuristic fallbacks
 *    (rules 1/1b), plus the old-pipeline watcher's isChineseOrigin gate. */
export interface ResolvedTargetLanguages {
  targetLanguages: string[]
  originSkipLanguages: string[]
}

/**
 * Resolves TARGET_LANGUAGES plus the legacy SKIP_CHINESE_ORIGIN compat flag into the two lists
 * above. Mapping (locked by targetLanguages.test.ts):
 * - SKIP_CHINESE_ORIGIN unset or 'true' (default; anything but the literal 'false', matching the
 *   old `!== 'false'` parsing): both lists = parsed TARGET_LANGUAGES (default ['zh'] — byte-
 *   compatible with pre-A4 skipChineseOrigin:true).
 * - SKIP_CHINESE_ORIGIN=false: historical opt-out = "don't SKIP Chinese-origin content" — which
 *   is NOT "zh is not a target". Pre-A4 the flag never affected zh coverage detection (embedded
 *   streams / disk sidecars still counted as covered, preventing endless refetch of already-
 *   subtitled items), so only originSkipLanguages loses 'zh'; targetLanguages is untouched.
 * - If 'zh' isn't in TARGET_LANGUAGES to begin with (e.g. TARGET_LANGUAGES=en),
 *   SKIP_CHINESE_ORIGIN=false is a no-op (nothing to drop) — the least-surprising reading of
 *   that combination: the flag only ever concerned zh, so there's nothing for it to opt out of.
 */
export function resolveTargetLanguages(
  env: { TARGET_LANGUAGES?: string; SKIP_CHINESE_ORIGIN?: string },
): ResolvedTargetLanguages {
  const targetLanguages = parseTargetLanguages(env.TARGET_LANGUAGES)
  const skipChineseOrigin = (env.SKIP_CHINESE_ORIGIN ?? 'true') !== 'false'
  return {
    targetLanguages,
    originSkipLanguages: skipChineseOrigin ? targetLanguages : targetLanguages.filter(l => l !== 'zh'),
  }
}
