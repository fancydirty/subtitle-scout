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

/** tw.css 原文——token 的**定义方**。下面「引用的 token 真的存在」那条守卫要用。 */
declare const __TW_CSS__: string
const TW_CSS = __TW_CSS__

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
    // 🔴 fade 起点锁 40%（2026-08-18 用户裁决：「渐变遮罩再往左延伸一点，要水乳交融」）。
    // 旧值 58%：实心海报占 58%、fade 只占 42%，淡出又晚又急，海报与右栏实色之间
    // 是「贴上去」不是「融进去」。40% 起溶 → fade 占海报 60%，过渡带更长更缓。
    // 终点必须钉 100%：海报右缘（= 文字栏左界）必须完全透明，否则那里会露一条海报硬边。
    expect(img).toContain('#000 40%')
    expect(img).toContain('transparent 100%')
    expect(img).not.toContain('#000 58%')
    expect(WB_CSS).not.toContain('.wb-queue-fade')
    expect(WB_CSS).not.toContain('.wb-run-fade')
    expect(WB_CSS).not.toContain('.notif-hero-compact')
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('.notif-hero-compact')
  })

  it('🔴 .wb-queue-img 与 .wb-run-img 的 mask 同值（两块是刻意复制的孪生块，不许漂移）', () => {
    // SplitHero 现在只渲染 wb-run-img，wb-queue-img 是历史孪生块；但只要它还在文件里，
    // 就必须和 wb-run-img 逐字一致——将来谁复活它时两页的溶接手感才不会悄悄分叉。
    const run = new RegExp('\\.wb-run-img\\s*\\{([^}]*)\\}').exec(WB_CSS)?.[1] ?? ''
    const queue = new RegExp('\\.wb-queue-img\\s*\\{([^}]*)\\}').exec(WB_CSS)?.[1] ?? ''
    expect(queue).toContain('mask-image')
    const runMask = /mask-image:\s*([^;]+)/.exec(run)?.[1] ?? ''
    const queueMask = /mask-image:\s*([^;]+)/.exec(queue)?.[1] ?? ''
    expect(queueMask).toBe(runMask)
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

  it('🔴 排队卡海报**不带 mask**——171px 小海报禁不起渐变溶接（同通知卡）', () => {
    // mask 是 ~700px 宽在跑海报的语言；小海报上渐变要么吃掉大半张图（40% 版）
    // 要么硬过渡（58% 版），都试过不行（2026-08-18 用户裁决「不如不要这个遮罩了」）。
    // 硬边 + 右栏实色才是小卡的干净形态。在跑卡保留 mask（见上面那条 40% 的锁）。
    expect(decl('.wb-queue-card .wb-run-img', 'mask-image')).toBe('none')
    expect(decl('.wb-queue-card .wb-run-img', '-webkit-mask-image')).toBe('none')
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

// ── 2026-08-22 视觉验收抓到的"隐形元素" ────────────────────────────────────
// 步骤条与 cue 进度条当初写成了 var(--color-accent)。那个 token 在新栈里是 #16181f
// （近黑），画在深色在跑卡上等于隐形——实测计算样式：done/active 的标签是
// rgb(22,24,31)，比**未点亮**的 --color-weak 还暗，用户看到的是"当前步骤最不显眼"。
// styles.css 里有七八处注释在反复警告这个坑（cmdk-trigger、focus ring……），
// 这条用例把那些注释变成机器可判的守卫。
//
// 为什么不整段禁用 --color-accent：tab 选中态的下划线**应该**用它（上一条用例在守），
// 那里是细线不是色块，且不在卡片的深色面上。故只钉在跑卡里画色块/文字的这几个选择器。
describe('在跑卡上的元素不许用 --color-accent（新栈近黑 = 隐形）', () => {
  const INK_ON_CARD = [
    '.wb-stage-node.done .wb-stage-dot',
    '.wb-stage-node.active .wb-stage-dot',
    '.wb-stage-node.done .wb-stage-label',
    '.wb-stage-node.active .wb-stage-label',
    '.wb-cue-bar-fill',
    '.wb-stage-node.done:not(:last-child)::after',
  ]
  for (const sel of INK_ON_CARD) {
    it(`🔴 ${sel} 不引用 --color-accent`, () => {
      const body = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:,[^{]*)?\\{([^}]*)\\}`).exec(WB_CSS)?.[1]
      expect(body, `选择器 ${sel} 在活动页段里找不到——改名了就把这条一起改`).toBeTruthy()
      expect(body).not.toContain('var(--color-accent)')
    })
  }

  it('🔴 进行中的节点比已完成的更显眼（active 有 font-weight，done 没有）', () => {
    const active = new RegExp(`\\.wb-stage-node\\.active \\.wb-stage-label\\s*\\{([^}]*)\\}`).exec(WB_CSS)?.[1] ?? ''
    const done = new RegExp(`\\.wb-stage-node\\.done \\.wb-stage-label\\s*\\{([^}]*)\\}`).exec(WB_CSS)?.[1] ?? ''
    expect(active).toMatch(/font-weight/)
    expect(done).not.toMatch(/font-weight/)
  })

  it('🔴 cue 条自己呼吸，不靠选不中的 .wb-stage-node.active ~ 兄弟选择器', () => {
    expect(decl('.wb-cue-bar', 'animation')).toMatch(/wb-bar-breathe/)
    expect(WB_CSS).not.toContain('.wb-stage-node.active ~ .wb-cue-progress')
  })
})

// ── 2026-08-26 视觉验收抓到的「四个节点同显一个词」 ────────────────────────
// 步骤条节点当初写成 `flex: 1`，它展开是 `1 1 0%`：flex-basis 0 让四格恒等宽 25%，
// 不管文案多长。窄卡上标签立刻撞到 .wb-stage-label 的 nowrap + ellipsis，中文
// 「正在下载 / 正在看候选 / 正在安装」共同前缀一被截断，三个节点退化成同一个字符串
// ——用户看不出这一轮跑到哪了。词条那半（wb_node_*）由 WorkbenchCards.test.tsx 守；
// **CSS 那半在这里**：jsdom 不排版，测不到 ellipsis，但能钉住 flex-basis 不是 0。
describe('步骤条节点按文案宽度排（flex-basis 不许是 0，否则长标签被无声截断）', () => {
  it('🔴 .wb-stage-node 的 flex 是 1 1 auto，不是 1 / 1 1 0% / 1 1 0', () => {
    const flex = decl('.wb-stage-node', 'flex')
    expect(flex, '.wb-stage-node 的 flex 声明不见了——改名或删了就把这条一起改').toBeTruthy()
    // basis 必须是 auto。`flex: 1`（= 1 1 0%）和显式的 0/0% 都是被修掉的那个形态。
    expect(flex).toBe('1 1 auto')
  })

  it('🔴 连线伪元素才是吃剩余空间的那个（flex:1 + min-width 兜底，不许被节点抢走）', () => {
    // 节点让出剩余空间的前提是连线自己会长。连线若也变成 auto/0，节点又会去分空间。
    expect(decl('.wb-stage-node:not(:last-child)::after', 'flex')).toBe('1')
    expect(decl('.wb-stage-node:not(:last-child)::after', 'min-width')).toMatch(/^\d+px$/)
  })

  it('🔴 标签仍留着 ellipsis 兜底 + min-width:0（窄到没办法时才截，且不撑破 bar）', () => {
    expect(decl('.wb-stage-label', 'text-overflow')).toBe('ellipsis')
    expect(decl('.wb-stage-label', 'white-space')).toBe('nowrap')
    expect(decl('.wb-stage-node', 'min-width')).toBe('0')
  })
})

// ── 拼错的 token 名不会报错，只会静默失效 ──────────────────────────────────
// CSS 的自定义属性没有拼写检查：`var(--color-fg)` 在 --color-fg 从未定义时既不报错
// 也**不回退**到低优先级的那条声明，而是 IACVT（invalid at computed-value time）
// → 该属性取继承值。color 是继承属性，多数元素因此拿到 body 的 --color-foreground，
// 看起来「碰巧是对的」，错误只在父级另设了 color 的地方现形：.wb-run-log-latest 的父
// .wb-run-log 设了 --color-weak，最新一行本该提亮成前景色，实际继承成了暗灰。
// 真身是 --color-foreground（tw.css 定义，styles.css 另有 20 处在用）。
describe('styles.css 引用的每个 --color-* token 都真的有定义（拼错不会报错，只会静默失效）', () => {
  const DEFINED = new Set(
    [...`${TW_CSS}\n${CSS}`.matchAll(/--(color-[a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
  )

  it('🔴 定义方读到了（读空会让本段恒绿）', () => {
    expect(TW_CSS.length).toBeGreaterThan(500)
    expect(DEFINED.has('color-foreground')).toBe(true)
    expect(DEFINED.has('color-weak')).toBe(true)
  })

  it('🔴 没有未定义的 --color-* 被引用（曾经的 --color-fg 就是这样溜进来的）', () => {
    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const used = [...bare.matchAll(/var\(\s*--(color-[a-z0-9-]+)/g)].map((m) => m[1]!)
    const missing = [...new Set(used)].filter((t) => !DEFINED.has(t))
    expect(
      missing,
      `styles.css 引用了未定义的 token：${missing.map((t) => `--${t}`).join(', ')} —— ` +
        '它们不会报错，只会让该属性取继承值（IACVT）。检查是不是拼错了 tw.css 里的名字。',
    ).toEqual([])
  })

  it('🔴 --color-fg 这个拼错的名字不再出现（真身是 --color-foreground）', () => {
    expect(CSS).not.toMatch(/--color-fg\b/)
  })
})

// ── 全局滚动条 DNA 化（2026-08-28，Hero D 同批裁决）──────────────────────────
// 滚动条样式是全局底盘件，写在 styles.css 顶部（在 .wb-tabs 段之前，不进 WB_CSS 切片）。
// 照本文件"钉 CSS 计算值"的既有先例钉两条：① Firefox 引擎（scrollbar-width/color）
// ② WebKit 引擎（thumb 常态/悬停色 + 圆角 + 轨道透明）。删任一条或改色都会红。
describe('全局滚动条：thin + 双引擎 + thumb .14/悬停 .22 + 圆角 + 轨道透明', () => {
  it('🔴 Firefox 引擎：html 上 scrollbar-width:thin + scrollbar-color（thumb .14 / 轨道透明）', () => {
    expect(declFromFullCss('html', 'scrollbar-width')).toBe('thin')
    const color = declFromFullCss('html', 'scrollbar-color')
    expect(color, 'html 没有 scrollbar-color——Firefox 会退回系统默认粗滚动条').toBeTruthy()
    expect(color).toContain('rgba(255, 255, 255, 0.14)')
    expect(color).toContain('transparent')
  })

  it('🔴 WebKit 引擎：thumb 常态 .14 / 悬停 .22 + 圆角，轨道透明', () => {
    expect(declFromFullCss('::-webkit-scrollbar-thumb', 'background')).toBe('rgba(255, 255, 255, 0.14)')
    expect(declFromFullCss('::-webkit-scrollbar-thumb:hover', 'background')).toBe('rgba(255, 255, 255, 0.22)')
    const radius = declFromFullCss('::-webkit-scrollbar-thumb', 'border-radius')
    expect(radius, 'thumb 没有圆角').toBeTruthy()
    expect(declFromFullCss('::-webkit-scrollbar-track', 'background')).toBe('transparent')
  })
})

// ── Hero backdrop 两档裁切 + B 曲线渐隐（2026-08-29 用户裁决）───────────────────
// ① mask 停点禁 calc（Chromium 时机敏感塌零 bug，2026-08-29 真机钉死）——B 曲线为
//    easeInOutSine 九停点（8×rgba + 1×#000），渐隐区占图高 38%，两端零导数无折痕。
// ② 宽屏 32:9 + object-position 50% 30%（裁切窗上移保头顶）；420px 封顶已退役。
// ③ 手机（既有 640px 断点）：素材由组件层换 poster（<picture>），比例 2:3、
//    object-position 回 center。declFromFullCss 只取首个规则块，手机档在第二个块里，
//    这里用本地 allBlocksOf 拿全部同名块按序断言。
function allBlocksOf(selector: string): string[] {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g')
  return [...bare.matchAll(re)].map((m) => m[1]!)
}

describe('Hero backdrop：B 曲线 mask（38% 九停点无 calc）+ 宽 32:9 / 手机 2:3 两档', () => {
  it('🔴 mask 双引擎均为 to top 百分比停点、含 38% 终点、9 停点、不含 calc', () => {
    for (const prop of ['mask-image', '-webkit-mask-image']) {
      const v = declFromFullCss('.media-detail-hero-backdrop', prop)
      expect(v, `${prop} 缺失——底缘渐隐没了`).toBeTruthy()
      expect(v).toContain('to top')
      expect(v).toContain('38%')
      expect(v, `${prop} 用了 calc——Chromium mask 停点 calc 百分比解析塌零，整图会被遮`).not.toContain('calc')
      expect((v!.match(/rgba\(/g) ?? []).length, '停点数变了——easeInOutSine 曲线被动过').toBe(8)
    }
  })

  it('🔴 宽屏默认档：32:9 + cover + object-position 50% 30%，420px 封顶已退役', () => {
    const base = allBlocksOf('.media-detail-hero-backdrop')[0]!
    expect(base).toContain('aspect-ratio: 32 / 9')
    expect(base).toContain('object-fit: cover')
    expect(base).toContain('object-position: 50% 30%')
    expect(base, 'max-height 该退役了——比例本身管住高度').not.toContain('max-height')
  })

  it('🔴 手机档（第二个规则块，640px 断点内）：2:3 + object-position 回 center', () => {
    const blocks = allBlocksOf('.media-detail-hero-backdrop')
    expect(blocks.length, '手机档规则块缺失').toBeGreaterThanOrEqual(2)
    expect(blocks[1]).toContain('aspect-ratio: 2 / 3')
    expect(blocks[1]).toContain('object-position: center')
  })
})
