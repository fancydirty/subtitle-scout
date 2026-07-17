// web/src/workflow/TraceRows.tsx：Inngest 式痕迹行——等宽工具名 + argsSummary 截断灰字 +
// 右对齐耗时（DESIGN.md §6/任务规格）。纯技术值展示，跟 EpisodeCell 的 .ep-num 一样走手写
// CSS 类而不是 Astryx <Text>（Text 没有 className 逃生口，这种密集单行网格布局需要 flex
// 对齐，参见 styles.css 顶部关于"组件语言表达不了"的既有说明）。
//
// live=true（Now working 卡直播视图）时末尾追加一行蓝点延展动画，代表"仍在跑、等下一条痕迹"
// （DESIGN.md §5：动效只给 active 等四件事之一）；live=false（默认，RunDetail 快照回放）时
// 静态渲染，没有这一行——回放不是直播。
//
// phraseMode（验收修复轮一 Task V4，design §B）：Now working 卡的直播步骤保留（灵魂卖点），
// 但工具名经 toolPhrase 映射成人话短语、argsSummary 不渲染（工程细节收在点开之后的 RunDetail
// 右侧板）；默认 false 时是 RunDetail 快照回放路径，逐字节维持原样——原始工具名 + argsSummary
// 都在场，这条路径不受这次改动影响（既有测试锁死）。
import type { TraceEvent } from '../api/types.js'
import { truncate } from './text.js'
import { formatTookMs } from './time.js'
import { toolPhrase } from './phrases.js'

interface Props {
  events: TraceEvent[]
  live?: boolean
  phraseMode?: boolean
}

export function TraceRows({ events, live = false, phraseMode = false }: Props) {
  return (
    <div className="wf-trace-rows">
      {events.map((e) => (
        // key 必须带 runKey（R2D-18）：realign 的混流 trail/回放合法地含多个 seq=0（各子集
        // runKey 的 seq 都从 0 起算），纯 seq 会撞 React key——与 mergeTrail 的去重复合键同形。
        <div className="wf-trace-row" key={`${e.runKey}#${e.seq}`}>
          <span className="wf-trace-tool">{phraseMode ? toolPhrase(e.tool) : e.tool}</span>
          {phraseMode ? null : <span className="wf-trace-args">{truncate(e.argsSummary, 60)}</span>}
          <span className="wf-trace-took">{formatTookMs(e.tookMs)}</span>
        </div>
      ))}
      {live ? (
        <div className="wf-trace-row wf-trace-row-active" data-testid="wf-trace-active" aria-hidden="true">
          <span className="wf-trace-active-dot" />
          <span className="wf-trace-active-bar" />
        </div>
      ) : null}
    </div>
  )
}
