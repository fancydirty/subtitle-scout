// web/src/workflow/RerunDialog.tsx：Rerun 的 AlertDialog 确认流——DESIGN.md §5 铁律
// （destructive/有实际后果的操作才用 AlertDialog）。四态回执（created/revived/coalesced/
// blocked_dormant）都要"以事实呈现"（DESIGN.md §8：不许都写成 success）。Astryx AlertDialog
// 时代把同一个元素复用成两阶段（它没有 children 插槽，title/description 只收字符串）；Task 30
// 换 Radix 组合式后 phase 状态机不变，Content 按 phase 切 Title/Description/Action 文案——
// 同 Task 27 RemoveRootDialog 的手法：⚠️ Radix Action 默认 click 即关，confirm→submitting
// 相位推进期间必须 e.preventDefault() 拦住默认关闭（结果态文本还在对话框里），done/error
// 相位才放默认关闭走 onOpenChange(false) → onClose。Cancel 用字面量——i18n 表无此键，
// 不为它加键（Task 26 铁规）。
//
// includeThrottled 开关不塞进这个对话框：它活在发起方（RunDetail 详情板里与 Rerun 按钮
// 并排的那个 Switch），点击 Rerun 时把当时的开关状态一并封进 RerunRequest 传进来，
// 这里只管"确认 + 提交 + 呈现回执"。
import { useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.js'
import { buttonVariants } from '../../components/ui/button.js'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
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

  const finished = phase === 'done' || phase === 'error'

  const handleAction = async () => {
    const target = request
    setPhase('submitting')
    try {
      const outcome = await api.redispatch({
        seriesId: target.seriesId,
        // R2D-1（R2 复审）：season===null 表示"全剧缺口"（RunDetail 的 worker-run Rerun 按钮走
        // 这条路）——不传 seasons 键，走 REDISPATCH_SCHEMA 的省略键语义（同 rerun.ts 的文档注释）。
        seasons: target.season != null ? [target.season] : undefined,
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
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: finished ? 'secondary' : 'default' })}
            disabled={phase === 'submitting'}
            onClick={(e) => {
              if (finished) return // 结果相位：放默认关闭 → onOpenChange(false) → onClose
              e.preventDefault() // confirm→submitting 相位推进期间保持打开（结果文本还在对话框里）
              void handleAction()
            }}
          >
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
