// web/src/setup/steps/StepFreeSources.tsx：wizard 步 5——subhd/zimuku 开关制（spec A §3 步 5）。
// wizard 路径出厂 ON（source==='none' 时初始 true）；可达性进页自动测、只展示不拦截；
// Continue 复用 PUT /api/v2/settings 写 provider flag（不另起端点）；env 锁定家不写。
import { useEffect, useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { Switch } from '../../components/ui/switch.js'
import { StepFooter } from './ui.js'
import type { WizardStepProps } from './types.js'
// SetupStatusDTO 是下面 statusPatch 的类型来源（`Partial<SetupStatusDTO['providers']>`）。
import type { SetupStatusDTO } from '../../api/types.js'

type Reach = 'checking' | 'ok' | 'fail'

export function StepFreeSources({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t } = useT()
  const subhdLocked = status.providers.subhd.source === 'env'
  const zimukuLocked = status.providers.zimuku.source === 'env'
  // wizard 出厂 ON：只在"从没设过"（source none）时默认开；env/db 已有值用现值。
  const [subhdOn, setSubhdOn] = useState(
    status.providers.subhd.source === 'none' ? true : status.providers.subhd.enabled,
  )
  const [zimukuOn, setZimukuOn] = useState(
    status.providers.zimuku.source === 'none' ? true : status.providers.zimuku.enabled,
  )
  const [reach, setReach] = useState<{ subhd: Reach; zimuku: Reach }>({ subhd: 'checking', zimuku: 'checking' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const probe = (target: 'subhd' | 'zimuku') =>
      api
        .validateSetup(target)
        .then((r) => alive && setReach((s) => ({ ...s, [target]: r.ok ? 'ok' : 'fail' })))
        .catch(() => alive && setReach((s) => ({ ...s, [target]: 'fail' })))
    void probe('subhd')
    void probe('zimuku')
    return () => {
      alive = false
    }
  }, [])

  const onContinue = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const patch: Partial<Record<'provider:SUBHD_ENABLED' | 'provider:ZIMUKU_ENABLED', string>> = {}
      if (!subhdLocked) patch['provider:SUBHD_ENABLED'] = String(subhdOn)
      if (!zimukuLocked) patch['provider:ZIMUKU_ENABLED'] = String(zimukuOn)
      if (Object.keys(patch).length > 0) await api.updateSettings(patch)
      // 类型是 `Partial<SetupStatusDTO['providers']>`——这个补丁攒的是 providers **子对象内部**的
      // 两家（subhd/zimuku），不是顶层快照。别写成 `Parameters<typeof patchStatus>[0]`
      // （= `Partial<SetupStatusDTO>`，顶层只有 bootstrapComplete/tmdb/llm/providers/roots/
      // engineEnabled 六个键）：那样 `statusPatch.subhd = …` 直接是 TS 报错。
      const statusPatch: Partial<SetupStatusDTO['providers']> = {}
      if (!subhdLocked) statusPatch.subhd = { enabled: subhdOn, source: 'db' }
      if (!zimukuLocked) {
        statusPatch.zimuku = {
          enabled: zimukuOn,
          source: 'db',
          captchaReady: status.providers.zimuku.captchaReady,
        }
      }
      if (Object.keys(statusPatch).length > 0) patchStatus({ providers: { ...status.providers, ...statusPatch } })
      onAdvance()
    } catch (e) {
      setSaveError(String(e))
      setSaving(false)
    }
  }

  const reachLine = (r: Reach) =>
    r === 'checking' ? t('wizard_free_reach_checking')
    : r === 'ok' ? t('wizard_free_reach_ok')
    : t('wizard_free_reach_fail')

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch
            aria-label={t('wizard_subhd_label')}
            checked={subhdOn}
            onCheckedChange={setSubhdOn}
            disabled={subhdLocked}
          />
          <span className="text-sm">{t('wizard_subhd_label')}</span>
          <span className="text-sm text-weak">{reachLine(reach.subhd)}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch
            aria-label={t('wizard_zimuku_label')}
            checked={zimukuOn}
            onCheckedChange={setZimukuOn}
            disabled={zimukuLocked}
          />
          <span className="text-sm">{t('wizard_zimuku_label')}</span>
          <span className="text-sm text-weak">{reachLine(reach.zimuku)}</span>
        </div>
        <span className="text-xs text-weak">
          {status.providers.zimuku.captchaReady ? t('wizard_zimuku_captcha_ready') : t('wizard_zimuku_captcha_not_ready')}
        </span>
      </div>
      {saveError && <p className="text-sm text-fn-red">{saveError}</p>}
      <StepFooter onBack={onBack}>
        <Button disabled={saving} onClick={() => void onContinue()}>{t('wizard_continue')}</Button>
      </StepFooter>
    </div>
  )
}
