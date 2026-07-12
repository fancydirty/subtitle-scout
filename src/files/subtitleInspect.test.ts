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

const ASS_SAMPLE = [
  '[Script Info]',
  'Title: [字幕组] Show S02E05 [1080p]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,Arial,20',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,你好,世界',
  'Dialogue: 0,0:00:04.00,0:00:06.20,Default,,0,0,0,,第二条字幕',
].join('\n')

describe('inspectSubtitle — ASS cue parsing', () => {
  it('counts Dialogue lines as cues and extracts the Script Info Title', () => {
    const signals = inspectSubtitle(stage('a.ass', ASS_SAMPLE))
    expect(signals.cueCount).toBe(2)
    expect(signals.assTitle).toBe('[字幕组] Show S02E05 [1080p]')
  })

  it('parses ASS H:MM:SS.cc timestamps into ms and preserves commas inside Text', () => {
    const signals = inspectSubtitle(stage('b.ass', ASS_SAMPLE))
    expect(signals.firstCueMs).toBe(1000)
    expect(signals.lastCueMs).toBe(6200) // deviation from plan: original expression `6 * 1000 + 6200 - 6000 + 6000` evaluated to 12200, not the 6200ms the inline comment intended
  })

  it('.ssa extension uses the same ASS parser', () => {
    const signals = inspectSubtitle(stage('c.ssa', ASS_SAMPLE))
    expect(signals.cueCount).toBe(2)
  })
})

describe('inspectSubtitle — decodable / isHtml', () => {
  it('flags an HTML error page masquerading as .srt', () => {
    const html = '<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head><body>gone</body></html>'
    const signals = inspectSubtitle(stage('fake.srt', html))
    expect(signals.isHtml).toBe(true)
    expect(signals.cueCount).toBe(0)
  })

  it('flags an empty file as undecodable', () => {
    const signals = inspectSubtitle(stage('blank.srt', ''))
    expect(signals.decodable).toBe(false)
  })

  it('flags a file dominated by replacement characters as undecodable', () => {
    const garbage = '�'.repeat(500)
    const signals = inspectSubtitle(stage('garbled.srt', garbage))
    expect(signals.decodable).toBe(false)
  })

  it('a normal SRT file is decodable and not HTML', () => {
    const signals = inspectSubtitle(stage('ok.srt', SRT_SAMPLE))
    expect(signals.decodable).toBe(true)
    expect(signals.isHtml).toBe(false)
  })
})
