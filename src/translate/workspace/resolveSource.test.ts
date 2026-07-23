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
  it('origin=ja with only eng embedded → no-source (never eng)', async () => {
    const extract = vi.fn(async () => 'should-not-run')
    const r = await resolveTranslateSource({
      originLang: 'ja',
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'eng', codec: 'ass', isImageBased: false }],
        extract,
      }),
    })
    expect(r).toEqual({ status: 'no-source', reason: expect.stringMatching(/ja|japanese|日/i) })
    expect(extract).not.toHaveBeenCalled()
  })

  it('origin=ja with jpn embedded text track → embedded source', async () => {
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
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.sourceRef).toMatch(/embedded/)
      expect(r.srtText).toContain('こんにちは')
      expect(r.sourceLangName).toBe('日文')
    }
  })

  it('origin=en with eng embedded → eng', async () => {
    const r = await resolveTranslateSource({
      originLang: 'en',
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
        extract: async () => '1\n00:00:01,000 --> 00:00:02,000\nHello\n',
      }),
    })
    expect(r.status).toBe('ok')
    if (r.status === 'ok') {
      expect(r.sourceLangName).toBe('英文')
      expect(r.srtText).toContain('Hello')
    }
  })

  it('origin empty with en embedded → treated as en (legacy parity)', async () => {
    const r = await resolveTranslateSource({
      originLang: null,
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
        extract: async () => '1\n00:00:01,000 --> 00:00:02,000\nHello\n',
      }),
    })
    expect(r).toMatchObject({ status: 'ok', sourceLangName: '英文' })
  })

  it('origin empty with only ja embedded → no-source (no honest language guess)', async () => {
    const r = await resolveTranslateSource({
      originLang: null,
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [{ lang: 'jpn', codec: 'ass', isImageBased: false }],
      }),
    })
    expect(r.status).toBe('no-source')
  })

  it('origin=ja with no embedded ja but fetch returns ja → ok with sourceRef', async () => {
    const r = await resolveTranslateSource({
      originLang: 'ja',
      videoPath: '/m/x.mkv',
      deps: baseDeps({
        probe: async () => [],
        fetchSourceSub: async () => ({ srtText: '1\n00:00:01,000 --> 00:00:02,000\n日\n', sourceRef: 'jimaku:1' }),
      }),
    })
    expect(r).toMatchObject({ status: 'ok', sourceRef: 'jimaku:1', sourceLangName: '日文' })
  })
})
