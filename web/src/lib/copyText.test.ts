// web/src/lib/copyText.test.ts：copyText 三态——现代 clipboard / execCommand 兜底 / 双失败。
// 起因（2026-08-29 NAS 实测）：LAN 纯 http 访问（如 http://192.168.1.x:8099）是非安全上下文，
// navigator.clipboard === undefined，旧代码 catch 后静默 → 用户看到"复制按钮点不动"。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './copyText.js'

afterEach(() => {
  vi.unstubAllGlobals()
  // execCommand 是我们手动挂的，测试间清干净
  delete (document as { execCommand?: unknown }).execCommand
})

describe('copyText（http 环境剪贴板兜底）', () => {
  it('clipboard API 可用 → 走它，resolve true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    await expect(copyText('k')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('k')
  })

  it('🔴 clipboard 不存在（http LAN）→ execCommand("copy") 兜底，resolve true', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const exec = vi.fn().mockReturnValue(true)
    ;(document as { execCommand?: unknown }).execCommand = exec
    await expect(copyText('a78a6a')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    // 兜底用的临时 textarea 不许留在 DOM 里
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('🔴 双通道皆不可用 → resolve false（调用方给可见反馈，绝不静默）', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    ;(document as { execCommand?: unknown }).execCommand = vi.fn().mockReturnValue(false)
    await expect(copyText('k')).resolves.toBe(false)
  })
})
