// web/src/auth/useAuthStatus.test.tsx：TMDB 大陆可达线（2026-08-30）——auth/status 是
// tmdbImageBase 的下发管道（AuthGate 首载必拉、三态都可达），本 hook 收到 status 即喂
// client.setTmdbImageBase。这里锁的是**接线**（拿到即生效/null 即复位），三形态语义本身
// 在 api/client.test.ts。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { useAuthStatus } from './useAuthStatus.js'
import { posterUrl, setTmdbImageBase } from '../api/client.js'
import type { AuthStatusDTO } from '../api/types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setTmdbImageBase(null) // 模块级状态，测试间复位
})

function stubAuthStatus(body: AuthStatusDTO) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response),
  )
}

describe('useAuthStatus × tmdbImageBase 接线', () => {
  it('status.tmdbImageBase 非 null → 图片 URL 改走模板', async () => {
    stubAuthStatus({
      initialized: true, authenticated: true,
      tmdbImageBase: 'https://wsrv.nl/?url=https://image.tmdb.org{path}',
    })
    const { result } = renderHook(() => useAuthStatus())
    await waitFor(() => expect(result.current.status).not.toBeNull())
    expect(posterUrl('/p.jpg')).toBe('https://wsrv.nl/?url=https://image.tmdb.org/t/p/w400/p.jpg')
  })

  it('tmdbImageBase: null → 维持直连（且清掉先前残值——重探拿到 null 不能沿用旧模板）', async () => {
    setTmdbImageBase('https://tmdb.example.com')
    stubAuthStatus({ initialized: true, authenticated: false, tmdbImageBase: null })
    const { result } = renderHook(() => useAuthStatus())
    await waitFor(() => expect(result.current.status).not.toBeNull())
    expect(posterUrl('/p.jpg')).toBe('https://image.tmdb.org/t/p/w400/p.jpg')
  })
})
