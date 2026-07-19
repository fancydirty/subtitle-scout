import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { ExcludedBox } from './ExcludedBox.js'
import type { ParkedItemDTO } from '../api/types.js'

afterEach(cleanup)

const row = (path: string): ParkedItemDTO => ({ path, parkReason: 'excluded-extra', firstSeen: 1, lastAttempt: 1 })
const wrap = (onRestore: (p: string) => Promise<void>) =>
  render(<I18nProvider><ExcludedBox excluded={[row('/media/tv/Show/extra.mkv')]} onRestore={onRestore} /></I18nProvider>)

async function openBox() {
  fireEvent.click(screen.getByText(/excluded extras|已排除/i))
  return screen.findByRole('button', { name: /restore|恢复/i })
}

describe('ExcludedBox Restore 健壮性（dashboard 审计 #2：静默失败 + 可双提交）', () => {
  it('Restore 失败 → 行内展示错误，不静默', async () => {
    const onRestore = vi.fn(() => Promise.reject(new Error('boom')))
    wrap(onRestore)
    fireEvent.click(await openBox())
    await screen.findByText(/boom/)
  })

  it('Restore 进行中按钮禁用 → 不可双提交', async () => {
    let resolve!: () => void
    const onRestore = vi.fn(() => new Promise<void>((r) => { resolve = r }))
    wrap(onRestore)
    const btn = await openBox()
    fireEvent.click(btn)
    // 在飞行中再点一次不应再触发
    fireEvent.click(btn)
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
    resolve()
  })

  it('Restore 成功 → 无错误', async () => {
    const onRestore = vi.fn(() => Promise.resolve())
    wrap(onRestore)
    fireEvent.click(await openBox())
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument()
  })
})
