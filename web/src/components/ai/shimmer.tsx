// AI Elements shimmer 的 copy-in。四处记录在案的偏离见 Plan C 任务 10。
//
// **最要紧的一条：高光色是 --color-foreground，不是官方源的 --color-background。**
// 官方源假设浅色主题（白底/灰字/白色高光扫过）；本仓恒暗色，--color-background 是 #0b0c0f，
// 照抄会变成一条近黑的暗带扫过 #9aa1ac 的字，比不动还暗——而 spec §5.3 要的是传送带最新行
// 读起来最亮。将来若有人"照官方源修回去"，请先读这段。
//
// 另外三处：① 去掉 as 多态、固定 motion.span（官方源在渲染体里 motion.create()，每渲染都产出
// 新组件类型，会让 DOM 节点反复卸载重建，传送带每条 trace 事件都重渲染，抖动是真实的）；
// ② duration/spread 两个 prop 降为常量（零调用点传）；③ 抽出 shimmerSpreadPx 便于直接断言。
import { memo, useMemo, type CSSProperties } from 'react'
import { motion } from 'motion/react'
import { cn } from '../../lib/utils.js'

// 每字符摊 2px 高光宽度：短语越长亮带越宽，观感才一致。官方源 spread 的默认值。
const SPREAD_PER_CHAR = 2
// 一轮扫动 2 秒、linear、无限循环。官方源 duration 的默认值。
const DURATION_SECONDS = 2

export function shimmerSpreadPx(text: string): number {
  return text.length * SPREAD_PER_CHAR
}

export type ShimmerProps = {
  children: string
  className?: string
}

const ShimmerComponent = ({ children, className }: ShimmerProps) => {
  const spread = useMemo(() => shimmerSpreadPx(children), [children])

  return (
    <motion.span
      animate={{ backgroundPosition: '0% center' }}
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
        '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-foreground),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      style={
        {
          '--spread': `${spread}px`,
          backgroundImage:
            'var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
        } as CSSProperties
      }
      transition={{ repeat: Number.POSITIVE_INFINITY, duration: DURATION_SECONDS, ease: 'linear' }}
    >
      {children}
    </motion.span>
  )
}

export const Shimmer = memo(ShimmerComponent)
