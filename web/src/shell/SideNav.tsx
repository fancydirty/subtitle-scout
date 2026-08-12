// web/src/shell/SideNav.tsx：自绘导航件（Astryx SideNav 无新栈对应物，Task 28 卸 Astryx 时亲笔）。
// 契约：item 是 <a>（App.test.tsx 的 findByRole('link', { name: 'Library' }) 靠它）；
// 选中态走 aria-current="page"（比 data-selected 更正确的语义，样式按属性选）。
//
// 几何逐值对齐 Astryx SideNav（node_modules/@astryxdesign/core/src/SideNav/SideNav.tsx:59-130）：
// 根 260px 宽 flex column 满高；header 粘顶、footer 粘底带发丝线顶边（Astryx stickyBottom 的
// borderBlockStart）；中段可滚。item 高 32px（py-1.5 + leading-5 = Astryx --size-element-md）。
//
// 选中态文字色用 --color-sidebar-active（lime 语义，tw.css:34——"当前页"是每屏唯一亮色配额），
// 不是 --color-accent：后者被 scout.css:86 遮蔽成柠檬绿 #96DA26，过渡期撞车铁律（名值两查
// 已打 0：sidebar-active 在 scout.css 零出现）。选中背景仍 bg-secondary。
// 2026-08-13 清理：`import { useId } from 'react'` 已删（零调用）。核对过它不是"漏接的
// 无障碍属性"：本组件的 <nav> 用的是静态 `aria-label="Side navigation"`（:23），选中态走
// `aria-current="page"`（:51），两者都不需要生成 id；也没有任何 label/aria-labelledby 配对
// 在等一个 id。属于纯残留，不是 a11y 缺口。
import type { ReactNode } from 'react'

interface SideNavProps {
  header?: ReactNode
  footer?: ReactNode
  children?: ReactNode
}

export function SideNav({ header, footer, children }: SideNavProps) {
  return (
    <nav aria-label="Side navigation" className="flex h-full w-[260px] shrink-0 flex-col">
      {header ? <div className="flex flex-col gap-2 px-2 py-2">{header}</div> : null}
      <div className="flex-1 overflow-y-auto px-2 py-1">{children}</div>
      {footer ? <div className="mt-auto border-t border-border px-2 pb-2 pt-1">{footer}</div> : null}
    </nav>
  )
}

/** 产品 wordmark——Astryx SideNavHeading 的等价物（17px semibold，--text-large-size/
 *  --font-weight-semibold 的逐值平移）。 */
export function SideNavHeading({ heading }: { heading: string }) {
  return <div className="px-3 py-1 text-[17px] font-semibold leading-6 text-foreground">{heading}</div>
}

interface SideNavItemProps {
  href: string
  label: string
  selected?: boolean
  /** 行首图标（2026-08-06：极简点线风格）。 */
  icon?: ReactNode
  /** 行尾槽（甄别角标等）。无数据时调用方传 undefined——"无数据不显示角标"是规格降级形态。 */
  endContent?: ReactNode
}

export function SideNavItem({ href, label, selected, icon, endContent }: SideNavItemProps) {
  return (
    <a
      href={href}
      aria-current={selected ? 'page' : undefined}
      className="flex items-center gap-3 rounded-control px-3 py-1.5 text-[13px] leading-5 text-muted-foreground transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring aria-[current=page]:bg-secondary aria-[current=page]:text-[var(--color-sidebar-active)]"
    >
      {icon && <span className="flex-shrink-0">{icon}</span>}
      <span className="flex-1">{label}</span>
      {endContent}
    </a>
  )
}
