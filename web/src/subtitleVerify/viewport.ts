// web/src/subtitleVerify/viewport.ts：对照时间轴的视口数学——纯函数，零 DOM、零 React。
//
// 为什么单独一层：这里是整个时间轴唯一的坐标真源。**两条轨读同一个 Viewport**，
// 所以"两轨严格对齐"（spec I5）不是靠小心实现出来的，而是结构上不可能出错——
// 没有第二份坐标可以漂移。把它抽成纯函数还让"滚轮以光标为锚点"这类容易搞错的
// 数学能被单元测试直接钉住，不必渲染 DOM。
//
// 坐标系约定：时间单位恒为 ms（与后端 DTO 一致，不做 秒/ms 混用）；像素是轨道内的
// 局部 x（左边缘 = 0），不含轨道左侧的标签列宽度——标签列是布局的事，不进这层。

/** 视口：当前可见的时间窗。宽度（像素）由布局给，不存在这里。 */
export interface Viewport {
  /** 可见窗左边缘对应的时刻（ms） */
  startMs: number
  /** 每毫秒占多少像素。用 px/ms 而不是 px/s：与 startMs 同单位，换算处少一个 1000 因子。 */
  pxPerMs: number
}

/** 缩放下限：整条时间轴刚好铺满视口时的 pxPerMs（再缩就出现空白，没有意义）。 */
export function minPxPerMs(durationMs: number, widthPx: number): number {
  if (durationMs <= 0 || widthPx <= 0) return 0
  return widthPx / durationMs
}

/** 缩放上限：1 像素 = 1ms。再放大就是在放大舍入噪声——字幕时间戳本身
 *  最细也只到 10ms（.ass 是厘秒），像素比 ms 更细毫无信息可言。 */
export const MAX_PX_PER_MS = 1

export function timeToPx(ms: number, vp: Viewport): number {
  return (ms - vp.startMs) * vp.pxPerMs
}

export function pxToTime(px: number, vp: Viewport): number {
  return vp.startMs + px / vp.pxPerMs
}

/**
 * 把视口夹回合法范围：不缩过整轨、不放过 1px/ms、不平移出 [0, durationMs]。
 *
 * 夹的顺序要紧：**先夹缩放再夹平移**，因为 maxStart 依赖夹后的 pxPerMs。
 * 反过来（用未夹的 pxPerMs 算 maxStart）会在**放大越过上限**时算出偏大的 maxStart，
 * 让右边缘越过 durationMs——表现为放到最大时能拖出一段空白。
 * 实测 20 万次随机输入有约 10% 落在这个差异区间（全部是 pxPerMs > 上限 且 startMs 越右界
 * 的组合）；缩小越下限那一侧两种顺序结果相同，因为 ppm 被夹到下限时可见窗恰好等于整轨、
 * maxStart 必为 0。
 */
export function clampViewport(vp: Viewport, durationMs: number, widthPx: number): Viewport {
  if (durationMs <= 0 || widthPx <= 0) return vp
  const minPpm = minPxPerMs(durationMs, widthPx)
  const pxPerMs = Math.min(MAX_PX_PER_MS, Math.max(minPpm, vp.pxPerMs))
  const visibleMs = widthPx / pxPerMs
  // 可见窗比整轨还宽（只可能在恰好等于下限时因浮点误差发生）→ 贴左
  const maxStart = Math.max(0, durationMs - visibleMs)
  const startMs = Math.min(maxStart, Math.max(0, vp.startMs))
  return { startMs, pxPerMs }
}

/**
 * 以某个像素位置为锚点缩放（spec I3：**必须以光标为锚点，不是缩到视口中心**）。
 *
 * 为什么锚点很重要：缩到中心的话，用户把光标停在某句台词上滚轮放大，那句台词会往
 * 视口边缘跑掉——他正在看的东西被自己的操作弄丢了。以光标为锚点则该时刻始终钉在
 * 光标下，放大像"钻进去"而不是"画面乱跳"。
 *
 * 数学：设锚点像素 ax 对应时刻 t（缩放前后必须相同）。
 *   t = start + ax/ppm  ⟹  start' = t - ax/ppm'
 */
export function zoomAt(
  vp: Viewport,
  anchorPx: number,
  factor: number,
  durationMs: number,
  widthPx: number,
): Viewport {
  const anchorMs = pxToTime(anchorPx, vp)
  const nextPpm = vp.pxPerMs * factor
  // 先按未夹的 nextPpm 求 start，再一起夹——clampViewport 内部先夹缩放后夹平移，
  // 所以这里传进去的 start 会基于夹后的 ppm 被重新审视，锚点在到达缩放边界时
  // 会有不可避免的偏移（视口已经到底了，没有别的选择），但不到边界时精确保持。
  const raw: Viewport = { startMs: anchorMs - anchorPx / nextPpm, pxPerMs: nextPpm }
  return clampViewport(raw, durationMs, widthPx)
}

/** 横向平移：dxPx 为正表示内容往右移（看到更早的时间）。 */
export function panBy(vp: Viewport, dxPx: number, durationMs: number, widthPx: number): Viewport {
  return clampViewport(
    { startMs: vp.startMs - dxPx / vp.pxPerMs, pxPerMs: vp.pxPerMs },
    durationMs,
    widthPx,
  )
}

/** 初始视口 = 整轨铺满。 */
export function fitViewport(durationMs: number, widthPx: number): Viewport {
  return { startMs: 0, pxPerMs: minPxPerMs(durationMs, widthPx) }
}

/** 当前可见时间窗（含右边界，供裁剪用）。 */
export function visibleRange(vp: Viewport, widthPx: number): { fromMs: number; toMs: number } {
  return { fromMs: vp.startMs, toMs: vp.startMs + widthPx / vp.pxPerMs }
}

/**
 * 可视区裁剪：只返回与可见窗相交的项的下标范围。
 *
 * 为什么必须做：一集常有 1000~2000 条 cue，全量渲染成 DOM 节点在缩到"整集"视图时
 * 会造出几千个节点，每次滚轮都重排一遍——实测这类页面会直接卡死。
 *
 * 要求 `items` 按 startMs 升序（字幕解析天然如此）。用二分找起点，线性扫到超出右边界。
 * 返回 [from, to)，to 是 exclusive。
 */
export function visibleSlice(
  items: readonly { startMs: number; endMs: number }[],
  fromMs: number,
  toMs: number,
): { from: number; to: number } {
  if (items.length === 0) return { from: 0, to: 0 }
  // 二分：找第一个 endMs >= fromMs 的项。用 endMs 而非 startMs——一条横跨整个可见窗的
  // 长 cue，它的 startMs 在窗左边很远，按 startMs 二分会把它漏掉，画面上表现为
  // "那句台词的块凭空消失"。
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((items[mid] as { endMs: number }).endMs < fromMs) lo = mid + 1
    else hi = mid
  }
  const from = lo
  let to = from
  while (to < items.length && (items[to] as { startMs: number }).startMs <= toMs) to++
  return { from, to }
}

/**
 * 刻度尺间隔：在给定缩放下选一个"好看的"时间间隔。
 *
 * 候选集是人类读时间的自然单位（1/2/5/10/15/30 秒、1/2/5/10/15/30 分），不是
 * d3.ticks 那种 1/2/5×10^n——后者会给出"每 20 秒"或"每 200 秒"这类刻度，
 * 读起来要算术。取第一个宽度 >= minLabelPx 的候选，保证标签不重叠。
 */
const NICE_STEPS_MS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000,
] as const

export function chooseTickStep(pxPerMs: number, minLabelPx = 64): number {
  for (const step of NICE_STEPS_MS) {
    if (step * pxPerMs >= minLabelPx) return step
  }
  return NICE_STEPS_MS[NICE_STEPS_MS.length - 1] as number
}

/** 可见窗内的刻度时刻列表。 */
export function ticksFor(vp: Viewport, widthPx: number, minLabelPx = 64): number[] {
  const step = chooseTickStep(vp.pxPerMs, minLabelPx)
  const { fromMs, toMs } = visibleRange(vp, widthPx)
  const first = Math.ceil(fromMs / step) * step
  const out: number[] = []
  for (let t = first; t <= toMs; t += step) out.push(t)
  return out
}

/** 刻度标签：`m:ss`，超过一小时给 `h:mm:ss`。不显示毫秒——刻度是定位坐标，
 *  精确到毫秒对人眼定位毫无帮助，只会让标签变长挤在一起。 */
export function formatTick(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

/** hover 浮层用的精确时刻：`m:ss.c`（厘秒，与 .ass 的精度一致）。 */
export function formatPrecise(ms: number): string {
  const sign = ms < 0 ? '-' : ''
  const abs = Math.abs(ms)
  const total = Math.floor(abs / 1000)
  const cs = Math.round((abs % 1000) / 10)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${sign}${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}
