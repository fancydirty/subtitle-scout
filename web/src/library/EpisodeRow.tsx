// web/src/library/EpisodeRow.tsx：逐集行（详情页重设计 item B）——5px 语义点 + mono 集号 + 标题
// 在左，剧照 + 首播日在右，点击整行行内展开该集 TMDB 简介（同一时刻至多一行开，由父组件管状态）。
// overview 缺失时展开区显示占位文案而非空白。内嵌集在标题旁挂 mono "内嵌" 角标。
//
// 2026-07-30（字幕校验）：外层从 <button> 改成 <div>，展开动作收进内部那个铺满主区域的
// <button>，校验芯片作为它的**兄弟**节点。原因是芯片在 shifted 态本身要可点（打开检视
// 面板），而 button 套 button 是非法 HTML——屏幕阅读器行为未定义、键盘 Tab 顺序错乱。
// 视觉上完全不变：flex 布局、hover 底色、active 左边框都还挂在 .library-eprow-head 上，
// 只是那个类现在长在 div 而不是 button 上。
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { GridCell } from './episodeState.js'
import type { SubtitleVerifyDTO } from '../api/types.js'
import { stillUrl } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { VerifyChip } from './VerifyChip.js'

interface Props {
  cell: GridCell
  expanded: boolean
  onToggle: () => void
  /** 字幕校验结论。缺席=父组件还没拿到（或这一格没有磁盘行）→ 不渲染芯片。 */
  verify?: SubtitleVerifyDTO
  /** 点红芯片打开检视面板。缺席时红芯片降级为不可点。 */
  onInspect?: () => void
}

// grid 语义态 → 5px 点样式类（复用 EpisodeCell 家族的 .ep-dot-* 原子样式）。未知态兜底灰点。
const DOT_CLASS: Record<string, string> = {
  covered: 'ep-dot-covered',
  hardsub: 'ep-dot-hardsub',
  missing: 'ep-dot-missing',
  throttled: 'ep-dot-throttled',
  partial: 'ep-dot-partial',
  error: 'ep-dot-missing',
  dashed: 'ep-dot-missing',
}

export function EpisodeRow({ cell, expanded, onToggle, verify, onInspect }: Props) {
  const { t } = useT()
  const isEmbedded = cell.onDisk?.subStatus === 'embedded'
  const still = stillUrl(cell.stillPath)
  const epLabel = `E${String(cell.episode).padStart(2, '0')}`
  return (
    <div className={`library-eprow${expanded ? ' library-eprow-active' : ''}`}>
      <div className="library-eprow-head">
        <button type="button" className="library-eprow-toggle" onClick={onToggle} aria-expanded={expanded}>
          <span className={`ep-dot ${DOT_CLASS[cell.state] ?? 'ep-dot-missing'}`} aria-hidden="true" />
          <Text type="code" color="secondary">{epLabel}</Text>
          <Text type="label" color="primary">{cell.title ?? epLabel}</Text>
          {isEmbedded ? <span className="library-eprow-tag">{t('library_detail_embedded_short')}</span> : null}
          <span className="library-eprow-spacer" />
          {still ? <img className="library-eprow-still" src={still} alt="" loading="lazy" /> : null}
          {cell.airDate ? <Text type="code" color="secondary">{cell.airDate}</Text> : null}
        </button>
        {verify ? <VerifyChip state={verify.state} checked={verify.checked} onInspect={onInspect} /> : null}
      </div>
      {expanded ? (
        <VStack gap={1} className="library-eprow-body">
          <Text type="body" color="secondary">{cell.overview ?? t('library_episode_no_overview')}</Text>
        </VStack>
      ) : null}
    </div>
  )
}
