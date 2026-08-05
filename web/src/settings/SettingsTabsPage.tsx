// web/src/settings/SettingsTabsPage.tsx：Settings 五 tab 容器（spec §2/§6）。
// general/providers/media/security/advanced。providers badge n/8（绿全/黄部分/红全无），
// media badge roots.length===0 时 ⚠ Not configured。默认 general tab。
// 阶段 2：骨架 + badge；阶段 3：接入六区。
import { useState } from 'react'
import type { SettingsDTO } from '../api/types.js'
import { useSettings, useDeploySettings, useRoots, useSetupProviders, useSetupStatus } from '../api/hooks.js'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs.js'
import { Badge } from '../components/ui/badge.js'
import { BehaviorSection } from './BehaviorSection.js'

export function SettingsTabsPage() {
  const settings = useSettings()
  const deploy = useDeploySettings()
  const roots = useRoots()
  const providers = useSetupProviders()
  const setupStatus = useSetupStatus()

  // BehaviorSection 的种子同步已自备；TranslateSection 的开关回写同样直取响应体。
  // updated 是 settings 的本地覆盖（单键 PUT 成功后直拿响应体，不重新 GET）。
  const [updated, setUpdated] = useState<SettingsDTO | null>(null)
  const settingsData = updated != null ? { ...settings, data: updated } : settings

  // providers badge: n/8（八张卡片：TMDB/LLM/AI翻译/ASSRT/OpenSubtitles/Jimaku/subhd/zimuku）
  // 阶段 2 占位 0；阶段 3 接入六区后实算。const + 类型标注避开 const-0 与 8 无 overlap 的 TS2367。
  const configuredCount: number = 0
  const providerBadgeVariant = configuredCount === 8 ? 'success' : configuredCount === 0 ? 'destructive' : 'warning'
  const mediaUnconfigured = (roots.data?.length ?? 0) === 0

  return (
    <Tabs defaultValue="general" className="w-full">
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="providers">
          Providers
          <Badge variant={providerBadgeVariant} className="ml-1">{configuredCount}/8</Badge>
        </TabsTrigger>
        <TabsTrigger value="media">
          Media
          {mediaUnconfigured ? <Badge variant="warning" className="ml-1">⚠ Not configured</Badge> : null}
        </TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
        <TabsTrigger value="advanced">Advanced</TabsTrigger>
      </TabsList>

      <TabsContent value="general" className="p-6 space-y-6">
        <BehaviorSection settings={settingsData} />
      </TabsContent>
      <TabsContent value="providers" className="p-6 space-y-6">
        {/* 阶段 3：ProviderCard × 6 + TranslateCard + ProviderToggleCard × 2 */}
      </TabsContent>
      <TabsContent value="media" className="p-6 space-y-6">
        {/* 阶段 3：RootsManager */}
      </TabsContent>
      <TabsContent value="security" className="p-6 space-y-6">
        {/* 阶段 3：SecuritySection */}
      </TabsContent>
      <TabsContent value="advanced" className="p-6 space-y-6">
        {/* 阶段 3：DeploySection + SystemSection */}
      </TabsContent>
    </Tabs>
  )
}