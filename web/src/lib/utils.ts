// web/src/lib/utils.ts：shadcn 惯例的 cn()——条件拼接（clsx）+ Tailwind 同族冲突合并
// （twMerge，后写赢）。所有 copy-in 组件与自绘件的 className 合成唯一入口。
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
