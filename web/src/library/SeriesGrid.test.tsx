// web/src/library/SeriesGrid.test.tsx：海报墙列表页——分区渲染、筛选 chip 过滤、结果计数、
// 三态（loading 由骨架屏覆盖，不额外断言像素；error/empty 断言文案）。沿 F2 的 fetch mock 手法
// （App.test.tsx 的 mockFetchRouted），这里只有一个端点（/api/v2/library），不需要按 URL 路由。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SeriesGrid } from './SeriesGrid.js'
import type { LibraryItemDTO } from '../api/types.js'

function mockFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response)
}

function item(overrides: Partial<LibraryItemDTO>): LibraryItemDTO {
  return {
    id: 'tmdb:1', kind: 'series', name: 'Series A', chineseTitle: null, year: 2021, posterPath: null,
    section: '剧集', coverage: { covered: 0, missing: 0, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 }, job: null,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderGrid() {
  return render(
    <I18nProvider>
      <SeriesGrid />
    </I18nProvider>,
  )
}

describe('SeriesGrid', () => {
  it('空库 → EmptyState（真库为空的事实，不是筛选结果）', async () => {
    vi.stubGlobal('fetch', mockFetch([]))
    renderGrid()
    expect(await screen.findByText('No library yet')).toBeInTheDocument()
  })

  it('加载失败 → 错误态 + 重试按钮', async () => {
    vi.stubGlobal('fetch', mockFetch({ error: 'boom' }, false))
    renderGrid()
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('按 section 分组渲染（剧集/电影），结果计数显示总条目数', async () => {
    const data: LibraryItemDTO[] = [
      item({ id: 's1', name: 'Series One', section: '剧集' }),
      item({ id: 'm1', kind: 'movie', name: 'Movie One', section: '电影' }),
    ]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()

    expect(await screen.findByText('Series One')).toBeInTheDocument()
    expect(screen.getByText('Movie One')).toBeInTheDocument()
    expect(screen.getByText('Series')).toBeInTheDocument()
    expect(screen.getByText('Movies')).toBeInTheDocument()
    expect(screen.getByText('2 titles')).toBeInTheDocument()
  })

  it('筛选 chip："有缺口" 只留 missing>0 的条目', async () => {
    const data: LibraryItemDTO[] = [
      item({ id: 's1', name: 'Gappy Series', coverage: { covered: 2, missing: 3, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 } }),
      item({ id: 's2', name: 'Full Series', coverage: { covered: 12, missing: 0, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 } }),
    ]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()

    await screen.findByText('Gappy Series')
    expect(screen.getByText('Full Series')).toBeInTheDocument()
    expect(screen.getByText('2 titles')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Has gaps' }))

    await waitFor(() => expect(screen.getByText('1 title')).toBeInTheDocument())
    expect(screen.getByText('Gappy Series')).toBeInTheDocument()
    expect(screen.queryByText('Full Series')).not.toBeInTheDocument()
  })

  it('筛选后零结果 → 区别于空库的"这个筛选下暂时没有条目"', async () => {
    const data: LibraryItemDTO[] = [
      item({ id: 's1', name: 'Only Series', coverage: { covered: 1, missing: 1, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 } }),
    ]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()

    await screen.findByText('Only Series')
    fireEvent.click(screen.getByRole('radio', { name: 'Fully covered' }))

    expect(await screen.findByText('Nothing matches this filter')).toBeInTheDocument()
  })

  it('系列海报卡指向 #/library/:id（series id 经 encodeURIComponent）', async () => {
    const data: LibraryItemDTO[] = [item({ id: 'tmdb:42', name: 'Linked Series' })]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()

    const link = await screen.findByRole('link', { name: 'Linked Series' })
    expect(link).toHaveAttribute('href', '#/library/tmdb%3A42')
  })
})
