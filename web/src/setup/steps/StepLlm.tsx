// web/src/setup/steps/StepLlm.tsx：wizard 步 3——LLM 三件套（硬门禁，spec A §3/§5.2 步 3）。
// 三字段齐填才能 Test（与 setupApi 的 llmSatisfied 同口径）；测绿的组合才能存；
// 保存 = 三次顺序 putSecret（端点单键；中途失败已存的留下次覆盖，幂等）。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { StatusDot, StepFooter } from './ui.js'
import type { WizardStepProps } from './types.js'

export function StepLlm({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t } = useT()
  const [base, setBase] = useState('')
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const [testing, setTesting] = useState(false)
  const [testedTriple, setTestedTriple] = useState<string | null>(null)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const tripleKey = `${base}\n${key}\n${model}`
  const filled = base !== '' && key !== '' && model !== ''
  const green = testedTriple === tripleKey && filled

  const runTest = async () => {
    setTesting(true)
    setFailMsg(null)
    try {
      const r = await api.validateSetup('llm', { LLM_BASE_URL: base, LLM_API_KEY: key, LLM_MODEL: model })
      if (r.ok) setTestedTriple(tripleKey)
      else setFailMsg(r.error ?? r.detail ?? t('wizard_test_failed'))
    } catch (e) {
      // 同 Task 17：端点自身挂了 ≠ 凭据不对（spec §7），不回显异常串。
      void e
      setFailMsg(t('wizard_test_unavailable'))
    } finally {
      setTesting(false)
    }
  }

  const retestResolved = async () => {
    setTesting(true)
    setFailMsg(null)
    try {
      const r = await api.validateSetup('llm')
      if (!r.ok) setFailMsg(r.error ?? r.detail ?? t('wizard_test_failed'))
    } catch (e) {
      void e
      setFailMsg(t('wizard_test_unavailable'))
    } finally {
      setTesting(false)
    }
  }

  const onSave = async () => {
    setSaving(true)
    setFailMsg(null)
    try {
      await api.putSecret('LLM_BASE_URL', base)
      await api.putSecret('LLM_API_KEY', key)
      await api.putSecret('LLM_MODEL', model)
      patchStatus({ llm: { satisfied: true, source: 'db', model } })
      onAdvance()
    } catch (e) {
      setFailMsg(String(e))
      setSaving(false)
    }
  }

  if (status.llm.source === 'env') {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>
            {t('wizard_env_locked')}{status.llm.model ? ` · ${status.llm.model}` : ''}
          </span>
        </div>
        <StepFooter onBack={onBack}>
          <Button onClick={onAdvance}>{t('wizard_continue')}</Button>
        </StepFooter>
      </div>
    )
  }

  if (status.llm.satisfied) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>{t('wizard_test_passed')}{status.llm.model ? ` · ${status.llm.model}` : ''}</span>
          <Button variant="ghost" size="sm" disabled={testing} onClick={() => void retestResolved()}>
            {testing ? t('wizard_testing') : t('wizard_retest')}
          </Button>
        </div>
        {failMsg && <p className="text-sm text-fn-red">{failMsg}</p>}
        <StepFooter onBack={onBack}>
          <Button onClick={onAdvance}>{t('wizard_continue')}</Button>
        </StepFooter>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{t('wizard_llm_required_note')}</p>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Input
            aria-label={t('wizard_llm_base_label')}
            value={base}
            onChange={(e) => {
              setBase(e.target.value)
              setFailMsg(null)
            }}
            placeholder={t('wizard_llm_base_label')}
            className="max-w-[420px]"
          />
          <span className="text-xs text-weak">{t('wizard_llm_base_hint')}</span>
        </div>
        <Input
          aria-label={t('wizard_llm_key_label')}
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
            setFailMsg(null)
          }}
          placeholder={t('wizard_llm_key_label')}
          className="max-w-[420px]"
        />
        <Input
          aria-label={t('wizard_llm_model_label')}
          value={model}
          onChange={(e) => {
            setModel(e.target.value)
            setFailMsg(null)
          }}
          placeholder={t('wizard_llm_model_placeholder')}
          className="max-w-[420px]"
        />
      </div>
      <div className="flex items-center gap-2">
        <StatusDot tone={testing ? 'spin' : green ? 'green' : failMsg ? 'red' : 'gray'} />
        <Button variant="secondary" disabled={!filled || testing} onClick={() => void runTest()}>
          {testing ? t('wizard_testing') : t('wizard_test')}
        </Button>
        {green && !failMsg && <span className="text-sm text-fn-green">{t('wizard_test_passed')}</span>}
      </div>
      {failMsg && <p className="text-sm text-fn-red">{failMsg}</p>}
      <StepFooter onBack={onBack}>
        <Button disabled={!green || saving} onClick={() => void onSave()}>
          {t('wizard_save_continue')}
        </Button>
      </StepFooter>
    </div>
  )
}
