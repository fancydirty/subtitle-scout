// 自绘，取代 @astryxdesign/core 的 Kbd。
// **行为与无障碍逐字复刻** src/Kbd/Kbd.tsx：外层 <span role="img" aria-label="可读名">，
// 内层每个键一个 <kbd aria-hidden="true">，可读名 = 各键长名以 " + " 连接，
// 显示 = 各键字形；mod 在苹果平台是 ⌘/Command，其他平台是 Ctrl/Control。
// 两张映射表也逐字照抄（含 Unicode 码点）。
//
// **视觉是自拟的**：Astryx Kbd 的 stylex 块本计划未逐字取证，所以键帽外观按 §5.1 token
// 自拟（弱文本色 + secondary 面 + border + mono 小字。面走 --color-secondary 不走
// --color-accent：scout.css:86 把 accent 覆写成柠檬绿，Task 31 前落屏必错——
// section.tsx 同款注释）。Task 33 的实机核对覆盖这一处；
// 若届时觉得偏，按 §5.1 token 调，**不要回头抄 Astryx**（那时它已卸载）。
import * as React from 'react'
import { cn } from '../../lib/utils.js'
import { isApplePlatform } from '../../lib/platform.js'

const KEY_DISPLAY: Record<string, string> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  enter: '↵',
  backspace: '⌫',
  escape: 'Esc',
  tab: '⇥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  plus: '+',
}

const KEY_LABEL: Record<string, string> = {
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  backspace: 'Backspace',
  escape: 'Escape',
  tab: 'Tab',
  up: 'Up arrow',
  down: 'Down arrow',
  left: 'Left arrow',
  right: 'Right arrow',
  plus: 'Plus',
}

function keyDisplay(key: string, isMac: boolean): string {
  if (key === 'mod') return isMac ? '⌘' : 'Ctrl'
  return KEY_DISPLAY[key] ?? key.toUpperCase()
}

function keyLabel(key: string, isMac: boolean): string {
  if (key === 'mod') return isMac ? 'Command' : 'Control'
  return KEY_LABEL[key] ?? key.toUpperCase()
}

function Kbd({ keys, className, ...props }: React.ComponentProps<'span'> & { keys: string }) {
  const isMac = isApplePlatform()
  const parts = keys.split('+').map((key) => key.trim().toLowerCase())
  const accessibleName = parts.map((key) => keyLabel(key, isMac)).join(' + ')
  return (
    <span
      data-slot="kbd"
      role="img"
      aria-label={accessibleName}
      className={cn('inline-flex items-center gap-0.5', className)}
      {...props}
    >
      {parts.map((key) => (
        <kbd
          aria-hidden="true"
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border bg-secondary px-1 font-mono text-[10px] leading-none text-muted-foreground"
          key={key}
        >
          {keyDisplay(key, isMac)}
        </kbd>
      ))}
    </span>
  )
}

export { Kbd }
