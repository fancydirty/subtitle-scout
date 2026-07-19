// web/src/api/client.test.ts：get() 失败时的错误消息抽取——R2D-8（R2 复审）：get() 此前从不解析
// 失败响应体，即使后端给出了人话消息（如 listMediaSubdirs 的 "path is not readable (permission
// denied?)"），调用方也只能看到裸的 "path → status"。这里锁住 get() 现在照 mutate() 的既有手法
// 抽取 `{error: string}` 字段；抽不出来（响应体不是 JSON、或没有 error 字段）时回落 "path →
// status"，不炸调用方。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { api } from './client.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

  it('401 → 给可操作的"加 ?token="人话提示,而不是裸 path → 401 / unauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => null }) as unknown as Response),
    )
    await expect(api.library()).rejects.toThrow(/\?token=/)
  })
})
