// web/src/triage/ExcludedBox.tsx：excluded-extra 翻案箱——默认折叠，列出被 exclude_extras 当"特典"
// 排除的停车行，每行文件名 + Restore（接 unexclude），取消排除后回 pending 池重新 ingest。
import { useState } from 'react'
import { Task, TaskTrigger, TaskContent } from '../components/ai/task.js'
import { Button } from '../components/ui/button.js'
import { ChevronDownIcon } from 'lucide-react'
import type { ParkedItemDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { pathTail } from './text.js'

interface Props {
  excluded: ParkedItemDTO[]
  /** 翻案一行——返回 Promise，据其成败驱动 busy/error（dashboard 审计 #2）。 */
  onRestore: (path: string) => Promise<void>
}

function ExcludedRow({ row, onRestore }: { row: ParkedItemDTO; onRestore: (path: string) => Promise<void> }) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restore() {
    if (busy) return // 同步去重：飞行中不再触发（双提交防护）
    setBusy(true)
    setError(null)
    try {
      await onRestore(row.path)
    } catch (e) {
      setError(t('triage_restore_error_prefix') + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="triage-excluded-row">
      <span className="triage-excluded-file" title={row.path}>
        {pathTail(row.path)}
      </span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={restore}>
        {t('triage_excluded_restore_label')}
      </Button>
      {error && <span className="auth-error" role="alert">{error}</span>}
    </div>
  )
}

export function ExcludedBox({ excluded, onRestore }: Props) {
  const { t } = useT()
  if (excluded.length === 0) return null

  return (
    <div className="triage-box">
      <Task defaultOpen={false}>
        <TaskTrigger>
          {/* 原生 button——Radix Slot 只合并 onClick/aria-expanded/data-state，不给 div 补
              role/tabIndex/keydown（Task 11 评审实证，同 PendingBox 组头）；div 触发器键盘
              不可达。w-full text-left font-[inherit] bg-transparent border-0 抵掉按钮默认
              样式；focus-visible 补显式焦点环（浏览器默认框在暗底上几乎不可见）。
              data-state 落在这个 button 上（它就是触发器），group 锚住 chevron 的
              group-data-[state=open]:rotate-180。 */}
          <button type="button" className="group flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left font-[inherit] text-inherit focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2">
            <span className="text-[13px] font-medium leading-5 text-foreground">{t('triage_excluded_heading')}</span>
            <span className="font-mono text-[13px] leading-5 text-muted-foreground">{excluded.length}</span>
            <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </TaskTrigger>
        <TaskContent>
          <div className="flex flex-col gap-2">
            {excluded.map((row) => (
              <ExcludedRow key={row.path} row={row} onRestore={onRestore} />
            ))}
          </div>
        </TaskContent>
      </Task>
    </div>
  )
}
