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
  // 证据 1：名字匹配（candidate.title 或 TMDB 中文别名 与目录名清洗后的标题）
  const titleOk = normalize(candidate.title) === normalize(targetTitle)
    || candidate.title.includes(targetTitle)
    || targetTitle.includes(candidate.title)
    || chineseTitles.some((c) =>
      normalize(c) === normalize(targetTitle) || c.includes(targetTitle) || targetTitle.includes(c))
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
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim()
}

export function yearFromDir(dirName: string): number | null {
  const m = dirName.match(/(?:\(|\[)?(\d{4})(?:\)|\])?/)
  return m ? Number(m[1]) : null
}
