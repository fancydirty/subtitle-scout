// web/src/shell/RootHealthNote.test.tsx —— 守备目录健康度**画出来之后**长什么样。
//
// ── 这个文件与 rootHealth.test.ts 的分工 ──────────────────────────────────
// 那个测折叠判据（三态 → 两个名单），这个测**渲染纪律**：
//  · 健康的根一个字都不占屏（沉默即好消息）
//  · `null` 与 `false` 视觉上必须可区分，且 `null` **不是绿的**
//  · `lastError` 原文一个字都不许进 DOM（R-F9/R-F10：排障不推给用户）
//  · Carbon 双通道：文字自己说全 + 形状（实心/空心方块），颜色只是第三重
//
// ⚠️ 端到端"链条真的接上了"由 rootHealthWiring.test.tsx 守（那才是 🔴-1 的判据：
// 变异 `roots: []` 要能让测试红）。本文件只管组件自身。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { en } from '../i18n/en.js'
import { RootHealthNote } from './RootHealthNote.js'
import type { HealthRootDTO } from '../api/types.js'

afterEach(cleanup)

declare const __STYLES_CSS__: string

function root(path: string, ok: boolean | null, lastError: string | null = null): HealthRootDTO {
  return { path, ok, lastError, lastCheckedAt: ok === null ? null : 1_700_000_000_000 }
}

function renderNote(roots: HealthRootDTO[] | null) {
  return render(<I18nProvider initialLang="en"><RootHealthNote roots={roots} /></I18nProvider>)
}

describe('RootHealthNote · 沉默即好消息（R-F9/R-F10：不做排障面板）', () => {
  it('全部健康 → **什么都不渲染**（健康的根不占屏）', () => {
    const { container } = renderNote([root('/a', true), root('/b', true)])
    expect(container.textContent).toBe('')
  })

  it('roots 为 null（/health 还没回来）→ 什么都不渲染，**不报"一切正常"**', () => {
    // fail-open 报绿正是这整条链要防的那句假话。
    const { container } = renderNote(null)
    expect(container.textContent).toBe('')
  })

  it('空 roots（零守备目录）→ 不渲染（那不是故障，设置页自有引导）', () => {
    const { container } = renderNote([])
    expect(container.textContent).toBe('')
  })

  it('🔴 健康的根**不与坏的一起列出来**——只说有问题的那个', () => {
    renderNote([root('/good', true), root('/bad', false, '读取失败')])
    const line = screen.getByTestId('root-health-failed')
    expect(line.textContent).toContain('/bad')
    // 全量列出 = 排障面板，那是被否掉的形态。
    expect(line.textContent).not.toContain('/good')
    expect(screen.queryByTestId('root-health-unknown')).toBeNull()
  })
})

describe('RootHealthNote · 三态怎么画（`null` 绝不许画成绿/健康）', () => {
  it('ok=false → failed 行，说"读不到 + 可能不是最新的"', () => {
    renderNote([root('/media', false, 'boom')])
    const line = screen.getByTestId('root-health-failed')
    expect(line.textContent).toContain(en.root_health_failed)
    expect(line.textContent).toContain('/media')
  })

  it('🔴 ok=null → **单独一行 unknown**，与 failed 不是同一句话', () => {
    renderNote([root('/new', null)])
    const line = screen.getByTestId('root-health-unknown')
    expect(line.textContent).toContain(en.root_health_unknown)
    // 变异：把 null 折进 failed → 这条红（"还没轮到扫"被报成"挂载掉了"）。
    expect(screen.queryByTestId('root-health-failed')).toBeNull()
    expect(en.root_health_unknown).not.toBe(en.root_health_failed)
  })

  // 🔴 这条就是后端 buildRootHealth 头注释点名的那条禁令的可执行形态。
  it('🔴 ok=null **不许**静默消失（`?? true` 兜底 → 本条红）', () => {
    const { container } = renderNote([root('/never-scanned', null)])
    expect(container.textContent, '未知被当成健康吞掉了').toContain('/never-scanned')
  })

  it('两类同时存在 → 两行都出，各说各的', () => {
    renderNote([root('/bad', false, 'x'), root('/unk', null), root('/ok', true)])
    expect(screen.getByTestId('root-health-failed').textContent).toContain('/bad')
    expect(screen.getByTestId('root-health-unknown').textContent).toContain('/unk')
  })

  it('多个同类根列在同一行（不是每个根一条提示）', () => {
    renderNote([root('/a', false, 'x'), root('/b', false, 'y')])
    const line = screen.getByTestId('root-health-failed')
    expect(line.textContent).toContain('/a')
    expect(line.textContent).toContain('/b')
    expect(screen.getAllByTestId('root-health-failed')).toHaveLength(1)
  })
})

describe('RootHealthNote · lastError 原文不进 DOM（R-F9/R-F10）', () => {
  it('🔴 failed 行**一个字都不透传** lastError（那是带 errno 的排障串）', () => {
    const raw = '守备目录读取失败，本轮跳过（已重试 2 次）: Error: EIO i/o error'
    const { container } = renderNote([root('/media', false, raw)])
    expect(container.textContent).not.toContain('EIO')
    expect(container.textContent).not.toContain('已重试')
    expect(container.textContent).not.toContain('Error')
  })

  it('🔴 陈旧（ok=null）时 lastError 仍可能非 null——**更不许**渲染它', () => {
    // 后端注释点名：那不是当前结论。渲染它会让"灰色未知"旁边挂一句红色失败原文。
    const { container } = renderNote([root('/stale', null, '守备目录扫出 0 个媒体文件')])
    expect(container.textContent).not.toContain('0 个媒体文件')
    expect(container.textContent).toContain('/stale')
  })

  it('不提供任何按钮（能修它的动作在用户的机器上，界面上画按钮只会是打不通的）', () => {
    renderNote([root('/a', false, 'x'), root('/b', null)])
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('role=status 而不是 alert（背景事实，不该抢读屏用户正在听的内容）', () => {
    renderNote([root('/a', false, 'x')])
    expect(screen.getByTestId('root-health-failed')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// ═══ Carbon 双通道 ═══════════════════════════════════════════════════════════
// 判据分两半：DOM 一半（形状类名真的挂上了）+ CSS 一半（那个类名真的产生形状差异）。
// 只断言类名在场锁不住它——把 .root-health-mark-hollow 改成 opacity:0.5 不会让任何
// 断言变红，而那时形状通道就没了，只剩颜色（cards.css.test.ts 的既有理由）。
describe('Carbon 双通道：形状 + 文字，颜色只是第三重', () => {
  it('failed=实心方块 / unknown=空心方块（DOM 侧：类名真的分开）', () => {
    const { container } = renderNote([root('/a', false, 'x'), root('/b', null)])
    const failedMark = container.querySelector('[data-testid="root-health-failed"] .root-health-mark')
    const unknownMark = container.querySelector('[data-testid="root-health-unknown"] .root-health-mark')
    expect(failedMark).not.toBeNull()
    expect(unknownMark).not.toBeNull()
    expect(failedMark!.className).not.toContain('root-health-mark-hollow')
    expect(unknownMark!.className).toContain('root-health-mark-hollow')
  })

  it('🔴 CSS 侧：空心档的差异是**形状**（border + 无填充），不是明暗', () => {
    const bare = (__STYLES_CSS__ as string).replace(/\/\*[\s\S]*?\*\//g, '')
    const block = /\.root-health-mark-hollow\s*\{([^}]*)\}/.exec(bare)?.[1] ?? ''
    expect(block, '.root-health-mark-hollow 规则不存在 → 形状通道没了').not.toBe('')
    expect(block).toMatch(/background\s*:\s*none/)
    expect(block).toMatch(/border\s*:/)
    // 变异：改成 opacity:0.5 的"淡实心块" → 上面两条红（灰度下与实心块无法区分）。
    expect(block).not.toMatch(/opacity/)
  })

  it('🔴 CSS 侧：方块不是圆点（与状态条里那两个圆点的形状必须真的不同）', () => {
    const bare = (__STYLES_CSS__ as string).replace(/\/\*[\s\S]*?\*\//g, '')
    const block = /\.root-health-mark\s*\{([^}]*)\}/.exec(bare)?.[1] ?? ''
    expect(block).toMatch(/border-radius\s*:\s*0/)
    expect(block).not.toMatch(/border-radius\s*:\s*50%/)
  })

  it('🔴 文字是主通道：去掉全部 CSS 之后信息量一个字不少', () => {
    // jsdom 本来就不加载 styles.css——所以这条断言测的正好是"裸 DOM 文本"。
    const { container } = renderNote([root('/bad', false, 'x'), root('/unk', null)])
    const text = container.textContent ?? ''
    expect(text).toContain(en.root_health_failed)
    expect(text).toContain('/bad')
    expect(text).toContain(en.root_health_unknown)
    expect(text).toContain('/unk')
  })

  it('路径不许被 ellipsis 截断（截掉的恰是区分同前缀根的那一段）', () => {
    const bare = (__STYLES_CSS__ as string).replace(/\/\*[\s\S]*?\*\//g, '')
    const block = /\.root-health-paths\s*\{([^}]*)\}/.exec(bare)?.[1] ?? ''
    expect(block).not.toMatch(/text-overflow\s*:\s*ellipsis/)
  })

  it('同前缀的两个根能区分（/mnt/media/a 与 /mnt/media/b 都完整出现）', () => {
    const { container } = renderNote([root('/mnt/media/a', false, 'x'), root('/mnt/media/b', false, 'y')])
    expect(container.textContent).toContain('/mnt/media/a')
    expect(container.textContent).toContain('/mnt/media/b')
  })
})
