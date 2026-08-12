// 结构化季/集/年份提取器——照 Emby.Naming 的架构（一组带优先级、带防错闸的正则），
// 为中文/真实世界命名专门设计。不依赖 @ctrl/video-filename-parser（它对真实命名会拆错：
// '2025.HDR...'→season=20 episode=25、'怪奇物语'→'怪'、'[组][剧][集]'→认不出）。
//
// 方法论（学自 MediaBrowser/Emby.Naming）：
//  - 一组按优先级排序的正则，逐个尝试，第一个成功就用——不是一个超级正则。
//  - seriesname 用 negative lookahead 防截断（lookahead 排除季/集标记，剧名不会被 S01E01 吃掉）。
//  - 防错闸：season 200-1927 或 >2500 作废（防 '1920x1080'/'2025' 被拆成季/集）。
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

/** 从一段文本提取季/集结构。只认明确标记，绝不把 4 位数字拆成季/集。 */
function extractSeasonEpisode(text: string): { season: number | null; episode: number | null; absoluteEpisode: number | null; seriesname: string | null } {
  // 规则按优先级从高到低，第一个 plausible 的命中即返回。

  // R1: S01E01 / S1E1 / s01e01（Kodi 标准，最严格）。seriesname 用 negative lookahead 防截断。
  //  多集文件（S01E05E06 / S01E05-E06 / S01E05+E06）取第一集（Emby/jellyfin 同款：multi-episode
  //  collapse to first episode，多集 span 不在识别层处理）。
  {
    const m = text.match(/(?<seriesname>.*?)[sS](?<seasonnumber>\d{1,2})[\s._-]*[eE](?<epnumber>\d{1,3})(?:[\s._+\-]*[eE]?\d{1,3})*\b/i)
    if (m?.groups) {
      const season = Number(m.groups.seasonnumber)
      const episode = Number(m.groups.epnumber)
      if (isPlausibleSeason(season) && !looksLikeYear(season, episode)) {
        return { season, episode, absoluteEpisode: null, seriesname: m.groups.seriesname || null }
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
        return { season, episode: null, absoluteEpisode: null, seriesname: m.groups.seriesname || null }
      }
    }
  }

  // R2: Season 1 Episode 2 / Season 1 - 02 / Season.01.Episode.02
  {
    const m = text.match(/(?<seriesname>.*?)season[\s._-]*(?<seasonnumber>\d{1,2})[\s._-]*(?:episode|ep|e)[\s._-]*(?<epnumber>\d{1,3})\b/i)
    if (m?.groups) {
      const season = Number(m.groups.seasonnumber)
      const episode = Number(m.groups.epnumber)
      if (isPlausibleSeason(season) && !looksLikeYear(season, episode)) {
        return { season, episode, absoluteEpisode: null, seriesname: m.groups.seriesname || null }
      }
    }
  }

  // R3: 1x03 / 01x03（season X episode，x 分隔）
  {
    const m = text.match(/(?<seriesname>.*?)(?<seasonnumber>\d{1,2})[xX](?<epnumber>\d{1,3})\b/)
    if (m?.groups) {
      const season = Number(m.groups.seasonnumber)
      const episode = Number(m.groups.epnumber)
      if (isPlausibleSeason(season) && !looksLikeYear(season, episode)) {
        return { season, episode, absoluteEpisode: null, seriesname: m.groups.seriesname || null }
      }
    }
  }

  // R4: 第1季第2集 / 第1季 02 / 第1季EP02（中文季+集）
  {
    const m = text.match(/(?<seriesname>.*?)第\s*(?<seasonnumber>\d{1,2})\s*季[\s._-]*(?:第\s*(?<ep1>\d{1,3})\s*[集话]|(?<ep2>\d{1,3})\b)/)
    if (m?.groups) {
      const season = Number(m.groups.seasonnumber)
      const episode = Number(m.groups.ep1 ?? m.groups.ep2)
      if (isPlausibleSeason(season) && !looksLikeYear(season, episode)) {
        return { season, episode, absoluteEpisode: null, seriesname: m.groups.seriesname || null }
      }
    }
  }

  // R5: EP01 / E01 / ep01（明确集标记，含前导零，前面不是字母）——绝对集号
  {
    const m = text.match(/(?<seriesname>.*?)(?<![a-zA-Z])[eE](?:p(?:isode)?)?[\s._-]*(?<epnumber>\d{2,3})\b/i)
    if (m?.groups) {
      const episode = Number(m.groups.epnumber)
      return { season: null, episode: null, absoluteEpisode: episode, seriesname: m.groups.seriesname || null }
    }
  }

  // R6: [01] / [001]（fansub 集数，独立方括号，非年份 [2025]）——绝对集号
  {
    const m = text.match(/(?<seriesname>.*?)\[(?<epnumber>0{0,2}\d{1,3})\]/)
    if (m?.groups) {
      const episode = Number(m.groups.epnumber)
      if (!(episode >= 1900 && episode <= 2099)) { // [2025] 是年份不是集号
        return { season: null, episode: null, absoluteEpisode: episode, seriesname: m.groups.seriesname || null }
      }
    }
  }

  // R7: 第3话 / 第3集（CJK 集标记）——绝对集号
  {
    const m = text.match(/(?<seriesname>.*?)第\s*(?<epnumber>\d{1,3})\s*[话集]/)
    if (m?.groups) {
      return { season: null, episode: null, absoluteEpisode: Number(m.groups.epnumber), seriesname: m.groups.seriesname || null }
    }
  }

  // R8: ' - 26' / ' 26 [' / ' 26.'（fansub 绝对编号，前面是空格/连字符/点，不是年份）——绝对集号
  //  防错闸：① epnumber 后面不能跟 .数字（'5.1' 是声道）或字母（'10bit' 是质量标记）
  //  ② seriesname 不能以 4 位数字开头（'2026.2160p...' 是年份）或以 season/E 结尾（'Season 2'/'E06' 是季/集标记不是绝对编号）。
  {
    const m = text.match(/(?<seriesname>.*?)[\s._-](?<epnumber>\d{1,3})(?![\da-zA-Z])/)
    if (m?.groups) {
      const episode = Number(m.groups.epnumber)
      const seriesname = m.groups.seriesname || null
      const startsWithYear = seriesname !== null && /^\s*(19\d{2}|20\d{2})\b/.test(seriesname)
      const seriesEndsWithSeasonOrE = seriesname !== null && /(?:season|[sS]|[eE])\s*$|(?:^|\s)season$/i.test(seriesname)
      const afterMatch = text.slice((m.index ?? 0) + m[0].length)
      const isDecimal = /^\.\d/.test(afterMatch)
      if (!(episode >= 1900 && episode <= 2099) && !startsWithYear && !seriesEndsWithSeasonOrE && !isDecimal) {
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
  // 裸集数标记不是剧名（'ep 1' / 'ep1' / 'ep' / '第3话' / '01' / '01.mkv' 剥完剩的 'ep'）
  if (/^(?:ep(?:isode)?(?:[\s._-]*\d{1,3})?|第\s*\d{1,3}\s*[话集]|\d{1,3})$/i.test(t)) return ''
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
