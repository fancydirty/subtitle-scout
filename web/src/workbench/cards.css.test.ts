// web/src/workbench/cards.css.test.ts —— B 切分几何与 R-F11 的"拒绝投影"。
//
// ── 为什么这些断言值得存在 ────────────────────────────────────────────────
// 活动页在跑卡走 B 切分：左栏 16:9 backdrop（宽走 --card-split-poster: 61%），
// 右栏实色排字。不定高——变量宽不能把静帧横向拉长。
// **排队卡（.wb-queue-card）2026-08-18 起脱离这套「宽 → 高」**：它右栏只有
// 片名 + 一行副标题，与通知行同量级，被 B 切分撑到与在跑卡一样高（~390px）
// 是错的——用户裁决「收成通知页的那种大小状态」，即恒定高 96px + 海报高推宽
// ≈171px + 右栏 normal flow，几何与通知卡（notif-card.css.test.ts 守）完全同套。
// 在跑卡仍走 B 切分「宽 → 高」（右栏有进度条 + 步骤 + 5 行 log，需要那个高度）。
// 旧 R-F13 数字（60% / 186px / 59px / 88px / 118px）和「在跑用横版、排队用竖版」
// 是这些测试现在**禁止**的历史，不是现行法。
//
// ── 为什么走 CSS 变量而不是断言组件里的内联样式 ────────────────────────────
// 移动端那一轮**在 media query 里改变量值、不改组件**，且**不许用 clamp()**。
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

/** 同 `decl`，但扫全文（剥注释）。`.media-legend` 在 `.wb-tabs` 之前，WB_CSS 切不到。 */
function declFromFullCss(selector: string, prop: string): string | null {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${re}\\s*\\{([^}]*)\\}`).exec(bare)?.[1]
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

describe('B 切分：左 16:9 + 右实色（覆盖 R-F13 固定高度 / 2:3 排队）', () => {
  it('唯一几何变量 --card-split-poster 在 :root 上，值为 61%', () => {
    const root = /:root\s*\{([^}]*--card-split-poster[^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(root).toMatch(/--card-split-poster:\s*61%/)
    expect(CSS).not.toMatch(/--card-run-h\s*:/)
    expect(CSS).not.toMatch(/--card-run-img\s*:/)
    expect(CSS).not.toMatch(/--card-queue-w\s*:/)
    expect(CSS).not.toMatch(/--card-queue-h\s*:/)
    expect(CSS).not.toMatch(/--card-queue-fade\s*:/)
  })

  it('在跑图宽走变量、锁 16/9，不定高', () => {
    expect(decl('.wb-run-img', 'width')).toBe('var(--card-split-poster)')
    expect(decl('.wb-run-img', 'aspect-ratio')).toMatch(/16\s*\/\s*9/)
    const h = decl('.wb-run-card', 'height')
    expect(h === null || h === 'auto').toBe(true)
    expect(h ?? '').not.toMatch(/\d+px/)
    expect(decl('.wb-run-card', 'display')).toBe('flex')
    expect(declFromFullCss('.notif-row.wb-run-card', 'gap')).toBe('0')
  })

  it('mask 朝右溶进右栏，不是 to left，也不是 overlay fade', () => {
    const img = new RegExp('\\.wb-run-img\\s*\\{([^}]*)\\}').exec(WB_CSS)?.[1] ?? ''
    expect(img).toContain('mask-image')
    expect(img).toContain('-webkit-mask-image')
    expect(img).toContain('to right')
    expect(img).not.toContain('to left')
    expect(WB_CSS).not.toContain('.wb-queue-fade')
    expect(WB_CSS).not.toContain('.wb-run-fade')
    expect(WB_CSS).not.toContain('.notif-hero-compact')
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('.notif-hero-compact')
  })

  it('右栏 overflow hidden + text-align right；无图改左对齐', () => {
    expect(decl('.wb-run-body', 'overflow')).toBe('hidden')
    expect(decl('.wb-run-body', 'text-align')).toBe('right')
    expect(decl('.wb-run-body', 'width')).not.toBe('46%')
    expect(decl('.wb-run-body', 'position')).toBe('absolute')
    expect(decl('.wb-run-body', 'left')).toBe('var(--card-split-poster)')
    expect(decl(".wb-run-card[data-noimg='true'] .wb-run-body", 'position')).toBe('relative')
    expect(WB_CSS).toMatch(/\[data-noimg='true'\][\s\S]*?text-align:\s*left/)
  })

  it('排队无图重置打在 .wb-run-body（SplitHero 不再渲染 .wb-queue-body）', () => {
    expect(WB_CSS).toContain(".wb-queue-card[data-noimg='true'] .wb-run-body")
    const idx = WB_CSS.indexOf(".wb-queue-card[data-noimg='true'] .wb-run-body")
    const block = /\{([^}]*)\}/.exec(WB_CSS.slice(idx))?.[1] ?? ''
    expect(block).toContain('position: relative')
    expect(block).toContain('text-align: left')
  })

  it('🔴 **不许出现 clamp()**', () => {
    expect(WB_CSS).not.toContain('clamp(')
  })
})

describe('排队卡：恒定高 96px + 海报 16:9（高 → 宽，2026-08-18 与通知卡同一套几何）', () => {
  // 排队右栏只有片名 + 一行副标题——与通知行（时钟+片名+副标题+CTA）同量级。
  // 此前排队与在跑共用 B 切分「宽 61% → 16:9 撑高」，两行字被撑到 ~390px，
  // 与在跑卡一样大。用户 2026-08-18 裁决：排队收成通知页那种恒定高小卡。
  it('🔴 排队卡高度 = var(--notif-card-h)（与通知卡共用），不是不定高', () => {
    expect(decl('.wb-queue-card', 'height')).toBe('var(--notif-card-h)')
  })

  it('排队海报：height:100% + width:auto + 16:9——高推宽 ≈171px，不走 61%', () => {
    expect(decl('.wb-queue-card .wb-run-img', 'width')).toBe('auto')
    expect(decl('.wb-queue-card .wb-run-img', 'height')).toBe('100%')
    expect(decl('.wb-queue-card .wb-run-img', 'aspect-ratio')).toMatch(/16\s*\/\s*9/)
  })

  it('🔴 排队右栏 normal flow（relative + flex:1 + inset:auto），不是 absolute', () => {
    // 海报只有 ~171px，右栏必须 normal flow 紧贴海报右侧——absolute + left:61%
    // 会在 171px 海报与 61% 左边界之间留出巨大空档（通知卡同日修过同一个坑）。
    expect(decl('.wb-queue-card .wb-run-body', 'position')).toBe('relative')
    expect(decl('.wb-queue-card .wb-run-body', 'flex')).toBe('1')
    expect(decl('.wb-queue-card .wb-run-body', 'inset')).toBe('auto')
  })

  it('🔴 排队右栏左对齐从顶部排（text-align:left + justify-content:flex-start）', () => {
    // 与通知卡同一节奏；也终结此前「有图右对齐 / 无图左对齐」的分裂——
    // 排队卡有没有图从此是同一种排法。
    expect(decl('.wb-queue-card .wb-run-body', 'text-align')).toBe('left')
    expect(decl('.wb-queue-card .wb-run-body', 'align-items')).toBe('flex-start')
    expect(decl('.wb-queue-card .wb-run-body', 'justify-content')).toBe('flex-start')
  })
})

describe('B 切分：实色栏与 legend', () => {
  it('🔴 .media-legend 宽度 100%', () => {
    expect(declFromFullCss('.media-legend', 'width')).toBe('100%')
  })

  it('🔴 **不引用 DESIGN.md 那套 surface-* token**', () => {
    expect(WB_CSS).not.toMatch(/--color-surface-\d/)
    expect(WB_CSS).not.toMatch(/--color-hairline/)
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
