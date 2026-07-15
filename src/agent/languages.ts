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
