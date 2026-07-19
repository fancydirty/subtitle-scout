// web/src/shell/Sidebar.tsx：左侧栏——产品名 + 三个 uppercase mono 分区（LIBRARY/AGENTS/SYSTEM）
// + 四个 tab 项。当前项高亮＝本屏唯一 accent 使用点：SideNavItem 的 isSelected 默认只给中性灰底
// （组件自己的 navItemStyles.selected 读 --color-neutral，不是 accent），组件又没留 xstyle
// 逃生口（BaseProps 类型上有但渲染函数逐参数解构、运行时吞掉）——只能在 styles.css 里用
// Astryx 自己输出的稳定 data-selected 选择器把文字色点成 --color-accent，见该文件底部注释。
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
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
      footer={<Button size="sm" variant="ghost" label={t('nav_logout')} onClick={logout} />}
    >
      {SECTIONS.map((section) => (
        <SideNavSection key={section} title={section}>
          {TABS.filter((m) => m.section === section).map((m) => (
            <SideNavItem
              key={m.id}
              label={t(m.labelKey)}
              href={`#/${m.id}`}
              isSelected={tab === m.id}
              endContent={
                m.id === 'triage' && parked != null ? (
                  <Text type="supporting" color="secondary">
                    {parked}
                  </Text>
                ) : undefined
              }
            />
          ))}
        </SideNavSection>
      ))}
    </SideNav>
  )
}
