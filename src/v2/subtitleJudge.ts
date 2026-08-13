// src/v2/subtitleJudge.ts：需字幕判定（新架构阶段 3，纯机械无 LLM）。
// spec: docs/design/2026-08-08-PIPELINE-SPEC.md 裁决 D8 / 缺口 C27
//
// 规则（身份确定后自动跑）：
//  0. 文件名命中机械特典标记（NCOP/NCED/menu/PV/…）→ needs_subtitle=0（特典不算字幕范围）
//  1. origin_lang ∈ 目标语言（如 zh）→ needs_subtitle=0（国产片，不需要中文字幕）
//  2. embedded_langs 含目标语言 → needs_subtitle=0（已有内嵌中字）
//  3. 其余 → needs_subtitle=1（需要找字幕）
//
// **判据是语言事实 + 文件名事实**（D8 的职责切分）：needs_subtitle 回答"这资源**原则上**
// 需要中文字幕吗"，与磁盘上当前有没有外挂字幕无关；后者归 sub_status，由扫描独占写入（R24）。
//
// ── 规则 0 的来历与它为什么在**这里**（2026-08-13 用户裁决）────────────────────
// 用户原话：「特典逻辑我觉得可以删除掉……特典都完全不算在找字幕的范围」。
// `isMechanicalExtra` 此前生产零调用点（原调用者 v2/ingest.ts 的 excludeExtras 分支随 ingest
// 整体退役），于是生产上 16 个 NCOP/NCED/PV/menu 文件全部 needs_subtitle=1，每轮巡检都在
// 为一段 91 秒的无对白 OP 动画烧一次付费 LLM session 去找中文字幕。
//
// 接在 judge 这一步（而不是扫描期就不入库、也不是在字幕工作台谓词里加一条）的理由：
//  · **一个事实只许有一个投影列**（C27 的教训）。"这个文件原则上需不需要中文字幕"已经有
//    needs_subtitle 这一列了，特典是这个问题的又一条判据，不是一个新问题。在工作台谓词里
//    另加 `AND filename NOT LIKE …` 就是第二份判据，且它对媒体库页不可见——用户会看到
//    16 个 `···`（系统正要去找）而 daemon 其实永远不找它，界面在撒谎。
//  · **不在扫描期丢掉**：文件在磁盘上，媒体库要如实说出它的存在（用户不能因为我们不给
//    它找字幕就以为文件丢了）。judge 只改判决，不改可见性。
//  · 它天然继承 needs_subtitle 已有的**重判通路**（谓词 `needs_subtitle IS NULL`）：
//    改了标记表 / 换目标语言时，retarget 与 D17 回填把这一列清 NULL 就会重判，
//    不需要为特典另造一条回填 pass。
//
// ⚠️ 规则 0 **必须排在语言规则之前**，这不是排版偏好：一个日语 NCOP（origin=ja、无内嵌中字）
// 走到规则 3 会被判 needs=1。而反过来把它排在最后毫无意义——前两条判 0 的行本来就已经出局。
// 排第一还有一个可观测的好处：skip_reason 会如实记成 'extra' 而不是被 origin-skip 抢先盖住
// （一个中文特典若判成 origin-skip，排障时看不出它其实是特典）。
//
// 这里曾有第 3 条规则「磁盘已有同名 sidecar 中文字幕 → needs_subtitle=0」，删掉的原因（C27）：
// 同一个**磁盘事实**被两列各判一次，就会造出一个双不满足的永久卡死态——
//   用户嫌翻译质量差手删字幕 → 扫描把 sub_status 从 covered 回退成 NULL ✅
//   但 needs_subtitle=0 留着 → 既不满足 judge 谓词 `needs_subtitle IS NULL`（不会重判它）、
//   又不满足字幕工作台谓词 `needs_subtitle=1`（不会排它）→ **这一集永久不再补字幕**，
//   而界面上什么异常都看不出来。
// 删掉之后"磁盘已有外挂中字的文件不许被送进字幕流白烧一轮付费 LLM"这个正确行为并没有丢，
// 只是换了保证者：由扫描写的 `sub_status='covered'` 挡在字幕工作台门口（R24）。
// 一个磁盘事实只许有一个投影列——这是 C19 换列复活（C27）的唯一根治办法。
import { langOf, tagsForLanguage } from '../agent/languages.js'
import { isMechanicalExtra } from './extrasFilter.js'

export interface JudgeInput {
  originLang: string | null
  embeddedLangs: string[] | null
  /** 文件名（`files.filename`，不是全路径）。规则 0 的判据。
   *
   *  🔴 **可选且默认按"不是特典"处理**：judgeTranslatable 与一批既有调用方共用 JudgeInput，
   *  强制必填会把它们全部改一遍而其中多数根本不关心文件名。缺省时规则 0 不成立——
   *  这是安全的方向（漏判成"要找字幕"只是白找一次，误判成特典是永久不找）。 */
  filename?: string | null
}

export interface JudgeDeps {
  targetLanguages: string[]
}

export type JudgeVerdict =
  | { needs: false; reason: 'origin-skip' | 'embedded' | 'extra' }
  | { needs: true; reason: 'missing' }

/** 判定一个文件是否需要找字幕。纯函数（只看语言事实与文件名，不碰磁盘）。 */
export function judgeSubtitle(input: JudgeInput, deps: JudgeDeps): JudgeVerdict {
  // 0. 机械特典（NCOP/NCED/menu/PV/…）：用户裁决「特典都完全不算在找字幕的范围」。
  //    必须排在语言规则之前，理由见文件头（日语 NCOP 否则会落到规则 3 判 needs=1）。
  if (input.filename != null && isMechanicalExtra(input.filename)) {
    return { needs: false, reason: 'extra' }
  }
  // 1. 国产片跳过：origin_lang 是目标语言（如 zh 目标中文时，中文影视不需要中文字幕）
  if (input.originLang != null && deps.targetLanguages.includes(input.originLang.toLowerCase())) {
    return { needs: false, reason: 'origin-skip' }
  }
  // 2. 已有内嵌中字
  if (input.embeddedLangs != null) {
    const hasTargetEmbedded = input.embeddedLangs.some((l) =>
      deps.targetLanguages.includes(langOf(l)))
    if (hasTargetEmbedded) return { needs: false, reason: 'embedded' }
  }
  // 3. 需要找字幕
  return { needs: true, reason: 'missing' }
}

/** 可抓源 / 可抽轨的源语言集合（R20 的 MVP 边界，两者**刻意不同**）。
 *
 *  · fetchableSourceLangs = 能从 provider **抓到外挂源语言字幕**的语言。MVP 仅 en
 *    （OpenSubtitles 靠 imdb 命中）。日语要等 F2 的 jimaku 落地，见 C6。
 *  · extractableSourceLangs = 能**抽内嵌文本轨**的语言。en/ja 皆可——抽轨是纯本地 ffmpeg
 *    操作、零 provider 依赖，故天然比抓取宽。
 *
 *  为什么必须是两个集合而不是一个（R20 的口径统一）：spec 正文写"MVP 仅 en"、而旧的
 *  `SUPPORTED_SOURCE_LANGS` 实为 ['en','ja']——两处口径不一正是因为它们说的是不同的事。
 *  合成一个集合的话，取 ['en'] 会误判死有日文轨的日漫（C31），
 *  取 ['en','ja'] 会让**无内嵌轨的日漫**被判可救 → 移交翻译流 →
 *  翻译流发现抓不到日文源 → unsolvable，白绕一圈（C24 想省掉的正是这种绕路）。
 *
 *  两个集合的**唯一定义处**是 `translateWorkerTask.ts` 的 FETCHABLE_SOURCE_LANGS /
 *  EXTRACTABLE_SOURCE_LANGS（第 4 步任务 G 收敛 / C31 末段）。本接口只声明形状，
 *  不放字面量——喂料由 daemonV2 从那一份定义组装。 */
export interface TranslatableDeps {
  fetchableSourceLangs: string[]
  extractableSourceLangs: string[]
}

/** 三态可救性（R21 + D9）。**返回 null 是有意义的第三态，不是"失败"**。 */
export type Translatable = 0 | 1 | null

/** 一个语言标签是否算作某个 BCP-47 主语言码（如 'jpn' 算 'ja'）。
 *
 *  🔴 为什么不能直接用 `langOf(a) === langOf(b)`（3-2 实测踩到，用例当场红）：
 *  `langOf` **只折叠中文别名**（ZH_ORIGIN_CODES = chi/zho/cmn/cn → zh），对其他语言是
 *  纯粹的"小写 + 去地区后缀"透传。于是 `langOf('jpn')` 得到 `'jpn'`，与 `'ja'` 不相等。
 *  而这两种形态在生产里**必然同时出现**：`works.origin_lang` 来自 TMDB 的 ISO-639-1
 *  两字母（ja/en/ko），`files.embedded_langs` 来自 ffprobe 的 ISO-639-2 三字母（jpn/eng/kor）。
 *  照字面比较的话，D9 第 ② 支对**每一部日漫**都判不成立 → 全体 translatable=0 → 永久停牌，
 *  正是 D9 存在的全部目的被静默取消。
 *
 *  复用 `tagsForLanguage`（'ja' → ['ja','jpn']）这一份既有映射，**不另写第二份折叠表**：
 *  本仓已因"留两份漂移实现"栽过（C30 的两处标签集各漏一半、第 1a 步的 findOverlappingRoot），
 *  语言映射尤其不能分叉——分叉的那天没有任何测试会红，只是日漫又开始被判死。 */
function isLang(tag: string | null | undefined, primary: string): boolean {
  if (!tag) return false
  const t = tag.toLowerCase()
  // 直接命中该语言的标签集（含三字母形态），或去掉地区/脚本后缀后命中主码
  // （'zh-Hans'→'zh'、'en-US'→'en'；ffprobe 偶尔给 'ja-JP' 这种）。
  return tagsForLanguage(primary).some((x) => x.toLowerCase() === t)
    || langOf(tag) === langOf(primary)
}

/** 预判"翻译救不救得了这一集"（R21），写入 files.translatable。纯函数，不碰磁盘。
 *
 *  两条**并列**判据（D9，缺一不可）：
 *   ① origin_lang ∈ 可抓源集合（MVP=en）→ 能抓外挂源语言字幕来译
 *   ② embedded_langs 含 **origin 同语言**文本轨 → 能抽轨来译（纯本地，符合 R13 单跳）
 *
 *  为什么第 ② 支非有不可（C31，这是本函数存在的全部理由）：`resolveSource.ts:56-65` 对
 *  `origin=ja` 且有日文内嵌轨的情况可以直接抽轨翻译。只看 origin_lang（第 ① 支）会把 BD
 *  压制的日漫——普遍带日文内嵌轨——判成不可救 → 满 7 次后直接 unsolvable → **永久停牌**，
 *  而它其实一抽就能救。
 *
 *  为什么第 ② 支要求"**同语言**"而不是"有任何内嵌轨"（R18 / C17）：R18 废止了 eng 兜底
 *  （JP→EN→CN 丢义严重，R13 只许单跳）。一部日漫只有英文内嵌轨时是**真的**不可救。
 *
 *  ── 何时返回 null（C40 铁律：`translatable IS NULL` 不得判死）──
 *  两条判据都不成立时还要分辨"确实不可救"与"暂时判不了"：
 *   · origin_lang 未知（NULL/空）→ null。TMDB 没刮到语言时**不许臆断**（C17 记有实案：
 *     resolveSource 曾把 origin==='' 当英语处理，语言完全未经证实）。连源语言都不知道，
 *     "单跳直译"的源是什么都说不出来，此时给 0 就是拿信息缺失当结论。
 *   · origin_lang 已知、但 embedded_langs 为 NULL（= "没探测过"，非 "[]确认零轨"）→ null。
 *     判据不全，待 D17 回填补上证据后重判；给 0 会永久判死一个可能有日文轨的日漫。
 *     注意：origin ∈ 可抓源集合时第 ① 支已足够定论，**不受这一条影响**（否则一批本可立刻
 *     判可救的英语片会白等一轮回填）。
 *  三态语义与 streamProbe 的 null/[] 契约一脉相承：null=不知道，0/[]=知道且为空。 */
export function judgeTranslatable(input: JudgeInput, deps: TranslatableDeps): Translatable {
  const origin = langOf(input.originLang)
  // origin 未知：两条判据都无从谈起（抽轨也要知道源语言是什么，见上方论证）。
  if (origin === '') return null

  // ① 可抓源集合。这一支不依赖内嵌轨证据，故先判——它能在 embedded_langs 还是 NULL 时定论。
  if (deps.fetchableSourceLangs.some((l) => isLang(l, origin))) return 1

  // ② 同语言内嵌文本轨。图形轨（PGS/DVD/DVB/XSub）已在 probe 写入前剔除，故这一列里的值
  //    一律视为文本轨——判据是 embedded_langs 这一列的语义，不是原始轨列表。
  if (deps.extractableSourceLangs.some((l) => isLang(l, origin))) {
    if (input.embeddedLangs === null) return null   // 判据不全（没探过）→ 暂不可判，不判死
    if (input.embeddedLangs.some((l) => isLang(l, origin))) return 1
    return 0   // 探过、确认没有同语言轨 → 真的不可救（不许 eng 兜底 / R18）
  }

  // origin 既不可抓、也不在可抽轨集合内（如 ko/fr）。此时内嵌轨有没有都不影响结论：
  // 抽出来一条韩文轨我们也没有 ko→zh 的单跳能力。故 embedded_langs 为 NULL 也照判 0
  // ——这不是"判据不全"，是"这门语言我们整体不支持"，补上证据也不会改变结论。
  return 0
}
