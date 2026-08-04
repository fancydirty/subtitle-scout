// Radix Select 的触发器监听的是 pointerdown，不是 click——用 fireEvent.click 打它，
// 下拉永远不会开，而且测试的失败信息只会是"找不到 option"，非常难反查。
// 全仓所有需要打开 Select 的测试都走这个助手，别各自 fireEvent.pointerDown。
//
// 为什么不能直接 fireEvent.pointerDown(trigger, {button: 0, ...})：jsdom 没有
// PointerEvent（jsdom#2527），testing-library 会退化成裸 Event，init 里的
// button/ctrlKey/pointerType/pointerId 全部被构造器丢弃；而 Radix 2.x 的 Trigger
// 要求 event.button === 0 && event.ctrlKey === false && event.pointerType === 'mouse'
// 三者齐备才开单。所以这里手工构造 MouseEvent（button/ctrlKey 走构造器），
// 再补挂两个 pointer 属性（defineProperty 挂在实例上，React 合成事件读得到）。
// 同理，将来要断言 Radix 用 pointermove 维护的 data-highlighted，也得这样手工构造
// pointermove——fireEvent.pointerMove 在同一个坑里（裸 Event 丢光坐标与 button）。
import { fireEvent } from '@testing-library/react'

export function openRadixSelect(trigger: HTMLElement): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ctrlKey: false,
  })
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
  })
  fireEvent(trigger, event)
}
