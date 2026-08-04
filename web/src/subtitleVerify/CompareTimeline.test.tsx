// web/src/subtitleVerify/CompareTimeline.test.tsx：双轨对照时间轴的渲染与交互。
//
// jsdom 里 getBoundingClientRect 恒返回 0，ResizeObserver 也不存在——两者都要垫，
// 否则组件永远停在"还没测到宽度"的骨架分支，什么都测不到。垫的宽度是本文件的
// 事实基准（WIDTH），所有涉及像素的断言都以它为准。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { CompareTimeline, type TimelineCue } from './CompareTimeline.js'

const WIDTH = 800
const DUR = 600_000   // 10 分钟

/** 造一批规则的 cue：每 10 秒一条、每条 3 秒。 */
function cues(n: number, shiftMs = 0, text = '台词'): TimelineCue[] {
  return Array.from({ length: n }, (_, i) => ({
    startMs: i * 10_000 + shiftMs,
    endMs: i * 10_000 + 3_000 + shiftMs,
    text: `${text}${i}`,
  }))
}

let observed: Array<() => void> = []

beforeEach(() => {
  observed = []
  // ResizeObserver 垫片：构造时记住回调，observe 时立即以 WIDTH 触发一次
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      const fire = () => this.cb(
        [{ contentRect: { width: WIDTH, height: 120 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      )
      observed.push(fire)
      fire()
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)
  // 组件用 getBoundingClientRect 做初始测量与锚点换算；jsdom 恒 0，垫成 WIDTH
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    const isLane = this.classList?.contains('cmptl-lane')
    const isBlk = this.classList?.contains('cmptl-blk')
    if (isBlk) return { left: 120, right: 160, top: 4, bottom: 26, width: 40, height: 22, x: 120, y: 4, toJSON: () => ({}) } as DOMRect
    if (isLane) return { left: 88, right: 88 + WIDTH, top: 0, bottom: 30, width: WIDTH, height: 30, x: 88, y: 0, toJSON: () => ({}) } as DOMRect
    return { left: 0, right: WIDTH, top: 0, bottom: 120, width: WIDTH, height: 120, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderTL(props: Partial<Parameters<typeof CompareTimeline>[0]> = {}, lang: 'en' | 'zh' = 'zh') {
  return render(
    <I18nProvider initialLang={lang}>
      <CompareTimeline
        reference={cues(20)}
        ours={cues(20, 8_300)}
        durationMs={DUR}
        {...props}
      />
    </I18nProvider>,
  )
}

describe('CompareTimeline：两轨渲染', () => {
  it('两条字幕轨都渲染出块', () => {
    const { container } = renderTL()
    expect(container.querySelectorAll('.cmptl-blk-ref').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.cmptl-blk-our').length).toBeGreaterThan(0)
  })

  it('块上直接显示字幕文字（spec I1）', () => {
    const { container } = renderTL({
      reference: [{ startMs: 0, endMs: 120_000, text: '这里的咖啡真不错' }],
      ours: [],
    })
    expect(container.textContent).toContain('这里的咖啡真不错')
  })

  // 窄块不渲染文字：挤成一两个字比留空更难读，而且省掉大量排版开销。
  it('块太窄时不渲染文字，只留色块', () => {
    const { container } = renderTL({
      reference: [{ startMs: 0, endMs: 200, text: '短' }],   // 200ms 在 10 分钟视图下 < 1px
      ours: [],
    })
    expect(container.querySelectorAll('.cmptl-blk-ref').length).toBe(1)
    expect(container.textContent).not.toContain('短')
  })

  it('文字为 null 的 cue 不崩（将来 VAD 参考源没有文字）', () => {
    const { container } = renderTL({
      reference: [{ startMs: 0, endMs: 120_000, text: null }],
      ours: [],
    })
    expect(container.querySelectorAll('.cmptl-blk-ref').length).toBe(1)
  })

  it('刻度尺渲染且标签是 m:ss（不含毫秒）', () => {
    const { container } = renderTL()
    const ticks = container.querySelectorAll('.cmptl-tick')
    expect(ticks.length).toBeGreaterThan(1)
    for (const t of ticks) {
      expect(t.textContent).toMatch(/^\d+:\d{2}$/)
    }
  })

  it('空数据不崩（两轨皆空）', () => {
    const { container } = renderTL({ reference: [], ours: [] })
    expect(container.querySelector('.cmptl')).toBeTruthy()
  })
})

describe('CompareTimeline：可视区裁剪', () => {
  // 2000 条 cue 全量渲染会造出几千个 DOM 节点，每次滚轮重排一遍——页面会卡死。
  //
  // 注意：初始视图是"整轨铺满"，此时 2000 条**本来就全在可见窗内**，裁剪无从生效
  // （我第一版测试就错在这里，断言了一个初始态不可能成立的性质）。裁剪的价值在放大
  // 之后——那才是真实的浏览场景。
  it('放大后只渲染可见区的一小部分（2000 条 cue）', () => {
    const many = cues(2000)
    const { container } = renderTL({ reference: many, ours: [], durationMs: 20_000_000 })
    const atFit = container.querySelectorAll('.cmptl-blk-ref').length
    const host = container.querySelector('.cmptl')!
    for (let i = 0; i < 12; i++) fireEvent.wheel(host, { deltaY: -100, clientX: 400 })
    const zoomed = container.querySelectorAll('.cmptl-blk-ref').length
    expect(zoomed).toBeGreaterThan(0)
    expect(zoomed).toBeLessThan(atFit / 4)   // 放大 12 格后应显著减少
  })

  it('整轨铺满时不裁剪（可见窗覆盖全部）', () => {
    const { container } = renderTL({ reference: cues(50), ours: [], durationMs: 600_000 })
    expect(container.querySelectorAll('.cmptl-blk-ref').length).toBe(50)
  })
})

describe('CompareTimeline：hover 浮层（spec I2）', () => {
  it('hover 块弹出浮层，含完整文字与精确时刻', () => {
    const { container } = renderTL({
      reference: [{ startMs: 65_430, endMs: 70_000, text: '我什么都没看见，真的' }],
      ours: [],
    })
    const blk = container.querySelector('.cmptl-blk-ref')!
    fireEvent.pointerEnter(blk)
    const pop = container.querySelector('.cmptl-pop')
    expect(pop).toBeTruthy()
    expect(pop!.textContent).toContain('我什么都没看见，真的')
    expect(pop!.textContent).toContain('1:05.43')   // 厘秒精度，与 .ass 一致
  })

  it('移出块后浮层消失', () => {
    const { container } = renderTL({
      reference: [{ startMs: 0, endMs: 120_000, text: 'x' }],
      ours: [],
    })
    const blk = container.querySelector('.cmptl-blk-ref')!
    fireEvent.pointerEnter(blk)
    expect(container.querySelector('.cmptl-pop')).toBeTruthy()
    fireEvent.pointerLeave(blk)
    expect(container.querySelector('.cmptl-pop')).toBeNull()
  })

  it('浮层有 role=tooltip', () => {
    const { container } = renderTL({
      reference: [{ startMs: 0, endMs: 120_000, text: 'x' }],
      ours: [],
    })
    fireEvent.pointerEnter(container.querySelector('.cmptl-blk-ref')!)
    expect(screen.getByRole('tooltip')).toBeTruthy()
  })
})

describe('CompareTimeline：滚轮缩放（spec I3）', () => {
  it('滚轮向上放大：可见块数减少（窗口变窄）', () => {
    const { container } = renderTL({ reference: cues(60), ours: [] })
    const host = container.querySelector('.cmptl')!
    const before = container.querySelectorAll('.cmptl-blk-ref').length
    for (let i = 0; i < 5; i++) {
      fireEvent.wheel(host, { deltaY: -100, clientX: 400 })
    }
    const after = container.querySelectorAll('.cmptl-blk-ref').length
    expect(after).toBeLessThan(before)
  })

  it('滚轮缩到底不会把块全部弄没（视口被夹在合法范围）', () => {
    const { container } = renderTL({ reference: cues(60), ours: [] })
    const host = container.querySelector('.cmptl')!
    for (let i = 0; i < 40; i++) fireEvent.wheel(host, { deltaY: 100, clientX: 400 })
    expect(container.querySelectorAll('.cmptl-blk-ref').length).toBeGreaterThan(0)
  })

  // 回归锁：滚轮必须走 addEventListener + passive:false 手动绑定。用 React 的 onWheel
  // （passive 监听）时 preventDefault 会被浏览器忽略，结果是缩放的同时整个页面也在滚。
  it('wheel 事件的 preventDefault 被调用（否则页面会跟着滚）', () => {
    const { container } = renderTL()
    const host = container.querySelector('.cmptl')!
    const ev = new WheelEvent('wheel', { deltaY: -100, clientX: 400, cancelable: true, bubbles: true })
    const spy = vi.spyOn(ev, 'preventDefault')
    host.dispatchEvent(ev)
    expect(spy).toHaveBeenCalled()
  })
})

describe('CompareTimeline：拖拽平移（spec I4）', () => {
  // 回归锁：setPointerCapture 在 jsdom 里压根不存在（不是 no-op）。裸调它会让 pointerdown
  // 抛错——测试里表现为 vitest 的 "unhandled errors / may cause false positive tests"，
  // 真实浏览器的老引擎上是同一个坑。捕获只是"拖到元素外也别丢事件"的增益，拿不到就算了。
  // fireEvent 会把 React 事件处理器里的抛错吞进 error boundary/控制台，所以不能用
  // expect(...).not.toThrow() 验——那样变异体（去掉可选链）会照绿。改为直接监听
  // window 的 error 事件：React 18+ 把未捕获的事件处理器异常重新抛到 window 上。
  it('setPointerCapture 缺席时 pointerdown 不产生未捕获异常（可选链保护）', () => {
    // setupTests.ts 自 Plan C Task 7 起给 Element.prototype 全局垫了 setPointerCapture
    // （Radix Select/Dialog 一族需要）。本用例测的恰恰是"它没有"的路径——用例内临时摘掉
    // 这个垫片、跑完恢复，其余套件继续享受全局垫片。
    const savedSetPointerCapture = Element.prototype.setPointerCapture
    Reflect.deleteProperty(Element.prototype, 'setPointerCapture')
    try {
      const { container } = renderTL()
      const host = container.querySelector('.cmptl')!
      expect((host as HTMLElement).setPointerCapture).toBeUndefined()
      const errors: unknown[] = []
      const onErr = (e: ErrorEvent) => { errors.push(e.error ?? e.message); e.preventDefault() }
      window.addEventListener('error', onErr)
      try {
        fireEvent.pointerDown(host, { clientX: 400, pointerId: 1 })
        fireEvent.pointerMove(host, { clientX: 200, pointerId: 1 })
        fireEvent.pointerUp(host, { clientX: 200, pointerId: 1 })
      } finally {
        window.removeEventListener('error', onErr)
      }
      expect(errors).toEqual([])
    } finally {
      Element.prototype.setPointerCapture = savedSetPointerCapture
    }
  })

  it('拖拽改变可见窗（刻度标签随之变化）', () => {
    const { container } = renderTL({ reference: cues(60), ours: [], durationMs: 600_000 })
    const host = container.querySelector('.cmptl')!
    // 先放大，否则整轨铺满时无处可平移
    for (let i = 0; i < 6; i++) fireEvent.wheel(host, { deltaY: -100, clientX: 400 })
    const before = Array.from(container.querySelectorAll('.cmptl-tick')).map((t) => t.textContent).join()
    fireEvent.pointerDown(host, { clientX: 600, pointerId: 1 })
    fireEvent.pointerMove(host, { clientX: 200, pointerId: 1 })
    fireEvent.pointerUp(host, { clientX: 200, pointerId: 1 })
    const after = Array.from(container.querySelectorAll('.cmptl-tick')).map((t) => t.textContent).join()
    expect(after).not.toBe(before)
  })
})

// spec I5：两轨严格同步。结构上由"两轨读同一个 Viewport"保证，这里从渲染结果反向验证。
describe('CompareTimeline：两轨严格对齐（spec I5）', () => {
  it('同一时刻在两轨上的像素 x 相同', () => {
    const same = cues(10)
    const { container } = renderTL({ reference: same, ours: same })
    const refX = Array.from(container.querySelectorAll('.cmptl-blk-ref')).map(
      (e) => (e as HTMLElement).style.left)
    const ourX = Array.from(container.querySelectorAll('.cmptl-blk-our')).map(
      (e) => (e as HTMLElement).style.left)
    expect(ourX).toEqual(refX)
  })

  it('缩放后两轨仍然对齐', () => {
    const same = cues(30)
    const { container } = renderTL({ reference: same, ours: same })
    const host = container.querySelector('.cmptl')!
    for (let i = 0; i < 4; i++) fireEvent.wheel(host, { deltaY: -100, clientX: 300 })
    const refX = Array.from(container.querySelectorAll('.cmptl-blk-ref')).map(
      (e) => (e as HTMLElement).style.left)
    const ourX = Array.from(container.querySelectorAll('.cmptl-blk-our')).map(
      (e) => (e as HTMLElement).style.left)
    expect(ourX).toEqual(refX)
  })

  it('偏移的字幕在视觉上确实偏移（同下标块的 x 不同）', () => {
    const { container } = renderTL({ reference: cues(10), ours: cues(10, 8_300) })
    const refX = (container.querySelector('.cmptl-blk-ref') as HTMLElement).style.left
    const ourX = (container.querySelector('.cmptl-blk-our') as HTMLElement).style.left
    expect(ourX).not.toBe(refX)
  })
})

describe('CompareTimeline：波形轨', () => {
  const peaks = Array.from({ length: 600 }, (_, i) => Math.abs(Math.sin(i / 7)))

  it('给了峰值就渲染声音轨', () => {
    const { container } = renderTL({ waveformPeaks: peaks })
    expect(container.querySelector('.cmptl-trk-wave')).toBeTruthy()
    expect(container.querySelector('.cmptl-lane-wave svg path')).toBeTruthy()
  })

  // spec 验收判据 13：云盘条目不渲染声音轨的容器，而不是渲染一个空的。
  it('峰值缺席（云盘）→ 完全不渲染声音轨容器', () => {
    const { container } = renderTL({ waveformPeaks: null })
    expect(container.querySelector('.cmptl-trk-wave')).toBeNull()
  })

  it('峰值为空数组同样不渲染', () => {
    const { container } = renderTL({ waveformPeaks: [] })
    expect(container.querySelector('.cmptl-trk-wave')).toBeNull()
  })

  // spec 验收判据 15：organic 波形必须是镜像对称包络，不是单向柱状。
  // 判据：path 里同时存在中线以上和以下的 y 坐标，且用了三次贝塞尔（C 命令）而非直线。
  it('波形是镜像对称的平滑包络（不是单向硬边柱状）', () => {
    const { container } = renderTL({ waveformPeaks: peaks })
    const d = container.querySelector('.cmptl-lane-wave path')!.getAttribute('d')!
    expect(d).toContain('C')              // 平滑：三次贝塞尔而非折线
    expect(d.endsWith('Z')).toBe(true)    // 闭合填充区域
    const ys = Array.from(d.matchAll(/[,\s](-?\d+(?:\.\d+)?)(?=[\s,C]|$)/g))
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n))
    const H = 46
    expect(ys.some((y) => y < H / 2 - 1)).toBe(true)   // 有中线以上的点
    expect(ys.some((y) => y > H / 2 + 1)).toBe(true)   // 有中线以下的点
  })
})

describe('CompareTimeline：i18n', () => {
  it('中文渲染轨道名与操作提示', () => {
    const { container } = renderTL({}, 'zh')
    expect(container.textContent).toContain('画面里说话')
    expect(container.textContent).toContain('这份字幕')
    expect(container.textContent).toContain('滚轮缩放')
  })

  it('英文渲染对应文案', () => {
    const { container } = renderTL({}, 'en')
    expect(container.textContent).toContain('spoken in the video')
    expect(container.textContent).toContain('this subtitle')
    expect(container.textContent).toContain('scroll to zoom')
  })

  // 铁律③：轨道名不许出现机械词汇（内嵌轨/参考源/sidecar/agent）。
  it('轨道名不暴露机械（不提内嵌轨/参考源/sidecar）', () => {
    const { container } = renderTL({}, 'zh')
    const names = Array.from(container.querySelectorAll('.cmptl-trk-n'))
      .map((e) => e.textContent).join(' ')
    expect(names).not.toMatch(/内嵌|sidecar|agent|参考源|VAD|轨道|stream/i)
  })
})
