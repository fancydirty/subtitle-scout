// web/src/shell/route.ts：新外壳的 hash 路由——四 tab（#/library #/workflow #/triage #/settings），
// 浏览器原生前进后退可用（location.hash 变化即触发 hashchange，无需自己维护历史栈）。
// 故意与旧 lib/hashRoute.ts（海报墙/详情/历史/park 那一套）分开：旧路由服务的老 components/
// 本任务不删（后续 F3-F6 逐个 tab 填肉时才会把老页面换掉），两套路由并存互不干扰。
import { useEffect, useState } from 'react'

export type Tab = 'library' | 'workflow' | 'triage' | 'settings'

const TAB_IDS: readonly Tab[] = ['library', 'workflow', 'triage', 'settings']

function isTab(value: string): value is Tab {
  return (TAB_IDS as readonly string[]).includes(value)
}

/** hash → tab，未识别/根路径一律落到 library（第一个 tab，也是产品默认落地页）。 */
export function parseShellHash(hash: string): Tab {
  const raw = hash.replace(/^#\/?/, '').split('/')[0]
  return isTab(raw) ? raw : 'library'
}

export function useShellRoute(): Tab {
  const [tab, setTab] = useState<Tab>(() => parseShellHash(location.hash))
  useEffect(() => {
    const onHash = () => setTab(parseShellHash(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return tab
}

/** 程序化跳转——CommandK 选中项时用。侧栏/面包屑走 <a href="#/xxx">，交给浏览器原生处理即可，
 *  不需要这个函数。 */
export function go(tab: Tab): void {
  location.hash = `/${tab}`
}
