// web/src/library/EpisodeDetail.tsx：C 式右侧详情板——固定右侧滑入，不跳页不弹 modal
// （DESIGN.md §5/§6）。文件名（mono，可换行）+ 字幕覆盖清单（lang + 文件名 mono）+ 停牌原因 +
// next recheck（throttled 时）+ esc 键帽角标关闭。dashed 格（磁盘无）显示 canonical 标题 +
// "not on disk"。
import { useHotkeys } from '@astryxdesign/core/hooks'
import { Kbd } from '@astryxdesign/core/Kbd'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Divider } from '@astryxdesign/core/Divider'
import type { LibraryCoverageRowDTO } from '../api/types.js'
import type { GridCell } from './episodeState.js'
import { useT } from '../i18n/useT.js'
import { formatDuration } from './text.js'

interface Props {
  season: number
  cell: GridCell
  coverage: LibraryCoverageRowDTO[]
  onClose: () => void
}

/** path 尾段——规格解析（分辨率/压制组）故意不做，直接给文件名本身（任务规格明说）。 */
function basename(path: string): string {
  const segs = path.split('/')
  return segs[segs.length - 1] || path
}

export function EpisodeDetail({ season, cell, coverage, onClose }: Props) {
  const { t } = useT()
  useHotkeys([{ keys: 'escape', onPress: onClose }])

  const episodeLabel = `S${String(season).padStart(2, '0')}E${String(cell.episode).padStart(2, '0')}`
  const episodeCoverage = coverage.filter((c) => c.episode === cell.episode)
  const isHardsubAssumed = cell.onDisk?.subStatus === 'hardsub-assumed'

  return (
    <div className="library-detail-panel" role="dialog" aria-label={episodeLabel}>
      <HStack gap={2} vAlign="center" justify="between" padding={4}>
        <VStack gap={0.5}>
          <Text type="code" color="secondary">
            {episodeLabel}
          </Text>
          {cell.title ? (
            <Text type="label" color="primary">
              {cell.title}
            </Text>
          ) : null}
        </VStack>
        <button
          type="button"
          className="library-detail-close"
          onClick={onClose}
          aria-label={t('library_detail_close_label')}
        >
          <Kbd keys="escape" />
        </button>
      </HStack>
      <Divider />

      <VStack gap={4} padding={4}>
        {cell.state === 'dashed' || !cell.onDisk ? (
          <Text type="body" color="secondary">
            {t('library_detail_not_on_disk')}
          </Text>
        ) : (
          <>
            <VStack gap={1}>
              <Text type="supporting" color="secondary">
                {t('library_detail_file_heading')}
              </Text>
              <Text type="code" wordBreak="break-all">
                {basename(cell.onDisk.path)}
              </Text>
            </VStack>

            <VStack gap={1}>
              <Text type="supporting" color="secondary">
                {t('library_detail_subtitles_heading')}
              </Text>
              {isHardsubAssumed ? (
                <Text type="body" color="secondary">
                  {t('library_detail_hardsub_assumed')}
                </Text>
              ) : episodeCoverage.length === 0 ? (
                <Text type="body" color="secondary">
                  {t('library_detail_no_subtitles')}
                </Text>
              ) : (
                <VStack gap={1}>
                  {episodeCoverage.map((c, i) => (
                    <HStack gap={2} key={i}>
                      <Text type="code" color="secondary">
                        {c.lang}
                      </Text>
                      <Text type="code" wordBreak="break-all">
                        {basename(c.path)}
                      </Text>
                    </HStack>
                  ))}
                </VStack>
              )}
            </VStack>

            {cell.onDisk.statusReason ? (
              <VStack gap={1}>
                <Text type="body" color="secondary">
                  {cell.onDisk.statusReason}
                </Text>
                {cell.state === 'throttled' && cell.onDisk.recheckAfter != null ? (
                  <Text type="code" color="secondary">
                    {t('library_detail_next_recheck_prefix')} {formatDuration(cell.onDisk.recheckAfter - Date.now())}
                  </Text>
                ) : null}
              </VStack>
            ) : null}
          </>
        )}
      </VStack>
    </div>
  )
}
