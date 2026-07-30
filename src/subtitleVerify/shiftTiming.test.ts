import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  shiftSubtitleTiming,
  revertSubtitleTiming,
  BACKUP_SUFFIX,
  META_SUFFIX,
  MAX_ABS_OFFSET_MS,
} from './shiftTiming.js'

const FIXTURE_TORTURE = resolve(__dirname, '__fixtures__/torture.ass')
const FIXTURE_REAL_ASS = resolve(__dirname, '../adapters/providers/__fixtures__/subhd/down-2BNs4Y.ass')

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shift-timing-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 把 fixture 复制进临时目录（测试自包含，不改 fixture 本身） */
function stage(fixturePath: string, name: string): string {
  const p = join(dir, name)
  writeFileSync(p, readFileSync(fixturePath))
  return p
}

function stageBytes(bytes: Buffer, name: string): string {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}

/**
 * 逐字节 diff：返回所有不同字节的偏移量。
 * 这是本套测试的核心工具——"只有时间戳字节变了"这个断言必须落在字节层，
 * 不能用字符串比较（那会掩盖 BOM/行尾/编码的变化）。
 */
function byteDiffOffsets(a: Buffer, b: Buffer): number[] {
  const out: number[] = []
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) out.push(i)
  }
  return out
}

/** 提取所有 Dialogue 行的 Start/End 字符串（latin1 视角，不解码） */
function dialogueTimes(buf: Buffer): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const line of buf.toString('latin1').split(/\r\n|\n|\r/)) {
    const m = /^Dialogue\s*:\s*[^,]*,([^,]*),([^,]*),/.exec(line.trim())
    if (m) out.push([(m[1] ?? '').trim(), (m[2] ?? '').trim()])
  }
  return out
}

function commentTimes(buf: Buffer): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const line of buf.toString('latin1').split(/\r\n|\n|\r/)) {
    const m = /^Comment\s*:\s*[^,]*,([^,]*),([^,]*),/.exec(line.trim())
    if (m) out.push([(m[1] ?? '').trim(), (m[2] ?? '').trim()])
  }
  return out
}

describe('shiftSubtitleTiming — 字节保真', () => {
  it('shift-byte-fidelity-only-dialogue-timestamps-change: 平移后只有 Dialogue 行时间戳字节不同，其余每个字节都相同', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(true)
    const after = readFileSync(p)

    // 长度必须完全一致：这个 fixture 的平移不改变时间戳的字符宽度
    // （0:00:10.50 → 0:00:08.50），所以任何长度变化都意味着我们动了不该动的东西。
    expect(after.length).toBe(before.length)

    const diffs = byteDiffOffsets(before, after)
    expect(diffs.length).toBeGreaterThan(0)

    // 每一个变化的字节都必须落在某个 Dialogue 行的 Start/End 字段区间内。
    // 用原始字节独立定位这些区间——不依赖被测代码的任何输出。
    const s = before.toString('latin1')
    const allowed: Array<[number, number]> = []
    let pos = 0
    for (const rawLine of s.split('\n')) {
      const lineStart = pos
      pos += rawLine.length + 1
      const t = rawLine.replace(/\r$/, '')
      if (!/^Dialogue\s*:/.test(t)) continue
      const colon = t.indexOf(':')
      const rest = t.slice(colon + 1)
      // 字段 1 和 2 = Start / End（本 fixture 无 Format 行，用默认列位）
      const f = rest.split(',')
      let off = lineStart + colon + 1 + (f[0]?.length ?? 0) + 1
      allowed.push([off, off + (f[1]?.length ?? 0)])
      off += (f[1]?.length ?? 0) + 1
      allowed.push([off, off + (f[2]?.length ?? 0)])
    }
    for (const d of diffs) {
      const inside = allowed.some(([lo, hi]) => d >= lo && d < hi)
      expect(inside, `byte at offset ${d} changed but is outside any Dialogue Start/End field`).toBe(true)
    }
  })

  it('shift-bom-preserved: UTF-8 BOM 原样保留，不丢不加', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    expect(readFileSync(p).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    await shiftSubtitleTiming(p, 1500)
    expect(readFileSync(p).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })

  it('shift-no-bom-stays-no-bom: 无 BOM 的文件不会被加上 BOM', async () => {
    const p = stage(FIXTURE_REAL_ASS, 'real.ass')
    const before = readFileSync(p)
    expect(before.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    await shiftSubtitleTiming(p, 1000)
    const after = readFileSync(p)
    expect(after.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(after.subarray(0, 13).toString('latin1')).toBe('[Script Info]')
  })

  it('shift-crlf-preserved: CRLF 行尾不被转成 LF', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const crlfBefore = (readFileSync(p).toString('latin1').match(/\r\n/g) ?? []).length
    expect(crlfBefore).toBe(17)
    await shiftSubtitleTiming(p, 3000)
    const afterStr = readFileSync(p).toString('latin1')
    expect((afterStr.match(/\r\n/g) ?? []).length).toBe(17)
    // 不能有任何裸 LF（不带前导 CR）
    expect(/[^\r]\n/.test(afterStr)).toBe(false)
  })

  it('shift-lf-preserved: LF 行尾文件不被转成 CRLF', async () => {
    const p = stage(FIXTURE_REAL_ASS, 'real.ass')
    await shiftSubtitleTiming(p, 1000)
    expect(readFileSync(p).toString('latin1')).not.toMatch(/\r\n/)
  })

  it('shift-other-sections-untouched: [Fonts] base64 / [Aegisub Project Garbage] / 字幕组注释行 逐字节不变', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    await shiftSubtitleTiming(p, 2000)
    const after = readFileSync(p)
    // [Events] 之前的所有字节必须逐字节相同——涵盖 BOM、注释行、Script Info、
    // Aegisub Project Garbage、V4+ Styles、Fonts 的 base64 垃圾
    const eventsAt = before.toString('latin1').indexOf('[Events]')
    expect(eventsAt).toBeGreaterThan(0)
    expect(after.subarray(0, eventsAt)).toEqual(before.subarray(0, eventsAt))
    // 具体几个标志串仍在
    const a = after.toString('latin1')
    expect(a).toContain('BASE64GARBAGE==')
    expect(a).toContain('Last Style Storage: Default')
    expect(a).toContain('fontname: AOV38813.ttf')
    // 字幕组中文注释行（UTF-8 字节原样）
    expect(after.includes(Buffer.from('; 字幕组注释', 'utf8'))).toBe(true)
  })

  it('shift-inline-tags-bytes-unchanged: {\\move} {\\pos} {\\fad} 内联标签字节完全不变', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    await shiftSubtitleTiming(p, 2000)
    const a = readFileSync(p).toString('latin1')
    // 内联标签的时间参数是相对该行 Start 的，整行同量平移后必须原样不动
    expect(a).toContain('{\\move(100,200,300,400)}')
    expect(a).toContain('{\\pos(640,600)\\fad(200,200)}')
  })
})

describe('shiftSubtitleTiming — 平移语义', () => {
  it('shift-sign-direction: 正 offsetMs = 字幕晚了 = 时间戳变小（减）', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    expect(dialogueTimes(readFileSync(p))).toEqual([
      ['0:00:10.50', '0:00:12.30'],
      ['0:00:15.00', '0:00:17.00'],
    ])
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(true)
    expect(r.shiftedLines).toBe(2)
    expect(dialogueTimes(readFileSync(p))).toEqual([
      ['0:00:08.50', '0:00:10.30'],
      ['0:00:13.00', '0:00:15.00'],
    ])
  })

  it('shift-negative-offset: 负 offsetMs = 字幕早了 = 时间戳变大（加）', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const r = await shiftSubtitleTiming(p, -2500)
    expect(r.ok).toBe(true)
    expect(r.clampedCount).toBe(0)
    expect(dialogueTimes(readFileSync(p))).toEqual([
      ['0:00:13.00', '0:00:14.80'],
      ['0:00:17.50', '0:00:19.50'],
    ])
  })

  it('shift-comment-lines-time-unchanged: Comment: 行的时间不变、字节不动，Dialogue 行照常平移', async () => {
    const src = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,废弃的翻译草稿',
      'Dialogue: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,生效台词',
      '',
    ].join('\n')
    const p = stageBytes(Buffer.from(src, 'utf8'), 'withcomment.ass')
    const r = await shiftSubtitleTiming(p, 3000)
    expect(r.ok).toBe(true)
    expect(r.shiftedLines).toBe(1) // 只有 Dialogue 被算作生效字幕行
    const after = readFileSync(p)
    // Comment 时间原封不动
    expect(commentTimes(after)).toEqual([['0:00:05.00', '0:00:06.00']])
    // Comment 整行字节原样（含文本）
    expect(after.includes(Buffer.from('Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,废弃的翻译草稿', 'utf8'))).toBe(true)
    // Dialogue 已平移
    expect(dialogueTimes(after)).toEqual([['0:00:07.00', '0:00:08.00']])
  })

  it('shift-clamp-negative-to-zero: 平移致时间戳变负 → 钳到 0，仅影响越界行，detail 报告条数', async () => {
    const src = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,开头署名',
      'Dialogue: 0,0:01:00.00,0:01:02.00,Default,,0,0,0,,正常台词',
      '',
    ].join('\n')
    const p = stageBytes(Buffer.from(src, 'utf8'), 'clamp.ass')
    const r = await shiftSubtitleTiming(p, 5000)
    expect(r.ok).toBe(true)
    // 第一行 Start(1s) 和 End(2s) 都 <5s → 两个时间戳都被钳
    expect(r.clampedCount).toBe(2)
    expect(r.detail).toContain('clamped 2 timestamp(s) to 0')
    expect(dialogueTimes(readFileSync(p))).toEqual([
      ['0:00:00.00', '0:00:00.00'],
      // 越界不影响其他行：这一行照常减 5s
      ['0:00:55.00', '0:00:57.00'],
    ])
  })

  it('shift-format-line-decides-columns: Start/End 列位由 Format 行决定，不写死 fields[1]/[2]', async () => {
    // 非规范列序：Start/End 在第 3、4 列
    const src = [
      '[Events]',
      'Format: Layer, Style, Start, End, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,Default,0:00:10.00,0:00:12.00,,0,0,0,,台词',
      '',
    ].join('\n')
    const p = stageBytes(Buffer.from(src, 'utf8'), 'cols.ass')
    const r = await shiftSubtitleTiming(p, 4000)
    expect(r.ok).toBe(true)
    expect(r.shiftedLines).toBe(1)
    const a = readFileSync(p).toString('utf8')
    expect(a).toContain('Dialogue: 0,Default,0:00:06.00,0:00:08.00,,0,0,0,,台词')
  })
})

describe('shiftSubtitleTiming — SRT', () => {
  const SRT = [
    '1',
    '00:00:10,500 --> 00:00:12,300',
    'first line',
    '',
    '2',
    '00:00:15,000 --> 00:00:17,000',
    'second line',
    '',
  ].join('\r\n')

  it('shift-srt-timestamps: 逗号毫秒格式的时间行被正确平移', async () => {
    const p = stageBytes(Buffer.from(SRT, 'utf8'), 'a.srt')
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(true)
    expect(r.shiftedLines).toBe(2)
    const a = readFileSync(p).toString('utf8')
    expect(a).toContain('00:00:08,500 --> 00:00:10,300')
    expect(a).toContain('00:00:13,000 --> 00:00:15,000')
  })

  it('shift-srt-byte-fidelity: 序号/文本/空行/CRLF 逐字节不变，只有时间行的时间戳变', async () => {
    const p = stageBytes(Buffer.from(SRT, 'utf8'), 'a.srt')
    const before = readFileSync(p)
    await shiftSubtitleTiming(p, 2000)
    const after = readFileSync(p)
    expect(after.length).toBe(before.length)
    // CRLF 保持
    expect((after.toString('latin1').match(/\r\n/g) ?? []).length).toBe(
      (before.toString('latin1').match(/\r\n/g) ?? []).length,
    )
    // 所有变化的字节都必须在时间行上
    const beforeLines = before.toString('latin1').split('\r\n')
    const timeLineRanges: Array<[number, number]> = []
    let off = 0
    for (const l of beforeLines) {
      if (l.includes('-->')) timeLineRanges.push([off, off + l.length])
      off += l.length + 2
    }
    for (const d of byteDiffOffsets(before, after)) {
      expect(timeLineRanges.some(([lo, hi]) => d >= lo && d < hi), `offset ${d} outside time lines`).toBe(true)
    }
    // 文本与序号原样
    expect(after.toString('utf8')).toContain('first line')
    expect(after.toString('utf8')).toContain('second line')
  })

  it('shift-srt-clamp: SRT 时间戳变负同样钳到 0', async () => {
    const p = stageBytes(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nx\n', 'utf8'), 'b.srt')
    const r = await shiftSubtitleTiming(p, 5000)
    expect(r.ok).toBe(true)
    expect(r.clampedCount).toBe(2)
    expect(readFileSync(p).toString('utf8')).toContain('00:00:00,000 --> 00:00:00,000')
  })
})

describe('shiftSubtitleTiming — 备份与幂等', () => {
  it('shift-idempotent-double-call: 连续两次同参数调用，最终时间轴只平移一次', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    await shiftSubtitleTiming(p, 2000)
    const afterFirst = readFileSync(p)
    const r2 = await shiftSubtitleTiming(p, 2000)
    expect(r2.ok).toBe(true)
    const afterSecond = readFileSync(p)
    // 逐字节一致 = 真幂等，不是"看起来差不多"
    expect(afterSecond).toEqual(afterFirst)
    expect(dialogueTimes(afterSecond)).toEqual([
      ['0:00:08.50', '0:00:10.30'],
      ['0:00:13.00', '0:00:15.00'],
    ])
    expect(r2.detail).toContain('recomputed from existing backup')
  })

  it('shift-idempotent-different-offset-rebases-from-original: 换一个 offset 时基准仍是原始文件，不叠加', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    await shiftSubtitleTiming(p, 2000)
    await shiftSubtitleTiming(p, 5000)
    // 若基准是"当前文件"会得到 10.50-2-5=3.50；正确行为是相对原始文件 10.50-5=5.50
    expect(dialogueTimes(readFileSync(p))).toEqual([
      ['0:00:05.50', '0:00:07.30'],
      ['0:00:10.00', '0:00:12.00'],
    ])
  })

  it('shift-backup-created-with-original-bytes: 备份内容 = 原始文件字节', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const original = readFileSync(p)
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.backupPath).toBe(`${resolve(p)}${BACKUP_SUFFIX}`)
    expect(readFileSync(r.backupPath!)).toEqual(original)
  })

  it('shift-existing-backup-never-overwritten: 备份已存在时绝不被覆盖', async () => {
    // 备份必须经**真实的一次 shift** 建立（不是手工放），否则 C-A1 守卫会保守拒绝
    // ——手工备份没有内容指纹，无从证明它与磁盘上的文件相关。这里要测的是
    // "备份即基准、绝不覆盖"，用 srt 起一个已知时间点便于验算。
    const src = '1\n00:00:20,000 --> 00:00:22,000\n原始版本\n'
    const p = stageBytes(Buffer.from(src, 'utf8'), 'base.srt')
    const backupPath = `${resolve(p)}${BACKUP_SUFFIX}`
    const r1 = await shiftSubtitleTiming(p, 5000)
    expect(r1.ok).toBe(true)
    const backupAfterFirst = readFileSync(backupPath)
    expect(backupAfterFirst).toEqual(Buffer.from(src, 'utf8'))

    // 第二次换个 offset：备份字节必须一个都不变，且平移是基于**备份**重算的
    // （20s - 2s = 18s，而不是在已平移的 15s 上再减）
    const r2 = await shiftSubtitleTiming(p, 2000)
    expect(r2.ok).toBe(true)
    expect(readFileSync(backupPath)).toEqual(backupAfterFirst)
    expect(readFileSync(p).toString('utf8')).toContain('00:00:18,000 --> 00:00:20,000')
  })

  it('shift-existing-backup-not-rewritten: 备份已存在时对备份的写次数为 0（不只是内容等价）', async () => {
    // 审计 I6：只断言备份**内容**时，把 `if (!backupExisted)` 改成 `if (true)` 全套照绿——
    // 内容等价，但每次调用都对不可替代的备份多做一次 rename 覆盖（多一次损坏窗口）。
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    await shiftSubtitleTiming(p, 2000)
    const backupPath = `${resolve(p)}${BACKUP_SUFFIX}`
    const target = resolve(p)
    const writes: string[] = []
    await shiftSubtitleTiming(p, 2500, {
      writeFileImpl: (path, data) => { writes.push(path); writeFileSync(path, data) },
    })
    expect(writes.filter(w => w === backupPath)).toEqual([])
    expect(writes).toContain(target)
  })

  it('shift-meta-reports-previous-offset: meta 记录累计平移量，供调用方做残差叠加', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const r1 = await shiftSubtitleTiming(p, 2000)
    expect(r1.previousOffsetMs).toBe(0)
    expect(r1.appliedOffsetMs).toBe(2000)
    const r2 = await shiftSubtitleTiming(p, 2500)
    expect(r2.previousOffsetMs).toBe(2000)
    expect(r2.appliedOffsetMs).toBe(2500)
  })

  it('shift-meta-missing-with-backup-refused: 备份在而 meta 缺失（手工/老版本备份）→ 保守拒绝，不猜也不动文件', async () => {
    // 审计 C-A1：备份靠**文件名**绑定，没有指纹就无从证明"这个备份对应磁盘上这份内容"。
    // 旧行为是照常基于备份重算并只把 previousOffsetMs 报成 null——而那正是销毁路径 ②
    // 的形状（备份是旧字幕、磁盘上是用户换的新字幕）。沿用 C1 的口径：宁可要求人工介入。
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    const backup = Buffer.from(readFileSync(p))
    writeFileSync(`${resolve(p)}${BACKUP_SUFFIX}`, backup)
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('records no content fingerprint')
    // 零副作用：目标与备份都一个字节没动
    expect(readFileSync(p)).toEqual(before)
    expect(readFileSync(`${resolve(p)}${BACKUP_SUFFIX}`)).toEqual(backup)
  })

  it('shift-meta-without-offset-reports-unknown: meta 有指纹但没有合法 offset → previousOffsetMs 为 null，不猜 0', async () => {
    // previousOffsetMs=null（未知）这一档在加了指纹守卫后仍然可达：meta 被手工编辑过、
    // 或将来某个写入方只记了指纹。此时指纹能证明绑定关系（放行），但累计平移量确实未知，
    // 必须如实报 null 而不是猜 0——调用方按 previousOffsetMs + R 叠加，猜 0 会欠校正。
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    await shiftSubtitleTiming(p, 2000)
    const metaPath = `${resolve(p)}${META_SUFFIX}`
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { targetFingerprint: string }
    // 只留指纹，抹掉 appliedOffsetMs
    writeFileSync(metaPath, JSON.stringify({ targetFingerprint: meta.targetFingerprint }))
    const r = await shiftSubtitleTiming(p, 2500)
    expect(r.ok).toBe(true)
    expect(r.previousOffsetMs).toBeNull()
    expect(r.detail).toContain('prevOffsetMs=unknown')
  })

  it('shift-revert-restores-original-bytes: revert 逐字节还原且保留备份', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const original = readFileSync(p)
    await shiftSubtitleTiming(p, 2000)
    expect(readFileSync(p)).not.toEqual(original)
    const r = await revertSubtitleTiming(p)
    expect(r.ok).toBe(true)
    expect(readFileSync(p)).toEqual(original)
    // 备份保留（可能还要再校正一次）。meta **改写**而非删除（C-A1）：删掉会留下
    // "备份有 + meta 无"，而那个状态会被指纹守卫保守拒绝，把"撤销 → 重新校正"
    // 这条出路堵死。改写成 offset=0 + 还原后字节的指纹，如实描述当前状态。
    expect(existsSync(`${resolve(p)}${BACKUP_SUFFIX}`)).toBe(true)
    const metaPath = `${resolve(p)}${META_SUFFIX}`
    expect(existsSync(metaPath)).toBe(true)
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      appliedOffsetMs: number; targetFingerprint: string
    }
    expect(meta.appliedOffsetMs).toBe(0)
    expect(meta.targetFingerprint).toEqual(expect.any(String))
  })

  it('shift-revert-without-backup-refused: 无备份时 revert 拒绝，不动目标文件', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    const r = await revertSubtitleTiming(p)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('no backup')
    expect(readFileSync(p)).toEqual(before)
  })
})

/**
 * 三文件状态机（target × backup × meta）守卫。
 * 审计 C1：`backupExisted` 这一个布尔位曾承担本该由两位信息共同决定的判断，
 * 导致"备份被删但 meta 尚存"时把已平移文件当原始基准，静默双倍平移且原始永久丢失。
 */
describe('shiftSubtitleTiming — 三文件状态机守卫', () => {
  it('shift-c1-backup-missing-but-meta-nonzero-refused: 备份被删而 meta 记着非零平移 → 拒绝，文件与备份都不动', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const backupPath = `${resolve(p)}${BACKUP_SUFFIX}`
    const metaPath = `${resolve(p)}${META_SUFFIX}`

    // t1：正常平移一次
    const r1 = await shiftSubtitleTiming(p, 2000)
    expect(r1.ok).toBe(true)
    expect(dialogueTimes(readFileSync(p))).toEqual([
      ['0:00:08.50', '0:00:10.30'],
      ['0:00:13.00', '0:00:15.00'],
    ])

    // 模拟清理脚本只删了 .scout-backup、漏删 .scout-backup.json
    rmSync(backupPath)
    expect(existsSync(metaPath)).toBe(true)
    const afterDelete = readFileSync(p)

    // t2：必须拒绝——磁盘上的文件已被平移过，却没有原始字节副本可作基准。
    // 修复前这里会 ok:true 并把 08.50 平移成 06.50（双倍），同时把 08.50 存成"原始"备份。
    const r2 = await shiftSubtitleTiming(p, 2000)
    expect(r2.ok).toBe(false)
    expect(r2.detail).toContain('backup missing')
    expect(r2.detail).toContain('2000')
    // 目标文件一个字节都没动（没有双倍平移）
    expect(readFileSync(p)).toEqual(afterDelete)
    expect(dialogueTimes(readFileSync(p))).toEqual([
      ['0:00:08.50', '0:00:10.30'],
      ['0:00:13.00', '0:00:15.00'],
    ])
    // 绝不能拿已平移的文件生成一个假"原始"备份
    expect(existsSync(backupPath)).toBe(false)
    // 拒绝时也如实回报 meta 的值，供调用方诊断
    expect(r2.previousOffsetMs).toBe(2000)
  })

  it('shift-c1-backup-missing-meta-zero-treated-as-never-shifted: meta 记 0 是退化的合法态，按首次平移处理', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    // meta 记 0ms = 等价于未平移，不该被 C1 守卫拦住
    writeFileSync(`${resolve(p)}${META_SUFFIX}`, JSON.stringify({ appliedOffsetMs: 0 }))
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(true)
    expect(dialogueTimes(readFileSync(p))).toEqual([
      ['0:00:08.50', '0:00:10.30'],
      ['0:00:13.00', '0:00:15.00'],
    ])
  })

  it('shift-c1-backup-missing-meta-corrupt-allowed: 备份无 + meta 损坏 → 不拦（损坏 meta 读作未知，当首次平移）', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    writeFileSync(`${resolve(p)}${META_SUFFIX}`, 'not json at all')
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(true)
    expect(readFileSync(`${resolve(p)}${BACKUP_SUFFIX}`)).toEqual(readFileSync(FIXTURE_TORTURE))
  })

  it('shift-c2-previous-offset-matches-detail: previousOffsetMs 与 detail 的 prevOffsetMs= 恒等（四种状态组合）', async () => {
    // 审计 C2：曾经 `backupExisted ? previousOffsetMs : 0` 让返回值与 detail 自相矛盾。
    const readPrevFromDetail = (d: string): string => /prevOffsetMs=(\S+)/.exec(d)![1]!
    const assertConsistent = (r: Awaited<ReturnType<typeof shiftSubtitleTiming>>) => {
      const shown = readPrevFromDetail(r.detail)
      const expected = r.previousOffsetMs == null ? 'unknown' : String(r.previousOffsetMs)
      expect(shown, `detail says prevOffsetMs=${shown} but field is ${String(r.previousOffsetMs)}`).toBe(expected)
    }

    // ① 备份无 + meta 无 = 确定从未平移过 → 0（事实，非猜测）
    const a = stage(FIXTURE_TORTURE, 'a.ass')
    const r1 = await shiftSubtitleTiming(a, 2000)
    expect(r1.previousOffsetMs).toBe(0)
    assertConsistent(r1)

    // ② 备份有 + meta 有 = 正常再次调用 → meta 的值
    const r2 = await shiftSubtitleTiming(a, 2500)
    expect(r2.previousOffsetMs).toBe(2000)
    assertConsistent(r2)

    // ③ 备份有 + meta 只有指纹（无 offset）→ null（未知，不猜 0）
    // 注：原先这一档用"手工放备份 + 无 meta"构造，那个状态现在被 C-A1 守卫保守拒绝
    // （没有指纹就无从证明备份与磁盘上的文件相关）。改用"指纹在、offset 缺"——
    // 同样是 previousOffsetMs=null 这一档，且仍能走到成功路径。
    const b = stage(FIXTURE_TORTURE, 'b.ass')
    await shiftSubtitleTiming(b, 1000)
    const bMetaPath = `${resolve(b)}${META_SUFFIX}`
    const bfp = (JSON.parse(readFileSync(bMetaPath, 'utf8')) as { targetFingerprint: string }).targetFingerprint
    writeFileSync(bMetaPath, JSON.stringify({ targetFingerprint: bfp }))
    const r3 = await shiftSubtitleTiming(b, 2000)
    expect(r3.ok).toBe(true)
    expect(r3.previousOffsetMs).toBeNull()
    assertConsistent(r3)

    // ④ 备份有 + meta 里 offset 类型不合法（字符串）但指纹合法 → null
    const c = stage(FIXTURE_TORTURE, 'c.ass')
    await shiftSubtitleTiming(c, 1000)
    const cMetaPath = `${resolve(c)}${META_SUFFIX}`
    const cfp = (JSON.parse(readFileSync(cMetaPath, 'utf8')) as { targetFingerprint: string }).targetFingerprint
    writeFileSync(cMetaPath, JSON.stringify({ appliedOffsetMs: 'nope', targetFingerprint: cfp }))
    const r4 = await shiftSubtitleTiming(c, 2000)
    expect(r4.ok).toBe(true)
    expect(r4.previousOffsetMs).toBeNull()
    assertConsistent(r4)
  })

  it('shift-c2-never-reports-zero-when-meta-says-otherwise: 只要 meta 有非零值，previousOffsetMs 绝不报 0', async () => {
    // 这是 C2 实害的直接钉子：调用方按 previousOffsetMs + R 叠加，报 0 会欠校正。
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    await shiftSubtitleTiming(p, 2000)
    const r = await shiftSubtitleTiming(p, 3000)
    expect(r.previousOffsetMs).not.toBe(0)
    expect(r.previousOffsetMs).toBe(2000)
  })
})

describe('shiftSubtitleTiming — revert 守卫（与 shift 对称）', () => {
  /** 建立一个**合法的**已平移状态（真实备份 + 带指纹的 meta），供各条 revert 守卫测试
   *  在此基础上单独破坏它们各自要测的那一样东西。手工放备份会先撞上 C-A1 守卫，
   *  那样后面的守卫（合理性检查等）就永远测不到了。 */
  async function shiftedState(fixture: string, name: string): Promise<string> {
    const p = stage(fixture, name)
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok, 'precondition: initial shift must succeed').toBe(true)
    return p
  }

  it('revert-garbage-backup-refused: 截断/垃圾备份不得覆盖用户文件', async () => {
    const p = await shiftedState(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    // 模拟 SIGKILL 留下的截断备份 / 备份事后被别的东西改坏
    // （目标与 meta 指纹仍一致，所以 C-A1 守卫放行，能走到合理性检查这一道）
    writeFileSync(`${resolve(p)}${BACKUP_SUFFIX}`, Buffer.from('TRUNCATE'))
    const r = await revertSubtitleTiming(p)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('does not look like a valid')
    // 修复前这里会把用户文件覆盖成 8 字节垃圾并报 ok:true
    expect(readFileSync(p)).toEqual(before)
  })

  it('revert-empty-backup-refused: 空备份被拒绝', async () => {
    const p = await shiftedState(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    writeFileSync(`${resolve(p)}${BACKUP_SUFFIX}`, Buffer.alloc(0))
    const r = await revertSubtitleTiming(p)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('empty file')
    expect(readFileSync(p)).toEqual(before)
  })

  it('revert-unsupported-extension-refused: revert 不得成为绕过 shift 扩展名检查的后门', async () => {
    const p = join(dir, 'x.vtt')
    writeFileSync(p, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n')
    writeFileSync(`${resolve(p)}${BACKUP_SUFFIX}`, 'WEBVTT\n')
    const before = readFileSync(p)
    const r = await revertSubtitleTiming(p)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('unsupported extension')
    expect(readFileSync(p)).toEqual(before)
  })

  it('revert-nonexistent-target-refused: 目标不存在时不得凭备份凭空造出文件', async () => {
    const p = join(dir, 'gone.ass')
    writeFileSync(`${resolve(p)}${BACKUP_SUFFIX}`, readFileSync(FIXTURE_TORTURE))
    const r = await revertSubtitleTiming(p)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('target does not exist')
    // 修复前 revert 会在这里创建出 gone.ass
    expect(existsSync(p)).toBe(false)
  })

  it('revert-valid-srt-backup-accepted: 合法 SRT 备份能正常 revert（合理性检查不误拒真文件）', async () => {
    const srt = '1\n00:00:10,500 --> 00:00:12,300\nhello\n'
    const p = stageBytes(Buffer.from(srt, 'utf8'), 'a.srt')
    await shiftSubtitleTiming(p, 2000)
    const r = await revertSubtitleTiming(p)
    expect(r.ok).toBe(true)
    expect(readFileSync(p).toString('utf8')).toBe(srt)
  })

  it('revert-minimal-ass-backup-accepted: 缺 section 头但 Dialogue 完好的 ASS 不被误拒', async () => {
    // 字幕组文件千奇百怪，合理性检查必须宽松：只区分"字幕"与"垃圾"，不做格式完整性审查。
    // 备份走真实 shift 建立（手工备份会先被 C-A1 守卫拒绝，测不到合理性检查这一道）。
    const minimal = 'Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,x\n'
    const p = stageBytes(Buffer.from(minimal, 'utf8'), 'min.ass')
    expect((await shiftSubtitleTiming(p, 2000)).ok).toBe(true)
    const r = await revertSubtitleTiming(p)
    expect(r.ok).toBe(true)
    expect(readFileSync(p).toString('utf8')).toBe(minimal)
  })
})

/**
 * C-A1（审计 Critical）：备份与目标只靠**文件名**绑定，换了字幕就销毁用户文件。
 *
 * 三文件状态机枚举了 target/backup/meta 的在与不在，但从不问"target 还是当初备份的那个
 * 文件吗"。而 subtitleWriter.ts 用**确定性文件名**——同一集重新下载一份字幕落在同一路径，
 * 于是"用户换了字幕"这件极普通的事会让备份指向一份与磁盘上的 target 毫无关系的内容。
 *
 * 巡检永不重查已有记录的条目（verifySweep.ts 的 `LEFT JOIN ... IS NULL` 过滤），
 * 所以 DB 里一直留着旧字幕的 shifted 判定、红芯片一直亮，用户点校正 → 撞 409 →
 * 照文案"先撤销再校正" → 走进路径 ①。两条路径修复前都是 `ok:true` 静默销毁。
 *
 * 下面两条测试逐字复刻审计的复现步骤，断言"拒绝 + 三个文件一个字节都不变"。
 */
describe('shiftSubtitleTiming — C-A1：备份与目标的内容绑定', () => {
  const A = '1\n00:00:10,000 --> 00:00:12,000\nVERSION-A\n'
  const B = '1\n00:00:30,000 --> 00:00:32,000\nVERSION-B\n'

  /** 写入 A → shift → 用户换成 B（同名 re-download）。返回换字幕后的三份快照。 */
  async function swappedAfterShift(name: string): Promise<{
    p: string; backupPath: string; metaPath: string
    targetBefore: Buffer; backupBefore: Buffer; metaBefore: Buffer
  }> {
    const p = stageBytes(Buffer.from(A, 'utf8'), name)
    const backupPath = `${resolve(p)}${BACKUP_SUFFIX}`
    const metaPath = `${resolve(p)}${META_SUFFIX}`
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok, 'precondition').toBe(true)
    // 备份里确实是 A
    expect(readFileSync(backupPath).toString('utf8')).toBe(A)
    // 用户换新字幕：同名覆盖（确定性文件名 → 命中同一路径）
    writeFileSync(p, B)
    return {
      p, backupPath, metaPath,
      targetBefore: readFileSync(p),
      backupBefore: readFileSync(backupPath),
      metaBefore: readFileSync(metaPath),
    }
  }

  it('ca1-revert-after-subtitle-swap-refused: 换过字幕后 revert 必须拒绝，绝不用旧备份覆盖新字幕', async () => {
    // 审计路径 ①：修复前 revert 返回 ok:true，磁盘变回 A，**B 被销毁**。
    // looksLikeSubtitle 拦不住——A 是一个合法字幕，只是错的那一份。
    const s = await swappedAfterShift('swap-revert.srt')
    const r = await revertSubtitleTiming(s.p)

    expect(r.ok).toBe(false)
    expect(r.detail).toContain('has been replaced since it was backed up')
    // 新字幕 B 完好无损（这是本条测试的全部意义）
    expect(readFileSync(s.p)).toEqual(s.targetBefore)
    expect(readFileSync(s.p).toString('utf8')).toBe(B)
    // 拒绝时零副作用：备份与 meta 都没动（meta 尤其不能被删——revert 成功路径会删它）
    expect(readFileSync(s.backupPath)).toEqual(s.backupBefore)
    expect(readFileSync(s.metaPath)).toEqual(s.metaBefore)
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('ca1-shift-after-subtitle-swap-refused: 换过字幕后再 shift 必须拒绝，绝不拿旧备份重算', async () => {
    // 审计路径 ②：修复前返回 ok:true 且 detail 写
    // "recomputed from existing backup (idempotent); prevOffsetMs=2000"，
    // 文件变成由旧备份 A 算出的内容，**B 彻底消失**。
    const s = await swappedAfterShift('swap-shift.srt')
    const r = await shiftSubtitleTiming(s.p, 3000)

    expect(r.ok).toBe(false)
    expect(r.detail).toContain('has been replaced since it was backed up')
    // 绝不能出现"基于备份重算"的成功回执
    expect(r.detail).not.toContain('idempotent')
    // 新字幕 B 完好无损，且**没有**被算成 A-3000（修复前的实测结果是 00:00:07,000）
    expect(readFileSync(s.p)).toEqual(s.targetBefore)
    expect(readFileSync(s.p).toString('utf8')).toBe(B)
    expect(readFileSync(s.p).toString('utf8')).not.toContain('VERSION-A')
    // 零副作用
    expect(readFileSync(s.backupPath)).toEqual(s.backupBefore)
    expect(readFileSync(s.metaPath)).toEqual(s.metaBefore)
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('ca1-fingerprint-is-of-bytes-not-normalized-text: 同内容不同编码算"被换过"（指纹是字节口径，不是 hashSubtitleContent 的归一化文本口径）', async () => {
    // 这条钉住指纹方案的选择：subtitleSpans.hashSubtitleContent 刻意做编码归一化
    // （GBK 与 UTF-8 的同一份字幕哈希相同），那个口径服务"结论要不要作废"。
    // 本模块按**字节**原地改写、revert 按**字节**写回，所以"同内容不同编码"对我们就是
    // 另一个文件——拿归一化哈希放行，revert 会把用户刚做的一次编码转换悄悄退回去。
    const utf8 = '[Events]\nDialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,中文\n'
    const p = stageBytes(Buffer.from(utf8, 'utf8'), 'enc.ass')
    expect((await shiftSubtitleTiming(p, 1000)).ok).toBe(true)

    // 把目标转成 GBK（内容相同、字节不同）——归一化文本哈希会认为"没变"
    const shiftedText = readFileSync(p).toString('utf8')
    const gbk = Buffer.concat([
      Buffer.from(shiftedText.slice(0, shiftedText.indexOf('中文')), 'latin1'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from('\n', 'latin1'),
    ])
    writeFileSync(p, gbk)

    const r = await revertSubtitleTiming(p)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('has been replaced since it was backed up')
    expect(readFileSync(p)).toEqual(gbk)
  })

  it('ca1-untouched-file-still-shifts-and-reverts: 没被换过的文件照常可 shift、可重算、可 revert（守卫不误伤主路径）', async () => {
    // 守卫的价值取决于它不挡住正常用法：首次平移 → 换 offset 重算（幂等）→ revert 还原。
    const p = stageBytes(Buffer.from(A, 'utf8'), 'clean.srt')
    const r1 = await shiftSubtitleTiming(p, 2000)
    expect(r1.ok).toBe(true)
    expect(readFileSync(p).toString('utf8')).toContain('00:00:08,000')

    // 第二次：基准仍是原始文件（10s - 3s = 7s），不是在 8s 上再减
    const r2 = await shiftSubtitleTiming(p, 3000)
    expect(r2.ok).toBe(true)
    expect(r2.previousOffsetMs).toBe(2000)
    expect(readFileSync(p).toString('utf8')).toContain('00:00:07,000')

    // 同参数连调仍幂等（指纹每次都被更新成刚写下的内容）
    const r3 = await shiftSubtitleTiming(p, 3000)
    expect(r3.ok).toBe(true)
    expect(readFileSync(p).toString('utf8')).toContain('00:00:07,000')

    const r4 = await revertSubtitleTiming(p)
    expect(r4.ok).toBe(true)
    expect(readFileSync(p).toString('utf8')).toBe(A)
  })

  it('ca1-revert-then-correct-again-works: 撤销 → 再校正走得通（409 门的出路没被守卫堵死）', async () => {
    // revert 成功后会删 meta 并保留备份，形成"备份有 + meta 无"。若下一次 shift 撞上
    // C-A1 的保守拒绝，correctSubtitle 那道 409 指望的出路就成了死胡同。
    // 所以 revert 成功时必须把备份也清理掉/或让状态可继续——这条钉住实际行为。
    const p = stageBytes(Buffer.from(A, 'utf8'), 'again.srt')
    expect((await shiftSubtitleTiming(p, 2000)).ok).toBe(true)
    expect((await revertSubtitleTiming(p)).ok).toBe(true)
    expect(readFileSync(p).toString('utf8')).toBe(A)

    const r = await shiftSubtitleTiming(p, 4000)
    expect(r.ok, `revert→correct must not be a dead end: ${r.detail}`).toBe(true)
    expect(readFileSync(p).toString('utf8')).toContain('00:00:06,000')
  })
})

describe('shiftSubtitleTiming — offset 上界与静默无操作', () => {
  it('shift-absurd-offset-refused: |offsetMs| 超过 ±6h 理智上界即拒绝，文件不动', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    for (const bad of [1e15, Number.MAX_SAFE_INTEGER, -1e12, MAX_ABS_OFFSET_MS + 1]) {
      const r = await shiftSubtitleTiming(p, bad)
      expect(r.ok, `offset ${bad} should be refused`).toBe(false)
      expect(r.detail).toContain('exceeds sanity bound')
    }
    expect(readFileSync(p)).toEqual(before)
    expect(existsSync(`${resolve(p)}${BACKUP_SUFFIX}`)).toBe(false)
  })

  it('shift-at-sanity-bound-accepted: 恰好等于上界的偏移仍被接受（边界不是 off-by-one）', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const r = await shiftSubtitleTiming(p, MAX_ABS_OFFSET_MS)
    expect(r.ok).toBe(true)
    // 全部钳到 0（6 小时远超这个 fixture 的时长），但这是合法的用户意图
    expect(r.clampedCount).toBe(4)
  })

  it('shift-bomless-utf16-refused-not-silent-noop: 无 BOM 的 UTF-16 被拒绝，而非报 ok 却什么都没改', async () => {
    // 审计 I7：BOM 检测抓不到它，字节级正则全失配 → 曾经返回 ok:true / shiftedLines:0，
    // 调用方看不出"这文件我没能处理"。
    const p = stageBytes(
      Buffer.from('[Events]\nDialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,x\n', 'utf16le'),
      'bomless.ass',
    )
    const before = readFileSync(p)
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(false)
    expect(readFileSync(p)).toEqual(before)
    expect(existsSync(`${resolve(p)}${BACKUP_SUFFIX}`)).toBe(false)
  })

  it('shift-all-timestamps-malformed-refused: 有 Dialogue 行但没一条时间戳能解析 → 拒绝而非静默报成功', async () => {
    // I7 守卫的另一条到达路径（无 BOM UTF-16 已被 NUL 检测提前拦掉）：
    // 时间戳格式整体不对（这里是 SSA v4 的 h:mm:ss.cc 被写成了 mm:ss 形式）。
    // 这种文件字节级正则全失配，若不拦就是 ok:true / shiftedLines:0 的静默无操作。
    const src = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,10:50,12:30,Default,,0,0,0,,坏时间戳一',
      'Dialogue: 0,15:00,17:00,Default,,0,0,0,,坏时间戳二',
      '',
    ].join('\n')
    const p = stageBytes(Buffer.from(src, 'utf8'), 'allbad.ass')
    const before = readFileSync(p)
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('rewrote 0 timestamp(s)')
    expect(readFileSync(p)).toEqual(before)
    expect(existsSync(`${resolve(p)}${BACKUP_SUFFIX}`)).toBe(false)
  })

  it('shift-no-dialogue-file-is-not-an-error: 本来就没有生效字幕行的文件不报错（0 行是正常的）', async () => {
    // 与上一条区分：eligible=0 时的 shiftedLines=0 是正常状态，不该被 I7 守卫误伤
    const p = stageBytes(Buffer.from('[Script Info]\nTitle: empty\n\n[Events]\n', 'utf8'), 'empty.ass')
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(true)
    expect(r.shiftedLines).toBe(0)
  })

  it('shift-comment-only-file-is-not-an-error: 只有 Comment: 行的文件不报错', async () => {
    const src = '[Events]\nComment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,废弃\n'
    const p = stageBytes(Buffer.from(src, 'utf8'), 'conly.ass')
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(true)
    expect(r.shiftedLines).toBe(0)
    expect(readFileSync(p).toString('utf8')).toBe(src)
  })
})

describe('shiftSubtitleTiming — 拒绝与失败路径', () => {
  it('shift-utf16-refused: UTF-16 BOM 文件被拒绝，原文件一个字节不变、无备份、无残留', async () => {
    // UTF-16LE：'[Events]' 的 ASCII 是双字节
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('[Events]\nDialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,x\n', 'utf16le'),
    ])
    const p = stageBytes(utf16, 'u16.ass')
    const before = readFileSync(p)
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('UTF-16')
    expect(readFileSync(p)).toEqual(before)
    expect(existsSync(`${resolve(p)}${BACKUP_SUFFIX}`)).toBe(false)
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('shift-utf16be-refused: UTF-16BE BOM 同样被拒绝', async () => {
    const p = stageBytes(Buffer.from([0xfe, 0xff, 0x00, 0x5b]), 'u16be.ass')
    const r = await shiftSubtitleTiming(p, 1000)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('UTF-16')
  })

  it('shift-write-failure-leaves-original-intact: 写 tmp 失败时原文件完好、无 tmp 残留', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    const target = resolve(p)
    const r = await shiftSubtitleTiming(p, 2000, {
      // 备份写成功，目标文件写失败（模拟磁盘满/权限）
      writeFileImpl: (path, data) => {
        if (path === target) throw new Error('ENOSPC: simulated disk full')
        writeFileSync(path, data)
      },
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('write failed')
    expect(readFileSync(p)).toEqual(before)
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('shift-real-atomicwrite-failure-cleans-up-tmp: 真实 tmp+rename 路径失败时不留 .tmp 残留', async () => {
    // 上一条用 writeFileImpl 注入，会**绕过**真实的 tmp/rename 逻辑，因此测不到孤儿 tmp 清理
    // （变异验证：砍掉 atomicWrite finally 里的 tmp 清理，正是靠这条才被杀掉）。
    //
    // 要精确覆盖"写到一半失败必须清 tmp"，需要 openSync/writeAll/fsync 全部成功
    // （tmp 文件真的被创建了）而只有最后的 renameSync 抛错。做法：把**目标路径做成非空目录**，
    // rename 到它必失败（ENOTEMPTY/EISDIR）。
    //
    // 首次平移（无备份）时 source 就是目标自己，而目标是个目录 → readFileSync 会 EISDIR，
    // 压根走不到写盘。所以这里给目标目录**旁边**放一个合法的源：用 existsImpl/readFileImpl
    // 让前置检查与读取都看到一份真字幕，而真正的 atomicWrite 仍写向那个非空目录。
    const targetDir = join(dir, 'blocked.ass')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(targetDir)
    writeFileSync(join(targetDir, 'keep.txt'), 'x') // 非空 → rename 必失败
    const realSubtitle = readFileSync(FIXTURE_TORTURE)

    const r = await shiftSubtitleTiming(targetDir, 2000, {
      existsImpl: (path) => path === resolve(targetDir), // 目标存在、备份与 meta 都不存在
      readFileImpl: () => realSubtitle,
    })
    expect(r.ok).toBe(false)
    // 首次平移的第一次落盘是**备份**，它的 rename 目标是 blocked.ass.scout-backup（普通路径，
    // 会成功）；接着写目标（那个非空目录）时 rename 失败。
    expect(r.detail).toContain('write failed')
    // 关键断言：tmp 文件必须已被清掉，不能在用户媒体目录旁堆垃圾
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
    // 目标目录及其内容完好
    expect(existsSync(join(targetDir, 'keep.txt'))).toBe(true)
  })

  it('shift-backup-failure-leaves-original-intact: 备份写失败时原文件完好、不进入目标写', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    let targetWrites = 0
    const target = resolve(p)
    const r = await shiftSubtitleTiming(p, 2000, {
      writeFileImpl: (path) => {
        if (path === target) targetWrites += 1
        throw new Error('EACCES: simulated permission denied')
      },
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('backup write failed')
    expect(targetWrites).toBe(0)
    expect(readFileSync(p)).toEqual(before)
  })

  it('shift-read-failure-refused: 读源失败时如实返回失败，磁盘未动', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    const r = await shiftSubtitleTiming(p, 2000, {
      readFileImpl: () => { throw new Error('EIO: simulated read error') },
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('cannot read source')
    expect(readFileSync(p)).toEqual(before)
  })

  it('shift-missing-file-refused: 文件不存在时拒绝', async () => {
    const r = await shiftSubtitleTiming(join(dir, 'nope.ass'), 2000)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('does not exist')
  })

  it('shift-unsupported-extension-refused: .vtt/.sub 等不支持的后缀被拒绝', async () => {
    const p = stageBytes(Buffer.from('WEBVTT\n', 'utf8'), 'x.vtt')
    const before = readFileSync(p)
    const r = await shiftSubtitleTiming(p, 1000)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('unsupported extension')
    expect(readFileSync(p)).toEqual(before)
  })

  it('shift-non-finite-offset-refused: NaN/Infinity 偏移被拒绝', async () => {
    const p = stage(FIXTURE_TORTURE, 'torture.ass')
    const before = readFileSync(p)
    for (const bad of [NaN, Infinity, -Infinity]) {
      const r = await shiftSubtitleTiming(p, bad)
      expect(r.ok).toBe(false)
      expect(r.detail).toContain('not a finite number')
    }
    expect(readFileSync(p)).toEqual(before)
  })

  it('shift-malformed-timestamp-line-preserved: 时间戳不合法的 Dialogue 行整行原样保留，不半改', async () => {
    const src = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,GARBAGE,0:00:12.00,Default,,0,0,0,,坏行',
      'Dialogue: 0,0:00:20.00,0:00:22.00,Default,,0,0,0,,好行',
      '',
    ].join('\n')
    const p = stageBytes(Buffer.from(src, 'utf8'), 'bad.ass')
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(true)
    expect(r.shiftedLines).toBe(1)
    const a = readFileSync(p).toString('utf8')
    // 坏行完全原样：End 也没被改（不能出现 Start 未变 End 已变的自相矛盾行）
    expect(a).toContain('Dialogue: 0,GARBAGE,0:00:12.00,Default,,0,0,0,,坏行')
    expect(a).toContain('Dialogue: 0,0:00:18.00,0:00:20.00,Default,,0,0,0,,好行')
  })
})

describe('shiftSubtitleTiming — 真实样本', () => {
  it('shift-real-fixture-all-dialogues-shifted: 真实 subhd 样本全部 Dialogue 平移正确，其余字节不变', async () => {
    const p = stage(FIXTURE_REAL_ASS, 'real.ass')
    const before = readFileSync(p)
    const beforeTimes = dialogueTimes(before)
    expect(beforeTimes.length).toBeGreaterThan(10)

    const r = await shiftSubtitleTiming(p, 1000)
    expect(r.ok).toBe(true)
    expect(r.shiftedLines).toBe(beforeTimes.length)

    const after = readFileSync(p)
    // header（[Events] 之前）逐字节不变
    const eventsAt = before.toString('latin1').indexOf('[Events]')
    expect(after.subarray(0, eventsAt)).toEqual(before.subarray(0, eventsAt))

    // 每条 Dialogue 恰好减 1000ms
    const toMs = (s: string) => {
      const m = /^(\d+):(\d\d):(\d\d)\.(\d\d)$/.exec(s)!
      return Number(m[1]) * 3600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]) * 10
    }
    const afterTimes = dialogueTimes(after)
    expect(afterTimes.length).toBe(beforeTimes.length)
    for (let i = 0; i < beforeTimes.length; i++) {
      expect(toMs(afterTimes[i]![0])).toBe(Math.max(0, toMs(beforeTimes[i]![0]) - 1000))
      expect(toMs(afterTimes[i]![1])).toBe(Math.max(0, toMs(beforeTimes[i]![1]) - 1000))
    }
  })
})

describe('shiftSubtitleTiming — 非 UTF-8 编码', () => {
  it('shift-gbk-bytes-preserved: GBK 文件的中文字节原样保留（不解码不转码）', async () => {
    // 手工构造 GBK 字节：'中文' = D6 D0 CE C4。若实现走了 decodeToUtf8 往返，这些字节会变。
    const gbkText = Buffer.concat([
      Buffer.from('[Events]\r\nDialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,', 'latin1'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from('\r\n', 'latin1'),
    ])
    const p = stageBytes(gbkText, 'gbk.ass')
    const r = await shiftSubtitleTiming(p, 2000)
    expect(r.ok).toBe(true)
    const after = readFileSync(p)
    expect(after.includes(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe(true)
    expect(dialogueTimes(after)).toEqual([['0:00:08.00', '0:00:10.00']])
    // 长度不变 = 没有发生编码膨胀
    expect(after.length).toBe(gbkText.length)
  })
})
