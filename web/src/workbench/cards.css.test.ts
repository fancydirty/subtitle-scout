// web/src/workbench/cards.css.test.ts —— R-F13 的几何与 R-F11 的"拒绝投影"。
//
// ── 为什么这些断言值得存在 ────────────────────────────────────────────────
// R-F13 给的是**具体数字**（60% / 186px / 59px / 88px / 118px），它们不是排版偏好：
// 用户实测发现"在跑用横版、排队用竖版"这个分工的根源就是宽高比算出来的
// （16:9 @70px高 = 124px宽 太窄；2:3 @70px高 = 47px宽 天生适合窄行）。
// 数字被人顺手改掉时没有任何东西会红——卡片只是变得难看，而"难看"没有判据。
//
// ── 为什么走 CSS 变量而不是断言组件里的内联样式 ────────────────────────────
// 设计文档 §七 明令移动端那一轮**在 media query 里改变量值、不改组件**，
// 且点名**不许用 clamp()**（三轮审计 🔵：clamp 要三个参数而 R-F13 只给了一个）。
// 故这里断言的是"变量存在且是那个值"+"组件确实引用变量而不是写死 px"。
//
// ⚠️⚠️ **切片必须有下界**（Task ⑩ 实测踩到，教训抄自 media/MediaDetailPage.test.tsx）：
// styles.css 是**追加式**的。用 `slice(i)` 一路切到文件尾的话，本段后面每加一段新页面
// 样式都会被静默吞进"活动页段"，守卫的作用域随文件增长而漂移（那次的表现是假红）。
// 本段目前是最后一段，故 NEXT_SECTION_MARKERS 为空——**新增页面段时必须把它的段首
// 选择器加进去**。为此下面有一条自检用例：本段真的是最后一段吗？
import { describe, it, expect } from 'vitest'

declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 下一个页面段的段首。**在 styles.css 尾部追加新段的人必须把段首选择器加进来**——
 *  下面那条自检用例就是为此存在的（终局审计 🔴-1 追加了守备目录健康度段，
 *  这个数组第一次真的派上用场）。提到 IIFE 外面是为了让自检用例也能读到它，
 *  否则自检只能硬编码一份同样的名单，两份必然漂移。 */
const NEXT_SECTION_MARKERS: string[] = ['.root-health-line {']

/** 活动页那一段 CSS 的**代码部分**（先剥全文注释，再从代码里切段——顺序不能反，
 *  否则会切出半截注释而扫描时命中自己的注释文字）。 */
const WB_CSS = (() => {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const i = bare.indexOf('.wb-tabs {')
  if (i < 0) return ''
  const rest = bare.slice(i)
  const ends = NEXT_SECTION_MARKERS.map((m) => rest.indexOf(m)).filter((n) => n >= 0)
  return ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest
})()

function decl(selector: string, prop: string): string | null {
  const re = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${re}\\s*\\{([^}]*)\\}`).exec(WB_CSS)?.[1]
  if (!block) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(block)
  return m ? m[1]!.trim() : null
}

describe('切片自检（防"守卫作用域随文件增长而漂移"）', () => {
  it('活动页段真的被切出来了，且规模合理（切空会让下面全部恒绿）', () => {
    expect(CSS.length).toBeGreaterThan(1000)
    expect(WB_CSS.length).toBeGreaterThan(500)
    expect(WB_CSS).toContain('.wb-run-card')
    expect(WB_CSS).toContain('.wb-queue-card')
  })

  it('🔴 活动页段之后的每一个新段都已登记下界——没登记的会让守卫扫到别人的样式', () => {
    // 这条是 NEXT_SECTION_MARKERS 的**可执行前提**。有人在文件尾追加了新页面段而没加标记时，
    // 本条会红，提示他去补——而不是让下面的守卫悄悄开始扫描别人的样式。
    //
    // ⚠️ 判据从"本段是最后一段"改成"越界的段都已登记"（终局审计 🔴-1 追加了守备目录
    // 健康度段之后的必然演进）：切片已经在 NEXT_SECTION_MARKERS 处截断，所以真正要守的
    // 不是"后面没有东西"，而是"后面的东西都在名单里"。仍旧改一行 CSS 就会红。
    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const after = bare.slice(bare.indexOf('.wb-tabs {'))
    // 已登记的下界之后的内容不算越界——它已经被切掉了，守卫扫不到。
    const ends = NEXT_SECTION_MARKERS.map((m) => after.indexOf(m)).filter((n) => n >= 0)
    const inSlice = ends.length > 0 ? after.slice(0, Math.min(...ends)) : after
    // 允许的选择器前缀：本段自己的 .wb-*。出现别的顶层页面段前缀就说明有人在**切片内部**
    // 追加了新段（而不是在下界之后）。
    const selectors = [...inSlice.matchAll(/^\.([a-z0-9-]+)/gim)].map((m) => m[1]!)
    const foreign = [...new Set(selectors)].filter((s) => !s.startsWith('wb-'))
    expect(foreign, `活动页段里混进了别的页面段：${foreign.join(', ')} —— 请给 NEXT_SECTION_MARKERS 加下界`).toEqual([])
    // 下界本身必须真的在文件里——名单里写了个不存在的选择器时，切片会退化成"切到文件尾"，
    // 而这条自检会假绿。
    for (const m of NEXT_SECTION_MARKERS) {
      expect(bare.includes(m), `下界 ${m} 在 styles.css 里不存在（切片会退化成切到文件尾）`).toBe(true)
    }
  })
})

describe('R-F13：尺寸走 CSS 变量（移动端只改变量、不改组件）', () => {
  it('四个几何变量都在 :root 上，且是 R-F13 给的那几个值', () => {
    // 这些数字来自设计文档 §六·八，不是排版偏好——见文件头。
    const root = /:root\s*\{([^}]*--card-run-h[^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(root).toMatch(/--card-run-h:\s*186px/)
    expect(root).toMatch(/--card-run-img:\s*60%/)
    expect(root).toMatch(/--card-queue-w:\s*59px/)
    expect(root).toMatch(/--card-queue-h:\s*88px/)
    expect(root).toMatch(/--card-queue-fade:\s*118px/)
  })

  it('🔴 组件引用变量而**不是写死 px**（写死了移动端那一轮就得改组件）', () => {
    expect(decl('.wb-run-card', 'height')).toBe('var(--card-run-h)')
    expect(decl('.wb-run-img', 'width')).toBe('var(--card-run-img)')
    expect(decl('.wb-queue-card', 'height')).toBe('var(--card-queue-h)')
    expect(decl('.wb-queue-img', 'width')).toBe('var(--card-queue-w)')
  })

  it('🔴 **不许出现 clamp()**（三轮审计 🔵：R-F13 只给了一个值，clamp 要三个）', () => {
    expect(WB_CSS).not.toContain('clamp(')
  })

  it('排队卡片的渐变区是图宽的两倍（118 vs 59）——那是 R-F13 的原话', () => {
    const w = /--card-queue-w:\s*(\d+)px/.exec(CSS)?.[1]
    const fade = /--card-queue-fade:\s*(\d+)px/.exec(CSS)?.[1]
    expect(Number(fade)).toBe(Number(w) * 2)
  })
})

describe('R-F13：渐变终点是 surface 实色，不是半透明黑', () => {
  // 决定 1 的原话：「渐变终点用 surface-1 实色，不是半透明黑——右半区底色与普通卡片
  // 完全一致，文字对比度稳定，不会因背后有图而发飘」。
  it('🔴 两个渐变的终点色都是 var(--color-card)（本仓真实存在的那个 token）', () => {
    const run = decl('.wb-run-fade', 'background') ?? ''
    const queue = decl('.wb-queue-fade', 'background') ?? ''
    expect(run).toContain('var(--color-card)')
    expect(queue).toContain('var(--color-card)')
    // 终点若是 rgba(...) 就是半透明黑那条被否掉的路
    expect(run).toMatch(/var\(--color-card\)\s+var\(--card-run-img\)/)
  })

  it('🔴 **不引用 DESIGN.md 那套 surface-* token**（本仓 grep 零命中，会静默 fallback 成透明）', () => {
    // Task ⑦ 的实施者踩过：写 var(--color-surface-1, transparent) 不报错，只是透明。
    expect(WB_CSS).not.toMatch(/--color-surface-\d/)
    expect(WB_CSS).not.toMatch(/--color-hairline/)
  })

  it('无图降级时渐变层塌成纯实色（不留一道说不清的暗角）', () => {
    expect(WB_CSS).toMatch(/\[data-noimg='true'\][\s\S]*?\{[^}]*background:\s*var\(--color-card\)/)
  })
})

describe('R-F11：Linear 视觉基准——拒绝投影', () => {
  it('🔴 活动页段里没有任何 box-shadow / drop-shadow', () => {
    // DESIGN.md：深度靠四层 surface 阶梯 + 三层 hairline 承载，深色上几乎完全拒绝投影。
    expect(WB_CSS).not.toContain('box-shadow')
    expect(WB_CSS).not.toContain('drop-shadow')
  })

  it('卡片边框走发丝线 token（--color-border），不是硬编码颜色', () => {
    expect(decl('.wb-run-card', 'border')).toContain('var(--color-border)')
    expect(decl('.wb-queue-card', 'border')).toContain('var(--color-border)')
  })

  it('tab 选中态靠下划线 + accent，**不用底色药丸**（药丸是 status-badge 的语言）', () => {
    const sel = new RegExp(`\\.wb-tab\\[aria-selected='true'\\]\\s*\\{([^}]*)\\}`).exec(WB_CSS)?.[1] ?? ''
    expect(sel).toContain('border-bottom-color')
    expect(sel).toContain('var(--color-accent)')
    expect(sel).not.toMatch(/(?:^|;)\s*background/)
  })
})
