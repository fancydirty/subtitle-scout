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
import { SideNav, SideNavHeading, SideNavItem } from './SideNav.js'
import { Button } from '../components/ui/button.js'
import { useT } from '../i18n/useT.js'
import { TABS } from './tabs.js'
import type { Tab } from './route.js'
import { api, UNAUTHORIZED_EVENT } from '../api/client.js'
import {
  SettingsIcon, ActivityIcon, NotificationsIcon, MediaIcon,
} from './NavIcons.js'

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

/** tab → 图标组件映射（2026-08-06：极简点线风格）。
 *  **`Record<Tab, …>` 是穷尽的**——少一个键 TS 就报错，多一个键也报错（多余属性）。
 *  Task ⑪ 起 `Tab` 就是导航四项（旧 library/workflow 随页面移入 `_legacy/`，它们的
 *  两个键与 import 在本次一并删除；`NavIcons.tsx` 里的 LibraryIcon/WorkflowIcon 组件
 *  本体保留——同 TriageIcon 的既有处置，图标是无依赖的纯 SVG，重启用时不必重画）。 */
const TAB_ICONS: Record<Tab, React.ComponentType> = {
  activity: ActivityIcon,
  notifications: NotificationsIcon,
  media: MediaIcon,
  settings: SettingsIcon,
}

export function Sidebar({ tab }: Props) {
  const { t } = useT()

  return (
    <SideNav
      header={<SideNavHeading heading={t('brand_name')} />}
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
