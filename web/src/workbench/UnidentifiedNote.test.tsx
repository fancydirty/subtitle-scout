// web/src/workbench/UnidentifiedNote.test.tsx —— 认不出来的目录**画出来之后**长什么样。
//
// ── 与 rootHealthWiring.test.tsx 的分工 ────────────────────────────────────
// 那个测**链条真的接上了**（端到端 HTTP 桩 → Shell → DOM，变异恒空要能红）；
// 这个测**渲染纪律**：
//  · dirCount 为 0 / DTO 缺席时一个字都不占屏（沉默即好消息）
//  · 信息量边界：目录名出、排障读数一律不出（R-F9/R-F10）
//  · 零操作面（R-F1「未识别资源不给用户改」）
//  · Carbon 双通道：文字自己说全 + 形状（空心方块），颜色只是第三重
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { en } from '../i18n/en.js'
import { UnidentifiedNote } from './UnidentifiedNote.js'
import type { UnidentifiedHealthDTO } from '../api/types.js'

afterEach(cleanup)

declare const __STYLES_CSS__: string

function renderNote(u: UnidentifiedHealthDTO | null) {
  return render(<I18nProvider initialLang="en"><UnidentifiedNote unidentified={u} /></I18nProvider>)
}

describe('UnidentifiedNote · 沉默即好消息', () => {
  it('dirCount 为 0 → **什么都不渲染**（认得出来的库不占屏）', () => {
    const { container } = renderNote({ dirCount: 0, dirs: [] })
    expect(container.textContent).toBe('')
  })

  it('DTO 缺席（/health 还没回来）→ 什么都不渲染，**不报"都认出来了"**', () => {
    // fail-open 报绿正是这整条链要防的那句假话（同 RootHealthNote 的既有论证）。
    const { container } = renderNote(null)
    expect(container.textContent).toBe('')
  })
})

describe('UnidentifiedNote · 说什么（信息量边界：R-F9/R-F10 排障不推给用户）', () => {
  it('说后果 + 说该干什么（`title (year)`），并列出目录名', () => {
    renderNote({ dirCount: 1, dirs: [{ dirName: 'Unknown Show', fileCount: 24 }] })
    const line = screen.getByTestId('wb-unidentified-line')
    expect(line.textContent).toContain(en.unidentified_note)
    expect(line.textContent).toContain('Unknown Show')
  })

  // 🔴 R-F1 的下半句「底线是按 title (year) 命名」必须真的出现在用户眼前——
  // 界面上没有任何按钮，不说清格式这条提示就只是在报忧。
  it('🔴 文案里带着 `title (year)` 这个可执行的格式', () => {
    renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    expect(screen.getByTestId('wb-unidentified-line').textContent).toMatch(/title.*year/i)
  })

  // 2026-08-27 实测（用户第一次真人跑 setup）：旧文案「rename them to "title (year)" and
  // they'll be picked up」在两处撒谎——① 识别是 agent 做的，title (year) 不是必需格式
  // （裸 title 也能认），说"改成这个格式就能处理"对着一个本来就是 title (year) 只是括号
  // 全角的目录，用户无从照办；② "就能处理"是没有的承诺。诚实版：格式只是"最有帮助"，
  // 且说清改名之后发生什么（下轮自动检查会重试）。
  it('🔴 文案说真话：格式是建议不是必需（helps，不承诺 picked up），且交代改名后下轮会重试', () => {
    renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    const text = screen.getByTestId('wb-unidentified-line').textContent ?? ''
    expect(text).not.toMatch(/rename them to .+ and they'll be picked up/i)
    expect(text).toMatch(/helps/i)
    expect(text).toMatch(/retr/i) // retry / retried
  })

  it('多个目录逗号分隔，同前缀的两个也能区分', () => {
    renderNote({ dirCount: 2, dirs: [
      { dirName: 'Show S01', fileCount: 3 },
      { dirName: 'Show S02', fileCount: 4 },
    ] })
    const text = screen.getByTestId('wb-unidentified-line').textContent ?? ''
    expect(text).toContain('Show S01')
    expect(text).toContain('Show S02')
  })

  it('截断：说"另外还有 N 个"，N = dirCount - dirs.length（不是 dirs.length）', () => {
    renderNote({ dirCount: 30, dirs: Array.from({ length: 8 }, (_, i) => ({ dirName: `D${i}`, fileCount: 1 })) })
    expect(screen.getByTestId('wb-unidentified-more').textContent).toContain('22')
  })

  it('没截断（dirCount === dirs.length）→ 不出现那条尾巴', () => {
    renderNote({ dirCount: 2, dirs: [
      { dirName: 'A', fileCount: 1 }, { dirName: 'B', fileCount: 1 },
    ] })
    expect(screen.queryByTestId('wb-unidentified-more')).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 R-F1：未识别资源不给用户改
// ══════════════════════════════════════════════════════════════════════════════
describe('🔴 零操作面（R-F1）', () => {
  it('没有按钮、没有链接、没有输入框', () => {
    renderNote({ dirCount: 3, dirs: [{ dirName: 'Unknown Show', fileCount: 24 }] })
    const line = screen.getByTestId('wb-unidentified-line')
    expect(within(line).queryByRole('button')).toBeNull()
    expect(within(line).queryByRole('link')).toBeNull()
    expect(within(line).queryByRole('textbox')).toBeNull()
    expect(line.querySelector('button, a, input, select')).toBeNull()
  })

  it('不是 alert（这是背景事实，不是打断用户的故障）', () => {
    renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('wb-unidentified-line')).toHaveAttribute('aria-live', 'polite')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 Carbon 双通道
// ══════════════════════════════════════════════════════════════════════════════
describe('Carbon 双通道：形状 + 文字，颜色只是第三重', () => {
  it('形状是**空心**方块——语气与 root_health_unknown 同档，不是 failed 的告警档', () => {
    // 这不是故障（库是好的、目录读得到，只是名字没按规范写）。用实心/amber
    // 会把"你该改个名"说成"你的库坏了"。
    const { container } = renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    const mark = container.querySelector('[data-testid="wb-unidentified-line"] .root-health-mark')
    expect(mark).not.toBeNull()
    expect(mark!.className).toContain('root-health-mark-hollow')
    expect(screen.getByTestId('wb-unidentified-line')).toHaveAttribute('data-kind', 'unknown')
  })

  it('🔴 CSS 侧：复用的那两个类真的存在（形状通道不是空头支票）', () => {
    // 复用 root-health-mark 一族是刻意的（不发明第五个符号）。但"复用"必须是真的——
    // 哪天那两条规则被改名/删掉，本组件的形状通道会静默消失，只剩颜色。
    const bare = (__STYLES_CSS__ as string).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(/\.root-health-mark\s*\{/.test(bare), '.root-health-mark 规则不存在').toBe(true)
    expect(/\.root-health-mark-hollow\s*\{/.test(bare), '.root-health-mark-hollow 规则不存在').toBe(true)
  })

  // 2026-08-27 实测截图：说明文字与目录名列表贴太近，人眼费力分辨哪里是话的结尾、
  // 哪里是名单的开头。目录名单前要有明确间距（跟随状态条的 12px 列距刻度）。
  it('🔴 CSS 侧：目录名单与说明文字之间有明确间距（wb-unidentified-paths 规则存在且元素挂着它）', () => {
    const { container } = renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    const paths = container.querySelector('[data-testid="wb-unidentified-line"] .root-health-paths')
    expect(paths).not.toBeNull()
    expect(paths!.className).toContain('wb-unidentified-paths')
    const bare = (__STYLES_CSS__ as string).replace(/\/\*[\s\S]*?\*\//g, '')
    const m = bare.match(/\.wb-unidentified-paths\s*\{([^}]*)\}/)
    expect(m, '.wb-unidentified-paths 规则不存在').not.toBeNull()
    expect(m![1]).toMatch(/margin-left\s*:/)
  })

  it('🔴 文字是主通道：去掉全部 CSS 之后信息量一个字不少', () => {
    // jsdom 本来就不加载 styles.css——这条断言测的正好是"裸 DOM 文本"。
    const { container } = renderNote({ dirCount: 9, dirs: [{ dirName: 'Unknown Show', fileCount: 24 }] })
    const text = container.textContent ?? ''
    expect(text).toContain(en.unidentified_note)
    expect(text).toContain('Unknown Show')
    expect(text).toContain('8')  // 另外还有 8 个
  })
})
