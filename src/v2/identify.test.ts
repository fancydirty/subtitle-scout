import { describe, it, expect } from 'vitest'
import { titleFromDir, searchCandidates, verifyEvidence, yearFromDir, yearFolderTypoOk, applyYearFolderTypoGate } from './identify.js'
import type { FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'

describe('titleFromDir（目录名 → 标题）', () => {
  it('标准电影：Pulp Fiction (1994) → Pulp Fiction', () => {
    expect(titleFromDir('Pulp Fiction (1994)')).toBe('Pulp Fiction')
  })
  it('带 tmdb 标签：后室 (2026) {tmdb-1083381} → 后室', () => {
    expect(titleFromDir('后室 (2026) {tmdb-1083381}')).toBe('后室')
  })
  it('无年份：SPY x FAMILY → SPY x FAMILY', () => {
    expect(titleFromDir('SPY x FAMILY')).toBe('SPY x FAMILY')
  })
  it('中文剧：绝命毒师 (2008) → 绝命毒师', () => {
    expect(titleFromDir('绝命毒师 (2008)')).toBe('绝命毒师')
  })
  // 2026-08-27 实测（用户第一次真人跑 setup）：中文环境的文件管理器常产出全角括号，
  // 半角字符类认不出 U+FF08/U+FF09，目录整体识别失败。混用（一半全角一半半角）更糟：
  // 只吞掉一半，留下孤儿括号。
  it('全角括号：Invasion（2021）→ Invasion', () => {
    expect(titleFromDir('Invasion（2021）')).toBe('Invasion')
  })
  it('混用括号：Invasion（2021) → Invasion（不留孤儿括号）', () => {
    expect(titleFromDir('Invasion（2021)')).toBe('Invasion')
    expect(titleFromDir('Invasion (2021）')).toBe('Invasion')
  })
  it('中文标题 + 全角括号：流浪地球（2019）→ 流浪地球', () => {
    expect(titleFromDir('流浪地球（2019）')).toBe('流浪地球')
  })
  it('全角方括号【】（[] 的中文形态）：流浪地球【2019】→ 流浪地球', () => {
    expect(titleFromDir('流浪地球【2019】')).toBe('流浪地球')
  })
  it('全角括号 + tmdb 标签：标签剥离不受影响', () => {
    expect(titleFromDir('后室（2026）{tmdb-1083381}')).toBe('后室')
  })
})

// 2026-08-13 补：`searchCandidates` 此前被 import 却**零断言**（清理时由 noUnusedLocals
// 抓出）。它不是可删的多余 import——它是生产活体：identifyWorker 的 prompt 里那行
// `Search candidates: ${candidates.join(' | ')}` 就是它的产出，agent 拿它去搜 TMDB。
// 一个决定"识别 agent 拿什么词去搜"的函数在本文件里一条覆盖都没有，属于测试漏洞而非死代码，
// 故补这一组，而不是把 import 删掉。
describe('searchCandidates（目录名 → TMDB 搜索候选）', () => {
  it('带年份：清洗后的标题排第一，原目录名作为第二候选保留', () => {
    // 顺序有语义：primary（titleFromDir 清洗过的）在前，agent 优先用它搜。
    expect(searchCandidates('Pulp Fiction (1994)')).toEqual(['Pulp Fiction', 'Pulp Fiction (1994)'])
  })
  it('无年份：清洗结果与原名相同 → 去重成一个候选（Set 去重，不产出重复搜索词）', () => {
    expect(searchCandidates('SPY x FAMILY')).toEqual(['SPY x FAMILY'])
  })
  it('带 tmdb 标签：标签被清掉，原名仍保留（万一 TMDB 认得完整形态）', () => {
    expect(searchCandidates('后室 (2026) {tmdb-1083381}')).toEqual(['后室', '后室 (2026) {tmdb-1083381}'])
  })
  it('空白目录名 → 空数组（不产出空字符串候选，否则 agent 会拿空串去搜）', () => {
    expect(searchCandidates('   ')).toEqual([])
  })
})

describe('verifyEvidence（双证据核验）', () => {
  it('名字 + 年份吻合 → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:680', title: 'Pulp Fiction', originalTitle: 'Pulp Fiction', year: 1994, mediaType: 'movie' },
      { dirName: 'Pulp Fiction (1994)', fileCount: 1, seasons: [], hasSeasonDirs: false },
      'Pulp Fiction',
    )).toEqual({ ok: true })
  })
  it('名字 + 类型（TV 目录 + 季目录）→ 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:1396', title: 'Breaking Bad', originalTitle: 'Breaking Bad', year: 2008, mediaType: 'tv' },
      { dirName: 'Breaking Bad (2008)', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      'Breaking Bad',
    )).toEqual({ ok: true })
  })
  it('中文目录名配 TMDB 中文别名 → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:1396', title: 'Breaking Bad', originalTitle: 'Breaking Bad', year: 2008, mediaType: 'tv' },
      { dirName: '绝命毒师 (2008)', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      '绝命毒师',
      ['绝命毒师', '绝命毒师 第一季'],
    )).toEqual({ ok: true })
  })
  it('名字不匹配 → 拒绝', () => {
    expect(verifyEvidence(
      { id: 'tmdb:999', title: 'Wrong Show', originalTitle: 'Wrong Show', year: 2008, mediaType: 'tv' },
      { dirName: '绝命毒师 (2008)', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      '绝命毒师',
    )).toEqual({ ok: false, reason: expect.stringContaining('title mismatch') })
  })
  it('名字匹配但无独立证据 → 拒绝', () => {
    expect(verifyEvidence(
      { id: 'tmdb:680', title: 'Pulp Fiction', originalTitle: null, year: null, mediaType: 'movie' },
      { dirName: 'Pulp Fiction', fileCount: 50, seasons: [], hasSeasonDirs: false },
      'Pulp Fiction',
    )).toEqual({ ok: false, reason: expect.stringContaining('no independent') })
  })
})

describe('yearFromDir', () => {
  it('标准年份', () => {
    expect(yearFromDir('Pulp Fiction (1994)')).toBe(1994)
    expect(yearFromDir('后室 (2026) {tmdb-1083381}')).toBe(2026)
  })
  it('无年份 → null', () => {
    expect(yearFromDir('SPY x FAMILY')).toBeNull()
  })
})

describe('normalize 的 × 变体（D×D vs DxD）', () => {
  it('High School D×D 与 High School DxD 匹配', () => {
    expect(verifyEvidence(
      { id: 'tmdb:45950', title: 'High School DxD', originalTitle: 'High School DxD', year: 2012, mediaType: 'tv' },
      { dirName: 'High School D×D', fileCount: 48, seasons: [1, 2, 3, 4], hasSeasonDirs: true },
      'High School D×D',
    )).toEqual({ ok: true })
  })
})

describe('verifyEvidence 的变音符号折叠（Amélie / Shōgun）', () => {
  it('Amélie vs Amelie → 通过（目录名常无变音）', () => {
    expect(verifyEvidence(
      { id: 'tmdb:194', title: 'Amélie', originalTitle: 'Le Fabuleux Destin d\'Amélie Poulain', year: 2001, mediaType: 'movie' },
      { dirName: 'Amelie (2001)', fileCount: 1, seasons: [], hasSeasonDirs: false },
      'Amelie',
    )).toEqual({ ok: true })
  })
  it('Shōgun vs Shogun → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:126308', title: 'Shōgun', originalTitle: 'Shōgun', year: 2024, mediaType: 'tv' },
      { dirName: 'Shogun (2024)', fileCount: 1, seasons: [1], hasSeasonDirs: true },
      'Shogun',
    )).toEqual({ ok: true })
  })
})

describe('verifyEvidence 的命名变体（模糊匹配）', () => {
  it('leetspeak：PLUR1BUS vs Pluribus → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:225171', title: 'Pluribus', originalTitle: 'Pluribus', year: 2025, mediaType: 'tv' },
      { dirName: 'PLUR1BUS', fileCount: 8, seasons: [1], hasSeasonDirs: true },
      'PLUR1BUS',
    )).toEqual({ ok: true })
  })
  it('完全无关的标题 → 拒绝（防幻觉）', () => {
    expect(verifyEvidence(
      { id: 'tmdb:999', title: 'SpongeBob', originalTitle: 'SpongeBob', year: 2024, mediaType: 'tv' },
      { dirName: 'Breaking Bad', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      'Breaking Bad',
    )).toEqual({ ok: false, reason: expect.stringContaining('title mismatch') })
  })
})

describe('yearFolderTypoOk（目录年 vs TMDB 年差 1–2、同名无第二年）', () => {
  const casablancaHits = [
    { title: 'Casablanca', originalTitle: 'Casablanca', year: 1943 },
    { title: 'Casablanca: An Unlikely Classic', originalTitle: null, year: 2012 },
  ]

  it('Casablanca 1942 vs TMDB 1943、唯一整串同名 → true（副标题条目不算同名）', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', casablancaHits)).toBe(true)
  })

  it('差 2 年同样 true', () => {
    expect(yearFolderTypoOk(1941, 1943, 'Casablanca', casablancaHits)).toBe(true)
  })

  it('年份完全一致 → false（不是 typo）', () => {
    expect(yearFolderTypoOk(1943, 1943, 'Casablanca', casablancaHits)).toBe(false)
  })

  it('差 ≥3 年 → false', () => {
    expect(yearFolderTypoOk(2013, 2023, 'The Conjuring', [
      { title: 'The Conjuring', originalTitle: null, year: 2023 },
    ])).toBe(false)
  })

  it('Dune 同名两个年份 → false（不得放行 1984/2021）', () => {
    expect(yearFolderTypoOk(1984, 2021, 'Dune', [
      { title: 'Dune', originalTitle: 'Dune', year: 1984 },
      { title: 'Dune', originalTitle: 'Dune', year: 2021 },
    ])).toBe(false)
  })

  it('同名两个年份且差 1 年 → false（独一性在 slack 窗口内仍否决）', () => {
    expect(yearFolderTypoOk(2020, 2021, 'Dune', [
      { title: 'Dune', originalTitle: 'Dune', year: 2020 },
      { title: 'Dune', originalTitle: 'Dune', year: 2021 },
    ])).toBe(false)
  })

  it('零同名 hits → false（fail-closed）', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', [])).toBe(false)
  })

  it('dirYear 或 tmdbYear 缺席 → false', () => {
    expect(yearFolderTypoOk(null, 1943, 'Casablanca', casablancaHits)).toBe(false)
    expect(yearFolderTypoOk(1942, null, 'Casablanca', casablancaHits)).toBe(false)
  })

  it('claimedTitle 与 hits 无整串相等 → false', () => {
    expect(yearFolderTypoOk(2019, 2020, '寄生虫', [
      { title: 'Parasite', originalTitle: '기생충', year: 2020 },
    ])).toBe(false)
  })

  it('originalTitle 整串相等也算同名', () => {
    expect(yearFolderTypoOk(2019, 2020, 'Parasite', [
      { title: 'Gisaengchung', originalTitle: 'Parasite', year: 2020 },
    ])).toBe(true)
  })

  it('同名只有目录年、没有 TMDB 年 → false（独一性要对着绑定的 TMDB 年）', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', [
      { title: 'Casablanca', originalTitle: 'Casablanca', year: 1942 },
    ])).toBe(false)
  })

  it('同名 hit 年份为 null 不算第二年 → true', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', [
      { title: 'Casablanca', originalTitle: 'Casablanca', year: null },
    ])).toBe(true)
  })
})

function emptyReport(over: Partial<FindSubtitleBatchReport> = {}): FindSubtitleBatchReport {
  return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null, ...over }
}

describe('applyYearFolderTypoGate', () => {
  const hits = [{ title: 'Casablanca', originalTitle: 'Casablanca', year: 1943 }]
  const bound = new Set(['tmdb:289'])

  it('已绑定 + identification-failed 年份 + typo ok → 从 no_safe_match 去掉并进 retry_later', () => {
    const report = emptyReport({
      no_safe_match: [{
        itemId: 'tmdb:289',
        reason: 'identification-failed: TMDB year 1943 does not match file year 1942; two-evidence bar not met',
      }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1942, tmdbYear: 1943, claimedTitle: 'Casablanca', hits, boundItemIds: bound,
    })
    expect(out.no_safe_match).toEqual([])
    expect(out.retry_later[0]?.itemId).toBe('tmdb:289')
    expect(out.retry_later[0]?.reason).toMatch(/year-folder-typo/)
    expect(report.no_safe_match).toHaveLength(1)
    expect(out).not.toBe(report)
  })

  it('typo 不成立时原样返回', () => {
    const report = emptyReport({
      no_safe_match: [{ itemId: 'tmdb:289', reason: 'identification-failed: year' }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1984, tmdbYear: 2021, claimedTitle: 'Dune',
      hits: [
        { title: 'Dune', originalTitle: null, year: 1984 },
        { title: 'Dune', originalTitle: null, year: 2021 },
      ],
      boundItemIds: new Set(['tmdb:289']),
    })
    expect(out.no_safe_match).toHaveLength(1)
    expect(out.retry_later).toEqual([])
  })

  it('已装上则只剥 no_safe_match，不重复塞 retry_later', () => {
    const report = emptyReport({
      installed: [{
        itemId: 'tmdb:289', installedPath: '/x.srt', installedLanguage: 'zh',
        candidateProvider: 'assrt', candidateProviderId: '1', reason: 'ok',
      }],
      no_safe_match: [{ itemId: 'tmdb:289', reason: 'identification-failed: year 1942' }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1942, tmdbYear: 1943, claimedTitle: 'Casablanca', hits, boundItemIds: bound,
    })
    expect(out.no_safe_match).toEqual([])
    expect(out.retry_later).toEqual([])
    expect(out.installed).toHaveLength(1)
  })

  it('真正源站没货（reason 不含 year/identification-failed）不动', () => {
    const report = emptyReport({
      no_safe_match: [{ itemId: 'tmdb:289', reason: 'no plausible candidate after search' }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1942, tmdbYear: 1943, claimedTitle: 'Casablanca', hits, boundItemIds: bound,
    })
    expect(out.no_safe_match).toHaveLength(1)
  })
})
