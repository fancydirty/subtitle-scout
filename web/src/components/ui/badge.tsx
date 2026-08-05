// web/src/components/ui/badge.tsx：shadcn/ui Badge（new-york，v4）copy-in。
// 本仓改造：相对 import + .js 后缀；删 dark: 变体；保留 shadcn 原 rounded-md（Badge 是小方角标签，
// 不进本仓 card/control 两档圆角体系）。唯一调用点是 Task 11 的 tool.tsx。
// success/warning 变体供 SettingsTabsPage 的 tab badge 用，token 取 fn-green/fn-amber
// （与 SettingsCard 三态 badge 同口径，但 SettingsCard 用 outline+className 覆盖；
// 此处给 Tab badge 一个独立变体方便 variant prop 直接用）。
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils.js'

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium transition-colors [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-border text-foreground',
        success: 'border-transparent bg-fn-green/15 text-fn-green',
        warning: 'border-transparent bg-fn-amber/15 text-fn-amber',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
