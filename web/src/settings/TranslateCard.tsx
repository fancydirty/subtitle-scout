// web/src/settings/TranslateCard.tsx：AI 翻译卡片。
// 开关打开和关闭都走 PUT。自动翻译只认 TRANSLATE_* 专用三凭证（与 daemon
// tryAutoTranslateCfg 同口径），没有「跟随默认 LLM」。开启后直接渲染三字段；
// Save = 先 validateSetup(translate, drafts) 再 putSecret；不通则行内提示、输入保留。
import { useState } from 'react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Switch } from '../components/ui/switch.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO, SettingsDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { localizeError, localizeErrorValue } from '../lib/errorText.js'
import { SettingsCard } from './SettingsCard.js'
import { SECRET_LABEL_KEY } from './secretLabels.js'

interface Props {
  translate: ProviderRowDTO
  settings: SettingsDTO
  onUpdated: (s: SettingsDTO) => void
  reload: () => void
}

const TRANSLATE_FIELDS = ['TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL'] as const
const PLACEHOLDERS: Record<string, string> = {
  TRANSLATE_BASE_URL: 'https://api.example.com/v1',
  TRANSLATE_API_KEY: 'sk-...',
  TRANSLATE_MODEL: 'gpt-5.6-sol',
}

export function TranslateCard({ translate, settings, onUpdated, reload }: Props) {
  const { t, lang } = useT()
  const [enabled, setEnabled] = useState(settings.ai_translate_enabled === 'true')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const secretMap = Object.fromEntries(translate.secrets.map((s) => [s.name, s]))
  const isDedicated = Boolean(
    secretMap.TRANSLATE_BASE_URL?.set &&
    secretMap.TRANSLATE_API_KEY?.set &&
    secretMap.TRANSLATE_MODEL?.set,
  )
  const allEnv =
    translate.secrets.length > 0 && translate.secrets.every((s) => s.source === 'env')

  const badge = !enabled
    ? t('settings_translate_badge_off')
    : isDedicated
      ? t('settings_translate_badge_dedicated')
      : t('settings_translate_badge_incomplete')

  async function commitEnabled(value: boolean) {
    setBusy(true)
    setError(null)
    try {
      const result = await api.updateSettings({ ai_translate_enabled: value ? 'true' : 'false' })
      setEnabled(value)
      onUpdated(result)
    } catch (e) {
      setError(t('settings_save_error_prefix') + localizeErrorValue(e, lang))
    } finally {
      setBusy(false)
    }
  }

  async function onSaveDedicated() {
    const credentials = {
      TRANSLATE_BASE_URL: (drafts.TRANSLATE_BASE_URL ?? '').trim(),
      TRANSLATE_API_KEY: (drafts.TRANSLATE_API_KEY ?? '').trim(),
      TRANSLATE_MODEL: (drafts.TRANSLATE_MODEL ?? '').trim(),
    }
    setBusy(true)
    setError(null)
    try {
      const probed = await api.validateSetup('translate', credentials)
      if (!probed.ok) {
        setError(
          t('settings_translate_save_error_prefix') +
            localizeError(probed.error ?? probed.detail ?? t('wizard_test_failed'), lang),
        )
        return
      }
      for (const name of TRANSLATE_FIELDS) {
        await api.putSecret(name, credentials[name])
      }
      setDrafts({})
      setTouched({})
      reload()
    } catch (e) {
      setError(t('settings_translate_save_error_prefix') + localizeErrorValue(e, lang))
    } finally {
      setBusy(false)
    }
  }

  const allFilled = TRANSLATE_FIELDS.every((n) => (drafts[n] ?? '').trim() !== '')
  const fieldError = (n: string) =>
    touched[n] && (drafts[n] ?? '').trim() === '' ? t('settings_translate_all_fields_required') : null

  return (
    <SettingsCard
      title={t('settings_translate_card_title')}
      description={t('settings_translate_card_description')}
      data-testid="providers-translate"
    >
      <div className="absolute right-5 top-5 text-[11px] leading-4 text-muted-foreground">{badge}</div>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Switch
            aria-label={t('settings_translate_card_title')}
            checked={enabled}
            onCheckedChange={(c) => void commitEnabled(c)}
            disabled={busy}
          />
          <span className="text-[13px] font-medium leading-5 text-foreground">
            {t('settings_translate_enable_label')}
          </span>
        </div>
        <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_translate_quota_note')}</span>
        {error && <div className="settings-error-text" role="alert">{error}</div>}

        {enabled && (
          <div className="flex flex-col gap-3">
            <span className="text-[11px] leading-4 text-muted-foreground">
              {t('settings_translate_dedicated_note')}
            </span>
            {!allEnv && (
              <div className="flex flex-col gap-1.5">
                {TRANSLATE_FIELDS.map((name) => (
                  <div key={name} className="flex flex-col gap-1.5">
                    <label className="text-[11px] leading-4 text-muted-foreground">{t(SECRET_LABEL_KEY[name])} *</label>
                    <Input
                      aria-label={t(SECRET_LABEL_KEY[name])}
                      required
                      value={drafts[name] ?? ''}
                      placeholder={secretMap[name]?.masked ?? PLACEHOLDERS[name]}
                      onChange={(e) => {
                        setDrafts((d) => ({ ...d, [name]: e.target.value }))
                        setError(null)
                      }}
                      onBlur={() => setTouched((tch) => ({ ...tch, [name]: true }))}
                    />
                    {fieldError(name) && (
                      <p role="alert" className="text-[11px] leading-4 text-fn-red">{fieldError(name)}</p>
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={busy || !allFilled} onClick={() => void onSaveDedicated()}>
                    {t('common_save')}
                  </Button>
                </div>
              </div>
            )}

            {allEnv && (
              <div className="flex flex-col gap-1.5">
                {TRANSLATE_FIELDS.map((name) => {
                  const s = secretMap[name]
                  return (
                    <div key={name} className="flex flex-col gap-1.5">
                      <label className="text-[11px] leading-4 text-muted-foreground">{t(SECRET_LABEL_KEY[name])}</label>
                      <Input aria-label={t(SECRET_LABEL_KEY[name])} readOnly value={s?.masked ?? ''} />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
