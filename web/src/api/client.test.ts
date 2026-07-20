// web/src/api/client.test.ts：get() 失败时的错误消息抽取——R2D-8（R2 复审）：get() 此前从不解析
// 失败响应体，即使后端给出了人话消息（如 listMediaSubdirs 的 "path is not readable (permission
// denied?)"），调用方也只能看到裸的 "path → status"。这里锁住 get() 现在照 mutate() 的既有手法
// 抽取 `{error: string}` 字段；抽不出来（响应体不是 JSON、或没有 error 字段）时回落 "path →
// status"，不炸调用方。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { api, backdropUrl, stillUrl } from './client.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('backdropUrl / stillUrl（详情页 hero + 逐集剧照 CDN 拼接）', () => {
  it('backdrop 用 w1280、still 用 w300；null → null', () => {
    expect(backdropUrl('/bd.jpg')).toBe('https://image.tmdb.org/t/p/w1280/bd.jpg')
    expect(stillUrl('/s.jpg')).toBe('https://image.tmdb.org/t/p/w300/s.jpg')
    expect(backdropUrl(null)).toBeNull()
    expect(stillUrl(null)).toBeNull()
  })
})

describe('client.ts get() 失败时的错误消息', () => {
  it('响应体带 {error} 字段时抛出那条人话消息（不是裸的 path → status）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false, status: 400, json: async () => ({ error: 'path is not readable (permission denied?)' }),
      }) as unknown as Response),
    )
    await expect(api.fsList('/mnt/locked')).rejects.toThrow('path is not readable (permission denied?)')
  })

  it('响应体不是 JSON（解析失败）时回落 "path → status"，不炸调用方', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false, status: 500, json: async () => { throw new Error('not json') },
      }) as unknown as Response),
    )
    await expect(api.fsList('/mnt/x')).rejects.toThrow('/api/v2/fs/list?path=%2Fmnt%2Fx → 500')
  })

  it('响应体是 JSON 但没有 error 字段时同样回落 "path → status"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ notError: 'x' }) }) as unknown as Response),
    )
    await expect(api.fsList('/mnt/y')).rejects.toThrow('/api/v2/fs/list?path=%2Fmnt%2Fy → 404')
  })

  it('401 → 给"请重新登录"人话提示,而不是裸 path → 401 / unauthorized（鉴权 A2：token 时代退役）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => null }) as unknown as Response),
    )
    await expect(api.library()).rejects.toThrow(/登录/)
  })
})

// 鉴权 A2 Task 8：api client auth 端点 + 全局 401 事件。App 层鉴权门（useAuthStatus）监听
// scout:unauthorized——任意请求撞 401（会话过期/登出）即触发一次 auth/status 重探，自动切回
// LoginPage，无需每个 hook 各自处理 401。
describe('auth api（A2 Task 8）', () => {
  it('authStatus 打 GET /api/v2/auth/status', async () => {
    const mock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ initialized: true, authenticated: false }) }) as unknown as Response)
    vi.stubGlobal('fetch', mock)
    const r = await api.authStatus()
    expect(r).toEqual({ initialized: true, authenticated: false })
    expect(String((mock.mock.calls[0] as unknown[])[0])).toBe('/api/v2/auth/status')
  })

  it('login 打 POST /api/v2/auth/login 带 JSON body', async () => {
    const mock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response)
    vi.stubGlobal('fetch', mock)
    await api.login('admin', 'pw')
    const [path, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/v2/auth/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ username: 'admin', password: 'pw' })
  })

  it('任何请求 401 → 派发 scout:unauthorized 全局事件（App 门据此切回 login）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }) as unknown as Response))
    const seen = vi.fn()
    window.addEventListener('scout:unauthorized', seen)
    await expect(api.settings()).rejects.toThrow()
    expect(seen).toHaveBeenCalledTimes(1)
    window.removeEventListener('scout:unauthorized', seen)
  })
})
