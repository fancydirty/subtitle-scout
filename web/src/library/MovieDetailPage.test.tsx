// web/src/library/MovieDetailPage.test.tsx：电影详情页测试——七 subStatus 映射快照、
// ignored+rule1b 不透传中文、多副本段条件渲染、404 空态（spec B Task 11）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { MovieDetailPage } from './MovieDetailPage.js'
import type { Async } from '../api/hooks.js'
import type { MovieDetailDTO } from '../api/types.js'

afterEach(() => cleanup())

function asyncOf(data: MovieDetailDTO | null, error: string | null = null): Async<MovieDetailDTO> {
  return { data, loading: false, error, reload: () => {} }
}

const BASE_MOVIE: MovieDetailDTO = {
  id: 'tt1234567',
  name: 'The Matrix',
  chineseTitle: '黑客帝国',
  year: 1999,
  posterPath: '/abc123.jpg',
  path: '/media/movies/The.Matrix.1999.mkv',
  subStatus: 'covered',
  statusReason: null,
  recheckAfter: null,
  originLang: 'en',
  nativeAudio: false,
  files: [{ path: '/media/movies/The.Matrix.1999.mkv', isMain: true, covered: true }],
  subtitles: [{ language: 'zh-CN', path: '/media/movies/The.Matrix.1999.zh-CN.srt' }],
  recentJobs: [{ id: 101, state: 'completed', priority: 5, updatedAt: Date.now() }],
}

describe('MovieDetailPage：subStatus 人话句映射', () => {
  it('covered → "Subtitles installed"', () => {
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf({ ...BASE_MOVIE, subStatus: 'covered' })} />
      </I18nProvider>,
    )
    expect(screen.getByText('Subtitles installed')).toBeInTheDocument()
  })

  it('missing → "Missing subtitles"', () => {
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf({ ...BASE_MOVIE, subStatus: 'missing' })} />
      </I18nProvider>,
    )
    expect(screen.getByText('Missing subtitles')).toBeInTheDocument()
  })

  it('embedded → "Embedded subtitles"', () => {
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf({ ...BASE_MOVIE, subStatus: 'embedded' })} />
      </I18nProvider>,
    )
    expect(screen.getByText('Embedded subtitles')).toBeInTheDocument()
  })

  it('hardsub-assumed → "Hard subtitles assumed"', () => {
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf({ ...BASE_MOVIE, subStatus: 'hardsub-assumed' })} />
      </I18nProvider>,
    )
    expect(screen.getByText('Hard subtitles assumed')).toBeInTheDocument()
  })

  it('unavailable + recheckAfter → "Will retry in N minutes"', () => {
    const recheckAfter = Date.now() + 5 * 60 * 1000 // 5 minutes from now
    render(
      <I18nProvider>
        <MovieDetailPage
          detail={asyncOf({ ...BASE_MOVIE, subStatus: 'unavailable', recheckAfter })}
        />
      </I18nProvider>,
    )
    expect(screen.getByText(/Will retry in \d+ minutes/)).toBeInTheDocument()
  })

  it('unavailable 无 recheckAfter → "No subtitles available"', () => {
    render(
      <I18nProvider>
        <MovieDetailPage
          detail={asyncOf({ ...BASE_MOVIE, subStatus: 'unavailable', recheckAfter: null })}
        />
      </I18nProvider>,
    )
    expect(screen.getByText('No subtitles available')).toBeInTheDocument()
  })

  it('ignored + nativeAudio → "Native audio — no subtitles needed"', () => {
    render(
      <I18nProvider>
        <MovieDetailPage
          detail={asyncOf({ ...BASE_MOVIE, subStatus: 'ignored', nativeAudio: true })}
        />
      </I18nProvider>,
    )
    // 状态行和母语标记行都会显示这句话
    const matches = screen.getAllByText('Native audio — no subtitles needed')
    expect(matches.length).toBeGreaterThan(0)
  })

  it('ignored + 非母语 → "Marked as not needing subtitles during scan."（不透传中文 reason）', () => {
    render(
      <I18nProvider>
        <MovieDetailPage
          detail={asyncOf({
            ...BASE_MOVIE,
            subStatus: 'ignored',
            nativeAudio: false,
            statusReason: '扫库时发现文件名含"中字"标记', // rule 1b 中文内部串
          })}
        />
      </I18nProvider>,
    )
    expect(screen.getByText('Marked as not needing subtitles during scan.')).toBeInTheDocument()
    // 不应透传中文 reason
    expect(screen.queryByText('扫库时发现文件名含"中字"标记')).not.toBeInTheDocument()
  })
})

describe('MovieDetailPage：多副本段条件渲染', () => {
  it('多副本（files.length > 1）才渲染副本段', () => {
    const multiFiles: MovieDetailDTO = {
      ...BASE_MOVIE,
      files: [
        { path: '/media/movies/The.Matrix.1999.1080p.mkv', isMain: true, covered: true },
        { path: '/media/movies/The.Matrix.1999.720p.mkv', isMain: false, covered: false },
      ],
    }
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf(multiFiles)} />
      </I18nProvider>,
    )
    expect(screen.getByText('Files')).toBeInTheDocument()
    expect(screen.getByText('/media/movies/The.Matrix.1999.1080p.mkv')).toBeInTheDocument()
    expect(screen.getByText('/media/movies/The.Matrix.1999.720p.mkv')).toBeInTheDocument()
  })

  it('单副本（files.length === 1）不渲染副本段', () => {
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf(BASE_MOVIE)} />
      </I18nProvider>,
    )
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
  })

  it('零副本（files.length === 0）不渲染副本段', () => {
    const noFiles: MovieDetailDTO = {
      ...BASE_MOVIE,
      files: [],
    }
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf(noFiles)} />
      </I18nProvider>,
    )
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
  })
})

describe('MovieDetailPage：404 空态', () => {
  it('404 error → "Series not found"（复用 SeriesPage i18n 键）', () => {
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf(null, 'not found')} />
      </I18nProvider>,
    )
    expect(screen.getByText('Series not found')).toBeInTheDocument()
  })

  it('404 with arrow notation → "Series not found"', () => {
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf(null, 'GET /api/v2/movies/tt999 → 404')} />
      </I18nProvider>,
    )
    expect(screen.getByText('Series not found')).toBeInTheDocument()
  })

  it('其它错误显示完整错误信息和重试按钮', () => {
    render(
      <I18nProvider>
        <MovieDetailPage detail={asyncOf(null, 'Network timeout')} />
      </I18nProvider>,
    )
    expect(screen.getByText(/Network timeout/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})

describe('MovieDetailPage：loading 态', () => {
  it('loading 时显示骨架屏', () => {
    render(
      <I18nProvider>
        <MovieDetailPage detail={{ data: null, loading: true, error: null, reload: () => {} }} />
      </I18nProvider>,
    )
    expect(screen.getByLabelText('loading movie')).toBeInTheDocument()
  })
})
