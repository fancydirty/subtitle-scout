import '@testing-library/jest-dom'
import { vi } from 'vitest'

// jsdom 不实现 <dialog> 的 showModal/close（Astryx CommandPalette/Dialog 底层用原生 <dialog>）。
// 全局垫一层最小 mock：把 open 属性当成"是否显示"的唯一真源，跟 Astryx 自己的测试套件同一手法
// （见 node_modules/@astryxdesign/core/src/CommandPalette/CommandPalette.test.tsx）。
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
}

// jsdom 的 window.scrollTo 是个只会报 "Not implemented" 的桩（不是缺失，是存在但一调用就报）——
// Astryx Dialog 开合时的 scroll lock 逻辑会调用它，不垫掉的话每次开关 ⌘K 面板测试都会往 stderr
// 打一条噪音（不影响断言）。这里直接换成真正的空实现。
if (typeof window !== 'undefined') {
  window.scrollTo = vi.fn()
}

// jsdom 不实现 window.matchMedia——Astryx AppShell 用它做响应式（移动端导航）判断。
// 垫一个恒为 false 的假实现：测试环境固定按桌面宽度跑，不需要真的响应媒体查询。
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
}
