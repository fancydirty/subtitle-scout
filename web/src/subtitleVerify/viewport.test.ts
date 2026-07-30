// web/src/subtitleVerify/viewport.test.ts：对照时间轴的视口数学。
//
// 这一层是整个时间轴的坐标真源，两条轨读同一个 Viewport——所以这些测试同时也是
// spec I5（两轨严格对齐）的保障：只要坐标函数对，两轨就不可能错开。
import { describe, it, expect } from 'vitest'
import {
  timeToPx, pxToTime, clampViewport, zoomAt, panBy, fitViewport, visibleRange,
  visibleSlice, chooseTickStep, ticksFor, formatTick, formatPrecise,
  minPxPerMs, MAX_PX_PER_MS, type Viewport,
} from './viewport.js'

const DUR = 1_422_000   // 23.7 分钟，取自生产实测的那一集
const W = 800

describe('时间 ↔ 像素互为逆运算', () => {
  const vp: Viewport = { startMs: 60_000, pxPerMs: 0.002 }

  it('timeToPx / pxToTime 往返无损', () => {
    for (const ms of [60_000, 120_000, 500_000, 1_000_000]) {
      expect(pxToTime(timeToPx(ms, vp), vp)).toBeCloseTo(ms, 6)
    }
  })

  it('视口左边缘对应 x=0', () => {
    expect(timeToPx(vp.startMs, vp)).toBe(0)
  })
})

describe('fitViewport / minPxPerMs：整轨铺满', () => {
  it('初始视口从 0 开始且刚好铺满', () => {
    const vp = fitViewport(DUR, W)
    expect(vp.startMs).toBe(0)
    expect(timeToPx(DUR, vp)).toBeCloseTo(W, 6)
  })

  it('零时长/零宽度不产生 NaN 或 Infinity', () => {
    expect(minPxPerMs(0, W)).toBe(0)
    expect(minPxPerMs(DUR, 0)).toBe(0)
    expect(Number.isFinite(fitViewport(0, W).pxPerMs)).toBe(true)
  })
})

describe('clampViewport：三条边界', () => {
  it('不许缩过整轨（pxPerMs 有下限）', () => {
    const tooSmall = clampViewport({ startMs: 0, pxPerMs: 1e-9 }, DUR, W)
    expect(tooSmall.pxPerMs).toBeCloseTo(minPxPerMs(DUR, W), 12)
  })

  it('不许放过 1px/ms（再放大只是放大舍入噪声）', () => {
    const tooBig = clampViewport({ startMs: 0, pxPerMs: 999 }, DUR, W)
    expect(tooBig.pxPerMs).toBe(MAX_PX_PER_MS)
  })

  it('不许平移出左边界', () => {
    expect(clampViewport({ startMs: -50_000, pxPerMs: 0.01 }, DUR, W).startMs).toBe(0)
  })

  it('不许平移出右边界（右边缘最多贴到 durationMs）', () => {
    const vp = clampViewport({ startMs: DUR, pxPerMs: 0.01 }, DUR, W)
    const { toMs } = visibleRange(vp, W)
    expect(toMs).toBeCloseTo(DUR, 3)
  })

  // 回归锁：夹的顺序是"先缩放后平移"，因为 maxStart 依赖夹后的 pxPerMs。
  // 差异只在**放大越上限 + 位置越右界**的组合上显现（缩小越下限那侧两种顺序等价，
  // 因为 ppm 到下限时可见窗恰等于整轨、maxStart 必为 0——我最初的注释把方向写反了，
  // 是这条测试的变异验证暴露的）。错误顺序会让右边缘越过 durationMs：放到最大时
  // 能拖出一段空白。
  it('放大越上限 + 位置越右界：右边缘不许越过 durationMs（钉住 clamp 顺序）', () => {
    for (const vp of [
      { startMs: 1_807_515, pxPerMs: 1.15 },
      { startMs: 1_560_312, pxPerMs: 1.42 },
      { startMs: DUR + 1000, pxPerMs: 5 },
    ] as Viewport[]) {
      const c = clampViewport(vp, DUR, W)
      expect(c.pxPerMs).toBe(MAX_PX_PER_MS)
      expect(visibleRange(c, W).toMs).toBeLessThanOrEqual(DUR + 1e-6)
    }
  })

  it('同时越界（缩放过小 + 位置越界）时结果自洽：铺满且贴左', () => {
    const vp = clampViewport({ startMs: 9_999_999, pxPerMs: 1e-9 }, DUR, W)
    expect(vp.startMs).toBe(0)
    expect(timeToPx(DUR, vp)).toBeCloseTo(W, 6)
  })
})

// spec I3：滚轮缩放必须以光标为锚点，不是缩到视口中心。缩到中心会让用户正在看的
// 台词跑到边缘去——他被自己的操作弄丢了目标。
describe('zoomAt：以光标为锚点（spec I3）', () => {
  const base: Viewport = { startMs: 100_000, pxPerMs: 0.001 }

  it('放大后，锚点像素下的时刻不变', () => {
    for (const anchorPx of [0, 137, 400, 799]) {
      const before = pxToTime(anchorPx, base)
      const after = zoomAt(base, anchorPx, 2, DUR, W)
      expect(pxToTime(anchorPx, after)).toBeCloseTo(before, 3)
    }
  })

  it('缩小后，锚点像素下的时刻同样不变', () => {
    // base.pxPerMs 必须离下限足够远，否则缩放会被 clamp 夹住——夹住时锚点漂移是
    // 物理必然（视口已经到底，没有别的选择），不是实现错误。实测下限 ≈0.00056，
    // 所以用 0.01 起步、只缩到 0.005，仍在合法区间内。
    const roomy: Viewport = { startMs: 100_000, pxPerMs: 0.01 }
    const anchorPx = 250
    const before = pxToTime(anchorPx, roomy)
    const after = zoomAt(roomy, anchorPx, 0.5, DUR, W)
    expect(after.pxPerMs).toBeGreaterThan(minPxPerMs(DUR, W))   // 确认没被夹
    expect(pxToTime(anchorPx, after)).toBeCloseTo(before, 3)
  })

  // 到达缩放边界时锚点会漂移，这是没有选择的——但必须**优雅**：视口保持合法、
  // 不出现 NaN、不越界。这条锁住"夹住时也别乱"。
  it('缩放被下限夹住时锚点漂移，但视口仍然合法', () => {
    const nearFloor: Viewport = { startMs: 100_000, pxPerMs: 0.001 }
    const after = zoomAt(nearFloor, 250, 0.5, DUR, W)
    expect(after.pxPerMs).toBeCloseTo(minPxPerMs(DUR, W), 12)
    expect(after.startMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(after.startMs)).toBe(true)
    const { toMs } = visibleRange(after, W)
    expect(toMs).toBeLessThanOrEqual(DUR + 1)
  })

  // 这条把"以光标为锚点"和"缩到中心"区分开：若实现是缩到中心，在非中心锚点上
  // 该时刻必然漂移，此断言失败。
  it('非中心锚点：与"缩到视口中心"的结果显著不同', () => {
    const anchorPx = 100
    const anchored = zoomAt(base, anchorPx, 2, DUR, W)
    const centered = zoomAt(base, W / 2, 2, DUR, W)
    expect(Math.abs(anchored.startMs - centered.startMs)).toBeGreaterThan(1000)
  })

  it('放大不会突破上限，缩小不会突破下限', () => {
    let vp = base
    for (let i = 0; i < 40; i++) vp = zoomAt(vp, 400, 2, DUR, W)
    expect(vp.pxPerMs).toBe(MAX_PX_PER_MS)
    for (let i = 0; i < 60; i++) vp = zoomAt(vp, 400, 0.5, DUR, W)
    expect(vp.pxPerMs).toBeCloseTo(minPxPerMs(DUR, W), 12)
  })
})

describe('panBy：横向平移', () => {
  it('往右拖看到更早的时间', () => {
    const vp: Viewport = { startMs: 100_000, pxPerMs: 0.001 }
    expect(panBy(vp, 100, DUR, W).startMs).toBeLessThan(vp.startMs)
  })

  it('平移被夹在合法范围内', () => {
    const vp: Viewport = { startMs: 0, pxPerMs: 0.001 }
    expect(panBy(vp, 99_999, DUR, W).startMs).toBe(0)
  })
})

describe('visibleSlice：可视区裁剪', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    startMs: i * 10_000, endMs: i * 10_000 + 3_000,
  }))

  it('只返回与可见窗相交的项', () => {
    const { from, to } = visibleSlice(items, 300_000, 400_000)
    expect(items[from]!.endMs).toBeGreaterThanOrEqual(300_000)
    expect(items[to - 1]!.startMs).toBeLessThanOrEqual(400_000)
    expect(to - from).toBeLessThan(20)   // 远小于 100，确实裁了
  })

  it('空数组不崩', () => {
    expect(visibleSlice([], 0, 1000)).toEqual({ from: 0, to: 0 })
  })

  it('全部在窗外时返回空区间', () => {
    const { from, to } = visibleSlice(items, 5_000_000, 6_000_000)
    expect(to - from).toBe(0)
  })

  // 回归锁：二分必须按 endMs 找起点，不是 startMs。一条横跨整个可见窗的长 cue，
  // 它的 startMs 在窗左边很远——按 startMs 二分会把它漏掉，画面上表现为
  // "那句台词的块凭空消失"。
  it('横跨整个可见窗的长 cue 不被漏掉（必须按 endMs 二分）', () => {
    const withLong = [
      { startMs: 0, endMs: 1_000_000 },      // 覆盖整个窗
      { startMs: 500_000, endMs: 503_000 },
    ]
    const { from, to } = visibleSlice(withLong, 400_000, 450_000)
    expect(from).toBe(0)      // 那条长的必须在切片内
    expect(to).toBeGreaterThan(0)
  })
})

describe('chooseTickStep / ticksFor：刻度尺', () => {
  it('缩放越大间隔越小', () => {
    const wide = chooseTickStep(0.0005)
    const tight = chooseTickStep(0.05)
    expect(tight).toBeLessThan(wide)
  })

  it('间隔取自人类自然单位（不是 1/2/5×10^n）', () => {
    // 20 秒 / 200 秒这类"要算术"的间隔不该出现
    const allowed = new Set([1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5])
    for (const ppm of [0.0001, 0.0005, 0.002, 0.01, 0.05, 0.3]) {
      expect(allowed.has(chooseTickStep(ppm)), `ppm=${ppm} → ${chooseTickStep(ppm)}`).toBe(true)
    }
  })

  it('标签不重叠：相邻刻度像素距离 >= minLabelPx', () => {
    const vp = fitViewport(DUR, W)
    const t = ticksFor(vp, W, 64)
    for (let i = 1; i < t.length; i++) {
      expect(timeToPx(t[i]!, vp) - timeToPx(t[i - 1]!, vp)).toBeGreaterThanOrEqual(64 - 1e-6)
    }
  })

  it('刻度全部落在可见窗内', () => {
    const vp: Viewport = { startMs: 123_456, pxPerMs: 0.003 }
    const { fromMs, toMs } = visibleRange(vp, W)
    for (const t of ticksFor(vp, W)) {
      expect(t).toBeGreaterThanOrEqual(fromMs)
      expect(t).toBeLessThanOrEqual(toMs)
    }
  })
})

describe('formatTick / formatPrecise', () => {
  it('刻度标签不含毫秒（定位坐标，不需要那个精度）', () => {
    expect(formatTick(0)).toBe('0:00')
    expect(formatTick(65_000)).toBe('1:05')
    expect(formatTick(3_725_000)).toBe('1:02:05')
    expect(formatTick(725_000)).not.toMatch(/\./)
  })

  it('hover 浮层给厘秒（与 .ass 精度一致）', () => {
    expect(formatPrecise(65_430)).toBe('1:05.43')
    expect(formatPrecise(0)).toBe('0:00.00')
    expect(formatPrecise(-2_500)).toBe('-0:02.50')
  })
})
