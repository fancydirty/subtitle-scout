import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { SubtitleVerifyRepo } from '../v2/subtitleVerifyRepo.js'
import {
  selectVerifyCandidates,
  runVerifySweep,
  VERIFY_SWEEP_MAX_ITEMS,
  VERIFY_SWEEP_BUDGET_MS,
  VERIFY_SWEEP_ITEM_TIMEOUT_MS,
  VERIFY_SWEEP_EVERY_MS,
  type VerifyCandidate,
  type VerifySweepDeps,
} from './verifySweep.js'
import { EMBEDDED_TOTAL_BUDGET_MS } from './referenceSource.js'
import type { VerifyOutcome } from './verifySubtitle.js'
import type { SubStatus } from '../v2/libraryRepo.js'

function outcome(over: Partial<VerifyOutcome> = {}): VerifyOutcome {
  return {
    verdict: 'aligned',
    offsetMs: null,
    score: 0.9,
    referenceTier: 'embedded',
    detail: 'test',
    subtitleHash: 'h',
    ...over,
  }
}

describe('verifySweep', () => {
  let db: ScoutDb
  let lib: LibraryRepo
  let repo: SubtitleVerifyRepo
  const logs: string[] = []

  beforeEach(() => {
    db = openDb(':memory:')
    lib = new LibraryRepo(db)
    repo = new SubtitleVerifyRepo(db)
    logs.length = 0
    // episodes.series_id 有 FK 约束，先立父行
    lib.upsertSeries({ id: 's1', name: 'Show' })
  })

  /** 种一集：episodes 行 + （可选）一条主文件外挂字幕行。 */
  const seedEpisode = (
    id: string,
    subStatus: SubStatus,
    opts: { subtitlePath?: string | null; replicaSubtitlePath?: string } = {},
  ): void => {
    lib.upsertEpisode({
      id, seriesId: 's1', season: 1, episode: Number(id.replace(/\D/g, '')) || 1,
      name: id, path: `/media/${id}.mkv`, subStatus,
    })
    const subPath = opts.subtitlePath === undefined ? `/media/${id}.zh-Hans.srt` : opts.subtitlePath
    if (subPath !== null) lib.recordAdoptedSidecar(id, subPath, 'zh-Hans', 1000)
    // file_path 非 NULL = 副本文件的字幕（addReplicaSubtitle 语义），不该被选成候选
    if (opts.replicaSubtitlePath) {
      lib.addReplicaSubtitle(id, `/media/${id}.replica.mkv`, opts.replicaSubtitlePath, 'zh-Hans', 'preexisting', 1000)
    }
  }

  const seedMovie = (id: string, subStatus: SubStatus, withSub = true): void => {
    lib.upsertMovie({ id, name: id, path: `/media/${id}.mkv`, subStatus })
    if (withSub) lib.recordAdoptedSidecar(id, `/media/${id}.zh-Hans.srt`, 'zh-Hans', 1000)
  }

  const makeDeps = (over: Partial<VerifySweepDeps> = {}): VerifySweepDeps => ({
    db,
    repo,
    verify: vi.fn(async () => outcome()),
    log: (m) => logs.push(m),
    now: () => 1_000_000,
    ...over,
  })

  // ---- 候选选取 ----

  describe('selectVerifyCandidates：状态白名单', () => {
    it('选中 covered 条目，带上片源路径与字幕路径', () => {
      seedEpisode('ep1', 'covered')
      expect(selectVerifyCandidates(db, 10)).toEqual([
        { itemId: 'ep1', videoPath: '/media/ep1.mkv', subtitlePath: '/media/ep1.zh-Hans.srt' },
      ])
    })

    it('movies 与 episodes 同一个 item_id 空间，两半都选', () => {
      seedEpisode('ep1', 'covered')
      seedMovie('mv1', 'covered')
      expect(selectVerifyCandidates(db, 10).map((c) => c.itemId).sort()).toEqual(['ep1', 'mv1'])
    })

    // 铁律级回归锁：embedded 是内嵌中字，没有外挂文件可检也可改——选进来只会产生一个
    // 点不动的红芯片。这个断言在"候选选取误包含 embedded"的变异下必红。
    it('排除 embedded（内嵌中字无外挂文件可校验/校正）', () => {
      seedEpisode('ep1', 'embedded')
      expect(selectVerifyCandidates(db, 10)).toEqual([])
    })

    it('排除 missing / unavailable / ignored / hardsub-assumed（无字幕文件可检）', () => {
      seedEpisode('ep-missing', 'missing')
      seedEpisode('ep-unavail', 'unavailable')
      seedEpisode('ep-ignored', 'ignored')
      seedEpisode('ep-hardsub', 'hardsub-assumed')
      expect(selectVerifyCandidates(db, 10)).toEqual([])
    })

    it('covered 但没有任何字幕行 → 不是候选（拿不到待检文件路径）', () => {
      seedEpisode('ep1', 'covered', { subtitlePath: null })
      expect(selectVerifyCandidates(db, 10)).toEqual([])
    })

    it('只有副本字幕（file_path 非 NULL）→ 不是候选（subtitle_verify 一行一集，副本会抢同一行）', () => {
      seedEpisode('ep1', 'covered', { subtitlePath: null, replicaSubtitlePath: '/media/ep1.replica.zh-Hans.srt' })
      expect(selectVerifyCandidates(db, 10)).toEqual([])
    })
  })

  describe('selectVerifyCandidates：已检过的不重复选', () => {
    it('subtitle_verify 已有行 → 不是候选', () => {
      seedEpisode('ep1', 'covered')
      repo.upsertVerifyResult({
        itemId: 'ep1', verdict: 'aligned',
        subtitlePath: '/media/ep1.zh-Hans.srt', subtitleHash: 'h', checkedAt: 1,
      })
      expect(selectVerifyCandidates(db, 10)).toEqual([])
    })

    it('别的条目有行不影响本条目（LEFT JOIN 按 item_id 对齐，不是全表存在性）', () => {
      seedEpisode('ep1', 'covered')
      seedEpisode('ep2', 'covered')
      repo.upsertVerifyResult({
        itemId: 'ep1', verdict: 'shifted', offsetMs: 2000,
        subtitlePath: '/media/ep1.zh-Hans.srt', subtitleHash: 'h', checkedAt: 1,
      })
      expect(selectVerifyCandidates(db, 10).map((c) => c.itemId)).toEqual(['ep2'])
    })
  })

  describe('selectVerifyCandidates：批次上限', () => {
    it('尊重 limit，不返回超额条目', () => {
      for (let i = 1; i <= 12; i++) seedEpisode(`ep${i}`, 'covered')
      expect(selectVerifyCandidates(db, 5)).toHaveLength(5)
    })

    it('limit<=0 → 空数组，且不查库', () => {
      seedEpisode('ep1', 'covered')
      expect(selectVerifyCandidates(db, 0)).toEqual([])
      expect(selectVerifyCandidates(db, -1)).toEqual([])
    })

    // 一条目多份字幕（简繁两份）时上限按**条目数**算，不按 SQL 行数——否则 SQL LIMIT 5
    // 在多份字幕的库上只对应 3 个条目，批次上限低于设定值。
    it('一条目挂多份字幕时只取一份，且上限按条目数计', () => {
      for (let i = 1; i <= 3; i++) {
        seedEpisode(`ep${i}`, 'covered')
        lib.recordAdoptedSidecar(`ep${i}`, `/media/ep${i}.zh-Hant.srt`, 'zh-Hant', 1000)
      }
      const got = selectVerifyCandidates(db, 3)
      expect(got).toHaveLength(3)
      expect(got.map((c) => c.itemId)).toEqual(['ep1', 'ep2', 'ep3'])
    })

    it('同一条目跨轮次恒选中同一个字幕文件（否则 needsRecheck 每轮都判"换了文件"，永不收敛）', () => {
      seedEpisode('ep1', 'covered')
      lib.recordAdoptedSidecar('ep1', '/media/ep1.zh-Hant.srt', 'zh-Hant', 1000)
      lib.recordAdoptedSidecar('ep1', '/media/ep1.en.srt', 'en', 1000)
      const first = selectVerifyCandidates(db, 10)
      const second = selectVerifyCandidates(db, 10)
      expect(first).toEqual(second)
      expect(first).toHaveLength(1)
    })
  })

  // ---- 扫描执行 ----

  describe('runVerifySweep：预算上限', () => {
    it('默认条数上限 = VERIFY_SWEEP_MAX_ITEMS，绝不扫全库', async () => {
      for (let i = 1; i <= 30; i++) seedEpisode(`ep${i}`, 'covered')
      const verify = vi.fn(async () => outcome())
      const res = await runVerifySweep(makeDeps({ verify }))
      expect(verify).toHaveBeenCalledTimes(VERIFY_SWEEP_MAX_ITEMS)
      expect(res.checked).toBe(VERIFY_SWEEP_MAX_ITEMS)
    })

    it('maxItems 可注入并被尊重', async () => {
      for (let i = 1; i <= 10; i++) seedEpisode(`ep${i}`, 'covered')
      const verify = vi.fn(async () => outcome())
      await runVerifySweep(makeDeps({ verify, maxItems: 2 }))
      expect(verify).toHaveBeenCalledTimes(2)
    })

    it('墙钟预算耗尽后不再开新条目，剩余留给下一轮', async () => {
      for (let i = 1; i <= 5; i++) seedEpisode(`ep${i}`, 'covered')
      // 假时钟：每次 now() 前进 40s —— 第一条无条件开工，之后累计越过 60s 预算
      let t = 0
      const verify = vi.fn(async () => outcome())
      const res = await runVerifySweep(makeDeps({
        verify, budgetMs: 60_000, now: () => { t += 40_000; return t },
      }))
      expect(verify).toHaveBeenCalledTimes(1)
      expect(res.budgetSkipped).toBe(4)
      expect(logs.some((l) => l.includes('墙钟预算'))).toBe(true)
    })

    it('第一条无条件开工（预算防多条累加，不防单条慢——否则慢盘上本分支永不铺量）', async () => {
      seedEpisode('ep1', 'covered')
      const verify = vi.fn(async () => outcome())
      // now() 恒返回一个已远超预算的值：elapsed 在 index 0 时仍为 0
      const res = await runVerifySweep(makeDeps({ verify, budgetMs: 1, now: () => 9_999_999 }))
      expect(verify).toHaveBeenCalledTimes(1)
      expect(res.checked).toBe(1)
    })

    it('无候选时零调用、零日志', async () => {
      const verify = vi.fn(async () => outcome())
      const res = await runVerifySweep(makeDeps({ verify }))
      expect(verify).not.toHaveBeenCalled()
      expect(res).toEqual({ checked: 0, skipped: 0, failed: 0, budgetSkipped: 0 })
      expect(logs).toEqual([])
    })
  })

  describe('runVerifySweep：串行（绝不并行 spawn ffmpeg 抢 IO）', () => {
    it('同一时刻最多一条在跑', async () => {
      for (let i = 1; i <= 4; i++) seedEpisode(`ep${i}`, 'covered')
      let inflight = 0
      let maxInflight = 0
      const verify = vi.fn(async () => {
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        await new Promise((r) => setTimeout(r, 1))
        inflight--
        return outcome()
      })
      await runVerifySweep(makeDeps({ verify }))
      expect(verify).toHaveBeenCalledTimes(4)
      expect(maxInflight).toBe(1)
    })
  })

  describe('runVerifySweep：失败不阻塞', () => {
    it('单条抛错被隔离，后续条目照常处理，函数本身不抛', async () => {
      for (let i = 1; i <= 3; i++) seedEpisode(`ep${i}`, 'covered')
      const verify = vi.fn(async (c: VerifyCandidate) => {
        if (c.itemId === 'ep2') throw new Error('ffmpeg 挂了')
        return outcome()
      })
      const res = await runVerifySweep(makeDeps({ verify }))
      expect(verify).toHaveBeenCalledTimes(3)
      expect(res).toEqual({ checked: 2, skipped: 0, failed: 1, budgetSkipped: 0 })
      expect(logs.some((l) => l.includes('ep2') && l.includes('ffmpeg 挂了'))).toBe(true)
    })

    it('全部失败也不抛（daemon 的既有纪律：一条坏字幕不能炸后台循环）', async () => {
      for (let i = 1; i <= 3; i++) seedEpisode(`ep${i}`, 'covered')
      const verify = vi.fn(async () => { throw new Error('boom') })
      await expect(runVerifySweep(makeDeps({ verify }))).resolves.toEqual({
        checked: 0, skipped: 0, failed: 3, budgetSkipped: 0,
      })
    })

    it('单条超时被计为失败并继续（且不落库——不知道结论时写假结论会让它永不重试）', async () => {
      seedEpisode('ep1', 'covered')
      seedEpisode('ep2', 'covered')
      const verify = vi.fn(async (c: VerifyCandidate) =>
        c.itemId === 'ep1' ? new Promise<VerifyOutcome>(() => {}) : outcome())
      const res = await runVerifySweep(makeDeps({ verify, itemTimeoutMs: 5 }))
      expect(res.failed).toBe(1)
      expect(res.checked).toBe(1)
      expect(repo.getVerifyResult('ep1')).toBeNull()
    })
  })

  describe('runVerifySweep：跳过判据来自 verifyAndRecord', () => {
    it('verify 返回 null（哈希未变）计入 skipped 而非 checked', async () => {
      seedEpisode('ep1', 'covered')
      seedEpisode('ep2', 'covered')
      const verify = vi.fn(async (c: VerifyCandidate) => (c.itemId === 'ep1' ? null : outcome()))
      const res = await runVerifySweep(makeDeps({ verify }))
      expect(res).toEqual({ checked: 1, skipped: 1, failed: 0, budgetSkipped: 0 })
    })
  })

  describe('spec 铁律③：巡检只检测，绝不校正', () => {
    // 回归锁：本模块的依赖面里**不存在**任何平移/撤销能力。若有人给 VerifySweepDeps 加了
    // shift/correct 之类的注入口并在 runVerifySweep 里调它，这个断言会当场变红。
    it('VerifySweepDeps 不含任何写字幕文件的能力（依赖面锁）', () => {
      const deps = makeDeps()
      expect(Object.keys(deps).sort()).toEqual(['db', 'log', 'now', 'repo', 'verify'])
    })

    it('shifted 结论只落库、不触发任何后续动作（红芯片亮起等用户点）', async () => {
      seedEpisode('ep1', 'covered')
      const verify = vi.fn(async () => outcome({ verdict: 'shifted', offsetMs: 2000 }))
      const res = await runVerifySweep(makeDeps({ verify }))
      // verify 恰好被调用一次——发现偏移后没有第二次调用（没有"顺手校正再重检"）
      expect(verify).toHaveBeenCalledTimes(1)
      expect(res.checked).toBe(1)
    })

    it('本模块源码不引用 shiftTiming（静态锁：巡检绝不改写用户文件）', async () => {
      const { readFileSync } = await import('node:fs')
      const src = readFileSync(new URL('./verifySweep.ts', import.meta.url), 'utf8')
      // 注释里可以谈论它（文件头就解释了为什么不能有）；import 语句里绝不能出现。
      const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n')
      expect(imports).not.toMatch(/shiftTiming/)
    })
  })

  describe('常量的相互约束', () => {
    // 单条目超时必须严格大于 referenceSource 的 ①层总预算，否则这道门会常态性砍掉
    // ①层跑完最后一条轨的合法路径，把"能验证"系统性变成"没验证"。
    it('单条目超时 > EMBEDDED_TOTAL_BUDGET_MS', () => {
      expect(VERIFY_SWEEP_ITEM_TIMEOUT_MS).toBeGreaterThan(EMBEDDED_TOTAL_BUDGET_MS)
    })

    it('批次墙钟预算 >= 条数上限 × ①层单条目预算（两个上限咬合，任一先到都止损）', () => {
      expect(VERIFY_SWEEP_BUDGET_MS).toBeGreaterThanOrEqual(
        VERIFY_SWEEP_MAX_ITEMS * EMBEDDED_TOTAL_BUDGET_MS,
      )
    })

    it('巡检间隔远大于单次扫描预算（低频：不是热路径）', () => {
      expect(VERIFY_SWEEP_EVERY_MS).toBeGreaterThan(VERIFY_SWEEP_BUDGET_MS * 10)
    })
  })
})
