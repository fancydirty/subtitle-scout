// web/src/media/EpisodeMark.test.tsx：八态符号的**几何**守卫（R-F12 / Carbon 双通道）。
//
// ── 为什么这个文件必须断言几何，而不是"渲染了一个 svg" ─────────────────────────
// Task ⓪ 的教训：4 条测试全绿，把 7 个生产写入点删光测试无一变红。这里的同型是
// 「断言 `container.querySelector('svg')` 非空」——把 covered 的 ✓ 画成 ◇ 照样绿，
// 而那正是这个组件唯一能出的错（映射错态 → 用户看到与事实相反的标记）。
//
// 所以本文件的判据是：**每个态的 path/circle 数据本身**，以及**七个态两两不同**。
// 前者钉住"这个态画的是不是那个符号"，后者钉住 Carbon 双通道（不许两个态共用同一图形
// 只换颜色——那就退化成只靠颜色，对色盲无效）。
//
// ── 为什么不用快照 ────────────────────────────────────────────────────────
// toMatchSnapshot 会在有人改坏时"友好地"提示 -u，而 -u 是一键把红改绿的按钮。
// 逐态显式断言让"改坏"与"改对"必须由人分辨。
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { EpisodeMark, type MarkState } from './EpisodeMark.js'
import type { EpisodeState } from '../api/types.js'

afterEach(cleanup)

/** 八态全集——**从这里派生**遍历用例，而不是手抄一份列表：后端加第九态时
 *  api/types.ts 的联合会变，但这个数组不会自动跟着变，所以下面还有一条
 *  "数组恰好等于类型联合"的编译期守卫（ALL_STATES 的类型标注）。 */
const ALL_STATES: readonly EpisodeState[] = [
  'covered', 'translating', 'unsolvable', 'origin-skip',
  'embedded', 'pending', 'unjudged', 'absent',
]
/** 编译期穷尽守卫：漏一个态 / 多一个不存在的态 → tsc 报错（vitest 不查类型，两个 tsc 查）。 */
const _exhaustive: Record<EpisodeState, true> = {
  covered: true, translating: true, unsolvable: true, 'origin-skip': true,
  embedded: true, pending: true, unjudged: true, absent: true,
}
void _exhaustive

const MARK_STATES = ALL_STATES.filter((s): s is MarkState => s !== 'absent')

function renderMark(state: EpisodeState) {
  const { container } = render(<EpisodeMark state={state} />)
  return container
}

/** 一个态画出的图形指纹：所有子元素的标签名 + 关键几何属性，按 DOM 序。
 *  这是"两个态是否长得一样"的判据——比对 innerHTML 会把 stroke/fill 之类的
 *  共享属性也算进去，反而更松。 */
function shapeFingerprint(container: Element): string {
  const svg = container.querySelector('svg')
  if (!svg) return ''
  return [...svg.children]
    .map((el) => {
      const tag = el.tagName.toLowerCase()
      if (tag === 'path') return `path:${el.getAttribute('d')}:${el.getAttribute('fill') ?? ''}`
      if (tag === 'circle')
        return `circle:${el.getAttribute('cx')},${el.getAttribute('cy')},${el.getAttribute('r')}`
      return tag
    })
    .join('|')
}

describe('EpisodeMark：规格（照 NavIcons.tsx 的既有约定）', () => {
  it.each(MARK_STATES)('%s 是 12×12 内联 SVG、笔画 1.8、继承 currentColor', (state) => {
    const svg = renderMark(state).querySelector('svg')!
    // 12×12 是设计文档 §4.3 的裁决（与 13px mono 集号视觉等高）。改成 16 会让集号格
    // 高度跳动——一屏 40 格时肉眼可见，而"渲染了 svg"式的断言抓不到。
    expect(svg.getAttribute('viewBox')).toBe('0 0 12 12')
    expect(svg.getAttribute('width')).toBe('12')
    expect(svg.getAttribute('height')).toBe('12')
    expect(svg.getAttribute('stroke-width')).toBe('1.8')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
  })

  it.each(MARK_STATES)('%s 的 SVG 是 aria-hidden（语义走外层 aria-label，不读成两个碎片）', (state) => {
    const svg = renderMark(state).querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('focusable')).toBe('false')
  })

  it.each(MARK_STATES)('%s 带 data-state=自己（CSS 上色的唯一钩子）', (state) => {
    const svg = renderMark(state).querySelector('svg')!
    expect(svg.getAttribute('data-state')).toBe(state)
  })

  it.each(MARK_STATES)('%s 组件层**不写死任何色值**（颜色只在 CSS 里按 data-state 选）', (state) => {
    const svg = renderMark(state).querySelector('svg')!
    // 允许 currentColor / none；出现具体色值（#xxx、rgb()、var(--color-…)）即违反。
    const colorish = [...svg.querySelectorAll('*'), svg].flatMap((el) =>
      ['fill', 'stroke', 'style'].map((a) => el.getAttribute(a) ?? ''),
    )
    for (const v of colorish) {
      expect(v).not.toMatch(/#[0-9a-f]{3,8}|rgb|hsl|var\(/i)
    }
  })
})

describe('EpisodeMark：八态的符号（映射错 = 用户看到与事实相反的标记）', () => {
  it('absent 不画任何符号——**虚线格不染色**（R-F12 点名条款）', () => {
    const container = renderMark('absent')
    expect(container.querySelector('svg')).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('covered = ✓ 对勾：两段折线，收笔明显高于起笔（这是"勾"与"折角"的区别）', () => {
    const d = renderMark('covered').querySelector('path')!.getAttribute('d')!
    // 三个点：起笔、谷底、收笔。
    const pts = [...d.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({
      x: Number(m[1]), y: Number(m[2]),
    }))
    expect(pts).toHaveLength(3)
    // SVG 的 y 向下增长：谷底 y 最大，收笔 y 最小（最高）。
    expect(pts[1]!.y).toBeGreaterThan(pts[0]!.y)
    expect(pts[2]!.y).toBeLessThan(pts[0]!.y)
    // 从左往右
    expect(pts[0]!.x).toBeLessThan(pts[1]!.x)
    expect(pts[1]!.x).toBeLessThan(pts[2]!.x)
  })

  it('translating = ⇄ 双向箭头：两条横线，箭头**反向**（同向就成了 ⇉ "都往一个方向"）', () => {
    const paths = [...renderMark('translating').querySelectorAll('path')]
    expect(paths).toHaveLength(2)
    // 每条 path 的 H 命令终点：上行向右（H 大于起点 x），下行向左（H 小于起点 x）。
    const hOf = (d: string) => {
      const start = Number(/M\s*(-?[\d.]+)/.exec(d)![1])
      const end = Number(/H\s*(-?[\d.]+)/.exec(d)![1])
      return end - start
    }
    const deltas = paths.map((p) => hOf(p.getAttribute('d')!))
    expect(deltas[0]! > 0).toBe(true)
    expect(deltas[1]! < 0).toBe(true)
  })

  it('unsolvable = ⊘：一个圆 + 一道斜杠（不是光秃秃一个圆）', () => {
    const c = renderMark('unsolvable')
    expect(c.querySelectorAll('circle')).toHaveLength(1)
    const slash = c.querySelector('path')!.getAttribute('d')!
    const pts = [...slash.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => ({
      x: Number(m[1]), y: Number(m[2]),
    }))
    expect(pts).toHaveLength(2)
    // 真的是斜的（x 和 y 都变），不是一条水平/垂直线。
    expect(pts[0]!.x).not.toBe(pts[1]!.x)
    expect(pts[0]!.y).not.toBe(pts[1]!.y)
  })

  it('origin-skip = ◇ 空心菱形（fill=none）；embedded = ◆ 实心（fill=currentColor）', () => {
    const open = renderMark('origin-skip').querySelector('path')!
    cleanup()
    const solid = renderMark('embedded').querySelector('path')!
    // 同一个轮廓 —— 两者是同一族"不需要外挂字幕"的事实，实/空表达"有内容 / 没内容"。
    expect(open.getAttribute('d')).toBe(solid.getAttribute('d'))
    // **只差填充**：这是它们唯一的区别，也是唯一会被改坏的地方。
    expect(open.getAttribute('fill')).toBe('none')
    expect(solid.getAttribute('fill')).toBe('currentColor')
    // 菱形 = 闭合四点
    expect(open.getAttribute('d')).toMatch(/Z\s*$/)
    expect([...open.getAttribute('d')!.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)]).toHaveLength(4)
  })

  it('pending = ··· 三个点，水平同高、等距（不是两个也不是四个）', () => {
    const circles = [...renderMark('pending').querySelectorAll('circle')]
    expect(circles).toHaveLength(3)
    const ys = circles.map((c) => Number(c.getAttribute('cy')))
    expect(new Set(ys).size).toBe(1) // 同高
    const xs = circles.map((c) => Number(c.getAttribute('cx'))).sort((a, b) => a - b)
    expect(xs[1]! - xs[0]!).toBeCloseTo(xs[2]! - xs[1]!, 5) // 等距
    // 三个点没有一个是 path —— 用 path 画三个点会让 fingerprint 与别的态混淆
    expect(renderMark('pending').querySelectorAll('path')).toHaveLength(0)
  })

  it('unjudged = ? 钩 + **分离的**点（连成一笔就是数字 2）', () => {
    const c = renderMark('unjudged')
    expect(c.querySelectorAll('path')).toHaveLength(1)
    const dot = c.querySelector('circle')!
    const hook = c.querySelector('path')!.getAttribute('d')!
    // 钩的末端 y 与点的 cy 之间要有真空隙（分离），否则就是 "2"。
    const hookEndY = Number(/V\s*(-?[\d.]+)/.exec(hook)![1])
    const dotY = Number(dot.getAttribute('cy'))
    expect(dotY).toBeGreaterThan(hookEndY + 1)
  })
})

describe('EpisodeMark：Carbon 双通道——七个染色态的形状两两不同', () => {
  // 若两个态共用同一图形，状态就退化成"只靠颜色"，对色盲无效、对屏幕阅读器不可见
  // ——正是 R-F12 推翻三色小圆点方案的那条理由。
  it('七个态的图形指纹互不相同', () => {
    const prints = MARK_STATES.map((s) => {
      const p = shapeFingerprint(renderMark(s))
      cleanup()
      return p
    })
    expect(prints.every((p) => p.length > 0)).toBe(true)
    expect(new Set(prints).size).toBe(MARK_STATES.length)
  })

  it('七个态都真的画了东西（不是空 svg）', () => {
    for (const s of MARK_STATES) {
      const svg = renderMark(s).querySelector('svg')!
      expect(svg.children.length, `${s} 是空 svg`).toBeGreaterThan(0)
      cleanup()
    }
  })
})
