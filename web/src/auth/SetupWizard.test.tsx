import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SetupWizard } from './SetupWizard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function renderWizard(onDone = vi.fn()) {
  render(<I18nProvider><SetupWizard onDone={onDone} /></I18nProvider>)
  return onDone
}
const okJson = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as unknown as Response)

describe('SetupWizard（鉴权 A2 Task 9+9′：首启向导，单屏建管理员）', () => {
  it('渲染用户名/密码/确认三输入与提交钮', () => {
    renderWizard()
    expect(screen.getByLabelText(/username|用户名/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$|^密码$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/confirm|确认/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create account|创建账号/i })).toBeInTheDocument()
  })

  it('密码管理器契约：username=username / password=new-password / confirm=new-password', () => {
    renderWizard()
    expect(screen.getByLabelText(/username|用户名/i)).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText(/^password$|^密码$/i)).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText(/confirm|确认/i)).toHaveAttribute('autocomplete', 'new-password')
  })

  it('上手期长度提示存在，满足（≥10）时切 met class', () => {
    renderWizard()
    const hint = screen.getByText(/at least 10|至少 10/i)
    expect(hint.className).not.toContain('auth-field__hint--met')
    fireEvent.change(screen.getByLabelText(/^password$|^密码$/i), { target: { value: 'longenough10' } })
    expect(screen.getByText(/at least 10|至少 10/i).className).toContain('auth-field__hint--met')
  })

  it('两次密码不一致 → 前端拦截显示错误，不发请求', async () => {
    const mock = okJson(200, { ok: true, apiKey: 'x' })
    vi.stubGlobal('fetch', mock)
    renderWizard()
    fireEvent.change(screen.getByLabelText(/username|用户名/i), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText(/^password$|^密码$/i), { target: { value: 'hunter2222!!' } })
    fireEvent.change(screen.getByLabelText(/confirm|确认/i), { target: { value: 'different2222' } })
    fireEvent.click(screen.getByRole('button', { name: /create account|创建账号/i }))
    await screen.findByText(/do not match|不一致/i)
    expect(mock).not.toHaveBeenCalled()
  })

  it('提交成功 → 一次性展示 apiKey，点进入调 onDone', async () => {
    vi.stubGlobal('fetch', okJson(200, { ok: true, apiKey: 'a'.repeat(32) }))
    const onDone = renderWizard()
    fireEvent.change(screen.getByLabelText(/username|用户名/i), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText(/^password$|^密码$/i), { target: { value: 'hunter2222!!' } })
    fireEvent.change(screen.getByLabelText(/confirm|确认/i), { target: { value: 'hunter2222!!' } })
    fireEvent.click(screen.getByRole('button', { name: /create account|创建账号/i }))
    await screen.findByText('a'.repeat(32))
    fireEvent.click(screen.getByRole('button', { name: /continue to dashboard|进入仪表盘/i }))
    expect(onDone).toHaveBeenCalled()
  })

  it('apiKey 屏复制后，Continue 钮升为 primary（屏上唯一 lime 引导前进）——审计前端 #6', async () => {
    vi.stubGlobal('fetch', okJson(200, { ok: true, apiKey: 'a'.repeat(32) }))
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
    renderWizard()
    fireEvent.change(screen.getByLabelText(/username|用户名/i), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText(/^password$|^密码$/i), { target: { value: 'hunter2222!!' } })
    fireEvent.change(screen.getByLabelText(/confirm|确认/i), { target: { value: 'hunter2222!!' } })
    fireEvent.click(screen.getByRole('button', { name: /create account|创建账号/i }))
    const cont = await screen.findByRole('button', { name: /continue to dashboard|进入仪表盘/i })
    // shadcn Button 不写 data-variant（Astryx 才写）——改锁 cva 类名：复制前 Continue 是 secondary 面
    expect(cont).toHaveClass('bg-secondary')
    fireEvent.click(screen.getByRole('button', { name: /^copy$|^复制$/i }))
    await screen.findByRole('button', { name: /copied|已复制/i })
    // 复制后 Continue 升为 primary 面
    expect(screen.getByRole('button', { name: /continue to dashboard|进入仪表盘/i })).toHaveClass('bg-primary')
  })

  it('服务端 400（密码太短等）→ 错误行内展示', async () => {
    vi.stubGlobal('fetch', okJson(400, { error: 'password must be at least 10 characters' }))
    renderWizard()
    fireEvent.change(screen.getByLabelText(/username|用户名/i), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText(/^password$|^密码$/i), { target: { value: 'shortpw1234' } })
    fireEvent.change(screen.getByLabelText(/confirm|确认/i), { target: { value: 'shortpw1234' } })
    fireEvent.click(screen.getByRole('button', { name: /create account|创建账号/i }))
    await screen.findByText(/at least 10/i)
  })
})

// ── 迁移锁（Astryx → shadcn，Plan C Task 30）────────────────────────────────
describe('SetupWizard：迁移锁', () => {
  it('DOM 里不再有 astryx-* 类名', () => {
    renderWizard()
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
