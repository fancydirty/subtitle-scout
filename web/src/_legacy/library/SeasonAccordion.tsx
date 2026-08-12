// web/src/library/SeasonAccordion.tsx：季手风琴（详情页重设计 item B）——季头恒显卷起汇总（人话
// 覆盖句，大数字嵌句），点头开合。展开后按集数分派：≤50 集逐集行式（EpisodeRow，剧照+行内展开
// 简介），>50 集回落紧凑格阵（SeasonGridBody）。canonical 未缓存时显示提示。行式下同一时刻至多
// 一行展开。
//
// 2026-08-07（spec §5）：字幕校验本轮雪藏——这一层的整季取数（useSubtitleVerify）、检视面板
// （InspectPanel/InspectBoundary + useSubtitleCompare + api.subtitleCorrect）与传给 EpisodeRow 的
// verify/onInspect prop 全部摘掉。subtitleVerify/** 的源码与测试保留，将来重启用时按下面的
// 历史注释把取数点和面板加回这一层。
// 历史注释（2026-07-30 字幕校验）：这一层是校验数据的**取数点**——一次拿整季（useSubtitleVerify
// 批量端点），而不是让每个 EpisodeRow 各发一个请求（24 集就是 24 个往返）。EpisodeRow 保持纯展示，
// 校验状态作为 prop 传下去；点红芯片打开的检视面板也挂在这一层，因为同一时刻只该有一个面板
// （面板外还包一层 InspectBoundary，key 绑 itemId——审计 I-D1：面板抛错曾白屏整个应用）。
import { useState } from 'react'
import type { LibrarySeasonDTO } from '../../api/types.js'
import { buildGridCells, tallyGridCells, isCanonicalPending, EPISODE_ROW_CAP } from './episodeState.js'
import { seasonCoverageSentence } from './text.js'
import { EpisodeRow } from './EpisodeRow.js'
import { SeasonGridBody } from './SeasonGridBody.js'
import { useT } from '../../i18n/useT.js'

interface Props {
  season: LibrarySeasonDTO
  now: number
  defaultOpen?: boolean
}

export function SeasonAccordion({ season, now, defaultOpen = true }: Props) {
  const { t, lang } = useT()
  const [open, setOpen] = useState(defaultOpen)
  const [expandedEp, setExpandedEp] = useState<number | null>(null)
  const cells = buildGridCells(season, now)
  const tally = tallyGridCells(cells)
  const sentence = seasonCoverageSentence(season.season, tally, lang)
  const useGrid = cells.length > EPISODE_ROW_CAP

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className="library-season-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`library-season-chev${open ? ' open' : ''}`} aria-hidden="true">›</span>
        <span className="text-[13px] leading-5 text-muted-foreground">
          {sentence.prefix} <span className="text-[16px] font-semibold leading-[1.5385] text-foreground">{sentence.emphasis}</span> {sentence.suffix}
          {sentence.clause ? <span className="text-muted-foreground"> — {sentence.clause}</span> : null}
        </span>
      </button>
      {isCanonicalPending(season) ? <span className="font-mono text-[13px] leading-5 text-muted-foreground">{t('library_detail_canonical_pending')}</span> : null}
      {open ? (
        useGrid ? <SeasonGridBody cells={cells} /> : (
          <div>
            {cells.map((cell) => (
              <EpisodeRow
                key={cell.episode}
                cell={cell}
                expanded={expandedEp === cell.episode}
                onToggle={() => setExpandedEp((p) => (p === cell.episode ? null : cell.episode))}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}
