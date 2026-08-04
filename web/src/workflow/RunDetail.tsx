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
//
// Plan C Task 30 换栈：Kbd/Switch/Divider/Button/StatusDot 换 components/ui 件，Text/VStack/
// HStack 换标签+工具类（事典逐值映射：code=font-mono text-[13px] leading-5、supporting=
// text-[11px] leading-4、secondary=muted-foreground、primary=foreground；VStack/HStack gap
// 刻度两栈相同；Switch 的 labelSpacing="hug" 是 Astryx 排印 prop，丢掉——开关与标签的 8px
// 间距由行内 flex gap-2 给出，与 Astryx 容器 gap --spacing-2=8px 同值）。自管 role="dialog"
// 与 .wf-rundetail-panel 固定面板几何不动（它从来不是 Astryx 件）。回放错误行有意改值：
// 灰字 → text-fn-red + role="alert"（事典继承——错误事实句要让读屏器播报，朴素 span 是静默的）。
import { useState } from 'react'
import { useHotkeys } from '../lib/useHotkeys.js'
import { Kbd } from '../components/ui/kbd.js'
import { Switch } from '../components/ui/switch.js'
import { Separator } from '../components/ui/separator.js'
import { Button } from '../components/ui/button.js'
import { StatusDot } from '../components/ui/status-dot.js'
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

  // R2D-19：Rerun 扳手的完整定义含 includeThrottled 开关（spec §5）——详情入口这一半不能只交付
  // 半个扳手，与 PendingLane 行内 Switch 同款（该状态随面板打开的 run 走，不跨 run 残留：
  // source 变更时组件由父级以 key 重挂载或 seriesId 变化，默认关是保守派）。
  const [includeThrottled, setIncludeThrottled] = useState(false)
  const handleRerun = () => {
    if (seriesId == null) return
    onRerun({ seriesId, season: null, includeThrottled })
  }

  return (
    <div className="wf-rundetail-panel" role="dialog" aria-label={`${kindLabel} ${id}`}>
      <div className="flex items-center justify-between gap-2 p-4">
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[13px] leading-5 text-muted-foreground">
            {kindLabel} #{id}
          </span>
          <span className="text-[11px] leading-4 text-muted-foreground">
            {relativeAgo(now - at)}
          </span>
        </div>
        <button
          type="button"
          className="wf-rundetail-close"
          onClick={onClose}
          aria-label={t('workflow_rundetail_close_label')}
        >
          <Kbd keys="escape" />
        </button>
      </div>
      <Separator />

      <div className="flex flex-col gap-4 p-4">
        {decision ? (
          // 状态=圆点+同色词（DESIGN.md §4）——StatusDot 本身只落 aria-label，可见的 decision 词
          // 是紧跟着的独立文本节点，同活动页完成行的既有呈现口径一致。
          <div className="flex items-center gap-2">
            <StatusDot variant={decisionVariant(decision)} label={decision} />
            <span className="font-mono text-[13px] leading-5 text-foreground">
              {decision}
            </span>
          </div>
        ) : null}

        {/* 审计 UX-P0:LLM 成本事实句(翻译 run 的 llm_calls 账本,mono-fact 口径) */}
        {source.kind === 'worker' && source.run.llmCalls != null && source.run.llmCalls > 0 ? (
          <span className="text-[11px] leading-4 text-muted-foreground">
            llm calls · {source.run.llmCalls}
          </span>
        ) : null}

        {detail ? (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] leading-4 text-muted-foreground">
              {t('workflow_rundetail_detail_heading')}
            </span>
            <span className="font-mono text-[13px] leading-5 text-foreground break-words">
              {detail}
            </span>
          </div>
        ) : null}

        {chips.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-[11px] leading-4 text-muted-foreground">
              {t('workflow_rundetail_receipts_heading')}
            </span>
            <div className="wf-chip-row">
              {chips.map((c) => (
                <span className="wf-chip" key={c}>
                  {c}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {seriesId != null ? (
          <div className="flex items-center gap-2">
            <Switch
              aria-label={t('workflow_rerun_include_throttled_label')}
              checked={includeThrottled}
              onCheckedChange={setIncludeThrottled}
            />
            <span className="text-[13px] font-medium leading-5 text-foreground">
              {t('workflow_rerun_include_throttled_label')}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleRerun}
            >
              {t('workflow_pending_rerun_label')}
            </Button>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <span className="text-[11px] leading-4 text-muted-foreground">
            {t('workflow_rundetail_replay_heading')}
          </span>
          {trace.loading && !trace.data ? (
            <span className="font-mono text-[13px] leading-5 text-muted-foreground">
              loading…
            </span>
          ) : trace.error && !trace.data ? (
            // 有意改值（事典继承）：错误事实句灰→fn-red + role="alert"——条件插入即播报，
            // 朴素 span 对读屏器是静默的。
            <p role="alert" className="text-[13px] leading-5 text-fn-red">
              {t('workflow_rundetail_replay_error_prefix')}
              {trace.error}
            </p>
          ) : trace.data && trace.data.events.length === 0 ? (
            <span className="text-[13px] leading-5 text-muted-foreground">
              {t('workflow_rundetail_replay_empty')}
            </span>
          ) : trace.data ? (
            <TraceRows events={trace.data.events} />
          ) : null}
        </div>
      </div>
    </div>
  )
}
