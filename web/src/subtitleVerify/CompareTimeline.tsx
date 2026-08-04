// web/src/subtitleVerify/CompareTimeline.tsx：PR 风格的双轨对照时间轴。
//
// 定位（用户裁决 2026-07-30）：这里是**图形化证据**，用来说服用户"字幕偏了、怎么偏的、
// 值得点那个校正按钮"。它与铁律③（不暴露机械）不冲突——不暴露机械是指别让用户操心我们
// 多累，而这里恰恰要给证据。见 spec §4.2.1 开头那段裁决原文。
//
// 形态本身携带诊断，这是泳道存在的真正理由：
//   两排块形状相同、整体平移 → 纯偏移，挪一下全片就对 → 校正按钮可信
//   开头贴合、越往后越拉开     → 帧率不匹配，平移修不好 → 不给校正按钮
// 用户看画面能判断"该不该修"，但判断不了"修得了修不了"——后者只有看形状才知道。
//
// 用 DOM 而非 Canvas 画块：文字省略号、hover、焦点、无障碍全部由浏览器免费提供。
// Canvas 要自己 fillText + 自算截断碰撞 + 自建焦点模型，等于手写一个渲染引擎。
//
// 坐标全部来自 viewport.ts 的纯函数，本文件只负责事件绑定与 DOM 输出。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fitViewport, zoomAt, panBy, timeToPx, visibleRange, visibleSlice,
  ticksFor, formatTick, formatPrecise, type Viewport,
} from './viewport.js'
import { useT } from '../i18n/useT.js'

export interface TimelineCue {
  startMs: number
  endMs: number
  text: string | null
}

interface Props {
  /** 参考轨（画面里说话的时段）——来自内嵌轨或同目录字幕 */
  reference: readonly TimelineCue[]
  /** 待检字幕轨 */
  ours: readonly TimelineCue[]
  durationMs: number
  /** 波形峰值（0~1，等间隔）。缺席=云盘或还没抽 → 不渲染声音轨；
   *  'loading' → 渲染骨架轨（shimmer）；失败时静默回退不渲染。 */
  waveformPeaks?: readonly number[] | null | 'loading'
}

/** 滚轮一格的缩放倍率。1.2 是试出来的手感：太大（2）一格就跳一个数量级、
 *  找不回原来的位置；太小（1.05）要滚十几下才有变化。 */
const WHEEL_ZOOM_FACTOR = 1.2

/** 块窄于这个像素宽就不渲染文字——挤成一两个字比留空更难读，而且省掉大量
 *  文字排版开销（缩到"整集"视图时可见块可达数百个）。 */
const MIN_TEXT_PX = 28

/** 块的最小渲染宽度：一条 40ms 的短 cue 在整集视图下不足 0.1px，会完全看不见。
 *  给个地板让它至少留下一道痕——**只影响视觉，不影响任何判断**（判断看的是整体
 *  形状而非单块宽度）。 */
const MIN_BLOCK_PX = 2

interface HoverState {
  cue: TimelineCue
  /** 相对时间轴容器的像素位置，用于定位浮层 */
  x: number
  y: number
}

export function CompareTimeline({ reference, ours, durationMs, waveformPeaks }: Props) {
  const { t } = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [vp, setVp] = useState<Viewport | null>(null)
  const [hover, setHover] = useState<HoverState | null>(null)
  const dragRef = useRef<{ startX: number; startVp: Viewport } | null>(null)

  // 宽度用 ResizeObserver 而不是一次性测量：面板可能在展开动画中挂载（此时宽度为 0），
  // 也可能因窗口缩放改变。宽度为 0 时 viewport 数学会退化成 0，所以必须跟住真实宽度。
  useEffect(() => {
    const el = hostRef.current
    if (el === null) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWidth(w)
    })
    ro.observe(el)
    setWidth(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  // 宽度或时长变化时重置为"整轨铺满"。不保留旧 viewport：宽度变了之后旧的
  // pxPerMs 可能已越界，与其做一次夹取不如回到一个明确的初始状态。
  useEffect(() => {
    if (width > 0 && durationMs > 0) setVp(fitViewport(durationMs, width))
  }, [width, durationMs])

  // 滚轮缩放。必须用 addEventListener 手动绑 + passive:false——React 的 onWheel 是
  // passive 监听，里面调 preventDefault 会被浏览器忽略并在控制台告警，结果是缩放同时
  // 整个页面也在滚。这是个真实踩过的坑，别改回 onWheel。
  useEffect(() => {
    const el = hostRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      if (vp === null || width <= 0) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const anchorPx = e.clientX - rect.left
      const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR
      setVp(zoomAt(vp, anchorPx, factor, durationMs, width))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [vp, width, durationMs])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (vp === null) return
    dragRef.current = { startX: e.clientX, startVp: vp }
    // setPointerCapture 在 jsdom 里如今是 setupTests 垫的无操作桩，但真实老引擎上仍可能
    // 压根没这个方法。捕获只是"拖到元素外面也别丢事件"的增益，拿不到就算了——绝不能让它
    // 把 pointerdown 炸掉：缺方法的引擎上裸调就是同一个坑，可选链是留给那条路径的。
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }, [vp])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (d === null || width <= 0) return
    setVp(panBy(d.startVp, e.clientX - d.startX, durationMs, width))
  }, [width, durationMs])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId) === true) {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    }
  }, [])

  const ticks = useMemo(
    () => (vp === null || width <= 0 ? [] : ticksFor(vp, width)),
    [vp, width],
  )

  if (vp === null || width <= 0) {
    // 首帧（还没测到宽度）——渲染骨架保持布局高度，避免面板打开时抖一下
    return <div ref={hostRef} className="cmptl cmptl-measuring" aria-hidden="true" />
  }

  const { fromMs, toMs } = visibleRange(vp, width)

  return (
    <div className="cmptl-wrap">
      <div
        ref={hostRef}
        className="cmptl"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="cmptl-ruler" aria-hidden="true">
          {ticks.map((ms) => (
            <span key={ms} className="cmptl-tick" style={{ left: `${timeToPx(ms, vp)}px` }}>
              {formatTick(ms)}
            </span>
          ))}
        </div>

        <Track
          label={t('verify_track_reference')}
          sub={t('verify_track_reference_sub')}
          cues={reference}
          vp={vp}
          fromMs={fromMs}
          toMs={toMs}
          variant="ref"
          onHover={setHover}
        />
        <Track
          label={t('verify_track_ours')}
          sub={t('verify_track_ours_sub')}
          cues={ours}
          vp={vp}
          fromMs={fromMs}
          toMs={toMs}
          variant="our"
          onHover={setHover}
        />

        {waveformPeaks === 'loading' ? (
          <div className="h-[60px] animate-pulse bg-secondary" />
        ) : null}
        {Array.isArray(waveformPeaks) && waveformPeaks.length > 0 ? (
          <WaveTrack
            label={t('verify_track_audio')}
            peaks={waveformPeaks}
            durationMs={durationMs}
            vp={vp}
            width={width}
          />
        ) : null}

        {hover ? (
          <div
            className="cmptl-pop"
            style={{ left: `${hover.x}px`, top: `${hover.y}px` }}
            role="tooltip"
          >
            <div className="cmptl-pop-time">
              {formatPrecise(hover.cue.startMs)} → {formatPrecise(hover.cue.endMs)}
            </div>
            {hover.cue.text ? <div className="cmptl-pop-text">{hover.cue.text}</div> : null}
          </div>
        ) : null}
      </div>
      <div className="cmptl-hint" aria-hidden="true">{t('verify_timeline_hint')}</div>
    </div>
  )
}

interface TrackProps {
  label: string
  sub: string
  cues: readonly TimelineCue[]
  vp: Viewport
  fromMs: number
  toMs: number
  variant: 'ref' | 'our'
  onHover: (h: HoverState | null) => void
}

function Track({ label, sub, cues, vp, fromMs, toMs, variant, onHover }: TrackProps) {
  // 只渲染可见区的块。1000~2000 条 cue 全量渲染成 DOM 在"整集"视图下会造出几千个节点，
  // 每次滚轮都重排一遍——那样的页面会卡死。
  const { from, to } = visibleSlice(cues, fromMs, toMs)
  const slice = []
  for (let i = from; i < to; i++) {
    const c = cues[i]
    if (c === undefined) continue
    const x = timeToPx(c.startMs, vp)
    const w = Math.max(MIN_BLOCK_PX, (c.endMs - c.startMs) * vp.pxPerMs)
    slice.push(
      <div
        key={`${c.startMs}-${i}`}
        className={`cmptl-blk cmptl-blk-${variant}`}
        style={{ left: `${x}px`, width: `${w}px` }}
        onPointerEnter={(e) => {
          const host = e.currentTarget.closest('.cmptl') as HTMLElement | null
          if (host === null) return
          const hr = host.getBoundingClientRect()
          const br = e.currentTarget.getBoundingClientRect()
          onHover({ cue: c, x: br.left - hr.left, y: br.bottom - hr.top + 4 })
        }}
        onPointerLeave={() => onHover(null)}
      >
        {w >= MIN_TEXT_PX && c.text ? <span className="cmptl-blk-t">{c.text}</span> : null}
      </div>,
    )
  }
  return (
    <div className="cmptl-trk">
      <span className="cmptl-trk-n">
        {label}
        <em>{sub}</em>
      </span>
      <div className="cmptl-lane">{slice}</div>
    </div>
  )
}

interface WaveTrackProps {
  label: string
  peaks: readonly number[]
  durationMs: number
  vp: Viewport
  width: number
}

/**
 * organic 波形：上下镜像对称的平滑包络（SoundCloud / iOS 语音备忘录那种质感），
 * 不是等宽硬边竖条——用户对竖条版的评价是"糙了点"。
 *
 * 自己画 SVG path 而不用 wavesurfer：我们已经有了视口状态（滚轮缩放/拖拽平移都在
 * 这个组件里），wavesurfer 的价值主要是音频解码 + 自带交互，而我们两样都不需要
 * （峰值是后端 ffmpeg 抽好的，交互归 viewport.ts）。剩下的就是把峰值数组画成
 * 一条对称 path——那是几十行的事，引一个库反而要处理它的视口与我们的视口同步。
 */
function WaveTrack({ label, peaks, durationMs, vp, width }: WaveTrackProps) {
  const H = 46
  const mid = H / 2
  const path = useMemo(() => {
    // 可见窗对应的峰值下标范围
    const { fromMs, toMs } = visibleRange(vp, width)
    const n = peaks.length
    const i0 = Math.max(0, Math.floor((fromMs / durationMs) * n))
    const i1 = Math.min(n, Math.ceil((toMs / durationMs) * n))
    if (i1 <= i0) return ''

    // 降采样到"每 2 像素一个采样点"：再密画不出来（相邻点不足 1px），
    // 只是白算。每段取 max 而非平均——平均会把瞬时峰值抹平，波形看起来
    // 死气沉沉；取 max 保住"说话的爆发感"，这正是 organic 的来源。
    const targetPts = Math.max(2, Math.floor(width / 2))
    const stride = Math.max(1, Math.floor((i1 - i0) / targetPts))
    const up: Array<[number, number]> = []
    for (let i = i0; i < i1; i += stride) {
      let m = 0
      for (let j = i; j < Math.min(i + stride, i1); j++) m = Math.max(m, peaks[j] ?? 0)
      const tMs = (i / n) * durationMs
      up.push([timeToPx(tMs, vp), m])
    }
    if (up.length < 2) return ''

    // 用 Catmull-Rom 风格的平滑（这里手写基数样条，避免为一条 path 引 d3-shape：
    // 张力 0.5 与 curveCatmullRom.alpha(0.5) 视觉等价）。
    // 上半：mid - v*mid；下半反向回来形成镜像闭合。
    const top = up.map(([x, v]) => [x, mid - v * mid * 0.92] as [number, number])
    const bot = [...up].reverse().map(([x, v]) => [x, mid + v * mid * 0.92] as [number, number])
    return `M${smooth(top)} L${smooth(bot)} Z`
  }, [peaks, durationMs, vp, width, mid])

  return (
    <div className="cmptl-trk cmptl-trk-wave">
      <span className="cmptl-trk-n">{label}</span>
      <div className="cmptl-lane cmptl-lane-wave">
        <svg viewBox={`0 0 ${Math.max(1, width)} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="cmptl-wg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-fn-blue)" stopOpacity="0.8" />
              <stop offset="50%" stopColor="var(--color-fn-blue)" stopOpacity="0.45" />
              <stop offset="100%" stopColor="var(--color-fn-blue)" stopOpacity="0.8" />
            </linearGradient>
          </defs>
          <path d={path} fill="url(#cmptl-wg)" />
        </svg>
      </div>
    </div>
  )
}

/** 基数样条：把点列变成平滑的 SVG 路径片段（不含起始命令）。 */
function smooth(pts: readonly [number, number][]): string {
  if (pts.length === 0) return ''
  if (pts.length < 3) return pts.map(([x, y]) => `${r(x)},${r(y)}`).join(' L')
  const out: string[] = [`${r(pts[0]![0])},${r(pts[0]![1])}`]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    out.push(`C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(p2[0])},${r(p2[1])}`)
  }
  return out.join(' ')
}

/** 路径坐标保留一位小数——SVG 不需要更高精度，且能显著缩短 path 字符串。 */
function r(n: number): number {
  return Math.round(n * 10) / 10
}
