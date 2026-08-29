// web/src/settings/SecuritySection.tsx：鉴权 A3 Task 13——Settings tab 的安全区。自管数据（mount
// 拉 api.authSecurity()，只有本区用，不进全局 hooks）。api key 脱敏展示尾 4 位（调研：*arr 明文
// 常驻会在每张设置截图里泄露）+ 复制 + 重生成（确认弹窗陈述爆炸半径，即时生效无需重启）。改密
// 三输入复用 AuthField（密码管理器契约 + show-password）。三态齐全（DESIGN.md 铁律）。
//
// 控件栈（Plan C Task 27 迁移）：Astryx Text/Button/VStack/AlertDialog 全卸——Button children 化
// （label prop 退役；isLoading 期间 Astryx 本就 disable 按钮，故 disabled={busy} 守住同一语义，
// spinner 不迁），VStack 换裸 flex div，Text 按控件事典映射到手写 span。重生成 AlertDialog 换
// Radix 组合式：Action 默认 click 即关，现网语义是 regenerate 的 finally 手动关（飞行中保持
// 开启），故 Action onClick 必须 e.preventDefault() 拦住默认关闭。改密真 <form> + AuthField
// 本来就是原生，不动。
import { useEffect, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js'
import { Button, buttonVariants } from '../components/ui/button.js'
import { api } from '../api/client.js'
import type { AuthSecurityDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { localizeErrorValue } from '../lib/errorText.js'
import { copyText } from '../lib/copyText.js'
import { AuthField } from '../auth/AuthField.js'

const MIN_PASSWORD_LEN = 10
const maskKey = (key: string) => '••••••••' + key.slice(-4)

export function SecuritySection() {
  const { t, lang } = useT()
  const [data, setData] = useState<AuthSecurityDTO | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.authSecurity()
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(t('settings_security_error_prefix') + localizeErrorValue(e, lang)) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error && !data) {
    return (
      <section className="settings-section">
        <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_security_heading')}</span>
        <div className="auth-error" role="alert">{error}</div>
      </section>
    )
  }
  if (!data) {
    return (
      <section className="settings-section">
        <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_security_heading')}</span>
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">{t('settings_security_loading')}</span>
      </section>
    )
  }

  return (
    <section className="settings-section">
      <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_security_heading')}</span>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_security_username_label')}</span>
          <span className="settings-deploy-key">{data.username}</span>
        </div>
        <ApiKeyRow data={data} onRegenerated={(apiKey) => setData({ ...data, apiKey })} />
        <ChangePasswordRow />
      </div>
    </section>
  )
}

function ApiKeyRow({ data, onRegenerated }: { data: AuthSecurityDTO; onRegenerated: (apiKey: string) => void }) {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  async function copy() {
    // lib/copyText：LAN 纯 http 下 navigator.clipboard 不存在，execCommand 兜底（2026-08-29
    // NAS 实测同 wizard ApiKeyNotice 的坑）。设置页这里复制的是脱敏值末 4 位场景少，但同病同修。
    if (await copyText(data.apiKey)) setCopied(true)
  }

  async function regenerate() {
    // 破坏性动作：AlertDialog 陈述爆炸半径（审计前端 #5：DESIGN §5 铁律，destructive 用 AlertDialog
    // 而非 window.confirm——同 RemoveRootDialog 先例）。Action 已 preventDefault 拦住默认关闭，
    // 这里 finally 手动收尾（飞行中对话框保持开启，busy 守住 Action）。
    setBusy(true)
    try {
      const r = await api.regenerateApiKey()
      onRegenerated(r.apiKey)
      setCopied(false)
    } catch {
      // best-effort：失败保持旧值不变；此处不额外弹错（低频动作，用户可重试）。
    } finally {
      setBusy(false)
      setConfirmOpen(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_security_apikey_label')}</span>
      <div className="settings-deploy-row">
        <span className="settings-deploy-key">{maskKey(data.apiKey)}</span>
        <Button size="sm" variant="secondary" onClick={copy}>
          {copied ? t('settings_security_copied') : t('settings_security_copy')}
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setConfirmOpen(true)}>
          {t('settings_security_regenerate')}
        </Button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings_security_regenerate')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings_security_regen_confirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* Cancel 走 common_cancel（审计 P0-4）。 */}
            <AlertDialogCancel>{t('common_cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              disabled={busy}
              onClick={(e) => {
                // Radix Action 默认 click 即关闭；现网语义是 regenerate 的 finally 手动关
                // （飞行中保持开启、busy 守住重复点击），这里必须拦住默认关闭。
                e.preventDefault()
                void regenerate()
              }}
            >
              {t('settings_security_regenerate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function ChangePasswordRow() {
  const { t, lang } = useT()
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
      setError(localizeErrorValue(e, lang))
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
      {success && <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_security_change_success')}</span>}
      <div>
        <Button type="submit" size="sm" variant="default" disabled={busy}>
          {t('settings_security_change_button')}
        </Button>
      </div>
    </form>
  )
}
