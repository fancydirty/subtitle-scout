// 自绘，取代 @astryxdesign/core 的 SegmentedControl / SegmentedControlItem。
// **role 契约是硬的**：SeriesGrid.test.tsx:75/90 用 getByRole('radio', { name: 'Has gaps' })
// 和 { name: 'Fully covered' } 取这两个分段——所以外层必须 role="radiogroup"、
// 分段必须 role="radio"，写成普通 button 会让那两个断言直接红。
//
// 度量逐条取证（TSX 里没有 borderRadius，圆角藏在主题层发的 --_*-radius 自定义属性里，
// 是从 dist/astryx.css 扫出来的）：
//   轨道  inline-flex items-center gap-0.5 + padding 2px + 圆角 --radius-element = 8px  → rounded-control p-0.5 gap-0.5
//   分段  圆角 max(0px, calc(8px - 2px)) = 6px                                        → rounded-[6px]
//   分段  paddingInline --spacing-3 = 12px，**完全没有 paddingBlock**（高度只由行盒决定）→ px-3，且不许加 py-*
//   分段  --text-label-size = **13px**（`--font-size-base` 被 scout.css:118 覆盖成 0.8125rem，
//         不是 Astryx 默认的 14px）/ medium / leading 1.5385                                → text-[13px] font-medium leading-[1.5385]
//   选中  --color-text-primary + semibold + --color-background-surface + --shadow-low    → text-foreground font-semibold bg-secondary shadow-sm
//          （surface 色走 --color-secondary 而非 --color-accent：scout.css:86 把 accent
//            覆写成柠檬绿，Task 31 删 scout.css 前 bg-accent 落屏是错的——section.tsx 同款注释）
//   悬停  --color-overlay-hover = #FFFFFF0D（白 5%）                                     → hover:bg-white/5
//          （Tailwind v4 的 hover: 本身就包在 @media (hover: hover) 里，正好等价于
//            Astryx 那层 hover 媒体查询，不用再自己写。）
//   轨道底 Astryx 用 --color-neutral (#E1E4DA33)。这里改用 Task 6 加的 --color-stage-track
//          （rgba(255,255,255,0.09)，即 spec §5.1 已写死的阶段条轨道值）——同一个"底槽"
//          语义不给两个近似值。
//
// 焦点环改成本仓统一的 --ring（Astryx 用它自己的 lime accent 描边）：本栈里 button/input/
// select 的焦点环全是 ring-ring/50，分段控件跟着统一。
//
// **键盘：分段就是原生 <button>，全部可 Tab 到、Enter/Space 激活；不做 roving tabindex +
// 方向键导航。这是有意的行为回退，不是行为冻结**——Astryx 原件有 roving tabindex +
// Arrow/Home/End 导航（src/SegmentedControl/SegmentedControl.tsx:176，useListFocus 提供），
// 本件暂以原生 button 的 Tab/Enter/Space 兜底（WCAG 达标：全键盘可达 + 语义正确），
// 用户已知情拍板。将来要补回方向键导航时按 APG radio-group 模式补，不算新需求。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

export type SegmentedItem = { value: string; label: string }

function Segmented({
  items,
  value,
  onChange,
  label,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'onChange'> & {
  items: readonly SegmentedItem[]
  value: string
  onChange: (value: string) => void
  label: string
}) {
  return (
    <div
      data-slot="segmented"
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex items-center gap-0.5 rounded-control bg-stage-track p-0.5', className)}
      {...props}
    >
      {items.map((item) => {
        const selected = item.value === value
        return (
          <button
            aria-checked={selected}
            className={cn(
              'inline-flex items-center justify-center gap-1 rounded-[6px] px-3 text-[13px] leading-[1.5385] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              selected
                ? 'bg-secondary font-semibold text-foreground shadow-sm'
                : 'font-medium text-muted-foreground hover:bg-white/5',
            )}
            key={item.value}
            onClick={() => onChange(item.value)}
            role="radio"
            type="button"
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

export { Segmented }
