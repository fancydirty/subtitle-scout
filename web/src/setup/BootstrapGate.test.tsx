// web/src/setup/BootstrapGate.test.tsx：gate 五态——loading 先露 children（不闪 wizard）；
// bootstrapComplete=false → wizard 接管；true / 拉取失败 → children（fail-open）；
// sessionStorage rerun 标记 → 强制 wizard 且一次性消费；onComplete 契约——必须作为函数
// 传进 wizard（硬刷新本体 jsdom 探不了，钉"传了函数"这层）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { api } from '../api/client.js'
import type { SetupStatusDTO } from '../api/types.js'
import { BootstrapGate } from './BootstrapGate.js'
import { BootstrapWizard } from './BootstrapWizard.js'

// wizard 本体打桩——gate 只验证触发与 props 传递，七步行为有 Task 16-22 各自的测试在看。
vi.mock('./BootstrapWizard.js', () => ({
  BootstrapWizard: vi.fn(({ rerun }: { rerun: boolean }) => (
    <div data-testid="wizard" data-rerun={String(rerun)} />
  )),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

function status(over: Partial<SetupStatusDTO> = {}): SetupStatusDTO {
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
    engineEnabled: true,
    ...over,
  }
}

function renderGate() {
  return render(
    <BootstrapGate>
      <div data-testid="shell" />
    </BootstrapGate>,
  )
}

describe('BootstrapGate', () => {
  it('status 加载中 → 先露 children，不闪 wizard', async () => {
    vi.spyOn(api, 'setupStatus').mockReturnValue(new Promise(() => {}))
    renderGate()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.getByTestId('shell')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument()
  })

  it('bootstrapComplete=true → 渲染 children，无 wizard', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status())
    renderGate()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.getByTestId('shell')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument()
  })

  it('bootstrapComplete=false → wizard 接管，children 不渲染', async () => {
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status({ bootstrapComplete: false }))
    renderGate()
    expect(await screen.findByTestId('wizard')).toBeInTheDocument()
    expect(screen.queryByTestId('shell')).not.toBeInTheDocument()
  })

  it('status 拉取失败 → 渲染 children（fail-open：探测失败不许锁死主界面）', async () => {
    vi.spyOn(api, 'setupStatus').mockRejectedValue(new Error('network'))
    renderGate()
    await waitFor(() => expect(api.setupStatus).toHaveBeenCalled())
    expect(screen.getByTestId('shell')).toBeInTheDocument()
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument()
  })

  it('sessionStorage rerun 标记 → 即使 bootstrapComplete=true 也进 wizard（rerun=true），标记一次性消费', async () => {
    // 这里故意写死字面量而不 import RERUN_WIZARD_KEY：测试要钉住的就是"key 是这个字符串"
    // ——用常量对拍会变成自证（改了常量测试跟着改，跨会话的死链照样溜过去）。
    sessionStorage.setItem('scout-rerun-wizard', '1')
    vi.spyOn(api, 'setupStatus').mockResolvedValue(status())
    renderGate()
    const wizard = await screen.findByTestId('wizard')
    expect(wizard.dataset.rerun).toBe('true')
    expect(sessionStorage.getItem('scout-rerun-wizard')).toBeNull()
    // onComplete 契约钉住：jsdom spy 不了 location.reload 本体，钉"gate 把函数传进了 wizard"
    // 这层——硬刷新是 impl 侧一行的事实，传没传、传的是不是函数由这里守。
    const wizMock = vi.mocked(BootstrapWizard)
    expect(wizMock.mock.calls[0][0].onComplete).toBeTypeOf('function')
  })
})
