import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mountAliveSentinel, chooseRealignStrategy, archiveDirFor,
  planCollisions, invisibleBuildDir, assembleInvisibleTree, finalizeShowDir,
  archiveOldDir, buildRealignMediaContext, makeRealignRunEpisode,
  waitForJellyfinIdle, verifyRealignedCounts,
} from './realignExecutor.js'
import type { RealignPlanItem } from '../files/libraryRealign.js'
import type { Assembled } from '../cli/index.js'
import { MediaContextSchema } from '../core/schemas.js'

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
})

describe('archiveDirFor', () => {
  it('拼出 <share根>/.archive/<剧名>-<时间戳>/', () => {
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

describe('buildRealignMediaContext', () => {
  it('字面构造 MediaContext：tmdbid 钉死、季集来自计划、trigger=library_scan', () => {
    const item: RealignPlanItem = {
      sourcePath: '/x.mkv', sourceFilename: 'x.mkv', absoluteEpisode: 26,
      targetSeason: 2, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-120089]/Season 02/y.mkv',
    }
    const ctx = buildRealignMediaContext('间谍过家家', 2022, '120089', item, '/lib/Show (2022) [tmdbid-120089]/Season 02/y.mkv')
    expect(() => MediaContextSchema.parse(ctx)).not.toThrow()
    expect(ctx.media.type).toBe('episode')
    expect(ctx.media.season).toBe(2)
    expect(ctx.media.episode).toBe(1)
    expect(ctx.media.provider_ids.tmdb).toBe('120089')
    expect(ctx.media.path).toBe('/lib/Show (2022) [tmdbid-120089]/Season 02/y.mkv')
    expect(ctx.media.filename).toBe('y.mkv')
    expect(ctx.media.title).toBe('间谍过家家')
    expect(ctx.media.year).toBe(2022)
    expect(ctx.trigger).toBe('library_scan')
  })
})

describe('makeRealignRunEpisode', () => {
  it('接线 runPipeline：不经过 jf.getItem，直接用调用方构造好的 ctx，包 withJournal', async () => {
    const runPipelineMock = vi.fn(async () => ({
      decision: 'download' as const, journalPath: '/j.json', stats: { durationMs: 1, llmCalls: 1, apiCalls: 1 },
    }))
    const makeDeps = vi.fn(() => ({}) as never)
    const withJournal = vi.fn((fn: () => Promise<unknown>) => fn())
    const runEpisode = makeRealignRunEpisode(
      { makeDeps, withJournal: withJournal as unknown as Assembled['withJournal'], cacheRoot: '/cache' },
      { runPipelineImpl: runPipelineMock as never },
    )
    const ctx = MediaContextSchema.parse({
      request_id: 'r1', trigger: 'library_scan',
      media: { type: 'episode', path: '/x.mkv', filename: 'x.mkv', title: 'Show', season: 2, episode: 1, provider_ids: { tmdb: '1' } },
      preferences: {},
    })
    const result = await runEpisode(ctx, '/lib/Show/Season 02', 'job-1')
    expect(result.decision).toBe('download')
    expect(runPipelineMock).toHaveBeenCalledTimes(1)
    expect(withJournal).toHaveBeenCalledTimes(1)
    // runPipeline(deps, ctx, outDir, journalDir, opts)：v2 状态机拥有全部重试策略，负缓存必须旁路
    const call = runPipelineMock.mock.calls[0] as unknown[]
    expect(call[1]).toBe(ctx)
    expect(call[2]).toBe('/lib/Show/Season 02')
    expect(String(call[3])).toContain('/cache/journals/realign-job-1-')
    expect(call[4]).toEqual({ bypassNegativeCache: true })
  })
})

describe('waitForJellyfinIdle', () => {
  it('无运行中任务 → 立即 true，不 sleep', async () => {
    const jf = { getScheduledTasks: vi.fn(async () => [{ id: '1', name: 'scan', isRunning: false }]) }
    const sleep = vi.fn(async () => {})
    const ok = await waitForJellyfinIdle(jf, { pollMs: 10, timeoutMs: 1000, sleep })
    expect(ok).toBe(true)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('先运行后空闲 → 轮询几次后 true', async () => {
    let calls = 0
    const jf = { getScheduledTasks: vi.fn(async () => { calls++; return [{ id: '1', name: 'scan', isRunning: calls < 3 }] }) }
    const sleep = vi.fn(async () => {})
    const ok = await waitForJellyfinIdle(jf, { pollMs: 10, timeoutMs: 10_000, sleep })
    expect(ok).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('超时仍在跑 → false（假时钟注入，不真等也不篡改全局 Date.now）', async () => {
    const jf = { getScheduledTasks: vi.fn(async () => [{ id: '1', name: 'scan', isRunning: true }]) }
    let clock = 0
    const ok = await waitForJellyfinIdle(jf, {
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
