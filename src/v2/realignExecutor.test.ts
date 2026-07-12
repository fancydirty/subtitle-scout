import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mountAliveSentinel, chooseRealignStrategy, archiveDirFor,
  planCollisions, invisibleBuildDir, assembleInvisibleTree, finalizeShowDir,
  archiveOldDir,
} from './realignExecutor.js'
import type { RealignPlanItem } from '../files/libraryRealign.js'

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
