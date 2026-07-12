import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectSubtitle } from './subtitleInspect.js'

const dir = () => mkdtempSync(join(tmpdir(), 'inspect-'))
function stage(name: string, content: string): string {
  const p = join(dir(), name)
  writeFileSync(p, content, 'utf8')
  return p
}

const SRT_SAMPLE = [
  '1', '00:00:01,000 --> 00:00:03,500', '你好世界', '',
  '2', '00:00:04,000 --> 00:00:06,200', '第二条字幕', '',
  '3', '00:20:00,000 --> 00:20:02,000', '最后一条', '',
].join('\n')

describe('inspectSubtitle — SRT cue parsing', () => {
  it('counts cues and reports first/last/span in ms', () => {
    const signals = inspectSubtitle(stage('a.srt', SRT_SAMPLE))
    expect(signals.cueCount).toBe(3)
    expect(signals.firstCueMs).toBe(1000)
    expect(signals.lastCueMs).toBe(20 * 60_000 + 2000)
    expect(signals.spanMs).toBe(signals.lastCueMs! - signals.firstCueMs!)
  })

  it('handles a comma or dot millisecond separator', () => {
    const dotStyle = '1\n00:00:01.000 --> 00:00:02.000\nhi\n'
    const signals = inspectSubtitle(stage('b.srt', dotStyle))
    expect(signals.cueCount).toBe(1)
  })

  it('zero cues on an empty-but-decodable file', () => {
    const signals = inspectSubtitle(stage('empty.srt', '\n\n'))
    expect(signals.cueCount).toBe(0)
    expect(signals.firstCueMs).toBeNull()
    expect(signals.lastCueMs).toBeNull()
    expect(signals.spanMs).toBeNull()
  })
})
