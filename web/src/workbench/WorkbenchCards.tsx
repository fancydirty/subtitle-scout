// web/src/workbench/WorkbenchCards.tsx —— R-F13 的两种全背景式卡片。
//
// 「在跑」用横版 backdrop（60% 宽 / 186px 高），「排队」用竖版 poster（59×88，渐变区 118px）。
// 为什么形状不同：宽高比决定的（设计文档 §六·八 决定 2）——
//   16:9 @ 70px高 = 124px宽（太窄看不清）  vs  2:3 @ 70px高 = 47px宽（天生适合窄行）。
// 两个位置职责不同，形状不同不是缺陷是分工。
//
// 几何与渐变全在 styles.css 的 .wb-* 段（CSS 变量驱动，移动端只改变量不改组件——
// 设计文档 §七 的"留路"，且点名**不许用 clamp()**）。本文件只负责：
//  · 取哪张图（在跑取 backdrop、排队取 poster）
//  · **拿不到图时怎么降级**（见下）
//  · 三行文案的组装
//
// ── 拿不到图时的降级（§4.4 点名：这是必然分支，不是边缘兜底）─────────────────
// 两种拿不到：① 后端给的 path 就是 null（works.backdrop_path 没回填 / TMDB 确实没横版图）；
// ② path 有值但 TMDB CDN 加载失败（onError）。两种走**同一条**降级：
//   `data-noimg='true'` → 渐变层塌成纯实色、文字左边距归零。
// 🔴 **不画首字母占位块**（与媒体库页的 MediaPoster 刻意不同）：那个是 2:3 的海报槽位，
// 空着会很显眼；这里图是**背景**，缺图时最好的样子就是一张干净的实色卡片，
// 硬塞一个灰方块反而像坏了。
//
// ── 在跑卡片没有图时**不回落到竖版 poster** ────────────────────────────────
// 想过（"横版没有就用竖版顶上"），否掉：竖版图拉伸到 60%宽×186px 会严重变形，
// 而 R-F13 选横版正是因为宽高比。一张变形的图比没有图更糟。
import { useState } from 'react'
import { backdropUrl, posterUrl } from '../api/client.js'
import { useT } from '../i18n/useT.js'

/** 卡片的图。加载失败 → 交给父级走无图降级（父级据 `failed` 置 data-noimg）。
 *  `alt=""` 是刻意的：图是纯装饰，标题就在旁边的文字里，读屏器再念一遍片名是噪音。 */
function CardImage({ src, className, onFail }: { src: string; className: string; onFail: () => void }) {
  return <img className={className} src={src} alt="" loading="lazy" onError={onFail} />
}

export interface WorkbenchCardFace {
  title: string
  /** 「2018 · 动画 · 13 集待处理」那一行，调用方拼好（i18n 在调用方）。 */
  subtitle: string
  posterPath: string | null
  backdropPath: string | null
}

/**
 * 「正在跑」的卡片。横版 backdrop（全幅 mask 溶边，字在左 46%）。
 *
 * `progress` 是 `{ done, total }`；index/total 为 null 时不传——**诚实的 null**，
 * 不编 "0/0"、不画 progressbar。分数行是 `` `${done} / ${total} ${suffix}` ``，
 * 不用 t() 插值引擎。`stepLabel` / `logLines` 必须已经是译文，禁止塞 raw tool id
 * 或 `event.message`。有图时不渲染 `.wb-run-fade`（不许再罩一层把图压暗）。
 */
export function RunCard(
  { face, progress, staleNote, stepLabel, logLines, elapsedLabel }:
  {
    face: WorkbenchCardFace
    progress?: { done: number; total: number } | null
    staleNote?: string | null
    stepLabel?: string | null
    logLines?: string[]
    elapsedLabel?: string | null
  },
) {
  const { t } = useT()
  const [failed, setFailed] = useState(false)
  const url = backdropUrl(face.backdropPath)
  const noimg = !url || failed
  const done = progress?.done
  const total = progress?.total
  const finite = typeof done === 'number' && Number.isFinite(done)
    && typeof total === 'number' && Number.isFinite(total)
  const lines = (logLines ?? []).slice(-5)
  const subtitle = elapsedLabel ? `${face.subtitle} · ${elapsedLabel}` : face.subtitle
  return (
    <div className="wb-run-card" data-noimg={noimg ? 'true' : 'false'}
         data-stale={staleNote ? 'true' : 'false'} data-testid="wb-run-card">
      {!noimg && <CardImage src={url} className="wb-run-img" onFail={() => setFailed(true)} />}
      {noimg ? <div className="wb-run-fade" /> : null}
      <div className="wb-run-body">
        <span className="wb-card-title">{face.title}</span>
        <span className="wb-card-sub">{subtitle}</span>
        {finite ? (
          <>
            <span className="wb-card-progress">
              {`${done} / ${total} ${t('wb_run_files_done_suffix')}`}
            </span>
            <div
              className="wb-run-bar"
              role="progressbar"
              aria-valuenow={done}
              aria-valuemin={0}
              aria-valuemax={total}
            >
              <div
                className="wb-run-bar-fill"
                style={{ width: total > 0 ? `${Math.min(100, Math.max(0, (done / total) * 100))}%` : '0%' }}
              />
            </div>
          </>
        ) : null}
        {stepLabel ? <span className="wb-run-step">{stepLabel}</span> : null}
        {lines.length > 0 ? (
          <div className="wb-run-log" role="log">
            {lines.map((line, i) => (
              <div key={`${i}:${line}`} className={i === lines.length - 1 ? 'wb-run-log-latest' : undefined}>
                {line}
              </div>
            ))}
          </div>
        ) : null}
        {staleNote
          ? <span className="wb-run-stale" role="status" data-testid="wb-run-stale">{staleNote}</span>
          : null}
      </div>
    </div>
  )
}

/** 「已排队」的卡片。竖版 poster。 */
export function QueueCard({ face }: { face: WorkbenchCardFace }) {
  const [failed, setFailed] = useState(false)
  const url = posterUrl(face.posterPath)
  const noimg = !url || failed
  return (
    <li className="wb-queue-card" data-noimg={noimg ? 'true' : 'false'} data-testid="wb-queue-card">
      {!noimg && <CardImage src={url} className="wb-queue-img" onFail={() => setFailed(true)} />}
      <div className="wb-queue-fade" />
      <div className="wb-queue-body">
        <span className="wb-card-title">{face.title}</span>
        <span className="wb-card-sub">{face.subtitle}</span>
      </div>
    </li>
  )
}
