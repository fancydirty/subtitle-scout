import { describe, it, expect } from 'vitest'
import { makeR3subAdapter } from './r3subAdapter.js'
import type { R3subSearchRow, R3subShow } from '../providers/r3sub.js'

/** fake client：只需 search/detail（下载走 tools 层旁路，adapter 不碰）。 */
function fakeClient(rows: R3subSearchRow[], show?: R3subShow) {
  return {
    async search() { return rows },
    async detail() { return show ?? { zipName: '', files: [] } },
  }
}

const ROW: R3subSearchRow = {
  id: 'S8g2H021493', titleCn: '沙丘：第二部', titleEn: 'Dune: Part Two', year: 2024,
  source: 'iTunes官方', langMark: '繁 粵 日 韓', subtype: 'SRT', sizeText: '135KB', downloads: 2953,
}

describe('makeR3subAdapter', () => {
  it('name==="r3sub"', () => {
    expect(makeR3subAdapter(fakeClient([])).name).toBe('r3sub')
  })

  it('enabled：languages 含 zh 系为 true，纯 en 为 false（中文源门控）', () => {
    const a = makeR3subAdapter(fakeClient([]))
    expect(a.enabled({ queries: [], languages: ['zh-cn'] }, {} as NodeJS.ProcessEnv)).toBe(true)
    expect(a.enabled({ queries: [], languages: ['cmn'] }, {} as NodeJS.ProcessEnv)).toBe(true)
    expect(a.enabled({ queries: [], languages: ['en'] }, {} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('search 映射 candidate（provider/providerId/nativeName/language/releaseSite 等）', async () => {
    const a = makeR3subAdapter(fakeClient([ROW], { zipName: 'Dune.zip', files: ['a.cmn-Hant.srt', 'a.ja.srt'] }))
    const cands = await a.search({ queries: ['沙丘'], languages: ['zh'] }, () => {})
    expect(cands.length).toBe(1)
    const c = cands[0]
    expect(c.provider).toBe('r3sub')
    expect(c.providerId).toBe('S8g2H021493')
    expect(c.nativeName).toBe('沙丘：第二部')
    expect(c.videoName).toBe('Dune: Part Two')
    expect(c.language).toBe('繁 粵 日 韓')
    expect(c.releaseSite).toBe('iTunes官方')
    expect(c.subtype).toBe('SRT')
    // ≤3 条命中 → 懒加载 fileList（详情的 files 被填进 fileList）
    expect(c.fileList.length).toBe(2)
    expect(c.fileList.map(f => f.name)).toContain('a.cmn-Hant.srt')
  })

  it('search 命中 >3 条 → 不逐条取详情，fileList 留空（控请求量）', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ...ROW, id: `id${i}` }))
    let detailCalls = 0
    const client = {
      async search() { return rows },
      async detail() { detailCalls++; return { zipName: '', files: ['x.srt'] } },
    }
    const cands = await makeR3subAdapter(client).search({ queries: ['x'], languages: ['zh'] }, () => {})
    expect(cands.length).toBe(5)
    expect(detailCalls).toBe(0)
    expect(cands.every(c => c.fileList.length === 0)).toBe(true)
  })

  it('resolve 抛错——r3sub 下载走 tools 层旁路，不经 runResolve', async () => {
    const a = makeR3subAdapter(fakeClient([]))
    await expect(a.resolve({ provider: 'r3sub', providerId: 'x', fileIndex: null }, () => {}))
      .rejects.toThrow(/旁路|tools|bypass/i)
  })
})
