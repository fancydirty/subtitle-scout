import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { Sidebar } from './Sidebar.js'
import { UNAUTHORIZED_EVENT } from '../api/client.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const wrap = () => render(<I18nProvider><Sidebar tab="library" parked={undefined} /></I18nProvider>)

describe('Sidebar 登出入口（鉴权 A2 Task 14）', () => {
  it('渲染登出钮', () => {
    wrap()
    expect(screen.getByRole('button', { name: /log out|登出|退出/i })).toBeInTheDocument()
  })

  it('点击登出 → POST /api/v2/auth/logout 并派发 scout:unauthorized（App 门据此切回 login）', async () => {
    const mock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response)
    vi.stubGlobal('fetch', mock)
    const seen = vi.fn()
    window.addEventListener(UNAUTHORIZED_EVENT, seen)
    wrap()
    fireEvent.click(screen.getByRole('button', { name: /log out|登出|退出/i }))
    await waitFor(() => {
      const [path, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
      expect(path).toBe('/api/v2/auth/logout')
      expect(init.method).toBe('POST')
    })
    await waitFor(() => expect(seen).toHaveBeenCalled())
    window.removeEventListener(UNAUTHORIZED_EVENT, seen)
  })

  it('登出 POST 失败（网络错）也照样派发事件（finally）——服务器宕了仍切回 login，不卡死', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const seen = vi.fn()
    window.addEventListener(UNAUTHORIZED_EVENT, seen)
    wrap()
    fireEvent.click(screen.getByRole('button', { name: /log out|登出|退出/i }))
    await waitFor(() => expect(seen).toHaveBeenCalled())
    window.removeEventListener(UNAUTHORIZED_EVENT, seen)
  })
})

// Plan C Task 28 迁移锁（自绘 SideNav 换 Astryx SideNav）——以下三条只追加、不改上面的存量。
describe('Sidebar 迁移锁（Task 28：自绘 SideNav）', () => {
  it('选中项带 aria-current="page"，未选中项没有——选中态语义锚点（不再是 data-selected）', () => {
    wrap() // tab="library"
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Workflow' })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current')
  })

  it('甄别角标计数渲染在 Triage 链接内（parked=7 → 可及名 "Triage 7"）', () => {
    render(<I18nProvider><Sidebar tab="library" parked={7} /></I18nProvider>)
    const triage = screen.getByRole('link', { name: /^Triage/ })
    expect(triage).toHaveTextContent('7')
  })

  it('子树不再有任何 astryx 类名——自绘件不输出 .astryx-* DOM', () => {
    const { container } = wrap()
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
  })
})
