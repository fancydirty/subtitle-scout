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

// ── 字幕校验芯片 / 时间轴入口：随字幕校验下架删除（spec §5，2026-08-07）─────────────
// 原本这里有两个 describe 共 17 条用例：
//   · "EpisodeRow：字幕校验芯片"（12 条）——checked/state 两维的芯片渲染矩阵、红芯片点击
//     触发 onInspect、缺 onInspect 时降级 disabled、铁律②（零数字上界面）与铁律③（不暴露
//     机械词汇）文案锁、"无嵌套 button（芯片与展开按钮是兄弟）"结构锁、中英文案锁。
//   · "EpisodeRow：时间轴入口"（5 条）——展开区入口的出现/点击、绿态与未检测态同样有入口、
//     onInspect 缺席不渲染、绿芯片保持非 button（零焦点）。
// 两组用例的每一条都以 verify/onInspect prop 与 verify-chip-* 为前提，EpisodeRow 摘掉这两个
// prop 后它们全都无从成立，故整组删除（不是改断言）。VerifyChip.tsx 与 web/src/subtitleVerify/**
// 的源码测试保留，将来重启用时把这两个 describe（连同 SubtitleVerifyDTO 的 verify()/renderRow()
// 两个 helper）恢复即可。
//
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

// ── DOM 侧迁移锁（Task 21）
describe('EpisodeRow：DOM 侧迁移锁', () => {
  it('子树无 astryx-* 类名；集号 mono、标题在场', () => {
    const cell: GridCell = {
      episode: 1, state: 'covered', title: 'Pilot', overview: 'ov', airDate: '2011-10-05', stillPath: null,
      onDisk: { itemId: 'ep1', episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
    }
    const { container } = render(
      <I18nProvider><EpisodeRow cell={cell} expanded={false} onToggle={() => {}} /></I18nProvider>,
    )
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 集号走 font-mono（type="code" 迁移后的证据）。
    expect(container.querySelector('span.font-mono')).toBeTruthy()
    expect(screen.getByText('Pilot')).toBeInTheDocument()
  })
})
