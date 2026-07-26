// 结构化季/集/年份提取器——不依赖 @ctrl/video-filename-parser 的 season/episode 判断
// （它对真实命名会拆错：'2025.HDR...'→season=20 episode=25、'怪奇物语'→'怪'）。
// 这里用严格的、只认明确季/集标记的规则，绝不把 4 位数字拆成季/集。

export interface EpisodeStructure {
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
}

/** 明确的季/集标记（按优先级从高到低）。只认这些，其它一律不算季/集。
 *  S01E01 / s01e01 / S1E1
 *  Season 1 Episode 2 / Season 1 - 02
 *  第1季第2集 / 第1季 02
 *  [01]（fansub 集数，含前导零）
 *  EP01 / E01 / ep01（含前导零的明确集标记）
 *  第3话 / 第3集（CJK 集标记）
 *  绝对集号：' - 26 ' / ' - 26[' / ' 26 '（fansub 绝对编号）
 */
const SEASON_EPISODE_PATTERNS: Array<{ re: RegExp; kind: 'season-episode' | 'absolute' }> = [
  // S01E01 / S1E1 / s01e01（含可选的分隔符 . _ - 空格）
  { re: /[sS](\d{1,2})[\s._-]*[eE](\d{1,3})\b/, kind: 'season-episode' },
  // Season 1 Episode 2 / Season 1 - 02 / Season.01.Episode.02
  { re: /season[\s._-]*(\d{1,2})[\s._-]*(?:episode|ep|e)[\s._-]*(\d{1,3})\b/i, kind: 'season-episode' },
  // 第1季第2集 / 第1季 02 / 第1季EP02
  { re: /第\s*(\d{1,2})\s*季[\s._-]*(?:第\s*(\d{1,3})\s*[集话]|(\d{1,3})\b)/, kind: 'season-episode' },
  // EP01 / E01 / ep01（含前导零，且前面不是字母——避免吃到 'Episode' 里的 'e'）
  { re: /(?<![a-zA-Z])[eE](?:p(?:isode)?)?[\s._-]*(\d{2,3})\b/, kind: 'absolute' },
  // 第3话 / 第3集（CJK 集标记）
  { re: /第\s*(\d{1,3})\s*[话集]/, kind: 'absolute' },
  // fansub 集数：[01] / [001]（独立的方括号数字，不是 [2025] 这种年份）
  { re: /\[(0{0,2}\d{1,3})\]/, kind: 'absolute' },
  // 绝对编号：' - 26' / ' 26 [' / ' 26.'（fansub 绝对集号，前面是空格/连字符，不是年份）
  { re: /[\s._-](\d{1,3})(?=[\s._\-\[]|$)/, kind: 'absolute' },
]

/** 年份提取：认 (2025) / 2025. / .2025. / 2025 ，但不把 "2025" 在 "2025.HDR" 开头当年份
 *  （除非它后面跟的是年份上下文，如 "(2025)" 或 " 2025 "）。
 *  关键：要求年份前后有明确的边界（括号/空格/点/连字符），且年份本身是 19xx/20xx。 */
const YEAR_PATTERN = /(?:[\(\[\s._-]|^)(19\d{2}|20\d{2})(?=[\)\]\s._-]|$)/

/** 从一个文本段（文件名或目录名）提取季/集/年份结构。
 *  只认明确的季/集标记，绝不把 4 位数字拆成季/集（这是轮子会犯的错）。
 *  返回 null 表示没提取到季/集结构（年份可能单独存在）。 */
export function extractEpisodeStructure(text: string): EpisodeStructure {
  // 先提取年份——它会影响"哪些数字是年份不是集号"的判断
  const yearMatch = text.match(YEAR_PATTERN)
  const year = yearMatch ? Number(yearMatch[1]) : null

  // 依次尝试季/集标记（高优先级在前）
  for (const { re, kind } of SEASON_EPISODE_PATTERNS) {
    const m = text.match(re)
    if (!m) continue
    // 排除"年份被当成季/集"：如果提取到的 season/episode 拼起来正好是提取到的年份，那不是季/集
    if (kind === 'season-episode') {
      const season = Number(m[1])
      const episode = Number(m[2] ?? m[3])
      const asFourDigits = `${String(season).padStart(2, '0')}${String(episode).padStart(2, '0')}`
      if (year !== null && asFourDigits === String(year)) {
        // "2025" 被拆成 season=20 episode=25——这是年份不是季/集，跳过这个模式
        continue
      }
      return { season, episode, absoluteEpisode: null }
    }
    // 绝对集号：如果是 [01] 或 " - 01" 这种，且数字不是年份
    const abs = Number(m[1])
    if (year !== null && abs === year) continue // 数字是年份不是集号
    // 绝对集号不带季
    return { season: null, episode: null, absoluteEpisode: abs }
  }

  return { season: null, episode: null, absoluteEpisode: null }
}

/** 提取年份（独立于季/集，电影和剧集都可能用）。 */
export function extractYear(text: string): number | null {
  const m = text.match(YEAR_PATTERN)
  return m ? Number(m[1]) : null
}
