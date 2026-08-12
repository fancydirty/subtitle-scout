// web/src/media/shellWiring.test.tsx：**Shell 层**的媒体库接线守卫。
//
// ── 这个文件为什么存在（变异 M22 抓到的洞）─────────────────────────────────
// 变异实测：把 AppShell 的
//     route.mediaWorkId ? <MediaDetailPage …/> : <MediaLibraryPage />
// 改成恒渲染 `<MediaLibraryPage />`（详情路由永远打不开），**162 条测试 0 红**。
// 组件级测试全在测组件自己（给它一个 detail prop 它就渲染），路由测试全在测
// parseShellHash（hash 解析对了），**中间那条"Shell 拿解析结果去选组件"的接线没有任何
// 人钉着**——这正是 AppShell.nav.test.tsx 头注释里说的那类静默失效，只是它守的是
// 一级 tab，二级路由是新出现的形态。
//
// 判据必须是**运行时**的：渲染整个 Shell、真的把 hash 切到 #/media/:id、看主区渲染的是
// 哪一页，并数**真实发出的请求**（详情页会打 /api/v2/mediaLibrary/:id，列表页不会）。
// 源码级断言（grep AppShell.tsx 里有没有 MediaDetailPage）会被 Task ⑤ 那种行尾注释骗过去。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { Shell } from '../shell/AppShell.js'
import { en } from '../i18n/en.js'

const DETAIL = {
  work: { workId: 'tmdb:1396', title: 'Breaking Bad', chineseTitle: null, year: 2008,
          posterPath: null, mediaType: 'tv' as const },
  seasons: [{
    season: 1,
    episodes: [
      { episode: 1, title: null, onDisk: true, dot: 'green' as const,
        episodeState: 'covered' as const, fileCount: 1, subtitledFileCount: 1 },
      { episode: 2, title: null, onDisk: false, dot: 'none' as const,
        episodeState: 'absent' as const, fileCount: 0, subtitledFileCount: 0 },
    ],
  }],
  movie: null,
  unplacedFileCount: 0,
}

/** 记录每个 URL 被打了几次——"详情页有没有真的挂上"的判据是请求，不是 DOM 文案。 */
let urls: string[] = []

function mockFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    const path = url.split('?')[0] ?? ''
    const body: unknown =
      url.includes('/api/v2/setup/status')
        ? { initialized: true, engineEnabled: true,
            providers: { subhd: { enabled: false }, zimuku: { enabled: false },
                         opensubtitles: { enabled: false }, jimaku: { enabled: false } },
            secrets: {} }
      : /\/api\/v2\/mediaLibrary$/.test(path) ? [
          { workId: 'tmdb:1396', title: 'Breaking Bad', chineseTitle: null, year: 2008,
            posterPath: null, mediaType: 'tv', expectedEpisodeCount: 62,
            onDiskEpisodeCount: 30, missingEpisodeCount: 32, subtitledEpisodeCount: 12 },
        ]
      : path.includes('/api/v2/mediaLibrary/') ? DETAIL
      : url.includes('/workflow/pending')
        ? { meta: { roots: [], lastScanAt: null, files: 0, lastVerifySweepAt: null,
                    verifiedItems: 0, verifiableItems: 0 }, parked: 0 }
      : url.includes('/api/v2/library') ? []
      : {}
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
}

beforeEach(() => { urls = []; vi.stubGlobal('fetch', mockFetch()); location.hash = '' })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); location.hash = '' })

const renderShell = () => render(<I18nProvider initialLang="en"><Shell /></I18nProvider>)

describe('Shell 接线：#/media 与 #/media/:workId 渲染的是两个不同的页面', () => {
  it('#/media → 列表页（海报卡），**不打**详情端点', async () => {
    location.hash = '#/media'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByRole('link', { name: 'Breaking Bad' })).toBeInTheDocument()
    })
    expect(urls.some((u) => /\/api\/v2\/mediaLibrary\/.+/.test(u.split('?')[0] ?? ''))).toBe(false)
  })

  // 🔴 M22 那个洞就在这里：改成恒渲染列表页时，这一条必红。
  it('#/media/:workId → 详情页（季集网格 + 图例），**真的打了详情端点**', async () => {
    location.hash = '#/media/tmdb%3A1396'
    renderShell()
    const main = await screen.findByRole('main')
    await waitFor(() => {
      expect(within(main).getByLabelText(en.media_legend_label)).toBeInTheDocument()
    })
    // 请求探针：详情端点被打到，且 id 正确编码
    expect(urls.some((u) => u.includes('/api/v2/mediaLibrary/tmdb%3A1396'))).toBe(true)
    // 网格里两格：E01 实线 covered、E02 虚线 absent
    const cells = within(main).getAllByRole('listitem')
    expect(cells).toHaveLength(2)
    expect(cells[0]!.getAttribute('data-ondisk')).toBe('true')
    expect(cells[1]!.getAttribute('data-ondisk')).toBe('false')
    // 列表页的标志物（结果计数）绝不该在场——它在场说明渲染的是列表页
    expect(within(main).queryByText(new RegExp(`${en.media_result_count_prefix} \\d`))).toBeNull()
  })

  it('两个路由的主区内容互不相同（渲染成同一个组件时红）', async () => {
    const texts: string[] = []
    for (const hash of ['#/media', '#/media/tmdb%3A1396']) {
      location.hash = hash
      renderShell()
      const main = await screen.findByRole('main')
      await waitFor(() => expect((main.textContent ?? '').trim().length).toBeGreaterThan(0))
      texts.push((main.textContent ?? '').trim())
      cleanup()
    }
    expect(new Set(texts).size).toBe(2)
  })

  it('侧栏高亮仍是 media（二级路由不改变当前 tab）', async () => {
    location.hash = '#/media/tmdb%3A1396'
    renderShell()
    // ⚠️ 页面上有两个 navigation（Topbar 的面包屑 aria-label="Breadcrumb" + 侧栏）。
    // getByRole('navigation') 会因多重命中而抛——按侧栏那个链接直接查更稳，
    // 且判据本身就是"那个链接带 aria-current"。
    const link = await screen.findByRole('link', { name: en.nav_media })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  it('详情页的返回链接指回 #/media（不是旧的 #/library）', async () => {
    location.hash = '#/media/tmdb%3A1396'
    renderShell()
    const main = await screen.findByRole('main')
    const back = await within(main).findByRole('link', { name: en.media_back })
    expect(back).toHaveAttribute('href', '#/media')
  })

  it('列表卡片的链接真的能进详情（href 与路由解析闭环）', async () => {
    location.hash = '#/media'
    renderShell()
    const main = await screen.findByRole('main')
    const card = await within(main).findByRole('link', { name: 'Breaking Bad' })
    expect(card).toHaveAttribute('href', '#/media/tmdb%3A1396')
  })
})
