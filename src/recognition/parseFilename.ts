// 结构化季/集/年份提取器——照 Emby.Naming 的架构（一组带优先级、带防错闸的正则），
// 为中文/真实世界命名专门设计。不依赖 @ctrl/video-filename-parser（它对真实命名会拆错：
// '2025.HDR...'→season=20 episode=25、'怪奇物语'→'怪'、'[组][剧][集]'→认不出）。
//
// 方法论（学自 MediaBrowser/Emby.Naming）：
//  - 一组按优先级排序的正则，逐个尝试，第一个成功就用——不是一个超级正则。
//  - seriesname 用 negative lookahead 防截断（lookahead 排除季/集标记，剧名不会被 S01E01 吃掉）。
//  - 防错闸：season 200-1927 或 >2500 作废（防 '1920x1080'/'2025' 被拆成季/集）；
//    episode ≥ 1（0 不是集号，防 'AAC2.0' 小数尾被当集号）；R3 对 WxH 加数字边界
//    （'1280x720' 不拆季集）；R1/R5 消化粘连版本后缀 vN（'S01E04v2'）；R8 分隔符
//    前是数字即拒（'DDP5.1'/'AAC2.0' 的小数点不是分隔符）。
//  - 季/集只认明确标记（SxxExx / 1x03 / [01] / 第N集），绝不把 4 位数字拆成季/集。

/** Recognition-ready shape for a single filename or bare path segment. Consumed by C2 (path-aware
 *  merging) and C3 (TMDB resolution) — keep the field names stable, they are the contract. */
export interface ParsedName {
  title: string | null
  year: number | null
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
  isTv: boolean
  isMultiSeason: boolean
  complete: boolean
}

// ---------------------------------------------------------------------------
// 底层：带优先级的季/集正则库（Emby EpisodeExpressions 的等价物）
//
// 注：这组规则是**内联的顺序 if 块**（见 extractSeasonEpisode），不是一张数据表。
// 曾经存在过一个 `EpisodeRule { re; isAbsolute }` 接口来描述表驱动形态，但表驱动从未
// 落地——每条规则的 plausible 判据各不相同（R1 要 looksLikeYear 闸、R1b 要额外的
// complete/全N集 上下文测试），塞不进统一的 `{re, isAbsolute}` 里。该接口已随本次
// 清理删除；要恢复表驱动，得先让各条规则的后置判据同构。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 共享字符类：CJK 集号标记字
//
// 收敛记录（2026-08-14）：此前全仓有 **4 处**同义字符类、**3 种**写法——
//   src/files/libraryRealign.ts      `[话話集]`  ← 唯一写全的
//   src/recognition/parseFilename.ts `[集话]`（R4）/ `[话集]`（R7）/ `[话集]`（cleanTitle 守卫）
//   src/recognition/identifyFromPath.ts `[话集]` ×2
// 漂移的代价是实打实的：parseFilename 的三处漏了日文/繁体的「話」，生产库 13 个日文动画
// 文件全部解析不出集号（DB 落 parse_confidence='none'），而 libraryRealign 对同一批文件
// 认得出——同一个仓库里两套字符类给出两个答案。
//
// 治法是让它**只有一个定义点**：下面这个常量。新增字形（如「回」「話数」）只改这里。
// 用字符串而非 RegExp 是因为四个使用点的上下文各不相同（有的要捕获组、有的要锚定 ^$、
// 有的带 \s* 弹性），共享的是**字符类**这一层，不是整条正则。
// ---------------------------------------------------------------------------

/** CJK 集号标记字：简体「话」/ 日文·繁体「話」/ 通用「集」。全仓唯一定义点。 */
export const CJK_EPISODE_MARKER_CLASS = '[话話集]'

/** 裸集数标记（整段就是一个集号，没有剧名）——`第05話` / `第 5 话` / `第12集`。
 *  cleanTitle 守卫和 identifyFromPath 的 BARE_EPISODE_PATTERNS 共用它，防止两边再次漂移。 */
export const BARE_CJK_EPISODE_SOURCE = `第\\s*(\\d{1,3})\\s*${CJK_EPISODE_MARKER_CLASS}`

/** 防错闸：season 落在 [200, 1927] 或 >2500 视为误判（防 '1920x1080'/'2025' 被拆成季/集）。
 *  学自 Emby EpisodePathParser.cs: "Invalidate match when the season is 200 through 1927 or
 *  above 2500"——除非真有剧故意用这么大的季号（几乎没有），这么大的 season 一定是把别的数字
 *  （分辨率/年份/帧率）错拆了。 */
function isPlausibleSeason(n: number): boolean {
  return !((n >= 200 && n < 1928) || n > 2500)
}

/** season+episode 合并成的 4 位数若正好等于一个 19xx/20xx 年份，那它不是季/集，是年份。
 *  （'Hero.2002' → '20'+'02' = '2002' 是年份不是 season=20 episode=02。） */
function looksLikeYear(s: number, e: number): boolean {
  const four = s * 100 + e
  return four >= 1900 && four <= 2099
}

/** 防错闸：episode/absoluteEpisode ≥ 1——集号从 1 起，0 不是集号。
 *  生产实案（2026-08-18 en 巡检，spec §4.4）：'Nukitashi...S01E04v2...AAC2.0' 在 R1 因
 *  "4|v" 无词边界失配后，R8 兜底把 'AAC2.0' 的小数尾 '0' 当集号 → episode=0 进库。
 *  0 一律视同该规则失配，让优先级更低的规则继续找（宁可落到诚实的 null，绝不产出 0）。 */
function isPlausibleEpisode(n: number): boolean {
  return n >= 1
}

/** 括号包裹的、恰好 8 位的十六进制串 —— CRC32 校验和。
 *
 *  病灶（2026-08-14 生产实测）：ep04 的文件名尾部是 `...第04話「...」[BDRip][AVC_AAC][1080P][CHS](4FE33E90).mp4`。
 *  R5（`(?<![a-zA-Z])[eE]...(\d{2,3})`）在 CRC 里命中了 `E90`——`E` 前面是 `3`（不是字母），
 *  negative lookbehind 闸放它过去 → DB 落成 `season=1, episode=90, parse_confidence='high'`。
 *  这比"解析不出"严重得多：**带着高置信度的错误答案**没有任何下游会去复查它。
 *
 *  判据（三个限定缺一不可，每一个都在收窄误伤面）：
 *   ① 圆括号包裹 `(...)` —— fansub/BDRip 发布命名放 CRC32 的固定位置（AniDB CRC 惯例）。
 *      裸写的 `4FE33E90` 不排除：没有约定支撑，宁可不动。
 *   ② 恰好 8 个字符   —— CRC32 就是 32 bit = 8 个 hex nibble。7 位/9 位不是 CRC32，不排除。
 *   ③ 全部是 hex 字符 —— `(ZFE33E90)` 长度对但不是 hex，不排除。
 *
 *  方向是**宁可漏判也不要误判**（北极星红线"绝不误认"）：排除面越窄，正常集号被误杀的面越小。
 *  已知残余风险：方括号写法 `[4FE33E90]` 和裸写不在排除范围内，依然可能被 R5 吃掉。那是
 *  **已知边界**而非遗漏——扩大排除面需要新的真实样本来立论，不能凭想象扩。 */
const CRC32_TOKEN_RE = /\([0-9A-Fa-f]{8}\)/g

/** 视频 codec token（`H.265` / `x.264` / `h.265` 等分隔符变体）——数字是 codec 编号
 *  不是集号。
 *
 *  病灶（2026-08-19 生产实测，Chainsaw Reze 实案）：电影文件名尾 `...DV.HDR10P.H.265-BYNDR.mkv`
 *  的 `.265` 被 R8 吃成 abs=265。单独看是无害的 low（P5 之前 listDir 不接线，季推导
 *  不发生）；P5 接通后碰上该电影目录里真有 `Season 01` 子目录（剧场版特典），唯一季
 *  推导把 abs=265 升级成 S1E265 **high**——一部电影被解析成"剧集第 265 集"，带着高
 *  置信度进库。这是"两个各自无害的修复组合出有害行为"的实案，故 codec 遮蔽必须
 *  与 P5 同批。
 *
 *  判据：`[hHxX]` + 分隔符（`.`/`_`/`-`/空格）+ `26[2-9]`（H.26x/x.26x 家族；262-269
 *  覆盖现存与近未来的 AVC/HEVC/VVC 编号）。**不带分隔符的 `x265` 不在此列**——它后面
 *  直接跟数字边界，R8 的现有闸已不认（`x` 是字母，分隔符字符类不匹配粘连），fansub
 *  命名里 `x265-10Bit` 中的 `265` 也因此从未被吃。与 CRC32 同法**等长遮蔽**，保住
 *  m.index / seriesname 的偏移对齐（见 maskCrc32 的论证）。 */
const CODEC_TOKEN_RE = /[hHxX][\s._-]26[2-9]\b/g

/** 把 CRC32 校验和与 codec token 整段替换成等长的 '#'（两处共用同一套等长论证）。 */
function maskNoise(text: string): string {
  return text.replace(CRC32_TOKEN_RE, (m) => '#'.repeat(m.length))
    .replace(CODEC_TOKEN_RE, (m) => '#'.repeat(m.length))
}

/** 把 CRC32 校验和整段替换成等长的 '#'，让集号正则看不见它里面的 `E90`。
 *
 *  **等长**是关键：调用方（R8）依赖 `m.index` 在原串上做后置判据，长度一变索引就全错。
 *  '#' 既不是十六进制字符也不是 `\d`/`[a-zA-Z]`，任何集号规则都不会从它身上刨出数字。
 *  只做遮蔽不做删除，也保证 seriesname 的字符偏移与原串逐字对齐（见 R5 的还原逻辑）。 */
function maskCrc32(text: string): string {
  return maskNoise(text)
}

/** 从一段文本提取季/集结构。只认明确标记，绝不把 4 位数字拆成季/集。 */
function extractSeasonEpisode(rawText: string): { season: number | null; episode: number | null; absoluteEpisode: number | null; seriesname: string | null } {
  // 规则按优先级从高到低，第一个 plausible 的命中即返回。
  //
  // 先把 CRC32 / codec token 遮蔽掉（等长替换成 '#'，见 maskNoise）——CRC 是发布命名
  // 的固定约定，codec 编号是编码事实，两者里面的数字对集号规则全是噪声。遮蔽而非
  // 删除：等长保证 m.index / seriesname 的字符偏移与原串逐字对齐，下面所有规则都可以
  // 照旧用 text，唯一的额外责任是**返回 seriesname 时切回原串**（'#' 不能进 title）。
  const text = maskCrc32(rawText)
  /** seriesname 必须取自原串——text 里的 CRC 已被 '#' 覆盖，直接返回会把 '#' 塞进 title。
   *  等长遮蔽让同一个 [start, end) 区间在两串上指向同一段内容，所以按长度切回即可。 */
  const unmask = (s: string | undefined): string | null => (s ? rawText.slice(0, s.length) || null : null)

  // R1: S01E01 / S1E1 / s01e01（Kodi 标准，最严格）。seriesname 用 negative lookahead 防截断。
  //  多集文件（S01E05E06 / S01E05-E06 / S01E05+E06）取第一集（Emby/jellyfin 同款：multi-episode
  //  collapse to first episode，多集 span 不在识别层处理）。
  //  粘连版本后缀（2026-08-18 en 巡检实案）：'S01E04v2' 的 "4|v" 之间没有词边界，尾部 \b 让
  //  R1 整条失配——Nukitashi 因此落到 R8 吃掉 'AAC2.0' 的 '0'（episode=0），芬芳 Flowers 甚至
  //  季集全 NULL。点分隔 '.v2' 本就正常（"1|." 有边界），只有粘连 vN 出事。修法：epnumber 后
  //  插入 (?:v\d{1,2})? 把 v2 当重定时版本消化掉，多集组与 \b 照旧。
  {
    const m = text.match(/(?<seriesname>.*?)[sS](?<seasonnumber>\d{1,2})[\s._-]*[eE](?<epnumber>\d{1,3})(?:v\d{1,2})?(?:[\s._+\-]*[eE]?\d{1,3})*\b/i)
    if (m?.groups) {
      const season = Number(m.groups.seasonnumber)
      const episode = Number(m.groups.epnumber)
      if (isPlausibleSeason(season) && isPlausibleEpisode(episode) && !looksLikeYear(season, episode)) {
        return { season, episode, absoluteEpisode: null, seriesname: unmask(m.groups.seriesname) }
      }
    }
  }

  // R1b: 季包标记（S01 / Season 1 / COMPLETE / 全N集）——只有 season 没有 episode（season pack）。
  //  学自 jellyfin/Emby：季包文件只有季号没有单集号，识别为 season=N, episode=null。
  //  放在 R1（SxxExx）之后——S01E01 会先被 R1 拦，S01（无 E）才落这里。
  {
    const m = text.match(/(?<seriesname>.*?)[sS](?<seasonnumber>\d{1,2})(?![\s._-]*[eE]\d)\b/i)
    if (m?.groups && /complete|全\s*\d+\s*集|season/i.test(text)) {
      const season = Number(m.groups.seasonnumber)
      if (isPlausibleSeason(season)) {
        return { season, episode: null, absoluteEpisode: null, seriesname: unmask(m.groups.seriesname) }
      }
    }
  }

  // R2: Season 1 Episode 2 / Season 1 - 02 / Season.01.Episode.02
  {
    const m = text.match(/(?<seriesname>.*?)season[\s._-]*(?<seasonnumber>\d{1,2})[\s._-]*(?:episode|ep|e)[\s._-]*(?<epnumber>\d{1,3})\b/i)
    if (m?.groups) {
      const season = Number(m.groups.seasonnumber)
      const episode = Number(m.groups.epnumber)
      if (isPlausibleSeason(season) && isPlausibleEpisode(episode) && !looksLikeYear(season, episode)) {
        return { season, episode, absoluteEpisode: null, seriesname: unmask(m.groups.seriesname) }
      }
    }
  }

  // R3: 1x03 / 01x03（season X episode，x 分隔）
  //  数字边界闸（2026-08-18 en 巡检实案，spec §4.4）：WxH 分辨率的宽度尾部不再是独立季号
  //  token——'1280x720' 的 "80x720" 曾被拆成 season=80 episode=720 且 parse_confidence='high'
  //  （Overflow ×8 实案；isPlausibleSeason(80) 放行、looksLikeYear(80,720)=80720 不是年，
  //  两道旧闸全漏）。seasonnumber 前加 (?<!\d)（"1280" 里的 "80" 前面是数字，拒收），
  //  epnumber 后加 (?!\d)（对称收口）。1920x1080/3840x2160 的四位高度本就被 \d{1,3}+\b
  //  挡住，此闸补的是 720 这类三位高度。
  {
    const m = text.match(/(?<seriesname>.*?)(?<!\d)(?<seasonnumber>\d{1,2})[xX](?<epnumber>\d{1,3})(?!\d)\b/)
    if (m?.groups) {
      const season = Number(m.groups.seasonnumber)
      const episode = Number(m.groups.epnumber)
      if (isPlausibleSeason(season) && isPlausibleEpisode(episode) && !looksLikeYear(season, episode)) {
        return { season, episode, absoluteEpisode: null, seriesname: unmask(m.groups.seriesname) }
      }
    }
  }

  // R4: 第1季第2集 / 第1季 02 / 第1季EP02（中文季+集）
  {
    const m = text.match(new RegExp(`(?<seriesname>.*?)第\\s*(?<seasonnumber>\\d{1,2})\\s*季[\\s._-]*(?:第\\s*(?<ep1>\\d{1,3})\\s*${CJK_EPISODE_MARKER_CLASS}|(?<ep2>\\d{1,3})\\b)`))
    if (m?.groups) {
      const season = Number(m.groups.seasonnumber)
      const episode = Number(m.groups.ep1 ?? m.groups.ep2)
      if (isPlausibleSeason(season) && isPlausibleEpisode(episode) && !looksLikeYear(season, episode)) {
        return { season, episode, absoluteEpisode: null, seriesname: unmask(m.groups.seriesname) }
      }
    }
  }

  // R5: EP01 / E01 / ep01（明确集标记，含前导零，前面不是字母）——绝对集号
  //  粘连版本后缀（同 R1 实案）：'E05v3' 的 "5|v" 无词边界 → \b 失配。epnumber 后加
  //  (?:v\d{1,2})? 消化 vN 再 \b，与 R1 同理。
  {
    const m = text.match(/(?<seriesname>.*?)(?<![a-zA-Z])[eE](?:p(?:isode)?)?[\s._-]*(?<epnumber>\d{2,3})(?:v\d{1,2})?\b/i)
    if (m?.groups) {
      const episode = Number(m.groups.epnumber)
      if (isPlausibleEpisode(episode)) {
        return { season: null, episode: null, absoluteEpisode: episode, seriesname: unmask(m.groups.seriesname) }
      }
    }
  }

  // R6: [01] / [001]（fansub 集数，独立方括号，非年份 [2025]）——绝对集号
  {
    const m = text.match(/(?<seriesname>.*?)\[(?<epnumber>0{0,2}\d{1,3})\]/)
    if (m?.groups) {
      const episode = Number(m.groups.epnumber)
      if (!(episode >= 1900 && episode <= 2099) && isPlausibleEpisode(episode)) { // [2025] 是年份不是集号
        return { season: null, episode: null, absoluteEpisode: episode, seriesname: unmask(m.groups.seriesname) }
      }
    }
  }

  // R7: 第3话 / 第3集（CJK 集标记）——绝对集号
  {
    const m = text.match(new RegExp(`(?<seriesname>.*?)第\\s*(?<epnumber>\\d{1,3})\\s*${CJK_EPISODE_MARKER_CLASS}`))
    if (m?.groups) {
      const episode = Number(m.groups.epnumber)
      if (isPlausibleEpisode(episode)) {
        return { season: null, episode: null, absoluteEpisode: episode, seriesname: unmask(m.groups.seriesname) }
      }
    }
  }

  // R8: ' - 26' / ' 26 [' / ' 26.'（fansub 绝对编号，前面是空格/连字符/点，不是年份）——绝对集号
  //  防错闸：① epnumber 后面不能跟「.一位小数」（'5.1'/'2.0' 是声道——真实声道小数的小数位
  //    恒为一位；'.1280' 这种多位"小数"不是小数，是点分隔的分辨率宽度，'Show.01.1280x720'
  //    的 01 必须能被接住）或字母（'10bit' 是质量标记）
  //  ② seriesname 不能以 4 位数字开头（'2026.2160p...' 是年份）或以 season/E 结尾（'Season 2'/'E06' 是季/集标记不是绝对编号）
  //  ③ 前置数字闸（2026-08-18 en 巡检实案）：分隔符前一个字符是数字时拒收——'DDP5.1' 的 '1'、
  //    'AAC2.0' 的 '0' 是小数声道尾不是编号（'Movie.2020.DDP5.1' 曾被判 abs=1 电影变剧集；
  //    'AAC2.0' 曾被判 episode=0）。闸 ① 只看了数字后面（'.1' 跟在 epnumber 后），这里补的是
  //    数字前面（'.' 前是数字 → 这是小数点不是分隔符），两个方向合围才封死 5.1/2.0 形态。
  {
    const m = text.match(/(?<seriesname>.*?)(?<!\d)[\s._-](?<epnumber>\d{1,3})(?![\da-zA-Z])/)
    if (m?.groups) {
      const episode = Number(m.groups.epnumber)
      const seriesname = unmask(m.groups.seriesname)
      const startsWithYear = seriesname !== null && /^\s*(19\d{2}|20\d{2})\b/.test(seriesname)
      const seriesEndsWithSeasonOrE = seriesname !== null && /(?:season|[sS]|[eE])\s*$|(?:^|\s)season$/i.test(seriesname)
      const afterMatch = text.slice((m.index ?? 0) + m[0].length)
      const isDecimal = /^\.\d(?!\d)/.test(afterMatch)
      if (isPlausibleEpisode(episode) && !(episode >= 1900 && episode <= 2099) && !startsWithYear && !seriesEndsWithSeasonOrE && !isDecimal) {
        return { season: null, episode: null, absoluteEpisode: episode, seriesname }
      }
    }
  }

  return { season: null, episode: null, absoluteEpisode: null, seriesname: null }
}

/** 年份提取：认 (2025) / （2025） / 2025. / .2025. / 2025 ，要求明确边界，不把 "2025" 在 "2025.HDR" 开头当年份
 *  （除非它真的是年份位置——括号包裹或独立成段）。含全角括号（中文命名常用）。 */
const YEAR_PATTERN = /(?:[\(\[\s._\-（【]|^)(19\d{2}|20\d{2})(?=[\)\]\s._\-）】]|$)/

function extractYear(text: string): number | null {
  const m = text.match(YEAR_PATTERN)
  return m ? Number(m[1]) : null
}

/** 清洗 title：剥掉尾部的季/集/质量/来源标记 + 扩展名 + fansub 组名前缀。
 *  "Teach You a Lesson S01E01 2160p WEB-DL" → "Teach You a Lesson"
 *  "[诸神字幕组][莉可丽丝]" → "莉可丽丝"
 *  "怪奇物语 S04E09" → "怪奇物语"（不截断成"怪"）
 *  "ep 1.mp4" → ""（裸集数标记不是剧名）
 *  "铁拳教育 (2026) 4K HDR10" → "铁拳教育"（不截断成"铁"） */
function cleanTitle(title: string): string {
  let t = title
  // 1. 剥扩展名
  t = t.replace(/\.(?:mkv|mp4|avi|ts|m2ts|wmv|flv|webm|mov|mpg|mpeg|m4v)$/i, '')
  // 2. 点/下划线/连字符换空格（"Teach.You.a.Lesson" → "Teach You a Lesson"）
  t = t.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  // 3. 剥尾部技术标记（质量/来源/编码/季集/字幕组描述）——反复剥直到没有可剥的。
  //  前面可以是空格/括号边界/点（' 4K' / '）4K' / ' 2160p' / '.WEB-DL'），因为中文命名常把画质
  //  紧跟在括号后面（'（2026）4K HDR'）。
  const techTail = /[\s\)）\].]+(?:s\d{1,2}e\d{1,3}(?:e\d{1,3})?|e\d{1,3}|ep\d{1,3}|\d{3,4}p(?:\d{1,2})?|[48]K|(?:web[ _-]?dl|webrip|bluray|bdrip|remux|hdtv|hdrip|dvdrip|brrip|x26[45]|h\.?26[45]|hevc|avc|hdr10\+?|hdr|dv|10bit|8bit|aac|ac3|ddp?5\.1|dts[._-]?hd|truehd|atmos|lpcm|flac|mp3|repack|proper|internal|limited|complete|multi|dual[._-]?audio|eng|english|高码率|蓝光原盘|杜比视界|简繁英字幕|简日双语|简繁内封|内封简日双字|特效|中英特字|国配特字|官译中字)\b.*)$/i
  let prev = ''
  while (prev !== t) { prev = t; t = t.replace(techTail, '') }
  // 4. 剥括号标记——内容是年份/画质/技术标记的括号，任何位置（'(2026)' / '（2026）' / '[简繁英字幕]'），
  //    不剥含剧名的括号（'[莉可丽丝]'是剧名不是标记）。判定：括号内容若以 19xx/20xx 年份开头，
  //    或以分辨率/编码开头（2160p/1080p/720p/4K/8K/x265/BluRay/WEB-DL），或含标记词，才剥。
  t = t.replace(/[\(（\[](?:19\d{2}|20\d{2})[^\)）\]]*[\)）\]]?/g, ' ')
  t = t.replace(/[\(（\[](?:\d{3,4}p|[48]K|x26[45]|h\.?26[45]|bluray|bdrip|web[ _-]?dl|webrip|hdtv|remux|hevc|avc)[^\)）\]]*[\)）\]]?/gi, ' ')
  t = t.replace(/[\(（\[][^\)）\]]*(?:杜比视界|蓝光原盘|REMUX|简繁英字幕|简日双语|简繁内封|内封简日双字|特效|中英特字|国配特字|官译中字)[^\)）\]]*[\)）\]]?/gi, ' ')
  // 剥开头的乱写括号前缀（'H）' / 'H)'——版权规避的乱写，不是剧名一部分）
  t = t.replace(/^[A-Z][）\)]\s*/i, '')
  // 剥乱写分隔符（'丨' / '|'——版权规避用竖线代替常规分隔，如'后丨室'→'后室'）
  t = t.replace(/[丨|]/g, '')
  t = t.replace(/\s+/g, ' ').trim()
  // 5. 剥尾部独立的 4 位年份（"招z魂z4 2025" → "招z魂z4"；年份由 extractYear 单独提取）
  t = t.replace(/\s+(19\d{2}|20\d{2})\s*$/, '').trim()
  // 6. 剥开头的 fansub 组名（只剥开头，[组名] / 【组名】）。
  //    逐个剥，每剥一个检查剩下的是不是还以 [ 开头（连续组名）。剥完若空了说明把剧名也剥了
  //    （如"[莉可丽丝]"是剧名不是组名），回退到最后一次剥之前。
  {
    let cur = t
    while (true) {
      const m = cur.match(/^(?:\[([^\]]*)\]|【([^】]*)】)\s*/)
      if (!m) break
      const rest = cur.slice(m[0].length).trim()
      // 剥完空了或只剩标点 → 这一段是剧名不是组名（如"[莉可丽丝]"），回退到当前组名本身（剥括号）
      if (!rest || !/[\p{L}\p{N}]/u.test(rest)) {
        cur = (m[1] ?? m[2] ?? '').trim()
        break
      }
      cur = rest
    }
    t = cur
  }
  // 7. 剥尾部标点/分隔符
  t = t.replace(/[\s._\-—–()（）\[\]【】]+$/, '').trim()
  // 裸集数标记不是剧名（'ep 1' / 'ep1' / 'ep' / '第3话' / '第3話' / '01' / '01.mkv' 剥完剩的 'ep'）
  if (new RegExp(`^(?:ep(?:isode)?(?:[\\s._-]*\\d{1,3})?|${BARE_CJK_EPISODE_SOURCE}|\\d{1,3})$`, 'i').test(t)) return ''
  return t
}


/**
 * 照 Emby.Naming 架构重写的 parseFilename。先用我们自己的规则库提取季/集（扛住真实命名），
 * title 清洗不截断，季/集只认明确标记。
 *
 * 2026-08-13 清理实测：本文件**已完全不依赖** `@ctrl/video-filename-parser`。文件头注释
 * 说的"轮子的 movie 模式仅作 year/title 的 fallback"在今天的代码里不成立——fallback 走的是
 * 本文件自己的 `extractYear` / `cleanTitle`。随之删除的还有只为该轮子而存在的
 * `toYear`（把轮子的 string year 转 number）和 `isShowResult`（ParsedFilename → ParsedShow
 * 类型守卫）两个函数，以及 `filenameParse/ParsedFilename/ParsedShow` 三个 import。
 * package.json 的依赖项**未动**——identifyFromPath.ts 的注释仍在引用该轮子的行为特征。
 */
export function parseFilename(name: string): ParsedName {
  // 1. 先用我们自己的规则库提取季/集结构（这是扛住真实命名的关键——轮子会拆错 '2025'/'怪奇物语'）。
  const struct = extractSeasonEpisode(name)

  // 2. 提取年份（独立于轮子的 movie.year——轮子在 '2025.HDR...' 里认不出 year）。
  const year = extractYear(name)

  // 3. 提取 title：优先用规则库的 seriesname（negative lookahead 防截断），否则整段清洗当 title
  //    （**不用轮子的 title 作 fallback**——轮子对中文/真实命名会截断成"铁"/"怪"）。
  let title: string | null = null
  if (struct.seriesname) {
    title = cleanTitle(struct.seriesname)
  }
  if (!title) {
    // 无季/集结构（纯电影/纯剧名段）：整段清洗后就是 title，不用轮子截断
    title = cleanTitle(name) || null
  }

  const season = struct.season
  const episode = struct.episode
  const absoluteEpisode = struct.absoluteEpisode
  const isTv = season !== null || episode !== null || absoluteEpisode !== null

  // 4. isMultiSeason：多季包（S01E01 且 season>1 不存在，或 COMPLETE/全N集 标记）
  const isMultiSeason = /complete|全\s*\d+\s*集|season\s*\d+\s*-\s*\d+/i.test(name)

  return {
    title: title || null,
    year: year ?? (struct.seriesname ? extractYear(struct.seriesname) : null),
    season,
    episode,
    absoluteEpisode,
    isTv,
    isMultiSeason,
    complete: false,
  }
}
