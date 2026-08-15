// RootPathInput.test.tsx：守备目录用普通输入框，不再用目录点选浏览器。
// 人类知道自己磁盘上有什么；产品只需要一个输入框 + 后端校验。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import { RootPathInput } from './RootPathInput.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderInput(onAdded: (path: string) => void = vi.fn()) {
  render(<I18nProvider initialLang="zh"><RootPathInput onAdded={onAdded} /></I18nProvider>)
  return onAdded
}

describe('RootPathInput', () => {
  it('渲染普通 text input，不是目录浏览器', () => {
    renderInput()
    expect(screen.getByRole('textbox', { name: '媒体目录路径' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('空路径不能提交', () => {
    renderInput()
    expect(screen.getByRole('button', { name: '添加媒体目录' })).toBeDisabled()
  })

  it('提交路径 → POST /api/v2/settings/roots → 成功提示 + onAdded + 清空输入', async () => {
    const add = vi.spyOn(api, 'addRoot').mockResolvedValue({ ok: true })
    const onAdded = renderInput()
    const input = screen.getByRole('textbox', { name: '媒体目录路径' })
    fireEvent.change(input, { target: { value: '/data/media' } })
    fireEvent.click(screen.getByRole('button', { name: '添加媒体目录' }))
    await waitFor(() => expect(add).toHaveBeenCalledWith('/data/media'))
    expect(await screen.findByText('已加入，下一轮扫描将自动摄取。')).toBeInTheDocument()
    expect(onAdded).toHaveBeenCalledWith('/data/media')
    expect(input).toHaveValue('')
  })

  it('提交失败 → 行内展示后端校验原因，不吞错误', async () => {
    vi.spyOn(api, 'addRoot').mockRejectedValue(new Error('path does not exist'))
    const onAdded = renderInput()
    fireEvent.change(screen.getByRole('textbox', { name: '媒体目录路径' }), { target: { value: '/nope' } })
    fireEvent.click(screen.getByRole('button', { name: '添加媒体目录' }))
    expect(await screen.findByText('无法添加该目录：路径不存在')).toBeInTheDocument()
    expect(onAdded).not.toHaveBeenCalled()
  })
})
