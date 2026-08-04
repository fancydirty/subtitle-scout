// web/src/triage/DormantBox.tsx：Triage 第四区「Dormant tasks · N」（spec §5.5）——自动重试已停的
// 停车任务，只读。行 = 灰点 + targetLabel + "Failed N times, automatic retries stopped." + 右端 mono
// 裸工具名。**零按钮**：唤醒通道 spec 明确不补（§3 决策 1），别画打不通的按钮。灰不是红：停摆是
// 平静事实、不是卡死（铁律①红只给卡死层）。空清单整区不渲染。无时刻字段（DTO 刻意不带）。
import type { DormantTaskDTO } from '../api/types.js'
import { useDormantTasks } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { dormantReasonLine } from './text.js'

export function DormantBox() {
  const { t, lang } = useT()
  const dormant = useDormantTasks()
  const rows: DormantTaskDTO[] = dormant.data ?? []
  if (rows.length === 0) return null

  return (
    <div className="triage-box">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium leading-5 text-foreground">{t('triage_dormant_heading')}</span>
          <span className="font-mono text-[13px] leading-5 text-muted-foreground">· {rows.length}</span>
        </div>
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.jobId} className="flex items-center gap-3 rounded-[4px] border border-border bg-secondary px-3 py-2">
              <span className="size-[5px] shrink-0 rounded-full bg-weak" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground" title={row.targetLabel}>{row.targetLabel}</span>
              <span className="shrink-0 text-[11px] leading-4 text-muted-foreground">{dormantReasonLine(row.attempts, lang)}</span>
              <span className="shrink-0 font-mono text-[11px] leading-4 text-weak">{row.task}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
