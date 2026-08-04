// web/src/settings/SettingsPage.tsx：Settings tab 主体——行为区（即时单键 PUT）+ 翻译区 +
// Providers 区（打码/编辑/Test，spec A §5.4）+ 部署区（只读非密 env）+ 守备目录管理器 +
// System 区（Re-run wizard）+ 安全区。各数据面独立拉取（useSettings/useDeploySettings/
// useRoots/useSetupProviders/useSetupStatus，一次性或 15s 轮询，见各 hook 头注），
// 各 section 组件各自处理自己的 loading/empty/error 三态（DESIGN.md 铁律），互不阻塞彼此渲染。
import { useState } from 'react'
import { useSettings, useDeploySettings, useRoots, useSetupProviders, useSetupStatus } from '../api/hooks.js'
import { BehaviorSection } from './BehaviorSection.js'
import { TranslateSection } from './TranslateSection.js'
import { ProvidersSection } from './ProvidersSection.js'
import { DeploySection } from './DeploySection.js'
import { RootsManager } from './RootsManager.js'
import { SystemSection } from './SystemSection.js'
import { SecuritySection } from './SecuritySection.js'
import type { SettingsDTO } from '../api/types.js'

export function SettingsPage() {
  const settings = useSettings()
  const deploy = useDeploySettings()
  const roots = useRoots()
  const providers = useSetupProviders()
  const setupStatus = useSetupStatus()
  // BehaviorSection 的种子同步已自备;TranslateSection 的开关回写同样直取响应体(与
  // BehaviorSection 的 onUpdated 同一语义:响应即新事实,不重新 GET)。
  const [updated, setUpdated] = useState<SettingsDTO | null>(null)
  const settingsData = updated != null ? { ...settings, data: updated } : settings

  return (
    <div className="flex flex-col gap-8">
      <BehaviorSection settings={settingsData} />
      <TranslateSection settings={settingsData} deploy={deploy} onUpdated={setUpdated} />
      <ProvidersSection providers={providers} setupStatus={setupStatus} />
      <DeploySection deploy={deploy} />
      <RootsManager roots={roots} />
      <SystemSection />
      {/* 安全区排最后——低频人工操作（改密/换 key），不抢常用设置的视觉序位。 */}
      <SecuritySection />
    </div>
  )
}
