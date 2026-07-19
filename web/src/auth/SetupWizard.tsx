// web/src/auth/SetupWizard.tsx：鉴权 A2 Task 9+9′——首启向导。单屏建管理员（调研：*arr/Homarr
// 都单屏建管理员；Jellyfin 六步是为库/网络配置，我们没有那些）。成功即登录（服务端 setup 响应
// 直接 set-cookie），接一次性 API key 告知屏——避开 *arr/Jellyfin 最烂共性"重打刚建的凭据"。
import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { useT } from '../i18n/useT.js'
import { api } from '../api/client.js'
import { AuthShell } from './AuthShell.js'
import { AuthField } from './AuthField.js'

const MIN_PASSWORD_LEN = 10

export function SetupWizard({ onDone }: { onDone: () => void }) {
  const { t } = useT()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)

  async function submit() {
    setError(null)
    if (password !== confirm) { setError(t('setup_password_mismatch')); return }
    setBusy(true)
    try {
      const r = await api.authSetup(username, password)
      setApiKey(r.apiKey) // 一次性告知屏：唯一一次全显
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (apiKey !== null) {
    return <ApiKeyNotice apiKey={apiKey} onDone={onDone} />
  }

  return (
    <AuthShell heading={t('setup_heading')}>
      <p className="auth-intro">{t('setup_intro')}</p>
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <AuthField
          id="setup-username" label={t('auth_username_label')} value={username} onChange={setUsername}
          autoComplete="username" autoFocus
        />
        <AuthField
          id="setup-password" label={t('auth_password_label')} value={password} onChange={setPassword}
          type="password" autoComplete="new-password"
          hint={t('setup_password_hint')} hintMet={password.length >= MIN_PASSWORD_LEN}
        />
        <AuthField
          id="setup-confirm" label={t('setup_confirm_label')} value={confirm} onChange={setConfirm}
          type="password" autoComplete="new-password"
        />
        {error && <div className="auth-error" role="alert">{error}</div>}
        <Button
          type="submit" variant="primary"
          label={busy ? t('setup_submitting') : t('setup_submit')}
          isLoading={busy} isDisabled={busy}
        />
      </form>
    </AuthShell>
  )
}

/** 一次性 API key 告知屏（建成即登录后立即展示，唯一一次全显）。复制是屏上的 lime 主动作；
 *  进入需显式点击——绝不自动跳过一个专门给用户抄密钥的屏（调研：GitHub/Stripe 秘钥一次性揭示）。 */
function ApiKeyNotice({ apiKey, onDone }: { apiKey: string; onDone: () => void }) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(apiKey)
      setCopied(true)
    } catch {
      // 剪贴板不可用（无 https/权限）时静默——用户仍可手动选中 mono 文本复制。
    }
  }
  return (
    <AuthShell heading={t('setup_apikey_heading')}>
      <div className="auth-apikey">{apiKey}</div>
      <p className="auth-intro">{t('setup_apikey_notice')}</p>
      <div className="auth-form">
        <Button
          variant={copied ? 'secondary' : 'primary'}
          label={copied ? t('setup_apikey_copied') : t('setup_apikey_copy')}
          onClick={copy}
        />
        <Button variant="secondary" label={t('setup_enter_label')} onClick={onDone} />
      </div>
    </AuthShell>
  )
}
