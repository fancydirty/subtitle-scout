// web/src/settings/ProvidersSection.test.tsx：Providers 区（spec A §5.4）——打码/source 徽标/
// 上次测试点/env 锁定/编辑（仅 db 可改，空输入=不动该键，UI 不提供删除）/Test；
// subhd·zimuku 两家 toggle 行走 PUT settings 通道。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { ProvidersDTO, SetupStatusDTO } from '../api/types.js'
import { ProvidersSection } from './ProvidersSection.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const PROVIDERS: ProvidersDTO = {
  providers: [
    { id: 'tmdb', secrets: [{ name: 'TMDB_API_KEY', set: true, source: 'env', masked: 'abc••••xyz' }], lastTest: null },
    { id: 'llm', secrets: [
      { name: 'LLM_BASE_URL', set: true, source: 'db', masked: 'htt••••/v1' },
      { name: 'LLM_API_KEY', set: false, source: 'none', masked: null },
      { name: 'LLM_MODEL', set: true, source: 'db', masked: '••••' },
    ], lastTest: { ok: false, at: 1700000000000, error: 'Invalid credentials' } },
    { id: 'assrt', secrets: [{ name: 'ASSRT_TOKEN', set: true, source: 'db', masked: 'ass••••123' }], lastTest: { ok: true, at: 1700000000000 } },
    { id: 'opensubtitles', secrets: [
      { name: 'OPENSUBTITLES_API_KEY', set: false, source: 'none', masked: null },
      { name: 'OPENSUBTITLES_USERNAME', set: false, source: 'none', masked: null },
      { name: 'OPENSUBTITLES_PASSWORD', set: false, source: 'none', masked: null },
    ], lastTest: null },
    { id: 'jimaku', secrets: [{ name: 'JIMAKU_API_KEY', set: false, source: 'none', masked: null }], lastTest: null },
    { id: 'subhd', secrets: [], lastTest: null },
    { id: 'zimuku', secrets: [], lastTest: null },
  ],
}

const SETUP: SetupStatusDTO = {
  bootstrapComplete: true,
  tmdb: { satisfied: true, source: 'env', masked: 'abc••••xyz' },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: true, source: 'db', masked: 'ass••••123' },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: false, source: 'env', captchaReady: true },
  },
  roots: { count: 1 },
  engineEnabled: true,
}

function renderSection(over: { providers?: Partial<Parameters<typeof ProvidersSection>[0]['providers']>; setupStatus?: Partial<Parameters<typeof ProvidersSection>[0]['setupStatus']> } = {}) {
  const providersReload = vi.fn()
  const setupReload = vi.fn()
  render(
    <I18nProvider initialLang="en">
      <ProvidersSection
        providers={{ data: PROVIDERS, loading: false, error: null, reload: providersReload, ...over.providers }}
        setupStatus={{ data: SETUP, loading: false, error: null, reload: setupReload, ...over.setupStatus }}
      />
    </I18nProvider>,
  )
  return { providersReload, setupReload }
}

describe('ProvidersSection', () => {
  it('env secret：打码 + environment 徽标 + 锁定注；全家 env 的 provider 无 Edit', () => {
    renderSection()
    const tmdb = within(screen.getByTestId('providers-tmdb'))
    expect(tmdb.getByText('abc••••xyz')).toBeInTheDocument()
    expect(tmdb.getByText('environment')).toBeInTheDocument()
    expect(tmdb.getByText('Set by environment — locked')).toBeInTheDocument()
    expect(tmdb.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    const jimaku = within(screen.getByTestId('providers-jimaku'))
    expect(jimaku.getByText('Not set')).toBeInTheDocument()
  })

  it('lastTest：ok → 绿点 + Last test passed；fail → Last test failed + 错误行', () => {
    renderSection()
    // **必须用正则、不能用全等字符串**：可见的那个 `<Text>` 内容是
    // `Last test passed · ${new Date(at).toLocaleString()}`（见下面 Step 3 的实现），
    // getByText 默认整串规范化后全等匹配，`'Last test passed'` 永远匹配不上；
    // 而 StatusDot 的 `label` 只落在 aria-label 上，压根不是文本节点。
    expect(within(screen.getByTestId('providers-assrt')).getByText(/Last test passed/)).toBeInTheDocument()
    const llm = within(screen.getByTestId('providers-llm'))
    expect(llm.getByText(/Last test failed/)).toBeInTheDocument()
    expect(llm.getByText('Invalid credentials')).toBeInTheDocument()
  })

  it('Edit（db 家）→ 输入 → Save → putSecret + providers reload', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const { providersReload } = renderSection()
    const assrt = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(assrt.getByRole('button', { name: 'Edit' }))
    fireEvent.change(assrt.getByLabelText('ASSRT_TOKEN'), { target: { value: 'new-tok' } })
    fireEvent.click(assrt.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('ASSRT_TOKEN', 'new-tok'))
    await waitFor(() => expect(providersReload).toHaveBeenCalled())
  })

  it('Edit 后输入留空 → Save 不 PUT 该键（空输入=不动，UI 不提供删除）', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    renderSection()
    const assrt = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(assrt.getByRole('button', { name: 'Edit' }))
    fireEvent.click(assrt.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).not.toHaveBeenCalled())
  })

  it('Test → validateSetup(该家) → reload（结果由 lastTest 行呈现）', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true })
    const { providersReload } = renderSection()
    fireEvent.click(within(screen.getByTestId('providers-assrt')).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('assrt'))
    await waitFor(() => expect(providersReload).toHaveBeenCalled())
  })

  it('subhd toggle → PUT provider:SUBHD_ENABLED + setupStatus reload', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const { setupReload } = renderSection()
    const subhd = within(screen.getByTestId('providers-subhd'))
    fireEvent.click(subhd.getByRole('switch'))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ 'provider:SUBHD_ENABLED': 'false' }))
    await waitFor(() => expect(setupReload).toHaveBeenCalled())
  })

  it('zimuku 是 env 源 → toggle 禁用 + 锁定注', () => {
    renderSection()
    const zimuku = within(screen.getByTestId('providers-zimuku'))
    expect(zimuku.getByRole('switch')).toBeDisabled()
    expect(zimuku.getByText('Set by environment — locked')).toBeInTheDocument()
  })
})
