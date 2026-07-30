// web/src/library/SeasonAccordion.test.tsx：季手风琴——≤50 集用行式（EpisodeRow），>50 集回落
// 格阵（SeasonGridBody），季头恒显卷起汇总（覆盖句）。默认测试语言 en（jsdom navigator.language=
// en-US，同 SeriesPage.test.tsx 口径）——覆盖句大数字段在 en 下渲染为 "1 of 2"（zh 才是 "1 / 2"）。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SeasonAccordion } from './SeasonAccordion.js'
import type { LibrarySeasonDTO, SubtitleCompareDTO } from '../api/types.js'

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

  // jsdom 没有 ResizeObserver，而 CompareTimeline 用它测容器宽度。不打这个桩，
  // 面板一渲染就抛 ReferenceError —— 那是**测试环境**的缺口，不是产品行为，
  // 用它来"证明"错误边界有效等于拿一个假故障糊弄自己（真实浏览器里 ResizeObserver 恒在）。
  // 同 InspectPanel.test.tsx 的既有口径。
  beforeEach(() => {
    class RO {
      constructor(private cb: ResizeObserverCallback) {}
      observe() { this.cb([{ contentRect: { width: 800, height: 120 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  /** 一份形状**完整**的 compare 响应。
   *
   *  审计 I-E1：这里原来只对 `/subtitle/verify` 作答，`/subtitle/compare` 落到
   *  `return new Response('{}')` 那条兜底上 —— 面板拿到一个空对象，`data.reference`
   *  是 undefined，渲染当场抛错、整棵树被拆掉（实测 `root html length: 11`）。
   *  而那条测试断言的是 `.vinspect` 存在，它**匹配到的是抛错之前的 loading 帧**，
   *  于是测试照绿。vitest 的 "3 unhandled errors / may cause false positive tests"
   *  警告正是在说这件事。 */
  function compareDTO(over: Partial<SubtitleCompareDTO> = {}): SubtitleCompareDTO {
    return {
      itemId: 'ep1',
      reference: [{ startMs: 1_000, endMs: 3_000, text: '参考第一句' }],
      ours: [{ startMs: 3_400, endMs: 5_400, text: '待检第一句' }],
      durationMs: 600_000,
      waveformAvailable: true,
      mountKind: 'lan',
      diagnosis: 'behind',
      fixable: true,
      ...over,
    }
  }

  function stubVerify(
    items: Array<{ itemId: string; state: 'ok' | 'shifted'; checked: boolean }>,
    compare: Partial<SubtitleCompareDTO> | null = {},
  ) {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/subtitle/verify')) {
        return new Response(JSON.stringify({ items }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // 对照图：给一份形状完整的 DTO。compare=null 时如实回 500（用来测错误态），
      // 绝不再回 '{}' —— 那个空对象不是任何真实响应，只会制造一次假通过。
      if (url.includes('/subtitle/compare')) {
        if (compare === null) {
          return new Response('nope', { status: 500 })
        }
        return new Response(JSON.stringify(compareDTO(compare)), { status: 200, headers: { 'content-type': 'application/json' } })
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

  /** 点开红芯片，返回面板容器。断言**落在面板真正渲染出内容之后**——
   *  只等 `.vinspect` 出现会匹配到 loading 帧，那之后面板可能抛错、整棵树被拆掉，
   *  而测试已经绿了（审计 I-E1）。 */
  async function openPanel(container: HTMLElement) {
    const chip = await waitFor(() => {
      const c = container.querySelector('[data-testid="verify-chip-shifted"]')
      expect(c).toBeTruthy()
      return c!
    })
    fireEvent.click(chip)
  }

  it('点红芯片打开检视面板（断言落在面板内容渲染之后，不是 loading 帧）', async () => {
    stubVerify([{ itemId: 'ep1', state: 'shifted', checked: true }])
    const { container } = render(
      <I18nProvider initialLang="zh"><SeasonAccordion season={seasonDTO(2)} now={NOW} /></I18nProvider>,
    )
    await openPanel(container)

    // ① 结论条真的渲染出来了（loading 帧里没有它）
    await waitFor(() => {
      expect(screen.getByText(/字幕比画面慢了/)).toBeInTheDocument()
    })
    // ② 对照时间轴容器在（面板的主体，也是 loading 帧里没有的东西）
    expect(document.querySelector('.cmptl')).toBeTruthy()
    // ③ 台词列表里是真数据
    expect(screen.getByText('待检第一句')).toBeInTheDocument()
    // ④ 校正按钮（后端说 fixable）
    expect(screen.getByText('校正时间轴')).toBeInTheDocument()

    // ⑤ 整棵树还活着——这是 I-E1 那次假通过真正漏掉的东西：
    // 当时面板抛错、React 卸载了整棵树，document.body 只剩十几个字符。
    expect(document.body.innerHTML.length).toBeGreaterThan(500)
    expect(container.querySelector('.library-season-head')).toBeTruthy()
  })

  it('对照图请求失败 → 面板显示错误态，dashboard 不被拖垮', async () => {
    stubVerify([{ itemId: 'ep1', state: 'shifted', checked: true }], null)
    const { container } = render(
      <I18nProvider initialLang="zh"><SeasonAccordion season={seasonDTO(2)} now={NOW} /></I18nProvider>,
    )
    await openPanel(container)
    await waitFor(() => {
      expect(document.querySelector('.vinspect')).toBeTruthy()
    })
    // 季头还在 = 应用没白屏
    expect(container.querySelector('.library-season-head')).toBeTruthy()
  })

  // 审计 I-D1：面板路径没有 error boundary，任何抛错都白屏整个应用。
  // 这条用一份**畸形**的 compare 响应（reference 缺席，正是 I-E1 里实际发生的形状）
  // 逼面板抛错，然后断言：降级成一句人话，且 dashboard 完好。
  it('面板抛错 → 降级成一句人话 + 关闭按钮，不拖垮整个 dashboard【I-D1】', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // `ours` 被删掉 → CueList 读 `cues.length` 时抛
    // `Cannot read properties of undefined (reading 'length')`
    // ——正是审计在 I-E1 里实测到的那个错误形状（当时它从 diagnose() 抛出，
    // 整棵树被卸载、`root html length: 11`）。
    stubVerify(
      [{ itemId: 'ep1', state: 'shifted', checked: true }],
      { ours: undefined as unknown as SubtitleCompareDTO['ours'] },
    )
    const { container } = render(
      <I18nProvider initialLang="zh"><SeasonAccordion season={seasonDTO(2)} now={NOW} /></I18nProvider>,
    )
    await openPanel(container)

    // 降级态出现
    await waitFor(() => {
      expect(document.querySelector('[data-testid="vinspect-failed"]')).toBeTruthy()
    })
    expect(screen.getByText(/这个对照面板没能显示出来/)).toBeInTheDocument()
    // 关闭按钮可用
    const close = screen.getByText('知道了')
    expect(close).toBeInTheDocument()

    // **整个 dashboard 完好**——这是这条测试的全部意义（修复前这里整棵树被拆掉）
    expect(container.querySelector('.library-season-head')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid^="verify-chip"]').length).toBeGreaterThan(0)

    // 点关闭 → 面板消失，季内容仍在
    fireEvent.click(close)
    await waitFor(() => {
      expect(document.querySelector('[data-testid="vinspect-failed"]')).toBeNull()
    })
    expect(container.querySelector('.library-season-head')).toBeTruthy()
    spy.mockRestore()
  })
})
