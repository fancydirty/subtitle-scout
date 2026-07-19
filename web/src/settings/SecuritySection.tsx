// web/src/settings/SecuritySection.tsx：鉴权 A3 Task 13——Settings tab 的安全区。自管数据（mount
// 拉 api.authSecurity()，只有本区用，不进全局 hooks）。api key 脱敏展示尾 4 位（调研：*arr 明文
// 常驻会在每张设置截图里泄露）+ 复制 + 重生成（确认弹窗陈述爆炸半径，即时生效无需重启）。改密
// 三输入复用 AuthField（密码管理器契约 + show-password）。三态齐全（DESIGN.md 铁律）。
import { useEffect, useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { VStack } from '@astryxdesign/core/VStack'
import { api } from '../api/client.js'
import type { AuthSecurityDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { AuthField } from '../auth/AuthField.js'

const MIN_PASSWORD_LEN = 10
const maskKey = (key: string) => '••••••••' + key.slice(-4)

export function SecuritySection() {
  const { t } = useT()
  const [data, setData] = useState<AuthSecurityDTO | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.authSecurity()
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(t('settings_security_error_prefix') + String(e)) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error && !data) {
    return (
      <section className="settings-section">
        <Text type="label">{t('settings_security_heading')}</Text>
        <div className="auth-error">{error}</div>
      </section>
    )
  }
  if (!data) {
    return (
      <section className="settings-section">
        <Text type="label">{t('settings_security_heading')}</Text>
        <Text type="code" color="secondary">{t('settings_security_loading')}</Text>
      </section>
    )
  }

  return (
    <section className="settings-section">
      <Text type="label">{t('settings_security_heading')}</Text>
      <VStack gap={5}>
        <VStack gap={2}>
          <Text type="supporting" color="secondary">{t('settings_security_username_label')}</Text>
          <span className="settings-deploy-key">{data.username}</span>
        </VStack>
        <ApiKeyRow data={data} onRegenerated={(apiKey) => setData({ ...data, apiKey })} />
        <ChangePasswordRow />
      </VStack>
    </section>
  )
}

function ApiKeyRow({ data, onRegenerated }: { data: AuthSecurityDTO; onRegenerated: (apiKey: string) => void }) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(data.apiKey)
      setCopied(true)
    } catch {
      // 剪贴板不可用时静默——脱敏值可手选复制不了全量，但这条降级路径罕见（需 https/权限）。
    }
  }

  async function regenerate() {
    // 破坏性动作：确认弹窗陈述爆炸半径（调研：*arr 的"Are you sure?"是无后果坏范例）。
    if (!window.confirm(t('settings_security_regen_confirm'))) return
    setBusy(true)
    try {
      const r = await api.regenerateApiKey()
      onRegenerated(r.apiKey)
      setCopied(false)
    } catch {
      // best-effort：失败保持旧值不变；此处不额外弹错（低频动作，用户可重试）。
    } finally {
      setBusy(false)
    }
  }

  return (
    <VStack gap={2}>
      <Text type="supporting" color="secondary">{t('settings_security_apikey_label')}</Text>
      <div className="settings-deploy-row">
        <span className="settings-deploy-key">{maskKey(data.apiKey)}</span>
        <Button size="sm" variant="secondary" label={copied ? t('settings_security_copied') : t('settings_security_copy')} onClick={copy} />
        <Button size="sm" variant="destructive" label={t('settings_security_regenerate')} isLoading={busy} onClick={regenerate} />
      </div>
    </VStack>
  )
}

function ChangePasswordRow() {
  const { t } = useT()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setError(null)
    setSuccess(false)
    setBusy(true)
    try {
      await api.changePassword(current, next)
      setSuccess(true)
      setCurrent('')
      setNext('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <AuthField
        id="sec-current" label={t('settings_security_current_password')} value={current} onChange={setCurrent}
        type="password" autoComplete="current-password"
      />
      <AuthField
        id="sec-new" label={t('settings_security_new_password')} value={next} onChange={setNext}
        type="password" autoComplete="new-password"
        hint={t('settings_security_password_hint')} hintMet={next.length >= MIN_PASSWORD_LEN}
      />
      {error && <div className="auth-error" role="alert">{error}</div>}
      {success && <Text type="supporting" color="secondary">{t('settings_security_change_success')}</Text>}
      <Button type="submit" size="sm" variant="primary" label={t('settings_security_change_button')} isLoading={busy} isDisabled={busy} />
    </form>
  )
}
