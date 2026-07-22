import { describe, it, expect } from 'vitest'
import { translateItem, type TranslateItemDeps } from './translateItem.js'
import type { TranslationLM } from './translatePipeline.js'
import type { SrtCue } from './qualityGate.js'

const SOURCE = ['1', '00:00:01,000 --> 00:00:03,000', 'Rose enters Pictor.', ''].join('\n')

/** 忠实 MockLM:术语替换、结构保留 → 过闸。drift=true 把 Pictor 漂成皮克特(被闸拦)。 */
function mockLM(drift = false): TranslationLM {
  return {
    async buildGlossary() { return [{ en: 'Rose', zh: '罗斯' }, { en: 'Pictor', zh: '皮克托' }] },
    async translateBatch(batch: SrtCue[]) {
      return {
        cues: batch.map((c) => ({ ...c, text: c.text.map((l) => l.replace(/Rose/g, '罗斯').replace(/Pictor/g, drift ? '皮克特' : '皮克托')) })),
        summary: 's',
      }
    },
  }
}

function baseDeps(over: Partial<TranslateItemDeps> = {}): TranslateItemDeps {
  return {
    probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
    extract: async () => SOURCE,
    lm: mockLM(),
    readExistingChineseSidecar: () => null,
    writeSidecar: (videoPath, _content) => videoPath.replace(/\.[^.]+$/, '.zh-Hans.srt'),
    ...over,
  }
}

describe('translateItem — 端到端编排', () => {
  it('内嵌英文轨 + 无中字 + 忠实译 → installed,写 zh-Hans sidecar', async () => {
    const written: { path: string; content: string }[] = []
    const deps = baseDeps({ writeSidecar: (vp, c) => { const p = vp.replace(/\.[^.]+$/, '.zh-Hans.srt'); written.push({ path: p, content: c }); return p } })
    const r = await translateItem('/media/The.Rig.S02E01.mkv', deps)
    expect(r.status).toBe('installed')
    expect(r.sidecarPath).toBe('/media/The.Rig.S02E01.zh-Hans.srt')
    expect(written).toHaveLength(1)
    expect(written[0].content).toContain('皮克托')
  })

  it('无内嵌可抽文本轨(只有图形轨) → no-embedded', async () => {
    const r = await translateItem('/media/x.mkv', baseDeps({ probe: async () => [{ lang: 'eng', codec: 'hdmv_pgs_subtitle', isImageBased: true }] }))
    expect(r.status).toBe('no-embedded')
  })

  it('探测返回 null(探针不可用) → no-embedded', async () => {
    const r = await translateItem('/media/x.mkv', baseDeps({ probe: async () => null }))
    expect(r.status).toBe('no-embedded')
  })

  it('已有中文外挂 → already-covered', async () => {
    const r = await translateItem('/media/x.mkv', baseDeps({ readExistingChineseSidecar: () => '/media/x.zh-Hans.srt' }))
    expect(r.status).toBe('already-covered')
  })

  it('内嵌已有中文轨 → already-covered', async () => {
    const r = await translateItem('/media/x.mkv', baseDeps({ probe: async () => [{ lang: 'chi', codec: 'subrip', isImageBased: false }] }))
    expect(r.status).toBe('already-covered')
  })

  it('抽取失败 → extract-failed', async () => {
    const r = await translateItem('/media/x.mkv', baseDeps({ extract: async () => null }))
    expect(r.status).toBe('extract-failed')
  })

  it('译文漂移过不了闸 → held,绝不写 sidecar(fail-closed)', async () => {
    const written: { path: string; content: string }[] = []
    const deps = baseDeps({ lm: mockLM(true), writeSidecar: (vp, c) => { const p = vp.replace(/\.[^.]+$/, '.zh-Hans.srt'); written.push({ path: p, content: c }); return p } })
    const r = await translateItem('/media/x.mkv', deps)
    expect(r.status).toBe('held')
    expect(written).toHaveLength(0)
  })

  it('critic 判不合格 → held,不写 sidecar(语义层透传)', async () => {
    const written: { path: string; content: string }[] = []
    const deps = baseDeps({
      critic: { async review() { return { ok: false, issues: [{ cueIndex: '1', severity: 'major', kind: 'awkward', note: '生硬' }] } } },
      writeSidecar: (vp, c) => { const p = vp.replace(/\.[^.]+$/, '.zh-Hans.srt'); written.push({ path: p, content: c }); return p },
    })
    const r = await translateItem('/media/x.mkv', deps)
    expect(r.status).toBe('held')
    expect(written).toHaveLength(0)
  })

  it('F1: 无合格轨 + fetchSourceSub 命中 → 走同一管道 installed,带 sourceRef', async () => {
    const written: { path: string; content: string }[] = []
    const deps = baseDeps({
      probe: async () => [{ lang: 'eng', codec: 'hdmv_pgs_subtitle', isImageBased: true }], // 只有图形轨=无合格轨
      fetchSourceSub: async () => ({ srtText: SOURCE, sourceRef: 'opensubtitles:12345' }),
      writeSidecar: (vp, c) => { const p = vp.replace(/\.[^.]+$/, '.zh-Hans.srt'); written.push({ path: p, content: c }); return p },
    })
    const r = await translateItem('/media/x.mkv', deps)
    expect(r.status).toBe('installed')
    expect(r.sourceRef).toBe('opensubtitles:12345')
    expect(written).toHaveLength(1)
    expect(written[0].content).toContain('皮克托') // 抓下来的文本走了既有翻译管道
  })

  it('F1: 无合格轨 + fetchSourceSub 返回 null → no-source', async () => {
    const r = await translateItem('/media/x.mkv', baseDeps({
      probe: async () => [],
      fetchSourceSub: async () => null,
    }))
    expect(r.status).toBe('no-source')
  })

  it('F1: 无合格轨 + 未接线 fetchSourceSub → no-embedded(行为不变)', async () => {
    const r = await translateItem('/media/x.mkv', baseDeps({ probe: async () => [] }))
    expect(r.status).toBe('no-embedded')
  })

  it('F1: 有合格内嵌轨时绝不调 fetchSourceSub(省下载配额)', async () => {
    let fetchCalls = 0
    const r = await translateItem('/media/x.mkv', baseDeps({
      fetchSourceSub: async () => { fetchCalls++; return { srtText: SOURCE, sourceRef: 'opensubtitles:1' } },
    }))
    expect(r.status).toBe('installed')
    expect(fetchCalls).toBe(0)
  })

  it('F1: 探针不可用(probe null)时不调 fetchSourceSub → no-embedded(不能判、不猜、不译)', async () => {
    let fetchCalls = 0
    const r = await translateItem('/media/x.mkv', baseDeps({
      probe: async () => null,
      fetchSourceSub: async () => { fetchCalls++; return { srtText: SOURCE, sourceRef: 'opensubtitles:1' } },
    }))
    expect(r.status).toBe('no-embedded')
    expect(fetchCalls).toBe(0)
  })

  it('F1: fetch 腿的译文同样过 fail-closed 闸 → 漂移 held,不写 sidecar', async () => {
    const written: string[] = []
    const r = await translateItem('/media/x.mkv', baseDeps({
      probe: async () => [],
      fetchSourceSub: async () => ({ srtText: SOURCE, sourceRef: 'opensubtitles:9' }),
      lm: mockLM(true),
      writeSidecar: (vp) => { written.push(vp); return vp },
    }))
    expect(r.status).toBe('held')
    expect(written).toHaveLength(0)
  })

  it('选第一条非中文文本轨当源(跳过图形轨)', async () => {
    let extractedIndex = -1
    const deps = baseDeps({
      probe: async () => [
        { lang: 'eng', codec: 'hdmv_pgs_subtitle', isImageBased: true }, // idx0 图形→跳
        { lang: 'eng', codec: 'subrip', isImageBased: false }, // idx1 文本英文→选
      ],
      extract: async (_vp, idx) => { extractedIndex = idx; return SOURCE },
    })
    const r = await translateItem('/media/x.mkv', deps)
    expect(extractedIndex).toBe(1)
    expect(r.status).toBe('installed')
  })
})

describe('translateItem — 时长校验闸(北极星:错版本/错源永不落盘)', () => {
  // 生产实案:Overflow 全季 8 集装错版本(TV 版 210s 视频装了 423s 完整版字幕);Adam E01
  // 翻译用了 24 分钟字幕给 3.5 分钟视频(spanRatio=6.8)。translatePipeline 是纯文本管道
  // 不知视频时长,这道闸只能在 translateItem 层(它持 videoPath)用 ffprobe 比对产出字幕
  // 最后 cue 结束时间 / 视频时长,不在 [0.85, 1.15] → held(fail-closed 绝不写 sidecar)。
  // mockLM 冻结时轴(只替换文本),故产出字幕的结束时间 = 源 SRT 的结束时间。

  it('产出字幕最后 cue 结束时间 / 视频时长 > 1.15 → held(duration-mismatch),绝不写 sidecar', async () => {
    // 423s 字幕 / 210s 视频 = 2.01(Overflow 装错版本实案)
    const longSource = ['1', '00:00:01,000 --> 00:07:03,000', 'Rose enters Pictor.', ''].join('\n')
    const written: string[] = []
    const r = await translateItem('/media/Overflow.S01.mkv', baseDeps({
      extract: async () => longSource,
      videoDurationSec: async () => 210,
      writeSidecar: (vp) => { written.push(vp); return vp },
    }))
    expect(r.status).toBe('held')
    expect(r.reason).toContain('duration-mismatch')
    expect(r.reason).toContain('423')
    expect(r.reason).toContain('210')
    expect(written).toHaveLength(0)
  })

  it('产出字幕最后 cue 结束时间 / 视频时长 < 0.85 → held(duration-mismatch)', async () => {
    // 100s 字幕 / 1000s 视频 = 0.1(字幕远短于视频)
    const shortSource = ['1', '00:00:01,000 --> 00:01:40,000', 'Rose enters Pictor.', ''].join('\n')
    const r = await translateItem('/media/x.mkv', baseDeps({
      extract: async () => shortSource,
      videoDurationSec: async () => 1000,
    }))
    expect(r.status).toBe('held')
    expect(r.reason).toContain('duration-mismatch')
  })

  it('ratio 在 [0.85, 1.15] 内 → installed(正常落盘)', async () => {
    // 208s 字幕 / 210s 视频 = 0.99(正常时轴)
    const src = ['1', '00:00:01,000 --> 00:03:28,000', 'Rose enters Pictor.', ''].join('\n')
    const r = await translateItem('/media/x.mkv', baseDeps({
      extract: async () => src,
      videoDurationSec: async () => 210,
    }))
    expect(r.status).toBe('installed')
  })

  it('videoDurationSec 返回 null(探针不可用)→ 跳过校验,installed(宁缺毋滥不阻塞)', async () => {
    const r = await translateItem('/media/x.mkv', baseDeps({
      videoDurationSec: async () => null,
    }))
    expect(r.status).toBe('installed')
  })

  it('未接 videoDurationSec → 不校验,行为与从前完全一致(向后兼容)', async () => {
    const r = await translateItem('/media/x.mkv', baseDeps())
    expect(r.status).toBe('installed')
  })
})
