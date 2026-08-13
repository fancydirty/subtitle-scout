/** 文件名级特典硬过滤（"机械铁案层"）。词边界匹配、大小写不敏感。
 *
 *  ── 唯一读取方：`v2/subtitleJudge.ts` 的规则 0（2026-08-13 用户裁决）─────────────
 *  用户原话：「特典都完全不算在找字幕的范围」。命中即 `needs_subtitle=0` +
 *  `skip_reason='extra'`，该文件从此不进字幕工作台。判据为什么落在 judge 而不是扫描期或
 *  工作台谓词，见 subtitleJudge.ts 头部规则 0 那一段。
 *
 *  🔴 只收"绝无剧情"的映像/菜单/预告类标记——SP/OVA/OAD/Special 是灰区（时长/S0 才能判），
 *  **绝不进这张铁案表**（否则会误杀有字幕的剧情向 OAD）。
 *
 *  ── 为什么这张表值得留着，而"解析不出季集就不找字幕"那条更简单的规则不行 ──────────
 *  2026-08-13 生产库实测（645 文件），这是本裁决唯一的立论依据：
 *   · 本表在**全库**命中 16 个，其中有季集号的 **0 个**（零误伤），16 个时长 91–179s，
 *     全是 NCOP/NCED/PV/menu——判准。
 *   · 而 `season/episode` 解析为 NULL 的 TV 文件有 **79 个**，本表只认其中 16 个；
 *     剩下 **63 个是真剧集**（26 个 Re:ZERO 正片 ~1500s、12 个 Violet Evergarden 正片
 *     ~1420s、25 个官方短篇 spinoff 151s），**且这 63 个全部 sub_status='covered'**
 *     ——它们磁盘上已经有中文字幕，是不可能更硬的"这是真内容"的证据。
 *  所以"解析不出季集 ⇒ 不找字幕"会**误杀 63 个真剧集**（其中 38 个正片长度）。
 *  解析器在正常剧集上失败是常态（括号数字 `[01]`、日文 `第01話` 都能让它失败），
 *  拿它当特典判据是把两件不相干的事合并。标记表会过期，但它**过期的方向是漏判**
 *  （新标记没收进来 → 白找一次字幕）；简单规则失效的方向是**误杀**（永久不找）。
 *  两种代价不对称，故取标记表。 */
const EXTRA_MARKERS = ['NCOP', 'NCED', 'Menu', 'PV', 'CM', 'Trailer', 'Preview']

/** @param filePath 文件名或全路径（内部只看 basename）。 */
export function isMechanicalExtra(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? filePath
  // 词边界：marker 左侧必须是非字母数字或串首，右侧必须是非字母或串尾——避免 'PV' 命中 'PVC'、
  // 'CM' 命中 'CMovie'，同时允许 'NCOP01' 这类真实编号后缀命中。
  return EXTRA_MARKERS.some((m) => new RegExp(`(^|[^A-Za-z0-9])${m}([^A-Za-z]|$)`, 'i').test(base))
}
