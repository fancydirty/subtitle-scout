// web/src/shell/layout.css.test.ts —— SPA 布局体系（2026-08-27 spec）的钉值守卫。
//
// ── 为什么这些断言值得存在 ────────────────────────────────────────────────
// 「没有产品感」的结构性根因是布局系统缺席：main 无限拉伸、16px 贴边留白、零断点、
// 字号无刻度。这四样全是**计算值层面的裁决**（1440px 不是 1280px、p-6 不是 p-4），
// 只断言"类名在场"锁不住它们——口径同 cards.css.test.ts 文件头（be025db 先例）。
//
// ── 覆盖矩阵（对应 spec 四决策）────────────────────────────────────────────
//  A. 四个 --container-* token 的存在与值（tw.css @theme static；Tailwind v4 由
//     --container-* 命名空间生成 max-w-page/form/detail/wide 工具类，页面顶层容器消费）。
//  B. AppShell main 的 padding 类：p-6 xl:p-8，p-4 退役。
//  C. 两个手写 @media 的断点值与叠放形态（1100px 工作台 B 切分 / 640px 设置 deploy 行）。
//     ⚠️ spec 原文还有第三处「详情 hero（1fr 2fr grid）900px 叠单栏」——**现行代码里
//     这个结构不存在**（详情页 hero 是 72px 海报 + flex 文字列，900px 下无挤断风险；
//     唯一的 1fr 2fr 是零消费方的 .wf-lanes 死类），硬加一条空转的 @media 是凑数，
//     故不落、不钉。结构若将来长出来，断点随它一起来。
//  D. 四个 --text-* 刻度 token 的存在与值；.wb-section-head 作为「区块标题」层
//     从刻度走（var(--text-section) + 600）。styles.css 的 10/11px 正文密度值
//     **不在守备范围**——那是密度设计，spec 明令不动。
//
// ── 为什么走 define 注入而不是 import ──────────────────────────────────────
// 同 vitest.config.ts 头注释：`import '…css?raw'` 在 vitest 里恒返回空字符串；
// AppShell.tsx 原文走同一条 define 通道（__APPSHELL_TSX__），不引入 ?raw 的
// tsconfig types 例外。
import { describe, it, expect } from 'vitest'

declare const __STYLES_CSS__: string
declare const __TW_CSS__: string
declare const __APPSHELL_TSX__: string
const CSS = __STYLES_CSS__
const TW_CSS = __TW_CSS__
const SHELL = __APPSHELL_TSX__

/** styles.css 剥注释后的代码部分（注释里演示的旧值不该被扫描命中）。 */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** 提取 `@media (max-width: <px>px)` 的整块内容（含嵌套花括号——@media 里是
 *  完整的规则集，[^}] 那种单层正则会在第一个规则末尾就截断）。 */
function mediaBlock(px: number): string {
  const marker = `@media (max-width: ${px}px)`
  const i = BARE.indexOf(marker)
  if (i < 0) return ''
  const start = BARE.indexOf('{', i)
  if (start < 0) return ''
  let depth = 0
  for (let j = start; j < BARE.length; j++) {
    if (BARE[j] === '{') depth++
    else if (BARE[j] === '}') {
      depth--
      if (depth === 0) return BARE.slice(start + 1, j)
    }
  }
  return ''
}

/** @media 块内某选择器块里的一条声明（同 cards.css.test.ts 的 decl，但作用域是传入片段）。 */
function declIn(scope: string, selector: string, prop: string): string | null {
  const re = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${re}\\s*\\{([^}]*)\\}`).exec(scope)?.[1]
  if (!block) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(block)
  return m ? m[1]!.trim() : null
}

describe('决策 A：分页收口的 --container-* token（tw.css）', () => {
  // 值就是裁决本体：1440 默认 / 880 表单可读横距 / 1200 详情 / 1600 海报墙 8 列给足。
  const TOKENS: Array<[string, string]> = [
    ['container-page', '1440px'],
    ['container-form', '880px'],
    ['container-detail', '1200px'],
    ['container-wide', '1600px'],
  ]
  for (const [name, value] of TOKENS) {
    it(`🔴 --${name}: ${value}`, () => {
      expect(TW_CSS).toMatch(new RegExp(`--${name}:\\s*${value.replace('.', '\\.')}\\s*;`))
    })
  }

  it('🔴 token 落在 @theme static 里（非 static 时手写 CSS 的 var() 引用会静默失效）', () => {
    // tw.css 的每个 @theme 块都必须是 static——文件头注释讲过官方口径：
    // 默认只发射"被 utility 用到"的变量，styles.css 手写引用对它不可见。
    expect(TW_CSS).not.toMatch(/@theme\s*\{/)
    expect(TW_CSS).toMatch(/@theme static\s*\{/)
  })
})

describe('决策 B：主内容区留白 24px 基线 + 宽屏 32px（AppShell main）', () => {
  const mainClass = /<main[^>]*className="([^"]*)"/.exec(SHELL)?.[1] ?? ''
  const classes = mainClass.split(/\s+/)

  it('🔴 main 读到了（读空会让本段恒绿）', () => {
    expect(mainClass.length).toBeGreaterThan(0)
    expect(classes).toContain('flex-1')
  })

  it('🔴 p-6 + xl:p-8，p-4 退役', () => {
    expect(classes).toContain('p-6')
    expect(classes).toContain('xl:p-8')
    expect(classes).not.toContain('p-4')
  })
})

describe('决策 C：最小断点集（styles.css 手写 @media，值对齐 Tailwind 默认档）', () => {
  it('🔴 1100px：工作台在跑卡 B 切分叠单栏（海报全宽、右栏回归 normal flow 左对齐）', () => {
    const m = mediaBlock(1100)
    expect(m, '@media (max-width: 1100px) 不存在').not.toBe('')
    expect(declIn(m, '.wb-run-card', 'flex-direction')).toBe('column')
    expect(declIn(m, '.wb-run-card .wb-run-img', 'width')).toBe('100%')
    expect(declIn(m, '.wb-run-card .wb-run-body', 'position')).toBe('relative')
    expect(declIn(m, '.wb-run-card .wb-run-body', 'text-align')).toBe('left')
    // 叠放后海报在上、右栏在下：溶接方向必须跟着转成 to bottom——留着 to right
    // 会把全宽海报的右半边溶成透明（下面已没有实色栏接住它）。
    const img = new RegExp(`\\.wb-run-card \\.wb-run-img\\s*\\{([^}]*)\\}`).exec(m)?.[1] ?? ''
    expect(img).toContain('to bottom')
    expect(img).not.toContain('to right')
  })

  it('🔴 1100px 块不触碰排队卡（96px 恒定高小卡窄屏本来就放得下）', () => {
    const m = mediaBlock(1100)
    expect(m).not.toContain('.wb-queue-card')
  })

  it('🔴 640px：设置 deploy 行 label/值上下叠（220px 定宽 key 在窄屏挤死值列）', () => {
    const m = mediaBlock(640)
    expect(m, '@media (max-width: 640px) 不存在').not.toBe('')
    expect(declIn(m, '.settings-deploy-row', 'flex-direction')).toBe('column')
    expect(declIn(m, '.settings-deploy-row', 'align-items')).toBe('flex-start')
    expect(declIn(m, '.settings-deploy-key', 'min-width')).toBe('0')
  })

  it('🔴 断点里不许出现 clamp()（口径同 cards.css.test.ts）', () => {
    expect(mediaBlock(1100)).not.toContain('clamp(')
    expect(mediaBlock(640)).not.toContain('clamp(')
  })
})

describe('决策 D：结构层字号刻度（tw.css token + 标题层消费）', () => {
  const TOKENS: Array<[string, string]> = [
    ['text-page-title', '18px'],
    ['text-section', '14px'],
    ['text-body', '13px'],
    ['text-caption', '11px'],
  ]
  for (const [name, value] of TOKENS) {
    it(`🔴 --${name}: ${value}`, () => {
      expect(TW_CSS).toMatch(new RegExp(`--${name}:\\s*${value}\\s*;`))
    })
  }

  it('🔴 .wb-section-head（区块标题层）从刻度走：var(--text-section) + 600', () => {
    const block = /\.wb-section-head\s*\{([^}]*)\}/.exec(BARE)?.[1] ?? ''
    expect(block).toMatch(/font-size:\s*var\(--text-section\)/)
    expect(block).toMatch(/font-weight:\s*600/)
  })

  it('🔴 styles.css 引用的每个 --text-* token 都真有定义（拼错不报错，只静默失效——口径同 --color-* 守卫）', () => {
    const DEFINED = new Set([...TW_CSS.matchAll(/--(text-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!))
    const used = [...BARE.matchAll(/var\(\s*--(text-[a-z0-9-]+)/g)].map((m) => m[1]!)
    const missing = [...new Set(used)].filter((t) => !DEFINED.has(t))
    expect(missing, `styles.css 引用了未定义的字号 token：${missing.map((t) => `--${t}`).join(', ')}`).toEqual([])
  })
})
