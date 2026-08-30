// web/src/setup/steps/StepTmdb.tsx：wizard 步 2——TMDB token。硬门禁（spec A §3）：先测后存，
// 只有测绿的那个值能 Save & continue。env 已配 → 锁定绿态；db 已配 → 绿态 + Re-test
// （Re-test 不传凭据 = 测服务端已解析值）。输入屏另带「大陆网络预设」引导块（CnPresetGuide）。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { localizeError, localizeErrorValue } from '../../lib/errorText.js'
import { copyText } from '../../lib/copyText.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { StatusDot, StepFooter } from './ui.js'
import type { WizardStepProps } from './types.js'

/** TMDB 大陆可达线（2026-08-30）：大陆预设定案——API 走 TMDB 官方旧域名（多数地区免代理
 *  可直连），图片走 wsrv.nl 包装模板（老牌免费图片 CDN；图片 URL 不含 key，隐私无虞）。
 *  ⚠️ 这两个键是**部署层 env**，向导改不了容器 env——预设做的是纯引导（可复制片段 +
 *  README 大陆节链接），不是配置开关。 */
const CN_PRESET_SNIPPET = [
  'TMDB_BASE_URL: https://api.tmdb.org/3',
  'TMDB_IMAGE_BASE_URL: https://wsrv.nl/?url=https://image.tmdb.org{path}',
].join('\n')
/** README「大陆网络环境」节的 GitHub 锚点（README 内部链接同款拼法）。 */
const CN_PRESET_README_URL =
  'https://github.com/fancydirty/subtitle-scout#大陆网络环境tmdb-直连不通怎么办'

/** 「大陆网络预设」引导块：恒显示（UI 文案全英语铁律，不做语言探测分流）。展开态含
 *  compose env 两行 + 复制钮（lib/copyText：LAN 纯 http 下 execCommand 兜底）+ README 链接。 */
function CnPresetGuide() {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <div className="flex flex-col gap-2">
      <Button variant="ghost" size="sm" className="self-start" onClick={() => setOpen((v) => !v)}>
        {t('wizard_tmdb_cn_preset')}
      </Button>
      {open && (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <p className="text-sm text-muted-foreground">{t('wizard_tmdb_cn_note')}</p>
          <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{CN_PRESET_SNIPPET}</pre>
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void copyText(CN_PRESET_SNIPPET).then((ok) => setCopyState(ok ? 'copied' : 'failed'))
              }}
            >
              {copyState === 'copied' ? t('wizard_tmdb_cn_copied') : t('wizard_tmdb_cn_copy')}
            </Button>
            <a
              className="text-sm text-muted-foreground underline underline-offset-2"
              href={CN_PRESET_README_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t('wizard_tmdb_cn_readme')}
            </a>
          </div>
          {copyState === 'failed' && <p className="text-sm text-fn-red">{t('wizard_tmdb_cn_copy_failed')}</p>}
        </div>
      )}
    </div>
  )
}

export function StepTmdb({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t, lang } = useT()
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
      else setFailMsg(localizeError(r.error ?? r.detail ?? t('wizard_test_failed'), lang))
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
      if (!r.ok) setFailMsg(localizeError(r.error ?? r.detail ?? t('wizard_test_failed'), lang))
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
      setFailMsg(localizeErrorValue(e, lang))
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
      {/* 大陆用户在向导第一步就能看到出路（不用翻文档）——api.themoviedb.org 被墙时上面的
          Test 永远转圈/超时，这里给部署层 env 的就地引导。 */}
      <CnPresetGuide />
      <StepFooter onBack={onBack}>
        <Button disabled={testedValue !== value || value === '' || saving} onClick={() => void onSave()}>
          {t('wizard_save_continue')}
        </Button>
      </StepFooter>
    </div>
  )
}
