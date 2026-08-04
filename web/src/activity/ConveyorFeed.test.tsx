// web/src/activity/ConveyorFeed.test.tsx：传送带的渲染、几何、无障碍与 key 稳定性。
//
// jsdom 不做布局：getBoundingClientRect 恒返回全 0，而本组件的核心判据（"被顶出容器的行必须
// 完全在界外"）恰好只在几何上成立。所以这里按 CompareTimeline.test.tsx 的既有手法 spy
// Element.prototype.getBoundingClientRect，**用组件自己的不变量重算真实盒模型**：
//   - .conveyor  的高 = rows × ROW_H（组件写在 style 上，这里从 style.height 读回来）
//   - .conveyor-row 的 top = 容器 top + track 的 translateY + 行序 × ROW_H
// track 的 translateY 从 style.transform 里解析——即被测值本身。这一点很关键：垫片**不重新
// 推导**该位移多少，它只忠实地把组件给出的位移换算成几何。所以位移算错时垫片会跟着错到界外，
// 断言会红（下面"变异验证"里改容器高度那一发就是这样红的）。
//
// 这些数字的真实性已在 headless Chromium 里核过（n=0/2/4/7/9/120 六种规模、rows=4/6）：动画结束
// 后的**稳态**下可见行恒为末 rows 行、halfCut=false、末行底边严格贴容器底边。
// jsdom 查不到、只有真实浏览器能确认的两件事，记录在此以免下次有人以为测试覆盖了它们：
//   1) 亮度分级实际生效——末五行取到 4 个不同的 computed color（#e6e8ec / #9aa1ac / #6b7280 /
//      #4b5563），且第 5 行与第 4 行同色（n+5 那条规则）。用的是 color 不是 opacity。
//   2) 动画进行中（≤200ms）最上一行会短暂探出上边界 2px——slide-in-from-top-2 的固有代价，
//      稳态不受影响。整行步进保证的是稳态永不切半行。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider, type Lang } from '../i18n/useT.js'
import type { TraceEvent } from '../api/types.js'
import { ConveyorFeed, ROW_H } from './ConveyorFeed.js'

// styles.css 原文（vitest.config.ts 的 define 注入，见那边注释）。用来锁 JS↔CSS 的耦合不变量。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 从 CSS 里读某个选择器块的某条声明（剥注释，兼容单行/多行写法）。 */
function cssDecl(selector: string, prop: string): string | null {
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`(?:^|[\\s,}])${esc}\\s*\\{([^}]*)\\}`, 'm').exec(noComments)?.[1]
  if (block === undefined) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(block)
  return m?.[1]?.trim() ?? null
}


/** 造 n 条事件，工具名循环取自真实注册表（都在 toolPhrase 表里登记过）。 */
function events(n: number, tools = ['search_source', 'list_candidates', 'download_candidate']): TraceEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    runKey: 'job-1',
    seq: i,
    tool: tools[i % tools.length]!,
    argsSummary: `args${i}`,
    resultSummary: `result${i}`,
    tookMs: 100 + i,
    at: 1_700_000_000_000 + i * 1000,
  }))
}

function rect(top: number, height: number): DOMRect {
  return {
    top, bottom: top + height, height,
    left: 0, right: 400, width: 400, x: 0, y: top,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const CONTAINER_TOP = 0
    if (this.classList?.contains('conveyor')) {
      // 容器高度取组件自己写在 style 上的值——不是测试硬编码的期望值。
      const h = Number.parseFloat((this as HTMLElement).style.height) || 0
      return rect(CONTAINER_TOP, h)
    }
    if (this.classList?.contains('conveyor-row')) {
      const row = this as HTMLElement
      const track = row.parentElement
      // 解析 translateY(<n>px)，含负号。解析不出来当 0（不静默补一个"好看"的值）。
      const m = /translateY\((-?[\d.]+)px\)/.exec(track?.style.transform ?? '')
      const shift = m ? Number.parseFloat(m[1]!) : 0
      const idx = Array.prototype.indexOf.call(track?.children ?? [], row)
      return rect(CONTAINER_TOP + shift + idx * ROW_H, ROW_H)
    }
    return rect(0, 0)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderFeed(evts: readonly TraceEvent[], rows?: number, lang: Lang = 'zh') {
  return render(
    <I18nProvider initialLang={lang}>
      <ConveyorFeed events={evts} rows={rows} />
    </I18nProvider>,
  )
}

const rowsOf = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('.conveyor-row'))

describe('ConveyorFeed：文案', () => {
  it('事件渲染成行，文案走 toolPhrase（中文）', () => {
    renderFeed(events(3))
    expect(screen.getByText('正在搜字幕来源')).toBeInTheDocument()
    expect(screen.getByText('正在核对候选')).toBeInTheDocument()
    expect(screen.getByText('正在下载字幕')).toBeInTheDocument()
  })

  it('事件渲染成行，文案走 toolPhrase（英文）', () => {
    renderFeed(events(3), 4, 'en')
    expect(screen.getByText('Searching providers')).toBeInTheDocument()
    expect(screen.getByText('Reviewing candidates')).toBeInTheDocument()
    expect(screen.getByText('Downloading a subtitle')).toBeInTheDocument()
  })

  it('未登记的工具名原样显示——诚实降级，不在这一层美化', () => {
    // 中英各一次：裸工具名是技术值，中文语境下同样原样显示（phrases.ts §7 口径）。
    const t = [{ ...events(1)[0]!, tool: 'brand_new_backend_tool' }]
    renderFeed(t)
    expect(screen.getByText('brand_new_backend_tool')).toBeInTheDocument()
    cleanup()
    renderFeed(t, 4, 'en')
    expect(screen.getByText('brand_new_backend_tool')).toBeInTheDocument()
  })

  it('不渲染 argsSummary / 耗时等工程值——取证归日志，传送带只安抚', () => {
    const { container } = renderFeed(events(2))
    expect(container.textContent).not.toContain('args0')
    expect(container.textContent).not.toContain('result0')
    expect(container.textContent).not.toContain('100')
  })
})

describe('ConveyorFeed：整行步进的几何', () => {
  it('容器高度恒为 ROW_H 的整数倍（整行步进的前提）', () => {
    for (const rows of [1, 3, 4, 7, 12]) {
      const { container } = renderFeed(events(rows + 5), rows)
      const el = container.querySelector<HTMLElement>('.conveyor')!
      const h = Number.parseFloat(el.style.height)
      expect(h % ROW_H).toBe(0)
      expect(h).toBe(rows * ROW_H)
      cleanup()
    }
  })

  it('默认 4 行：容器高 80px', () => {
    const { container } = renderFeed(events(1))
    expect(container.querySelector<HTMLElement>('.conveyor')!.style.height).toBe(`${4 * ROW_H}px`)
  })

  it('非整数/非法 rows 也夹紧成整数行，容器高仍是 ROW_H 的整数倍', () => {
    for (const rows of [4.5, 0, -3]) {
      const { container } = renderFeed(events(6), rows)
      const h = Number.parseFloat(container.querySelector<HTMLElement>('.conveyor')!.style.height)
      expect(h % ROW_H).toBe(0)
      expect(h).toBeGreaterThan(0)
      cleanup()
    }
  })

  it('7 条事件 / rows=4：前 3 条完全在容器上边界之外（spec 判据 3）', () => {
    const { container } = renderFeed(events(7), 4)
    const feed = container.querySelector<HTMLElement>('.conveyor')!
    const top = feed.getBoundingClientRect().top
    const rs = rowsOf(feed)
    expect(rs).toHaveLength(7)
    // 前 3 条：底边 <= 容器顶边 —— 完全在界外，一个像素都不露。
    for (const i of [0, 1, 2]) {
      expect(rs[i]!.getBoundingClientRect().bottom).toBeLessThanOrEqual(top)
    }
    // 后 4 条完整可见（上不越顶、下不越底）。
    const bottom = feed.getBoundingClientRect().bottom
    for (const i of [3, 4, 5, 6]) {
      const r = rs[i]!.getBoundingClientRect()
      expect(r.top).toBeGreaterThanOrEqual(top)
      expect(r.bottom).toBeLessThanOrEqual(bottom)
    }
  })

  it('任何行都不会被容器上下边界切成半行（硬出的必要条件）', () => {
    for (const n of [0, 1, 4, 5, 7, 40]) {
      const { container } = renderFeed(events(n), 4)
      const feed = container.querySelector<HTMLElement>('.conveyor')!
      const { top, bottom } = feed.getBoundingClientRect()
      for (const row of rowsOf(feed)) {
        const r = row.getBoundingClientRect()
        const cutTop = r.top < top && r.bottom > top
        const cutBottom = r.top < bottom && r.bottom > bottom
        expect(cutTop || cutBottom).toBe(false)
      }
      cleanup()
    }
  })

  it('最新一行恒贴容器底边（bottom-pinned，含不满屏的情形）', () => {
    for (const n of [1, 2, 4, 9]) {
      const { container } = renderFeed(events(n), 4)
      const feed = container.querySelector<HTMLElement>('.conveyor')!
      const rs = rowsOf(feed)
      expect(rs.at(-1)!.getBoundingClientRect().bottom).toBe(feed.getBoundingClientRect().bottom)
      cleanup()
    }
  })

  it('位移恒为 ROW_H 的整数倍，且不满屏时不上移', () => {
    const shiftOf = (n: number, rows: number) => {
      const { container } = renderFeed(events(n), rows)
      const t = container.querySelector<HTMLElement>('.conveyor-track')!.style.transform
      const v = Number.parseFloat(/translateY\((-?[\d.]+)px\)/.exec(t)![1]!)
      cleanup()
      return v
    }
    // 溢出 3 行 → 恰好 -3 × ROW_H（裁决口径：-20px × 溢出行数）
    expect(shiftOf(7, 4)).toBe(-3 * ROW_H)
    expect(shiftOf(5, 4)).toBe(-1 * ROW_H)
    // 刚好满屏 → 不位移
    expect(shiftOf(4, 4)).toBe(0)
    // 不满屏 → 正位移（压到底部），绝不为负
    expect(shiftOf(2, 4)).toBe(2 * ROW_H)
    for (const [n, r] of [[7, 4], [5, 4], [4, 4], [2, 4], [0, 4], [13, 3]] as const) {
      // Math.abs：负位移取余得 -0，而 toBe 走 Object.is（-0 !== +0）。这是 JS 取余的符号
      // 语义，不是位移算错——整行步进只关心余数的绝对值为 0。
      expect(Math.abs(shiftOf(n, r) % ROW_H)).toBe(0)
    }
  })
})

describe('ConveyorFeed：无障碍', () => {
  it('role="log" 在场（WCAG ARIA23——该规范明确允许旧信息消失）', () => {
    renderFeed(events(3))
    expect(screen.getByRole('log')).toBeInTheDocument()
  })

  it('没有 aria-live="assertive"（会把每条痕迹打断式念出来，纯噪音）', () => {
    const { container } = renderFeed(events(3))
    expect(container.querySelector('[aria-live="assertive"]')).toBeNull()
    expect(screen.getByRole('log').getAttribute('aria-live')).not.toBe('assertive')
  })
})

describe('ConveyorFeed：key 稳定性与边界', () => {
  it('同一 runKey 下多个 seq=0 不撞 key（realign 的多子集场景）', () => {
    // 各子集 runKey 的 seq 都从 0 起算——纯 seq 或数组下标都会出问题，`runKey#seq` 不会。
    const mixed: TraceEvent[] = [
      { ...events(1)[0]!, runKey: 'job-1', seq: 0, tool: 'search_source' },
      { ...events(1)[0]!, runKey: 'job-2', seq: 0, tool: 'list_candidates' },
      { ...events(1)[0]!, runKey: 'job-3', seq: 0, tool: 'download_candidate' },
    ]
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = renderFeed(mixed)
    // 三行都在（撞 key 时 React 会丢行/复用错节点），且没有 duplicate key 警告。
    expect(rowsOf(container.querySelector<HTMLElement>('.conveyor')!)).toHaveLength(3)
    expect(spy.mock.calls.flat().join(' ')).not.toMatch(/same key|duplicate/i)
    spy.mockRestore()
  })

  it('key 稳定：滑动窗口掐掉头部后，留存事件仍是同一个 DOM 节点（入场动画只给新行）', () => {
    // 这条才是真正区分 `runKey#seq` 与数组下标的场景。**只追加**是区分不出来的——追加时旧行的
    // 下标不变，下标 key 也能碰巧保住节点身份（我第一版测试就止步于此，结果"key 改成下标"这个
    // 变异活着通过了全部 16 条）。传送带的真实数据流是**滑动窗口**：前端会掐掉过老的行。
    // 窗口一掐头，每条留存事件的下标就整体左移一格，下标 key 于是把 e2 的节点判给 e1、
    // e3 的节点判给 e2……React 复用节点只换文字，被顶走的旧行因此全部重播入场动画。
    const all = events(5)
    const { container, rerender } = renderFeed(all.slice(0, 4))
    const feed = () => container.querySelector<HTMLElement>('.conveyor')!
    // 记住每条事件当前占的 DOM 节点（按事件身份索引，不是按位置）。
    const before = new Map(rowsOf(feed()).map((el, i) => [all[i]!.seq, el]))
    rerender(
      <I18nProvider initialLang="zh">
        <ConveyorFeed events={all.slice(1, 5)} />
      </I18nProvider>,
    )
    const after = rowsOf(feed())
    expect(after).toHaveLength(4)
    // seq 1..3 是掐头后留存的三条：它们必须还坐在原来那个 DOM 节点上。
    for (let k = 0; k < 3; k++) {
      expect(after[k]).toBe(before.get(all[k + 1]!.seq))
    }
    // 末位是真正的新行——它应当是个新节点（动画只给它）。
    expect([...before.values()]).not.toContain(after[3])
  })

  it('key 稳定：纯追加时旧行的 DOM 节点保持同一个', () => {
    const first = events(3)
    const { container, rerender } = renderFeed(first)
    const before = rowsOf(container.querySelector<HTMLElement>('.conveyor')!)
    const grown = [...first, { ...events(1)[0]!, seq: 3, tool: 'install_subtitle' }]
    rerender(
      <I18nProvider initialLang="zh">
        <ConveyorFeed events={grown} />
      </I18nProvider>,
    )
    const after = rowsOf(container.querySelector<HTMLElement>('.conveyor')!)
    expect(after).toHaveLength(4)
    for (let i = 0; i < 3; i++) expect(after[i]).toBe(before[i])
  })

  it('空事件列表不崩，容器与 role 仍在场', () => {
    const { container } = renderFeed([])
    expect(screen.getByRole('log')).toBeInTheDocument()
    expect(rowsOf(container.querySelector<HTMLElement>('.conveyor')!)).toHaveLength(0)
    expect(container.querySelector<HTMLElement>('.conveyor')!.style.height).toBe(`${4 * ROW_H}px`)
  })
})

// ── JS↔CSS 耦合不变量（2026-07-31 审计 C-2 补）────────────────────────────────
// ConveyorFeed.tsx 的文件头写明「改一处不改另一处会立刻切出半行」，但那条不变量原本
// **不可测**：下面那批位移断言用的 getBoundingClientRect 垫片，行高取的就是 JS 侧的
// ROW_H（`rect(top + shift + idx*ROW_H, ROW_H)`），从不读 CSS。于是垫片验证的是
// 「JS 与自己一致」——审计实测把 CSS 的 .conveyor-row height 从 20px 改成 21px
// （那才是真会在浏览器里切半行的一改），全部测试照绿。
//
// 这两条把 CSS 侧的真实值拉进来对账。一行断言就把耦合变成真锁。
describe('ConveyorFeed：JS 的 ROW_H 必须与 CSS 的行高一致', () => {
  it('.conveyor-row 的 height 等于 ROW_H', () => {
    expect(cssDecl('.conveyor-row', 'height')).toBe(`${ROW_H}px`)
  })

  // line-height 也要跟上：只改 height 不改 line-height，文字会在行内偏移，
  // 视觉上同样是「切了一半」（只是切的是文字而非行框）。
  it('.conveyor-row 的 line-height 也等于 ROW_H', () => {
    expect(cssDecl('.conveyor-row', 'line-height')).toBe(`${ROW_H}px`)
  })
})

/** 把 window.matchMedia 临时换成"用户要求减少动效"，跑完立刻还原。
 *  不用 vi.spyOn：window.matchMedia 在 setupTests.ts 里是直接赋值的普通属性，
 *  spy 的 configurability 与 restoreAllMocks 的交互容易出玄学问题；显式存/还原更好懂。 */
function withReducedMotion<T>(fn: () => T): T {
  const real = window.matchMedia
  window.matchMedia = ((q: string) => ({
    matches: /prefers-reduced-motion/.test(q),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  try {
    return fn()
  } finally {
    window.matchMedia = real
  }
}

describe('ConveyorFeed 最新行的 shimmer', () => {
  it('最新一行的文字包在 Shimmer 的 span 里', () => {
    const { container } = renderFeed(events(3))
    const rows = rowsOf(container)
    const last = rows[rows.length - 1]
    // Shimmer 渲染 motion.span；文字不再是 .conveyor-row 的直接文本节点
    const span = last.querySelector('span')
    expect(span).not.toBeNull()
    expect(span?.textContent).toBe(last.textContent)
    expect(last.textContent).not.toBe('')
  })

  it('旧行不套 span，文字直接坐在 .conveyor-row 上', () => {
    const { container } = renderFeed(events(3))
    const rows = rowsOf(container)
    for (const row of Array.from(rows).slice(0, -1)) {
      expect(row.querySelector('span')).toBeNull()
      expect(row.textContent).not.toBe('')
    }
  })

  it('reduced-motion 下最新行退回纯文本', () => {
    const { container } = withReducedMotion(() => renderFeed(events(3)))
    const rows = rowsOf(container)
    const last = rows[rows.length - 1]
    expect(last.querySelector('span')).toBeNull()
    expect(last.textContent).not.toBe('')
  })

  it('只有一条事件时，那一条就是最新行（走 shimmer）', () => {
    const { container } = renderFeed(events(1))
    const rows = rowsOf(container)
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector('span')).not.toBeNull()
  })
})
