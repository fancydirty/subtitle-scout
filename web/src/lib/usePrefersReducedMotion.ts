/**
 * 读 prefers-reduced-motion 媒体查询，并跟随变化。
 *
 * 为什么不用 motion 自带的 useReducedMotion()：那个实现在模块作用域初始化时就把偏好
 * 读进缓存（import 时跑一次），测试里事后替换 window.matchMedia 换不动它——依赖它会让
 * "reduced-motion 下退回纯文本"这个分支变成不可测、且依赖 import 顺序的代码。
 *
 * mount 时现读 matchMedia（useState 惰性初始化，每次挂载只读一次），live 更新靠 change
 * 事件订阅跟随（用户在系统设置里现场改也能跟上）。
 * SSR / 没有 matchMedia 的环境返回 false（不减少动效），与浏览器默认一致。
 */
import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function read(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(QUERY).matches
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(QUERY)
    // mount 读（useState 初始化）到订阅挂上之间偏好可能正好变了——订阅前先对一次账，
    // 补上这个窄窗口。
    setReduced(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    // pre-14 Safari 的 MQL 只有 addListener：可选调用下 change 事件静默不到，mount 读仍正确；
    // 本仓 Vite 7 baseline 不含那些浏览器，接受此缺口。
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}
