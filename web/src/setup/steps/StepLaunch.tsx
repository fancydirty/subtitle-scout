// web/src/setup/steps/StepLaunch.tsx：wizard 步 7——汇总 + 点火（spec A §5.2 步 7）。
// 清单八行照 status 直译（语言行不画：status 不带语言字段，零编造）；Engine 开关默认取
// status.engineEnabled；Launch 无论开关态都显式 PUT——点火语义是"用户拍板那一刻写库"。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { localizeErrorValue } from '../../lib/errorText.js'
import { Button } from '../../components/ui/button.js'
import { Switch } from '../../components/ui/switch.js'
import { StepFooter } from './ui.js'
import type { TKey } from '../../i18n/useT.js'
import type { WizardStepProps } from './types.js'

export function StepLaunch({ status, onBack, onComplete }: WizardStepProps) {
  const { t, lang } = useT()
  const [engineOn, setEngineOn] = useState(status.engineEnabled)
  const [launching, setLaunching] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const rows: { labelKey: TKey; ok: boolean }[] = [
    { labelKey: 'wizard_step_tmdb_title', ok: status.tmdb.satisfied },
    { labelKey: 'wizard_step_llm_title', ok: status.llm.satisfied },
    { labelKey: 'wizard_assrt_label', ok: status.providers.assrt.satisfied },
    { labelKey: 'wizard_os_apikey_label', ok: status.providers.opensubtitles.satisfied },
    { labelKey: 'wizard_jimaku_label', ok: status.providers.jimaku.satisfied },
    { labelKey: 'wizard_subhd_label', ok: status.providers.subhd.enabled },
    { labelKey: 'wizard_zimuku_label', ok: status.providers.zimuku.enabled },
    { labelKey: 'wizard_step_roots_title', ok: status.roots.count > 0 },
  ]

  const launch = async () => {
    setLaunching(true)
    setSaveError(null)
    try {
      await api.updateSettings({ engine_enabled: String(engineOn) })
      onComplete()
    } catch (e) {
      setSaveError(localizeErrorValue(e, lang))
      setLaunching(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.labelKey} className="flex items-center justify-between text-sm">
            <span>{t(r.labelKey)}</span>
            <span className={r.ok ? 'text-fn-green' : 'text-weak'}>
              {r.ok ? t('wizard_launch_configured') : t('wizard_launch_skipped')}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Switch aria-label={t('wizard_launch_engine_label')} checked={engineOn} onCheckedChange={setEngineOn} />
        <span className="text-sm">{t('wizard_launch_engine_label')}</span>
        <span className="text-sm text-weak">{t('wizard_launch_engine_desc')}</span>
      </div>
      {saveError && <p className="text-sm text-fn-red">{saveError}</p>}
      <StepFooter onBack={onBack}>
        <Button disabled={launching} onClick={() => void launch()}>{t('wizard_launch')}</Button>
      </StepFooter>
    </div>
  )
}
