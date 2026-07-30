import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as iconv from 'iconv-lite'
import { parseCues, toSpans, readSubtitleText, hashSubtitleContent, loadSpans } from './subtitleSpans.js'

/**
 * 参考源侧与待检侧共用的读+解码+解析底座。
 *
 * 这个模块存在的全部理由是"两侧口径必须一致"，所以测试重点在于：编码探测真的生效
 * （GBK 字幕不能变乱码）、格式试探按内容而非扩展名、以及哈希的语义（时间戳必须参与）。
 */

const SRT = `1
00:00:01,000 --> 00:00:02,000
你好世界

2
00:00:03,500 --> 00:00:04,500
第二句
`

const ASS = `[Script Info]
Title: t

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,你好世界
Dialogue: 0,0:00:03.50,0:00:04.50,Default,,0,0,0,,第二句
`

/** 编码探测用的**真实体量**样本（60 条 cue，约 5KB）。
 *
 *  刻意不用上面那个 2 条 cue 的 SRT：chardet 是统计式探测，41 字节的样本会被判成
 *  ISO-8859-7 之类的西欧编码（实测），于是 GBK 中文解出乱码。这是 decodeToUtf8
 *  （src/files/subtitleEncoding.ts，全仓共用）的既有性质而非本模块的缺陷——真实字幕
 *  文件都是几十 KB 起，落在探测可靠的区间。用 2 条 cue 测编码只会测出 chardet 的
 *  小样本行为，与生产路径无关。 */
const BIG_SRT = Array.from({ length: 60 }, (_, i) => {
  const n = i + 1
  const s = String(n % 60).padStart(2, '0')
  const e = String((n + 1) % 60).padStart(2, '0')
  return `${n}\n00:01:${s},000 --> 00:01:${e},000\n这是第${n}句台词，内容足够长以便编码探测能够正常工作。\n`
}).join('\n')

describe('subtitleSpans', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spans-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (name: string, content: Buffer | string) => {
    const p = join(dir, name)
    writeFileSync(p, content)
    return p
  }

  describe('parseCues：按内容试探，不按扩展名', () => {
    it('SRT 文本解析出 cue', () => {
      expect(parseCues(SRT).map((c) => c.startMs)).toEqual([1000, 3500])
    })

    it('ASS 文本解析出 cue（SRT 解析得 0 条后回落）', () => {
      expect(parseCues(ASS).map((c) => c.startMs)).toEqual([1000, 3500])
    })

    it('.srt 里装 ASS 内容照样解析出来（字幕站常见错贴）', () => {
      // 按扩展名分派的实现会在这里得 0 条 cue，把一条可用的参考源误判成不可用。
      const text = ASS
      expect(parseCues(text).length).toBe(2)
    })

    it('不是字幕的文本（如 404 HTML 页）返回空数组，不抛', () => {
      expect(parseCues('<html><body>Not Found</body></html>')).toEqual([])
    })

    it('空文本返回空数组', () => {
      expect(parseCues('')).toEqual([])
    })
  })

  describe('toSpans：只留时段，剥掉文本', () => {
    it('剥掉 text 字段（对齐一律不看内容，跨语言天然对不上）', () => {
      expect(toSpans(parseCues(SRT))).toEqual([
        { startMs: 1000, endMs: 2000 },
        { startMs: 3500, endMs: 4500 },
      ])
    })

    it('空输入得空输出', () => {
      expect(toSpans([])).toEqual([])
    })
  })

  describe('readSubtitleText：读 + 编码归一', () => {
    it('UTF-8 文件原样读回', async () => {
      const p = write('a.srt', SRT)
      expect(await readSubtitleText(p)).toContain('你好世界')
    })

    it('GBK 文件解码成正确中文（朴素按 utf-8 读会变乱码→解析出 0 条 cue→误判无参考源）', async () => {
      const p = write('gbk.srt', iconv.encode(BIG_SRT, 'gbk'))
      const text = await readSubtitleText(p)
      expect(text).toContain('这是第1句台词')
      expect(parseCues(text!).length).toBe(60)
    })

    it('BIG5 文件同样解码正确', async () => {
      // 正体中文样本：BIG5 编不了"这/够"这类简体字（会落成 '?'），用简体样本测 BIG5
      // 只会测出"转码丢字"，与解码路径无关。
      const trad = BIG_SRT.replace(/这是第(\d+)句台词，内容足够长以便编码探测能够正常工作。/g,
        '這是第$1句台詞，內容足夠長以便編碼探測能夠正常工作。')
      const p = write('big5.srt', iconv.encode(trad, 'big5'))
      const text = await readSubtitleText(p)
      expect(text).toContain('句台詞')
      expect(parseCues(text!).length).toBe(60)
    })

    it('文件不存在返回 null，不抛（一个读不动的候选不该让整次检测失败）', async () => {
      expect(await readSubtitleText(join(dir, 'nope.srt'))).toBeNull()
    })

    it('路径是目录返回 null，不抛', async () => {
      expect(await readSubtitleText(dir)).toBeNull()
    })
  })

  describe('hashSubtitleContent', () => {
    it('同内容得同哈希', async () => {
      const a = write('a.srt', SRT)
      const b = write('b.srt', SRT)
      expect(await hashSubtitleContent(a)).toBe(await hashSubtitleContent(b))
    })

    it('内容不同得不同哈希', async () => {
      const a = write('a.srt', SRT)
      const b = write('b.srt', SRT.replace('你好世界', '换了台词'))
      expect(await hashSubtitleContent(a)).not.toBe(await hashSubtitleContent(b))
    })

    it('**时间戳变了哈希必须变**——这是本模块唯一关心的维度', async () => {
      // 若复用 subtitleDialogueFingerprint（刻意剥掉时间戳只哈希对白），平移过时间轴的字幕
      // 会哈希不变而永不重检——恰好把校验唯一在意的那一维抹掉了。
      const a = write('a.srt', SRT)
      const b = write('b.srt', SRT.replace('00:00:01,000', '00:00:03,000'))
      expect(await hashSubtitleContent(a)).not.toBe(await hashSubtitleContent(b))
    })

    it('同内容的 GBK 与 UTF-8 两份得同哈希（哈希解码后文本，不哈希原始字节）', async () => {
      // 一次无害的编码归一化（subtitleWriter 落盘就会做）不该触发"变了要重检"。
      const utf8 = write('u.srt', BIG_SRT)
      const gbk = write('g.srt', iconv.encode(BIG_SRT, 'gbk'))
      expect(await hashSubtitleContent(gbk)).toBe(await hashSubtitleContent(utf8))
    })

    it('读不到文件返回 null（调用方据此保守判需重检）', async () => {
      expect(await hashSubtitleContent(join(dir, 'nope.srt'))).toBeNull()
    })
  })

  describe('loadSpans：一条龙', () => {
    it('读 + 解码 + 解析 + 剥 spans', async () => {
      const p = write('a.srt', iconv.encode(BIG_SRT, 'gbk'))
      const spans = await loadSpans(p)
      expect(spans?.length).toBe(60)
      expect(spans![0]).toEqual({ startMs: 61_000, endMs: 62_000 })
    })

    it('读不到返回 null', async () => {
      expect(await loadSpans(join(dir, 'nope.srt'))).toBeNull()
    })

    it('解析出 0 条 cue 返回 null（与读失败对调用方是同一件事：拿不到时间轴）', async () => {
      const p = write('junk.srt', '<html>404</html>')
      expect(await loadSpans(p)).toBeNull()
    })
  })
})
