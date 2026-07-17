// web/src/settings/RemoveRootDialog.tsx：删根的 AlertDialog 确认流——DESIGN.md §5 铁律
// （destructive/有实际后果的操作才用 AlertDialog）。同 workflow/RerunDialog.tsx 的既有先例：
// 一个 AlertDialog 元素复用成两阶段（先问确认，DELETE 完成后把 title/description/actionLabel
// 换成结果态），因为 AlertDialog 本身没有 children 插槽，title/description 只接受字符串。
//
// 成功后展示"removed 42 episodes · 3 series · 1 parked"式事实计数（DESIGN.md §8：数据诚实，
// 不许笼统说"已删除"糊弄过去）；404（path 不是登记在册的守备目录）如实展示那句 error。
import { useEffect, useRef, useState } from 'react'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { removeRootConfirmTitle, removeRootResultLabel } from './text.js'

interface Props {
  /** null＝对话框关闭；非空＝待删除的守备目录路径。 */
  path: string | null
  onClose: () => void
  /** DELETE 成功后调用——父级借此刷新根列表（RootsManager 传 roots.reload）。 */
  onRemoved: () => void
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

  const handleAction = async () => {
    if (phase === 'done' || phase === 'error') {
      onClose()
      return
    }
    const target = path
    setPhase('submitting')
    try {
      const result = await api.removeRoot(target)
      if (pathRef.current !== target) return
      setResultText(removeRootResultLabel(result, lang))
      setPhase('done')
      onRemoved()
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
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={title}
      description={description}
      actionLabel={actionLabel}
      actionVariant={phase === 'done' || phase === 'error' ? 'secondary' : 'destructive'}
      isActionLoading={phase === 'submitting'}
      onAction={handleAction}
    />
  )
}
