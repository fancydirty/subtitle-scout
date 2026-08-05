// web/src/settings/ProvidersSection.tsx：Providers 区（spec A §5.4）——每家一行：打码值、
// source 徽标、上次测试点、编辑（仅 db 源可改；空输入=不动该键，UI 不提供删除——删除走
// PUT secrets API 语义，界面不开放，防占位空串误删）、Test；无 key 的 subhd/zimuku 两家
// 以 toggle 行呈现（同一 PUT settings 通道）。编辑/测试后直接 reload 刷新打码与测试点。
// 与 wizard 的不对称是有意的：wizard 先测后存是首跑纪律；Settings 保存不强制测试，
// 靠上次测试点展示兜底（测试按钮常备）。
//
// 控件栈（Plan C Task 26 迁移）：Astryx Text/TextInput/Button/Switch/VStack/HStack/StatusDot
// 全卸——Button children 化（isLoading→disabled，既有用例不断言 spinner）；TextInput 换
// shadcn Input（aria-label 手写对齐 getByLabelText 锚；Astryx onChange 直接吃新值，shadcn 是
// (e) => e.target.value）；Switch 的 value/onChange 改名 checked/onCheckedChange + aria-label
// 手写；StatusDot 同名零改件；VStack/HStack 换裸 flex div（不包裹子节点——children 计数结构钉
// okRow 2 / llm 5 / failRow 2 在 ProvidersSection.test.tsx 钉死）。行内错误换
// <p role="alert">（条件插入即 SR 自动播报，同 BehaviorSection 口径）。
import { useState } from 'react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { StatusDot } from '../components/ui/status-dot.js'
import { Switch } from '../components/ui/switch.js'
import { api } from '../api/client.js'
import type { Async } from '../api/hooks.js'
import type { ProvidersDTO, ProviderRowDTO, SetupStatusDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'

// 厂牌专名不进 i18n（双表同形，同 wizard 步 1 语言自称先例）。
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
    <div className="flex flex-col gap-2" data-testid={`providers-${row.id}`}>
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium leading-5 text-foreground">{PROVIDER_NAME[row.id]}</span>
        <Button size="sm" variant="secondary" disabled={busy && !editing} onClick={() => void onTest()}>
          {t('settings_provider_test')}
        </Button>
        {editable && !editing && (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {t('settings_provider_edit')}
          </Button>
        )}
        {row.lastTest && (
          <>
            <StatusDot
              // StatusDotVariant 的域是 success|error|neutral 三档（Astryx 五档随主题退役）。
              variant={row.lastTest.ok ? 'success' : 'error'}
              label={row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')}
            />
            <span className="text-[11px] leading-4 text-muted-foreground">
              {row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')}
              {` · ${new Date(row.lastTest.at).toLocaleString()}`}
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
          {editing && s.source !== 'env' ? (
            <Input
              aria-label={s.name}
              value={drafts[s.name] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [s.name]: e.target.value }))}
              placeholder={s.masked ?? ''}
            />
          ) : (
            <>
              <span className="text-[11px] leading-4">{s.set ? s.masked ?? '••••' : t('settings_provider_not_set')}</span>
              {s.set && (
                <span className="text-[11px] leading-4 text-muted-foreground">
                  {s.source === 'env' ? t('settings_provider_source_env') : t('settings_provider_source_db')}
                </span>
              )}
              {s.source === 'env' && (
                <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_provider_env_locked')}</span>
              )}
            </>
          )}
        </div>
      ))}
      {editing && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void onSave()}>
            {t('settings_provider_save')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setDrafts({}) }}>
            {t('settings_provider_cancel')}
          </Button>
        </div>
      )}
      {error && <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p>}
    </div>
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
    <div className="flex flex-col gap-1" data-testid={`providers-${id}`}>
      <div className="flex items-center gap-2">
        <Switch
          aria-label={PROVIDER_NAME[id]}
          checked={state.enabled}
          onCheckedChange={(next) => void onToggle(next)}
          disabled={busy || locked}
        />
        <span className="text-[13px] font-medium leading-5 text-foreground">{PROVIDER_NAME[id]}</span>
        {locked && <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_provider_env_locked')}</span>}
      </div>
      {error && <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p>}
    </div>
  )
}

export function ProvidersSection({ providers, setupStatus }: Props) {
  const { t } = useT()
  return (
    <section className="settings-section">
      <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_providers_title')}</span>
      {providers.loading && !providers.data ? (
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">loading…</span>
      ) : providers.error && !providers.data ? (
        <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_error_prefix') + providers.error}</span>
      ) : providers.data ? (
        <div className="flex flex-col gap-5">
          {providers.data.providers.filter((r) => r.secrets.length > 0).map((row) => (
            <KeyedRow key={row.id} row={row} reload={providers.reload} />
          ))}
          {setupStatus.data && (
            <>
              <ToggleRow id="subhd" state={setupStatus.data.providers.subhd} reload={setupStatus.reload} />
              <ToggleRow id="zimuku" state={setupStatus.data.providers.zimuku} reload={setupStatus.reload} />
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}
