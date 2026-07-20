// web/src/library/SeasonAccordion.test.tsx：季手风琴——≤50 集用行式（EpisodeRow），>50 集回落
// 格阵（SeasonGridBody），季头恒显卷起汇总（覆盖句）。默认测试语言 en（jsdom navigator.language=
// en-US，同 SeriesPage.test.tsx 口径）——覆盖句大数字段在 en 下渲染为 "1 of 2"（zh 才是 "1 / 2"）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SeasonAccordion } from './SeasonAccordion.js'
import type { LibrarySeasonDTO } from '../api/types.js'

afterEach(cleanup)

const NOW = 1_700_000_000_000

function seasonDTO(nEps: number): LibrarySeasonDTO {
  return {
    season: 1,
    canonical: Array.from({ length: nEps }, (_, i) => ({ episode: i + 1, title: `E${i + 1}`, overview: `ov${i + 1}`, airDate: null, stillPath: null })),
    onDisk: Array.from({ length: nEps }, (_, i) => ({ episode: i + 1, path: `/m/e${i + 1}.mkv`, subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] })),
    coverage: [],
  }
}

describe('SeasonAccordion', () => {
  it('默认展开：≤50 集用行式（EpisodeRow），点集展开简介', () => {
    render(<I18nProvider><SeasonAccordion season={seasonDTO(3)} now={NOW} defaultOpen /></I18nProvider>)
    expect(screen.queryByText('ov2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /E2/ }))
    expect(screen.getByText('ov2')).toBeInTheDocument()
  })

  it('>50 集回落格阵（SeasonGridBody：格子是数字按钮，不是逐集行头）', () => {
    render(<I18nProvider><SeasonAccordion season={seasonDTO(60)} now={NOW} defaultOpen /></I18nProvider>)
    // 行式头是 "E0N + 标题"，格阵是裸数字 → 存在纯数字 name 的按钮即证明走了格阵
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument()
  })

  it('季头卷起汇总：覆盖句（大数字段，en 下为 "1 of 2"）', () => {
    const s = seasonDTO(2)
    s.onDisk[1].subStatus = 'missing'
    render(<I18nProvider><SeasonAccordion season={s} now={NOW} defaultOpen={false} /></I18nProvider>)
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
  })
})
