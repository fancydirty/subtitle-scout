// web/src/settings/SettingsPage.tsx：Settings tab 主体（dashboard-F6）——行为区（即时单键 PUT）+
// 部署区（只读脱敏展示）+ 守备目录管理器（AlertDialog 删根 + 目录浏览器加根）。三块数据面各自
// 独立拉取（useSettings/useDeploySettings/useRoots，均一次性 + 手动 reload，同 useTriage/
// useParked 的既有先例：这些都是低频人工动作，不需要常驻轮询），三个 section 组件各自处理自己
// 的 loading/empty/error 三态（DESIGN.md 铁律），互不阻塞彼此渲染。
import { VStack } from '@astryxdesign/core/VStack'
import { useSettings, useDeploySettings, useRoots } from '../api/hooks.js'
import { BehaviorSection } from './BehaviorSection.js'
import { DeploySection } from './DeploySection.js'
import { RootsManager } from './RootsManager.js'
import { SecuritySection } from './SecuritySection.js'

export function SettingsPage() {
  const settings = useSettings()
  const deploy = useDeploySettings()
  const roots = useRoots()

  return (
    <VStack gap={8}>
      <BehaviorSection settings={settings} />
      <DeploySection deploy={deploy} />
      <RootsManager roots={roots} />
      {/* 安全区排最后——低频人工操作（改密/换 key），不抢常用设置的视觉序位。 */}
      <SecuritySection />
    </VStack>
  )
}
