// web/src/components/ui/skeleton.tsx：shadcn/ui Skeleton copy-in，但**行为取自 Astryx**
// （node_modules/@astryxdesign/core/src/Skeleton/Skeleton.tsx:32-71），因为本仓五个调用点
// （SeriesGrid.tsx:37/39、SeriesPage.tsx:37/40/41）依赖的是 Astryx 的交错延迟语义：
//   DELAY_TIME=1000ms 起播（快速加载时根本不闪骨架）+ STAGGER_TIME=100ms × index 逐个错开。
//   SeriesPage 的三个调用点不传 index，吃默认 0 → 延迟 1000ms，与 Astryx 原件的默认值一致。
// shadcn 原版只有一句 animate-pulse，没有 delay/stagger，直接用会把这个语义丢掉。
// 动画本体是 tw.css 的 --animate-skeleton-fade（550ms steps(10,end) infinite alternate，
// keyframes 0.25 → 1），逐字复刻 Astryx。
//
// 三处有意的取舍（审计对照 Astryx 原件时会看到差异，都是明知故犯）：
// 1. 底色用 --color-faint (#4b5563)，不用 Astryx scout 暗色 --color-skeleton (#44483C)。
//    #44483C 是橄榄色（68,72,60），是 Astryx 主题的遗留色调；新栈调色板（spec §5.1）里没有
//    橄榄色，而 #4b5563（75,85,99）明度基本相当、色相中性。换的是色相，不是明度。
// 2. 不实现 Astryx 的 @media (prefers-contrast: more) 提对比分支——本仓无高对比需求登记，YAGNI。
// 3. **不给默认圆角**。本仓五个调用点全部显式传 radius（radius={2}=8px / radius={1}=4px），
//    换栈后改为传 className；如果组件里再写一个默认 rounded-card，"谁赢"就取决于 tailwind-merge
//    是否把自定义 radius 后缀（card / control）识别成同一冲突组——v3 对非 t-shirt-size 的自定义
//    后缀不保证合并，赌不起。所以圆角一律由调用点给。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

const DELAY_MS = 1000
const STAGGER_MS = 100

function Skeleton({
  className,
  index = 0,
  style,
  ...props
}: React.ComponentProps<'div'> & { index?: number }) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-skeleton-fade bg-faint opacity-25 motion-reduce:animate-none', className)}
      style={{ animationDelay: `${DELAY_MS + STAGGER_MS * index}ms`, ...style }}
      {...props}
    />
  )
}

export { Skeleton }
