// web/src/api/client.test.ts：get() 失败时的错误消息抽取——R2D-8（R2 复审）：get() 此前从不解析
// 失败响应体，即使后端给出了人话消息（如 listMediaSubdirs 的 "path is not readable (permission
// denied?)"），调用方也只能看到裸的 "path → status"。这里锁住 get() 现在照 mutate() 的既有手法
// 抽取 `{error: string}` 字段；抽不出来（响应体不是 JSON、或没有 error 字段）时回落 "path →
// status"，不炸调用方。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { api, backdropUrl, stillUrl, heroPosterUrl, posterUrl, setTmdbImageBase } from './client.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // setTmdbImageBase 是模块级状态——测试间必须复位，否则本文件里先跑的模板用例会把
  // 后跑的"默认直连"断言染成模板 URL。
  setTmdbImageBase(null)
})

describe('backdropUrl / stillUrl（详情页 hero + 逐集剧照 CDN 拼接）', () => {
  it('backdrop 用 w1280、still 用 w300；null → null', () => {
    expect(backdropUrl('/bd.jpg')).toBe('https://image.tmdb.org/t/p/w1280/bd.jpg')
    expect(stillUrl('/s.jpg')).toBe('https://image.tmdb.org/t/p/w300/s.jpg')
    expect(backdropUrl(null)).toBeNull()
    expect(stillUrl(null)).toBeNull()
  })

  it('heroPosterUrl：裸路径拼 w780；完整 URL 透传（demo 假数据形态）；null → null', () => {
    expect(heroPosterUrl('/p.jpg')).toBe('https://image.tmdb.org/t/p/w780/p.jpg')
    expect(heroPosterUrl('https://image.tmdb.org/t/p/w342/p.jpg')).toBe('https://image.tmdb.org/t/p/w342/p.jpg')
    expect(heroPosterUrl(null)).toBeNull()
  })
})

// TMDB 大陆可达线（2026-08-30）：图片基址可配。部署层 env TMDB_IMAGE_BASE_URL 经
// GET /api/v2/auth/status 下发，useAuthStatus 收到即喂 setTmdbImageBase。三形态语义
// README env 表已写死（照实现）：null=现状 image.tmdb.org 直连；含 {path}=整体模板替换
// （{path} = /t/p/w400/xx.jpg 完整路径段，wsrv.nl 包装式）；否则=前缀替换（自建反代域）。
describe('setTmdbImageBase（图片基址三形态）', () => {
  it('null（未配置/复位）→ 现状 image.tmdb.org 直连', () => {
    setTmdbImageBase(null)
    expect(posterUrl('/p.jpg')).toBe('https://image.tmdb.org/t/p/w400/p.jpg')
    expect(backdropUrl('/bd.jpg')).toBe('https://image.tmdb.org/t/p/w1280/bd.jpg')
  })

  it('前缀形态 → 替换 https://image.tmdb.org、保留 /t/p/wXXX 路径段；尾斜杠去掉防双斜杠', () => {
    setTmdbImageBase('https://tmdb.example.com')
    expect(posterUrl('/p.jpg')).toBe('https://tmdb.example.com/t/p/w400/p.jpg')
    expect(backdropUrl('/bd.jpg')).toBe('https://tmdb.example.com/t/p/w1280/bd.jpg')
    expect(stillUrl('/s.jpg')).toBe('https://tmdb.example.com/t/p/w300/s.jpg')
    expect(heroPosterUrl('/p.jpg')).toBe('https://tmdb.example.com/t/p/w780/p.jpg')
    setTmdbImageBase('https://tmdb.example.com/')
    expect(posterUrl('/p.jpg')).toBe('https://tmdb.example.com/t/p/w400/p.jpg')
  })

  it('模板形态（含 {path}）→ 整体替换，{path} 是含尺寸段的完整路径（wsrv.nl 实例）', () => {
    setTmdbImageBase('https://wsrv.nl/?url=https://image.tmdb.org{path}')
    expect(posterUrl('/p.jpg')).toBe('https://wsrv.nl/?url=https://image.tmdb.org/t/p/w400/p.jpg')
    expect(backdropUrl('/bd.jpg')).toBe('https://wsrv.nl/?url=https://image.tmdb.org/t/p/w1280/bd.jpg')
    expect(stillUrl('/s.jpg')).toBe('https://wsrv.nl/?url=https://image.tmdb.org/t/p/w300/s.jpg')
  })

  it('demo 完整 URL 形态在模板配置下仍透传（短路在模板替换之前）；null path 恒 null；空串视同未配置', () => {
    setTmdbImageBase('https://wsrv.nl/?url=https://image.tmdb.org{path}')
    expect(heroPosterUrl('https://image.tmdb.org/t/p/w342/p.jpg')).toBe('https://image.tmdb.org/t/p/w342/p.jpg')
    expect(posterUrl(null)).toBeNull()
    setTmdbImageBase('')
    expect(posterUrl('/p.jpg')).toBe('https://image.tmdb.org/t/p/w400/p.jpg')
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
    await expect(api.mediaLibrary()).rejects.toThrow('path is not readable (permission denied?)')
  })

  it('响应体不是 JSON（解析失败）时回落 "path → status"，不炸调用方', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false, status: 500, json: async () => { throw new Error('not json') },
      }) as unknown as Response),
    )
    await expect(api.mediaLibrary()).rejects.toThrow('/api/v2/mediaLibrary → 500')
  })

  it('响应体是 JSON 但没有 error 字段时同样回落 "path → status"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ notError: 'x' }) }) as unknown as Response),
    )
    await expect(api.mediaLibrary()).rejects.toThrow('/api/v2/mediaLibrary → 404')
  })

  it('401 → 给"请重新登录"人话提示,而不是裸 path → 401 / unauthorized（鉴权 A2：token 时代退役）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => null }) as unknown as Response),
    )
    await expect(api.mediaLibrary()).rejects.toThrow(/登录/)
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

describe('client.ts 启动面方法（spec A §4.4 线形）', () => {
  it('validateSetup 带 credentials 时请求体原样透传（"先测后存"的落库裁决在服务端，这里只锁线形）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true, detail: 'connected' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const r = await api.validateSetup('tmdb', { TMDB_API_KEY: 'k' })
    expect(r).toEqual({ ok: true, detail: 'connected' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url).startsWith('/api/v2/setup/validate')).toBe(true)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ target: 'tmdb', credentials: { TMDB_API_KEY: 'k' } })
  })

  it('validateSetup 省略 credentials 时请求体只有 target（测已解析 env/db 凭据）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await api.validateSetup('subhd')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ target: 'subhd' })
  })

  it('putSecret 走 PUT /api/v2/settings/secrets（空值=删除的语义裁决同样在服务端）', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true, name: 'ASSRT_TOKEN', action: 'deleted' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const r = await api.putSecret('ASSRT_TOKEN', '')
    expect(r).toEqual({ ok: true, name: 'ASSRT_TOKEN', action: 'deleted' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url).startsWith('/api/v2/settings/secrets')).toBe(true)
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ name: 'ASSRT_TOKEN', value: '' })
  })

  it('setupStatus / setupProviders 路径正确、走 get（失败响应也吃 errorMessage 抽取）', async () => {
    const fetchMock = vi.fn(async () => ({
      // **故意用 500、不用 401**：`client.ts:58-70` 的 errorMessage 对 401 有硬编码中文兜底
      //（`return '会话未授权或已失效，请重新登录'`，早于 body.error 抽取 return），
      // 走 401 这条用例永远拿不到 'unauthorized'，下面的 rejects.toThrow 必红。
      ok: false, status: 500, json: async () => ({ error: 'unauthorized' }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.setupStatus()).rejects.toThrow('unauthorized')
    expect(String((fetchMock.mock.calls[0] as unknown[])[0]).startsWith('/api/v2/setup/status')).toBe(true)
  })

  it('🔴 triggerScan 打的是 /api/v2/library/scan 且用 POST（这条 URL 此前零覆盖）', async () => {
    // ── 来历 ────────────────────────────────────────────────────────────────
    // 端点裁决那一轮把 11 条端点里的 10 条判为"无活 UI"，`/api/v2/library/scan` 是**唯一活的**
    //（AppShell settings → SettingsTabsPage → RootsManager → scanDebouncer → 这里）。
    // 但变异实测：把这里的 URL 改成 `/api/v2/WRONG/scan`，前端 1287 条用例**无一变红**——
    // scanDebouncer.test.ts 测的是防抖时序，`triggerScan` 是注入的 mock，**碰不到真实 URL**。
    // 线上后果：用户加完守备目录后永远不会自动扫描，且**静默无声**（POST 打到 404 被吞）。
    //
    // ⚠️ 这条 URL 的名字里带 `library`，而同批被删的三条端点（/api/v2/library、
    // library/series/:id、library/movies/:id）**同前缀**——下一轮清理的人极易顺手带走它。
    // 判据是"链断没断"，不是"名字里有没有 library"。
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await api.triggerScan()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('/api/v2/library/scan')
    expect(init.method).toBe('POST')
  })

  it('🔴 triggerInspect 打的是 /api/v2/library/inspect 且用 POST', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    await api.triggerInspect()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('/api/v2/library/inspect')
    expect(init.method).toBe('POST')
  })
})
