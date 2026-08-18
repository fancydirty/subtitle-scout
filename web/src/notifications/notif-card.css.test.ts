// web/src/notifications/notif-card.css.test.ts —— 通知卡「恒定高 → 海报 16:9」几何锁。
//
// ── 为什么独立一个文件 ─────────────────────────────────────────────────
// 2026-08-18 的 SplitHero B 切分（cards.css.test.ts 守的那一套）让通知行复用
// 在跑卡的「宽 → 高」推导：左栏 width:61% × aspect-ratio:16/9 把卡片撑到 ~390px。
// 在活动页那是对的（右栏有进度条 + 步骤 + 5 行 log）；在通知页是错的（只有
// 时钟 + 片名 + 一行副标题 + ghost 按钮）。用户 2026-08-18 实测：一条「黑暗智宅」
// 把卡片撑到 ~400px。
//
// 用户裁决（字面原文）：「卡片高度恒定，只是让海报本身的比例保持 16:9 而已」。
// 「显示器宽度变化不会影响海报和文字的排布，只会影响『去片库看』和标题间的距离。」
//
// 即通知行从「宽 → 高」反转为「高 → 宽」：
//   · 卡片高 = var(--notif-card-h) = 96px（恒定，与视口宽度无关）
//   · 海报 height:100% × aspect-ratio:16/9 → 宽 ≈ 171px（恒定，与视口宽度无关）
//   · 右栏左边界 = 海报实际宽（calc），不再 61%
//   · 视口变宽时只改变右栏弹性宽（标题与「去片库看」之间的距离），海报尺寸不变
//
// 活动页的 .wb-run-card / .wb-queue-card **不动**（cards.css.test.ts 继续守那边）。
// 两套几何共存：SplitHero 组件复用，CSS 选择器分别钉。
import { describe, it, expect } from 'vitest'

declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 剥注释后查某选择器的某条声明。扫全文（通知段不在 cards.css.test.ts 切的 WB_CSS 里）。 */
function decl(selector: string, prop: string): string | null {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${re}\\s*\\{([^}]*)\\}`).exec(bare)?.[1]
  if (!block) return null
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(block)
  return m ? m[1]!.trim() : null
}

describe('切片自检', () => {
  it('CSS 常量真的注入了，且通知段在其中', () => {
    expect(typeof CSS).toBe('string')
    expect(CSS.length).toBeGreaterThan(1000)
    expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).toContain('.notif-row.wb-run-card')
  })
})

describe('通知卡：恒定高 96px + 海报 16:9（高 → 宽）', () => {
  it(':root 上有 --notif-card-h: 96px', () => {
    const root = /:root\s*\{([^}]*--notif-card-h[^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(root).toMatch(/--notif-card-h:\s*96px/)
  })

  it('🔴 通知卡高度 = var(--notif-card-h)，**不是** auto、不是任何 px 写死', () => {
    const h = decl('.notif-row.wb-run-card', 'height')
    expect(h).toBe('var(--notif-card-h)')
    expect(h).not.toBe('auto')
    expect(h ?? '').not.toMatch(/^\d+px$/)
  })

  it('通知卡海报：height:100% + width:auto + aspect-ratio:16/9（高推宽）', () => {
    expect(decl('.notif-row.wb-run-card .wb-run-img', 'height')).toBe('100%')
    expect(decl('.notif-row.wb-run-card .wb-run-img', 'width')).toBe('auto')
    expect(decl('.notif-row.wb-run-card .wb-run-img', 'aspect-ratio')).toMatch(/16\s*\/\s*9/)
  })

  it('🔴 通知卡海报宽**不走** --card-split-poster（61% 是活动页的，不是通知的）', () => {
    const w = decl('.notif-row.wb-run-card .wb-run-img', 'width')
    expect(w).not.toBe('var(--card-split-poster)')
    expect(w ?? '').not.toMatch(/%$/)
  })

  it('右栏左边界 = 海报实际宽（calc(96px × 16/9) ≈ 171px），不是 61%', () => {
    const l = decl('.notif-row.wb-run-card .wb-run-body', 'left')
    // normal flow 下 left 不再生效，但保留这条断言防回退：如果谁把 position 改回 absolute，
    // left 必须仍是 calc 而不是 var(--card-split-poster)。
    expect(l === null || l === 'calc(var(--notif-card-h) * 16 / 9)').toBe(true)
  })

  it('🔴 通知行右栏**不用 absolute**——normal flow 才是通知行的正确形态', () => {
    // 事故（2026-08-18 用户截图）：absolute 定位的 right:0 把内容顶到卡片 border-box
    // 右缘，border-radius 裁掉了「21:35」的右上角。padding 只推了 16px 但 top:0 仍在
    // 圆角裁切区。活动页需要 absolute 是因为右栏要覆盖在海报 mask 上；通知行海报
    // 只有 ~171px，右栏从 171px 开始，根本不需要 absolute——normal flow 的 flex:1
    // 才是它的正确形态（同活动页 data-noimg='true' 的降级）。
    expect(decl('.notif-row.wb-run-card .wb-run-body', 'position')).toBe('relative')
    expect(decl('.notif-row.wb-run-card .wb-run-body', 'flex')).toBe('1')
    expect(decl('.notif-row.wb-run-card .wb-run-body', 'inset')).toBe('auto')
  })

  it('🔴 右栏**左对齐**（text-align:left + align-items:flex-start）——mockup 承诺的', () => {
    // 2026-08-18 用户裁决：visual companion mockup 是「左对齐文字 + 右端按钮」，
    // 代码却写成了全右对齐。这是实现与承诺不一致。
    expect(decl('.notif-row.wb-run-card .wb-run-body', 'text-align')).toBe('left')
    expect(decl('.notif-row.wb-run-card .wb-run-body', 'align-items')).toBe('flex-start')
  })

  it('🔴 「去片库看」单独右端（margin-left:auto），不跟文字一起左对齐', () => {
    // mockup：时钟/标题/副标题从左开始，「去片库看」单独在右端——中间有呼吸空间。
    // 实现：NotificationRow 里给按钮 span 加 class="notif-row-cta"，CSS 里 margin-left:auto。
    expect(decl('.notif-row-cta', 'margin-left')).toBe('auto')
  })

  it('🔴 右栏有 padding——时间戳/标题/按钮不许顶到卡片右缘', () => {
    // 事故（2026-08-18 用户截图）：「21:35」被切了一半。absolute 定位的 right:0
    // 把内容顶到卡片最右缘，border-radius 裁掉了时间戳的右边。活动页 .wb-run-body
    // 有 padding:14px 16px，通知行漏了这条——absolute 定位不会继承父级的 padding。
    const p = decl('.notif-row.wb-run-card .wb-run-body', 'padding')
    expect(p).toBe('14px 16px')
  })

  it('🔴 不许出现 --notif-card-w（宽度是推出来的，不能再起一个变量把它写死）', () => {
    expect(CSS).not.toMatch(/--notif-card-w\s*:/)
  })
})

describe('反向禁令：活动页卡的几何不许被通知卡污染', () => {
  it('活动页 .wb-run-card 仍 height:auto（不定高）', () => {
    // 注意这条断言的切片：.wb-run-card 单独出现的那一条规则，不是 .notif-row.wb-run-card。
    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    // 用「行首 .wb-run-card」锚定，避免误中 .notif-row.wb-run-card。
    const block = new RegExp(`^\\.wb-run-card\\s*\\{([^}]*)\\}`, 'm').exec(bare)?.[1] ?? ''
    expect(block).not.toMatch(/height\s*:\s*\d+px/)
    // 活动页卡没有显式 height（即 auto），这里只锁它没被人写成固定 px。
  })

  it('活动页 .wb-run-img 仍 width: var(--card-split-poster)', () => {
    const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const block = new RegExp(`^\\.wb-run-img\\s*\\{([^}]*)\\}`, 'm').exec(bare)?.[1] ?? ''
    expect(block).toMatch(/width\s*:\s*var\(--card-split-poster\)/)
  })
})
