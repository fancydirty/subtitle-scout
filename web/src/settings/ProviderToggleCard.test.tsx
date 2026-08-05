import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import { ProviderToggleCard } from './ProviderToggleCard.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderCard(props: { id: 'subhd' | 'zimuku'; state: { enabled: boolean; source: string }; reload?: () => void }) {
  const reload = props.reload ?? vi.fn()
  render(<I18nProvider initialLang="en"><ProviderToggleCard id={props.id} state={props.state} reload={reload} /></I18nProvider>)
  return reload
}

describe('ProviderToggleCard', () => {
  it('enabled → configured badge + Switch on', () => {
    renderCard({ id: 'subhd', state: { enabled: true, source: 'db' } })
    const card = within(screen.getByTestId('providers-subhd'))
    expect(card.getByText('✓ Configured')).toBeInTheDocument()
    expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('disabled → unconfigured badge + Switch off', () => {
    renderCard({ id: 'zimuku', state: { enabled: false, source: 'none' } })
    expect(within(screen.getByTestId('providers-zimuku')).getByText('⚠ Not configured')).toBeInTheDocument()
  })

  it('切换 → PUT provider:<FLAG> + reload', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({} as never)
    const reload = renderCard({ id: 'subhd', state: { enabled: true, source: 'db' } })
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ 'provider:SUBHD_ENABLED': 'false' }))
    await waitFor(() => expect(reload).toHaveBeenCalled())
  })

  it('env 源 → Switch 禁用 + locked badge + 锁定注', () => {
    renderCard({ id: 'zimuku', state: { enabled: false, source: 'env' } })
    const card = within(screen.getByTestId('providers-zimuku'))
    expect(card.getByRole('switch')).toBeDisabled()
    expect(card.getByText('🔒 Environment')).toBeInTheDocument()
    expect(card.getByText('Set by environment — locked')).toBeInTheDocument()
  })

  it('渲染中文源描述', () => {
    renderCard({ id: 'subhd', state: { enabled: true, source: 'db' } })
    expect(screen.getByText('Chinese subtitle source')).toBeInTheDocument()
  })
})