import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { LoginPage } from './LoginPage.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const wrap = (onDone = vi.fn()) => {
  render(<I18nProvider><LoginPage onDone={onDone} /></I18nProvider>)
  return onDone
}
const resp = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as unknown as Response)

describe('LoginPage（鉴权 A2 Task 10+10′）', () => {
  it('密码管理器契约：username=username / password=current-password', () => {
    wrap()
    expect(screen.getByLabelText(/username|用户名/i)).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText(/^password$|^密码$/i)).toHaveAttribute('autocomplete', 'current-password')
  })

  it('提交成功 → onDone', async () => {
    vi.stubGlobal('fetch', resp(200, { ok: true }))
    const onDone = wrap()
    fireEvent.change(screen.getByLabelText(/username|用户名/i), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText(/^password$|^密码$/i), { target: { value: 'hunter2222!!' } })
    fireEvent.click(screen.getByRole('button', { name: /log in|登录/i }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('401 → 精确文案 "Incorrect username or password."，保留 username、清空 password', async () => {
    vi.stubGlobal('fetch', resp(401, { error: 'invalid username or password' }))
    wrap()
    const u = screen.getByLabelText(/username|用户名/i) as HTMLInputElement
    const p = screen.getByLabelText(/^password$|^密码$/i) as HTMLInputElement
    fireEvent.change(u, { target: { value: 'admin' } })
    fireEvent.change(p, { target: { value: 'wrong-pass' } })
    fireEvent.click(screen.getByRole('button', { name: /log in|登录/i }))
    await screen.findByText(/incorrect username or password|用户名或密码不正确/i)
    expect(u.value).toBe('admin')
    expect(p.value).toBe('')
  })

  it('传输失败（fetch reject）→ "Can\'t reach the server." 变体', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    wrap()
    fireEvent.change(screen.getByLabelText(/username|用户名/i), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText(/^password$|^密码$/i), { target: { value: 'hunter2222!!' } })
    fireEvent.click(screen.getByRole('button', { name: /log in|登录/i }))
    await screen.findByText(/can't reach the server|无法连接服务器/i)
  })

  it('底部有找回密码提示，含真实 CLI 命令 subtitle-scout auth reset', () => {
    wrap()
    expect(screen.getByText(/subtitle-scout auth reset/)).toBeInTheDocument()
  })
})

// ── 迁移锁（Astryx → shadcn，Plan C Task 30）────────────────────────────────
describe('LoginPage：迁移锁', () => {
  it('DOM 里不再有 astryx-* 类名', () => {
    wrap()
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
