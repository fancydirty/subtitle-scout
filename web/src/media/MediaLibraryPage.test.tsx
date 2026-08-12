// web/src/media/MediaLibraryPage.test.tsx：海报墙列表——R-F2 的呈现、R-F5 的应有集读数、
// 三态齐（loading/error/empty）。
//
// ── R-F2 在这一屏怎么测 ────────────────────────────────────────────────────
// 「不管来源、按 work_id 合并、任一份有字幕就算已获取」这条**判据在后端**
// （buildMediaLibrary 的 `.some()`），前端的责任是**如实呈现后端的合并结果，且不再自己算**。
// 所以这里的用例分两类：
//   ① 后端给一行 work（两个目录已合并）→ 前端只画一张卡（不按目录/来源拆开）；
//   ② `subtitledEpisodeCount` **原样呈现**，不与 onDisk 做任何再运算——
//      前端做第二遍聚合就是把 R-F2 的判据复制一份到浏览器里（C30 的原型）。
// 用例②的形态是：给一组"任何本地重算都会算错"的数字（subtitled > onDisk 是不可能的，
// 但 subtitled=5/onDisk=5/expected=12 下，若有人把已配写成 `onDisk - missing` 就会错）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { MediaLibraryPage, coverageParts } from './MediaLibraryPage.js'
import { en } from '../i18n/en.js'
import type { MediaLibraryItemDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function item(o: Partial<MediaLibraryItemDTO> = {}): MediaLibraryItemDTO {
  return {
    workId: 'tmdb:1396', title: 'Breaking Bad', chineseTitle: null, year: 2008,
    posterPath: null, mediaType: 'tv',
    expectedEpisodeCount: 62, onDiskEpisodeCount: 30, missingEpisodeCount: 32,
    subtitledEpisodeCount: 12,
    ...o,
  }
}

function mockFetch(body: unknown, ok = true) {
  // 形参必须显式声明：不声明的话 vi.fn 推出的 calls 类型是 `[]`，`c[0]` 在 tsc 下报
  // TS2493（vitest 不查类型，只有两个 tsc 会抓到）——而下面那条端点断言正是靠 c[0] 取 URL。
  return vi.fn(async (_input: RequestInfo | URL) =>
    ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response)
}

function renderPage() {
  return render(<I18nProvider initialLang="en"><MediaLibraryPage /></I18nProvider>)
}

// ═══ R-F2 ════════════════════════════════════════════════════════════════════
describe('R-F2「不管来源，按 work_id 合并」在 UI 上是什么', () => {
  it('后端合并后的一行 work → **一张卡**（不按来源/目录拆成两张）', async () => {
    // 两个「绝命毒师」目录的 4 个文件，后端已合并成一行 work（fileCount 之类的细节
    // 在详情页；列表页看到的就是"一部剧一张卡"）。
    vi.stubGlobal('fetch', mockFetch([item({ onDiskEpisodeCount: 2, subtitledEpisodeCount: 1 })]))
    renderPage()
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1))
    // 结果计数也说 1 —— 若有谁按文件数计数，这里会报 4。
    expect(screen.getByText(new RegExp(`${en.media_result_count_prefix} 1`))).toBeInTheDocument()
  })

  it('卡片链接指向 **workId**（R-F2 的合并键，也是详情页的 id）', async () => {
    vi.stubGlobal('fetch', mockFetch([item({ workId: 'tmdb:1396' })]))
    renderPage()
    const link = await screen.findByRole('link')
    // 冒号被 encodeURIComponent 编码；不编码的话 id 空间将来出现需转义字符会静默 404。
    expect(link.getAttribute('href')).toBe('#/media/tmdb%3A1396')
  })

  it('已获取集数**原样呈现后端的 subtitledEpisodeCount**，前端不做第二遍聚合', async () => {
    // 这组数字下，几种"顺手自己算"的写法都会得出别的值：
    //   onDisk - missing = 30-32 = -2 ；expected - missing = 62-32 = 30 ；都不是 12。
    vi.stubGlobal('fetch', mockFetch([item({
      expectedEpisodeCount: 62, onDiskEpisodeCount: 30, missingEpisodeCount: 32,
      subtitledEpisodeCount: 12,
    })]))
    renderPage()
    const link = await screen.findByRole('link')
    const line = within(link).getByText(new RegExp(en.media_card_subtitled))
    expect(line.textContent).toContain(`${en.media_card_subtitled} 12`)
    expect(line.textContent).toContain(`${en.media_card_ondisk} 30`)
  })

  it('coverageParts 是纯映射——三个数字逐字取自 DTO，不含任何算术', () => {
    const p = coverageParts(item({
      subtitledEpisodeCount: 7, onDiskEpisodeCount: 9, expectedEpisodeCount: 24,
      missingEpisodeCount: 15,
    }))
    expect(p).toEqual({ subtitled: 7, onDisk: 9, expected: 24, missing: 15 })
  })
})

// ═══ 🟡-3 缺集数 ═════════════════════════════════════════════════════════════
// `missingEpisodeCount` 后端算了、DTO 声明了，而在本次改动之前**只在测试 fixture 里
// 出现过**——终局审计变异 `missingEpisodeCount: 0` → 前端 0 红。下面这组是它的守卫。
describe('🟡-3 missingEpisodeCount 真的被读了（变异恒 0 → 本组必红）', () => {
  it('🔴 missing>0 → 卡片上显示"缺 N"', async () => {
    vi.stubGlobal('fetch', mockFetch([item({ missingEpisodeCount: 32 })]))
    renderPage()
    const link = await screen.findByRole('link')
    const line = within(link).getByTestId('media-card-missing')
    expect(line.textContent).toContain(`${en.media_card_missing} 32`)
  })

  // 🔴 这一条是"前端别自己算"的判据：给一组任何本地重算都会得出别的值的数字。
  it('🔴 **原样取 DTO**，不在浏览器里算 expected - onDisk', async () => {
    // expected-onDisk = 62-30 = 32，而后端给的是 7（比如应有集缓存刚回填了一部分）。
    // 任何"顺手自己算"的写法都会显示 32——那就是把后端的夹 0 判据复制了第二份。
    vi.stubGlobal('fetch', mockFetch([item({
      expectedEpisodeCount: 62, onDiskEpisodeCount: 30, missingEpisodeCount: 7,
    })]))
    renderPage()
    const link = await screen.findByRole('link')
    const line = within(link).getByTestId('media-card-missing')
    expect(line.textContent).toContain(`${en.media_card_missing} 7`)
    expect(line.textContent).not.toContain('32')
  })

  it('🔴 missing=0（齐全）→ **整段不在场**（沉默即好消息，不显示"缺 0"）', async () => {
    vi.stubGlobal('fetch', mockFetch([item({
      expectedEpisodeCount: 62, onDiskEpisodeCount: 62, missingEpisodeCount: 0,
    })]))
    renderPage()
    const link = await screen.findByRole('link')
    expect(within(link).queryByTestId('media-card-missing')).toBeNull()
    expect(link.textContent).not.toContain(`${en.media_card_missing} 0`)
  })

  it('电影（missing 恒 0）不显示这一段', async () => {
    vi.stubGlobal('fetch', mockFetch([item({
      mediaType: 'movie', expectedEpisodeCount: 0, onDiskEpisodeCount: 1,
      missingEpisodeCount: 0, subtitledEpisodeCount: 1,
    })]))
    renderPage()
    const link = await screen.findByRole('link')
    expect(within(link).queryByTestId('media-card-missing')).toBeNull()
  })

  it('🔴 应有集未回填（expected=0）→ 后端夹 0 给 missing=0 → 不显示（与"绝口不提应有集"一致）', () => {
    // 这一支不需要额外的前端条件：后端的 Math.max(0, …) 已经把它折成 0 了。
    // 在前端再写一次 `expected>0 &&` 就是第三份判据（后端一份、coverageParts 一份）。
    expect(coverageParts(item({ expectedEpisodeCount: 0, missingEpisodeCount: 0 })).missing).toBeNull()
  })

  it('coverageParts 对 missing=0 给 null，>0 原样给', () => {
    expect(coverageParts(item({ missingEpisodeCount: 0 })).missing).toBeNull()
    expect(coverageParts(item({ missingEpisodeCount: 1 })).missing).toBe(1)
  })
})

// ═══ R-F5 ════════════════════════════════════════════════════════════════════
describe('R-F5 应有集：expected=0 的两种含义都不许显示 "N/0"', () => {
  it('剧集 expected>0 → 显示"应有 N"那一段', async () => {
    vi.stubGlobal('fetch', mockFetch([item({ expectedEpisodeCount: 62 })]))
    renderPage()
    const link = await screen.findByRole('link')
    expect(within(link).getByText(new RegExp(`${en.media_card_expected} 62`))).toBeInTheDocument()
  })

  it('剧集 expected=0（应有集缓存还没回填）→ **绝口不提应有集**，只报磁盘数', async () => {
    // "应有 0" 会让用户以为这部剧应该有 0 集——那是一个我们并不知道的数字。
    vi.stubGlobal('fetch', mockFetch([item({ expectedEpisodeCount: 0, onDiskEpisodeCount: 12 })]))
    renderPage()
    const link = await screen.findByRole('link')
    expect(within(link).queryByText(new RegExp(en.media_card_expected))).toBeNull()
    expect(within(link).getByText(new RegExp(`${en.media_card_ondisk} 12`))).toBeInTheDocument()
  })

  it('电影（expected 恒 0）同样不显示"应有"那一段', async () => {
    vi.stubGlobal('fetch', mockFetch([item({
      mediaType: 'movie', expectedEpisodeCount: 0, onDiskEpisodeCount: 1, subtitledEpisodeCount: 1,
    })]))
    renderPage()
    const link = await screen.findByRole('link')
    expect(within(link).queryByText(new RegExp(en.media_card_expected))).toBeNull()
  })

  it('coverageParts 对 expected=0 给 null（调用方据此不渲染那一段）', () => {
    expect(coverageParts(item({ expectedEpisodeCount: 0 })).expected).toBeNull()
    expect(coverageParts(item({ expectedEpisodeCount: 1 })).expected).toBe(1)
  })
})

// ═══ 三态 + 标题 ══════════════════════════════════════════════════════════════
describe('三态齐 + 标题回落', () => {
  it('loading → 骨架屏，不白屏不转圈（§4.4）', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderPage()
    expect(screen.getByLabelText('loading media library')).toBeInTheDocument()
  })

  it('空库 → 空态文案（库确实空的事实）', async () => {
    vi.stubGlobal('fetch', mockFetch([]))
    renderPage()
    expect(await screen.findByText(en.media_empty_title)).toBeInTheDocument()
  })

  it('请求失败 → 错误态 + 重试按钮，**绝不显示空态文案**（§4.4：那是谎报）', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'db locked' }, false))
    renderPage()
    expect(await screen.findByText(en.media_error_title)).toBeInTheDocument()
    // 后端的人话消息如实透出（client.ts 的既有 {error} 抽取）
    expect(screen.getByText(/db locked/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.media_retry })).toBeInTheDocument()
    // 这一条是判据：错误态与空态混淆 = 把"我没能问到"说成"库里没东西"
    expect(screen.queryByText(en.media_empty_title)).toBeNull()
  })

  it('重试按钮真的重发请求（不是一个画着好看的死按钮）', async () => {
    const f = mockFetch({ error: 'boom' }, false)
    vi.stubGlobal('fetch', f)
    renderPage()
    const btn = await screen.findByRole('button', { name: en.media_retry })
    const before = f.mock.calls.length
    btn.click()
    await waitFor(() => expect(f.mock.calls.length).toBeGreaterThan(before))
  })

  it('中文名优先于原名；没有中文名时回落原名', async () => {
    vi.stubGlobal('fetch', mockFetch([
      item({ workId: 'a', chineseTitle: '绝命毒师', title: 'Breaking Bad' }),
      item({ workId: 'b', chineseTitle: null, title: 'Chernobyl' }),
    ]))
    renderPage()
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(2))
    expect(screen.getByRole('link', { name: '绝命毒师' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Chernobyl' })).toBeInTheDocument()
  })

  it('无 posterPath → 首字母占位（§4.4 点名：这是必然分支，不是边缘兜底）', async () => {
    vi.stubGlobal('fetch', mockFetch([item({ posterPath: null, title: 'Chernobyl', chineseTitle: null })]))
    const { container } = renderPage()
    await screen.findByRole('link')
    expect(container.querySelector('.media-poster-fallback')?.textContent).toBe('C')
    expect(container.querySelector('img')).toBeNull()
  })

  it('打的是 /api/v2/mediaLibrary（新端点），**不是**旧的 /api/v2/library', async () => {
    const f = mockFetch([])
    vi.stubGlobal('fetch', f)
    renderPage()
    await screen.findByText(en.media_empty_title)
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/api/v2/mediaLibrary'))).toBe(true)
    // 旧端点长在 series/episodes 表上（生产 series 0 行），打它等于永远空库。
    expect(urls.some((u) => /\/api\/v2\/library(\?|$)/.test(u))).toBe(false)
  })
})
