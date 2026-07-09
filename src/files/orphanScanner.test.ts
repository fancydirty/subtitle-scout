import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as iconv from 'iconv-lite'
import { scanOrphans } from './orphanScanner.js'

function dir(files: Record<string, Buffer | string>) {
  const d = mkdtempSync(join(tmpdir(), 'orph-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content)
  return d
}
const VIDEO = 'Tron.Ares.2025.2160p.WEB-DL.mp4'

describe('scanOrphans', () => {
  it('finds mismatched subtitle files with content sample', () => {
    const d = dir({
      [VIDEO]: 'fake video',
      '创：战神.Tron.Ares.中英字幕.ass': '[Script Info]\nTitle: 创：战神 Tron Ares 中英双语\n',
    })
    const orphans = scanOrphans(d, VIDEO)
    expect(orphans.length).toBe(1)
    expect(orphans[0].filename).toBe('创：战神.Tron.Ares.中英字幕.ass')
    expect(orphans[0].sample).toContain('中英双语')
  })
  it('excludes conforming-named subtitles and the video itself', () => {
    const d = dir({
      [VIDEO]: 'v',
      'Tron.Ares.2025.2160p.WEB-DL.zh-Hans.ass': 'conforming',
      'Tron.Ares.2025.2160p.WEB-DL.srt': 'also conforming (no lang tag)',
    })
    expect(scanOrphans(d, VIDEO)).toEqual([])
  })
  it('decodes GB18030 samples', () => {
    const d = dir({
      [VIDEO]: 'v',
      'old.srt': iconv.encode('1\n00:00:01,000 --> 00:00:02,000\n创战纪台词样本内容\n', 'gb18030'),
    })
    const orphans = scanOrphans(d, VIDEO)
    expect(orphans[0].sample).toContain('创战纪')
  })
  it('caps sample length and skips huge/hidden files', () => {
    const d = dir({
      [VIDEO]: 'v',
      '.hidden.ass': 'x',
      'big.ass': 'a'.repeat(10000),
    })
    const orphans = scanOrphans(d, VIDEO)
    expect(orphans.length).toBe(1) // 只有 big.ass；隐藏文件跳过
    expect(orphans[0].sample.length).toBeLessThanOrEqual(500)
  })
})
