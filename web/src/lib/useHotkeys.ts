// 自绘，取代 @astryxdesign/core/hooks 的 useHotkeys。
// **逻辑逐字复刻** dist/hooks/useHotkeys.js（含它两处不对称语义，见下方注释），唯一偏离是
// 平台探测 import ./platform.js，不再自带一份——Astryx 里 Kbd 与 useHotkeys 各有一份
// isApplePlatform，两份走偏就会出现"界面写 ⌘K、按 ⌘K 没反应"。
import { useEffect, useRef } from 'react'
import { isApplePlatform } from './platform.js'

export interface Hotkey {
  /** 组合键，形如 'mod+k' / 'escape' / 'ctrl+shift+p'；mod = 苹果平台 ⌘、其他平台 Ctrl。 */
  keys: string
  onPress: (event: KeyboardEvent) => void
  /** 默认 false：焦点在输入类元素里时不触发。 */
  allowInInputs?: boolean
  isDisabled?: boolean
}

// 别名表逐字照抄。注意 ' ' 和 '+' 两条：空格键的 event.key 是字面空格，而 '+' 没法直接写进
// 组合键串（'ctrl++' 会被 split('+') 切成空段），所以必须写 'ctrl+plus'。写 'esc' 而不是
// 'escape' 若没有这张表就会静默永不匹配——这类拼写 bug 最难查，表和它的用例都留着。
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  return: 'enter',
  plus: '+',
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function matchesCombo(keys: string, event: KeyboardEvent, isApple: boolean): boolean {
  const parts = keys
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return false
  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  const wantsMod = mods.has('mod')
  const wantsCtrl = mods.has('ctrl') || (wantsMod && !isApple)
  const wantsMeta = mods.has('meta') || (wantsMod && isApple)
  const wantsAlt = mods.has('alt')
  const wantsShift = mods.has('shift')
  if (event.ctrlKey !== wantsCtrl) return false
  if (event.metaKey !== wantsMeta) return false
  if (event.altKey !== wantsAlt) return false
  // 不对称①：ctrl/meta/alt 是**精确相等**，shift 只在写明时才校验。也就是说没写 shift 的
  // 组合键在 ⇧ 按下时依然触发（⌘⇧K 会开命令面板）。这是 Astryx 的既有语义，本 spec 是
  // 换视觉、行为冻结，不准"顺手改成精确相等"——有用例压着（'没写明 shift 时…'）。
  if (wantsShift && !event.shiftKey) return false
  const expected = KEY_ALIASES[key] ?? key
  return event.key.toLowerCase() === expected
}

export function useHotkeys(hotkeys: Hotkey[]): void {
  const hotkeysRef = useRef(hotkeys)
  // 故意不给依赖数组：每次渲染后把最新的 handler 数组塞进 ref。调用点传的都是内联数组
  // 字面量（每渲染一个新引用），写成依赖数组会让它每渲染都重订阅；而把 handler 直接
  // 捕获进监听器闭包（naive 的 [] 写法）会永远调用首渲染那一版。
  useEffect(() => {
    hotkeysRef.current = hotkeys
  })

  // 依赖数组恒空：整个生命周期只挂一个 window keydown 监听器。
  useEffect(() => {
    const isApple = isApplePlatform()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const isTyping = isTypingTarget(event.target)
      for (const hotkey of hotkeysRef.current) {
        if (hotkey.isDisabled) continue
        if (isTyping && !hotkey.allowInInputs) continue
        if (matchesCombo(hotkey.keys, event, isApple)) {
          event.preventDefault()
          hotkey.onPress(event)
          // 不对称②：首个命中即 return——同组合键的后续条目不会被调用。
          return
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
