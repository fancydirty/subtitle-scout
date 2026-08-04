// web/src/setup/steps/StepProviders.test.tsx：步 4 软门禁——各测各的、红不拦路、只存绿的；
// 零绿时 Save 禁用走 Skip；OS 用户名密码成对才存；env 满足家锁定零输入。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { api } from '../../api/client.js'
import type { SetupStatusDTO } from '../../api/types.js'
import { StepProviders } from './StepProviders.js'
import type { WizardStepProps } from './types.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const BASE: SetupStatusDTO = {
  bootstrapComplete: false,
  tmdb: { satisfied: true, source: 'db', masked: null },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: false, source: 'none', masked: null },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: true, source: 'db', captchaReady: true },
  },
  roots: { count: 0 },
  engineEnabled: true,
}

function props(over: Partial<WizardStepProps> = {}): WizardStepProps {
  return {
    status: BASE, patchStatus: () => {}, rerun: false,
    onAdvance: () => {}, onBack: () => {}, onComplete: () => {}, ...over,
  }
}

function renderStep(over: Partial<WizardStepProps> = {}) {
  return render(<I18nProvider initialLang="en"><StepProviders {...props(over)} /></I18nProvider>)
}

describe('StepProviders', () => {
  it('横幅与保存说明在；初始零绿 → Save 禁用；Skip 直接走', () => {
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    expect(screen.getByText(/subhd and zimuku are built-in free sources/)).toBeInTheDocument()
    expect(screen.getByText(/Only keys that pass the test are saved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Skip this step' }))
    expect(onAdvance).toHaveBeenCalledTimes(1)
  })

  it('ASSRT 测绿 → Save 解锁；Save 只 PUT  ASSRT_TOKEN', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    const block = within(screen.getByTestId('provider-assrt'))
    fireEvent.change(block.getByLabelText('ASSRT token'), { target: { value: 'at-1' } })
    fireEvent.click(block.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([['ASSRT_TOKEN', 'at-1']])
    // patchStatus 收到的是**整只** providers 子对象（实现里 `{ ...status.providers, ...patch }`
    // 把五家全展开了——见本 Task Step 2 的注释）。所以不能裸断言 `{ assrt: … }`：那既漏了
    // `providers` 这层包装，也漏了没动的另外四家，toHaveBeenCalledWith 是深相等，必红。
    // 只关心"assrt 那家变绿了"，就用两层 objectContaining。
    expect(patchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          assrt: { satisfied: true, source: 'db', masked: null },
        }),
      }),
    )
    // 整只替换语义下的反向护栏：subhd/zimuku 必须原样活着（spread 不可丢家）。
    expect(patchStatus.mock.calls[0][0].providers.subhd).toEqual(BASE.providers.subhd)
    expect(patchStatus.mock.calls[0][0].providers.zimuku).toEqual(BASE.providers.zimuku)
  })

  it('一家绿一家红 → 只存绿的那家', async () => {
    vi.spyOn(api, 'validateSetup').mockImplementation(async (target) =>
      target === 'assrt' ? { ok: true } : { ok: false, error: 'Invalid credentials' },
    )
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    const assrt = within(screen.getByTestId('provider-assrt'))
    fireEvent.change(assrt.getByLabelText('ASSRT token'), { target: { value: 'at-1' } })
    fireEvent.click(assrt.getByRole('button', { name: 'Test' }))
    const jimaku = within(screen.getByTestId('provider-jimaku'))
    fireEvent.change(jimaku.getByLabelText('Jimaku API key'), { target: { value: 'jk-bad' } })
    fireEvent.click(jimaku.getByRole('button', { name: 'Test' }))
    await screen.findByText('Without Jimaku, one fewer subtitle source.')
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([['ASSRT_TOKEN', 'at-1']])
  })

  it('OS：apiKey 绿 + 只填 username（缺 password）→ 成对规则只存 apiKey', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const onAdvance = vi.fn()
    renderStep({ onAdvance })
    const os = within(screen.getByTestId('provider-opensubtitles'))
    fireEvent.change(os.getByLabelText('OpenSubtitles API key'), { target: { value: 'osk-1' } })
    // 定位串必须是 i18n 里 `wizard_os_user_label` 的原文 'OpenSubtitles username (optional)'
    // ——不是 'Username'。三个 OS 字段的 aria-label 都由 PROVIDER_FIELDS 的 labelKey 经 t() 生成
    // （见 Step 2），字典里怎么写，测试就得怎么查。
    fireEvent.change(os.getByLabelText('OpenSubtitles username (optional)'), { target: { value: 'alice' } })
    fireEvent.click(os.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([['OPENSUBTITLES_API_KEY', 'osk-1']])
    // 成对规则同样约束测试路径：单填的 username 不得进 validate 的 credentials。
    expect(vi.mocked(api.validateSetup).mock.calls[0]).toEqual(['opensubtitles', { OPENSUBTITLES_API_KEY: 'osk-1' }])
  })

  it('OS：apiKey 绿 + username/password 成对填满 → 三键全存且 hasUsername: true', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const patchStatus = vi.fn()
    const onAdvance = vi.fn()
    renderStep({ patchStatus, onAdvance })
    const os = within(screen.getByTestId('provider-opensubtitles'))
    fireEvent.change(os.getByLabelText('OpenSubtitles API key'), { target: { value: 'osk-1' } })
    fireEvent.change(os.getByLabelText('OpenSubtitles username (optional)'), { target: { value: 'alice' } })
    fireEvent.change(os.getByLabelText('OpenSubtitles password (optional)'), { target: { value: 'pw-1' } })
    fireEvent.click(os.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save & continue' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }))
    await waitFor(() => expect(onAdvance).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([
      ['OPENSUBTITLES_API_KEY', 'osk-1'],
      ['OPENSUBTITLES_USERNAME', 'alice'],
      ['OPENSUBTITLES_PASSWORD', 'pw-1'],
    ])
    // inclusion 侧钉子：成对填满时 validate 必须收到**三键全量**凭据（不只 apiKey）——
    // 后端 OS 成对校验吃的是 username+password，漏传会把绿灯误判成半残。
    expect(vi.mocked(api.validateSetup).mock.calls[0]).toEqual([
      'opensubtitles',
      { OPENSUBTITLES_API_KEY: 'osk-1', OPENSUBTITLES_USERNAME: 'alice', OPENSUBTITLES_PASSWORD: 'pw-1' },
    ])
    expect(patchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          opensubtitles: expect.objectContaining({ hasUsername: true }),
        }),
      }),
    )
  })

  it('env 满足的家锁定展示、无输入框、不占绿名额', () => {
    renderStep({
      status: {
        ...BASE,
        providers: { ...BASE.providers, assrt: { satisfied: true, source: 'env', masked: 'abc••••xyz' } },
      },
    })
    const block = within(screen.getByTestId('provider-assrt'))
    expect(block.getByText(/Configured via environment/)).toBeInTheDocument()
    expect(block.queryByLabelText('ASSRT token')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })

  it('测红 → 红点 + 行内错误 + 后果句；不拦其他家', async () => {
    vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: false, error: 'Invalid credentials' })
    renderStep()
    const assrt = within(screen.getByTestId('provider-assrt'))
    fireEvent.change(assrt.getByLabelText('ASSRT token'), { target: { value: 'bad' } })
    fireEvent.click(assrt.getByRole('button', { name: 'Test' }))
    await screen.findByText('Without ASSRT, one fewer subtitle source.')
    expect(assrt.getByTestId('status-dot-red')).toBeInTheDocument()
    expect(within(screen.getByTestId('provider-jimaku')).getByLabelText('Jimaku API key')).toBeEnabled()
  })

  it('validate 端点自身挂了（reject）→ 第四态文案，不回显异常串（spec §7/§8）', async () => {
    vi.spyOn(api, 'validateSetup').mockRejectedValue(new Error('HTTP 500 boom'))
    renderStep()
    const assrt = within(screen.getByTestId('provider-assrt'))
    fireEvent.change(assrt.getByLabelText('ASSRT token'), { target: { value: 'tok-1' } })
    fireEvent.click(assrt.getByRole('button', { name: 'Test' }))
    expect(await screen.findByText('Test unavailable, retry')).toBeInTheDocument()
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save & continue' })).toBeDisabled()
  })
})
