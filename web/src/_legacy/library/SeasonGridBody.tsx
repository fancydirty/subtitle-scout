// web/src/library/SeasonGridBody.tsx：超长季（>50 集，见 EPISODE_ROW_CAP）紧凑格阵回落（详情页
// 重设计 item B）——复用 A 式 EpisodeCell 格阵，点某格在格阵下方行内展开该集简介（不逐集铺行，
// 适配国产长剧上百集）。同一时刻至多一格选中，再点同格收起。
import { useState } from 'react'
import type { GridCell } from './episodeState.js'
import { EpisodeCell } from './EpisodeCell.js'
import { useT } from '../../i18n/useT.js'

export function SeasonGridBody({ cells }: { cells: GridCell[] }) {
  const { t } = useT()
  const [sel, setSel] = useState<number | null>(null)
  const active = cells.find((c) => c.episode === sel) ?? null
  return (
    <div className="flex flex-col gap-2">
      <div className="ep-grid">
        {cells.map((cell) => (
          <EpisodeCell
            key={cell.episode}
            cell={cell}
            isSelected={cell.episode === sel}
            onSelect={() => setSel((p) => (p === cell.episode ? null : cell.episode))}
          />
        ))}
      </div>
      {active ? (
        <div className="library-eprow-body flex flex-col gap-1" style={{ paddingLeft: 10 }}>
          <span className="text-[11px] leading-4 text-muted-foreground">{`S·E${String(active.episode).padStart(2, '0')}`} {active.title ?? ''}</span>
          <span className="text-[13px] leading-5 text-muted-foreground">{active.overview ?? t('library_episode_no_overview')}</span>
        </div>
      ) : null}
    </div>
  )
}
