import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { isApplePlatform } from './platform.js'
import { useHotkeys, type Hotkey } from './useHotkeys.js'

// 平台探测在这里被替换掉：真实的 navigator 嗅探已经由 Task 8 的 primitives.test.tsx
// 通过 Kbd 压过一遍，这里只关心"判成苹果/判成非苹果时 mod 分别落到哪个修饰键"。
vi.mock('./platform.js', () => ({ isApplePlatform: vi.fn(() => false) }))

// 宿主组件：hook 没法单独渲染。顺带放一个 textbox，"焦点在输入框里"的两条用例要用。
function Host({ hotkeys }: { hotkeys: Hotkey[] }) {
  useHotkeys(hotkeys)
  return <input aria-label="probe" />
}

beforeEach(() => {
  // isApple 是在挂载 effect 里取一次的，所以每条用例都必须在 render 之前设定好。
  vi.mocked(isApplePlatform).mockReturnValue(false)
})

describe('useHotkeys', () => {
  it('非苹果平台上 mod+k = Ctrl+K，并且吃掉浏览器默认行为', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress }]} />)

    // fireEvent 返回 false 表示事件被 preventDefault 了（keyDown 是 cancelable）。
    expect(fireEvent.keyDown(window, { key: 'k', ctrlKey: true })).toBe(false)
    expect(onPress).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('苹果平台上 mod+k = ⌘K，Ctrl+K 不算', () => {
    vi.mocked(isApplePlatform).mockReturnValue(true)
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress }]} />)

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(onPress).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('escape 无修饰键触发（RunDetail 的实际组合）', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'escape', onPress }]} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('esc 是 escape 的别名', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'esc', onPress }]} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('焦点在输入框里时默认不触发', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress }]} />)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'k', ctrlKey: true })
    expect(onPress).not.toHaveBeenCalled()
  })

  it('allowInInputs 打开后输入框里也触发', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress, allowInInputs: true }]} />)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'k', ctrlKey: true })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('isDisabled 的条目整条跳过', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress, isDisabled: true }]} />)

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(onPress).not.toHaveBeenCalled()
  })

  it('同一组合键只有数组里第一条被调用', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(<Host hotkeys={[{ keys: 'escape', onPress: first }, { keys: 'escape', onPress: second }]} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('已经被别人 preventDefault 的事件整体跳过', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'escape', onPress }]} />)

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(onPress).not.toHaveBeenCalled()
  })

  it('没写明 shift 时，按住 ⇧ 依然触发（Astryx 既有语义，行为冻结）', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress }]} />)

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('handler 换新后调用的是新的那个（ref 刷新，不重订阅）', () => {
    const stale = vi.fn()
    const fresh = vi.fn()
    const { rerender } = render(<Host hotkeys={[{ keys: 'escape', onPress: stale }]} />)
    rerender(<Host hotkeys={[{ keys: 'escape', onPress: fresh }]} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(stale).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledTimes(1)
  })

  it('卸载后监听器被摘掉', () => {
    const onPress = vi.fn()
    const { unmount } = render(<Host hotkeys={[{ keys: 'escape', onPress }]} />)
    unmount()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPress).not.toHaveBeenCalled()
  })
})
