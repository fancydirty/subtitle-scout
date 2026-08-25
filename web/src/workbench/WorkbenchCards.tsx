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

/** 左 16:9 图 + 右实色栏。`as` 只换根节点；几何 class 由调用方给。
 *  `{...rest}` 先铺，chrome 后写——调用方不能靠 rest 盖掉 data-noimg / data-testid。 */
export function SplitHero({
  src,
  className,
  testId,
  as: Tag = 'div',
  stale,
  children,
  href,
  ...rest
}: {
  src: string | null
  className: string
  testId: string
  as?: 'div' | 'li' | 'a'
  stale?: boolean
  children: ReactNode
  href?: string
  'data-via'?: string
  'data-shape'?: string
} & HTMLAttributes<HTMLElement>) {
  const [failed, setFailed] = useState(false)
  const noimg = !src || failed
  const inner = (
    <>
      {!noimg && src ? <CardImage src={src} className="wb-run-img" onFail={() => setFailed(true)} /> : null}
      <div className="wb-run-body">{children}</div>
    </>
  )
  if (Tag === 'a') {
    return (
      <a
        {...rest}
        className={className}
        data-noimg={noimg ? 'true' : 'false'}
        data-stale={stale ? 'true' : 'false'}
        data-testid={testId}
        href={href}
      >
        {inner}
      </a>
    )
  }
  return (
    <Tag
      {...rest}
      className={className}
      data-noimg={noimg ? 'true' : 'false'}
      data-stale={stale ? 'true' : 'false'}
      data-testid={testId}
    >
      {inner}
    </Tag>
  )
}

/** 阶段步骤条：4 个节点，当前阶段高亮 + pulse 动画，已完成阶段打勾。
 *  字幕流: source → download → review → install
 *  翻译流: source → glossary → translate → install（用 cueProgress 画进度）
 *  调用方传入 stage（来自 stageOf(tool)），据此确定高亮位置。 */
const SUBTITLE_STAGES = ['source', 'download', 'review', 'install'] as const
const TRANSLATE_STAGES = ['source', 'glossary', 'translate', 'install'] as const

function StageBar({ stage, kind }: { stage: string | null; kind: 'subtitle' | 'translate' }) {
  const { t } = useT()
  const stages = kind === 'translate' ? TRANSLATE_STAGES : SUBTITLE_STAGES
  const activeIdx = stage ? (stages as readonly string[]).indexOf(stage) : -1
  if (activeIdx < 0) return null
  return (
    <div className="wb-stage-bar" role="list">
      {stages.map((s, i) => (
        <div
          key={s}
          className={`wb-stage-node${i < activeIdx ? ' done' : ''}${i === activeIdx ? ' active' : ''}`}
          data-stage={s}
          data-stage-active={i === activeIdx ? 'true' : 'false'}
        >
          <span className="wb-stage-dot">{i < activeIdx ? '✓' : i + 1}</span>
          <span className="wb-stage-label">{t(`wb_step_${s}` as Parameters<typeof t>[0])}</span>
        </div>
      ))}
    </div>
  )
}

/** 相同动作合并 "×N"：相邻重复行折叠。 */
function mergeLogLines(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const prev = out[out.length - 1]
    if (prev) {
      const m = /^(.*) ×(\d+)$/.exec(prev)
      const base = m ? m[1]! : prev
      const count = m ? Number(m[2]) : 1
      if (base === line) {
        out[out.length - 1] = `${base} ×${count + 1}`
        continue
      }
    }
    out.push(line)
  }
  return out.slice(-5)
}

/**
 * 「正在跑」的卡片。SplitHero + 右栏阶段步骤条 / 进度 / cue 进度 / log。
 *
 * `progress` 是 `{ done, total }`；index/total 为 null 时不传——**诚实的 null**，
 * 不编 "0/0"、不画 progressbar。`cueProgress` 是翻译的 cue 级进度（done/total 句），
 * 有值时画迷你进度条——这是活动页重做的核心动感。
 * `stepLabel` / `logLines` 必须已经是译文，禁止塞 raw tool id 或 `event.message`。
 * 有图时不渲染 `.wb-run-fade`（不许再罩一层把图压暗）。
 */
export function RunCard(
  { face, stage, kind, progress, cueProgress, staleNote, stepLabel, logLines, elapsedLabel }:
  {
    face: WorkbenchCardFace
    stage?: string | null
    kind?: 'subtitle' | 'translate'
    progress?: { done: number; total: number } | null
    cueProgress?: { done: number; total: number } | null
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
  const lines = mergeLogLines(logLines ?? [])
  const subtitle = elapsedLabel ? `${face.subtitle} · ${elapsedLabel}` : face.subtitle
  const cueDone = cueProgress?.done
  const cueTotal = cueProgress?.total
  const cueFinite = typeof cueDone === 'number' && Number.isFinite(cueDone)
    && typeof cueTotal === 'number' && Number.isFinite(cueTotal)
    && cueTotal > 0
  return (
    <SplitHero
      className="wb-run-card"
      testId="wb-run-card"
      stale={!!staleNote}
      src={backdropUrl(face.backdropPath)}
    >
      <span className="wb-card-title">{face.title}</span>
      <span className="wb-card-sub">{subtitle}</span>
      <StageBar stage={stage ?? null} kind={kind ?? 'subtitle'} />
      {cueFinite ? (
        <div className="wb-cue-progress">
          <span className="wb-cue-label">{stepLabel ?? ''} {cueProgress!.done} / {cueProgress!.total} {t('wb_run_cues_done_suffix')}</span>
          <div
            className="wb-cue-bar"
            data-cue-bar
            role="progressbar"
            aria-valuenow={cueProgress!.done}
            aria-valuemin={0}
            aria-valuemax={cueProgress!.total}
          >
            <div
              className="wb-cue-bar-fill"
              style={{ width: `${Math.min(100, (cueProgress!.done / cueProgress!.total) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}
      {finite && !cueFinite ? (
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
      {stepLabel && !cueFinite ? <span className="wb-run-step">{stepLabel}</span> : null}
      {lines.length > 0 ? (
        <div className="wb-run-log" role="log">
          {lines.map((line, i) => (
            <div key={`${i}:${line}`} data-log-line className={i === lines.length - 1 ? 'wb-run-log-latest' : undefined}>
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