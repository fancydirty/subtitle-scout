// web/src/settings/TranslateCard.tsx：AI 翻译卡片。
// 开关只写 ai_translate_enabled，不碰 TRANSLATE_*。配齐后 rest 态对齐 LLM ProviderCard
//（已配置 / 测试 / 编辑 / 打码键值）。未配齐才摊开必填表单。
import { useState } from 'react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Segmented } from '../components/ui/segmented.js'
import { Switch } from '../components/ui/switch.js'
import { StatusDot } from '../components/ui/status-dot.js'
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

// registry 待办二：翻译移交阈值五档（值=settings translate_after_attempts；daemon 每次派发
// 现取，clamp 兜底 7）。退避按天（M-1），所以"次数≈天数"。照 scan_interval_ms 五档先例。
const TRANSLATE_AFTER_OPTIONS = [
  { value: '1', labelKey: 'settings_translate_after_1' },
  { value: '3', labelKey: 'settings_translate_after_3' },
  { value: '7', labelKey: 'settings_translate_after_7' },
  { value: '14', labelKey: 'settings_translate_after_14' },
  { value: '30', labelKey: 'settings_translate_after_30' },
] as const

/** 库存值落到最近档（手输过其他整数也不炸，值仍合法，daemon 侧 clamp 兜底）。空/脏 → 默认 7。 */
function nearestAfter(raw: string | null): string {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return '7'
  return TRANSLATE_AFTER_OPTIONS.reduce(
    (best, o) => (Math.abs(Number(o.value) - n) < Math.abs(Number(best) - n) ? o.value : best),
    '7',
  )
}
const PLACEHOLDERS: Record<string, string> = {
  TRANSLATE_BASE_URL: 'https://api.example.com/v1',
  TRANSLATE_API_KEY: 'sk-...',
  TRANSLATE_MODEL: 'gpt-5.6-sol',
}

/** 相对时长（`3h` / `12m`）。与 ProviderCard.relDuration 同口径同粒度。
 *  四行的小函数，重复一次比建一条跨文件依赖便宜（同 ProviderCard 注释里的论证）。 */
function relDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export function TranslateCard({ translate, settings, onUpdated, reload }: Props) {
  const { t, lang } = useT()
  const [enabled, setEnabled] = useState(settings.ai_translate_enabled === 'true')
  const [editing, setEditing] = useState(false)
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
  const showForm = enabled && (!isDedicated || editing)
  const status = enabled ? (isDedicated ? 'configured' : 'unconfigured') : undefined

  const canSave = TRANSLATE_FIELDS.every(
    (n) => (drafts[n] ?? '').trim() !== '' || Boolean(secretMap[n]?.set),
  )

  async function commitAfterAttempts(value: string) {
    setBusy(true)
    setError(null)
    try {
      const result = await api.updateSettings({ translate_after_attempts: value })
      onUpdated(result)
    } catch (e) {
      setError(t('settings_save_error_prefix') + localizeErrorValue(e, lang))
    } finally {
      setBusy(false)
    }
  }

  async function commitEnabled(value: boolean) {
    setBusy(true)
    setError(null)
    try {
      const result = await api.updateSettings({ ai_translate_enabled: value ? 'true' : 'false' })
      setEnabled(value)
      setEditing(false)
      setDrafts({})
      setTouched({})
      onUpdated(result)
    } catch (e) {
      setError(t('settings_save_error_prefix') + localizeErrorValue(e, lang))
    } finally {
      setBusy(false)
    }
  }

  async function onSaveDedicated() {
    const credentials: Record<string, string> = {}
    for (const name of TRANSLATE_FIELDS) {
      const v = (drafts[name] ?? '').trim()
      if (v !== '') credentials[name] = v
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
        if (credentials[name]) await api.putSecret(name, credentials[name])
      }
      setDrafts({})
      setTouched({})
      setEditing(false)
      reload()
    } catch (e) {
      setError(t('settings_translate_save_error_prefix') + localizeErrorValue(e, lang))
    } finally {
      setBusy(false)
    }
  }

  async function onTest() {
    setBusy(true)
    setError(null)
    try {
      await api.validateSetup('translate')
      reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + localizeErrorValue(e, lang))
    } finally {
      setBusy(false)
    }
  }

  const fieldError = (n: string) =>
    showForm && !isDedicated && touched[n] && (drafts[n] ?? '').trim() === '' && !secretMap[n]?.set
      ? t('settings_translate_all_fields_required')
      : null

  const restFooter = enabled && isDedicated && !editing ? (
    <>
      <Button size="sm" disabled={busy} onClick={() => void onTest()}>
        {t('settings_provider_test_connect')}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
        {t('settings_provider_edit_credentials')}
      </Button>
      {translate.lastTest && (
        <span className="ml-auto flex items-center gap-2 text-[11px] leading-4 text-muted-foreground">
          <StatusDot
            variant={translate.lastTest.ok ? 'success' : 'error'}
            label={translate.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')}
          />
          <span title={new Date(translate.lastTest.at).toLocaleString()}>
            {translate.lastTest.ok ? t('settings_provider_last_test_passed_ago') : t('settings_provider_last_test_failed_ago')}
            {' '}
            {relDuration(Date.now() - translate.lastTest.at)}
            {' '}
            {t('settings_provider_last_test_ago_suffix')}
          </span>
        </span>
      )}
    </>
  ) : undefined

  return (
    <SettingsCard
      title={t('settings_translate_card_title')}
      description={t('settings_translate_card_description')}
      status={status}
      statusDot={status === 'configured' ? 'success' : undefined}
      footer={restFooter}
      data-testid="providers-translate"
    >
      {!enabled && (
        <div className="absolute right-5 top-5 text-[11px] leading-4 text-muted-foreground">
          {t('settings_translate_badge_off')}
        </div>
      )}
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

        {!enabled && isDedicated && (
          <span className="text-[11px] leading-4 text-muted-foreground">
            {t('settings_translate_creds_saved')}
          </span>
        )}

        {enabled && (
          <span className="text-[11px] leading-4 text-muted-foreground">
            {t('settings_translate_dedicated_note')}
          </span>
        )}

        {enabled && (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium leading-5 text-foreground">
              {t('settings_translate_after_label')}
            </span>
            <Segmented
              label={t('settings_translate_after_label')}
              items={TRANSLATE_AFTER_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
              value={nearestAfter(settings.translate_after_attempts)}
              onChange={(v) => void commitAfterAttempts(v)}
            />
            <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_translate_after_note')}</span>
          </div>
        )}

        {enabled && isDedicated && !editing && (
          <div className="flex flex-col gap-2">
            <dl className="settings-kv">
              {TRANSLATE_FIELDS.map((name) => {
                const s = secretMap[name]
                return (
                  <div key={name} className="settings-kv-row contents">
                    <dt className="text-[11px] leading-4 text-muted-foreground">{t(SECRET_LABEL_KEY[name])}</dt>
                    <dd className="font-mono text-[12px] leading-4 text-foreground m-0">{s?.masked ?? '••••'}</dd>
                  </div>
                )
              })}
            </dl>
          </div>
        )}

        {showForm && (
          <div className="flex flex-col gap-1.5">
            {TRANSLATE_FIELDS.map((name) => (
              <div key={name} className="flex flex-col gap-1.5">
                <label className="text-[11px] leading-4 text-muted-foreground">{t(SECRET_LABEL_KEY[name])}{isDedicated ? '' : ' *'}</label>
                <Input
                  aria-label={t(SECRET_LABEL_KEY[name])}
                  required={!isDedicated && !secretMap[name]?.set}
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
              <Button size="sm" disabled={busy || !canSave} onClick={() => void onSaveDedicated()}>
                {t('common_save')}
              </Button>
              {editing && (
                <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setDrafts({}); setTouched({}) }}>
                  {t('settings_provider_cancel')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </SettingsCard>
  )
}
