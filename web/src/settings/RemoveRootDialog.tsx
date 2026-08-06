// web/src/settings/RemoveRootDialog.tsx：删根的 AlertDialog 确认流——DESIGN.md §5 铁律
// （destructive/有实际后果的操作才用 AlertDialog）。同 workflow/RerunDialog.tsx 的既有先例：
// 一个对话框元素复用成两阶段（先问确认，DELETE 完成后把 title/description/action 换成结果态）。
//
// 成功后展示"removed 42 episodes · 3 series · 1 parked"式事实计数（DESIGN.md §8：数据诚实，
// 不许笼统说"已删除"糊弄过去）；404（path 不是登记在册的守备目录）如实展示那句 error。
//
// 控件栈（Plan C Task 27 迁移）：Astryx AlertDialog（无插槽、title/description 只收字符串）
// 换 Radix 组合式——phase 状态机不变，Content 按 phase 条件渲染 Title/Description/Action 文案；
// actionVariant destructive→secondary 的相位切换走 Action className（buttonVariants 参数化）；
// isActionLoading → disabled。⚠️ Radix Action 默认 click 即关：confirm→submitting 相位推进期间
// 必须 e.preventDefault() 拦住默认关闭（结果态文本还在对话框里），done/error 相位才放默认关闭
// （onOpenChange(false) → onClose）。Cancel 用字面量——i18n 表无此键，不为它加键（Task 26 铁规）。
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
} from '../components/ui/alert-dialog.js'
import { buttonVariants } from '../components/ui/button.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { removeRootConfirmTitle, removeRootResultLabel } from './text.js'

interface Props {
  /** null＝对话框关闭；非空＝待删除的守备目录路径。 */
  path: string | null
  onClose: () => void
  /** DELETE 成功后调用——父级借此刷新根列表（RootsManager 传 handleRemoved）+ 取消该路径的待扫请求。
   *  R6 改：回调现在接收删除的路径，RootsManager 据此通知 scanDebouncer.cancelScan(path)。 */
  onRemoved: (path: string) => void
}

type Phase = 'confirm' | 'submitting' | 'done' | 'error'

export function RemoveRootDialog({ path, onClose, onRemoved }: Props) {
  const { t, lang } = useT()
  const [phase, setPhase] = useState<Phase>('confirm')
  const [resultText, setResultText] = useState<string | null>(null)
  // 陈旧结果守卫：组件本身不因 path→null 而卸载（RootsManager 常驻渲染这一个元素），一次
  // DELETE 的 Promise 还在飞时用户可能已经关闭/换成另一个 path——resolve 后先核对这份结果是否
  // 还对应"当前打开的那个 path"，不是就静默丢弃（同 RerunDialog 的 requestRef 既有先例）。
  const pathRef = useRef(path)

  useEffect(() => {
    pathRef.current = path
    setPhase('confirm')
    setResultText(null)
  }, [path])

  if (!path) return null

  const finished = phase === 'done' || phase === 'error'

  const handleAction = async () => {
    const target = path
    setPhase('submitting')
    try {
      const result = await api.removeRoot(target)
      if (pathRef.current !== target) return
      setResultText(removeRootResultLabel(result, lang))
      setPhase('done')
      onRemoved(target)  // R6：传递删除的路径给父级（取消防抖扫描）
    } catch (e) {
      if (pathRef.current !== target) return
      setResultText(t('settings_roots_remove_error_prefix') + String(e))
      setPhase('error')
    }
  }

  let title: string
  let description: string
  let actionLabel: string
  if (phase === 'done') {
    title = t('settings_roots_remove_result_title')
    description = resultText ?? ''
    actionLabel = t('settings_roots_remove_close_label')
  } else if (phase === 'error') {
    title = t('settings_roots_remove_failed_title')
    description = resultText ?? ''
    actionLabel = t('settings_roots_remove_close_label')
  } else {
    title = removeRootConfirmTitle(path, lang)
    description = t('settings_roots_remove_confirm_desc')
    actionLabel = t('settings_roots_remove_label')
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
            className={buttonVariants({ variant: finished ? 'secondary' : 'destructive' })}
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
