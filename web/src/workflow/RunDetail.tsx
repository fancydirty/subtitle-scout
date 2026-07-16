// web/src/workflow/RunDetail.tsx：C 式右侧详情板——固定右侧滑入，不跳页不弹 modal（DESIGN.md
// §5/§6，沿用 F3 EpisodeDetail 的既有先例）。打开自 Passes 泳道点开一张 PassCard：detail 全文
// mono 块 + receipts 分布 + 快照回放（GET runs/:id/trace 拿事件列表，静态 TraceRows 渲染，
// live=false——回放≠直播，无蓝点延展）。
//
// 没有 Rerun 按钮：WorkflowPassDTO（orchestrate 通行记录）本身不带 seriesId——orchestrate
// job 的 series_id 是编排层用的合成值（'orchestrator-shard-N'），不是真实剧集，从 pass 结构上
// 就关联不到某一部具体的剧（DESIGN 任务规格："从 pass 关联不到 series 时不显示"）。Rerun 只
// 活在 PendingLane 每个真实 series 行的 hover 工具条里，这里没有数据可以喂给它。
import { useHotkeys } from '@astryxdesign/core/hooks'
import { Kbd } from '@astryxdesign/core/Kbd'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Divider } from '@astryxdesign/core/Divider'
import { useRunTrace } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { relativeAgo } from './time.js'
import { receiptChips } from './text.js'
import { TraceRows } from './TraceRows.js'
import type { WorkflowPassDTO } from '../api/types.js'

interface Props {
  pass: WorkflowPassDTO
  now: number
  onClose: () => void
}

export function RunDetail({ pass, now, onClose }: Props) {
  const { t } = useT()
  useHotkeys([{ keys: 'escape', onPress: onClose }])
  const trace = useRunTrace(pass.id)
  const chips = receiptChips(pass.receipts)
  const at = pass.finishedAt ?? pass.startedAt

  return (
    <div className="wf-rundetail-panel" role="dialog" aria-label={`pass ${pass.id}`}>
      <HStack gap={2} vAlign="center" justify="between" padding={4}>
        <VStack gap={0.5}>
          <Text type="code" color="secondary">
            pass #{pass.id}
          </Text>
          <Text type="supporting" color="secondary">
            {relativeAgo(now - at)}
          </Text>
        </VStack>
        <button
          type="button"
          className="wf-rundetail-close"
          onClick={onClose}
          aria-label={t('workflow_rundetail_close_label')}
        >
          <Kbd keys="escape" />
        </button>
      </HStack>
      <Divider />

      <VStack gap={4} padding={4}>
        {pass.detail ? (
          <VStack gap={1}>
            <Text type="supporting" color="secondary">
              {t('workflow_rundetail_detail_heading')}
            </Text>
            <Text type="code" wordBreak="break-word">
              {pass.detail}
            </Text>
          </VStack>
        ) : null}

        {chips.length > 0 ? (
          <VStack gap={1}>
            <Text type="supporting" color="secondary">
              {t('workflow_rundetail_receipts_heading')}
            </Text>
            <div className="wf-chip-row">
              {chips.map((c) => (
                <span className="wf-chip" key={c}>
                  {c}
                </span>
              ))}
            </div>
          </VStack>
        ) : null}

        <VStack gap={1}>
          <Text type="supporting" color="secondary">
            {t('workflow_rundetail_replay_heading')}
          </Text>
          {trace.loading && !trace.data ? (
            <Text type="code" color="secondary">
              loading…
            </Text>
          ) : trace.error && !trace.data ? (
            <Text type="body" color="secondary">
              {t('workflow_rundetail_replay_error_prefix')}
              {trace.error}
            </Text>
          ) : trace.data && trace.data.events.length === 0 ? (
            <Text type="body" color="secondary">
              {t('workflow_rundetail_replay_empty')}
            </Text>
          ) : trace.data ? (
            <TraceRows events={trace.data.events} />
          ) : null}
        </VStack>
      </VStack>
    </div>
  )
}
