// web/src/shell/Sidebar.tsx：左侧栏——产品名 + 三个 uppercase mono 分区（LIBRARY/AGENTS/SYSTEM）
// + 四个 tab 项。当前项高亮＝本屏唯一 accent 使用点：SideNavItem 的 isSelected 默认只给中性灰底
// （组件自己的 navItemStyles.selected 读 --color-neutral，不是 accent），组件又没留 xstyle
// 逃生口（BaseProps 类型上有但渲染函数逐参数解构、运行时吞掉）——只能在 styles.css 里用
// Astryx 自己输出的稳定 data-selected 选择器把文字色点成 --color-accent，见该文件底部注释。
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav'
import { Text } from '@astryxdesign/core/Text'
import { useT } from '../i18n/useT.js'
import { SECTIONS, TABS } from './tabs.js'
import type { Tab } from './route.js'

interface Props {
  tab: Tab
  /** 甄别角标（parked 计数）：undefined＝还没有数据（loading/error/未知），此时不渲染角标——
   *  "无数据时不显示角标"是任务规格明确要求的降级形态，不是漏写。 */
  parked: number | undefined
}

export function Sidebar({ tab, parked }: Props) {
  const { t } = useT()

  return (
    <SideNav header={<SideNavHeading heading="subtitle-scout" />}>
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
