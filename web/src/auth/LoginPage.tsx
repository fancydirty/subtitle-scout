// web/src/auth/LoginPage.tsx：鉴权 A2 Task 10+10′——登录页，极简。调研（Overseerr/*arr）：被夸的
// 登录页夸的是构图与"不跟密码管理器打架"，从不是功能。一个 method 一个 form，无 remember-me、无
// method 选择器。错误精确文案 + 保留 username + 清空 password + 聚焦（避 Overseerr "Something
// went wrong" / *arr `?loginFailed=true` reload）。
import { useRef, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { useT } from '../i18n/useT.js'
import { api } from '../api/client.js'
import { AuthShell } from './AuthShell.js'
import { AuthField } from './AuthField.js'

export function LoginPage({ onDone }: { onDone: () => void }) {
  const { t } = useT()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      await api.login(username, password)
      onDone()
    } catch (err) {
      // 传输失败（fetch 在拿到响应前就 reject）是 TypeError；HTTP 错误（401/429…）是 errorMessage
      // 抛的 Error。据此分两类文案——401 恒作"用户名或密码不正确"（不泄露账号是否存在，虽单管理员
      // 无枚举风险，措辞仍取此为准）。保留 username、清空 password、聚焦密码框（调研强建议）。
      setError(err instanceof TypeError ? t('login_error_transport') : t('login_error_invalid'))
      setPassword('')
      passwordRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell heading={t('login_heading')}>
      <form className="auth-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <AuthField
          id="login-username" label={t('auth_username_label')} value={username} onChange={setUsername}
          autoComplete="username" autoFocus
        />
        <AuthField
          id="login-password" label={t('auth_password_label')} value={password} onChange={setPassword}
          type="password" autoComplete="current-password" inputRef={passwordRef}
        />
        {error && <div className="auth-error" role="alert">{error}</div>}
        <Button
          type="submit" variant="primary"
          label={busy ? t('login_submitting') : t('login_submit')}
          isLoading={busy} isDisabled={busy}
        />
      </form>
      {/* 诚实找回密码：命令真实存在（A4 的 `auth reset` CLI 背书），mono 展示。 */}
      <p className="auth-forgot">
        {t('login_forgot_hint').replace(/subtitle-scout auth reset/, '')}
        <code>subtitle-scout auth reset</code>
      </p>
    </AuthShell>
  )
}
