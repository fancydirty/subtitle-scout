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
