// web/src/lib/utils.test.ts：cn() 的两条语义——真值拼接、同族冲突后写赢（twMerge）。
import { describe, it, expect } from 'vitest'
import { cn } from './utils.js'

describe('cn()', () => {
  it('拼接真值类、丢弃假值', () => {
    expect(cn('px-2', false && 'hidden', undefined, 'block')).toBe('px-2 block')
  })

  it('同族冲突后写赢（twMerge 语义）', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4')
  })
})
