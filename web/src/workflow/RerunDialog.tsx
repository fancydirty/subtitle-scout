// web/src/workflow/RerunDialog.tsx：Rerun 的 AlertDialog 确认流——DESIGN.md §5 铁律
// （destructive/有实际后果的操作才用 AlertDialog）。四态回执（created/revived/coalesced/
// blocked_dormant）都要"以事实呈现"（DESIGN.md §8：不许都写成 success），这里把同一个
// AlertDialog 元素复用成两阶段：先问确认，POST 完成后把 title/description/actionLabel
// 换成结果态（AlertDialog 本身没有 children 插槽，见其源码 props 表——title/description 只
// 接受字符串，没有地方塞一个"结果视图"，复用同一元素、切换阶段是这个约束下最贴合组件真实
// API 的做法）。
//
// includeThrottled 开关同理不塞进这个 AlertDialog：AlertDialog 的 props 只有
// title/description/actionLabel/cancelLabel 几个字符串+回调，没有 children 插槽能放下一个
// Switch——开关因此活在发起方（PendingLane 的每行 hover 工具条）里，点击 Rerun 时把当时的
// 开关状态一并封进 RerunRequest 传进来，这里只管"确认 + 提交 + 呈现回执"。
import { useEffect, useRef, useState } from 'react'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { outcomeMessageKey } from './text.js'
import type { RerunRequest } from './rerun.js'

interface Props {
  /** null＝对话框关闭。 */
  request: RerunRequest | null
  onClose: () => void
}

type Phase = 'confirm' | 'submitting' | 'done' | 'error'

export function RerunDialog({ request, onClose }: Props) {
  const { t } = useT()
  const [phase, setPhase] = useState<Phase>('confirm')
  const [resultText, setResultText] = useState<string | null>(null)
  // 陈旧结果守卫：组件本身不因 request→null 而卸载（Lanes.tsx 常驻渲染这一个元素），一次
  // POST 的 Promise 还在飞时用户可能已经关闭/换成另一个 request——resolve 后先核对这份结果
  // 是否还对应"当前打开的那个 request"，不是就静默丢弃，不许把上一次点击的回执误盖到这次
  // 新打开的确认态上。
  const requestRef = useRef(request)

  useEffect(() => {
    requestRef.current = request
    setPhase('confirm')
    setResultText(null)
  }, [request])

  if (!request) return null

  const handleAction = async () => {
    if (phase === 'done' || phase === 'error') {
      onClose()
      return
    }
    const target = request
    setPhase('submitting')
    try {
      const outcome = await api.redispatch({
        seriesId: target.seriesId,
        seasons: [target.season],
        includeThrottled: target.includeThrottled,
      })
      if (requestRef.current !== target) return
      setResultText(t(outcomeMessageKey(outcome.outcome)))
      setPhase('done')
    } catch (e) {
      if (requestRef.current !== target) return
      setResultText(t('workflow_rerun_error_prefix') + String(e))
      setPhase('error')
    }
  }

  let title: string
  let description: string
  let actionLabel: string
  if (phase === 'done') {
    title = t('workflow_rerun_result_title')
    description = resultText ?? ''
    actionLabel = t('workflow_rerun_close_label')
  } else if (phase === 'error') {
    title = t('workflow_rerun_failed_title')
    description = resultText ?? ''
    actionLabel = t('workflow_rerun_close_label')
  } else {
    title = t('workflow_rerun_confirm_title')
    description = t('workflow_rerun_confirm_desc')
    actionLabel = t('workflow_rerun_action_label')
  }

  return (
    <AlertDialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={title}
      description={description}
      actionLabel={actionLabel}
      actionVariant={phase === 'done' || phase === 'error' ? 'secondary' : 'primary'}
      isActionLoading={phase === 'submitting'}
      onAction={handleAction}
    />
  )
}
