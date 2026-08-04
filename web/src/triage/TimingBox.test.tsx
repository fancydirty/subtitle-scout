import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { TimingBox } from './TimingBox.js'
import { api } from '../api/client.js'
import type { ShiftedItemDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const row = (over: Partial<ShiftedItemDTO> = {}): ShiftedItemDTO => ({
  itemId: 'it-1', seriesId: 'tmdb:1', seriesName: 'Peacemaker', season: 2, episode: 3,
  checkedAt: Date.now() - 2 * 3_600_000, hasPriorCorrection: true, ...over,
})

function stub(rows: ShiftedItemDTO[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/subtitle/shifted')) {
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
const wrap = () => render(<I18nProvider initialLang="en"><TimingBox /></I18nProvider>)

describe('TimingBox', () => {
  it('空清单 → 整区不渲染（零预告）', async () => {
    stub([])
    const { container } = wrap()
    await waitFor(() => expect(container.textContent).not.toContain('Timing looks off'))
    expect(container.querySelector('.triage-box')).toBeNull()
  })

  it('有偏移行 → 区头计数 + 标签 + checked ago', async () => {
    stub([row()])
    wrap()
    expect(await screen.findByText('Timing looks off')).toBeInTheDocument()
    expect(screen.getByText('Peacemaker S2E03')).toBeInTheDocument()
    expect(screen.getByText('checked 2h ago')).toBeInTheDocument()
  })

  it('Fix the timing → POST correct', async () => {
    stub([row()])
    const spy = vi.spyOn(api, 'subtitleCorrect').mockResolvedValue(undefined as never)
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Fix the timing' }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('it-1'))
  })

  it('hasPriorCorrection=false → Undo 置灰；=true → 可点触发 revert', async () => {
    stub([row({ hasPriorCorrection: false })])
    wrap()
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeDisabled()
  })

  it('hasPriorCorrection=true → Undo 点了走 revert', async () => {
    stub([row({ hasPriorCorrection: true })])
    const spy = vi.spyOn(api, 'subtitleRevert').mockResolvedValue(undefined as never)
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('it-1'))
  })
})
