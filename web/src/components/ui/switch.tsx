// web/src/components/ui/switch.tsx：shadcn/ui Switch（v4）copy-in。
// 有意适配：checked 底色 = --color-fn-green（发动机"开"的语义色），非 shadcn 默认 primary。
import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '../../lib/utils.js'

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent outline-none transition-colors',
        'data-[state=checked]:bg-fn-green data-[state=unchecked]:bg-input',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-foreground shadow ring-0 transition-transform',
          'data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-[2px]',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
