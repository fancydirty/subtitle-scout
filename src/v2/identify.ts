// src/v2/identify.ts：识别 agent 的核心纯函数（新架构阶段 2）。
// spec: docs/design/2026-08-08-new-architecture-design.md §5
//
// 识别 agent 的职责（用户裁决）：
//  - 确认"这个 work_dir 是什么影视"（TMDB 身份）
//  - 批量绑定文件季集号（60 一包，身份只确认一次）
//  - 404 终态（作品真不在 TMDB → 永不重试）
//
// 本文件是**纯函数层**（标题清洗、候选生成、核验逻辑），不含 LLM 调用——
// LLM 调用在识别 worker 里（阶段 2b），这里的函数可单测。

/** 从目录名提取标题候选。目录名可能带年份、{tmdb-N} 标签、乱码等。
 *  "Pulp Fiction (1994)" → "Pulp Fiction"
 *  "后室 (2026) {tmdb-1083381}" → "后室"
 *  "绝命毒师 (2008)" → "绝命毒师" */
export function titleFromDir(dirName: string): string {
  let t = dirName.trim()
  // 去掉 {tmdb-N} 标签
  t = t.replace(/\s*\{tmdb-\d+\}\s*$/i, '')
  // 去掉末尾年份 (2024) / [2024] / 2024
  t = t.replace(/\s*[\(\[]?\d{4}[\)\]]?\s*$/, '')
  // 去掉末尾年份（无括号，如 "Show 2024"）
  t = t.replace(/\s+\d{4}\s*$/, '')
  return t.trim()
}

/** 生成 TMDB 搜索候选：主标题 + 中文变体（从目录名形态）。
 *  用于 prompt 告诉 agent 搜什么，agent 自己决定最终搜索词。 */
export function searchCandidates(dirName: string): string[] {
  const primary = titleFromDir(dirName)
  const out = new Set<string>()
  if (primary) out.add(primary)
  // 目录名本身就是候选（可能已是完整形态）
  if (dirName.trim()) out.add(dirName.trim())
  return [...out]
}

/** 双证据核验（spec: two-evidence bar）：
 *  名字匹配 + 独立结构证据（年份/类型/集数）至少一条吻合。
 *  返回是否通过。纯函数，TMDB 查询结果由调用方传入。 */
export interface TmdbEvidence {
  id: string
  title: string
  originalTitle: string | null
  year: number | null
  mediaType: 'tv' | 'movie'
  episodeCount?: number
}

export interface DirFacts {
  dirName: string
  fileCount: number
  seasons: number[]   // work_dir 下出现的季号
  hasSeasonDirs: boolean
}

export function verifyEvidence(
  candidate: TmdbEvidence,
  dirFacts: DirFacts,
  targetTitle: string,
  chineseTitles: string[] = [],
): { ok: true } | { ok: false; reason: string } {
  // 🔴 2026-08-08 实测修正（PLUR1BUS/High School D×D）：纯 normalize 相等太严格，
  // 真实世界的命名变体（leetspeak 1→i、×→x、缩写、粉丝写法）会让合法匹配被拒。
  // 标题匹配降级为"模糊相关性"（显著子串重叠 ≥ 5 字符 或 首词相等）——
  // 机械层只拦"完全无关的标题"（防幻觉），不拦"合法变体"（那是 agent 双证据的职责）。
  const titleCandidates = [normalize(candidate.title)]
  if (candidate.originalTitle != null) titleCandidates.push(normalize(candidate.originalTitle))
  for (const c of chineseTitles) titleCandidates.push(normalize(c))
  const normTarget = normalize(targetTitle)
  const titleOk = titleCandidates.some((nc) => {
    if (nc === '' || normTarget === '') return false
    if (nc === normTarget) return true
    // 显著子串重叠（≥5 字符）——覆盖 PLUR1BUS vs Pluribus 这种部分匹配
    if (nc.length >= 5 && normTarget.length >= 5) {
      if (nc.includes(normTarget) || normTarget.includes(nc)) return true
      // 最长公共子串（简化：取短串的前 5+ 字符在长串里找）
      const short = nc.length <= normTarget.length ? nc : normTarget
      const long = nc.length <= normTarget.length ? normTarget : nc
      for (let i = 0; i <= short.length - 5; i++) {
        if (long.includes(short.slice(i, i + 5))) return true
      }
    }
    return false
  })
  if (!titleOk) {
    return { ok: false, reason: `title mismatch: candidate="${candidate.title}" vs dir="${targetTitle}"` }
  }
  // 证据 2：独立结构证据（年份 / 类型 / 集数）
  //  - 年份：candidate.year 与目录名里的年份一致（如果目录名有年份）
  const dirYear = yearFromDir(dirFacts.dirName)
  if (dirYear !== null && candidate.year !== null && dirYear === candidate.year) {
    return { ok: true }
  }
  //  - 类型：candidate.mediaType 与 work_dir 的位置（TV/ 下 → tv）
  //  - 集数：candidate.episodeCount 与文件数（同数量级）
  if (dirFacts.hasSeasonDirs && candidate.mediaType === 'tv') return { ok: true }
  if (!dirFacts.hasSeasonDirs && candidate.mediaType === 'movie' && dirFacts.fileCount <= 10) {
    return { ok: true }
  }
  return { ok: false, reason: 'no independent structural evidence (year/type/episodes)' }
}

function normalize(s: string): string {
  // 命名变体归一（2026-08-08 实测踩中三类）：
  //  ×（U+00D7）→ x："D×D" 是 "DxD" 的粉丝写法
  //  leetspeak 数字 → 字母：PLUR1BUS → Pluribus（1→i）、M4TRIX → Matrix（4→a）
  //  变音符号折叠：Amélie→Amelie、Shōgun→Shogun（目录名常无 diacritic）
  //  之后再删非字母数字（空格/标点/年份分隔符）
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/×/g, 'x')
    .replace(/1/g, 'i').replace(/4/g, 'a').replace(/3/g, 'e')
    .replace(/0/g, 'o').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[^\p{L}\p{N}]+/gu, '').trim()
}

export interface YearHit {
  title: string
  originalTitle: string | null
  year: number | null
}

function exactName(hit: YearHit, claimedTitle: string): boolean {
  const claimed = normalize(claimedTitle)
  if (!claimed) return false
  if (normalize(hit.title) === claimed) return true
  if (hit.originalTitle != null && normalize(hit.originalTitle) === claimed) return true
  return false
}

/** Directory year vs TMDB year off by 1–2, and no other exact-name title in a different year. */
export function yearFolderTypoOk(
  dirYear: number | null,
  tmdbYear: number | null,
  claimedTitle: string,
  hits: YearHit[],
): boolean {
  if (dirYear == null || tmdbYear == null) return false
  const delta = Math.abs(dirYear - tmdbYear)
  if (delta !== 1 && delta !== 2) return false
  const sameName = hits.filter((h) => exactName(h, claimedTitle))
  if (sameName.length === 0) return false
  const years = new Set(sameName.map((h) => h.year).filter((y): y is number => y != null))
  return years.size <= 1
}

export function yearFromDir(dirName: string): number | null {
  const m = dirName.match(/(?:\(|\[)?(\d{4})(?:\)|\])?/)
  return m ? Number(m[1]) : null
}
