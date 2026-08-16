// web/src/settings/TranslateCard.tsx：AI 翻译双层卡片（spec §4.2.6）。
// 第一层 Switch（ai_translate_enabled）；打开和关闭都走 PUT，不能只改本地 state。
// 第二层 Segmented（跟随默认/专用模型），仅开启时渲染。
// 专用模型原子性：三凭证全填才可保存，任一空 disabled + 行内错误。切回跟随默认 = 清空三键
// （PUT 空串 = DELETE），破坏性确认。徽标五态。env 源三凭证 → readOnly + 🔒 + 无保存。
// isDedicated = Boolean(三凭证存在)，不新增 settings 键。
import { useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../components/ui/alert-dialog.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Segmented } from '../components/ui/segmented.js'
import { Switch } from '../components/ui/switch.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO, SettingsDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { localizeErrorValue } from '../lib/errorText.js'
import { SettingsCard } from './SettingsCard.js'
import { SECRET_LABEL_KEY } from './secretLabels.js'

interface Props {
  translate: ProviderRowDTO
  llm: ProviderRowDTO
  settings: SettingsDTO
  onUpdated: (s: SettingsDTO) => void
  reload: () => void
}

const SEG_ITEMS = [
  { value: 'default', labelKey: 'settings_translate_model_default' },
  { value: 'dedicated', labelKey: 'settings_translate_model_dedicated' },
] as const

const TRANSLATE_FIELDS = ['TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL'] as const
const PLACEHOLDERS: Record<string, string> = {
  TRANSLATE_BASE_URL: 'https://api.example.com/v1',
  TRANSLATE_API_KEY: 'sk-...',
  TRANSLATE_MODEL: 'gpt-4o-mini',
}

export function TranslateCard({ translate, llm, settings, onUpdated, reload }: Props) {
  const { t, lang } = useT()
  const [enabled, setEnabled] = useState(settings.ai_translate_enabled === 'true')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // userSeg: 用户主动选择的 seg；null=未主动选，回退到由 isDedicated 推导。
  // 切回 default && isDedicated → 弹确认，**不写 userSeg**，取消时 seg 仍是 dedicated（自动回弹）。
  const [userSeg, setUserSeg] = useState<string | null>(null)

  const secretMap = Object.fromEntries(translate.secrets.map((s) => [s.name, s]))
  const isDedicated = Boolean(
    secretMap.TRANSLATE_BASE_URL?.set &&
    secretMap.TRANSLATE_API_KEY?.set &&
    secretMap.TRANSLATE_MODEL?.set,
  )
  const allEnv =
    translate.secrets.length > 0 && translate.secrets.every((s) => s.source === 'env')
  const seg = userSeg ?? (isDedicated ? 'dedicated' : 'default')
  const defaultModel =
    llm.secrets.find((s) => s.name === 'LLM_MODEL')?.masked ?? '—'

  // incomplete：enabled 且非 allEnv 且三凭证有任一 set 但非全 set（部分配置不完整）。
  const anySet = translate.secrets.some((s) => s.set)
  const incomplete = enabled && !allEnv && anySet && !isDedicated
  const badge = !enabled
    ? t('settings_translate_badge_off')
    : isDedicated
      ? t('settings_translate_badge_dedicated')
      : incomplete
        ? t('settings_translate_badge_incomplete')
        : t('settings_translate_badge_enabled')

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
    setBusy(true)
    setError(null)
    try {
      for (const name of TRANSLATE_FIELDS) {
        await api.putSecret(name, drafts[name] ?? '')
      }
      setDrafts({})
      setTouched({})
      reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + localizeErrorValue(e, lang))
    } finally {
      setBusy(false)
    }
  }

  async function onClearDedicated() {
    setBusy(true)
    setError(null)
    try {
      for (const name of TRANSLATE_FIELDS) await api.putSecret(name, '')
      setUserSeg('default')  // 立即切换 UI，不等 reload 数据回来
      reload()
      setConfirmOpen(false)
    } catch (e) {
      setError(t('settings_save_error_prefix') + localizeErrorValue(e, lang))
    } finally {
      setBusy(false)
    }
  }

  function onSegChange(value: string) {
    if (value === 'default' && isDedicated) {
      setConfirmOpen(true)
    } else {
      setUserSeg(value)
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
        {error && <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p>}

        {enabled && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_translate_model_label')}</span>
              <Segmented
                items={SEG_ITEMS.map((it) => ({ value: it.value, label: t(it.labelKey) }))}
                value={seg}
                onChange={onSegChange}
                label={t('settings_translate_model_label')}
              />
              {seg === 'default' && (
                <span className="text-[11px] leading-4 text-muted-foreground">
                  {t('settings_translate_current_model_prefix')} {defaultModel} · {t('settings_translate_shared_with_agent')}
                </span>
              )}
            </div>

            {seg === 'dedicated' && !allEnv && (
              <div className="flex flex-col gap-1.5">
                {TRANSLATE_FIELDS.map((name) => (
                  <div key={name} className="flex flex-col gap-1.5">
                    <label className="text-[11px] leading-4 text-muted-foreground">{t(SECRET_LABEL_KEY[name])} *</label>
                    <Input
                      aria-label={t(SECRET_LABEL_KEY[name])}
                      required
                      value={drafts[name] ?? ''}
                      placeholder={PLACEHOLDERS[name]}
                      onChange={(e) => setDrafts((d) => ({ ...d, [name]: e.target.value }))}
                      onBlur={() => setTouched((tch) => ({ ...tch, [name]: true }))}
                    />
                    {fieldError(name) && (
                      <p role="alert" className="text-[11px] leading-4 text-fn-red">{fieldError(name)}</p>
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={busy || !allFilled} onClick={() => void onSaveDedicated()}>{t('common_save')}</Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void api.validateSetup('translate').then(reload)}
                  >
                    {t('settings_provider_test')}
                  </Button>
                </div>
              </div>
            )}

            {seg === 'dedicated' && allEnv && (
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

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!o) setConfirmOpen(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings_translate_dedicated_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings_translate_dedicated_confirm_body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common_cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void onClearDedicated() }}>
              {t('common_confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}