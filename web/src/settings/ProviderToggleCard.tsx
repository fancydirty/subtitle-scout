// web/src/settings/ProviderToggleCard.tsx：subhd/zimuku 开关卡片（spec §3.3）——与 ProviderCard
// 平级，描述 Chinese subtitle source。env 源锁定。迁移自 ProvidersSection ToggleRow。
import { useState } from 'react'
import { Switch } from '../components/ui/switch.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { localizeErrorValue } from '../lib/errorText.js'
import { SettingsCard } from './SettingsCard.js'

const TOGGLE_NAME: Record<'subhd' | 'zimuku', string> = { subhd: 'subhd', zimuku: 'zimuku' }
const TOGGLE_DESC_KEY: Record<'subhd' | 'zimuku', 'settings_free_source_description'> = { subhd: 'settings_free_source_description', zimuku: 'settings_free_source_description' }

export function ProviderToggleCard({ id, state, reload }: {
  id: 'subhd' | 'zimuku'
  state: { enabled: boolean; source: string }
  reload: () => void
}) {
  const { t, lang } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = state.source === 'env'
  const key = id === 'subhd' ? 'provider:SUBHD_ENABLED' as const : 'provider:ZIMUKU_ENABLED' as const

  async function onToggle(next: boolean) {
    setBusy(true); setError(null)
    try { await api.updateSettings({ [key]: String(next) }); reload() }
    catch (e) { setError(t('settings_save_error_prefix') + localizeErrorValue(e, lang)) }
    finally { setBusy(false) }
  }

  return (
    <SettingsCard
      title={TOGGLE_NAME[id]}
      description={t(TOGGLE_DESC_KEY[id])}
      status={state.enabled ? 'configured' : 'unconfigured'}
      data-testid={`providers-${id}`}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Switch aria-label={TOGGLE_NAME[id]} checked={state.enabled} onCheckedChange={(n) => void onToggle(n)} disabled={busy || locked} />
          <div className="flex-1">
            <div className="text-sm font-medium">{t('settings_provider_enable_label').replace('{name}', TOGGLE_NAME[id])}</div>
            <div className="text-xs text-muted-foreground">{t('settings_provider_no_api_key_note')}</div>
          </div>
        </div>
        {locked && (
          <div className="text-xs text-muted-foreground">{t('settings_provider_readonly_note')}</div>
        )}
        {error && <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p>}
      </div>
    </SettingsCard>
  )
}