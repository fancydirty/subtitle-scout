import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initManifest, appendManifestEntry, appendRollbackMarker, readManifest, replayRollback, manifestPath,
} from './realignManifest.js'

describe('realign manifest', () => {
  it('initManifest 建目录 + 写 header 行（JSONL 首行）', () => {
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

  it('appendManifestEntry 是纯追加（append-only）：不重写既有字节，每条 entry 一行', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-append-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    const afterInit = readFileSync(manifestPath(dir), 'utf8')
    appendManifestEntry(dir, { op: 'rename', from: '/a1', to: '/b1', size: 1, mtimeMs: 1, reason: 'r1', ts: 1 })
    const afterOne = readFileSync(manifestPath(dir), 'utf8')
    // 追加语义：旧内容原样是新内容的前缀——绝不整篇重写（重写在断电时会把整本账毁掉）
    expect(afterOne.startsWith(afterInit)).toBe(true)
    appendManifestEntry(dir, { op: 'rename', from: '/a2', to: '/b2', size: 2, mtimeMs: 2, reason: 'r2', ts: 2 })
    const afterTwo = readFileSync(manifestPath(dir), 'utf8')
    expect(afterTwo.startsWith(afterOne)).toBe(true)
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

  it('撕裂尾行（崩溃在追加半途）：readManifest 忽略不完整末行，返回全部完整 entries', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-torn-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(dir, { op: 'rename', from: '/a1', to: '/b1', size: 1, mtimeMs: 1, reason: 'r1', ts: 1 })
    appendManifestEntry(dir, { op: 'rename', from: '/a2', to: '/b2', size: 2, mtimeMs: 2, reason: 'r2', ts: 2 })
    // 模拟 kill -9 撕裂：最后一条 entry 只写了半行就断电
    appendFileSync(manifestPath(dir), '{"type":"entry","op":"rename","from":"/a3","to":')
    const doc = readManifest(dir)!
    expect(doc.entries.map(e => e.from)).toEqual(['/a1', '/a2'])
  })

  it('撕裂尾行后 replayRollback 仍能重放全部完整 entries（崩溃恢复主路径）', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-torn-rb-'))
    const archiveDir = join(root, 'archive')
    const libA = join(root, 'lib', 'a.mkv')
    mkdirSync(join(root, 'lib'), { recursive: true })
    const newA = join(root, 'new-a.mkv')
    writeFileSync(newA, 'A')
    initManifest(archiveDir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(archiveDir, { op: 'rename', from: libA, to: newA, size: 1, mtimeMs: 1, reason: 'x', ts: 1 })
    appendFileSync(manifestPath(archiveDir), '{"type":"entry","op":"ren') // 半行
    expect(() => replayRollback(archiveDir)).not.toThrow()
    expect(existsSync(libA)).toBe(true)
    expect(existsSync(newA)).toBe(false)
  })

  it('撕裂尾行之后继续追加（崩溃恢复同账本续写）：半行被封口作废，新旧完整账都读得回来', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-torn-resume-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(dir, { op: 'rename', from: '/a1', to: '/b1', size: 1, mtimeMs: 1, reason: 'r1', ts: 1 })
    appendFileSync(manifestPath(dir), '{"type":"entry","op":"rename","from":"/torn') // kill -9 撕裂
    // 重跑：同一账本上继续追加——绝不能和半行黏成一条真损坏
    appendManifestEntry(dir, { op: 'rename', from: '/a2', to: '/b2', size: 2, mtimeMs: 2, reason: 'r2', ts: 2 })
    const doc = readManifest(dir)!
    expect(doc.entries.map(e => e.from)).toEqual(['/a1', '/a2'])
  })

  it('双撕裂级联（撕裂 entry 后重跑补封口、seal 本身又撕裂）：按截断处理返回完整前缀，不 brick 账本', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-torn-cascade-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(dir, { op: 'rename', from: '/a1', to: '/b1', size: 1, mtimeMs: 1, reason: 'r1', ts: 1 })
    // 崩溃 1：追加 entry 半途断电（无换行的半行）
    appendFileSync(manifestPath(dir), '{"type":"entry","op":"rename","from":"/torn-half')
    // 崩溃 2：重跑 appendLine 先补换行 + seal 封口，seal 本身又写到一半断电——
    // 撕裂 entry 的后继不再是合法 seal，而是又一条撕裂尾行（级联）。
    appendFileSync(manifestPath(dir), '\n{"type":"seal","ts":17')
    const doc = readManifest(dir)!
    expect(doc.entries.map(e => e.from)).toEqual(['/a1']) // 完整前缀全部读回，级联尾巴按截断忽略
  })

  it('撕裂行之后仍有能解析的行（撕裂/级联解释不了）→ 大声抛错，不静默吞账', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-torn-then-valid-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendFileSync(manifestPath(dir), '{"type":"entry","op":"rename","from":"/torn-half\n')
    appendFileSync(manifestPath(dir), '{"type":"seal","ts":17\n') // 第二行也是坏行（不是合法 seal）
    appendManifestEntry(dir, { op: 'rename', from: '/a1', to: '/b1', size: 1, mtimeMs: 1, reason: 'r1', ts: 1 })
    expect(() => readManifest(dir)).toThrow(/损坏/) // 坏行之后还有合法行——真损坏，不是截断
  })

  it('中间行损坏（不是末行撕裂能解释的）→ readManifest 抛错，不静默吞账', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-corrupt-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendFileSync(manifestPath(dir), 'GARBAGE-NOT-JSON\n')
    appendManifestEntry(dir, { op: 'rename', from: '/a1', to: '/b1', size: 1, mtimeMs: 1, reason: 'r1', ts: 1 })
    expect(() => readManifest(dir)).toThrow(/损坏/)
  })

  it('rollback 标记行：readManifest 只返回最后一次 rollback 之后的 entries（重跑不重放旧账）', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-marker-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(dir, { op: 'rename', from: '/old1', to: '/oldb1', size: 1, mtimeMs: 1, reason: 'r', ts: 1 })
    appendRollbackMarker(dir, 2)
    appendManifestEntry(dir, { op: 'rename', from: '/new1', to: '/newb1', size: 1, mtimeMs: 1, reason: 'r', ts: 3 })
    const doc = readManifest(dir)!
    expect(doc.entries.map(e => e.from)).toEqual(['/new1'])
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

  it('replayRollback：文件尺寸与记账不符 → 警告跳过，不搬（那不是我们搬过去的那个文件）', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-rollback-size-'))
    const archiveDir = join(root, 'archive')
    const libA = join(root, 'lib-a.mkv')
    const newA = join(root, 'new-a.mkv')
    writeFileSync(newA, 'REPLACED-CONTENT-LONGER') // 23 字节，记账时是 1 字节
    initManifest(archiveDir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(archiveDir, { op: 'rename', from: libA, to: newA, size: 1, mtimeMs: 1, reason: 'x', ts: 1 })
    const logs: string[] = []
    expect(() => replayRollback(archiveDir, m => logs.push(m))).not.toThrow()
    expect(existsSync(newA)).toBe(true)   // 未被搬走
    expect(existsSync(libA)).toBe(false)
    expect(logs.some(l => l.includes('尺寸'))).toBe(true)
  })

  it('replayRollback：size=0 的目录级条目（reveal/归档）不做尺寸校验，正常逆转', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-rollback-dir-'))
    const archiveDir = join(root, 'archive')
    const buildShow = join(root, '.realign-build', 'Show')
    const finalShow = join(root, 'Show')
    mkdirSync(finalShow, { recursive: true }) // 模拟 reveal 已发生：目录在最终位置
    writeFileSync(join(finalShow, 'a.mkv'), 'A')
    initManifest(archiveDir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(archiveDir, { op: 'rename', from: buildShow, to: finalShow, size: 0, mtimeMs: 1, reason: 'reveal', ts: 1 })
    expect(() => replayRollback(archiveDir)).not.toThrow()
    expect(existsSync(buildShow)).toBe(true)  // 目录被逆转回 build 位置
    expect(existsSync(finalShow)).toBe(false)
    expect(existsSync(join(buildShow, 'a.mkv'))).toBe(true)
  })

  it('replayRollback：manifest 不存在直接抛错', () => {
    expect(() => replayRollback(join(tmpdir(), 'no-manifest-here-' + Date.now()))).toThrow()
  })

  it('manifestPath 拼 <archiveDir>/manifest.jsonl', () => {
    expect(manifestPath('/x/archive')).toBe('/x/archive/manifest.jsonl')
  })
})
