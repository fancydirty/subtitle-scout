import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as iconv from 'iconv-lite'
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

// 之前的实现用 `00:00:0${i}` 硬拼一个前导零：i>=10 时秒位溢出成三位数（如 "010"），
// SRT_TIME 正则匹配不上，cue 被静默丢弃而不报错。改成把秒数溢出 spread 进分钟位、
// 并 zero-pad 到两位，保证任意 N 条 cue 都能生成合法时间戳、全部解析成功。
function srtWithLines(lines: string[]): string {
  const fmt = (totalSeconds: number): string => {
    const m = Math.floor(totalSeconds / 60)
    const s = totalSeconds % 60
    const pad = (n: number) => String(n).padStart(2, '0')
    return `00:${pad(m)}:${pad(s)}.000`
  }
  return lines.map((text, i) =>
    `${i + 1}\n${fmt(i)} --> ${fmt(i + 1)}\n${text}\n`
  ).join('\n')
}

describe('inspectSubtitle — detectScript', () => {
  it('detects simplified Chinese from sampled cue text', () => {
    const lines = Array.from({ length: 12 }, () => '这是国说来时会为学过对现关开东车门问儿')
    const signals = inspectSubtitle(stage('simp.srt', srtWithLines(lines)))
    expect(signals.cueCount).toBe(12) // 全部 12 条都应解析成功（回归 finding 6 的 helper 修复）
    expect(signals.detectedScript).toBe('zh-Hans')
  })

  it('detects traditional Chinese from sampled cue text', () => {
    const lines = Array.from({ length: 12 }, () => '這是國說來時會為學過對現關開東車門問兒')
    const signals = inspectSubtitle(stage('trad.srt', srtWithLines(lines)))
    expect(signals.cueCount).toBe(12)
    expect(signals.detectedScript).toBe('zh-Hant')
  })

  it('detects Cantonese markers even mixed with traditional characters', () => {
    const lines = Array.from({ length: 12 }, () => '佢哋唔係咁樣嘅嘢喺呢度')
    const signals = inspectSubtitle(stage('yue.srt', srtWithLines(lines)))
    expect(signals.cueCount).toBe(12)
    expect(signals.detectedScript).toBe('zh-yue')
  })

  it('reports "other" for non-Han text', () => {
    const lines = Array.from({ length: 12 }, () => 'Hello world, this is English text.')
    const signals = inspectSubtitle(stage('eng.srt', srtWithLines(lines)))
    expect(signals.cueCount).toBe(12)
    expect(signals.detectedScript).toBe('other')
  })

  it('reports "unknown" when there are too few Han characters to judge', () => {
    const signals = inspectSubtitle(stage('sparse.srt', srtWithLines(['你', '好'])))
    expect(signals.cueCount).toBe(2)
    expect(signals.detectedScript).toBe('unknown')
  })

  it('parses all cues past index 9 where the old zero-padding bug silently dropped them', () => {
    // 25 条 cue：覆盖秒位溢出到两位数(i=10..)乃至分钟位进位(i=60..)的场景
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`)
    const signals = inspectSubtitle(stage('many.srt', srtWithLines(lines)))
    expect(signals.cueCount).toBe(25)
  })
})

describe('inspectSubtitle — large cue counts do not crash first/last-cue detection', () => {
  it('handles 200k cues without RangeError and returns finite first/last cue ms', () => {
    // Math.min(...cues.map(...)) / Math.max(...) 展开一个 20 万元素的参数列表，在 V8 上会
    // 撞 "Maximum call stack size exceeded"（约 13 万+ 元素起）——字幕组合集/全季合并的
    // .srt 轻松越过这个坎。改成单次遍历后不应再抛错。
    // 20s 超时：这条用例真实吃到的是 chardet.detect 扫一个 ~8MB buffer 的开销（finding 3
    // 引入,本身就是秒级），在全量并行跑测试时的 CPU 争抢下容易顶到 vitest 默认 5s；
    // RangeError 回归会同步抛错、不会拖到超时，所以放宽超时不会掩盖真正的 bug。
    const n = 200_000
    const pad = (x: number) => String(x).padStart(2, '0')
    const fmt = (totalSeconds: number) => {
      const h = Math.floor(totalSeconds / 3600)
      const m = Math.floor((totalSeconds % 3600) / 60)
      const s = totalSeconds % 60
      return `${pad(h)}:${pad(m)}:${pad(s)},000`
    }
    const parts: string[] = []
    for (let i = 0; i < n; i++) {
      parts.push(`${i + 1}\n${fmt(i)} --> ${fmt(i + 1)}\nx\n`)
    }
    const path = stage('huge.srt', parts.join('\n'))

    let signals: ReturnType<typeof inspectSubtitle> | undefined
    expect(() => { signals = inspectSubtitle(path) }).not.toThrow()

    expect(signals!.cueCount).toBe(n)
    expect(Number.isFinite(signals!.firstCueMs!)).toBe(true)
    expect(Number.isFinite(signals!.lastCueMs!)).toBe(true)
    expect(signals!.firstCueMs).toBe(0)
    expect(signals!.lastCueMs).toBe(n * 1000)
  }, 20_000)
})

describe('inspectSubtitle — oversize file guard', () => {
  it('fails closed on a file just over the 16MB cap without reading it into memory', () => {
    // 重复写同一个小 buffer 撑到刚好超过 cap的内容是普通可解码的 ASCII 字节（不是全零/
    // 稀疏洞），这样如果护栏没生效、老代码把整个文件读进来，会正常判成 decodable:true——
    // 测试才能真正区分"护栏生效"和"侥幸通过"，而不是靠控制字节误伤蒙对。同时全程只
    // 复用一个 64KB 的 buffer 反复 write，不在测试进程里攒一个 16MB 的字符串/Buffer。
    const path = join(dir(), 'huge-oversize.srt')
    const fd = openSync(path, 'w')
    const CAP = 16 * 1024 * 1024
    const target = CAP + 1024
    const chunk = Buffer.alloc(64 * 1024, 'a'.charCodeAt(0))
    let written = 0
    while (written < target) {
      const n = writeSync(fd, chunk, 0, Math.min(chunk.length, target - written))
      written += n
    }
    closeSync(fd)

    let signals: ReturnType<typeof inspectSubtitle> | undefined
    expect(() => { signals = inspectSubtitle(path) }).not.toThrow()

    expect(signals).toEqual({
      decodable: false,
      isHtml: false,
      cueCount: 0,
      firstCueMs: null,
      lastCueMs: null,
      spanMs: null,
      detectedScript: 'unknown',
    })
  })

  it('still inspects a normal small file the same as before (cap does not affect real subtitles)', () => {
    const signals = inspectSubtitle(stage('small.srt', SRT_SAMPLE))
    expect(signals.decodable).toBe(true)
    expect(signals.cueCount).toBe(3)
  })
})

describe('inspectSubtitle — non-UTF-8 encodings decode via chardet+iconv (same path as subtitleWriter)', () => {
  it('a GBK-encoded Chinese SRT is decodable and reports the correct script, instead of mojibaking to decodable:false', () => {
    const body = [
      '1', '00:00:01,000 --> 00:00:03,000', '你好世界，这是国说来时会为学过对现关开东车门问儿', '',
      '2', '00:00:04,000 --> 00:00:06,000', '第二条字幕内容测试国说来时会为学过对现关开东车门问儿', '',
    ].join('\n')
    const gbkBytes = iconv.encode(body, 'gbk')
    const path = join(dir(), 'gbk.srt')
    writeFileSync(path, gbkBytes)

    const signals = inspectSubtitle(path)

    expect(signals.decodable).toBe(true)
    expect(signals.isHtml).toBe(false)
    expect(signals.cueCount).toBe(2)
    expect(signals.detectedScript).toBe('zh-Hans')
  })
})

const ASS_LONG_TITLE_AND_COMMENT = (title: string, comment: string) => [
  '[Script Info]',
  comment,
  `Title: ${title}`,
  'ScriptType: v4.00+',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,你好',
].join('\n')

describe('inspectSubtitle — assTitle / assHeaderComment truncation and extraction', () => {
  it('truncates an oversized assTitle to ~200 chars instead of shipping it whole into a downstream prompt', () => {
    const hugeTitle = 'A'.repeat(5000)
    const path = stage('huge-title.ass', ASS_LONG_TITLE_AND_COMMENT(hugeTitle, '; normal comment'))
    const signals = inspectSubtitle(path)
    expect(signals.assTitle).not.toBeNull()
    expect(signals.assTitle!.length).toBeLessThanOrEqual(200)
    expect(signals.assTitle).toBe(hugeTitle.slice(0, 200))
  })

  it('extracts a fansub header comment line from [Script Info] as assHeaderComment', () => {
    const path = stage('header-comment.ass', ASS_LONG_TITLE_AND_COMMENT('Show S05E05', '; 桜都字幕组 第5话'))
    const signals = inspectSubtitle(path)
    expect(signals.assHeaderComment).toBeDefined()
    expect(signals.assHeaderComment).toContain('桜都字幕组')
  })

  it('also truncates an oversized assHeaderComment to ~200 chars', () => {
    const hugeComment = `; ${'注'.repeat(5000)}`
    const path = stage('huge-comment.ass', ASS_LONG_TITLE_AND_COMMENT('Show', hugeComment))
    const signals = inspectSubtitle(path)
    expect(signals.assHeaderComment).toBeDefined()
    expect(signals.assHeaderComment!.length).toBeLessThanOrEqual(200)
  })

  it('omits assHeaderComment when the ASS file has no [Script Info] comment lines', () => {
    const signals = inspectSubtitle(stage('no-comment.ass', ASS_SAMPLE))
    expect(signals.assHeaderComment).toBeUndefined()
  })
})
