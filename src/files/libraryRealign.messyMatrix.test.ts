import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanVideoFiles, buildRealignPlan } from './libraryRealign.js'
import type { SeasonTableEntry } from '../adapters/providers/tmdb.js'

function mkDir(...parts: string[]): string {
  const dir = join(...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

// 乱排布矩阵：验收记录（真实 tmp 目录，离线，无 docker）——诊断 + 计划构建两层的验收断言。
// Five naming shapes cover the realignment regression scenarios:
//   1. 绝对编号平铺（真实 bug 形状）——必须成功建出整理计划
//   2. 错位（已用 SxxEyy 记法但集号整体偏移）——不是本次 realign 的目标，必须整剧放弃
//   3. 合集文件（E01-02 合并）——合集文件隔离，其余单集正常整理
//   4. 特别篇混入（S0 与正片同目录）——已用 SxxEyy 记法，必须整剧放弃，不误伤
//   5. 正常库（控制组）——诊断主信号不成立 + 建不出任何整理计划，两层都确认"不动手"
//      （假阳性守卫：这是全矩阵里最重要的一条断言，一个正常库被误诊断/误整理比"漏诊"更糟）
describe('乱排布矩阵（验收记录：5 种形态）', () => {
  it('形态1 绝对编号平铺：40 个裸 E{n} 文件 → 计划成功，S1×25/S2×12/S3×3，无隔离', () => {
    const root = mkdtempSync(join(tmpdir(), 'messy-flat-'))
    const seasonDir = mkDir(root, 'Spy x Family (2022)', 'Season 01')
    for (let i = 1; i <= 40; i++) writeFileSync(join(seasonDir, `Spy x Family (2022) E${i}.mkv`), '')
    const files = scanVideoFiles(seasonDir)
    expect(files).toHaveLength(40)
    const seasonTable: SeasonTableEntry[] = [
      { seasonNumber: 1, episodeCount: 25, airDate: null },
      { seasonNumber: 2, episodeCount: 12, airDate: null },
      { seasonNumber: 3, episodeCount: 3, airDate: null },
    ]
    const result = buildRealignPlan(files, { seriesTitle: 'Spy x Family', year: 2022, tmdbId: '120089', seasonTable })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.items.filter(i => i.targetSeason === 1)).toHaveLength(25)
    expect(result.items.filter(i => i.targetSeason === 2)).toHaveLength(12)
    expect(result.items.filter(i => i.targetSeason === 3)).toHaveLength(3)
    expect(result.quarantined).toHaveLength(0)
  })

  it('形态2 错位（已含 SxxEyy 记法）：不解析为绝对编号，整剧放弃（不当绝对编号平铺处理）', () => {
    const root = mkdtempSync(join(tmpdir(), 'messy-offset-'))
    const seasonDir = mkDir(root, 'Offset Show (2021)', 'Season 01')
    for (let i = 1; i <= 25; i++) {
      writeFileSync(join(seasonDir, `Offset Show (2021) S01E${String(i + 1).padStart(2, '0')}.mkv`), '')
    }
    const files = scanVideoFiles(seasonDir)
    for (const f of files) expect(f.match).toBeNull() // 已是 SxxEyy 记法，一律不当绝对编号处理
    const seasonTable: SeasonTableEntry[] = [{ seasonNumber: 1, episodeCount: 25, airDate: null }]
    const result = buildRealignPlan(files, { seriesTitle: 'Offset Show', year: 2021, tmdbId: '1', seasonTable })
    expect(result.ok).toBe(false) // 全部解不出绝对集号 → "没有任何文件能解析出绝对集号"
  })

  it('形态3 合集文件（E01-02 合并）：合集文件解不出集号进隔离区，单集文件正常整理', () => {
    const root = mkdtempSync(join(tmpdir(), 'messy-combined-'))
    const seasonDir = mkDir(root, 'Combined Show (2020)', 'Season 01')
    writeFileSync(join(seasonDir, 'Combined Show (2020) E01-02.mkv'), '')
    // 配够单集文件让可解析覆盖率 ≥80%（libraryRealign.ts MIN_PARSEABLE_COVERAGE 闸门）——
    // 只有合集文件 + 1 个单集文件覆盖率只有 50%，会被覆盖率闸门整剧拒绝，测不出"合集文件
    // 隔离、其余正常整理"这条设计意图；9 个单集（8/9≈89%）留出安全余量越过阈值。
    for (let i = 3; i <= 11; i++) writeFileSync(join(seasonDir, `Combined Show (2020) E${i}.mkv`), '')
    const files = scanVideoFiles(seasonDir)
    expect(files).toHaveLength(10)
    const seasonTable: SeasonTableEntry[] = [{ seasonNumber: 1, episodeCount: 11, airDate: null }]
    const result = buildRealignPlan(files, { seriesTitle: 'Combined Show', year: 2020, tmdbId: '1', seasonTable })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.items).toHaveLength(9) // E03..E11
    expect(result.quarantined.map(f => f.filename)).toEqual(['Combined Show (2020) E01-02.mkv'])
  })

  it('形态4 特别篇混入：S0 与正片同目录，两者都已是 SxxEyy 记法 → 判 null，整剧放弃，不误伤', () => {
    const root = mkdtempSync(join(tmpdir(), 'messy-specials-'))
    const seasonDir = mkDir(root, 'Specials Mixed Show (2019)', 'Season 01')
    writeFileSync(join(seasonDir, 'Specials Mixed Show (2019) S01E01.mkv'), '')
    writeFileSync(join(seasonDir, 'Specials Mixed Show (2019) S00E01.mkv'), '')
    const files = scanVideoFiles(seasonDir)
    for (const f of files) expect(f.match).toBeNull() // 两个文件都已是 SxxEyy 记法
    const seasonTable: SeasonTableEntry[] = [{ seasonNumber: 1, episodeCount: 12, airDate: null }]
    const result = buildRealignPlan(files, { seriesTitle: 'Specials Mixed Show', year: 2019, tmdbId: '1', seasonTable })
    expect(result.ok).toBe(false) // 全部解不出 → 整理放弃（本就不该被误判成绝对编号平铺）
  })

  it('形态5 正常库（控制组）：正确组织的库既建不出整理计划、诊断主信号也不成立——假阳性守卫的核心断言', () => {
    const root = mkdtempSync(join(tmpdir(), 'messy-normal-'))
    const seasonDir = mkDir(root, 'Normal Show (2018)', 'Season 01')
    for (let i = 1; i <= 3; i++) writeFileSync(join(seasonDir, `Normal Show (2018) S01E0${i}.mkv`), '')
    const files = scanVideoFiles(seasonDir)
    // 全部已是 SxxEyy 记法——不是绝对编号平铺的目标，parseAbsoluteEpisodeNumber 一律 null。
    for (const f of files) expect(f.match).toBeNull()

    // 第一层守卫（计划构建）：一个字节的整理计划都建不出来。
    const seasonTable: SeasonTableEntry[] = [{ seasonNumber: 1, episodeCount: 3, airDate: null }]
    const planResult = buildRealignPlan(files, { seriesTitle: 'Normal Show', year: 2018, tmdbId: '1', seasonTable })
    expect(planResult.ok).toBe(false) // headline assertion：正常库产不出 realign 计划

    // ── 2026-08-13：原先这里有第二层守卫，断言 `mirrorExceedsSeasonTable`（core/seasonShape.ts）
    // 对本形态判 false。该模块本轮随死代码清理删除——它的头注释声称消费方是
    // `orchestratorAgent.tools.ts`，但那个文件早已不存在（旧管线退役时删掉），全仓
    // 除本行外零引用。**留着这条断言就得留着整个模块**，而模块唯一的存在理由就是这条断言：
    // 那是自证循环，不是守卫。
    //
    // ⚠️ 删的是「对一个没有生产消费方的纯函数的断言」，不是本用例的判据——上面那条
    // headline（正常库产不出 realign 计划）才是本用例的真判据，它走的是真产品代码
    // `buildRealignPlan`，原样保留。变异实测见本轮报告：把 buildRealignPlan 的闸门放开
    // 这条会红。
  })
})
