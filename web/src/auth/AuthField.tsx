// web/src/auth/AuthField.tsx：鉴权 A2 Task 9′——auth 表单的原生字段。用原生 <input> 而非 Astryx
// TextInput，因为密码管理器契约（autocomplete username / current-password / new-password）不可
// 谈判，而 Astryx TextInput 不透传 autocomplete（见 design-recon）。label 用 <label htmlFor> 关联
// （无障碍 + 测试 getByLabelText 可命中）。password 字段附 show-password 切换（modern 实践）。
import { useState } from 'react'
import { useT } from '../i18n/useT.js'

interface Props {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'password'
  autoComplete: string
  autoFocus?: boolean
  hint?: string
  hintMet?: boolean
  inputRef?: React.Ref<HTMLInputElement>
}

export function AuthField({
  id, label, value, onChange, type = 'text', autoComplete, autoFocus, hint, hintMet, inputRef,
}: Props) {
  const { t } = useT()
  const [revealed, setRevealed] = useState(false)
  const isPassword = type === 'password'
  const effectiveType = isPassword && revealed ? 'text' : type
  const hintId = hint !== undefined ? `${id}-hint` : undefined

  return (
    <div className="auth-field">
      <label className="auth-field__label" htmlFor={id}>{label}</label>
      <div className="auth-field__input-wrap">
        <input
          id={id}
          ref={inputRef}
          // 密码框右侧给 show-password 钮留位（--pw 修饰加 padding-right），避免揭示后长文本压到钮下。
          className={`auth-field__input${isPassword ? ' auth-field__input--pw' : ''}`}
          type={effectiveType}
          value={value}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          // a11y：把长度规则等提示通过 aria-describedby 关联，屏幕阅读器聚焦时能听到（审计前端 #1）。
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.value)}
        />
        {isPassword && (
          <button
            type="button"
            className="auth-field__toggle"
            // 切换语义：aria-pressed 反映当前是否已揭示（审计前端 #2）。
            aria-pressed={revealed}
            aria-label={revealed ? t('auth_hide_password') : t('auth_show_password')}
            onClick={() => setRevealed((r) => !r)}
          >
            {revealed ? t('auth_hide_password') : t('auth_show_password')}
          </button>
        )}
      </div>
      {hint !== undefined && (
        <span id={hintId} className={`auth-field__hint${hintMet ? ' auth-field__hint--met' : ''}`}>{hint}</span>
      )}
    </div>
  )
}
