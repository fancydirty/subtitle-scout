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
