// web/src/workbench/WorkbenchCards.tsx —— 活动页在跑 / 排队共用 B 切分英雄卡。
//
// 两张卡都走 SplitHero：左栏 16:9 backdrop（w1280），右栏实色写字。
// 无图 = 不渲染 img、不留空海报槽、不拿竖版 poster 填 16:9。
// 几何与 mask 全在 styles.css 的 .wb-* 段（CSS 变量驱动；不许 clamp()）。
// 本文件只负责：取 backdrop、onError → data-noimg、右栏文案。
import { useState, type HTMLAttributes, type ReactNode } from 'react'
import { backdropUrl } from '../api/client.js'
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

/** 左 16:9 图 + 右实色栏。`as` 只换根节点；几何 class 由调用方给。 */
export function SplitHero({
  src,
  className,
  testId,
  as: Tag = 'div',
  stale,
  children,
  ...rest
}: {
  src: string | null
  className: string
  testId: string
  as?: 'div' | 'li'
  stale?: boolean
  children: ReactNode
} & HTMLAttributes<HTMLElement>) {
  const [failed, setFailed] = useState(false)
  const noimg = !src || failed
  return (
    <Tag
      className={className}
      data-noimg={noimg ? 'true' : 'false'}
      data-stale={stale ? 'true' : 'false'}
      data-testid={testId}
      {...rest}
    >
      {!noimg && src ? <CardImage src={src} className="wb-run-img" onFail={() => setFailed(true)} /> : null}
      <div className="wb-run-body">{children}</div>
    </Tag>
  )
}

/**
 * 「正在跑」的卡片。SplitHero + 右栏进度/步骤/log。
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
  const done = progress?.done
  const total = progress?.total
  const finite = typeof done === 'number' && Number.isFinite(done)
    && typeof total === 'number' && Number.isFinite(total)
  const lines = (logLines ?? []).slice(-5)
  const subtitle = elapsedLabel ? `${face.subtitle} · ${elapsedLabel}` : face.subtitle
  return (
    <SplitHero
      className="wb-run-card"
      testId="wb-run-card"
      stale={!!staleNote}
      src={backdropUrl(face.backdropPath)}
    >
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
    </SplitHero>
  )
}

/** 「已排队」的卡片。同一套 SplitHero，backdrop，右栏只有片名+副标题。 */
export function QueueCard({ face }: { face: WorkbenchCardFace }) {
  return (
    <SplitHero
      as="li"
      className="wb-queue-card"
      testId="wb-queue-card"
      src={backdropUrl(face.backdropPath)}
    >
      <span className="wb-card-title">{face.title}</span>
      <span className="wb-card-sub">{face.subtitle}</span>
    </SplitHero>
  )
}
