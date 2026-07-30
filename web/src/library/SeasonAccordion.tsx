// web/src/library/SeasonAccordion.tsx：季手风琴（详情页重设计 item B）——季头恒显卷起汇总（人话
// 覆盖句，大数字嵌句），点头开合。展开后按集数分派：≤50 集逐集行式（EpisodeRow，剧照+行内展开
// 简介），>50 集回落紧凑格阵（SeasonGridBody）。canonical 未缓存时显示提示。行式下同一时刻至多
// 一行展开。
//
// 2026-07-30（字幕校验）：这一层是校验数据的**取数点**——一次拿整季（useSubtitleVerify 批量
// 端点），而不是让每个 EpisodeRow 各发一个请求（24 集就是 24 个往返）。EpisodeRow 保持纯展示，
// 校验状态作为 prop 传下去；点红芯片打开的检视面板也挂在这一层，因为同一时刻只该有一个面板。
import { useCallback, useMemo, useState } from 'react'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import type { LibrarySeasonDTO, SubtitleVerifyDTO } from '../api/types.js'
import { buildGridCells, tallyGridCells, isCanonicalPending, EPISODE_ROW_CAP } from './episodeState.js'
import { seasonCoverageSentence } from './text.js'
import { EpisodeRow } from './EpisodeRow.js'
import { SeasonGridBody } from './SeasonGridBody.js'
import { useSubtitleVerify, useSubtitleCompare } from '../api/hooks.js'
import { InspectPanel } from '../subtitleVerify/InspectPanel.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'

interface Props {
  season: LibrarySeasonDTO
  now: number
  defaultOpen?: boolean
}

export function SeasonAccordion({ season, now, defaultOpen = true }: Props) {
  const { t, lang } = useT()
  const [open, setOpen] = useState(defaultOpen)
  const [expandedEp, setExpandedEp] = useState<number | null>(null)
  /** 正在检视的 itemId。null = 面板关闭。同一时刻至多一个——面板是模态的。 */
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [correcting, setCorrecting] = useState(false)
  const cells = buildGridCells(season, now)
  const tally = tallyGridCells(cells)
  const sentence = seasonCoverageSentence(season.season, tally, lang)
  const useGrid = cells.length > EPISODE_ROW_CAP

  // 只给磁盘上真实存在的集查校验——dashed 格（canonical 有而磁盘无）没有文件可校验。
  // 季未展开时也不查：折叠状态下芯片根本不可见，省掉整季的往返。
  const itemIds = useMemo(
    () => (open ? cells.map((c) => c.onDisk?.itemId).filter((x): x is string => x !== undefined) : []),
    [cells, open],
  )
  const verify = useSubtitleVerify(itemIds)
  const verifyByItem = useMemo(() => {
    const m = new Map<string, SubtitleVerifyDTO>()
    for (const v of verify.data?.items ?? []) m.set(v.itemId, v)
    return m
  }, [verify.data])

  const compare = useSubtitleCompare(inspecting)

  const onCorrect = useCallback(async () => {
    if (inspecting === null) return
    setCorrecting(true)
    try {
      await api.subtitleCorrect(inspecting)
      // 校正后重新拉校验结论：后端在 correct 里已重新检测并覆盖落库，这里只需刷新视图。
      // 不做乐观更新——校正结果可能是"仍然 shifted"（残差），谎报成功比等一次往返更糟。
      verify.reload()
      setInspecting(null)
    } catch {
      // 失败保持面板打开，让用户看到仍是红的；具体原因在后端日志里（铁律：
      // 不把内部 detail 糊到界面上）
    } finally {
      setCorrecting(false)
    }
  }, [inspecting, verify])

  const inspectTitle = useMemo(() => {
    if (inspecting === null) return ''
    const cell = cells.find((c) => c.onDisk?.itemId === inspecting)
    if (cell === undefined) return ''
    const ep = `E${String(cell.episode).padStart(2, '0')}`
    return cell.title === null ? ep : `${ep} · ${cell.title}`
  }, [inspecting, cells])

  return (
    <VStack gap={2}>
      <button type="button" className="library-season-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`library-season-chev${open ? ' open' : ''}`} aria-hidden="true">›</span>
        <Text type="body" color="secondary">
          {sentence.prefix} <Text as="span" weight="semibold" color="primary" size="lg">{sentence.emphasis}</Text> {sentence.suffix}
          {sentence.clause ? <Text as="span" color="secondary"> — {sentence.clause}</Text> : null}
        </Text>
      </button>
      {isCanonicalPending(season) ? <Text type="code" color="secondary">{t('library_detail_canonical_pending')}</Text> : null}
      {open ? (
        useGrid ? <SeasonGridBody cells={cells} /> : (
          <div>
            {cells.map((cell) => {
              const itemId = cell.onDisk?.itemId
              return (
                <EpisodeRow
                  key={cell.episode}
                  cell={cell}
                  expanded={expandedEp === cell.episode}
                  onToggle={() => setExpandedEp((p) => (p === cell.episode ? null : cell.episode))}
                  verify={itemId === undefined ? undefined : verifyByItem.get(itemId)}
                  onInspect={itemId === undefined ? undefined : () => setInspecting(itemId)}
                />
              )
            })}
          </div>
        )
      ) : null}
      {inspecting !== null ? (
        <InspectPanel
          isOpen
          onOpenChange={(o) => { if (!o) setInspecting(null) }}
          title={inspectTitle}
          data={compare.data}
          loading={compare.loading}
          error={compare.error}
          onCorrect={onCorrect}
          correcting={correcting}
        />
      ) : null}
    </VStack>
  )
}
