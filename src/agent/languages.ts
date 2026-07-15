/** Tiny BCP-47 primary-language-code → human-readable name lookup, used to interpolate the
 *  find-subtitle worker's prompt with a readable target language (findSubtitleWorker.ts) instead
 *  of a bare code. Deliberately NOT exhaustive — unknown codes fall back to the code itself, which
 *  is still a legible instruction to the model (e.g. "target subtitle language: fr"). */
const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
}

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code
}

/** Historical Chinese sidecar filename tags (scanner.ts's on-disk detection, pre-generalization).
 *  Kept verbatim — do not change its contents; other modules (e.g. scanner.ts's zh-Hans/zh-Hant
 *  refinement table) key off these exact tags. */
const CHINESE_SIDECAR_TAGS = ['zh-Hans', 'zh-Hant', 'zh', 'chs', 'cht', 'chi', 'zho']

/** BCP-47 primary language code → sidecar filename tags that count as that language on disk
 *  (used by scanner.ts's on-disk subtitle detection). Deliberately NOT an exhaustive ISO 639-2
 *  registry — just a cheap table for the languages already named in LANGUAGE_NAMES above, plus
 *  their common ISO 639-2/T 3-letter form. Unknown codes fall back to [code], which is still
 *  correct for the common case of a sidecar tagged with the bare 2-letter code. */
const LANGUAGE_TAGS: Record<string, string[]> = {
  zh: CHINESE_SIDECAR_TAGS,
  en: ['en', 'eng'],
  ja: ['ja', 'jpn'],
  ko: ['ko', 'kor'],
}

export function tagsForLanguage(code: string): string[] {
  return LANGUAGE_TAGS[code] ?? [code]
}

/** Chinese-language codes/aliases langOf() folds into 'zh' — kept in lockstep with
 *  daemon/triggers.ts's isChineseLang (TMDB original_language: 'zh'/'cn') and CHINESE_LANG_TAGS
 *  (embedded MediaStream Language field: chi/zho/chs/cht/zh) so the generalized same-audio-language
 *  skip gate (v2/scanner.ts classifyItemDetailed rule 0) classifies exactly the same origin values
 *  as Chinese that the pre-generalization code did. 'cmn' (ISO 639-3 Mandarin) is included for
 *  robustness against origin signals that don't stick to TMDB's plain ISO-639-1 'zh' — it's not
 *  currently produced by any resolver in this codebase, but normalizing it costs nothing. */
const ZH_ORIGIN_CODES = new Set(['zh', 'cn', 'chi', 'zho', 'cmn'])

/** Normalizes an origin-language value (TMDB original_language, or any similarly-shaped signal)
 *  to a BCP-47-ish primary language code comparable against FindSubtitleTask.targetLanguage /
 *  TARGET_LANGUAGES entries (scanner.ts's classifyItemDetailed rule 0: `targetLanguages.includes(
 *  langOf(originLang))` → ignored). Case/region-insensitive — drops a `-XX`/`_XX` region or script
 *  suffix before matching, so 'zh-CN', 'zh_TW', 'ZH' all normalize to 'zh'. Unknown codes fall back
 *  to their lowercased primary subtag, which is already correct for the common case (origin
 *  resolvers return plain ISO-639-1 codes like 'en'/'ja'/'ko'). Empty/nullish input returns ''
 *  (never equals a real target language code, so it never matches by accident). */
export function langOf(code: string | null | undefined): string {
  if (!code) return ''
  const primary = code.toLowerCase().split(/[-_]/)[0]
  return ZH_ORIGIN_CODES.has(primary) ? 'zh' : primary
}
