// web/src/shell/CommandK.test.tsx：自绘 ⌘K 面板的组件级契约测试（Plan C Task 29 新档）。
// App.test.tsx 的两条 ⌘K 集成用例（触发器开/Esc 关、点项跳转+关）保留在原地不动；
// 这里把同一组契约钉到组件级，并补上过滤/空态/mod+k 打开三条组件级独有的锁。
import { useState } from 'react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { CommandK } from './CommandK.js'

// 受控开合的最小宿主：CommandK 本身不管开合态（isOpen/onOpenChange 是 props），
// mod+k → onOpenChange(true) → 真开 这条链需要一个真 state 宿主才验得全。
function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <I18nProvider initialLang="en">
      <CommandK isOpen={open} onOpenChange={setOpen} />
    </I18nProvider>
  )
}

beforeEach(() => {
  // 点项用例会写 location.hash，用例间归零，互不影响。
  location.hash = ''
})

afterEach(() => cleanup())

describe('CommandK（自绘 ⌘K 面板）', () => {
  it('闭态：整棵不在 DOM（无 dialog、无 combobox）', () => {
    render(<Harness />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('mod+k 打开（useHotkeys 换源后的键盘契约；jsdom 非苹果 → Ctrl+K）', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeInTheDocument()
    // 契约②：combobox 与列表的 aria 配套。
    const combobox = screen.getByRole('combobox')
    expect(combobox).toHaveAttribute('aria-expanded', 'true')
    expect(combobox).toHaveAttribute('aria-controls', 'cmdk-list')
    expect(screen.getByRole('listbox')).toHaveAttribute('id', 'cmdk-list')
  })

  // 2026-08-07（spec §5）：甄别 tab 下架，TABS 从四项减为三项——CommandK 源码直接 TABS.map，
  // 所以只有下面这些"列表恰为哪几项 / 箭头走到第几项是谁"的断言需要跟着改（Triage 从列表
  // 里消失，两次 ArrowDown 的落点从 cmdk-option-triage 变成末项 cmdk-option-settings）。
  it('空查询：四个 tab 全列出（bootstrap 语义）', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Activity', 'Notifications', 'Media', 'Settings'])
  })

  it('输入过滤：子串匹配（noti → Notifications 在，其余不在）', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'noti' } })
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual(['Notifications'])
    expect(within(listbox).queryByText('Activity')).not.toBeInTheDocument()
  })

  it('无匹配：空态文案（cmdk_empty），无 option', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } })
    expect(screen.getByText('No matches')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('Escape 在 combobox 上按下 → 关', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('点项 → hash 跳转 + 关', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('option', { name: 'Settings' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(location.hash).toBe('#/settings')
  })

  it('关掉重开：上次输入的查询串不残留（Astryx 卸载语义的平价保持）', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'work' } })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(4)
  })
})

// 契约⑥（2026-08-04 plan 修正案补入）：↑/↓ 移动高亮 + Enter 激活。
// 语义逐字对齐 Astryx BaseTypeahead.js:403-446——wrap 不 clamp、打开/过滤后默认高亮首项、
// hover 同步高亮；dist 证据行号钉在各用例注释里。
describe('CommandK 键盘导航（契约⑥，对齐 Astryx BaseTypeahead）', () => {
  it('打开即高亮首项（BaseTypeahead.js:288 bootstrap 默认 active），aria-activedescendant 指向它', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    const combobox = screen.getByRole('combobox')
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-activity')
    expect(screen.getByRole('option', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Notifications' })).toHaveAttribute('aria-selected', 'false')
  })

  it('↓ 移到下一项；末项再按回卷首项（wrap 不 clamp，BaseTypeahead.js:417）', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    const combobox = screen.getByRole('combobox')

    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-notifications')
    expect(screen.getByRole('option', { name: 'Notifications' })).toHaveAttribute('aria-selected', 'true')

    // 四项（Task ⑦）：再按两次到末项 Settings。
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-media')
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-settings')
    // 末项再按 → 回卷首项（clamp 语义下这里会停在 settings，这条断言就是 wrap/clamp 的分界线）。
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-activity')
  })

  it('↑ 反向移动；首项再按回卷末项（BaseTypeahead.js:421）', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    const combobox = screen.getByRole('combobox')
    fireEvent.keyDown(combobox, { key: 'ArrowUp' })
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-settings')
    expect(screen.getByRole('option', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
  })

  it('Enter 激活高亮项：hash 跳转 + 关（与点击同一路径）', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    const combobox = screen.getByRole('combobox')
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(location.hash).toBe('#/notifications')
  })

  it('过滤变化 → 高亮重置回首项（BaseTypeahead.js:255 结果集落地语义）', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    const combobox = screen.getByRole('combobox')
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    // 四项下三次 ArrowDown 落在末项 Settings（Task ⑦ 前是三项两次）。
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-settings')

    fireEvent.change(combobox, { target: { value: 'noti' } })
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-notifications')
    expect(screen.getByRole('option', { name: 'Notifications' })).toHaveAttribute('aria-selected', 'true')
  })

  it('hover 同步高亮（BaseTypeahead.js:543 onMouseEnter），点击仍走原路径', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    const combobox = screen.getByRole('combobox')
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'Settings' }))
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-settings')

    fireEvent.click(screen.getByRole('option', { name: 'Settings' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(location.hash).toBe('#/settings')
  })

  // 回归（2026-08-04 质量审抓获）：纯键盘路径——全程不输入，query 恒为 ''，setQuery('') 是
  // no-op、items 引用不变、重置 effect 不触发；若关闭分支不显式重置 activeIndex，重开会
  // 残留上次箭头位（activedescendant=末项 而非 library）。既有"关掉重开"用例先输了 'work'，
  // items 引用变了、effect 兜住了，恰好掩盖这条缝。
  it('回归：纯键盘路径（不输入）关掉重开 → 高亮回首项，不残留上次的箭头位', async () => {
    render(<Harness />)
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    const combobox = screen.getByRole('combobox')
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    fireEvent.keyDown(combobox, { key: 'ArrowDown' })
    // 四项下三次 ArrowDown 落在末项 Settings（Task ⑦ 前是三项两次；甄别下架前是 triage）。
    // 这里必须停在**末项**：本用例要验的是"重开时高亮不残留在上次的位置"，
    // 停在中间项的话首项与它的距离更近，回归发生时更容易蒙混过关。
    expect(combobox).toHaveAttribute('aria-activedescendant', 'cmdk-option-settings')
    fireEvent.keyDown(combobox, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    await screen.findByRole('dialog')
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', 'cmdk-option-activity')
    expect(screen.getByRole('option', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
  })
})
