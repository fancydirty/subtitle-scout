// web/src/workflow/RunDetail.tsx：C 式右侧详情板——固定右侧滑入，不跳页不弹 modal（DESIGN.md
// §5/§6，沿用 F3 EpisodeDetail 的既有先例）。两种来源共用同一块板（R2D-1，R2 复审：worker run
// 详情入口）：
//  - kind='pass'：自 Passes 泳道点开一张 PassCard（orchestrate 通行记录）——detail 全文 mono
//    块 + receipts 分布 + 快照回放。没有 Rerun 按钮：WorkflowPassDTO 本身不带真实 series 的
//    seriesId（orchestrate job 的 series_id 是编排层合成值 'orchestrator-shard-N'，关联不到
//    某一部具体的剧）。
//  - kind='worker'：自 Workers 泳道 Recent 区点开一行 RecentRunRow（find_subtitle/realign
//    worker 的收工记录）——decision 语义色点 + detail mono 块 + 同一个快照回放端点
//    （GET runs/:id/trace 按 runs.id 查询，worker run 与 pass 共用这一个端点，不新增接口）+
//    Rerun 按钮（seriesId 非空才显示；season 恒传 null——这里不知道原任务覆盖哪些季，"全剧缺口"
//    是唯一诚实的默认，见 rerun.ts 的文档注释）。
//
// 快照回放（GET runs/:id/trace 拿事件列表，静态 TraceRows 渲染，live=false——回放≠直播，
// 无蓝点延展）两种来源完全一致，只是 id 的取值不同（pass.id vs run.id，都是 runs 表的行 id）。
import { useHotkeys } from '@astryxdesign/core/hooks'
import { Kbd } from '@astryxdesign/core/Kbd'
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Divider } from '@astryxdesign/core/Divider'
import { Button } from '@astryxdesign/core/Button'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { useRunTrace } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { relativeAgo } from './time.js'
import { receiptChips, decisionVariant } from './text.js'
import { TraceRows } from './TraceRows.js'
import type { WorkflowPassDTO, WorkflowRecentRunDTO } from '../api/types.js'
import type { RerunRequest } from './rerun.js'

/** RunDetail 的两种来源——判别式联合，调用方（Lanes.tsx）按点开的是哪种卡片构造。 */
export type RunDetailSource =
  | { kind: 'pass'; pass: WorkflowPassDTO }
  | { kind: 'worker'; run: WorkflowRecentRunDTO }

interface Props {
  source: RunDetailSource
  now: number
  onClose: () => void
  onRerun: (request: RerunRequest) => void
}

export function RunDetail({ source, now, onClose, onRerun }: Props) {
  const { t } = useT()
  useHotkeys([{ keys: 'escape', onPress: onClose }])
  const kindLabel = source.kind === 'pass' ? 'pass' : 'run'
  const id = source.kind === 'pass' ? source.pass.id : source.run.id
  const trace = useRunTrace(id)
  const detail = source.kind === 'pass' ? source.pass.detail : source.run.detail
  const at = source.kind === 'pass' ? source.pass.finishedAt ?? source.pass.startedAt : source.run.finishedAt ?? now
  const chips = source.kind === 'pass' ? receiptChips(source.pass.receipts) : []
  const decision = source.kind === 'worker' ? source.run.decision : null
  const seriesId = source.kind === 'worker' ? source.run.seriesId : null

  const handleRerun = () => {
    if (seriesId == null) return
    onRerun({ seriesId, season: null, includeThrottled: false })
  }

  return (
    <div className="wf-rundetail-panel" role="dialog" aria-label={`${kindLabel} ${id}`}>
      <HStack gap={2} vAlign="center" justify="between" padding={4}>
        <VStack gap={0.5}>
          <Text type="code" color="secondary">
            {kindLabel} #{id}
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
        {decision ? (
          // 状态=圆点+同色词（DESIGN.md §4）——StatusDot 本身只落 aria-label，可见的 decision 词
          // 是紧跟着的独立文本节点，同 Lanes.tsx RecentRunRow 的既有呈现口径一致。
          <HStack gap={2} vAlign="center">
            <StatusDot variant={decisionVariant(decision)} label={decision} />
            <Text type="code" color="primary">
              {decision}
            </Text>
          </HStack>
        ) : null}

        {detail ? (
          <VStack gap={1}>
            <Text type="supporting" color="secondary">
              {t('workflow_rundetail_detail_heading')}
            </Text>
            <Text type="code" wordBreak="break-word">
              {detail}
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

        {seriesId != null ? (
          <Button
            size="sm"
            variant="secondary"
            label={t('workflow_pending_rerun_label')}
            onClick={handleRerun}
          />
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
