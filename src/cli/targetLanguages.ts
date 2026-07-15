/** Parses TARGET_LANGUAGES (comma-separated BCP-47 primary codes, e.g. "zh,en") into the array
 *  that drives BOTH scanner.ts's rule 0 same-audio-language skip gate AND its rule 3 disk-sidecar
 *  tag detection (scanner.ts's classifyItemDetailed unifies the two — one target-language set
 *  serves both jobs, A4). Trims entries and drops empties so "zh, en ,," doesn't produce stray
 *  blank targets. Defaults to ['zh'] when unset/empty — the historical single-target-language
 *  default (skipChineseOrigin:true was the only shipped configuration pre-A4). */
export function parseTargetLanguages(raw: string | undefined): string[] {
  const languages = (raw ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0)
  return languages.length > 0 ? languages : ['zh']
}

/**
 * Resolves the effective target-language set scanLibrary/Watcher should gate + sidecar-detect
 * against, folding in the legacy SKIP_CHINESE_ORIGIN compat flag (pre-generalization: a
 * standalone boolean that gated ONLY the zh same-audio-language skip, scanner.ts rule 0/1/1b).
 *
 * Mapping (locked by targetLanguages.test.ts):
 * - SKIP_CHINESE_ORIGIN unset or 'true' (default): no-op — TARGET_LANGUAGES passed through
 *   unchanged (default ['zh'], byte-compatible with pre-A4 skipChineseOrigin:true).
 * - SKIP_CHINESE_ORIGIN=false: historical opt-out ("still create zh subtitle tasks for
 *   Chinese-origin content"). Post-A4 there is no separate gate-only toggle — one targetLanguages
 *   list now drives BOTH the origin gate and rule-3 disk-sidecar tag detection (scanner.ts) — so
 *   this is implemented by dropping 'zh' from that shared list. Accepted trade-off: this also
 *   turns off rule-3 zh disk-sidecar auto-detection while the flag is set. That's fine — this
 *   flag was always a narrow legacy escape hatch, not the primary config surface (TARGET_LANGUAGES
 *   is); a user who wants both the opt-out AND zh disk-sidecar detection back should stop using
 *   this compat flag and manage TARGET_LANGUAGES directly.
 * - If 'zh' isn't even in TARGET_LANGUAGES to begin with (e.g. TARGET_LANGUAGES=en),
 *   SKIP_CHINESE_ORIGIN=false is a no-op (nothing to drop) — resolves the "genuinely ambiguous"
 *   SKIP_CHINESE_ORIGIN=false + TARGET_LANGUAGES=en case from the least-surprising angle: the
 *   flag only ever concerned zh, so if zh isn't a target there's nothing for it to opt out of.
 */
export function resolveTargetLanguages(env: { TARGET_LANGUAGES?: string; SKIP_CHINESE_ORIGIN?: string }): string[] {
  const targetLanguages = parseTargetLanguages(env.TARGET_LANGUAGES)
  const skipChineseOrigin = (env.SKIP_CHINESE_ORIGIN ?? 'true') !== 'false'
  return skipChineseOrigin ? targetLanguages : targetLanguages.filter(l => l !== 'zh')
}
