import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import {
  findReferenceSource,
  MIN_REFERENCE_CUES,
  MAX_EMBEDDED_TRACKS_TRIED,
  EMBEDDED_TOTAL_BUDGET_MS,
  SIBLING_SUBTITLE_EXTS,
} from './referenceSource.js'
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'

/** 造 SRT 文本：n 条 cue，每条 1s 说话 + 1s 静默。参考源必须 ≥ MIN_REFERENCE_CUES 条
 *  才被接受，所以测试 fixture 默认造够数，"cue 太少"是单独一个 case 显式构造的。 */
function mkSrt(n: number, label = 'line'): string {
  const pad = (v: number, w: number) => String(v).padStart(w, '0')
  const ts = (ms: number) => {
    const h = Math.floor(ms / 3600_000)
    const m = Math.floor((ms % 3600_000) / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`
  }
  const blocks: string[] = []
  for (let i = 0; i < n; i++) {
    const start = 1000 + i * 2000
    blocks.push(`${i + 1}\n${ts(start)} --> ${ts(start + 1000)}\n${label} ${i + 1}\n`)
  }
  return blocks.join('\n')
}

/** 造 ASS 文本：n 条 Dialogue。走 parseAssCues 那条分支（SRT 解析必然得 0 条）。 */
function mkAss(n: number, label = 'line'): string {
  const pad = (v: number, w: number) => String(v).padStart(w, '0')
  const ts = (ms: number) => {
    const h = Math.floor(ms / 3600_000)
    const m = Math.floor((ms % 3600_000) / 60_000)
    const s = Math.floor((ms % 60_000) / 1000)
    return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(Math.floor((ms % 1000) / 10), 2)}`
  }
  const lines = [
    '[Script Info]',
    'Title: Test',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  for (let i = 0; i < n; i++) {
    const start = 1000 + i * 2000
    lines.push(`Dialogue: 0,${ts(start)},${ts(start + 1000)},Default,,0,0,0,,${label} ${i + 1}`)
  }
  return lines.join('\n')
}

const SRT_20 = mkSrt(20)
const ASS_30 = mkAss(30)

const VIDEO = '/video/Show.S01E01.mkv'
const OURS = '/video/Show.S01E01.zh-Hans.srt'

/** 只喂内嵌轨、不许碰同目录——用来锁"①命中时不该去扫盘"。 */
function forbidSiblingIo() {
  return {
    readDir: async (): Promise<string[]> => { throw new Error('tier ② 不该被触达') },
    readSubtitleText: async (): Promise<string | null> => { throw new Error('tier ② 不该被触达') },
  }
}

function textTrack(lang: string, codec = 'subrip'): EmbeddedSubtitleTrack {
  return { lang, codec, isImageBased: false }
}

function imageTrack(lang: string, codec = 'hdmv_pgs_subtitle'): EmbeddedSubtitleTrack {
  return { lang, codec, isImageBased: true }
}

describe('referenceSource 常量', () => {
  it('后缀白名单与 subtitleWriter.ts / sidecar.ts 同源', () => {
    expect([...SIBLING_SUBTITLE_EXTS]).toEqual(['.srt', '.ass', '.ssa'])
  })

  it('cue 下限与轨数上限是正整数', () => {
    expect(MIN_REFERENCE_CUES).toBeGreaterThan(0)
    expect(MAX_EMBEDDED_TRACKS_TRIED).toBeGreaterThan(0)
  })

  it('① 层总预算是正数毫秒', () => {
    expect(EMBEDDED_TOTAL_BUDGET_MS).toBeGreaterThan(0)
  })
})

describe('findReferenceSource — ① 内嵌字幕轨', () => {
  it('有可用内嵌轨 → tier embedded，spans 取自该轨时轴', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng')],
      extractEmbedded: async () => SRT_20,
      ...forbidSiblingIo(),
    })
    expect(result).not.toBeNull()
    expect(result!.tier).toBe('embedded')
    expect(result!.spans).toHaveLength(20)
    expect(result!.spans[0]).toEqual({ startMs: 1000, endMs: 2000 })
    expect(result!.spans[19]).toEqual({ startMs: 39_000, endMs: 40_000 })
  })

  it('内嵌轨语言无关：日语轨同样可用（只看说话时段，不看内容）', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('jpn')],
      extractEmbedded: async () => SRT_20,
      ...forbidSiblingIo(),
    })
    expect(result!.tier).toBe('embedded')
    expect(result!.spans).toHaveLength(20)
  })

  it('spans 不含 text 字段之外的语义——原样是 {startMs,endMs} 可直接喂 detectOffset', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng')],
      extractEmbedded: async () => SRT_20,
      ...forbidSiblingIo(),
    })
    for (const s of result!.spans) {
      expect(Number.isFinite(s.startMs)).toBe(true)
      expect(Number.isFinite(s.endMs)).toBe(true)
      expect(s.endMs).toBeGreaterThan(s.startMs)
    }
  })

  it('位图字幕轨被跳过，不做抽取', async () => {
    let extractCalls = 0
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [imageTrack('eng'), textTrack('jpn')],
      extractEmbedded: async (_v, index) => { extractCalls++; expect(index).toBe(1); return SRT_20 },
      ...forbidSiblingIo(),
    })
    expect(extractCalls).toBe(1)
    expect(result!.tier).toBe('embedded')
  })

  it('全是位图字幕 → ① 失败，降级到 ②', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [imageTrack('eng'), imageTrack('chi', 'dvd_subtitle')],
      extractEmbedded: async () => { throw new Error('位图轨不该被抽取') },
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.srt'],
      readSubtitleText: async (p) => (p.endsWith('eng.srt') ? SRT_20 : null),
    })
    expect(result).not.toBeNull()
    expect(result!.tier).toBe('sibling')
  })

  it('抽取全部失败（返回 null）→ 降级到 ②', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng'), textTrack('jpn')],
      extractEmbedded: async () => null,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.jpn.ass'],
      readSubtitleText: async (p) => (p.endsWith('jpn.ass') ? ASS_30 : null),
    })
    expect(result).not.toBeNull()
    expect(result!.tier).toBe('sibling')
    expect(result!.spans).toHaveLength(30)
  })

  it('probe 返回 null（探测不可用）→ 降级到 ②，不当"确认无内嵌轨"', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => null,
      extractEmbedded: async () => { throw new Error('probe null 时不该抽取') },
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.srt'],
      readSubtitleText: async (p) => (p.endsWith('eng.srt') ? SRT_20 : null),
    })
    expect(result!.tier).toBe('sibling')
  })

  it('多条文本轨 → 选解析后 cue 数最多的那条（不是第一条）', async () => {
    // 第 0 条是"强制字幕轨"形态：cue 数少但非零，正是选第一条会踩的坑
    const forced = mkSrt(12, 'forced')
    const full = mkSrt(800, 'full')
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng'), textTrack('jpn')],
      extractEmbedded: async (_v, index) => (index === 0 ? forced : full),
      ...forbidSiblingIo(),
    })
    expect(result!.tier).toBe('embedded')
    expect(result!.spans).toHaveLength(800)
  })

  it('cue 数并列时保留先到的轨（稳定、可预期）', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng'), textTrack('jpn')],
      extractEmbedded: async () => SRT_20,
      ...forbidSiblingIo(),
    })
    expect(result!.detail).toContain('track 0')
  })

  it('ffmpeg 抽出的 ass 文本也能解析（SRT 解析得 0 条时回落 ASS）', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('jpn', 'ass')],
      extractEmbedded: async () => ASS_30,
      ...forbidSiblingIo(),
    })
    expect(result!.tier).toBe('embedded')
    expect(result!.spans).toHaveLength(30)
  })

  it('所有轨 cue 数都低于下限 → ① 失败，降级到 ②', async () => {
    const tooFew = mkSrt(MIN_REFERENCE_CUES - 1)
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng')],
      extractEmbedded: async () => tooFew,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.srt'],
      readSubtitleText: async (p) => (p.endsWith('eng.srt') ? SRT_20 : null),
    })
    expect(result).not.toBeNull()
    expect(result!.tier).toBe('sibling')
  })

  it('最多只试 MAX_EMBEDDED_TRACKS_TRIED 条轨（防几十条轨的容器退化）', async () => {
    let extractCalls = 0
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => Array.from({ length: 40 }, (_, i) => textTrack(`l${i}`)),
      extractEmbedded: async () => { extractCalls++; return SRT_20 },
      ...forbidSiblingIo(),
    })
    expect(extractCalls).toBe(MAX_EMBEDDED_TRACKS_TRIED)
    expect(result!.tier).toBe('embedded')
  })

  it('上限只数"实际抽取"的轨，位图轨不占额度', async () => {
    let extractCalls = 0
    const tracks = [
      ...Array.from({ length: 10 }, (_, i) => imageTrack(`img${i}`)),
      ...Array.from({ length: 10 }, (_, i) => textTrack(`txt${i}`)),
    ]
    await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => tracks,
      extractEmbedded: async () => { extractCalls++; return SRT_20 },
      ...forbidSiblingIo(),
    })
    expect(extractCalls).toBe(MAX_EMBEDDED_TRACKS_TRIED)
  })

  it('总预算耗尽后不再开新抽取，拿手上的候选择优', async () => {
    // 假时钟：每次抽取"耗时" 25s，第 3 次开始前累计 50s... 第 4 次前 75s > 60s 预算
    let clock = 0
    const extracted: number[] = []
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => Array.from({ length: 5 }, (_, i) => textTrack(`l${i}`)),
      extractEmbedded: async (_v, index) => {
        extracted.push(index)
        clock += 25_000
        return SRT_20
      },
      now: () => clock,
      ...forbidSiblingIo(),
    })
    // 第 1 条无条件试；此后每次开新的都查预算 → 25s、50s 时仍可开，75s 时超预算
    expect(extracted).toEqual([0, 1, 2])
    expect(result!.tier).toBe('embedded')
    expect(result!.detail).toContain('budget')
  })

  it('第一条轨无条件尝试（预算已超也要试，否则慢盘上①层彻底废掉）', async () => {
    let clock = 0
    const extracted: number[] = []
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng'), textTrack('jpn')],
      extractEmbedded: async (_v, index) => {
        extracted.push(index)
        clock += EMBEDDED_TOTAL_BUDGET_MS * 10 // 一条就远超预算
        return SRT_20
      },
      now: () => clock,
      ...forbidSiblingIo(),
    })
    expect(extracted).toEqual([0]) // 试了第一条，没试第二条
    expect(result!.tier).toBe('embedded')
  })

  it('预算内不受影响（典型快速抽取，全部轨都试）', async () => {
    let clock = 0
    const extracted: number[] = []
    await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => Array.from({ length: 3 }, (_, i) => textTrack(`l${i}`)),
      extractEmbedded: async (_v, index) => { extracted.push(index); clock += 50; return SRT_20 },
      now: () => clock,
      ...forbidSiblingIo(),
    })
    expect(extracted).toEqual([0, 1, 2])
  })

  it('预算耗尽且一条候选都没拿到 → 降级到 ②', async () => {
    let clock = 0
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng'), textTrack('jpn')],
      extractEmbedded: async () => { clock += EMBEDDED_TOTAL_BUDGET_MS * 2; return null },
      now: () => clock,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.srt'],
      readSubtitleText: async (p) => (p.endsWith('eng.srt') ? SRT_20 : null),
    })
    expect(result!.tier).toBe('sibling')
  })

  it('抽取抛错（注入实现不守 null 契约）也不炸，降级到 ②', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng')],
      extractEmbedded: async () => { throw new Error('ffmpeg exploded') },
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.srt'],
      readSubtitleText: async (p) => (p.endsWith('eng.srt') ? SRT_20 : null),
    })
    expect(result!.tier).toBe('sibling')
  })

  it('probe 抛错也不炸，降级到 ②', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => { throw new Error('ffprobe exploded') },
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.srt'],
      readSubtitleText: async (p) => (p.endsWith('eng.srt') ? SRT_20 : null),
    })
    expect(result!.tier).toBe('sibling')
  })
})

describe('findReferenceSource — ② 同目录字幕文件', () => {
  const noEmbedded = { probeEmbedded: async (): Promise<EmbeddedSubtitleTrack[]> => [] }

  it('同目录另有字幕 → tier sibling', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.srt'],
      readSubtitleText: async (p) => (p.endsWith('eng.srt') ? SRT_20 : null),
    })
    expect(result).not.toBeNull()
    expect(result!.tier).toBe('sibling')
    expect(result!.spans).toHaveLength(20)
  })

  it('排除待检字幕自己：目录里只有自己 → null', async () => {
    const touched: string[] = []
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt'],
      readSubtitleText: async (p) => { touched.push(p); return null },
    })
    expect(touched).toEqual([])
    expect(result).toBeNull()
  })

  it('排除自己：待检路径给相对路径也能正确排除（path.resolve 归一后比较）', async () => {
    // 待检字幕给**相对**路径，readDir 返回**裸文件名**（与真实 fs.readdir 一致）。
    // 实现内部 join(dirname(resolve(ours)), name) 得绝对路径，与 resolve(ours) 相等，
    // 故只有 resolve() 归一后比较才排得掉；朴素比字符串会漏判（'./x.srt' !== 绝对路径）。
    //
    // 用 process.cwd() 的 basename 反推一个真实存在的相对路径前缀：相对路径必须能
    // resolve 到与 join(dir, name) 相同的位置，这个关系是本测试的全部要害。
    const ourRelative = './Show.S01E01.zh-Hans.srt'
    const videoInCwd = `${resolve('.')}/Show.S01E01.mkv`

    const touched: string[] = []
    const result = await findReferenceSource(videoInCwd, ourRelative, {
      ...noEmbedded,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt'],
      readSubtitleText: async (p) => { touched.push(p); return null },
    })
    // 断言"根本没去读自己"——只断言结果为 null 是不够的：读了自己再因故失败也得 null
    expect(touched).toEqual([])
    expect(result).toBeNull()
  })

  it('排除自己：路径含 ./ 冗余段也能正确排除', async () => {
    const touched: string[] = []
    const result = await findReferenceSource(VIDEO, '/video/./Show.S01E01.zh-Hans.srt', {
      ...noEmbedded,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt'],
      readSubtitleText: async (p) => { touched.push(p); return null },
    })
    // 断言"根本没去读"，而不只是结果为 null——读了自己再因故失败也会得 null，
    // 那样这个测试就形同虚设（拿自己当参考会算出 offset 0 / score 1.0，掩盖一切偏移）
    expect(touched).toEqual([])
    expect(result).toBeNull()
  })

  it('多候选 → 选 cue 数最多的（信息量最大）', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => [
        'Show.S01E01.mkv',
        'Show.S01E01.zh-Hans.srt',
        'Show.S01E01.forced.srt',
        'Show.S01E01.jpn.ass',
      ],
      readSubtitleText: async (p) => {
        if (p.endsWith('forced.srt')) return mkSrt(11, 'forced')
        if (p.endsWith('jpn.ass')) return ASS_30
        return null
      },
    })
    expect(result!.tier).toBe('sibling')
    expect(result!.spans).toHaveLength(30)
    expect(result!.detail).toContain('jpn.ass')
  })

  it('只认 .srt/.ass/.ssa —— .vtt/.sub/.idx 等不进候选', async () => {
    const touched: string[] = []
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => [
        'Show.S01E01.mkv',
        'Show.S01E01.zh-Hans.srt',
        'Show.S01E01.eng.vtt',
        'Show.S01E01.eng.sub',
        'Show.S01E01.eng.idx',
        'Show.S01E01.nfo',
      ],
      readSubtitleText: async (p) => { touched.push(p); return null },
    })
    expect(touched).toEqual([])
    expect(result).toBeNull()
  })

  it('.ssa 也在白名单内', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.ssa'],
      readSubtitleText: async (p) => (p.endsWith('.ssa') ? ASS_30 : null),
    })
    expect(result!.tier).toBe('sibling')
    expect(result!.spans).toHaveLength(30)
  })

  it('后缀大小写不敏感（.SRT/.ASS 也认）', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.ENG.SRT'],
      readSubtitleText: async (p) => (p.toLowerCase().endsWith('.srt') ? SRT_20 : null),
    })
    expect(result!.tier).toBe('sibling')
  })

  it('编码解不出（readSubtitleText 返回 null）→ 跳过该文件，继续下一个', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => [
        'Show.S01E01.mkv',
        'Show.S01E01.zh-Hans.srt',
        'Show.S01E01.gbk-broken.srt',
        'Show.S01E01.good.ass',
      ],
      readSubtitleText: async (p) => {
        if (p.endsWith('gbk-broken.srt')) return null
        if (p.endsWith('good.ass')) return ASS_30
        return null
      },
    })
    expect(result!.tier).toBe('sibling')
    expect(result!.spans).toHaveLength(30)
    expect(result!.detail).toContain('good.ass')
  })

  it('读文件抛错 → 跳过该文件，不炸整次探测', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => [
        'Show.S01E01.mkv',
        'Show.S01E01.zh-Hans.srt',
        'Show.S01E01.eperm.srt',
        'Show.S01E01.good.srt',
      ],
      readSubtitleText: async (p) => {
        if (p.endsWith('eperm.srt')) throw new Error('EACCES')
        if (p.endsWith('good.srt')) return SRT_20
        return null
      },
    })
    expect(result!.tier).toBe('sibling')
    expect(result!.spans).toHaveLength(20)
  })

  it('解析不出 cue 的畸形文件 → 跳过，继续下一个', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => [
        'Show.S01E01.mkv',
        'Show.S01E01.zh-Hans.srt',
        'Show.S01E01.html-404.srt',
        'Show.S01E01.good.srt',
      ],
      readSubtitleText: async (p) => {
        if (p.endsWith('html-404.srt')) return '<!DOCTYPE html><html><body>404</body></html>'
        if (p.endsWith('good.srt')) return SRT_20
        return null
      },
    })
    expect(result!.tier).toBe('sibling')
    expect(result!.spans).toHaveLength(20)
  })

  it('候选 cue 数低于下限 → 不采用（撑不起有意义的互相关）', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.srt'],
      readSubtitleText: async (p) => (p.endsWith('eng.srt') ? mkSrt(MIN_REFERENCE_CUES - 1) : null),
    })
    expect(result).toBeNull()
  })

  it('readDir 抛错（目录不可读）→ 返回 null，不炸', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      ...noEmbedded,
      readDir: async () => { throw new Error('ENOENT') },
      readSubtitleText: async () => null,
    })
    expect(result).toBeNull()
  })
})

describe('findReferenceSource — 两层皆无', () => {
  it('probe 返回 []（确认无内嵌轨）+ 同目录无其他字幕 → null', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [],
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt'],
      readSubtitleText: async () => null,
    })
    expect(result).toBeNull()
  })

  it('probe 返回 null + 同目录空 → null', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => null,
      readDir: async () => [],
      readSubtitleText: async () => null,
    })
    expect(result).toBeNull()
  })
})

describe('findReferenceSource — detail 字段（内部诊断，不上 UI）', () => {
  it('① 命中时记下轨号与 cue 数', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng')],
      extractEmbedded: async () => SRT_20,
      ...forbidSiblingIo(),
    })
    expect(result!.detail).toContain('embedded')
    expect(result!.detail).toContain('20')
  })

  it('② 命中时记下所选文件名与 cue 数，并带上 ① 失败原因', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [imageTrack('eng')],
      readDir: async () => ['Show.S01E01.mkv', 'Show.S01E01.zh-Hans.srt', 'Show.S01E01.eng.srt'],
      readSubtitleText: async (p) => (p.endsWith('eng.srt') ? SRT_20 : null),
    })
    expect(result!.detail).toContain('sibling')
    expect(result!.detail).toContain('eng.srt')
    expect(result!.detail).toContain('20')
    // ① 为什么没命中也要留痕，否则事后无法区分"没内嵌轨"与"内嵌轨全是位图"
    expect(result!.detail).toContain('image-based')
  })

  it('detail 是单行字符串，适合塞进结构化痕迹字段', async () => {
    const result = await findReferenceSource(VIDEO, OURS, {
      probeEmbedded: async () => [textTrack('eng')],
      extractEmbedded: async () => SRT_20,
      ...forbidSiblingIo(),
    })
    expect(result!.detail).not.toContain('\n')
    expect(typeof result!.detail).toBe('string')
  })
})
