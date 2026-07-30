// web/src/library/SeasonAccordion.test.tsx：季手风琴——≤50 集用行式（EpisodeRow），>50 集回落
// 格阵（SeasonGridBody），季头恒显卷起汇总（覆盖句）。默认测试语言 en（jsdom navigator.language=
// en-US，同 SeriesPage.test.tsx 口径）——覆盖句大数字段在 en 下渲染为 "1 of 2"（zh 才是 "1 / 2"）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SeasonAccordion } from './SeasonAccordion.js'
import type { LibrarySeasonDTO } from '../api/types.js'

afterEach(cleanup)

const NOW = 1_700_000_000_000

function seasonDTO(nEps: number): LibrarySeasonDTO {
  return {
    season: 1,
    canonical: Array.from({ length: nEps }, (_, i) => ({ episode: i + 1, title: `E${i + 1}`, overview: `ov${i + 1}`, airDate: null, stillPath: null })),
    onDisk: Array.from({ length: nEps }, (_, i) => ({ itemId: `ep${i + 1}`, episode: i + 1, path: `/m/e${i + 1}.mkv`, subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] })),
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

// ── 字幕校验接线（2026-07-30）────────────────────────────────────────────
// 这一层是取数点：一次拿整季，而不是每行各发一个请求（24 集 = 24 个往返）。
describe('SeasonAccordion：字幕校验接线', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function stubVerify(items: Array<{ itemId: string; state: 'ok' | 'shifted'; checked: boolean }>) {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/subtitle/verify')) {
        return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return calls
  }

  it('整季只发一个批量请求（不是每集一个）', async () => {
    const calls = stubVerify([])
    render(<I18nProvider initialLang="zh"><SeasonAccordion season={seasonDTO(24)} now={NOW} /></I18nProvider>)
    await waitFor(() => {
      expect(calls.filter((u) => u.includes('/subtitle/verify')).length).toBe(1)
    })
    // 一个请求里带上全部 24 个 id
    const url = calls.find((u) => u.includes('/subtitle/verify'))!
    expect(url).toContain('itemIds=')
    expect(url.split('itemIds=')[1]!.split(',').length).toBe(24)
  })

  it('shifted 的集渲染红芯片，ok 的集渲染绿点', async () => {
    stubVerify([
      { itemId: 'ep1', state: 'shifted', checked: true },
      { itemId: 'ep2', state: 'ok', checked: true },
    ])
    const { container } = render(
      <I18nProvider initialLang="zh"><SeasonAccordion season={seasonDTO(3)} now={NOW} /></I18nProvider>,
    )
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="verify-chip-shifted"]').length).toBe(1)
    })
    expect(container.querySelectorAll('[data-testid="verify-chip-ok"]').length).toBe(1)
    // 第三集没在响应里 → checked 缺席 → 不渲染芯片（不装作查过）
    expect(container.querySelectorAll('[data-testid^="verify-chip"]').length).toBe(2)
  })

  it('季折叠时不查校验（芯片不可见，省掉整季往返）', async () => {
    const calls = stubVerify([])
    render(
      <I18nProvider initialLang="zh">
        <SeasonAccordion season={seasonDTO(24)} now={NOW} defaultOpen={false} />
      </I18nProvider>,
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.filter((u) => u.includes('/subtitle/verify')).length).toBe(0)
  })

  it('点红芯片打开检视面板', async () => {
    stubVerify([{ itemId: 'ep1', state: 'shifted', checked: true }])
    const { container } = render(
      <I18nProvider initialLang="zh"><SeasonAccordion season={seasonDTO(2)} now={NOW} /></I18nProvider>,
    )
    const chip = await waitFor(() => {
      const c = container.querySelector('[data-testid="verify-chip-shifted"]')
      expect(c).toBeTruthy()
      return c!
    })
    fireEvent.click(chip)
    await waitFor(() => {
      expect(document.querySelector('.vinspect')).toBeTruthy()
    })
  })
})
