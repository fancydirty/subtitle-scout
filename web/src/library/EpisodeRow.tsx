// web/src/library/EpisodeRow.tsx：逐集行（详情页重设计 item B）——5px 语义点 + mono 集号 + 标题
// 在左，剧照 + 首播日在右，点击整行行内展开该集 TMDB 简介（同一时刻至多一行开，由父组件管状态）。
// overview 缺失时展开区显示占位文案而非空白。内嵌集在标题旁挂 mono "内嵌" 角标。
//
// 2026-08-07（spec §5）：字幕校验本轮雪藏——verify/onInspect 两个 prop、VerifyChip 渲染点、
// 展开区的"看字幕时间轴"入口一并摘掉（留着会是 TS 未使用告警 + 孤儿 i18n 键）。VerifyChip.tsx
// 与 web/src/subtitleVerify/** 的源码测试全部保留，将来重启用时把这三处加回即可。
// 历史注释（2026-07-30 字幕校验）：外层从 <button> 改成 <div>，展开动作收进内部那个铺满主区域的
// <button>，校验芯片作为它的**兄弟**节点。原因是芯片在 shifted 态本身要可点（打开检视
// 面板），而 button 套 button 是非法 HTML——屏幕阅读器行为未定义、键盘 Tab 顺序错乱。
// 视觉上完全不变：flex 布局、hover 底色、active 左边框都还挂在 .library-eprow-head 上，
// 只是那个类现在长在 div 而不是 button 上（芯片下架后这个 div 保持不动，避免无关的结构回归）。
import type { GridCell } from './episodeState.js'
import { stillUrl } from '../api/client.js'
import { useT } from '../i18n/useT.js'

interface Props {
  cell: GridCell
  expanded: boolean
  onToggle: () => void
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

export function EpisodeRow({ cell, expanded, onToggle }: Props) {
  const { t } = useT()
  const isEmbedded = cell.onDisk?.subStatus === 'embedded'
  const still = stillUrl(cell.stillPath)
  const epLabel = `E${String(cell.episode).padStart(2, '0')}`
  return (
    <div className={`library-eprow${expanded ? ' library-eprow-active' : ''}`}>
      <div className="library-eprow-head">
        <button type="button" className="library-eprow-toggle" onClick={onToggle} aria-expanded={expanded}>
          <span className={`ep-dot ${DOT_CLASS[cell.state] ?? 'ep-dot-missing'}`} aria-hidden="true" />
          <span className="font-mono text-[13px] leading-5 text-muted-foreground">{epLabel}</span>
          <span className="text-[13px] font-medium leading-5 text-foreground">{cell.title ?? epLabel}</span>
          {isEmbedded ? <span className="library-eprow-tag">{t('library_detail_embedded_short')}</span> : null}
          <span className="library-eprow-spacer" />
          {still ? <img className="library-eprow-still" src={still} alt="" loading="lazy" /> : null}
          {cell.airDate ? <span className="font-mono text-[13px] leading-5 text-muted-foreground">{cell.airDate}</span> : null}
        </button>
      </div>
      {expanded ? (
        <div className="library-eprow-body flex flex-col gap-1">
          <span className="text-[13px] leading-5 text-muted-foreground">{cell.overview ?? t('library_episode_no_overview')}</span>
          {/* 时间轴入口（library_verify_inspect 按钮）随字幕校验下架移除（spec §5）——原设计把它
              放在展开区而不是绿芯片上，是为了让绿芯片保持零焦点（一整季 24 个绿点不该让 Tab 空转），
              同时给"无法验证"的条目一个自己看对照图的入口。重启用时把那个 button 加回这里。 */}
        </div>
      ) : null}
    </div>
  )
}
