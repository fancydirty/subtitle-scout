// web/src/library/SeasonGridBody.tsx：超长季（>50 集，见 EPISODE_ROW_CAP）紧凑格阵回落（详情页
// 重设计 item B）——复用 A 式 EpisodeCell 格阵，点某格在格阵下方行内展开该集简介（不逐集铺行，
// 适配国产长剧上百集）。同一时刻至多一格选中，再点同格收起。
import { useState } from 'react'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import type { GridCell } from './episodeState.js'
import { EpisodeCell } from './EpisodeCell.js'
import { useT } from '../i18n/useT.js'

export function SeasonGridBody({ cells }: { cells: GridCell[] }) {
  const { t } = useT()
  const [sel, setSel] = useState<number | null>(null)
  const active = cells.find((c) => c.episode === sel) ?? null
  return (
    <VStack gap={2}>
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
        <VStack gap={1} className="library-eprow-body" style={{ paddingLeft: 10 }}>
          <Text type="supporting" color="secondary">{`S·E${String(active.episode).padStart(2, '0')}`} {active.title ?? ''}</Text>
          <Text type="body" color="secondary">{active.overview ?? t('library_episode_no_overview')}</Text>
        </VStack>
      ) : null}
    </VStack>
  )
}
