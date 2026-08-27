// web/src/shell/BottomTabBar.tsx：<768px 的底部 tab 导航——tabs.ts 注册表的第三个消费者
//（侧栏、⌘K 之后），图标/路由/选中语义与侧栏同源同款：href="#/<id>" + aria-current="page"
// + 选中色 --color-sidebar-active。与 SideNav 靠断点互斥（本件 md:hidden，SideNav hidden md:flex），
// 永不同屏。spec：docs/superpowers/specs/2026-08-27-mobile-bottom-nav-design.md。
import { useT } from '../i18n/useT.js'
import { TABS } from './tabs.js'
import type { Tab } from './route.js'
import { TAB_ICONS } from './NavIcons.js'

export function BottomTabBar({ tab }: { tab: Tab }) {
  const { t } = useT()
  return (
    <nav
      aria-label={t('a11y_bottom_nav')}
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {TABS.map((m) => {
        const Icon = TAB_ICONS[m.id]
        return (
          <a
            key={m.id}
            href={`#/${m.id}`}
            aria-current={tab === m.id ? 'page' : undefined}
            className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] leading-4 text-muted-foreground transition-colors aria-[current=page]:text-[var(--color-sidebar-active)]"
          >
            <Icon />
            <span>{t(m.labelKey)}</span>
          </a>
        )
      })}
    </nav>
  )
}
