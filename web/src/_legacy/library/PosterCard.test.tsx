// web/src/library/PosterCard.test.tsx：海报卡单元测试——series/movie 分支都渲染为 <a> 链接，
// href 指向正确路由（series → #/library/:id，movie → #/library/movies/:id）。
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { PosterCard } from './PosterCard.js'
import type { LibraryItemDTO } from '../../api/types.js'

function mockItem(overrides: Partial<LibraryItemDTO>): LibraryItemDTO {
  return {
    id: 's1',
    kind: 'series',
    name: 'Test Series',
    chineseTitle: null,
    year: 2023,
    posterPath: null,
    section: '剧集',
    coverage: { covered: 0, missing: 0, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 },
    job: null,
    originLang: null,
    nativeAudio: false,
    ...overrides,
  }
}

describe('PosterCard', () => {
  it('series 分支渲染 <a> 链接', () => {
    const series = mockItem({ id: 's1', name: 'Dune Series', kind: 'series' })
    render(
      <I18nProvider>
        <PosterCard item={series} />
      </I18nProvider>,
    )
    const card = screen.getByRole('link', { name: 'Dune Series' })
    expect(card.tagName).toBe('A')
    expect(card).toHaveAttribute('href', '#/library/s1')
  })

  it('movie 分支渲染 <a> 链接', () => {
    const movie = mockItem({ id: 'm1', name: 'Dune', kind: 'movie' })
    render(
      <I18nProvider>
        <PosterCard item={movie} />
      </I18nProvider>,
    )
    const card = screen.getByRole('link', { name: 'Dune' })
    expect(card.tagName).toBe('A')
    expect(card).toHaveAttribute('href', '#/library/movies/m1')
  })

  it('movie 链接 href 对 id 进行 encodeURIComponent', () => {
    const movie = mockItem({ id: 'tmdb:123', name: 'Movie with colon', kind: 'movie' })
    render(
      <I18nProvider>
        <PosterCard item={movie} />
      </I18nProvider>,
    )
    const card = screen.getByRole('link', { name: 'Movie with colon' })
    expect(card).toHaveAttribute('href', '#/library/movies/tmdb%3A123')
  })
})
