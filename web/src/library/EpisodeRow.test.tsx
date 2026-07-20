// web/src/library/EpisodeRow.test.tsx：逐集行——文字在左 + 剧照 + 点击行内展开该集简介；
// overview 缺失时展开显示占位而非空白。默认测试语言为 en（jsdom navigator.language=en-US，
// 同 SeriesPage.test.tsx 的既有口径），故占位断言用英文文案。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { EpisodeRow } from './EpisodeRow.js'
import type { GridCell } from './episodeState.js'

afterEach(cleanup)

function cell(over: Partial<GridCell> = {}): GridCell {
  return { episode: 1, state: 'covered', title: 'Pilot', overview: 'ov1', airDate: '2011-10-05', stillPath: '/s1.jpg', onDisk: null, ...over }
}

describe('EpisodeRow', () => {
  it('展开态显示该集简介；未展开不显示', () => {
    const { rerender } = render(
      <I18nProvider><EpisodeRow cell={cell()} expanded={false} onToggle={() => {}} /></I18nProvider>,
    )
    expect(screen.queryByText('ov1')).not.toBeInTheDocument()
    rerender(<I18nProvider><EpisodeRow cell={cell()} expanded={true} onToggle={() => {}} /></I18nProvider>)
    expect(screen.getByText('ov1')).toBeInTheDocument()
  })

  it('点击行触发 onToggle', () => {
    const onToggle = vi.fn()
    render(<I18nProvider><EpisodeRow cell={cell()} expanded={false} onToggle={onToggle} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: /Pilot/ }))
    expect(onToggle).toHaveBeenCalled()
  })

  it('overview 为 null → 展开显示"暂无本集简介"占位（不空白）', () => {
    render(<I18nProvider><EpisodeRow cell={cell({ overview: null })} expanded={true} onToggle={() => {}} /></I18nProvider>)
    expect(screen.getByText('No synopsis for this episode (not provided by TMDB).')).toBeInTheDocument()
  })
})
