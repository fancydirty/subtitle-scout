// web/src/auth/ConnectionError.tsx：鉴权门探测失败时的诚实错误屏（correctness 审计 #2/#6）——
// 服务器不可达/超时时既不误显 LoginPage（fresh install 上会让用户对着"密码不正确"的假象），也不
// 永久白屏。给一句人话 + 重试钮。复用 AuthShell 外壳。
// Plan C Task 30：Astryx Button 卸（label prop 退役、children 化）。
import { Button } from '../components/ui/button.js'
import { useT } from '../i18n/useT.js'
import { AuthShell } from './AuthShell.js'

export function ConnectionError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT()
  return (
    <AuthShell heading={t('auth_connection_error_heading')}>
      <p className="auth-intro">{t('auth_connection_error_desc')}</p>
      <div className="auth-form">
        <Button variant="default" onClick={onRetry}>{t('auth_retry')}</Button>
      </div>
    </AuthShell>
  )
}
