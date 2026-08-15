// web/src/settings/ProviderCard.test.tsx：字幕源 keyed 卡片（spec §3.2）迁移自
// ProvidersSection KeyedRow，外壳换 SettingsCard。env 源只读、db 源可编辑、
// 编辑/测试/lastTest。fixture 与 ProvidersSection.test.tsx 同形，保证迁移锁。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO } from '../api/types.js'
import { ProviderCard } from './ProviderCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderCard(row: ProviderRowDTO, reload = vi.fn()) {
  render(<I18nProvider initialLang="en"><ProviderCard row={row} reload={reload} /></I18nProvider>)
}

const TMDB: ProviderRowDTO = { id: 'tmdb', secrets: [{ name: 'TMDB_API_KEY' as any, set: true, source: 'env', masked: 'abc••••xyz' }], lastTest: null, quota: null }
const ASSRT: ProviderRowDTO = { id: 'assrt', secrets: [{ name: 'ASSRT_TOKEN' as any, set: true, source: 'db', masked: 'ass••••123' }], lastTest: { ok: true, at: 1700000000000 }, quota: null }

describe('ProviderCard', () => {
  it('env 源：只读打码 + locked badge + 无 Edit', () => {
    renderCard(TMDB)
    const card = within(screen.getByTestId('providers-tmdb'))
    expect(card.getByText('abc••••xyz')).toBeInTheDocument()
    expect(card.getByText('🔒 Environment')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('db 源：可编辑 + Edit 按钮 + configured badge', () => {
    renderCard(ASSRT)
    const card = within(screen.getByTestId('providers-assrt'))
    expect(card.getByText('✓ Configured')).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it('Edit → 输入 → Save → putSecret + reload', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    const reload = vi.fn()
    renderCard(ASSRT, reload)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    fireEvent.change(card.getByLabelText('ASSRT token'), { target: { value: 'new-tok' } })
    fireEvent.click(card.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).toHaveBeenCalledWith('ASSRT_TOKEN', 'new-tok'))
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('空输入 = 不动该键（UI 不提供删除）', async () => {
    const put = vi.spyOn(api, 'putSecret').mockResolvedValue({ ok: true })
    renderCard(ASSRT)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    fireEvent.click(card.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(put).not.toHaveBeenCalled())
  })

  it('Test → validateSetup(id) → reload', async () => {
    const validate = vi.spyOn(api, 'validateSetup').mockResolvedValue({ ok: true } as any)
    const reload = vi.fn()
    renderCard(ASSRT, reload)
    fireEvent.click(within(screen.getByTestId('providers-assrt')).getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(validate).toHaveBeenCalledWith('assrt'))
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('lastTest ok → 绿点 + Last test passed；fail → Last test failed + 错误行', () => {
    renderCard(ASSRT)
    expect(within(screen.getByTestId('providers-assrt')).getByText(/Last test passed/)).toBeInTheDocument()
    const fail: ProviderRowDTO = { id: 'llm', secrets: [{ name: 'LLM_API_KEY' as any, set: true, source: 'db', masked: 'sk••••' }], lastTest: { ok: false, at: 1700000000000, error: 'Invalid credentials' }, quota: null }
    cleanup(); renderCard(fail)
    const card = within(screen.getByTestId('providers-llm'))
    expect(card.getByText(/Last test failed/)).toBeInTheDocument()
    expect(card.getByText('Invalid credentials')).toBeInTheDocument()
  })

  it('混合源编辑：env 行只读，db 行变输入框', () => {
    const mixed: ProviderRowDTO = { id: 'llm', secrets: [
      { name: 'LLM_BASE_URL' as any, set: true, source: 'env', masked: 'htt••••/v1' },
      { name: 'LLM_API_KEY' as any, set: true, source: 'db', masked: 'sk••••ey' },
    ], lastTest: null, quota: null }
    renderCard(mixed)
    const card = within(screen.getByTestId('providers-llm'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    expect(card.queryByLabelText('LLM_BASE_URL')).not.toBeInTheDocument()
    expect(card.getByText('htt••••/v1')).toBeInTheDocument()
    expect(card.getByLabelText('API key')).toBeInTheDocument()
  })

  it('保存失败 → 行内错误 + 编辑态保留', async () => {
    vi.spyOn(api, 'putSecret').mockRejectedValue(new Error('boom'))
    renderCard(ASSRT)
    const card = within(screen.getByTestId('providers-assrt'))
    fireEvent.click(card.getByRole('button', { name: 'Edit' }))
    fireEvent.change(card.getByLabelText('ASSRT token'), { target: { value: 'new-tok' } })
    fireEvent.click(card.getByRole('button', { name: 'Save' }))
    expect(await card.findByText(/Couldn't save: /)).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('DOM 里不再有 astryx-* 类名', () => {
    renderCard(ASSRT)
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })

  // ═══════════════════════════════════════════════════════════════════════
  // 配额耗尽行（2026-08-13）——`quota_state_*` 旁路键在前端的**唯一**露出。
  // 这是"为什么 assrt 不找了"这个问题在产品里的答案所在地。
  // ═══════════════════════════════════════════════════════════════════════
  describe('配额耗尽行', () => {
    const NOW = 1_700_000_000_000
    const withQuota = (quota: ProviderRowDTO['quota']): ProviderRowDTO => ({ ...ASSRT, quota })

    it('quota=null → 一个字都不占屏（常态）', () => {
      renderCard(ASSRT)
      expect(screen.queryByTestId('provider-quota-note')).not.toBeInTheDocument()
    })

    it('quota 非空 → 出现在**这个源自己的卡片**上，说明它当前不可用', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      renderCard(withQuota({ resetAt: new Date(NOW + 3 * 3600_000).toISOString(), observedAt: NOW - 120_000 }))
      const card = within(screen.getByTestId('providers-assrt'))
      const note = card.getByTestId('provider-quota-note')
      expect(note).toHaveTextContent('Quota exhausted')
      expect(note).toHaveTextContent('resets in 3h')
      expect(note).toHaveTextContent('observed 2m ago')
    })

    // 🔴 不知道何时恢复 ≠ 可以编一个时间。用户会照着显示的时间来等。
    it('🔴 resetAt=null → 如实说"恢复时间未知"，且**不出现**任何倒计时字样', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      renderCard(withQuota({ resetAt: null, observedAt: NOW - 60_000 }))
      const note = within(screen.getByTestId('providers-assrt')).getByTestId('provider-quota-note')
      expect(note).toHaveTextContent('reset time unknown')
      expect(note.textContent).not.toContain('resets in')
    })

    // 后端已滤过期条目，这里是第二道：宁可退化成"未知"，也不显示负数倒计时。
    it('resetAt 在过去（后端漏网）→ 退化成"恢复时间未知"，不显示负数倒计时', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      renderCard(withQuota({ resetAt: new Date(NOW - 3600_000).toISOString(), observedAt: NOW - 7200_000 }))
      const note = within(screen.getByTestId('providers-assrt')).getByTestId('provider-quota-note')
      expect(note).toHaveTextContent('reset time unknown')
      expect(note.textContent).not.toContain('-')
    })

    it('resetAt 不可解析 → 同样退化成"恢复时间未知"，不渲染 NaN', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      renderCard(withQuota({ resetAt: 'garbage', observedAt: NOW }))
      const note = within(screen.getByTestId('providers-assrt')).getByTestId('provider-quota-note')
      expect(note).toHaveTextContent('reset time unknown')
      expect(note.textContent).not.toContain('NaN')
    })

    // 🔴 Carbon 双通道：颜色不能是唯一载体。
    //   ① 文字自己把话说全；② 标记是**空心**的（形状差异）。
    it('🔴 双通道：文字独立成句 + 空心标记（颜色不是唯一载体）', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      renderCard(withQuota({ resetAt: null, observedAt: NOW }))
      const note = within(screen.getByTestId('providers-assrt')).getByTestId('provider-quota-note')
      // ① 去掉一切样式后，句子本身仍然把"不可用"说清楚了
      expect(note.textContent).toContain('this source is unavailable right now')
      // ② 形状通道：空心点（沿用既有 .notif-new-dot-hollow），且对读屏器隐藏
      const dot = note.querySelector('.notif-new-dot-hollow')
      expect(dot).not.toBeNull()
      expect(dot).toHaveAttribute('aria-hidden', 'true')
    })

    // 这是背景事实不是错误：读屏器要知道，但不该打断用户正在听的内容。
    it('role=status + aria-live=polite（背景事实，不打断）', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      renderCard(withQuota({ resetAt: null, observedAt: NOW }))
      const note = within(screen.getByTestId('providers-assrt')).getByTestId('provider-quota-note')
      expect(note).toHaveAttribute('role', 'status')
      expect(note).toHaveAttribute('aria-live', 'polite')
      // 不是 alert：配额耗尽不需要抢断读屏
      expect(note).not.toHaveAttribute('role', 'alert')
    })

    it('配额行与凭据/上次测试并存，互不吞没（一个源的三个侧面）', () => {
      vi.spyOn(Date, 'now').mockReturnValue(NOW)
      renderCard(withQuota({ resetAt: null, observedAt: NOW }))
      const card = within(screen.getByTestId('providers-assrt'))
      expect(card.getByTestId('provider-quota-note')).toBeInTheDocument()
      expect(card.getByText(/Last test passed/)).toBeInTheDocument()
      expect(card.getByText('ass••••123')).toBeInTheDocument()
    })
  })
})