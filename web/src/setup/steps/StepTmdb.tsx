// web/src/setup/steps/StepTmdb.tsx：wizard 步 2——TMDB token。硬门禁（spec A §3）：先测后存，
// 只有测绿的那个值能 Save & continue。env 已配 → 锁定绿态；db 已配 → 绿态 + Re-test
// （Re-test 不传凭据 = 测服务端已解析值）。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { StatusDot, StepFooter } from './ui.js'
import type { WizardStepProps } from './types.js'

export function StepTmdb({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t } = useT()
  const [value, setValue] = useState('')
  const [testing, setTesting] = useState(false)
  const [testedValue, setTestedValue] = useState<string | null>(null)
  const [failMsg, setFailMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const runTest = async (v: string) => {
    setTesting(true)
    setFailMsg(null)
    try {
      const r = await api.validateSetup('tmdb', { TMDB_API_KEY: v })
      if (r.ok) setTestedValue(v)
      else setFailMsg(r.error ?? r.detail ?? t('wizard_test_failed'))
    } catch (e) {
      // 端点自身挂了（5xx / 网络断）——不是"凭据不对"，文案必须区分开（spec §7）。
      // 不回显 String(e)：那会把 "Error: HTTP 500" 摆到用户脸上，且异常串来源不受我们控制。
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
      const r = await api.validateSetup('tmdb')
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
      await api.putSecret('TMDB_API_KEY', value)
      // masked 是展示字段、wizard 后续不再展示本步输入值——null 如实表示"前端不算打码"，
      // 打码唯一事实源在后端（setupApi.ts 的 mask）。
      patchStatus({ tmdb: { satisfied: true, source: 'db', masked: null } })
      onAdvance()
    } catch (e) {
      setFailMsg(String(e))
      setSaving(false)
    }
  }

  if (status.tmdb.source === 'env') {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>{t('wizard_env_locked')}{status.tmdb.masked ? ` · ${status.tmdb.masked}` : ''}</span>
        </div>
        <StepFooter onBack={onBack}>
          <Button onClick={onAdvance}>{t('wizard_continue')}</Button>
        </StepFooter>
      </div>
    )
  }

  if (status.tmdb.satisfied) {
    return (
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone="green" />
          <span>{t('wizard_test_passed')}{status.tmdb.masked ? ` · ${status.tmdb.masked}` : ''}</span>
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
      <p className="text-sm text-muted-foreground">{t('wizard_tmdb_hint')}</p>
      <div className="flex items-center gap-2">
        <StatusDot tone={testing ? 'spin' : testedValue === value && value !== '' ? 'green' : failMsg ? 'red' : 'gray'} />
        <Input
          aria-label={t('wizard_tmdb_label')}
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setFailMsg(null)
          }}
          placeholder={t('wizard_tmdb_placeholder')}
          className="max-w-[360px]"
        />
        <Button variant="secondary" disabled={value === '' || testing} onClick={() => void runTest(value)}>
          {testing ? t('wizard_testing') : t('wizard_test')}
        </Button>
      </div>
      {testedValue === value && value !== '' && !failMsg && (
        <p className="text-sm text-fn-green">{t('wizard_test_passed')}</p>
      )}
      {failMsg && <p className="text-sm text-fn-red">{failMsg}</p>}
      <StepFooter onBack={onBack}>
        <Button disabled={testedValue !== value || value === '' || saving} onClick={() => void onSave()}>
          {t('wizard_save_continue')}
        </Button>
      </StepFooter>
    </div>
  )
}
