import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkVideoFiles, SELF_SCAN_DEFAULT_INTERVAL_MS } from './selfScan.js'

describe('SELF_SCAN_DEFAULT_INTERVAL_MS', () => {
  it('is 15 minutes — the single source of truth cli/index.ts and v2/daemon.ts wire the ingest heartbeat gate off of', () => {
    expect(SELF_SCAN_DEFAULT_INTERVAL_MS).toBe(15 * 60_000)
  })
})

// 清算波 R-6（A-F9/C-A4）：makeSelfScan（B1 的整个 walk→diff→recognize 编排，含它的
// SelfScanDeps/SelfScanResult 类型）已随死器官处决——production 唯一调用点（B2 self-scan
// refresh-bridge）早已折叠进 v2/ingest.ts 的统一 ingest 心跳。这个 describe 块原先借
// makeSelfScan(...).tick() 间接验证 walkVideoFiles 的真实文件系统行为（递归、扩展名过滤、
// 排除 dot-dir/@ 前缀目录）——这是 walkVideoFiles 唯一未被 mock 掉、真正走硬盘的测试点
// （v2/ingest.test.ts、v2/realignLibraryPort.test.ts 里的同名 listVideoFiles 全部是注入的
// mock）。walkVideoFiles 本身仍是活体（v2/ingest.ts、v2/realignLibraryPort.ts 直接消费），
// 迁到直接调用它本身，不再经过已死的 makeSelfScan 包装层。
describe('walkVideoFiles (real fs walk)', () => {
  it('recurses into real directories, filters by video extension, and excludes dot-dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'selfscan-'))

    // Plain video file at top level
    writeFileSync(join(root, 'movie.mkv'), '')
    // Non-video file — must be filtered out
    writeFileSync(join(root, 'notes.txt'), '')

    // Nested video file — recursion must reach it
    mkdirSync(join(root, 'Show', 'Season 01'), { recursive: true })
    writeFileSync(join(root, 'Show', 'Season 01', 'ep1.mp4'), '')

    // Dot-dir (daemon's own staging/build dirs, or any other hidden dir) must be excluded
    // entirely — including video-looking files inside it.
    mkdirSync(join(root, '.subtitle-staging', 'job1'), { recursive: true })
    writeFileSync(join(root, '.subtitle-staging', 'job1', 'ghost.mkv'), '')

    // '@eaDir'-style NAS junk dirs must also be excluded.
    mkdirSync(join(root, '@eaDir'), { recursive: true })
    writeFileSync(join(root, '@eaDir', 'thumb.mkv'), '')

    const paths = walkVideoFiles(root).sort()

    expect(paths).toEqual([join(root, 'Show', 'Season 01', 'ep1.mp4'), join(root, 'movie.mkv')].sort())
  })
})
