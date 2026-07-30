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
