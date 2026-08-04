// web/src/triage/TimingBox.tsx：Triage 第三区「Timing looks off · N」（spec §5.5）——偏移字幕全局
// 收件箱。行 = 行级红点 + "SeriesName SxxExx" + "checked Xh ago" + Fix the timing（接 correct）+
// Undo（接 revert，无在先校正时置灰）。空清单整区不渲染（零预告）。毫秒/分数在 API 层已剥（铁律②）。
import { useCallback, useState } from 'react'
import { Button } from '../components/ui/button.js'
import type { ShiftedItemDTO } from '../api/types.js'
import { useShiftedSubtitles } from '../api/hooks.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { checkedAgoLine, timingRowLabel } from './text.js'

function TimingRow({ row, now, onChanged }: { row: ShiftedItemDTO; now: number; onChanged: () => void }) {
  const { t, lang } = useT()
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (action: 'fix' | 'undo') => {
      if (busy) return
      setBusy(true)
      try {
        if (action === 'fix') await api.subtitleCorrect(row.itemId)
        else await api.subtitleRevert(row.itemId)
        onChanged()
      } catch {
        // 失败的可见后果是行仍在场（reload 后偏移行还在）——这一屏无 toast（铁律 L7）。
      } finally {
        setBusy(false)
      }
    },
    [busy, row.itemId, onChanged],
  )

  return (
    <div className="flex items-center gap-3 rounded-[4px] border border-border bg-secondary px-3 py-2">
      <span className="size-[5px] shrink-0 rounded-full bg-fn-red" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground" title={timingRowLabel(row)}>{timingRowLabel(row)}</span>
      <span className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground">{checkedAgoLine(row.checkedAt, now, lang)}</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => run('fix')}>
        {t('verify_correct_action')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || !row.hasPriorCorrection} onClick={() => run('undo')}>
        {t('triage_timing_undo')}
      </Button>
    </div>
  )
}

export function TimingBox() {
  const { t } = useT()
  const shifted = useShiftedSubtitles()
  const rows = shifted.data ?? []
  if (rows.length === 0) return null // 零偏移 → 不占屏（收件箱零预告）

  const now = Date.now()
  return (
    <div className="triage-box">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium leading-5 text-foreground">{t('triage_timing_heading')}</span>
          <span className="font-mono text-[13px] leading-5 text-muted-foreground">· {rows.length}</span>
        </div>
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <TimingRow key={row.itemId} row={row} now={now} onChanged={shifted.reload} />
          ))}
        </div>
      </div>
    </div>
  )
}
