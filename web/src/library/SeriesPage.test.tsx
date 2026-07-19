// web/src/library/SeriesPage.test.tsx：剧集页——三层格阵合成渲染、详情板开合（点击/esc）、
// 覆盖句文案、layoutNonstandard 事实陈述、canonical 缓存未建提示。SeriesPage 不自己发请求
// （Shell 把 useLibrarySeriesDetail 的结果当 prop 传下来，见 shell/AppShell.tsx），所以这里
// 直接手搭 Async<LibrarySeriesDetailDTO> 对象喂给组件，不需要 mock fetch。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SeriesPage } from './SeriesPage.js'
import type { Async } from '../api/hooks.js'
import type { LibrarySeriesDetailDTO } from '../api/types.js'

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
    id: 'tmdb:1', name: 'Series A', chineseTitle: null, posterPath: null, year: 2021,
    layoutNonstandard: false, ...overrides,
  }
}

describe('SeriesPage：三层合成渲染', () => {
  it('canonical 8 集 / 磁盘 6（4 covered + 2 missing）→ 8 格，2 dashed，4 绿点，2 灰', async () => {
    const detail: LibrarySeriesDetailDTO = {
      series: baseSeries(),
      seasons: [
        {
          season: 1,
          canonical: Array.from({ length: 8 }, (_, i) => ({ episode: i + 1, title: `E${i + 1}` })),
          onDisk: [
            { episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
            { episode: 2, path: '/m/e2.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
            { episode: 3, path: '/m/e3.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
            { episode: 4, path: '/m/e4.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
            { episode: 5, path: '/m/e5.mkv', subStatus: 'missing', statusReason: null, recheckAfter: null, files: [] },
            { episode: 6, path: '/m/e6.mkv', subStatus: 'missing', statusReason: null, recheckAfter: null, files: [] },
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
    expect(container.querySelectorAll('.ep-cell')).toHaveLength(8)
    expect(container.querySelectorAll('.ep-cell-dashed')).toHaveLength(2)
    expect(container.querySelectorAll('.ep-cell-covered')).toHaveLength(4)
    expect(container.querySelectorAll('.ep-cell-missing')).toHaveLength(2)
  })
})

describe('SeriesPage：覆盖句文案', () => {
  it('24 of 28 episodes covered——大数字嵌句', async () => {
    const detail: LibrarySeriesDetailDTO = {
      series: baseSeries(),
      seasons: [
        {
          season: 1,
          canonical: Array.from({ length: 28 }, (_, i) => ({ episode: i + 1, title: null })),
          onDisk: Array.from({ length: 24 }, (_, i) => ({
            episode: i + 1, path: `/m/e${i + 1}.mkv`, subStatus: 'covered', statusReason: null, recheckAfter: null, files: [],
          })),
          coverage: [],
        },
      ],
    }
    // 覆盖句是"前缀 + 嵌句大数字 + 后缀"三段拼接（seasonCoverageSentence 的结构，见
    // library/text.ts），前后缀是裸文本节点、不各自成一个元素——RTL 的 getByText 只按元素
    // 文本内容匹配，找不到"裸文本节点"，所以前后缀用 container.textContent 整体断言，
    // 只有嵌句大数字（有自己的 <Text as="span">）才用 getByText 精确定位。
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
  it('canonical 为空、磁盘有行 → 提示 + 格阵只按磁盘行渲染', async () => {
    const detail: LibrarySeriesDetailDTO = {
      series: baseSeries(),
      seasons: [
        {
          season: 1,
          canonical: [],
          onDisk: [{ episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] }],
          coverage: [],
        },
      ],
    }
    const { container } = renderPage(asyncData(detail))
    expect(await screen.findByText('canonical catalog pending')).toBeInTheDocument()
    expect(container.querySelectorAll('.ep-cell')).toHaveLength(1)
    expect(container.querySelectorAll('.ep-cell-dashed')).toHaveLength(0)
  })
})

describe('SeriesPage：详情板开合', () => {
  function detailFixture(): LibrarySeriesDetailDTO {
    return {
      series: baseSeries(),
      seasons: [
        {
          season: 1,
          canonical: [{ episode: 1, title: 'Pilot' }, { episode: 2, title: 'Second' }],
          onDisk: [
            {
              episode: 1, path: '/media/Series A/S01/Series.A.S01E01.1080p.mkv',
              subStatus: 'covered', statusReason: null, recheckAfter: null, files: [],
            },
          ],
          coverage: [{ episode: 1, lang: 'zh-Hans', path: '/media/Series A/S01/Series.A.S01E01.zh-Hans.ass' }],
        },
      ],
    }
  }

  it('点击已上盘的格子 → 面板显示文件名 + 字幕清单', async () => {
    renderPage(asyncData(detailFixture()))
    const cells = await screen.findAllByRole('button', { name: '1' })
    fireEvent.click(cells[0])

    expect(await screen.findByText('S01E01')).toBeInTheDocument()
    expect(screen.getByText('Series.A.S01E01.1080p.mkv')).toBeInTheDocument()
    expect(screen.getByText('zh-Hans')).toBeInTheDocument()
    expect(screen.getByText('Series.A.S01E01.zh-Hans.ass')).toBeInTheDocument()
  })

  it('点击 hardsub-assumed 格子 → 面板显示硬字幕假定与后端 reason', async () => {
    const detail = detailFixture()
    detail.seasons[0].onDisk = [
      {
        episode: 1, path: '/media/Series A/S01/Series.A.S01E01.1080p.mkv',
        subStatus: 'hardsub-assumed', statusReason: 'video stream has Chinese hard subtitles', recheckAfter: null, files: [],
      },
    ]
    detail.seasons[0].coverage = []

    renderPage(asyncData(detail))
    const cells = await screen.findAllByRole('button', { name: '1' })
    fireEvent.click(cells[0])

    expect(await screen.findByText('covered (hardsub assumed)')).toBeInTheDocument()
    expect(screen.getByText('video stream has Chinese hard subtitles')).toBeInTheDocument()
  })

  it('点击 dashed 格（磁盘无）→ 面板显示 canonical 标题 + not on disk', async () => {
    renderPage(asyncData(detailFixture()))
    const cells = await screen.findAllByRole('button', { name: '2' })
    fireEvent.click(cells[0])

    expect(await screen.findByText('S01E02')).toBeInTheDocument()
    // "not on disk" 也是格阵图例里 dashed 图例的文案（同一句话，两处都成立不是 bug）——
    // 用 within(panel) 把断言限定在详情板内，避免撞上图例那一份同名文本。
    const panel = screen.getByRole('dialog')
    expect(within(panel).getByText('Second')).toBeInTheDocument()
    expect(within(panel).getByText('not on disk')).toBeInTheDocument()
  })

  it('esc 关闭面板', async () => {
    renderPage(asyncData(detailFixture()))
    const cells = await screen.findAllByRole('button', { name: '1' })
    fireEvent.click(cells[0])
    await screen.findByText('S01E01')

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('S01E01')).not.toBeInTheDocument())
  })

  it('点击关闭控件关闭面板', async () => {
    renderPage(asyncData(detailFixture()))
    const cells = await screen.findAllByRole('button', { name: '1' })
    fireEvent.click(cells[0])
    await screen.findByText('S01E01')

    fireEvent.click(screen.getByRole('button', { name: 'Close episode details' }))
    await waitFor(() => expect(screen.queryByText('S01E01')).not.toBeInTheDocument())
  })

  it('再次点击同一格 → 关闭（toggle）', async () => {
    renderPage(asyncData(detailFixture()))
    const cells = await screen.findAllByRole('button', { name: '1' })
    fireEvent.click(cells[0])
    await screen.findByText('S01E01')
    fireEvent.click(cells[0])
    await waitFor(() => expect(screen.queryByText('S01E01')).not.toBeInTheDocument())
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
