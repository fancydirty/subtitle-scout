// web/src/shell/Sidebar.tsx：左侧栏——产品名 + 三个 uppercase mono 分区（LIBRARY/AGENTS/SYSTEM）
// + 四个 tab 项。Task 28 卸 Astryx：SideNav 一族换成本目录的自绘件（./SideNav.js），选中态
// 走 aria-current="page" 属性选择器（文字色 --color-sidebar-active，lime 语义），styles.css
// 底部的 .astryx-side-nav-item 覆写随之退役。登出钮走 shadcn ghost Button。
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from './SideNav.js'
import { Button } from '../components/ui/button.js'
import { useT } from '../i18n/useT.js'
import { SECTIONS, TABS } from './tabs.js'
import type { Tab } from './route.js'
import { api, UNAUTHORIZED_EVENT } from '../api/client.js'

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
  /** 甄别角标（parked 计数）：undefined＝还没有数据（loading/error/未知），此时不渲染角标——
   *  "无数据时不显示角标"是任务规格明确要求的降级形态，不是漏写。 */
  parked: number | undefined
}

export function Sidebar({ tab, parked }: Props) {
  const { t } = useT()

  return (
    <SideNav
      header={<SideNavHeading heading="subtitle-scout" />}
      footer={
        <Button variant="ghost" size="sm" onClick={logout}>
          {t('nav_logout')}
        </Button>
      }
    >
      {SECTIONS.map((section) => (
        <SideNavSection key={section} title={section}>
          {TABS.filter((m) => m.section === section).map((m) => (
            <SideNavItem
              key={m.id}
              label={t(m.labelKey)}
              href={`#/${m.id}`}
              selected={tab === m.id}
              endContent={
                m.id === 'triage' && parked != null ? (
                  <span className="text-xs text-muted-foreground">{parked}</span>
                ) : undefined
              }
            />
          ))}
        </SideNavSection>
      ))}
    </SideNav>
  )
}
