// web/src/triage/TriagePage.tsx：甄别 tab 主体（dashboard-F5）——单列收件箱：页头 + 四区竖排
// （Pending → Excluded → Timing → Dormant，spec §5.5；后三区空则各自渲染 null，单列自然略过）。
// 数据面：GET /api/v2/triage 一次拿全 pending，翻案后手动 reload（useTriage 不轮询）；Timing/Dormant
// 两区组件自取数。认领已退役（见 src/v2/triageOps.ts 头注释）。
import { Section } from '../components/ui/section.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { useTriage } from '../api/hooks.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { PendingBox } from './PendingBox.js'
import { ExcludedBox } from './ExcludedBox.js'
import { TimingBox } from './TimingBox.js'
import { DormantBox } from './DormantBox.js'
import { groupPending } from './text.js'

export function TriagePage() {
  const { t } = useT()
  const triage = useTriage()

  const head = (
    <div className="flex flex-col gap-1">
      <h1 className="m-0 text-[19px] font-semibold leading-7 text-foreground">{t('triage_page_title')}</h1>
      <span className="text-[13px] leading-5 text-muted-foreground">{t('triage_subtitle')}</span>
    </div>
  )

  if (triage.loading && !triage.data) {
    return (
      <Section>
        {head}
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">loading…</span>
      </Section>
    )
  }
  if (triage.error && !triage.data) {
    return (
      <Section>
        {head}
        <EmptyState
          title={t('triage_error_prefix') + triage.error}
          actions={
            <Button variant="secondary" onClick={triage.reload}>
              {t('triage_retry_label')}
            </Button>
          }
        />
      </Section>
    )
  }
  if (!triage.data) return null

  const { actionable, excluded } = groupPending(triage.data.pending)

  const handleRestore = async (path: string) => {
    await api.unexclude(path)
    triage.reload()
  }

  return (
    <Section>
      <div className="flex flex-col gap-4">
        {head}
        <div className="triage-boxes">
          <PendingBox actionable={actionable} />
          <ExcludedBox excluded={excluded} onRestore={handleRestore} />
          <TimingBox />
          <DormantBox />
        </div>
      </div>
    </Section>
  )
}
