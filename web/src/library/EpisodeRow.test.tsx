// web/src/library/EpisodeRow.test.tsx：逐集行——文字在左 + 剧照 + 点击行内展开该集简介；
// overview 缺失时展开显示占位而非空白。默认测试语言为 en（jsdom navigator.language=en-US，
// 同 SeriesPage.test.tsx 的既有口径），故占位断言用英文文案。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { EpisodeRow } from './EpisodeRow.js'
import type { GridCell } from './episodeState.js'

// CSS 断言取值同 Task 19/20 与 src/activity 四文件：走 vitest.config.ts:21 的 define 编译期替换。
// 这一屏读 CSS 是因为 3 处 --color-accent（活跃行左条/格子焦点环/选中格边框）和 .ep-cell 面底
// 都踩在跨栈撞车上（Task 19 背景一 / 本 task 背景二），只看 DOM 改错了也全绿。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

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

// ── 字幕校验芯片（2026-07-30 spec）────────────────────────────────────────────
// 语言一律用 initialLang 显式锁定，不依赖 jsdom 的 navigator.language：那是隐式环境
// 依赖，CI locale 或 jsdom 版本一变就会莫名开始渲染另一种语言，断言随之崩塌
// （同 workflow/TraceRows.test.tsx 的既有口径）。
import type { SubtitleVerifyDTO } from '../api/types.js'

function verify(over: Partial<SubtitleVerifyDTO> = {}): SubtitleVerifyDTO {
  return { itemId: 'tmdb:1/s1e1', state: 'ok', checked: true, ...over }
}

function renderRow(props: Partial<Parameters<typeof EpisodeRow>[0]> = {}, lang: 'en' | 'zh' = 'en') {
  return render(
    <I18nProvider initialLang={lang}>
      <EpisodeRow cell={cell()} expanded={false} onToggle={() => {}} {...props} />
    </I18nProvider>,
  )
}

describe('EpisodeRow：字幕校验芯片', () => {
  it('checked=false → 芯片完全不渲染（还没查过就别装作查过）', () => {
    renderRow({ verify: verify({ checked: false }) })
    expect(screen.queryByTestId('verify-chip-ok')).not.toBeInTheDocument()
    expect(screen.queryByTestId('verify-chip-shifted')).not.toBeInTheDocument()
  })

  // 回归锁：后端对未检测条目也给 state='ok'（类型上只有两态），所以 checked 必须先判。
  // 若先看 state，没查过的集子会被渲染成绿色——那是替系统撒谎说"查过了，没问题"。
  it('checked=false 且 state=ok → 仍然不渲染（checked 必须优先于 state）', () => {
    renderRow({ verify: verify({ checked: false, state: 'ok' }) })
    expect(screen.queryByTestId('verify-chip-ok')).not.toBeInTheDocument()
  })

  it('verify 缺席（父组件还没拿到数据）→ 不渲染芯片', () => {
    renderRow({})
    expect(screen.queryByTestId('verify-chip-ok')).not.toBeInTheDocument()
    expect(screen.queryByTestId('verify-chip-shifted')).not.toBeInTheDocument()
  })

  it("state='ok' → 绿芯片在场，且不是 button（绿态无事可做，不该吃键盘焦点）", () => {
    renderRow({ verify: verify({ state: 'ok' }) })
    const chip = screen.getByTestId('verify-chip-ok')
    expect(chip).toBeInTheDocument()
    expect(chip.tagName).not.toBe('BUTTON')
  })

  it("state='shifted' → 红芯片可点，点击触发 onInspect", () => {
    const onInspect = vi.fn()
    renderRow({ verify: verify({ state: 'shifted' }), onInspect })
    const chip = screen.getByTestId('verify-chip-shifted')
    fireEvent.click(chip)
    expect(onInspect).toHaveBeenCalledTimes(1)
  })

  it("state='shifted' 但 onInspect 缺席 → 红芯片降级为 disabled，点击不炸", () => {
    renderRow({ verify: verify({ state: 'shifted' }) })
    const chip = screen.getByTestId('verify-chip-shifted') as HTMLButtonElement
    expect(chip.disabled).toBe(true)
    fireEvent.click(chip)   // 不应抛错
  })

  // 铁律②回归锁：零数字上界面。只断言芯片自身的 textContent——行里本来就有集号 E01
  // 与首播日 2011-10-05，那是既有的合法内容，不能连坐。
  it('铁律②：芯片自身文本不含任何数字/百分号/内部术语', () => {
    for (const state of ['ok', 'shifted'] as const) {
      cleanup()
      renderRow({ verify: verify({ state }), onInspect: () => {} })
      const chip = screen.getByTestId(`verify-chip-${state}`)
      const text = `${chip.textContent ?? ''} ${chip.getAttribute('aria-label') ?? ''}`
      expect(text).not.toMatch(/\d/)
      expect(text).not.toMatch(/%/)
      expect(text.toLowerCase()).not.toMatch(/score|offset|confidence|\bms\b|jaccard|tier/)
    }
  })

  // 铁律③回归锁：不暴露机械。"没能验证"这一档在后端就被折成 'ok'，前端连词汇都不该有。
  it('铁律③：芯片文本不出现 agent/内嵌轨/参考源等机械词汇', () => {
    renderRow({ verify: verify({ state: 'shifted' }), onInspect: () => {} }, 'zh')
    const chip = screen.getByTestId('verify-chip-shifted')
    const text = `${chip.textContent ?? ''} ${chip.getAttribute('aria-label') ?? ''}`
    expect(text).not.toMatch(/agent|orchestrator|worker|参考源|内嵌轨|比对|互相关/i)
  })

  // 结构回归锁：芯片可点 + 整行可点，两者必须是兄弟而非嵌套。button 套 button 是非法
  // HTML——屏幕阅读器行为未定义、键盘 Tab 顺序错乱。
  it('无嵌套 button（芯片与展开按钮是兄弟）', () => {
    const { container } = renderRow({ verify: verify({ state: 'shifted' }), onInspect: () => {} })
    expect(container.querySelectorAll('button button').length).toBe(0)
  })

  it('展开按钮仍带 aria-expanded（结构重构没丢无障碍语义）', () => {
    renderRow({ verify: verify({ state: 'shifted' }), onInspect: () => {} })
    expect(screen.getByRole('button', { name: /Pilot/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('中英各渲染一次：红芯片文案跟随 UI 语言', () => {
    renderRow({ verify: verify({ state: 'shifted' }), onInspect: () => {} }, 'en')
    expect(screen.getByTestId('verify-chip-shifted').textContent).toBe('timing looks off')
    cleanup()
    renderRow({ verify: verify({ state: 'shifted' }), onInspect: () => {} }, 'zh')
    expect(screen.getByTestId('verify-chip-shifted').textContent).toBe('时间轴对不上')
  })

  it('芯片在场时不影响展开行为（点行仍触发 onToggle，不误触芯片）', () => {
    const onToggle = vi.fn()
    const onInspect = vi.fn()
    renderRow({ verify: verify({ state: 'shifted' }), onToggle, onInspect })
    fireEvent.click(screen.getByRole('button', { name: /Pilot/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onInspect).not.toHaveBeenCalled()
  })
})

// ── 时间轴入口（2026-07-31）──────────────────────────────────────────────
// 约一半条目是"无法验证"（PGS 位图字幕 / 无同目录参考），它们判绿是诚实的沉默，
// 但对照图本身仍有用——用户对着画面能自己判断偏没偏。音频 VAD 实测走不通
// （偏移量准但相似度只有 0.5），所以"让用户自己看"是这批条目的唯一出路。
describe('EpisodeRow：时间轴入口', () => {
  it('展开后出现入口，点击触发 onInspect', () => {
    const onInspect = vi.fn()
    renderRow({ verify: verify({ state: 'ok' }), onInspect })
    // 折叠时不该有
    expect(screen.queryByText('看字幕时间轴')).not.toBeInTheDocument()
    cleanup()
    renderRow({ verify: verify({ state: 'ok' }), onInspect, expanded: true }, 'zh')
    const btn = screen.getByText('看字幕时间轴')
    fireEvent.click(btn)
    expect(onInspect).toHaveBeenCalledTimes(1)
  })

  // 关键：绿态也要有入口。这条锁住"用户能自己看"这个产品承诺。
  it('绿芯片（含无法验证）同样有入口——不是只有红的能点', () => {
    renderRow({ verify: verify({ state: 'ok' }), onInspect: () => {}, expanded: true }, 'zh')
    expect(screen.getByText('看字幕时间轴')).toBeInTheDocument()
  })

  it('没检测过的条目展开后也有入口（对照图不依赖检测结论）', () => {
    renderRow({ verify: verify({ checked: false }), onInspect: () => {}, expanded: true }, 'zh')
    expect(screen.getByText('看字幕时间轴')).toBeInTheDocument()
  })

  it('onInspect 缺席（父组件未接线）→ 不渲染入口', () => {
    renderRow({ verify: verify({ state: 'ok' }), expanded: true }, 'zh')
    expect(screen.queryByText('看字幕时间轴')).not.toBeInTheDocument()
  })

  // 绿芯片必须保持零焦点：做成 button 会让 Tab 在整季 24 个绿点上空转。
  it('绿芯片仍然不是 button（入口在展开区，不在芯片上）', () => {
    renderRow({ verify: verify({ state: 'ok' }), onInspect: () => {}, expanded: true })
    expect(screen.getByTestId('verify-chip-ok').tagName).not.toBe('BUTTON')
  })
})

// ── CSS 侧迁移锁（Task 21）——三处可见强调避开 --color-accent 撞车 + 面底/圆角/绿点/橙→琥珀
describe('EpisodeRow / 季手风琴组：CSS 侧迁移锁', () => {
  it('三处可见强调走 --color-ring（不是 --color-accent：后者过渡期柠檬绿、卸载后与背景同色 → 隐形）', () => {
    expect(cssDecl('.ep-cell:focus-visible', 'outline')).toBe('2px solid var(--color-ring)')
    expect(cssDecl('.ep-cell-selected', 'border-color')).toBe('var(--color-ring)')
    // 活跃行左条：选择器含 `>`，用整串 includes 断言更稳。
    expect(CSS).toContain('border-left-color: var(--color-ring)')
    expect(CSS).not.toContain('border-left-color: var(--color-accent)')
  })

  it('格子面底走 --color-secondary（不是 --color-accent），圆角字面 4px', () => {
    expect(cssDecl('.ep-cell', 'background')).toBe('var(--color-secondary)')
    expect(cssDecl('.ep-cell', 'border-radius')).toBe('4px')
  })

  it('语义色迁到新栈：绿点 --color-fn-green、半覆盖集号橙→琥珀 --color-fn-amber（有意改值）', () => {
    expect(cssDecl('.ep-dot-covered', 'background')).toBe('var(--color-fn-green)')
    // 半覆盖集号：新栈无橙档，沿用唯一暖色 --color-fn-amber（#f2c00b）。
    expect(CSS).toContain('var(--color-fn-amber)')
    expect(CSS).not.toContain('var(--color-text-orange)')
  })
})
