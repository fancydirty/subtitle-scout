import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SecuritySection } from './SecuritySection.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const wrap = () => render(<I18nProvider><SecuritySection /></I18nProvider>)

describe('SecuritySection（鉴权 A3 Task 13）', () => {
  it('展示 username 与脱敏 api key（••+尾4位），有复制与重生成钮', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ username: 'admin', apiKey: 'a'.repeat(28) + 'beef' }) }) as unknown as Response))
    wrap()
    await screen.findByText('admin')
    expect(screen.getByText(/beef$/)).toBeInTheDocument()
    expect(screen.queryByText('a'.repeat(28) + 'beef')).not.toBeInTheDocument() // 不整串明示
    expect(screen.getByRole('button', { name: /copy|复制/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /regenerate|重新生成/i })).toBeInTheDocument()
  })

  it('改密表单：新旧密码提交 → POST change-password；400 错误行内展示', async () => {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      return url.includes('/auth/security')
        ? { ok: true, status: 200, json: async () => ({ username: 'admin', apiKey: 'k'.repeat(32) }) } as unknown as Response
        : { ok: false, status: 400, json: async () => ({ error: 'current password is incorrect' }) } as unknown as Response
    })
    vi.stubGlobal('fetch', mock)
    wrap()
    await screen.findByText('admin')
    fireEvent.change(screen.getByLabelText(/current password|当前密码/i), { target: { value: 'oldpass1234' } })
    fireEvent.change(screen.getByLabelText(/new password|新密码/i), { target: { value: 'newpass8888' } })
    fireEvent.click(screen.getByRole('button', { name: /change password|修改密码/i }))
    await screen.findByText(/incorrect|不正确/i)
  })

  it('重生成：点钮开 AlertDialog（陈述爆炸半径），确认后 POST，新尾 4 位上屏（审计前端 #5：不用 window.confirm）', async () => {
    let regenerated = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('regenerate-api-key')) { regenerated = true; return { ok: true, status: 200, json: async () => ({ apiKey: 'b'.repeat(28) + 'cafe' }) } as unknown as Response }
      return { ok: true, status: 200, json: async () => ({ username: 'admin', apiKey: 'a'.repeat(28) + 'beef' }) } as unknown as Response
    }))
    wrap()
    await screen.findByText(/beef$/)
    fireEvent.click(screen.getByRole('button', { name: /regenerate|重新生成/i }))
    // AlertDialog 打开且陈述爆炸半径（立即失效/客户端会失败）
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(/立即失效|stops working immediately/i)
    fireEvent.click(within(dialog).getByRole('button', { name: /regenerate|重新生成/i }))
    await screen.findByText(/cafe$/)
    expect(regenerated).toBe(true)
  })

  it('重生成 AlertDialog 取消 → 不发请求', async () => {
    let regenerated = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('regenerate-api-key')) { regenerated = true }
      return { ok: true, status: 200, json: async () => ({ username: 'admin', apiKey: 'a'.repeat(28) + 'beef' }) } as unknown as Response
    }))
    wrap()
    await screen.findByText(/beef$/)
    fireEvent.click(screen.getByRole('button', { name: /regenerate|重新生成/i }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel|取消/i }))
    expect(regenerated).toBe(false)
  })
})

describe('SecuritySection：迁移锁', () => {
  it('DOM 里不再有 astryx-* 类名', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ username: 'admin', apiKey: 'a'.repeat(28) + 'beef' }) }) as unknown as Response))
    wrap()
    await screen.findByText('admin')
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
