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

  // 评审遗留补测①（Important）：多密钥家的"选择存"钉——onSave 逐键跳过空草稿，只 PUT 填了的键。
  // llm 桩三键（db/none/db），只填 LLM_API_KEY → put 恰好一次、参数恰为该键。
  it('多密钥家：只填一个输入 → Save 只 PUT 该键（选择存，空输入不碰其余键）', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const { providersReload } = renderSection()
    const llm = within(screen.getByTestId('providers-llm'))
    fireEvent.click(llm.getByRole('button', { name: 'Edit' }))
    fireEvent.change(llm.getByLabelText('LLM_API_KEY'), { target: { value: 'sk-new' } })
    fireEvent.click(llm.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1))
    expect(put.mock.calls).toEqual([['LLM_API_KEY', 'sk-new']])
    await waitFor(() => expect(providersReload).toHaveBeenCalled())
  })

  // 评审遗留补测②：保存失败路径——行内错误展示、编辑态不退出（Save 还在）、草稿不丢（可改完重试）。
  it('Edit 保存失败 → 行内错误 + 编辑态保留 + 草稿不丢', async () => {
    vi.spyOn(api, 'putSecret').mockRejectedValue(new Error('boom'))
    renderSection()
    const assrt = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(assrt.getByRole('button', { name: 'Edit' }))
    fireEvent.change(assrt.getByLabelText('ASSRT_TOKEN'), { target: { value: 'new-tok' } })
    fireEvent.click(assrt.getByRole('button', { name: 'Save' }))
    expect(await assrt.findByText(/Couldn't save: /)).toBeInTheDocument()
    expect(assrt.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(assrt.getByLabelText('ASSRT_TOKEN')).toHaveValue('new-tok')
  })

  // 评审遗留补测③：混合源编辑——env 行在编辑态下仍只读（不出输入框、打码与锁定注原样），
  // 只有 db/none 行变输入框（KeyedRow 的 editing 分支按行级 source 分流，不是整家一刀切）。
  it('混合源编辑：env 行保持只读，db 行变输入框', () => {
    const mixed: ProvidersDTO = {
      providers: [
        { id: 'llm', secrets: [
          { name: 'LLM_BASE_URL', set: true, source: 'env', masked: 'htt••••/v1' },
          { name: 'LLM_API_KEY', set: true, source: 'db', masked: 'sk••••ey' },
        ], lastTest: null },
        { id: 'subhd', secrets: [], lastTest: null },
        { id: 'zimuku', secrets: [], lastTest: null },
      ],
    }
    renderSection({ providers: { data: mixed } })
    const llm = within(screen.getByTestId('providers-llm'))
    fireEvent.click(llm.getByRole('button', { name: 'Edit' }))
    expect(llm.queryByLabelText('LLM_BASE_URL')).not.toBeInTheDocument()
    expect(llm.getByText('htt••••/v1')).toBeInTheDocument()
    expect(llm.getByText('Set by environment — locked')).toBeInTheDocument()
    expect(llm.getByLabelText('LLM_API_KEY')).toBeInTheDocument()
  })

  // 评审遗留补测④：lastTest 负向——ok 行不渲染失败文案与错误段；fail 但无 error 字段时
  // 失败行照常、错误段不渲染（错误段渲染的是 error 原文，没有原文就没有段）。
  it('lastTest 负向：ok 行无失败/错误文案；fail 无 error 字段 → 只有失败行没有错误段', () => {
    renderSection()
    const okRow = screen.getByTestId('providers-assrt')
    expect(within(okRow).getByText(/Last test passed/)).toBeInTheDocument()
    expect(within(okRow).queryByText(/Last test failed/)).not.toBeInTheDocument()
    // 结构钉（VStack/Stack 不包裹子节点，直接子节点数即行数）：assrt ok 行 = 头部行 +
    // 1 密钥行 = 2；对照 llm（fail + error）= 头部行 + 错误段 + 3 密钥行 = 5——证明
    // 错误段在场时这个计数确实会 +1，下面的 2 不是"数错了也碰巧过"。
    expect(okRow.children).toHaveLength(2)
    expect(screen.getByTestId('providers-llm').children).toHaveLength(5)

    cleanup()
    const noErr: ProvidersDTO = {
      providers: [
        { id: 'assrt', secrets: [{ name: 'ASSRT_TOKEN', set: true, source: 'db', masked: 'ass••••123' }], lastTest: { ok: false, at: 1700000000000 } },
        { id: 'subhd', secrets: [], lastTest: null },
        { id: 'zimuku', secrets: [], lastTest: null },
      ],
    }
    renderSection({ providers: { data: noErr } })
    const failRow = screen.getByTestId('providers-assrt')
    expect(within(failRow).getByText(/Last test failed/)).toBeInTheDocument()
    expect(failRow.children).toHaveLength(2)
  })
})
