// web/src/settings/ProvidersSection.tsx：Providers 区（spec A §5.4）——每家一行：打码值、
// source 徽标、上次测试点、编辑（仅 db 源可改；空输入=不动该键，UI 不提供删除——删除走
// PUT secrets API 语义，界面不开放，防占位空串误删）、Test；无 key 的 subhd/zimuku 两家
// 以 toggle 行呈现（同一 PUT settings 通道）。编辑/测试后直接 reload 刷新打码与测试点。
// 与 wizard 的不对称是有意的：wizard 先测后存是首跑纪律；Settings 保存不强制测试，
// 靠上次测试点展示兜底（测试按钮常备）。Astryx 栈与邻区一致——整页随 Spec C 迁新栈。
import { useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { Button } from '@astryxdesign/core/Button'
import { Switch } from '@astryxdesign/core/Switch'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { api } from '../api/client.js'
import type { Async } from '../api/hooks.js'
import type { ProvidersDTO, ProviderRowDTO, SetupStatusDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'

// 厂牌专名不进 i18n（双表同形，同 wizard 步 1 语言自称先例）。
const PROVIDER_NAME: Record<ProviderRowDTO['id'], string> = {
  tmdb: 'TMDB',
  llm: 'LLM',
  assrt: 'ASSRT',
  opensubtitles: 'OpenSubtitles',
  jimaku: 'Jimaku',
  subhd: 'subhd',
  zimuku: 'zimuku',
}

interface Props {
  providers: Async<ProvidersDTO>
  setupStatus: Async<SetupStatusDTO>
}

function KeyedRow({ row, reload }: { row: ProviderRowDTO; reload: () => void }) {
  const { t } = useT()
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editable = row.secrets.some((s) => s.source !== 'env')

  const onSave = async () => {
    setBusy(true)
    setError(null)
    try {
      for (const s of row.secrets) {
        const v = drafts[s.name] ?? ''
        if (v === '') continue // 空输入 = 不动该键（UI 不提供删除，防占位空串误删）
        await api.putSecret(s.name, v)
      }
      setEditing(false)
      setDrafts({})
      reload()
    } catch (e) {
      // 评审注：多密钥家循环中途抛错 = 前面的键已逐键落库（PUT 是单键语义，不回滚）——
      // 这条路径不 reload，已写键的打码展示会旧到下一拍 15s 轮询自愈，属已知可接受口径。
      setError(t('settings_save_error_prefix') + String(e))
    } finally {
      setBusy(false)
    }
  }

  const onTest = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.validateSetup(row.id)
      reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <VStack gap={2} data-testid={`providers-${row.id}`}>
      <HStack gap={2} vAlign="center">
        <Text type="label">{PROVIDER_NAME[row.id]}</Text>
        <Button size="sm" variant="secondary" label={t('settings_provider_test')} isLoading={busy && !editing} onClick={() => void onTest()} />
        {editable && !editing && (
          <Button size="sm" variant="secondary" label={t('settings_provider_edit')} onClick={() => setEditing(true)} />
        )}
        {row.lastTest && (
          <>
            <StatusDot
              // StatusDotVariant 的域是 success|warning|error|accent|neutral 五个，**没有 danger**
              //（写 danger 是 TS2322，Step 5 的 `npx tsc --noEmit` 会直接拦下）。
              variant={row.lastTest.ok ? 'success' : 'error'}
              label={row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')}
            />
            <Text type="supporting" color="secondary">
              {row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')}
              {` · ${new Date(row.lastTest.at).toLocaleString()}`}
            </Text>
          </>
        )}
      </HStack>
      {row.lastTest && !row.lastTest.ok && row.lastTest.error && (
        <Text type="supporting" color="secondary">{row.lastTest.error}</Text>
      )}
      {row.secrets.map((s) => (
        <HStack key={s.name} gap={2} vAlign="center">
          <Text type="code">{s.name}</Text>
          {editing && s.source !== 'env' ? (
            <TextInput
              label={s.name}
              value={drafts[s.name] ?? ''}
              onChange={(v) => setDrafts((d) => ({ ...d, [s.name]: v }))}
              placeholder={s.masked ?? ''}
            />
          ) : (
            <>
              <Text type="supporting">{s.set ? s.masked ?? '••••' : t('settings_provider_not_set')}</Text>
              {s.set && (
                <Text type="supporting" color="secondary">
                  {s.source === 'env' ? t('settings_provider_source_env') : t('settings_provider_source_db')}
                </Text>
              )}
              {s.source === 'env' && (
                <Text type="supporting" color="secondary">{t('settings_provider_env_locked')}</Text>
              )}
            </>
          )}
        </HStack>
      ))}
      {editing && (
        <HStack gap={2}>
          <Button size="sm" variant="primary" label={t('settings_provider_save')} isLoading={busy} onClick={() => void onSave()} />
          <Button size="sm" variant="secondary" label={t('settings_provider_cancel')} onClick={() => { setEditing(false); setDrafts({}) }} />
        </HStack>
      )}
      {error && <Text type="supporting">{error}</Text>}
    </VStack>
  )
}

function ToggleRow({
  id, state, reload,
}: {
  id: 'subhd' | 'zimuku'
  state: { enabled: boolean; source: string }
  reload: () => void
}) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = state.source === 'env'
  const key = id === 'subhd' ? 'provider:SUBHD_ENABLED' as const : 'provider:ZIMUKU_ENABLED' as const

  const onToggle = async (next: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await api.updateSettings({ [key]: String(next) })
      reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <VStack gap={1} data-testid={`providers-${id}`}>
      <HStack gap={2} vAlign="center">
        <Switch
          label={PROVIDER_NAME[id]}
          value={state.enabled}
          onChange={(next) => void onToggle(next)}
          isLoading={busy}
          isDisabled={locked}
        />
        {locked && <Text type="supporting" color="secondary">{t('settings_provider_env_locked')}</Text>}
      </HStack>
      {error && <Text type="supporting">{error}</Text>}
    </VStack>
  )
}

export function ProvidersSection({ providers, setupStatus }: Props) {
  const { t } = useT()
  return (
    <section className="settings-section">
      <Text type="label">{t('settings_providers_title')}</Text>
      {providers.loading && !providers.data ? (
        <Text type="code" color="secondary">loading…</Text>
      ) : providers.error && !providers.data ? (
        <Text type="supporting" color="secondary">{t('settings_error_prefix') + providers.error}</Text>
      ) : providers.data ? (
        <VStack gap={5}>
          {providers.data.providers.filter((r) => r.secrets.length > 0).map((row) => (
            <KeyedRow key={row.id} row={row} reload={providers.reload} />
          ))}
          {setupStatus.data && (
            <>
              <ToggleRow id="subhd" state={setupStatus.data.providers.subhd} reload={setupStatus.reload} />
              <ToggleRow id="zimuku" state={setupStatus.data.providers.zimuku} reload={setupStatus.reload} />
            </>
          )}
        </VStack>
      ) : null}
    </section>
  )
}
