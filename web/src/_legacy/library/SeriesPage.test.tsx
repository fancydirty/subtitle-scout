// web/src/library/SeriesPage.test.tsx：剧集页——渐变 hero + 事实栏 + 季手风琴逐集行内展开（详情页
// 重设计 item B：不再有右侧滑入面板）。三层格阵合成语义、覆盖句文案、layoutNonstandard 事实陈述、
// canonical 缓存未建提示、三态。SeriesPage 不自己发请求（Shell 把 useLibrarySeriesDetail 结果当
// prop 传下来，见 shell/AppShell.tsx），所以这里直接手搭 Async<LibrarySeriesDetailDTO> 喂给组件。
// 默认测试语言 en（jsdom navigator.language=en-US）——覆盖句大数字段在 en 下渲染为 "N of M"。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { SeriesPage } from './SeriesPage.js'
import type { Async } from '../../api/hooks.js'
import type { LibraryCanonicalEpisodeDTO, LibrarySeriesDetailDTO } from '../../api/types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function asyncData(data: LibrarySeriesDetailDTO): Async<LibrarySeriesDetailDTO> {
  return { data, loading: false, error: null, reload: vi.fn() }
}

function renderPage(detail: Async<LibrarySeriesDetailDTO>) {
  return render(
    <I18nProvider>
      <SeriesPage detail={detail} />
    </I18nProvider>,
  )
}

function baseSeries(overrides: Partial<LibrarySeriesDetailDTO['series']> = {}) {
  return {
    id: 'tmdb:1', name: 'Series A', chineseTitle: null, posterPath: null,
    overview: null, backdropPath: null, year: 2021,
    layoutNonstandard: false, ...overrides,
  }
}

/** canonical 富化字段默认 null——多数用例不关心 overview/airDate/stillPath，工厂省样板。 */
function canon(episode: number, over: Partial<LibraryCanonicalEpisodeDTO> = {}): LibraryCanonicalEpisodeDTO {
  return { episode, title: `E${episode}`, overview: null, airDate: null, stillPath: null, ...over }
}

describe('SeriesPage：三层合成渲染（行式）', () => {
  it('canonical 8 集 / 磁盘 6（4 covered + 2 missing）→ 8 行，4 covered 点，事实栏 4 / 8', async () => {
    const detail: LibrarySeriesDetailDTO = {
      series: baseSeries(),
      seasons: [
        {
          season: 1,
          canonical: Array.from({ length: 8 }, (_, i) => canon(i + 1)),
          onDisk: [
            { itemId: 'ep1', episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
            { itemId: 'ep2', episode: 2, path: '/m/e2.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
            { itemId: 'ep3', episode: 3, path: '/m/e3.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
            { itemId: 'ep4', episode: 4, path: '/m/e4.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
            { itemId: 'ep5', episode: 5, path: '/m/e5.mkv', subStatus: 'missing', statusReason: null, recheckAfter: null, files: [] },
            { itemId: 'ep6', episode: 6, path: '/m/e6.mkv', subStatus: 'missing', statusReason: null, recheckAfter: null, files: [] },
          ],
          coverage: [
            { episode: 1, lang: 'zh-Hans', path: '/m/e1.zh-Hans.ass' },
            { episode: 2, lang: 'zh-Hans', path: '/m/e2.zh-Hans.ass' },
            { episode: 3, lang: 'zh-Hans', path: '/m/e3.zh-Hans.ass' },
            { episode: 4, lang: 'zh-Hans', path: '/m/e4.zh-Hans.ass' },
          ],
        },
      ],
    }
    const { container } = renderPage(asyncData(detail))

    await screen.findByText('Series A')
    // ≤50 集 → 行式（EpisodeRow），非格阵：8 行，其中 4 集 covered 绿点。
    expect(container.querySelectorAll('.library-eprow-head')).toHaveLength(8)
    expect(container.querySelectorAll('.ep-cell')).toHaveLength(0)
    expect(container.querySelectorAll('.ep-dot-covered')).toHaveLength(4)
    // 跨季事实栏合计（FactsRail）：4 / 8 覆盖。
    expect(screen.getByText(/4 \/ 8/)).toBeInTheDocument()
  })
})

describe('SeriesPage：覆盖句文案（季手风琴头）', () => {
  it('24 of 28 episodes covered——大数字嵌句', async () => {
    const detail: LibrarySeriesDetailDTO = {
      series: baseSeries(),
      seasons: [
        {
          season: 1,
          canonical: Array.from({ length: 28 }, (_, i) => canon(i + 1, { title: null })),
          onDisk: Array.from({ length: 24 }, (_, i) => ({
            itemId: `ep${i + 1}`, episode: i + 1, path: `/m/e${i + 1}.mkv`, subStatus: 'covered', statusReason: null, recheckAfter: null, files: [],
          })),
          coverage: [],
        },
      ],
    }
    // 覆盖句"前缀 + 嵌句大数字 + 后缀"三段拼接（seasonCoverageSentence，见 library/text.ts），
    // 前后缀是裸文本节点，只有嵌句大数字有自己的 <Text as="span"> → 用 getByText 精确定位大数字，
    // 前后缀用 container.textContent 整体断言。事实栏用 " / " 分隔（"24 / 28"），覆盖句大数字段用
    // en 的 "24 of 28"——两者文本不同，findByText('24 of 28') 唯一命中覆盖句。
    const { container } = renderPage(asyncData(detail))

    expect(await screen.findByText('24 of 28')).toBeInTheDocument()
    expect(container.textContent).toContain('Season 1 has')
    expect(container.textContent).toContain('episodes covered')
  })
})

describe('SeriesPage：layoutNonstandard 事实陈述', () => {
  it('true 时渲染灰字事实（不是警报）', async () => {
    const detail: LibrarySeriesDetailDTO = {
      series: baseSeries({ layoutNonstandard: true }),
      seasons: [],
    }
    renderPage(asyncData(detail))
    expect(await screen.findByText('layout differs from TMDB canonical order')).toBeInTheDocument()
  })

  it('false 时不渲染', async () => {
    const detail: LibrarySeriesDetailDTO = { series: baseSeries(), seasons: [] }
    renderPage(asyncData(detail))
    await screen.findByText('Series A')
    expect(screen.queryByText('layout differs from TMDB canonical order')).not.toBeInTheDocument()
  })
})

describe('SeriesPage：canonical 缓存未建', () => {
  it('canonical 为空、磁盘有行 → 提示 + 行式只按磁盘行渲染', async () => {
    const detail: LibrarySeriesDetailDTO = {
      series: baseSeries(),
      seasons: [
        {
          season: 1,
          canonical: [],
          onDisk: [{ itemId: 'ep1', episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] }],
          coverage: [],
        },
      ],
    }
    const { container } = renderPage(asyncData(detail))
    expect(await screen.findByText('canonical catalog pending')).toBeInTheDocument()
    expect(container.querySelectorAll('.library-eprow-head')).toHaveLength(1)
    expect(container.querySelectorAll('.ep-cell')).toHaveLength(0)
  })
})

describe('SeriesPage：逐集行内展开（无右侧面板）', () => {
  it('点击某集 → 行内展开该集 TMDB 简介（无右侧面板）', async () => {
    const detail: LibrarySeriesDetailDTO = {
      series: baseSeries(),
      seasons: [
        {
          season: 1,
          canonical: [canon(1, { title: 'Pilot', overview: '哈蒙一家搬进凶宅', airDate: '2011-10-05' })],
          onDisk: [{ itemId: 'ep1', episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] }],
          coverage: [],
        },
      ],
    }
    renderPage(asyncData(detail))
    // 单季默认展开 → 行立即可见；点击行头行内展开该集简介。
    fireEvent.click(await screen.findByRole('button', { name: /Pilot/ }))
    expect(screen.getByText('哈蒙一家搬进凶宅')).toBeInTheDocument()
    // 详情页重设计 item B：旧右侧滑入面板（role=dialog）已彻底移除。
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('SeriesPage：三态', () => {
  it('loading 不炸、不显示正文', () => {
    render(
      <I18nProvider>
        <SeriesPage detail={{ data: null, loading: true, error: null, reload: vi.fn() }} />
      </I18nProvider>,
    )
    expect(screen.queryByText('Series A')).not.toBeInTheDocument()
  })

  it('404 → 未找到态（真实 payload：后端 404 body {error:"not found"} → client 返回 "not found"）', async () => {
    // 生产真相：router.ts 的 series-detail 404 返回 {error:'not found'}，client.ts errorMessage 对
    // 4xx 优先取 body.error → 错误串就是 'not found'（不是合成的 '… → 404'）。此前 isNotFoundError
    // 只认 '→ 404'，导致真 404 落进"错误 + 重试"死循环，友好未找到态是死代码（dashboard 审计 #1）。
    render(
      <I18nProvider>
        <SeriesPage detail={{ data: null, loading: false, error: 'not found', reload: vi.fn() }} />
      </I18nProvider>,
    )
    expect(await screen.findByText('Series not found')).toBeInTheDocument()
  })

  it('404 非 JSON body 的兜底形态（"… → 404"）仍判未找到', async () => {
    render(
      <I18nProvider>
        <SeriesPage detail={{ data: null, loading: false, error: '/api/v2/library/series/tmdb:9 → 404', reload: vi.fn() }} />
      </I18nProvider>,
    )
    expect(await screen.findByText('Series not found')).toBeInTheDocument()
  })

  it('其它错误 → 错误态 + 重试', async () => {
    const reload = vi.fn()
    render(
      <I18nProvider>
        <SeriesPage detail={{ data: null, loading: false, error: 'network down', reload }} />
      </I18nProvider>,
    )
    const btn = await screen.findByRole('button', { name: 'Retry' })
    fireEvent.click(btn)
    expect(reload).toHaveBeenCalled()
  })
})

// ── DOM 侧迁移锁（Task 20）——只锁本组件自己那层；SeasonAccordion 子树的 astryx 归 Task 21 收口。
describe('SeriesPage：DOM 侧迁移锁', () => {
  it('未找到态用新栈 EmptyState（无 astryx），错误态重试按钮是 children 版 Button', async () => {
    const { container, rerender } = render(
      <I18nProvider>
        <SeriesPage detail={{ data: null, loading: false, error: 'not found', reload: vi.fn() }} />
      </I18nProvider>,
    )
    // 未找到态整棵子树只有新栈 EmptyState，没有 SeasonAccordion，可以安全查全树无 astryx。
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    expect(await screen.findByText('Series not found')).toBeInTheDocument()
    // 错误态：Button 用 children 渲染文案（Astryx 是 label prop），可访问名仍是 Retry。
    rerender(
      <I18nProvider>
        <SeriesPage detail={{ data: null, loading: false, error: 'network down', reload: vi.fn() }} />
      </I18nProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
    // Task 20 评审遗留（Task 21 收口补）：error 分支不渲染 SeasonAccordion，全树无 astryx 安全——
    // 有它，Retry 按钮 children 形的 pin 才真正可判别（Astryx 的 label prop 也出同一个可及名）。
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
  })

  // Task 20 评审遗留（Task 21 收口补）：SeasonAccordion 子树已干净，完整 detail 全树锁成立。
  // 用例不得点开任何面板——点开红芯片会渲染 Astryx 的 InspectPanel（Task 30 才迁）。
  it('完整 detail（不点开任何面板）→ 全树无 astryx-* 类名', async () => {
    const detail: LibrarySeriesDetailDTO = {
      series: baseSeries(),
      seasons: [
        {
          season: 1,
          canonical: Array.from({ length: 3 }, (_, i) => canon(i + 1)),
          onDisk: [
            { itemId: 'ep1', episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
          ],
          coverage: [],
        },
      ],
    }
    const { container } = renderPage(asyncData(detail))
    await screen.findByText('Series A')
    // 季手风琴子树确实渲染出来了（锁才有意义——不是对着空树查无 astryx）。
    expect(container.querySelectorAll('.library-eprow-head').length).toBeGreaterThan(0)
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
  })
})
