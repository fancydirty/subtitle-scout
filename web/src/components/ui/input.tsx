// web/src/components/ui/input.tsx：shadcn/ui Input（v4）copy-in，相对 import 适配。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-control border border-input bg-transparent px-3 py-1 text-sm text-foreground outline-none transition-colors',
        'placeholder:text-weak focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
