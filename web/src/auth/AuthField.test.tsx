import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { AuthField } from './AuthField.js'

afterEach(cleanup)

const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>)

describe('AuthField（鉴权 A2 Task 9′：承载密码管理器契约 + show-password 的原生字段）', () => {
  it('label 关联 input（getByLabelText 可命中），autocomplete 透传到原生 input', () => {
    wrap(<AuthField id="u" label="Username" value="" onChange={() => {}} autoComplete="username" />)
    const input = screen.getByLabelText('Username')
    expect(input).toHaveAttribute('autocomplete', 'username')
    expect(input).toHaveAttribute('type', 'text')
  })

  it('password 类型 + show-password 切换：点击后 type 从 password 变 text', () => {
    wrap(<AuthField id="p" label="Password" value="secret" onChange={() => {}} type="password" autoComplete="new-password" />)
    const input = screen.getByLabelText('Password')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveAttribute('autocomplete', 'new-password')
    fireEvent.click(screen.getByRole('button', { name: /show password|显示密码/i }))
    expect(input).toHaveAttribute('type', 'text')
    fireEvent.click(screen.getByRole('button', { name: /hide password|隐藏密码/i }))
    expect(input).toHaveAttribute('type', 'password')
  })

  it('非 password 字段不渲染 show-password 切换钮', () => {
    wrap(<AuthField id="u" label="Username" value="" onChange={() => {}} autoComplete="username" />)
    expect(screen.queryByRole('button', { name: /show password|显示密码/i })).not.toBeInTheDocument()
  })

  it('onChange 收到输入的新值', () => {
    const onChange = vi.fn()
    wrap(<AuthField id="u" label="Username" value="" onChange={onChange} autoComplete="username" />)
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } })
    expect(onChange).toHaveBeenCalledWith('admin')
  })

  it('hint 通过 aria-describedby 关联到 input（屏幕阅读器听得到密码规则）', () => {
    wrap(<AuthField id="p" label="Password" value="" onChange={() => {}} type="password" autoComplete="new-password" hint="min 10" hintMet={false} />)
    const input = screen.getByLabelText('Password')
    expect(input).toHaveAttribute('aria-describedby', 'p-hint')
    expect(screen.getByText('min 10')).toHaveAttribute('id', 'p-hint')
  })

  it('无 hint 时 input 不带 aria-describedby', () => {
    wrap(<AuthField id="u" label="Username" value="" onChange={() => {}} autoComplete="username" />)
    expect(screen.getByLabelText('Username')).not.toHaveAttribute('aria-describedby')
  })

  it('show-password 切换钮带 aria-pressed 反映开合态', () => {
    wrap(<AuthField id="p" label="Password" value="x" onChange={() => {}} type="password" autoComplete="new-password" />)
    const toggle = screen.getByRole('button', { name: /show password|显示密码/i })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: /hide password|隐藏密码/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('hint 满足态切 class（met）', () => {
    const { rerender } = wrap(
      <AuthField id="p" label="Password" value="short" onChange={() => {}} type="password" autoComplete="new-password" hint="min 10" hintMet={false} />,
    )
    expect(screen.getByText('min 10').className).not.toContain('auth-field__hint--met')
    rerender(<I18nProvider><AuthField id="p" label="Password" value="longenough!!" onChange={() => {}} type="password" autoComplete="new-password" hint="min 10" hintMet /></I18nProvider>)
    expect(screen.getByText('min 10').className).toContain('auth-field__hint--met')
  })
})
