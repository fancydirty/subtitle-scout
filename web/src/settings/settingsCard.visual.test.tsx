// web/src/settings/settingsCard.visual.test.tsx —— 「Vercel 风」Provider 卡视觉重构的判据。
//
// ── 为什么单独一个文件 ─────────────────────────────────────────────────
// 2026-08-18 用户裁决采用 B 方案（Vercel 风）重构已配置 Provider 卡的 rest 态：
//   ① Header 状态点 + 标题并排（与右上角 badge 同语义，视觉权重平衡）
//   ② 密钥清单改成 <dl> KV 栅格，dt=label、dd=mono 值
//   ③ 操作按钮独立成行（footer），lastTest 移到该行的右端，弱化
//   ④ 按钮文案「Test / Edit」→「Test connection / Edit credentials」
//   ⑤ lastTest 时间改相对值（2h / 3d），不再 toLocaleString() 绝对值
//
// 既有 ProviderCard.test.tsx 测的是**行为**（编辑流程、putSecret、validate），
// 本文件测的是**结构**（dl/dt/dd 栅格、footer 槽、状态点位置、文案）。
// 两类断言混在一个文件里，行为测试的样本数据会污染结构断言的 within 范围。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import type { ProviderRowDTO, SettingsDTO } from '../api/types.js'
import { ProviderCard } from './ProviderCard.js'
import { TranslateCard } from './TranslateCard.js'
import { SettingsCard } from './SettingsCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function withI18n(node: React.ReactNode) {
  return <I18nProvider initialLang="en">{node}</I18nProvider>
}

const LLM: ProviderRowDTO = {
  id: 'llm',
  secrets: [
    { name: 'LLM_BASE_URL' as any, set: true, source: 'db', masked: 'htt…/v1' },
    { name: 'LLM_API_KEY' as any, set: true, source: 'db', masked: 'sk-…e10' },
    { name: 'LLM_MODEL' as any, set: true, source: 'db', masked: 'dee…ash' },
  ],
  lastTest: { ok: true, at: Date.now() - 2 * 24 * 3600 * 1000 },
  quota: null,
}

const TMDB_ENV: ProviderRowDTO = {
  id: 'tmdb',
  secrets: [{ name: 'TMDB_API_KEY' as any, set: true, source: 'env', masked: 'abc••••xyz' }],
  lastTest: null,
  quota: null,
}

const TRANSLATE_ROW: ProviderRowDTO = {
  id: 'translate',
  secrets: [
    { name: 'TRANSLATE_BASE_URL' as any, set: true, source: 'db', masked: 'htt…/v1' },
    { name: 'TRANSLATE_API_KEY' as any, set: true, source: 'db', masked: 'tp-…qdh' },
    { name: 'TRANSLATE_MODEL' as any, set: true, source: 'db', masked: 'mim…pro' },
  ],
  lastTest: { ok: true, at: Date.now() - 3600 * 1000 },
  quota: null,
}

const SETTINGS_ON: SettingsDTO = { ai_translate_enabled: 'true' } as SettingsDTO

describe('SettingsCard Vercel 风：statusDot + footer 槽', () => {
  it('statusDot="success" → header 渲染一个 success StatusDot（与右上角 badge 并存）', () => {
    render(withI18n(
      <SettingsCard title="LLM" status="configured" statusDot="success" data-testid="c">body</SettingsCard>,
    ))
    const card = screen.getByTestId('c')
    // badge 仍在（aria-label 是 Status 文案）
    expect(within(card).getByText('✓ Configured')).toBeInTheDocument()
    // header 里还应该有一个 StatusDot（bg-fn-green 是 success 的 class 标记）。
    const dots = card.querySelectorAll('[data-slot="status-dot"].bg-fn-green')
    expect(dots.length).toBeGreaterThanOrEqual(1)
  })

  it('footer → 渲染在 CardContent 之后，且与 body 之间有一条 hairline 分隔元素', () => {
    render(withI18n(
      <SettingsCard title="X" data-testid="c" footer={<span data-testid="f">foot</span>}>body</SettingsCard>,
    ))
    const card = screen.getByTestId('c')
    expect(within(card).getByTestId('f')).toBeInTheDocument()
    // hairline 分隔：footer 容器自己带 top border。断言 className 含 border-t。
    const footer = within(card).getByTestId('f').parentElement
    expect(footer?.className ?? '').toMatch(/border-t/)
  })
})

describe('ProviderCard rest 态：KV 栅格 + 独立操作行', () => {
  it('渲染 <dl>，dt/dd 数量 == secrets 数量（LLM 3 个）', () => {
    render(withI18n(<ProviderCard row={LLM} reload={() => {}} />))
    const card = screen.getByTestId('providers-llm')
    const dl = card.querySelector('dl')
    expect(dl, 'rest 态应当用 <dl> 渲染密钥 KV 栅格').not.toBeNull()
    expect(dl!.querySelectorAll('dt').length).toBe(3)
    expect(dl!.querySelectorAll('dd').length).toBe(3)
  })

  it('dd 的 class 含 font-mono（masked token / URL 是技术读数）', () => {
    render(withI18n(<ProviderCard row={LLM} reload={() => {}} />))
    const dd = screen.getByTestId('providers-llm').querySelectorAll('dd')
    for (const el of dd) {
      expect(el.className).toMatch(/font-mono|tabular|mono/)
    }
  })

  it('按钮文案是「Test connection / Edit credentials」，不再是「Test / Edit」', () => {
    render(withI18n(<ProviderCard row={LLM} reload={() => {}} />))
    const card = within(screen.getByTestId('providers-llm'))
    expect(card.getByRole('button', { name: 'Test connection' })).toBeInTheDocument()
    expect(card.getByRole('button', { name: 'Edit credentials' })).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('lastTest 状态在 footer 区，**不在** credentials 区（不跟 dl 同层）', () => {
    render(withI18n(<ProviderCard row={LLM} reload={() => {}} />))
    const card = screen.getByTestId('providers-llm')
    const dl = card.querySelector('dl')!
    // lastTest 的 StatusDot 不应该出现在 dl 内部
    expect(dl.querySelector('[data-slot="status-dot"]')).toBeNull()
    // 相对时间文案（"2d ago" 之类）应该出现在 dl 之外
    const statusText = within(card).getByText(/passed.*ago|ago/i)
    expect(dl.contains(statusText)).toBe(false)
  })

  it('🔴 rest 态**不再**渲染 toLocaleString() 那种绝对时间', () => {
    render(withI18n(<ProviderCard row={LLM} reload={() => {}} />))
    const card = screen.getByTestId('providers-llm')
    // 绝对时间格式示例：「8/16/2026, 3:09:23 AM」或「2026/8/16 03:09:23」
    expect(card.textContent ?? '').not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/)
    expect(card.textContent ?? '').not.toMatch(/\d{4}\/\d{1,2}\/\d{1,2}/)
  })

  it('env 源（TMDB）：badge 在、状态点在、无 Edit 按钮、dl 仍渲染', () => {
    render(withI18n(<ProviderCard row={TMDB_ENV} reload={() => {}} />))
    const card = within(screen.getByTestId('providers-tmdb'))
    expect(card.getByText('✓ Configured')).toBeInTheDocument()
    expect(card.queryByRole('button', { name: 'Edit credentials' })).not.toBeInTheDocument()
    expect(screen.getByTestId('providers-tmdb').querySelector('dl')).not.toBeNull()
  })
})

describe('TranslateCard rest 态：复用同一模板', () => {
  it('enabled + dedicated → 渲染 dl KV + 「Test connection / Edit credentials」按钮', () => {
    render(withI18n(
      <TranslateCard translate={TRANSLATE_ROW} settings={SETTINGS_ON} onUpdated={() => {}} reload={() => {}} />,
    ))
    const card = screen.getByTestId('providers-translate')
    expect(card.querySelector('dl')).not.toBeNull()
    const c = within(card)
    expect(c.getByRole('button', { name: 'Test connection' })).toBeInTheDocument()
    expect(c.getByRole('button', { name: 'Edit credentials' })).toBeInTheDocument()
  })
})
