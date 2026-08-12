// web/src/settings/ProviderCard.tsx：字幕源 keyed 卡片（spec §3.2）——env 源只读、db 源可编辑、
// 编辑/测试/lastTest。内含 ProviderSecretField（不单测，行为由本卡测试覆盖）。外壳换 SettingsCard，
// 状态判据：allConfigured → configured；hasEnvSource && !allConfigured → locked；else unconfigured。
// 空输入 = 不动该键（UI 不提供删除，防占位空串误删——删除走 TranslateCard 的显式空串提交）。
import { useState } from 'react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { StatusDot } from '../components/ui/status-dot.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { SettingsCard } from './SettingsCard.js'

const PROVIDER_NAME: Record<ProviderRowDTO['id'], string> = {
  tmdb: 'TMDB',
  llm: 'LLM',
  translate: 'Translate',
  assrt: 'ASSRT',
  opensubtitles: 'OpenSubtitles',
  jimaku: 'Jimaku',
  subhd: 'subhd',
  zimuku: 'zimuku',
}

function ProviderSecretField({ secret, editing, draft, onDraft }: {
  secret: ProviderRowDTO['secrets'][number]
  editing: boolean
  draft: string
  onDraft: (v: string) => void
}) {
  const { t } = useT()
  if (editing && secret.source !== 'env') {
    return <Input aria-label={secret.name} value={draft} onChange={(e) => onDraft(e.target.value)} placeholder={secret.masked ?? ''} />
  }
  return (
    <>
      <span className="text-[11px] leading-4">{secret.set ? secret.masked ?? '••••' : t('settings_provider_not_set')}</span>
      {secret.set && (
        <span className="text-[11px] leading-4 text-muted-foreground">
          {secret.source === 'env' ? t('settings_provider_source_env') : t('settings_provider_source_db')}
        </span>
      )}
      {secret.source === 'env' && (
        <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_provider_env_locked')}</span>
      )}
    </>
  )
}

export function ProviderCard({ row, reload }: { row: ProviderRowDTO; reload: () => void }) {
  const { t } = useT()
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editable = row.secrets.some((s) => s.source !== 'env')
  // 状态判据（spec §3.2）：任意 env 源 → locked（环境变量接管，用户不可编辑，即使全 set）；
  // 否则 allConfigured → configured；else unconfigured。env 优先于 configured 是有意的——
  // env 源卡片即使全 set 也不可编辑，显示 "configured" 会误导用户以为可管理。
  const allConfigured = row.secrets.length > 0 && row.secrets.every((s) => s.set)
  const hasEnvSource = row.secrets.some((s) => s.source === 'env')
  const status = hasEnvSource ? 'locked' : allConfigured ? 'configured' : 'unconfigured'

  async function onSave() {
    setBusy(true); setError(null)
    try {
      for (const s of row.secrets) {
        const v = drafts[s.name] ?? ''
        if (v === '') continue
        await api.putSecret(s.name, v)
      }
      setEditing(false); setDrafts({}); reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + String(e))
    } finally { setBusy(false) }
  }

  async function onTest() {
    setBusy(true); setError(null)
    try { await api.validateSetup(row.id); reload() }
    catch (e) { setError(t('settings_save_error_prefix') + String(e)) }
    finally { setBusy(false) }
  }

  return (
    <SettingsCard title={PROVIDER_NAME[row.id]} status={status} data-testid={`providers-${row.id}`}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy && !editing} onClick={() => void onTest()}>
            {t('settings_provider_test')}
          </Button>
          {editable && !editing && (
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{t('settings_provider_edit')}</Button>
          )}
          {row.lastTest && (
            <>
              <StatusDot variant={row.lastTest.ok ? 'success' : 'error'} label={row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')} />
              <span className="text-[11px] leading-4 text-muted-foreground">
                {row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')}{` · ${new Date(row.lastTest.at).toLocaleString()}`}
              </span>
            </>
          )}
        </div>
        {row.lastTest && !row.lastTest.ok && row.lastTest.error && (
          <span className="text-[11px] leading-4 text-muted-foreground">{row.lastTest.error}</span>
        )}
        {row.secrets.map((s) => (
          <div key={s.name} className="flex items-center gap-2">
            <span className="font-mono text-[13px] leading-5">{s.name}</span>
            <ProviderSecretField secret={s} editing={editing} draft={drafts[s.name] ?? ''} onDraft={(v) => setDrafts((d) => ({ ...d, [s.name]: v }))} />
          </div>
        ))}
        {editing && (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void onSave()}>{t('settings_provider_save')}</Button>
            <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setDrafts({}) }}>{t('settings_provider_cancel')}</Button>
          </div>
        )}
        {error && <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p>}
      </div>
    </SettingsCard>
  )
}