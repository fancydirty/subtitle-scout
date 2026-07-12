import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initManifest, appendManifestEntry, readManifest, replayRollback, manifestPath } from './realignManifest.js'

describe('realign manifest', () => {
  it('initManifest 建目录 + 写空 entries 的 header', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 123 })
    const doc = readManifest(dir)!
    expect(doc.header).toEqual({ seriesId: 's1', seriesTitle: 'Show', startedAt: 123 })
    expect(doc.entries).toEqual([])
  })

  it('initManifest 幂等：已存在时不重新初始化（崩溃恢复重跑场景）', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-idem-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 111 })
    appendManifestEntry(dir, { op: 'rename', from: '/a', to: '/b', size: 10, mtimeMs: 1, reason: 'x', ts: 2 })
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 999 }) // 不同 header，应被忽略
    const doc = readManifest(dir)!
    expect(doc.header.startedAt).toBe(111)
    expect(doc.entries).toHaveLength(1)
  })

  it('appendManifestEntry 先记后搬：追加的 entry 落盘顺序保留', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-append-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(dir, { op: 'rename', from: '/a1', to: '/b1', size: 1, mtimeMs: 1, reason: 'r1', ts: 1 })
    appendManifestEntry(dir, { op: 'rename', from: '/a2', to: '/b2', size: 2, mtimeMs: 2, reason: 'r2', ts: 2 })
    const doc = readManifest(dir)!
    expect(doc.entries.map(e => e.from)).toEqual(['/a1', '/a2'])
  })

  it('appendManifestEntry：manifest 未初始化 → 抛错（write-ahead 记账不许静默丢）', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-noinit-')), 'archive')
    expect(() =>
      appendManifestEntry(dir, { op: 'rename', from: '/a', to: '/b', size: 1, mtimeMs: 1, reason: 'x', ts: 1 })
    ).toThrow(/initManifest/)
  })

  it('readManifest：manifest 不存在返回 null', () => {
    expect(readManifest(join(tmpdir(), 'no-such-archive-' + Date.now()))).toBeNull()
  })

  it('replayRollback 逆序重放：把 to 重命名回 from', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-rollback-'))
    const archiveDir = join(root, 'archive')
    const libA = join(root, 'lib', 'a.mkv')
    const libB = join(root, 'lib', 'b.mkv')
    mkdirSync(join(root, 'lib'), { recursive: true })
    initManifest(archiveDir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    // 模拟已经真的搬过：写文件到"新位置"
    const newA = join(root, 'new-a.mkv')
    const newB = join(root, 'new-b.mkv')
    writeFileSync(newA, 'A'); writeFileSync(newB, 'B')
    appendManifestEntry(archiveDir, { op: 'rename', from: libA, to: newA, size: 1, mtimeMs: 1, reason: 'x', ts: 1 })
    appendManifestEntry(archiveDir, { op: 'rename', from: libB, to: newB, size: 1, mtimeMs: 1, reason: 'x', ts: 2 })

    const logs: string[] = []
    replayRollback(archiveDir, m => logs.push(m))

    expect(existsSync(libA)).toBe(true)
    expect(existsSync(libB)).toBe(true)
    expect(existsSync(newA)).toBe(false)
    expect(existsSync(newB)).toBe(false)
    expect(readFileSync(libA, 'utf8')).toBe('A')
  })

  it('replayRollback 幂等：from 已存在（已回滚过）→ 跳过该条目，不报错、不覆盖', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-rollback-idem-'))
    const archiveDir = join(root, 'archive')
    const libA = join(root, 'lib-a.mkv')
    const newA = join(root, 'new-a.mkv')
    writeFileSync(libA, 'already-here') // from 已经存在（模拟已回滚过一次）
    initManifest(archiveDir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(archiveDir, { op: 'rename', from: libA, to: newA, size: 1, mtimeMs: 1, reason: 'x', ts: 1 })
    expect(() => replayRollback(archiveDir)).not.toThrow()
    expect(readFileSync(libA, 'utf8')).toBe('already-here') // 未被覆盖
  })

  it('replayRollback：回滚源（to）缺失 → 警告跳过，不中断其余条目', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-rollback-missing-'))
    const archiveDir = join(root, 'archive')
    const libA = join(root, 'lib-a.mkv')
    const libB = join(root, 'lib-b.mkv')
    const newB = join(root, 'new-b.mkv')
    writeFileSync(newB, 'B')
    initManifest(archiveDir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(archiveDir, { op: 'rename', from: libA, to: join(root, 'gone.mkv'), size: 1, mtimeMs: 1, reason: 'x', ts: 1 })
    appendManifestEntry(archiveDir, { op: 'rename', from: libB, to: newB, size: 1, mtimeMs: 1, reason: 'x', ts: 2 })
    const logs: string[] = []
    expect(() => replayRollback(archiveDir, m => logs.push(m))).not.toThrow()
    expect(existsSync(libB)).toBe(true)   // 其余条目照常回滚
    expect(existsSync(libA)).toBe(false)  // 源缺失的条目跳过
    expect(logs.some(l => l.includes('缺失'))).toBe(true)
  })

  it('replayRollback：manifest 不存在直接抛错', () => {
    expect(() => replayRollback(join(tmpdir(), 'no-manifest-here-' + Date.now()))).toThrow()
  })

  it('manifestPath 拼 <archiveDir>/manifest.json', () => {
    expect(manifestPath('/x/archive')).toBe('/x/archive/manifest.json')
  })
})
