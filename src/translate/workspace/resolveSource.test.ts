import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { resolveTranslateSource, type ResolveSourceDeps } from './resolveSource.js'

function baseDeps(over: Partial<ResolveSourceDeps> = {}): ResolveSourceDeps {
  return {
    probe: async () => [],
    extract: async () => null,
    fetchSourceSub: async () => null,
    ...over,
  }
}

describe('resolveTranslateSource — origin-lang single-hop', () => {
  // R18 红线用例(废止 2026-07-24 的 eng 兜底裁决)。断言不止看 status:extract 必须一次都没被调用,
  // 否则"抽了英轨但最后返回 no-source"这种半途而废也能骗过 status 断言。
  it('R18 红线:origin=ja + 只有 eng 内嵌轨 → no-source,且绝不抽英轨', async () => {
    const extract = vi.fn(async () => '1\n00:00:01,000 --> 00:00:02,000\nHello\n')
    const r = await resolveTranslateSource({
      originLang: 'ja',
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'eng', codec: 'ass', isImageBased: false }],
        extract,
      }),
    })
    expect(r.status).toBe('no-source')
    expect(extract).not.toHaveBeenCalled()
    expect(JSON.stringify(r)).not.toMatch(/fallback:/)
  })

  it('origin=ja with neither ja nor eng → no-source,reason 不再提英文兜底', async () => {
    const r = await resolveTranslateSource({
      originLang: 'ja',
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'spa', codec: 'ass', isImageBased: false }],
      }),
    })
    expect(r.status).toBe('no-source')
    if (r.status === 'no-source') {
      expect(r.reason).not.toMatch(/fallback|兜底/i)
      expect(r.reason).toMatch(/ja/)
    }
  })

  it('正路 1:origin=ja with jpn embedded text track → embedded source', async () => {
    const r = await resolveTranslateSource({
      originLang: 'ja',
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [
          { lang: 'eng', codec: 'ass', isImageBased: false },
          { lang: 'jpn', codec: 'ass', isImageBased: false },
        ],
        extract: async (_vp, idx) => (idx === 1 ? '1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n' : null),
      }),
    })
    expect(r).toMatchObject({ status: 'ok', sourceRef: 'embedded:s:1', sourceLangName: '日文' })
    if (r.status === 'ok') expect(r.srtText).toContain('こんにちは')
  })

  it('正路 2:origin=ja 无 ja 轨但 fetchSourceSub 抓到日文源 → ok', async () => {
    const r = await resolveTranslateSource({
      originLang: 'ja',
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'eng', codec: 'ass', isImageBased: false }],
        fetchSourceSub: async () => ({ srtText: '1\n00:00:01,000 --> 00:00:02,000\n日\n', sourceRef: 'jimaku:1' }),
      }),
    })
    expect(r).toMatchObject({ status: 'ok', sourceRef: 'jimaku:1', sourceLangName: '日文' })
  })

  // C17 后半:origin 空 = TMDB 未刮到 original_language,是"完全未经证实",不是"英语"。
  it('C17:origin 空 + 有 en 内嵌轨 → no-source(不许把未知当英语臆断)', async () => {
    const extract = vi.fn(async () => '1\n00:00:01,000 --> 00:00:02,000\nHello\n')
    const r = await resolveTranslateSource({
      originLang: null,
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
        extract,
      }),
    })
    expect(r.status).toBe('no-source')
    expect(extract).not.toHaveBeenCalled()
  })

  it('origin 空(空白字符串)+ 无任何轨 → no-source', async () => {
    const r = await resolveTranslateSource({
      originLang: '   ',
      videoPath: '/m/x.mkv',
      deps: baseDeps({ probe: async () => [] }),
    })
    expect(r.status).toBe('no-source')
  })

  it('origin 空 + 只有 ja 内嵌轨 → no-source (no honest language guess)', async () => {
    const r = await resolveTranslateSource({
      originLang: null,
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'jpn', codec: 'ass', isImageBased: false }],
      }),
    })
    expect(r.status).toBe('no-source')
  })

  it('origin 空 + fetchSourceSub 有货 → 仍 no-source(不许拿未证实语言去抓外源)', async () => {
    const fetchSourceSub = vi.fn(async () => ({ srtText: 'x', sourceRef: 'opensubtitles:9' }))
    const r = await resolveTranslateSource({
      originLang: '',
      videoPath: '/m/x.mkv',
      deps: baseDeps({ probe: async () => [], fetchSourceSub }),
    })
    expect(r.status).toBe('no-source')
    expect(fetchSourceSub).not.toHaveBeenCalled()
  })

  it('英语正路:origin=en with eng embedded → eng', async () => {
    const r = await resolveTranslateSource({
      originLang: 'en',
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
        extract: async () => '1\n00:00:01,000 --> 00:00:02,000\nHello\n',
      }),
    })
    expect(r).toMatchObject({ status: 'ok', sourceRef: 'embedded:s:0', sourceLangName: '英文' })
  })

  it('英语正路:origin=en 无内嵌轨但可抓外源 → ok(R20 外挂抓取仅 en)', async () => {
    const r = await resolveTranslateSource({
      originLang: 'en',
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [],
        fetchSourceSub: async () => ({ srtText: 'Hello', sourceRef: 'opensubtitles:7' }),
      }),
    })
    expect(r).toMatchObject({ status: 'ok', sourceRef: 'opensubtitles:7', sourceLangName: '英文' })
  })

  // R18 的结构性断言:兜底一旦被重新引入,sourceRef 的 'fallback:' 前缀是它唯一的物理痕迹。
  // 这条盯住实现文件本身,防止有人在别的分支上重造一个新的兜底出口。
  it('R18:resolveSource.ts 里不再存在任何 fallback: sourceRef 前缀', () => {
    const src = readFileSync(new URL('./resolveSource.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/`fallback:/)
    expect(src).not.toMatch(/'fallback:/)
  })

  it('probe 返回 null → probe-failed(不因 origin 分支变动而漏)', async () => {
    const r = await resolveTranslateSource({
      originLang: 'ja',
      videoPath: '/m/x.mkv',
      deps: baseDeps({ probe: async () => null }),
    })
    expect(r.status).toBe('probe-failed')
  })
})
