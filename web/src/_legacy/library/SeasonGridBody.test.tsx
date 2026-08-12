// web/src/library/SeasonGridBody.test.tsx：超长季紧凑格阵回落——点格阵中一格 → 格阵下方展开该集简介。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { SeasonGridBody } from './SeasonGridBody.js'
import type { GridCell } from './episodeState.js'

afterEach(cleanup)

describe('SeasonGridBody', () => {
  it('点格阵中一格 → 格阵下方展开该集简介', () => {
    const cells: GridCell[] = Array.from({ length: 3 }, (_, i) => ({
      episode: i + 1, state: 'covered', title: `E${i + 1}`, overview: `ov${i + 1}`, airDate: null, stillPath: null, onDisk: null,
    }))
    render(<I18nProvider><SeasonGridBody cells={cells} /></I18nProvider>)
    expect(screen.queryByText('ov2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(screen.getByText('ov2')).toBeInTheDocument()
  })
})

// ── DOM 侧迁移锁（Task 21）
describe('SeasonGridBody：DOM 侧迁移锁', () => {
  it('子树无 astryx-* 类名；展开区简介仍在场', () => {
    const cells: GridCell[] = Array.from({ length: 3 }, (_, i) => ({
      episode: i + 1, state: 'covered', title: `E${i + 1}`, overview: `ov${i + 1}`, airDate: null, stillPath: null, onDisk: null,
    }))
    const { container } = render(<I18nProvider><SeasonGridBody cells={cells} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    expect(screen.getByText('ov2')).toBeInTheDocument()
  })
})
