// web/src/workflow/SummaryLine.tsx：顶部人话总览行（验收修复轮一 Task V4，design §B，铁律①：
// 句子主语=内容，不是系统部件）——Midday 式大数字嵌句："Watching {gaps} gaps · {n} episodes
// installed in the last 24h · {m} agent(s) working"。三个片段各自独立依赖不同的数据源
// （gaps←pending，installed/agents←workers），任一数据源尚未到位（Async.data 仍是 null——首载
// loading 或请求失败）时省略对应片段，不显示编造的 "0" 占位假话（DESIGN.md §8：前端只呈现
// 事实，不替 agent 判断）。三个片段都缺席时整行不渲染。
import type { ReactNode } from 'react'
import { Text } from '@astryxdesign/core/Text'
import type { Async } from '../api/hooks.js'
import type { WorkflowPendingDTO, WorkflowWorkersDTO } from '../api/types.js'

interface Props {
  pending: Async<WorkflowPendingDTO>
  workers: Async<WorkflowWorkersDTO>
}

/** Midday 式嵌入数字——粗体大字号内联在句子里（同 library/SeriesPage.tsx
 *  seasonCoverageSentence 的既有呈现口径：数字负字距大字号嵌句，不做仪表盘环形图）。 */
function Num({ children }: { children: number }) {
  return (
    <Text type="body" as="span" weight="semibold" color="primary" size="lg">
      {children}
    </Text>
  )
}

export function SummaryLine({ pending, workers }: Props) {
  const gaps = pending.data ? pending.data.series.length + pending.data.movies.length : null
  const installed = workers.data ? workers.data.installedLast24h : null
  const translated = workers.data ? workers.data.translatedLast24h : null
  const running = workers.data ? workers.data.running.length : null

  const segments: ReactNode[] = []
  if (gaps != null) {
    segments.push(
      <span key="gaps">
        Watching <Num>{gaps}</Num> gaps
      </span>,
    )
  }
  if (installed != null) {
    segments.push(
      <span key="installed">
        <Num>{installed}</Num> episodes installed in the last 24h
      </span>,
    )
  }
  // 审计 UX-P0:翻译计数与下载计数分列(仅 >0 时显示——翻译是烧钱路径,有产出才给片段,
  //  与"不编造 0 占位"的 SummaryLine 既有哲学一致)。
  if (translated != null && translated > 0) {
    segments.push(
      <span key="translated">
        <Num>{translated}</Num> translated
      </span>,
    )
  }
  if (running != null) {
    segments.push(
      <span key="running">
        <Num>{running}</Num> agent{running === 1 ? '' : 's'} working
      </span>,
    )
  }
  // 字幕校验的推进度（2026-07-31）。只在**铺量期**显示（done < total）——铺满之后这个片段
  // 消失，因为"282 / 282 已检查"是一句没有信息的废话，而 SummaryLine 的既有哲学就是
  // 不给不携带信息的占位。检验从未跑过（lastVerifySweepAt === null）时也不显示：
  // 那时 0/282 会读成"这功能坏了"，而真相是它还没到第一个时间门。
  const vDone = pending.data ? pending.data.meta.verifiedItems : null
  const vTotal = pending.data ? pending.data.meta.verifiableItems : null
  const vSweptAt = pending.data ? pending.data.meta.lastVerifySweepAt : null
  if (vDone != null && vTotal != null && vSweptAt != null && vTotal > 0 && vDone < vTotal) {
    segments.push(
      <span key="verify">
        subtitle timing checked on <Num>{vDone}</Num> of <Num>{vTotal}</Num>
      </span>,
    )
  }

  if (segments.length === 0) return null

  return (
    <div data-testid="wf-summary-line">
      <Text type="body" color="secondary">
        {segments.map((seg, i) => (
          <span key={i}>
            {i > 0 ? ' · ' : ''}
            {seg}
          </span>
        ))}
      </Text>
    </div>
  )
}
