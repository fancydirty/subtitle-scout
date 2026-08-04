// web/src/shell/EngineBanner.test.tsx：引擎关闭 banner——仅 engineEnabled=false 渲染；
// Turn on 快捷 PUT 同键 + reload 刷新；status 加载中/拉取失败 → 不渲染（fail-open，
// 不可误报"引擎已关"）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { SetupStatusDTO } from '../api/types.js'
import { EngineBanner } from './EngineBanner.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function status(engineEnabled: boolean): SetupStatusDTO {
  return {
    bootstrapComplete: true,
    tmdb: { satisfied: true, source: 'env', masked: null },
    llm: { satisfied: true, source: 'env', model: null },
    providers: {
      assrt: { satisfied: false, source: 'none', masked: null },
      opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
      jimaku: { satisfied: false, source: 'none', masked: null },
      subhd: { enabled: false, source: 'none' },
      zimuku: { enabled: false, source: 'none', captchaReady: false },
    },
    roots: { count: 1 },
    engineEnabled,
  }
}

function renderBanner() {
  return render(<I18nProvider initialLang="en"><EngineBanner /></I18nProvider>)
}

describe('EngineBanner', () => {
  it('engineEnabled=false → 渲染细条 + Turn on', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status(false))
    renderBanner()
    expect(await screen.findByText('Engine off — polling and dispatch are paused.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument()
  })

  it('Turn on → PUT { engine_enabled: "true" } → reload 后 banner 消失', async () => {
    // 两段桩：第一次拉取给"引擎关"（banner 出现），Turn on 之后的 reload 给"引擎开"（banner 撤）。
    // 若整场都桩 status(false)，reload 拿回来的还是"关"，banner 永远不会消失——最后那个
    // waitFor 会一直等到超时，测试红得莫名。
    vi.spyOn(api, 'setupStatus')
      .mockResolvedValueOnce(status(false))
      .mockResolvedValue(status(true))
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    renderBanner()
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ engine_enabled: 'true' }))
    await waitFor(() =>
      expect(screen.queryByText('Engine off — polling and dispatch are paused.')).not.toBeInTheDocument(),
    )
  })

  it('engineEnabled=true → 不渲染', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status(true))
    renderBanner()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.queryByText(/Engine off/)).not.toBeInTheDocument()
  })

  it('status 拉取失败 → 不渲染（fail-open）', async () => {
    vi.spyOn(api, 'setupStatus').mockRejectedValue(new Error('network'))
    renderBanner()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.queryByText(/Engine off/)).not.toBeInTheDocument()
  })

  it('Turn on PUT 失败 → 行内错误文案 + banner 不消 + 按钮复活（不静默）', async () => {
    // setupStatus 恒给"关"：PUT 失败没有 reload 的理由，banner 必须留在原地。
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status(false))
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new Error('boom'))
    renderBanner()
    const btn = await screen.findByRole('button', { name: 'Turn on' })
    fireEvent.click(btn)
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    expect(screen.getByText('Engine off — polling and dispatch are paused.')).toBeInTheDocument()
    await waitFor(() => expect(btn).toBeEnabled())
  })
})
