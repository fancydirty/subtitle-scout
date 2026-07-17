import { describe, it, expect, vi } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, statSync,
  readdirSync, appendFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import {
  mountAliveSentinel, chooseRealignStrategy, archiveDirFor,
  planCollisions, invisibleBuildDir, assembleInvisibleTree, finalizeShowDir,
  archiveOldDir, buildRealignEpisodeFields, makeRealignRunEpisode,
  waitForIngestIdle, verifyRealignedCounts,
  executeRealign, type RealignExecutorDeps, type RealignLibraryPort,
} from './realignExecutor.js'
import { scanVideoFiles, buildRealignPlan, type RealignPlanItem } from '../files/libraryRealign.js'
import {
  initManifest, appendManifestEntry, manifestPath, readManifest,
} from '../files/realignManifest.js'
import { isUnderRoots } from '../core/mediaContext.js'
import type { FindSubtitleTask, FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'
import { episodeId } from './ownIds.js'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { JobsRepo } from './jobsRepo.js'

describe('mountAliveSentinel', () => {
  it('库根不存在 → 拒绝', () => {
    const result = mountAliveSentinel(join(tmpdir(), 'does-not-exist-' + Date.now()))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不存在')
  })

  it('库根为空（疑似挂载掉线）→ 拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realign-sentinel-empty-'))
    const result = mountAliveSentinel(dir)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('为空')
  })

  it('库根非空且可写 → 通过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realign-sentinel-ok-'))
    writeFileSync(join(dir, 'Show'), '') // 随便有点内容
    const result = mountAliveSentinel(dir)
    expect(result.ok).toBe(true)
  })

  it('库根非空但不可写 → 拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realign-sentinel-ro-'))
    writeFileSync(join(dir, 'Show'), '')
    chmodSync(dir, 0o555)
    try {
      const result = mountAliveSentinel(dir)
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('不可写')
    } finally {
      chmodSync(dir, 0o755) // 还原，避免 vitest 清理临时目录时因权限报错
    }
  })
})

describe('chooseRealignStrategy', () => {
  it('不可写 → abandon', () => {
    expect(chooseRealignStrategy({ writable: false, hardlink: true }, true)).toBe('abandon')
  })
  it('可写 + 支持硬链接 → hardlink（优先，做种保护）', () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: true }, true)).toBe('hardlink')
  })
  it('可写 + 不支持硬链接 + rename 跨库根↔归档目录原子 → rename', () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: false }, true)).toBe('rename')
  })
  it('可写 + 不支持硬链接 + rename 不原子（极端 FUSE）→ abandon（宁不做，不做烂）', () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: false }, false)).toBe('abandon')
  })
  // 探针是三态的（mountCapabilities.ProbeOutcome）：'unknown' = 没条件探，绝不能当探出来了。
  it("hardlink 探测 'unknown' 不算支持——rename 原子则降到 rename", () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: 'unknown' }, true)).toBe('rename')
  })
  it("rename 探测 'unknown' 不算原子——abandon", () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: false }, 'unknown')).toBe('abandon')
    expect(chooseRealignStrategy({ writable: true, hardlink: 'unknown' }, 'unknown')).toBe('abandon')
  })
  // GAP B（re-review #2）：archiveOldDir（步骤 14）无条件用 renameSync 把旧目录整棵搬进
  // 归档，与 strategy 是否探明支持硬链接无关——"支持硬链接"绝不能绕过 renameAtomic 检查，
  // 否则在"硬链接可用但归档根跨设备"的环境下会在归档这一步 EXDEV。
  it('GAP B：支持硬链接但 rename 不原子（跨设备归档根）→ abandon，绝不因硬链接放行', () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: true }, false)).toBe('abandon')
  })
  it('GAP B：支持硬链接但 rename 原子性 unknown → abandon，绝不因硬链接放行', () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: true }, 'unknown')).toBe('abandon')
  })
})

describe('archiveDirFor', () => {
  it('拼出 <归档根>/.archive/<剧名>-<时间戳>/', () => {
    expect(archiveDirFor('/media', '间谍过家家', 1720000000000)).toBe('/media/.archive/间谍过家家-1720000000000')
  })
  it('剧名文件系统安全化（Fate/Zero 不得把归档目录拆成两层）', () => {
    expect(archiveDirFor('/media', 'Fate/Zero', 1)).toBe('/media/.archive/Fate Zero-1')
  })
})

describe('planCollisions', () => {
  const items: RealignPlanItem[] = [
    { sourcePath: '/src/a.mkv', sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-1]/Season 01/x.mkv' },
    { sourcePath: '/src/b.mkv', sourceFilename: 'b.mkv', absoluteEpisode: 2, targetSeason: 1, targetEpisode: 2, targetRelPath: 'Show (2022) [tmdbid-1]/Season 01/y.mkv' },
    { sourcePath: '/src/c.mkv', sourceFilename: 'c.mkv', absoluteEpisode: 3, targetSeason: 1, targetEpisode: 3, targetRelPath: 'Show (2022) [tmdbid-1]/Season 01/z.mkv' },
  ]
  const getSize = (p: string): number | null => {
    const sizes: Record<string, number> = {
      '/src/a.mkv': 100, '/src/b.mkv': 200, '/src/c.mkv': 300,
      '/lib/Show (2022) [tmdbid-1]/Season 01/x.mkv': 100, // 同尺寸——已完成
      '/lib/Show (2022) [tmdbid-1]/Season 01/y.mkv': 999, // 不同尺寸——隔离
    }
    return sizes[p] ?? null
  }
  it('无碰撞的文件进 toMove；同尺寸碰撞进 alreadyDone；不同尺寸碰撞进 quarantine', () => {
    const result = planCollisions(items, '/lib', getSize)
    expect(result.toMove.map(i => i.sourcePath)).toEqual(['/src/c.mkv'])
    expect(result.alreadyDone.map(i => i.sourcePath)).toEqual(['/src/a.mkv'])
    expect(result.quarantine.map(i => i.sourcePath)).toEqual(['/src/b.mkv'])
    expect(result.quarantine[0].reason).toContain('尺寸不同')
  })
})

describe('不可见组装', () => {
  it('invisibleBuildDir 拼出 <libRoot>/.realign-build/<show>', () => {
    expect(invisibleBuildDir('/media/tv', 'Show (2022) [tmdbid-1]')).toBe('/media/tv/.realign-build/Show (2022) [tmdbid-1]')
  })

  it('assembleInvisibleTree：每个文件 rename 进 .realign-build/ 对应位置，先调用 onEntry 记账', () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-build-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.mkv'), 'A')
    const items: RealignPlanItem[] = [
      { sourcePath: join(root, 'src', 'a.mkv'), sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-1]/Season 01/final-a.mkv' },
    ]
    const recorded: Array<{ from: string; to: string }> = []
    assembleInvisibleTree(root, 'Show (2022) [tmdbid-1]', items, (from, to) => recorded.push({ from, to }))
    const finalPath = join(root, '.realign-build', 'Show (2022) [tmdbid-1]', 'Season 01', 'final-a.mkv')
    expect(existsSync(finalPath)).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe('A')
    expect(existsSync(join(root, 'src', 'a.mkv'))).toBe(false) // 源文件已被 rename 走
    expect(recorded).toEqual([{ from: join(root, 'src', 'a.mkv'), to: finalPath }])
    expect(existsSync(join(root, '.realign-build', '.ignore'))).toBe(true)
  })

  it('assembleInvisibleTree：onEntry 先于 renameSync（write-ahead——记账那一刻源文件还在原地）', () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-build-wa-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.mkv'), 'A')
    const items: RealignPlanItem[] = [
      { sourcePath: join(root, 'src', 'a.mkv'), sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'Show/Season 01/a.mkv' },
    ]
    let sourceStillThereAtRecordTime = false
    assembleInvisibleTree(root, 'Show', items, (from) => {
      sourceStillThereAtRecordTime = existsSync(from)
    })
    expect(sourceStillThereAtRecordTime).toBe(true)
  })

  it('assembleInvisibleTree：build 目标位置已有文件 → 拒绝覆盖，抛错（绝不静默 clobber）', () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-build-clobber-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.mkv'), 'NEW')
    const stale = join(root, '.realign-build', 'Show', 'Season 01', 'a.mkv')
    mkdirSync(dirname(stale), { recursive: true })
    writeFileSync(stale, 'STALE')
    const items: RealignPlanItem[] = [
      { sourcePath: join(root, 'src', 'a.mkv'), sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'Show/Season 01/a.mkv' },
    ]
    expect(() => assembleInvisibleTree(root, 'Show', items, () => {})).toThrow(/拒绝覆盖/)
    expect(readFileSync(stale, 'utf8')).toBe('STALE')          // 既有文件原样
    expect(readFileSync(join(root, 'src', 'a.mkv'), 'utf8')).toBe('NEW') // 源文件没被搬
  })

  it('finalizeShowDir：目录级原子 rename 到最终位置', () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-finalize-'))
    mkdirSync(join(root, '.realign-build', 'Show (2022) [tmdbid-1]', 'Season 01'), { recursive: true })
    writeFileSync(join(root, '.realign-build', 'Show (2022) [tmdbid-1]', 'Season 01', 'a.mkv'), 'A')
    const finalDir = finalizeShowDir(root, 'Show (2022) [tmdbid-1]')
    expect(finalDir).toBe(join(root, 'Show (2022) [tmdbid-1]'))
    expect(existsSync(join(finalDir, 'Season 01', 'a.mkv'))).toBe(true)
    expect(existsSync(join(root, '.realign-build', 'Show (2022) [tmdbid-1]'))).toBe(false)
  })

  it('finalizeShowDir：目标已存在时拒绝覆盖，抛错', () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-finalize-collide-'))
    mkdirSync(join(root, '.realign-build', 'Show'), { recursive: true })
    mkdirSync(join(root, 'Show'), { recursive: true })
    expect(() => finalizeShowDir(root, 'Show')).toThrow(/已存在/)
  })
})

describe('archiveOldDir', () => {
  it('把旧目录残骸整体 rename 进归档目录，附 .ignore 双保险', () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-archive-'))
    const oldDir = join(root, 'lib', 'Show', 'Season 01')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, '合集 01-02.mkv'), 'quarantined') // 隔离文件残留
    const archiveDir = join(root, 'archive', 'Show-123')

    const finalPath = archiveOldDir(oldDir, archiveDir)

    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(join(archiveDir, 'Season 01', '合集 01-02.mkv'))).toBe(true)
    expect(existsSync(join(archiveDir, '.ignore'))).toBe(true)
    expect(finalPath).toBe(join(archiveDir, 'Season 01'))
  })
})

const NO_ENRICHMENT = { originalTitle: null, alternativeTitles: [], overview: null, runtimeMinutes: null }

describe('buildRealignEpisodeFields', () => {
  it('字面构造字段：tmdbid 钉死、季集来自计划、itemId 走 episodes 自有 id 空间（ownIds.episodeId）', () => {
    const item: RealignPlanItem = {
      sourcePath: '/x.mkv', sourceFilename: 'x.mkv', absoluteEpisode: 26,
      targetSeason: 2, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-120089]/Season 02/y.mkv',
    }
    const ctx = buildRealignEpisodeFields(
      '间谍过家家', 2022, '120089', item, '/lib/Show (2022) [tmdbid-120089]/Season 02/y.mkv', NO_ENRICHMENT,
    )
    expect(ctx.season).toBe(2)
    expect(ctx.episode).toBe(1)
    expect(ctx.providerIds.tmdb).toBe('120089')
    expect(ctx.videoPath).toBe('/lib/Show (2022) [tmdbid-120089]/Season 02/y.mkv')
    expect(ctx.videoFilename).toBe('y.mkv')
    expect(ctx.title).toBe('间谍过家家')
    expect(ctx.year).toBe(2022)
    expect(ctx.itemId).toBe(episodeId('120089', 2, 1))
  })

  // A-F13 富化补面：TMDB 可达时，enrichment 参数（fetchTmdbEnrichment 的产出，由调用方
  // executeRealign 一次性取得）原样传导进字段——不再像老实现（C-B4 处决前）那样把
  // original_title/alternative_titles/overview/runtime_minutes 硬编码成 null/[]。
  it('富化补面：TMDB 可达时 originalTitle/alternativeTitles/overview/runtimeMinutes 原样传导', () => {
    const item: RealignPlanItem = {
      sourcePath: '/x.mkv', sourceFilename: 'x.mkv', absoluteEpisode: 26,
      targetSeason: 2, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-120089]/Season 02/y.mkv',
    }
    const ctx = buildRealignEpisodeFields(
      '间谍过家家', 2022, '120089', item, '/lib/Show (2022) [tmdbid-120089]/Season 02/y.mkv',
      { originalTitle: 'SPY×FAMILY', alternativeTitles: ['间谍家家酒'], overview: 'A spy, an assassin, a telepath.', runtimeMinutes: 24 },
    )
    expect(ctx.originalTitle).toBe('SPY×FAMILY')
    expect(ctx.alternativeTitles).toEqual(['间谍家家酒'])
    expect(ctx.overview).toBe('A spy, an assassin, a telepath.')
    expect(ctx.runtimeMinutes).toBe(24)
  })

  it('富化补面：TMDB 不可达时 originalTitle/overview/runtimeMinutes 为 null、alternativeTitles 为 []，不抛错', () => {
    const item: RealignPlanItem = {
      sourcePath: '/x.mkv', sourceFilename: 'x.mkv', absoluteEpisode: 26,
      targetSeason: 2, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-120089]/Season 02/y.mkv',
    }
    const ctx = buildRealignEpisodeFields(
      '间谍过家家', 2022, '120089', item, '/lib/Show (2022) [tmdbid-120089]/Season 02/y.mkv', NO_ENRICHMENT,
    )
    expect(ctx.originalTitle).toBeNull()
    expect(ctx.alternativeTitles).toEqual([])
    expect(ctx.overview).toBeNull()
    expect(ctx.runtimeMinutes).toBeNull()
  })
})

describe('makeRealignRunEpisode', () => {
  const item: RealignPlanItem = {
    sourcePath: '/src/y.mkv', sourceFilename: 'y.mkv', absoluteEpisode: 26,
    targetSeason: 2, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-120089]/Season 02/y.mkv',
  }

  it('把 realign ctx 翻译成单目标批量 FindSubtitleTask：videoPath 是 .realign-build 路径，mediaRoot 是库根（.realign-build 之前那一级，不是这一集自己的深层目录），季集/标题/tmdbId 都来自 ctx，targets 恰好一项且其 absoluteEpisode 为 null（与 realign 自己的绝对集号语义不同源，见实现注释）', async () => {
    const ctx = buildRealignEpisodeFields(
      '间谍过家家', 2022, '120089', item,
      '/lib/tv/.realign-build/Show (2022) [tmdbid-120089]/Season 02/y.mkv',
      NO_ENRICHMENT,
    )
    let capturedTask: FindSubtitleTask | undefined
    const report: FindSubtitleBatchReport = {
      installed: [{
        itemId: ctx.itemId,
        installedPath: '/lib/tv/.realign-build/Show (2022) [tmdbid-120089]/Season 02/y.zh.srt',
        installedLanguage: 'zh-Hans', candidateProvider: 'assrt', candidateProviderId: '1', reason: 'ok',
      }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    }
    const runFindSubtitleTask = vi.fn(async (task: FindSubtitleTask) => {
      capturedTask = task
      return report
    })
    const runEpisode = makeRealignRunEpisode({ runFindSubtitleTask })

    const result = await runEpisode(
      ctx,
      '/lib/tv/.realign-build/Show (2022) [tmdbid-120089]/Season 02',
      'job-1-26',
    )

    expect(runFindSubtitleTask).toHaveBeenCalledTimes(1)
    expect(capturedTask!.targets).toHaveLength(1)
    expect(capturedTask!.targets[0].videoPath).toBe('/lib/tv/.realign-build/Show (2022) [tmdbid-120089]/Season 02/y.mkv')
    expect(capturedTask!.targets[0].videoFilename).toBe('y.mkv')
    expect(capturedTask!.mediaRoot).toBe('/lib/tv') // 库根，不是这一集的深层 outDir
    expect(capturedTask!.jobId).toBe('job-1-26')
    expect(capturedTask!.targets[0].season).toBe(2)
    expect(capturedTask!.targets[0].episode).toBe(1)
    expect(capturedTask!.targets[0].absoluteEpisode).toBeNull()
    expect(capturedTask!.targets[0].itemId).toBe(ctx.itemId)
    expect(capturedTask!.title).toBe('间谍过家家')
    expect(capturedTask!.year).toBe(2022)
    expect(capturedTask!.providerIds.tmdb).toBe('120089')
    expect(result).toEqual(report)
  })

  it('mediaRoot 推导让 find-subtitle worker 自己的沙盒判定 isUnderRoots(dirname(videoPath), [mediaRoot]) 通过', async () => {
    const ctx = buildRealignEpisodeFields(
      'Show', 2020, '1', item,
      '/media/tv/.realign-build/Show (2020) [tmdbid-1]/Season 02/y.mkv',
      NO_ENRICHMENT,
    )
    let capturedMediaRoot = ''
    const runFindSubtitleTask = vi.fn(async (task: FindSubtitleTask) => {
      capturedMediaRoot = task.mediaRoot
      return { installed: [], no_safe_match: [{ itemId: ctx.itemId, reason: 'x' }], retry_later: [], hardsub_assumed: [] }
    })
    const runEpisode = makeRealignRunEpisode({ runFindSubtitleTask })

    await runEpisode(ctx, '/media/tv/.realign-build/Show (2020) [tmdbid-1]/Season 02', 'job-2')

    expect(isUnderRoots(dirname(ctx.videoPath), [capturedMediaRoot])).toBe(true)
  })

  it('outDir 不含 .realign-build 段 → 抛错（mediaRoot 推导失败，绝不猜一个不安全的根）', async () => {
    const ctx = buildRealignEpisodeFields('Show', 2020, '1', item, '/lib/tv/Show/Season 02/y.mkv', NO_ENRICHMENT)
    const runFindSubtitleTask = vi.fn()
    const runEpisode = makeRealignRunEpisode({ runFindSubtitleTask })

    await expect(runEpisode(ctx, '/lib/tv/Show/Season 02', 'job-3')).rejects.toThrow(/\.realign-build/)
    expect(runFindSubtitleTask).not.toHaveBeenCalled()
  })
})

describe('waitForIngestIdle', () => {
  it('无运行中任务 → 立即 true，不 sleep', async () => {
    const jf = { getScheduledTasks: vi.fn(async () => [{ id: '1', name: 'scan', isRunning: false }]) }
    const sleep = vi.fn(async () => {})
    const ok = await waitForIngestIdle(jf, { pollMs: 10, timeoutMs: 1000, sleep })
    expect(ok).toBe(true)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('先运行后空闲 → 轮询几次后 true', async () => {
    let calls = 0
    const jf = { getScheduledTasks: vi.fn(async () => { calls++; return [{ id: '1', name: 'scan', isRunning: calls < 3 }] }) }
    const sleep = vi.fn(async () => {})
    const ok = await waitForIngestIdle(jf, { pollMs: 10, timeoutMs: 10_000, sleep })
    expect(ok).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('超时仍在跑 → false（假时钟注入，不真等也不篡改全局 Date.now）', async () => {
    const jf = { getScheduledTasks: vi.fn(async () => [{ id: '1', name: 'scan', isRunning: true }]) }
    let clock = 0
    const ok = await waitForIngestIdle(jf, {
      pollMs: 100, timeoutMs: 250,
      sleep: async (ms) => { clock += ms },
      now: () => clock,
    })
    expect(ok).toBe(false)
  })
})

describe('verifyRealignedCounts', () => {
  it('实际集数与计划一致 → ok', async () => {
    const jf = {
      getItemsPage: vi.fn(async (start: number) => start === 0
        ? [
            { Type: 'Episode', Path: '/lib/Show/Season 01/a.mkv', ParentIndexNumber: 1 },
            { Type: 'Episode', Path: '/lib/Show/Season 02/b.mkv', ParentIndexNumber: 2 },
          ]
        : []),
    }
    const result = await verifyRealignedCounts(jf, '/lib/Show', new Map([[1, 1], [2, 1]]), { pageSize: 100 })
    expect(result.ok).toBe(true)
  })

  it('实际集数少于计划（旧条目未清/刮削不全）→ 不一致', async () => {
    const jf = {
      getItemsPage: vi.fn(async (start: number) => start === 0
        ? [{ Type: 'Episode', Path: '/lib/Show/Season 01/a.mkv', ParentIndexNumber: 1 }]
        : []),
    }
    const result = await verifyRealignedCounts(jf, '/lib/Show', new Map([[1, 2]]), { pageSize: 100 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('第 1 季')
  })

  it('只统计新目录路径下的条目（Path 前缀匹配），旧目录残留不计入', async () => {
    const jf = {
      getItemsPage: vi.fn(async (start: number) => start === 0
        ? [
            { Type: 'Episode', Path: '/lib/Show/Season 01/a.mkv', ParentIndexNumber: 1 },
            { Type: 'Episode', Path: '/lib/OldGhostShow/Season 01/z.mkv', ParentIndexNumber: 1 },
          ]
        : []),
    }
    const result = await verifyRealignedCounts(jf, '/lib/Show', new Map([[1, 1]]), { pageSize: 100 })
    expect(result.ok).toBe(true)
  })

  it('前缀匹配按路径段切割："Show Extended" 不会被算进 "Show" 的账', async () => {
    const jf = {
      getItemsPage: vi.fn(async (start: number) => start === 0
        ? [
            { Type: 'Episode', Path: '/lib/Show/Season 01/a.mkv', ParentIndexNumber: 1 },
            { Type: 'Episode', Path: '/lib/Show Extended/Season 01/x.mkv', ParentIndexNumber: 1 },
          ]
        : []),
    }
    const result = await verifyRealignedCounts(jf, '/lib/Show', new Map([[1, 1]]), { pageSize: 100 })
    expect(result.ok).toBe(true) // 若朴素 startsWith，会数出 2 集而误判不一致
  })

  it('MEDIA_PATH_MAPPINGS 部署：Jellyfin 报告的 item.Path 先映射再比对本地新目录前缀', async () => {
    const jf = {
      getItemsPage: vi.fn(async (start: number) => start === 0
        ? [{ Type: 'Episode', Path: '/jf/tv/Show/Season 01/a.mkv', ParentIndexNumber: 1 }]
        : []),
    }
    const result = await verifyRealignedCounts(jf, '/local/tv/Show', new Map([[1, 1]]), {
      pageSize: 100, mappings: [{ from: '/jf/tv', to: '/local/tv' }],
    })
    expect(result.ok).toBe(true) // 不映射的话 '/jf/tv/…' 永远不落在 '/local/tv/Show/' 之下
  })

  it('翻页耗尽为止（第二页也统计）', async () => {
    const jf = {
      getItemsPage: vi.fn(async (start: number) => {
        if (start === 0) return [{ Type: 'Episode', Path: '/lib/Show/Season 01/a.mkv', ParentIndexNumber: 1 }]
        if (start === 1) return [{ Type: 'Episode', Path: '/lib/Show/Season 01/b.mkv', ParentIndexNumber: 1 }]
        return []
      }),
    }
    const result = await verifyRealignedCounts(jf, '/lib/Show', new Map([[1, 2]]), { pageSize: 1 })
    expect(result.ok).toBe(true)
    expect(jf.getItemsPage).toHaveBeenCalledTimes(3)
  })
})

// ============================ 顶层编排（集成 + 崩溃模拟） ============================

const SHOW_DIR = 'Spy x Family (2022) [tmdbid-120089]'
const SEASONS_3 = [
  { seasonNumber: 1, episodeCount: 25, airDate: null },
  { seasonNumber: 2, episodeCount: 12, airDate: null },
  { seasonNumber: 3, episodeCount: 3, airDate: null },
]
const SEASONS_1x5 = [{ seasonNumber: 1, episodeCount: 5, airDate: null }]

function mkFlatLibrary(root: string, count: number): string {
  const dir = join(root, 'lib', 'Spy x Family', 'Season 01')
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= count; i++) writeFileSync(join(dir, `Spy x Family E${i}.mkv`), `video-${i}`)
  return dir
}

const statSize = (p: string): number | null => {
  try { return statSync(p).size } catch { return null }
}

function countVideosRec(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += countVideosRec(p)
    else if (/\.(mkv|mp4|avi|ts|m2ts)$/i.test(e.name)) n++
  }
  return n
}

function mkMirror(paths: string[], opts: { seriesId?: string; title?: string } = {}) {
  const seriesId = opts.seriesId ?? 'jf-series-1'
  const db = openDb(':memory:')
  const lib = new LibraryRepo(db)
  const jobsRepo = new JobsRepo(db)
  lib.upsertSeries({ id: seriesId, name: opts.title ?? 'Spy x Family' })
  paths.forEach((p, i) => {
    lib.upsertEpisode({
      id: `jf-ep-${i + 1}`, seriesId, season: 1, episode: i + 1, name: `E${i + 1}`,
      path: p, subStatus: 'missing',
    })
  })
  // 清算波 R-6（A-F8）：jobsRepo.upsertWanted 已随死器官处决（production 已无调用点——realign
  // worker_task 走 upsertWorkerTask，见 realignWorkerTask.ts）。直接 SQL 写一行同形状的
  // realign job，逐字复刻 upsertWanted 原 realign 分支的 INSERT（jobsRepo.ts 头注释存档）。
  const seedNow = Date.now()
  db.prepare(
    `INSERT INTO jobs (kind, series_id, season, plan_ref, state, priority, attempt, created_at, updated_at)
     VALUES ('realign', ?, NULL, NULL, 'wanted', 0, 0, ?, ?)`
  ).run(seriesId, seedNow, seedNow)
  const job = jobsRepo.claimNext(seedNow)!
  return { db, lib, jobsRepo, job, seriesId }
}

function mkJf(opts: {
  locations: string[]
  items?: { Type: string; Path: string; ParentIndexNumber: number }[]
}): RealignLibraryPort {
  return {
    getItem: vi.fn(async () => ({
      Id: 'jf-series-1', Name: 'Spy x Family', Type: 'Series', ProductionYear: 2022, ProviderIds: { Tmdb: '120089' },
    }) as never),
    getItemsPage: vi.fn(async (start: number) => (start === 0 ? (opts.items ?? []) : []) as never),
    getScheduledTasks: vi.fn(async () => [{ id: '1', name: 'scan', isRunning: false }]),
    getVirtualFolders: vi.fn(async () => [
      { id: 'lib-1', name: 'TV', locations: opts.locations },
    ]),
    refreshLibrary: vi.fn(async () => {}),
  }
}

/** 40 集 3 季的 Jellyfin 验收条目（新目录下）。prefix 为 Jellyfin 视角的库根。 */
function spyItems40(jfLibRoot: string) {
  return Array.from({ length: 40 }, (_, i) => {
    const abs = i + 1
    const season = abs <= 25 ? 1 : abs <= 37 ? 2 : 3
    return { Type: 'Episode', Path: join(jfLibRoot, SHOW_DIR, `Season 0${season}`, `f${abs}.mkv`), ParentIndexNumber: season }
  })
}

function mkDeps(
  env: { lib: LibraryRepo; jobsRepo: JobsRepo; jf: RealignLibraryPort; libRoot: string },
  over: Partial<RealignExecutorDeps> = {},
): RealignExecutorDeps {
  return {
    lib: env.lib, jobs: env.jobsRepo, jf: env.jf,
    tmdb: { getSeasonTable: vi.fn(async () => SEASONS_3) },
    fetchAnimeLists: vi.fn(async () => []),
    runEpisode: vi.fn(async () => ({
      decision: 'download' as const, journalPath: '/j.json', stats: { durationMs: 1, llmCalls: 1, apiCalls: 1 },
    })),
    now: () => Date.now(), log: () => {}, sleep: async () => {},
    getSize: statSize,
    mediaRoots: [env.libRoot],
    mappings: [],
    ...over,
  }
}

describe('executeRealign（顶层编排，集成）', () => {
  it('40 集绝对编号平铺整理成功：碰撞规划→不可见组装→字幕先行→原子亮相→归档→验收→镜像清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-e2e-'))
    const oldSeasonDir = mkFlatLibrary(root, 40)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror(
      Array.from({ length: 40 }, (_, i) => join(oldSeasonDir, `Spy x Family E${i + 1}.mkv`)),
    )
    // F10（审计修正 2026-07-16，jobsRepo.ts retireAllForSeries）：旧排布下的判决现在活在
    // kind='worker_task' 行里——series_season 是已退役的旧管线 kind，v3 起没有生产代码再写它。
    // find_subtitle 对着旧排布"搜索穷尽"的 dormant 判决，realign 成功后必须被 retire 作废。
    jobsRepo.upsertWorkerTask({ seriesId: 'jf-series-1', season: null, movieId: null }, { taskType: 'find_subtitle' }, null, Date.now())
    const staleJudgment = jobsRepo.claimNext(Date.now())! // 唯一 wanted 行（realign job 已是 searching）
    jobsRepo.park(staleJudgment.id, 'old layout search exhausted', Date.now())

    const jf = mkJf({ locations: [libRoot], items: spyItems40(libRoot) })
    const runEpisode = vi.fn(async () => ({
      decision: 'download' as const, journalPath: '/j.json', stats: { durationMs: 1, llmCalls: 1, apiCalls: 1 },
    }))
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { runEpisode })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned')
    expect(existsSync(oldSeasonDir)).toBe(false) // 旧目录已归档
    expect(existsSync(join(libRoot, SHOW_DIR, 'Season 01'))).toBe(true)
    expect(existsSync(join(libRoot, SHOW_DIR, 'Season 03'))).toBe(true)
    expect(countVideosRec(join(libRoot, SHOW_DIR))).toBe(40) // 一个不丢
    expect(lib.getSeries('jf-series-1')).toBeNull() // 镜像清理：旧 seriesId 行已删
    expect(runEpisode).toHaveBeenCalledTimes(40) // 40 集都跑过字幕先行
    // plan_ref 语义：manifest 落盘后立即回填（崩溃恢复指针）
    expect(jobsRepo.get(job.id)!.plan_ref).toMatch(/manifest\.jsonl$/)
    // I#9：归档目录在库根之外（默认落到库根上一级），Jellyfin 看不见
    const archiveBase = join(root, '.archive')
    expect(existsSync(archiveBase)).toBe(true)
    expect(existsSync(join(libRoot, '.archive'))).toBe(false)
    // I#10：亮相与旧目录归档也记进账本（reveal 之后回滚才有据可依）
    const archiveDir = dirname(jobsRepo.get(job.id)!.plan_ref!)
    const doc = readManifest(archiveDir)!
    expect(doc.entries.filter(e => e.reason === 'realign')).toHaveLength(40)
    expect(doc.entries.some(e => e.reason === 'reveal')).toBe(true)
    expect(doc.entries.some(e => e.reason === 'archive-old-dir')).toBe(true)
    // 旧排布的 dormant 判决被作废（retireAllForSeries 含 dormant，F10 后目标是 worker_task 行）
    expect(jobsRepo.get(staleJudgment.id)!.state).toBe('done')
    expect(result.detail).toContain('3 季')
    db.close()
  })

  it('CRIT#1 二层平铺库（root/Show/file.mkv，无 Season 目录）：库根按配置根推导，绝不按层数猜', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-2level-'))
    const libRoot = join(root, 'lib')
    const oldShowDir = join(libRoot, 'Spy x Family')
    mkdirSync(oldShowDir, { recursive: true })
    for (let i = 1; i <= 40; i++) writeFileSync(join(oldShowDir, `Spy x Family E${i}.mkv`), `video-${i}`)
    // 库根的其他住户——旧实现会把 dirname(dirname(scanDir))=root 当库根，把新剧目录建到库外
    writeFileSync(join(libRoot, 'other-show-marker.txt'), 'x')

    const { db, lib, jobsRepo, job } = mkMirror(
      Array.from({ length: 40 }, (_, i) => join(oldShowDir, `Spy x Family E${i + 1}.mkv`)),
    )
    const jf = mkJf({ locations: [libRoot], items: spyItems40(libRoot) })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned')
    expect(existsSync(join(libRoot, SHOW_DIR))).toBe(true)   // 新目录在真库根之内
    expect(existsSync(join(root, SHOW_DIR))).toBe(false)      // 绝没建到库根之外（旧 bug 的去处）
    expect(existsSync(join(root, '.realign-build'))).toBe(false)
    expect(countVideosRec(join(libRoot, SHOW_DIR))).toBe(40)
    expect(existsSync(oldShowDir)).toBe(false) // 旧目录归档走了
    db.close()
  })

  it('CRIT#1 scanDir 不在任何已配置库根之下 → park，零文件系统改动', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-noroot-'))
    const libRoot = join(root, 'lib')
    mkdirSync(libRoot, { recursive: true })
    writeFileSync(join(libRoot, 'resident.txt'), 'x')
    const outside = join(root, 'outside', 'Spy x Family', 'Season 01')
    mkdirSync(outside, { recursive: true })
    for (let i = 1; i <= 3; i++) writeFileSync(join(outside, `Spy x Family E${i}.mkv`), `video-${i}`)

    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(outside, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({ locations: [libRoot] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('park')
    expect(result.detail).toContain('库根')
    // 零改动：源文件原地、无 build、无归档、无 manifest
    for (let i = 1; i <= 3; i++) expect(existsSync(join(outside, `Spy x Family E${i}.mkv`))).toBe(true)
    expect(existsSync(join(root, '.archive'))).toBe(false)
    expect(readdirSync(root).sort()).toEqual(['lib', 'outside'])
    expect(jobsRepo.get(job.id)!.plan_ref).toBeNull()
    db.close()
  })

  it('MINOR#14 虚拟库 location 是字符串前缀但不是路径段前缀（/media/li vs /media/lib）→ 不误配，park', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-segment-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    // Jellyfin 库位置 /…/li：朴素 startsWith 会把 /…/lib 误判为其内
    const jf = mkJf({ locations: [join(root, 'li')] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) } })

    const result = await executeRealign(job, deps)
    expect(result.decision).toBe('park')
    expect(result.detail).toContain('找不到')
    expect(countVideosRec(oldSeasonDir)).toBe(3) // 没动
    db.close()
  })

  it('IMP#8 MEDIA_PATH_MAPPINGS 部署：镜像/虚拟库/验收全是 Jellyfin 侧路径，映射到本地后整理成功', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-mapped-'))
    const oldSeasonDir = mkFlatLibrary(root, 5)
    const libRoot = join(root, 'lib')
    const jfRoot = '/jf/tv' // Jellyfin 容器视角的库根，本机不存在
    const mappings = [{ from: jfRoot, to: libRoot }]

    const { db, lib, jobsRepo, job } = mkMirror(
      [1, 2, 3, 4, 5].map(i => `${jfRoot}/Spy x Family/Season 01/Spy x Family E${i}.mkv`),
    )
    const jf = mkJf({
      locations: [jfRoot],
      items: [1, 2, 3, 4, 5].map(i => ({
        Type: 'Episode', Path: `${jfRoot}/${SHOW_DIR}/Season 01/f${i}.mkv`, ParentIndexNumber: 1,
      })),
    })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
      mappings,
      tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) },
    })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned')
    expect(countVideosRec(join(libRoot, SHOW_DIR))).toBe(5) // 真实文件在本地映射根下就位
    expect(existsSync(oldSeasonDir)).toBe(false)
    db.close()
  })

  it('mount 哨兵不过（库根为空）→ 判 error（瞬时，可重试），不动任何文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-empty-'))
    const libRoot = join(root, 'lib')
    mkdirSync(libRoot, { recursive: true }) // 空目录，模拟挂载掉线

    const { db, lib, jobsRepo, job } = mkMirror([join(libRoot, 'Show', 'Season 01', 'a.mkv')], { title: 'Show' })
    const jf = mkJf({ locations: [libRoot] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot })

    const result = await executeRealign(job, deps)
    expect(result.decision).toBe('error')
    expect(result.detail).toContain('为空')
    db.close()
  })

  it('IMP#6 Jellyfin 扫描一直不空闲 → error，且发生在任何搬动之前（旧目录纹丝不动，无 manifest）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-busy-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({ locations: [libRoot] })
    jf.getScheduledTasks = vi.fn(async () => [{ id: '1', name: 'scan', isRunning: true }]) // 永远在扫
    let clock = 0
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) },
    })

    const result = await executeRealign(job, deps)
    expect(result.decision).toBe('error')
    expect(result.detail).toContain('空闲')
    expect(countVideosRec(oldSeasonDir)).toBe(3)                    // 一个都没搬
    expect(existsSync(join(libRoot, '.realign-build'))).toBe(false) // 组装从未开始
    expect(jobsRepo.get(job.id)!.plan_ref).toBeNull()               // manifest 也没建
    db.close()
  })

  it('IMP#11 确定性闸门不过（映射目标重复）→ park（不进瞬时重试环），旧目录原样保留', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-gatefail-'))
    const oldSeasonDir = join(root, 'lib', 'Show', 'Season 01')
    mkdirSync(oldSeasonDir, { recursive: true })
    writeFileSync(join(oldSeasonDir, 'a-E1.mkv'), 'a')
    writeFileSync(join(oldSeasonDir, 'b-第1话.mkv'), 'b') // 与 a 映射到同一 S1E1，触发重复闸门
    const libRoot = join(root, 'lib')

    const { db, lib, jobsRepo, job } = mkMirror(
      [join(oldSeasonDir, 'a-E1.mkv'), join(oldSeasonDir, 'b-第1话.mkv')], { title: 'Show' },
    )
    const jf = mkJf({ locations: [libRoot] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
      tmdb: { getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 25, airDate: null }]) },
    })

    const result = await executeRealign(job, deps)
    expect(result.decision).toBe('park')
    expect(result.detail).toContain('整理计划构建失败')
    expect(existsSync(join(oldSeasonDir, 'a-E1.mkv'))).toBe(true) // 旧目录完全没动
    expect(existsSync(join(oldSeasonDir, 'b-第1话.mkv'))).toBe(true)
    db.close()
  })

  it('IMP#11 挂载能力不支持安全整理（probeStrategy 注入 abandon）→ park，不动任何文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-abandon-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({ locations: [libRoot] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { probeStrategy: () => 'abandon' })

    const result = await executeRealign(job, deps)
    expect(result.decision).toBe('park')
    expect(result.detail).toContain('挂载能力不支持')
    expect(countVideosRec(oldSeasonDir)).toBe(3) // 探针拒绝，整理从未开始
    db.close()
  })

  it('CRIT#3 最终目标目录已存在且无账本可考（非崩溃遗留）→ park，绝不合并、绝不组装', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-foreign-'))
    const oldSeasonDir = mkFlatLibrary(root, 5)
    const libRoot = join(root, 'lib')
    // 同名异构目录：非本工具产物（可能是用户手动整理到一半的现场）
    const foreign = join(libRoot, SHOW_DIR)
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'somebody-elses.mkv'), 'foreign-content')

    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3, 4, 5].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({ locations: [libRoot] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) } })

    const result = await executeRealign(job, deps)
    expect(result.decision).toBe('park')
    expect(result.detail).toContain('已存在')
    expect(countVideosRec(oldSeasonDir)).toBe(5)                    // 旧目录没动
    expect(readFileSync(join(foreign, 'somebody-elses.mkv'), 'utf8')).toBe('foreign-content')
    expect(existsSync(join(libRoot, '.realign-build'))).toBe(false) // 没有任何文件被搬进 build
    db.close()
  })

  it('IMP#13 碰撞分支可达：同尺寸跳过 + 不同尺寸隔离；验收只按真实就位的集数对账', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-collide-'))
    const oldSeasonDir = mkFlatLibrary(root, 5)
    const libRoot = join(root, 'lib')
    // 用生产计划器算出与 executeRealign 一致的目标路径
    const plan = buildRealignPlan(scanVideoFiles(oldSeasonDir), {
      seriesTitle: 'Spy x Family', year: 2022, tmdbId: '120089', seasonTable: SEASONS_1x5,
    })
    if (!plan.ok) throw new Error('前提不成立：计划应可构建')
    // 预置完整最终树（模拟上次运行已 reveal 但账本丢失）：4 个同尺寸（已完成），1 个不同尺寸（隔离）
    for (const item of plan.items) {
      const target = join(libRoot, item.targetRelPath)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, item.absoluteEpisode === 2 ? 'TOTALLY-DIFFERENT-SIZE' : `video-${item.absoluteEpisode}`)
    }
    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3, 4, 5].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({
      locations: [libRoot],
      // Jellyfin 刮出的正是真实就位的 4 集（abs2 隔离，不在新树的账上）
      items: plan.items.filter(i => i.absoluteEpisode !== 2)
        .map(i => ({ Type: 'Episode', Path: join(libRoot, i.targetRelPath), ParentIndexNumber: 1 })),
    })
    const runEpisode = vi.fn(async () => ({
      decision: 'download' as const, journalPath: '/j.json', stats: { durationMs: 1, llmCalls: 1, apiCalls: 1 },
    }))
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
      runEpisode, tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) },
    })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned')
    // 隔离文件没被覆盖、没被删——随旧目录进归档
    const archived = join(root, '.archive')
    expect(countVideosRec(archived)).toBe(5) // 旧目录 5 个源文件全部归档（4 个已就位的源 + 1 个隔离源）
    expect(existsSync(oldSeasonDir)).toBe(false)
    // 最终树仍是预置的 5 个文件，其中 abs2 的"不同尺寸"文件原样未动
    const t2 = plan.items.find(i => i.absoluteEpisode === 2)!
    expect(readFileSync(join(libRoot, t2.targetRelPath), 'utf8')).toBe('TOTALLY-DIFFERENT-SIZE')
    // 本轮没有真实搬动任何文件 → 字幕先行不跑（都已就位），验收只对账 4 集也通过了
    expect(runEpisode).not.toHaveBeenCalled()
    db.close()
  })

  it('IMP#7 字幕先行发生在不可见 build 内、亮相之前；sidecar 随目录一起原子亮相', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-subfirst-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({
      locations: [libRoot],
      items: [1, 2, 3].map(i => ({ Type: 'Episode', Path: join(libRoot, SHOW_DIR, 'Season 01', `f${i}.mkv`), ParentIndexNumber: 1 })),
    })
    const observed: Array<{ path: string; inBuild: boolean; finalVisible: boolean; videoOnDisk: boolean }> = []
    const runEpisode = vi.fn(async (ctx: { videoPath: string }) => {
      observed.push({
        path: ctx.videoPath,
        inBuild: ctx.videoPath.includes('.realign-build'),
        finalVisible: existsSync(join(libRoot, SHOW_DIR)),
        videoOnDisk: existsSync(ctx.videoPath),
      })
      writeFileSync(ctx.videoPath.replace(/\.mkv$/, '.zh.srt'), 'subtitle') // 管线写 sidecar
      return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
    })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
      runEpisode: runEpisode as never, tmdb: { getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 3, airDate: null }]) },
    })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned')
    expect(observed).toHaveLength(3)
    for (const o of observed) {
      expect(o.inBuild).toBe(true)       // 字幕先行时视频还在 .realign-build 里
      expect(o.finalVisible).toBe(false) // 最终目录尚未亮相
      expect(o.videoOnDisk).toBe(true)   // 视频真实就位（管线能探到文件）
    }
    // sidecar 随目录一起亮相
    const finalSrts = countAll(join(libRoot, SHOW_DIR), /\.zh\.srt$/)
    expect(finalSrts).toBe(3)
    db.close()
  })

  it('IMP#9 REALIGN_ARCHIVE_ROOT（deps.archiveRoot）优先；归档根落在库根之内则 park', async () => {
    // a) 显式归档根
    {
      const root = mkdtempSync(join(tmpdir(), 'realign-archroot-'))
      const oldSeasonDir = mkFlatLibrary(root, 3)
      const libRoot = join(root, 'lib')
      const customArchive = join(root, 'custom-archive-root')
      mkdirSync(customArchive, { recursive: true })
      const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
      const jf = mkJf({
        locations: [libRoot],
        items: [1, 2, 3].map(i => ({ Type: 'Episode', Path: join(libRoot, SHOW_DIR, 'Season 01', `f${i}.mkv`), ParentIndexNumber: 1 })),
      })
      const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
        archiveRoot: customArchive,
        tmdb: { getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 3, airDate: null }]) },
      })
      const result = await executeRealign(job, deps)
      expect(result.decision).toBe('realigned')
      expect(existsSync(join(customArchive, '.archive'))).toBe(true)
      expect(existsSync(join(root, '.archive'))).toBe(false)
      expect(jobsRepo.get(job.id)!.plan_ref!.startsWith(customArchive)).toBe(true)
      db.close()
    }
    // b) 归档根配置在库根之内 → park（红线：归档必须在库外）
    {
      const root = mkdtempSync(join(tmpdir(), 'realign-archbad-'))
      const oldSeasonDir = mkFlatLibrary(root, 3)
      const libRoot = join(root, 'lib')
      const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
      const jf = mkJf({ locations: [libRoot] })
      const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
        archiveRoot: join(libRoot, 'inner-archive'),
        tmdb: { getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 3, airDate: null }]) },
      })
      const result = await executeRealign(job, deps)
      expect(result.decision).toBe('park')
      expect(result.detail).toContain('库根之内')
      expect(countVideosRec(oldSeasonDir)).toBe(3)
      db.close()
    }
  })

  it('GAP C：scanDir 嵌套 Extras 视频（数量在阈值以下）→ 不 park，记进 notes，且随旧目录整棵归档不丢', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-nested-notes-'))
    const oldSeasonDir = mkFlatLibrary(root, 5)
    const libRoot = join(root, 'lib')
    // scanVideoFiles 只扫顶层——嵌套 Extras 子目录里的视频文件整理计划从未检查过
    const extrasDir = join(oldSeasonDir, 'Extras')
    mkdirSync(extrasDir, { recursive: true })
    writeFileSync(join(extrasDir, 'making-of.mkv'), 'behind-the-scenes')

    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3, 4, 5].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({
      locations: [libRoot],
      items: [1, 2, 3, 4, 5].map(i => ({ Type: 'Episode', Path: join(libRoot, SHOW_DIR, 'Season 01', `f${i}.mkv`), ParentIndexNumber: 1 })),
    })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) } })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned')          // 数量少（1 个）不 park，照常整理
    expect(result.detail).toContain('making-of.mkv')    // 用户能在 runs 详情里看到嵌套文件被一并归档
    // 嵌套文件没丢——随 scanDir 整棵子树一起进了归档（archiveOldDir 是目录级 rename）
    const archiveDir = dirname(jobsRepo.get(job.id)!.plan_ref!)
    const archivedExtra = join(archiveDir, basename(oldSeasonDir), 'Extras', 'making-of.mkv')
    expect(existsSync(archivedExtra)).toBe(true)
    expect(readFileSync(archivedExtra, 'utf8')).toBe('behind-the-scenes')
    db.close()
  })

  it('GAP C：scanDir 嵌套视频文件数超过阈值（疑似整段并行内容被扫进同一目录）→ park，零改动', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-nested-park-'))
    const oldSeasonDir = mkFlatLibrary(root, 5)
    const libRoot = join(root, 'lib')
    // 6 个嵌套视频文件——超过 NESTED_VIDEO_PARK_THRESHOLD（5），疑似整季被错误地扫进了
    // scanDir 下的子目录。
    const nestedDir = join(oldSeasonDir, 'Season 02')
    mkdirSync(nestedDir, { recursive: true })
    for (let i = 1; i <= 6; i++) writeFileSync(join(nestedDir, `Spy x Family S2E${i}.mkv`), `s2-${i}`)

    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3, 4, 5].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({ locations: [libRoot] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) } })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('park')
    expect(result.detail).toContain('嵌套')
    // 零改动：旧目录（含嵌套内容）原样保留，没建 build/归档，没落 manifest
    expect(countVideosRec(oldSeasonDir)).toBe(5 + 6)
    expect(existsSync(join(root, '.archive'))).toBe(false)
    expect(existsSync(join(libRoot, '.realign-build'))).toBe(false)
    expect(jobsRepo.get(job.id)!.plan_ref).toBeNull()
    db.close()
  })

  it('A-F13 富化补面：TMDB 可达时字幕先行任务带 originalTitle/alternativeTitles/overview/runtimeMinutes（不再硬编码空），且全季共用同一次 TMDB 富化查询（不逐集各打一次往返）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-enrich-ok-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({
      locations: [libRoot],
      items: [1, 2, 3].map(i => ({ Type: 'Episode', Path: join(libRoot, SHOW_DIR, 'Season 01', `f${i}.mkv`), ParentIndexNumber: 1 })),
    })
    const capturedTasks: FindSubtitleTask[] = []
    const runFindSubtitleTask = vi.fn(async (task: FindSubtitleTask) => {
      capturedTasks.push(task)
      return { installed: [], no_safe_match: [{ itemId: task.targets[0].itemId, reason: 'x' }], retry_later: [], hardsub_assumed: [] }
    })
    const runEpisode = makeRealignRunEpisode({ runFindSubtitleTask })
    const getDetails = vi.fn(async () => ({
      overview: 'A spy, an assassin, a telepath.', runtimeMinutes: 24,
      posterPath: null, originalTitle: 'SPY×FAMILY', year: 2022, genreIds: [],
    }))
    const getChineseTitles = vi.fn(async () => ['间谍家家酒'])
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
      runEpisode,
      tmdb: {
        getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 3, airDate: null }]),
        getDetails, getChineseTitles,
      },
    })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned')
    expect(capturedTasks).toHaveLength(3)
    expect(getDetails).toHaveBeenCalledTimes(1)      // series 级富化只取一次，三个目标共用
    expect(getChineseTitles).toHaveBeenCalledTimes(1)
    for (const task of capturedTasks) {
      expect(task.originalTitle).toBe('SPY×FAMILY')
      expect(task.alternativeTitles).toEqual(['间谍家家酒'])
      expect(task.overview).toBe('A spy, an assassin, a telepath.')
      expect(task.runtimeMinutes).toBe(24)
    }
    db.close()
  })

  it('A-F13 富化补面：TMDB 请求失败（getDetails/getChineseTitles 拒绝）→ gain-path 降级为 null/[]，绝不因此 park/error，整理照常完成', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-enrich-fail-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({
      locations: [libRoot],
      items: [1, 2, 3].map(i => ({ Type: 'Episode', Path: join(libRoot, SHOW_DIR, 'Season 01', `f${i}.mkv`), ParentIndexNumber: 1 })),
    })
    const capturedTasks: FindSubtitleTask[] = []
    const runFindSubtitleTask = vi.fn(async (task: FindSubtitleTask) => {
      capturedTasks.push(task)
      return { installed: [], no_safe_match: [{ itemId: task.targets[0].itemId, reason: 'x' }], retry_later: [], hardsub_assumed: [] }
    })
    const runEpisode = makeRealignRunEpisode({ runFindSubtitleTask })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
      runEpisode,
      tmdb: {
        getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 3, airDate: null }]),
        getDetails: vi.fn(async () => { throw new Error('TMDB unreachable') }),
        getChineseTitles: vi.fn(async () => { throw new Error('TMDB unreachable') }),
      },
    })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned') // 不炸——绝不因为富化失败而 park/error
    expect(capturedTasks).toHaveLength(3)
    for (const task of capturedTasks) {
      expect(task.originalTitle).toBeNull()
      expect(task.alternativeTitles).toEqual([])
      expect(task.overview).toBeNull()
      expect(task.runtimeMinutes).toBeNull()
    }
    db.close()
  })
})

/** 递归统计匹配文件数（sidecar 等非视频文件也要能数）。 */
function countAll(dir: string, re: RegExp): number {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += countAll(p, re)
    else if (re.test(e.name)) n++
  }
  return n
}

describe('executeRealign（崩溃模拟：kill 在半途 + 重跑幂等）', () => {
  it('CRIT#4 组装中途断电（账本领先于搬动 + 撕裂末行）→ 重跑：先回滚后重来，同一账本，一集不丢', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-crash-assembly-'))
    const oldSeasonDir = mkFlatLibrary(root, 40)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror(
      Array.from({ length: 40 }, (_, i) => join(oldSeasonDir, `Spy x Family E${i + 1}.mkv`)),
    )

    // —— 用生产原语手工制造"kill -9 在第 3 个文件搬动前"的现场 ——
    const plan = buildRealignPlan(scanVideoFiles(oldSeasonDir), {
      seriesTitle: 'Spy x Family', year: 2022, tmdbId: '120089', seasonTable: SEASONS_3,
    })
    if (!plan.ok) throw new Error('前提不成立')
    const archiveDir = archiveDirFor(root, 'Spy x Family', 1720000000000)
    initManifest(archiveDir, { seriesId: 'jf-series-1', seriesTitle: 'Spy x Family', startedAt: 1720000000000 })
    jobsRepo.setPlanRef(job.id, manifestPath(archiveDir), Date.now())
    let moved = 0
    expect(() =>
      assembleInvisibleTree(libRoot, SHOW_DIR, plan.items, (from, to) => {
        if (moved === 2) throw new Error('simulated power loss')
        moved++
        appendManifestEntry(archiveDir, { op: 'rename', from, to, size: statSize(from) ?? 0, mtimeMs: 1, reason: 'realign', ts: moved })
      }),
    ).toThrow(/power loss/)
    // 同一次断电还撕坏了正在追加的一行账
    appendFileSync(manifestPath(archiveDir), '{"type":"entry","op":"rename","from":"/torn-half')
    // 现场核实：2 个文件已进 build，38 个还在旧目录
    expect(countVideosRec(join(libRoot, '.realign-build'))).toBe(2)
    expect(countVideosRec(oldSeasonDir)).toBe(38)

    // —— 重跑（daemon 重启后重新领到同一个 job，plan_ref 已指向账本）——
    const rerunJob = jobsRepo.get(job.id)!
    expect(rerunJob.plan_ref).toBe(manifestPath(archiveDir))
    const jf = mkJf({ locations: [libRoot], items: spyItems40(libRoot) })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot })

    const result = await executeRealign(rerunJob, deps)

    expect(result.decision).toBe('realigned')
    expect(countVideosRec(join(libRoot, SHOW_DIR))).toBe(40)        // 一集不丢
    expect(existsSync(join(libRoot, '.realign-build', SHOW_DIR))).toBe(false) // build 残留已清
    expect(existsSync(oldSeasonDir)).toBe(false)                    // 旧目录归档
    // 幂等：没有另起一个新时间戳的归档目录，账本还是同一本
    expect(readdirSync(join(root, '.archive'))).toEqual(['Spy x Family-1720000000000'])
    expect(jobsRepo.get(job.id)!.plan_ref).toBe(manifestPath(archiveDir))
    // 账本里旧账已被回滚标记作废，新账完整（40 搬动 + reveal + 归档）
    const doc = readManifest(archiveDir)!
    expect(doc.entries.filter(e => e.reason === 'realign')).toHaveLength(40)
    expect(doc.entries.some(e => e.reason === 'reveal')).toBe(true)
    db.close()
  })

  it('CRIT#3/#4 亮相之后收尾抛错（refreshLibrary 503）→ error 但新树不回滚；重跑走"续走"路径补齐收尾', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-crash-postreveal-'))
    const oldSeasonDir = mkFlatLibrary(root, 40)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror(
      Array.from({ length: 40 }, (_, i) => join(oldSeasonDir, `Spy x Family E${i + 1}.mkv`)),
    )

    // 第一跑：亮相成功，但 Jellyfin 刷新 503
    const jf1 = mkJf({ locations: [libRoot], items: spyItems40(libRoot) })
    jf1.refreshLibrary = vi.fn(async () => { throw new Error('jellyfin 503') })
    const deps1 = mkDeps({ lib, jobsRepo, jf: jf1, libRoot })
    const r1 = await executeRealign(job, deps1)
    expect(r1.decision).toBe('error')
    expect(r1.detail).toContain('收尾')
    expect(countVideosRec(join(libRoot, SHOW_DIR))).toBe(40) // 新树已亮相，不回滚
    expect(lib.getSeries('jf-series-1')).not.toBeNull()      // 镜像清理尚未发生

    // 第二跑：崩溃恢复——账本里已有 reveal，走"续走"而不是重搬/另起炉灶
    const rerunJob = jobsRepo.get(job.id)!
    expect(rerunJob.plan_ref).toMatch(/manifest\.jsonl$/)
    const jf2 = mkJf({ locations: [libRoot], items: spyItems40(libRoot) })
    const deps2 = mkDeps({ lib, jobsRepo, jf: jf2, libRoot })
    const r2 = await executeRealign(rerunJob, deps2)

    expect(r2.decision).toBe('realigned')
    expect(r2.detail).toMatch(/续走|恢复/)
    expect(countVideosRec(join(libRoot, SHOW_DIR))).toBe(40) // 文件没被重搬/复制
    expect(jf2.refreshLibrary).toHaveBeenCalledTimes(1)      // 收尾这次真做了
    expect(lib.getSeries('jf-series-1')).toBeNull()          // 镜像清理补齐
    // 依然只有一个归档目录（幂等）
    expect(readdirSync(join(root, '.archive'))).toHaveLength(1)
    db.close()
  })

  it('GAP A：post-refresh 崩溃（旧 series item 被 Jellyfin 裁掉）→ 重跑绝不在 jf.getItem 上 errorloop，必须走续走', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-crash-postrefresh-'))
    const oldSeasonDir = mkFlatLibrary(root, 40)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror(
      Array.from({ length: 40 }, (_, i) => join(oldSeasonDir, `Spy x Family E${i + 1}.mkv`)),
    )

    // 第一跑：亮相成功、refreshLibrary 真的被调用（现实中这一步会让 Jellyfin 开始重刮
    // 目标虚拟库，旧 seriesId 对应的条目随时可能被裁掉）——但进程在 refreshLibrary 之后
    // 的 120s 空闲等待期间"断电"：getScheduledTasks 第一次调用（搬动前 idleBefore）
    // 照常返回，第二次调用（refreshLibrary 之后）直接抛错模拟崩溃。
    const jf1 = mkJf({ locations: [libRoot], items: spyItems40(libRoot) })
    let scheduledCalls = 0
    jf1.getScheduledTasks = vi.fn(async () => {
      scheduledCalls++
      if (scheduledCalls > 1) throw new Error('simulated crash: process died mid idle-wait after refreshLibrary')
      return [{ id: '1', name: 'scan', isRunning: false }]
    })
    const deps1 = mkDeps({ lib, jobsRepo, jf: jf1, libRoot })
    const r1 = await executeRealign(job, deps1)
    expect(r1.decision).toBe('error')
    expect(countVideosRec(join(libRoot, SHOW_DIR))).toBe(40) // 新树已亮相，不回滚
    expect(jf1.refreshLibrary).toHaveBeenCalledTimes(1)      // refreshLibrary 真的已经打过
    expect(existsSync(oldSeasonDir)).toBe(false)             // 旧目录已归档（发生在 refreshLibrary 之前）

    // 第二跑：daemon 重启后重新领到同一个 job。现实中 Jellyfin 此刻已经把旧 seriesId
    // 对应的 series item 裁掉（新目录下内容被识别成新条目）——jf.getItem(旧 seriesId)
    // 会抛错（Jellyfin 时代是专门的 JellyfinItemNotFoundError，去 Jellyfin 化 P7 后 port 换成
    // 库原生实现，抛一个语义清晰的 plain Error 即可复现同样的可观察行为——见
    // realignLibraryPort.ts 的 getItem 注释）。旧实现（step 1 排最前）会在这里让异常直接冒出去，
    // 被上层记成 error 走 30s→15min→daily 的无穷重试环，永远够不到下面本该接管的续走路径
    // （当年是旧管线 v2/executor.ts 接的这个 catch，今天是 v2/realignWorkerTask.ts 的
    // runRealignWorkerTask；executor.ts 已随旧管线退役删除，这条历史描述的是修复前的行为，
    // 不是当前实现）。
    const rerunJob = jobsRepo.get(job.id)!
    expect(rerunJob.plan_ref).toMatch(/manifest\.jsonl$/)
    const jf2 = mkJf({ locations: [libRoot], items: spyItems40(libRoot) })
    jf2.getItem = vi.fn(async () => { throw new Error('realign: series not found in library: jf-series-1') })
    const deps2 = mkDeps({ lib, jobsRepo, jf: jf2, libRoot })

    const r2 = await executeRealign(rerunJob, deps2)

    expect(r2.decision).toBe('realigned')      // 不是 error——没有在 jf.getItem 上 errorloop
    expect(r2.detail).toMatch(/续走|恢复/)
    expect(jf2.getItem).not.toHaveBeenCalled() // 关键：续走路径从不查旧 series item
    expect(countVideosRec(join(libRoot, SHOW_DIR))).toBe(40) // 新树完整，一集没丢没重搬
    expect(jf2.refreshLibrary).toHaveBeenCalledTimes(1)       // 收尾（归档旧目录+刷新）这次真做了
    expect(lib.getSeries('jf-series-1')).toBeNull()           // 镜像清理补齐
    // 依然只有一个归档目录（幂等，未另起时间戳）
    expect(readdirSync(join(root, '.archive'))).toHaveLength(1)
    db.close()
  })

  it('CRIT 外来目录抢占 finalTarget + 回滚 EACCES 双故障：重跑绝不伪装"续走成功"——build 滞留视频否决续走', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-crash-foreign-resume-'))
    const oldSeasonDir = mkFlatLibrary(root, 5)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror(
      [1, 2, 3, 4, 5].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)),
    )
    // 旧排布下的 series_season job——假成功会把它错误退休（retireAllForSeries）
    // 清算波 R-6（A-F8）：upsertWanted 已随死器官处决，直接 SQL 写一行同形状的行。
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
       VALUES ('series_season', ?, ?, 'wanted', 0, 0, ?, ?)`
    ).run('jf-series-1', 1, Date.now(), Date.now())

    // —— 第一跑：字幕先行阶段（组装预检之后！）外来目录占住最终位置，亮相必然撞墙；
    //    同时旧目录被锁死（0o555）→ 进程内回滚 EACCES 半途而废、无 rollback 标记——
    //    正是审阅者端到端复现的双故障现场。
    const foreign = join(libRoot, SHOW_DIR)
    const runEpisode1 = vi.fn(async () => {
      if (!existsSync(foreign)) {
        mkdirSync(foreign, { recursive: true })
        writeFileSync(join(foreign, 'somebody-elses.mkv'), 'foreign-content')
        chmodSync(oldSeasonDir, 0o555)
      }
      return { decision: 'download' as const, journalPath: '/j.json', stats: { durationMs: 1, llmCalls: 1, apiCalls: 1 } }
    })
    const jf1 = mkJf({ locations: [libRoot] })
    const deps1 = mkDeps({ lib, jobsRepo, jf: jf1, libRoot }, {
      runEpisode: runEpisode1 as never, tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) },
    })
    const r1 = await executeRealign(job, deps1)
    expect(r1.decision).toBe('error')
    expect(r1.detail).toContain('回滚未完成')
    expect(countVideosRec(join(libRoot, '.realign-build'))).toBe(5) // 5 集全部滞留 build

    chmodSync(oldSeasonDir, 0o755) // 运维修复权限（或瞬时故障消失）

    // —— 第二跑：账本有 reveal + finalTarget"存在"（其实是外来目录）——旧实现在此伪装续走
    //    成功：归档空旧目录、删镜像行、退休全部 job，5 集从此隐身且永不自愈。修复后：
    //    build 有滞留视频 → 否决续走，落回回滚路径归位 5 集，再被 CRIT#3 预检（外来目录
    //    占位）确定性停车。
    const rerunJob = jobsRepo.get(job.id)!
    expect(rerunJob.plan_ref).toMatch(/manifest\.jsonl$/)
    const jf2 = mkJf({ locations: [libRoot] })
    const deps2 = mkDeps({ lib, jobsRepo, jf: jf2, libRoot }, {
      tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) },
    })
    const r2 = await executeRealign(rerunJob, deps2)

    expect(r2.decision).not.toBe('realigned')                       // 关键：绝不假成功
    expect(r2.decision).toBe('park')                                // 外来占位 → 确定性停车
    expect(countVideosRec(oldSeasonDir)).toBe(5)                    // 5 集已回滚归位（可见、可恢复）
    expect(countVideosRec(join(libRoot, '.realign-build'))).toBe(0) // build 无滞留
    expect(readFileSync(join(foreign, 'somebody-elses.mkv'), 'utf8')).toBe('foreign-content') // 外来文件原样
    expect(lib.getSeries('jf-series-1')).not.toBeNull()             // 镜像行未删
    // jobsRepo.find 已随死器官处决，直接 SQL 读回同形状的行。
    expect((db.prepare(`SELECT * FROM jobs WHERE kind = 'series_season' AND series_id = ? AND season = ?`).get('jf-series-1', 1) as { state: string }).state).toBe('wanted')   // series_season job 未被退休
    db.close()
  })

  it('崩溃恢复账本真损坏（撕裂解释不了）→ park（dormant 可恢复），不进 errorloop，零文件改动', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-manifest-corrupt-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    // plan_ref 指向一本中间行真损坏的账（损坏行之后还有合法行——撕裂级联解释不了的真损坏）
    const archiveDir = archiveDirFor(root, 'Spy x Family', 1720000000000)
    initManifest(archiveDir, { seriesId: 'jf-series-1', seriesTitle: 'Spy x Family', startedAt: 1720000000000 })
    jobsRepo.setPlanRef(job.id, manifestPath(archiveDir), Date.now())
    appendFileSync(manifestPath(archiveDir), 'GARBAGE-NOT-JSON\n')
    appendManifestEntry(archiveDir, { op: 'rename', from: '/a', to: '/b', size: 1, mtimeMs: 1, reason: 'realign', ts: 1 })

    const rerunJob = jobsRepo.get(job.id)!
    const jf = mkJf({ locations: [libRoot] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x5) } })
    const result = await executeRealign(rerunJob, deps)

    expect(result.decision).toBe('park')            // 确定性损坏：error 轨只会日日空转
    expect(result.detail).toContain('manifest.jsonl')
    expect(countVideosRec(oldSeasonDir)).toBe(3)    // 零改动
    expect(existsSync(join(libRoot, '.realign-build'))).toBe(false)
    db.close()
  })

  it('Wall ②：runEpisode（v3 find-subtitle worker 接线）抛错——非阻塞契约仍然成立，整理照常完成', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-subtitle-throw-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkMirror([1, 2, 3].map(i => join(oldSeasonDir, `Spy x Family E${i}.mkv`)))
    const jf = mkJf({
      locations: [libRoot],
      items: [1, 2, 3].map(i => ({ Type: 'Episode', Path: join(libRoot, SHOW_DIR, 'Season 01', `f${i}.mkv`), ParentIndexNumber: 1 })),
    })
    // runFindSubtitleTask（找字幕的 v3 worker）真实语义：一个 THROW（而非结构化 retry_later）
    // 代表 step-cap/timeout/abort 一类的 worker-exhaustion——realign 顶层编排必须把它当成
    // "这一集字幕先行没跑成"来吞掉，绝不能让它冒泡阻断整个整理流程（IMP#7 非阻塞契约）。
    const runEpisode = makeRealignRunEpisode({
      runFindSubtitleTask: vi.fn(async () => { throw new Error('find-subtitle worker exhausted (step cap)') }),
    })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, {
      runEpisode, tmdb: { getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 3, airDate: null }]) },
    })

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned')             // 整理仍然完成——字幕先行失败绝不阻塞
    expect(result.detail).toContain('字幕先行失败')
    expect(countVideosRec(join(libRoot, SHOW_DIR))).toBe(3) // 三集都已就位（只是没字幕）
    db.close()
  })
})
