// web/src/setup/steps/StepProviders.tsx：wizard 步 4——keyed 字幕源（软门禁，spec A §3 步 4）。
// 成员按目标语言分流（registry spec §5.2）：zh→ASSRT/OS/r3sub/SubDL；ja→OS/Jimaku/SubDL；
// 其他→OS/SubDL。语言归属从 /setup/providers 行派生（derive.ts），rows 未到 fail-open 全员。
// 各家自测自存：只有测绿的 key 会落库；红不拦路、行内写后果；零绿时 Save 禁用、走 Skip。
// OS 的 username/password 成对才存（与 setupApi hasUsername 同口径）。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { localizeError, localizeErrorValue } from '../../lib/errorText.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { StatusDot, StepFooter } from './ui.js'
import { visibleKeyedSourceIds, type WizardKeyedSourceId } from './derive.js'
import type { SecretName, SetupStatusDTO } from '../../api/types.js'
import type { TKey } from '../../i18n/useT.js'
import type { WizardStepProps } from './types.js'

type ProviderId = WizardKeyedSourceId

interface FieldDef {
  name: SecretName
  labelKey: TKey
  password: boolean
  required: boolean
}

const PROVIDER_FIELDS: Record<ProviderId, FieldDef[]> = {
  assrt: [{ name: 'ASSRT_TOKEN', labelKey: 'wizard_assrt_label', password: true, required: true }],
  opensubtitles: [
    { name: 'OPENSUBTITLES_API_KEY', labelKey: 'wizard_os_apikey_label', password: true, required: true },
    { name: 'OPENSUBTITLES_USERNAME', labelKey: 'wizard_os_user_label', password: false, required: false },
    { name: 'OPENSUBTITLES_PASSWORD', labelKey: 'wizard_os_pass_label', password: true, required: false },
  ],
  jimaku: [{ name: 'JIMAKU_API_KEY', labelKey: 'wizard_jimaku_label', password: true, required: true }],
  // r3sub：先在 r3sub.com 注册并完成邮箱验证，再回来填同一套账密（GET_CREDENTIALS 有指引）。
  r3sub: [
    { name: 'R3SUB_EMAIL', labelKey: 'wizard_r3sub_email_label', password: false, required: true },
    { name: 'R3SUB_PASSWORD', labelKey: 'wizard_r3sub_pass_label', password: true, required: true },
  ],
  subdl: [{ name: 'SUBDL_API_KEY', labelKey: 'wizard_subdl_label', password: true, required: true }],
}

const CONSEQUENCE_KEY: Record<ProviderId, TKey> = {
  assrt: 'wizard_consequence_assrt',
  opensubtitles: 'wizard_consequence_os',
  jimaku: 'wizard_consequence_jimaku',
  r3sub: 'wizard_consequence_r3sub',
  subdl: 'wizard_consequence_subdl',
}

interface BlockState {
  values: Partial<Record<SecretName, string>>
  testing: boolean
  testedKey: string | null
  failMsg: string | null
}

const EMPTY_BLOCK: BlockState = { values: {}, testing: false, testedKey: null, failMsg: null }

function currentKey(id: ProviderId, values: Partial<Record<SecretName, string>>): string {
  return PROVIDER_FIELDS[id].map((f) => values[f.name] ?? '').join('\n')
}

function testable(id: ProviderId, values: Partial<Record<SecretName, string>>): boolean {
  return PROVIDER_FIELDS[id].every((f) => !f.required || (values[f.name] ?? '') !== '')
}

export function StepProviders(props: WizardStepProps) {
  const { status, patchStatus, onAdvance, onBack } = props
  const { t, lang } = useT()
  const [blocks, setBlocks] = useState<Record<ProviderId, BlockState>>({
    assrt: EMPTY_BLOCK, opensubtitles: EMPTY_BLOCK, jimaku: EMPTY_BLOCK, r3sub: EMPTY_BLOCK, subdl: EMPTY_BLOCK,
  })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // 分流后的本步成员（顺序=行序=注册表声明序；rows 未到 fail-open 全员）。
  const memberIds = visibleKeyedSourceIds(props)

  const setBlock = (id: ProviderId, patch: Partial<BlockState>) =>
    setBlocks((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const green = (id: ProviderId): boolean => {
    const b = blocks[id]
    return b.testedKey !== null && b.testedKey === currentKey(id, b.values) && testable(id, b.values)
  }
  const anyGreen = memberIds.some(green)

  const runTest = async (id: ProviderId) => {
    const b = blocks[id]
    setBlock(id, { testing: true, failMsg: null })
    try {
      // OS 的 username/password 成对才参与测试与保存——单填视为未填（setupApi hasUsername 同口径）。
      const credentials: Partial<Record<SecretName, string>> = {}
      for (const f of PROVIDER_FIELDS[id]) {
        const v = b.values[f.name] ?? ''
        if (v === '') continue
        if (f.name === 'OPENSUBTITLES_USERNAME' && (b.values.OPENSUBTITLES_PASSWORD ?? '') === '') continue
        if (f.name === 'OPENSUBTITLES_PASSWORD' && (b.values.OPENSUBTITLES_USERNAME ?? '') === '') continue
        credentials[f.name] = v
      }
      const r = await api.validateSetup(id, credentials)
      if (r.ok) setBlock(id, { testing: false, testedKey: currentKey(id, b.values) })
      else setBlock(id, { testing: false, failMsg: localizeError(r.error ?? r.detail ?? t('wizard_test_failed'), lang) })
    } catch (e) {
      // 同 Task 17/18：端点自身挂了 ≠ 凭据不对（spec §7）。
      void e
      setBlock(id, { testing: false, failMsg: t('wizard_test_unavailable') })
    }
  }

  const onSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      for (const id of memberIds) {
        if (!green(id)) continue
        const b = blocks[id]
        for (const f of PROVIDER_FIELDS[id]) {
          const v = b.values[f.name] ?? ''
          if (v === '') continue
          if (f.name === 'OPENSUBTITLES_USERNAME' && (b.values.OPENSUBTITLES_PASSWORD ?? '') === '') continue
          if (f.name === 'OPENSUBTITLES_PASSWORD' && (b.values.OPENSUBTITLES_USERNAME ?? '') === '') continue
          await api.putSecret(f.name, v)
        }
      }
      // patchStatus 一次性组出各家新态——只动测绿的家，其余保持 status 原值。
      const patch: Partial<SetupStatusDTO['providers']> = {}
      if (green('assrt')) patch.assrt = { satisfied: true, source: 'db', masked: null }
      if (green('opensubtitles')) {
        const b = blocks.opensubtitles
        const paired = (b.values.OPENSUBTITLES_USERNAME ?? '') !== '' && (b.values.OPENSUBTITLES_PASSWORD ?? '') !== ''
        patch.opensubtitles = { satisfied: true, source: 'db', hasUsername: paired, masked: null }
      }
      if (green('jimaku')) patch.jimaku = { satisfied: true, source: 'db', masked: null }
      if (green('r3sub')) patch.r3sub = { satisfied: true, source: 'db', masked: null }
      if (green('subdl')) patch.subdl = { satisfied: true, source: 'db', masked: null }
      patchStatus({ providers: { ...status.providers, ...patch } })
      onAdvance()
    } catch (e) {
      setSaveError(localizeErrorValue(e, lang))
      setSaving(false)
    }
  }

  const renderBlock = (id: ProviderId) => {
    const satisfied = status.providers[id].satisfied
    const masked = status.providers[id].masked
    const source = status.providers[id].source
    const b = blocks[id]
    if (satisfied) {
      return (
        <section key={id} data-testid={`provider-${id}`} className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>
            {source === 'env' ? t('wizard_env_locked') : t('wizard_test_passed')}
            {masked ? ` · ${masked}` : ''}
          </span>
        </section>
      )
    }
    const isGreen = green(id)
    return (
      <section key={id} data-testid={`provider-${id}`} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot tone={b.testing ? 'spin' : isGreen ? 'green' : b.failMsg ? 'red' : 'gray'} />
          {PROVIDER_FIELDS[id].map((f) => (
            <Input
              key={f.name}
              aria-label={t(f.labelKey)}
              type={f.password ? 'password' : 'text'}
              value={b.values[f.name] ?? ''}
              onChange={(e) =>
                setBlock(id, { values: { ...b.values, [f.name]: e.target.value }, failMsg: null })
              }
              placeholder={t(f.labelKey)}
              className="max-w-[260px]"
            />
          ))}
          <Button variant="secondary" disabled={!testable(id, b.values) || b.testing} onClick={() => void runTest(id)}>
            {b.testing ? t('wizard_testing') : t('wizard_test')}
          </Button>
          {isGreen && <span className="text-sm text-fn-green">{t('wizard_test_passed')}</span>}
        </div>
        {b.failMsg && (
          <>
            <p className="text-sm text-fn-red">{b.failMsg}</p>
            <p className="text-sm text-weak">{t(CONSEQUENCE_KEY[id])}</p>
          </>
        )}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('wizard_providers_banner')}</p>
      {memberIds.map(renderBlock)}
      <p className="text-xs text-weak">{t('wizard_providers_save_note')}</p>
      {saveError && <p className="text-sm text-fn-red">{saveError}</p>}
      <StepFooter onBack={onBack}>
        <Button variant="ghost" onClick={onAdvance}>{t('wizard_skip_step')}</Button>
        <Button disabled={!anyGreen || saving} onClick={() => void onSave()}>
          {t('wizard_save_continue')}
        </Button>
      </StepFooter>
    </div>
  )
}
