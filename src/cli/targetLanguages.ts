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
 *
 * dashboard G4: `settingsTargetLanguages` is the DB settings 表 target_languages 键（行为级设置，
 * dashboard 里可改，优先于部署层的 TARGET_LANGUAGES env）——非空字符串时替代
 * env.TARGET_LANGUAGES 参与下面的解析；null/undefined/空字符串（"未设置"）都沿用 env，不当作
 * "覆盖成空"（否则一次误清空的 PUT 会把行为悄悄打回默认 zh，而不是保留部署层配置）。
 * SKIP_CHINESE_ORIGIN 的交互逻辑完全不变，只是被解析的原始串换了来源。
 */
export function resolveTargetLanguages(
  env: { TARGET_LANGUAGES?: string; SKIP_CHINESE_ORIGIN?: string },
  settingsTargetLanguages?: string | null,
): ResolvedTargetLanguages {
  const raw = settingsTargetLanguages ? settingsTargetLanguages : env.TARGET_LANGUAGES
  const targetLanguages = parseTargetLanguages(raw)
  const skipChineseOrigin = (env.SKIP_CHINESE_ORIGIN ?? 'true') !== 'false'
  return {
    targetLanguages,
    originSkipLanguages: skipChineseOrigin ? targetLanguages : targetLanguages.filter(l => l !== 'zh'),
  }
}
