// web/src/library/EpisodeCell.tsx：A 式格阵的单格——灰格（surface 底 + 发丝线）+ 左上 5px
// 语义点 + mono 集号。canonical 有而磁盘无 = dashed 边框空格（三层合成的核心呈现）。
//
// 视觉全靠 styles.css 集中的 .ep-cell 家族原子 CSS：Text 组件没有 font-style（斜体，throttled
// 态用来跟其它态区分）也没有 xstyle 之外的样式逃生口（同 PosterCard.tsx 顶部注释的理由），
// 这一小块格阵天生是"组件语言表达不了"的原子级 UI，DESIGN.md §10 明确允许集中开一段。
import type { GridCell } from './episodeState.js'

interface Props {
  cell: GridCell
  isSelected: boolean
  onSelect: () => void
}

export function EpisodeCell({ cell, isSelected, onSelect }: Props) {
  const classes = [
    'ep-cell',
    `ep-cell-${cell.state}`,
    isSelected ? 'ep-cell-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type="button" className={classes} onClick={onSelect} aria-pressed={isSelected}>
      {cell.state !== 'dashed' ? <span className={`ep-dot ep-dot-${cell.state}`} aria-hidden="true" /> : null}
      <span className="ep-num">{cell.episode}</span>
    </button>
  )
}
