// web/src/shell/Sidebar.tsx：左侧栏——产品名 + 扁平四 tab（2026-08-06 重设计：去掉分组标题，
// 全中文 + 极简点线图标）。Task 28 卸 Astryx：SideNav 一族换成本目录的自绘件（./SideNav.js），
// 选中态走 aria-current="page" 属性选择器（文字色 --color-sidebar-active，lime 语义），styles.css
// 底部的 .astryx-side-nav-item 覆写随之退役。登出钮走 shadcn ghost Button。
//
// 2026-08-07（spec §5）：甄别 tab 本轮雪藏——TAB_ICONS 的 triage 键、parked 角标 prop 与
// endContent 一并移除（TAB_ICONS 是 Record<Tab, …>，留着 triage 键会被 TS 判为多余属性）。
// 将来重启用时把 triage 图标键与 parked 角标加回即可（图标组件 TriageIcon 仍在 NavIcons 里）。
// 🟡 2026-08-13 更正：「雪藏」不等于「将来可能删」——它是**明确保留**的。为什么留、
//    什么时候才可以删（可证伪判据 + 机器载体）见 `web/src/triage/TriagePage.tsx` 头注释，
//    那里是正本；本处不重抄。
import { SideNav, SideNavItem } from './SideNav.js'
import { BrandLockup } from './BrandLockup.js'
import { Button } from '../components/ui/button.js'
import { useT } from '../i18n/useT.js'
import { TABS } from './tabs.js'
import type { Tab } from './route.js'
import { api, UNAUTHORIZED_EVENT } from '../api/client.js'
import { TAB_ICONS } from './NavIcons.js'

/** 登出：POST /auth/logout 清 cookie，无论成败都派发 scout:unauthorized——AuthGate 据此重探
 *  auth/status（cookie 已清 → authenticated:false → LoginPage）。finally 保证服务器宕了也切回
 *  login，不卡在已登出的 Shell 上。 */
function logout(): void {
  // finally 保证无论成败都派发事件；尾 catch 吞掉 POST 失败的 rejection（网络错时不留
  // unhandled rejection），登出的 UI 效果由派发的事件驱动，POST 成败不影响切回 login。
  void api.logout().finally(() => window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))).catch(() => {})
}

interface Props {
  tab: Tab
}

// TAB_ICONS（tab → 图标映射）2026-08-27 起移居 NavIcons.tsx 共享——BottomTabBar 成为
// 第二个消费者；Record<Tab,…> 穷尽性论证随定义一起搬过去，本处不重抄。

export function Sidebar({ tab }: Props) {
  const { t } = useT()

  return (
    <SideNav
      header={<BrandLockup />}
      footer={
        <Button variant="ghost" size="sm" onClick={logout}>
          {t('nav_logout')}
        </Button>
      }
    >
      {TABS.map((m) => {
        const Icon = TAB_ICONS[m.id]
        return (
          <SideNavItem
            key={m.id}
            label={t(m.labelKey)}
            href={`#/${m.id}`}
            selected={tab === m.id}
            icon={<Icon />}
          />
        )
      })}
    </SideNav>
  )
}
