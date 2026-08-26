/** 设置页目标语言下拉的**唯一真值**（web/src/settings/BehaviorSection.tsx 按此顺序渲染）。
 *
 *  为什么这个常量住在后端、由前端 import，而不是反过来：本文件的两张码表（LANGUAGE_NAMES /
 *  LANGUAGE_TAGS）是消费方，二者都必须逐一覆盖它；前端只有一个渲染方。让真值靠近约束最强的
 *  一侧，对账守卫才能从两头 import 同一份东西。
 *
 *  C51（2026-08-26 实案）：设置页早就能选 pt，而下面两张表只有 zh/en/ja/ko，两处都**静默降级**
 *  —— languageName('pt') 返回裸码喂给 worker prompt，tagsForLanguage('pt') 只探 `.pt.srt`。
 *  既不报错也找不到字幕。opensubtitlesAdapter.ts:52-65 已点名病根是「设置页选项集与码表之间没有
 *  对账机制」，本常量 + languages.test.ts / BehaviorSection.test.tsx 的双向守卫是那一刀。
 *  往这里加第 11 个语言而不补两张表 → 测试红，不再是运行时空集。 */
export const SELECTABLE_TARGET_LANGUAGES = [
  'zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'it',
] as const

/** Tiny BCP-47 primary-language-code → human-readable name lookup, used to interpolate the
 *  find-subtitle worker's prompt with a readable target language (findSubtitleWorker.ts) instead
 *  of a bare code. Must cover SELECTABLE_TARGET_LANGUAGES exhaustively (guarded by
 *  languages.test.ts) — the fallback below stays only for non-selectable codes reaching it from
 *  origin-language signals, not as a license to leave a settings option unnamed. */
export const LANGUAGE_NAMES: Record<string, string> = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  ru: 'Russian',
  it: 'Italian',
}

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code
}

/** Historical Chinese sidecar filename tags (originally scanner.ts's on-disk detection,
 *  pre-generalization; scanner.ts itself has since been deleted in the old-pipeline retirement —
 *  today's on-disk sidecar detection lives in files/sidecar.ts, which keys off this same table via
 *  tagsForLanguage below). Kept verbatim — do not change its contents. Exported for reuse in
 *  translateItemCommand.ts (C6: eliminate duplicate CHINESE_TAGS definition). */
export const CHINESE_SIDECAR_TAGS = ['zh-Hans', 'zh-Hant', 'zh', 'chs', 'cht', 'chi', 'zho']

/** BCP-47 地区变体(P0,zimuku 单源大考前置修复,2026-07-19)。A2 泛化后 agent 可自由选
 *  langTag(findSubtitleWorker H2 白名单),生产实证装出 `.zh-CN.srt` 而领养臂全瞎(Witch
 *  Watch E02/05/11/20 + Adam's E05:文件在、内容对、subtitles 零行、状态停 unavailable);
 *  NAS #recycle 里的 Bazarr 时代存量则是小写 `.zh-cn.srt`。探测机制是"构造
 *  `<base>.<tag><ext>` 后 fileExists"(files/sidecar.ts),在大小写敏感 FS 上不存在机制性
 *  不分大小写,故两种真实世界大小写形态都显式枚举。排在历史 tag 集之后——findExternalSidecar
 *  按序首中即返,规范装机形态(zh-Hans/zh-Hant)并存时继续优先。 */
const CHINESE_BCP47_REGION_TAGS = ['zh-CN', 'zh-cn', 'zh-TW', 'zh-tw', 'zh-HK', 'zh-hk', 'zh-SG', 'zh-sg']

/** BCP-47 primary language code → sidecar filename tags that count as that language on disk
 *  (used by files/sidecar.ts's on-disk subtitle detection — originally scanner.ts's, before that
 *  module was deleted in the old-pipeline retirement). Deliberately NOT an exhaustive ISO 639-2
 *  registry — just a cheap table for the languages already named in LANGUAGE_NAMES above, plus
 *  their common ISO 639-2/T 3-letter form. Unknown codes fall back to [code], which is still
 *  correct for the common case of a sidecar tagged with the bare 2-letter code — but a code that is
 *  selectable in settings must never rely on that fallback (guarded by languages.test.ts): a bare
 *  2-letter probe alone misses every `.por.srt` / `.spa.srt` an existing library already has.
 *
 *  pt 额外枚举 pt-BR/pt-PT 两个地区形态（含小写）：同 zh 的 CHINESE_BCP47_REGION_TAGS 论证——
 *  探测机制是「构造 `<base>.<tag><ext>` 后 fileExists」，大小写敏感 FS 上不存在机制性不分大小写。
 *  巴西/欧洲葡语在真实字幕站是分开发布的（OS 码表里也根本没有裸 'pt'，见
 *  opensubtitlesAdapter.ts:44-50 的 OS_LANGUAGE_MAP），落盘形态因此以地区码为主。 */
export const LANGUAGE_TAGS: Record<string, string[]> = {
  zh: [...CHINESE_SIDECAR_TAGS, ...CHINESE_BCP47_REGION_TAGS],
  en: ['en', 'eng'],
  ja: ['ja', 'jpn'],
  ko: ['ko', 'kor'],
  es: ['es', 'spa'],
  fr: ['fr', 'fra', 'fre'],
  de: ['de', 'deu', 'ger'],
  pt: ['pt', 'por', 'pt-BR', 'pt-br', 'pt-PT', 'pt-pt'],
  ru: ['ru', 'rus'],
  it: ['it', 'ita'],
}

export function tagsForLanguage(code: string): string[] {
  return LANGUAGE_TAGS[code] ?? [code]
}

/** Chinese-language codes/aliases langOf() folds into 'zh'. Historically kept in lockstep with
 *  daemon/triggers.ts's isChineseLang (TMDB original_language: 'zh'/'cn') and CHINESE_LANG_TAGS
 *  (embedded MediaStream Language field: chi/zho/chs/cht/zh) — both daemon/triggers.ts and the
 *  Jellyfin-era same-audio-language skip gate it fed have since been deleted (de-Jellyfin-ization).
 *  Today's equivalent is v2/ingest.ts's classify() rule 0 (origin_lang gate), which calls langOf()
 *  below the same way. 'cmn' (ISO 639-3 Mandarin) is included for robustness against origin
 *  signals that don't stick to TMDB's plain ISO-639-1 'zh' — it's not currently produced by any
 *  resolver in this codebase, but normalizing it costs nothing. */
const ZH_ORIGIN_CODES = new Set(['zh', 'cn', 'chi', 'zho', 'cmn'])

/** Normalizes an origin-language value (TMDB original_language, or any similarly-shaped signal)
 *  to a BCP-47-ish primary language code comparable against FindSubtitleTask.targetLanguage /
 *  TARGET_LANGUAGES entries (today: v2/ingest.ts's classify() rule 0 — `originSkipLanguages.includes(
 *  langOf(originLang))` → ignored; the same shape lived in scanner.ts's classifyItemDetailed rule 0
 *  before that module was deleted in the old-pipeline retirement). Case/region-insensitive — drops
 *  a `-XX`/`_XX` region or script suffix before matching, so 'zh-CN', 'zh_TW', 'ZH' all normalize to
 *  'zh'. Unknown codes fall back to their lowercased primary subtag, which is already correct for
 *  the common case (origin resolvers return plain ISO-639-1 codes like 'en'/'ja'/'ko'). Empty/nullish
 *  input returns '' (never equals a real target language code, so it never matches by accident). */
export function langOf(code: string | null | undefined): string {
  if (!code) return ''
  const primary = code.toLowerCase().split(/[-_]/)[0]
  return ZH_ORIGIN_CODES.has(primary) ? 'zh' : primary
}
