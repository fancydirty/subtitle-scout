// web/src/settings/SettingsTabsPage.tsx：Settings 五 tab 容器（spec §2/§6）。
// general/providers/media/security/advanced。providers badge n/8（绿全/黄部分/红全无），
// media badge roots.length===0 时 ⚠ Not configured。默认 general tab。
// 阶段 2：骨架 + badge；阶段 3：接入六区。
import { useState } from 'react'
import type { SettingsDTO, ProviderRowDTO } from '../api/types.js'
import { useSettings, useDeploySettings, useRoots, useSetupProviders, useSetupStatus } from '../api/hooks.js'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs.js'
import { Badge } from '../components/ui/badge.js'
import { BehaviorSection } from './BehaviorSection.js'
import { ProviderCard } from './ProviderCard.js'
import { ProviderToggleCard } from './ProviderToggleCard.js'
import { TranslateCard } from './TranslateCard.js'
import { ZimukuVisionCard } from './ZimukuVisionCard.js'
import { RootsManager } from './RootsManager.js'
import { SecuritySection } from './SecuritySection.js'
import { DeploySection } from './DeploySection.js'
import { SystemSection } from './SystemSection.js'

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

  // providers tab：八卡片（spec §4.2 顺序 TMDB/LLM/AI翻译/ASSRT/OpenSubtitles/Jimaku/subhd/zimuku）
  const rows = providers.data?.providers ?? []
  const translateRow = rows.find((r) => r.id === 'translate')
  const llmRow = rows.find((r) => r.id === 'llm')
  const keyedRows = rows.filter((r) => r.secrets.length > 0 && r.id !== 'translate')

  // badge n/8 实算（spec §2 已配置判据）
  const keyedConfigured = (r: ProviderRowDTO) => r.secrets.length > 0 && r.secrets.every((s) => s.set)
  const keyedCount = keyedRows.filter(keyedConfigured).length
  const translateConfigured = settingsData.data?.ai_translate_enabled === 'true'
  const subhdConfigured = setupStatus.data?.providers.subhd.enabled ?? false
  const zimukuConfigured = setupStatus.data?.providers.zimuku.enabled ?? false
  const configuredCount: number = keyedCount + (translateConfigured ? 1 : 0) + (subhdConfigured ? 1 : 0) + (zimukuConfigured ? 1 : 0)
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
        {keyedRows.map((row) => (
          <div key={row.id} className="space-y-6">
            <ProviderCard row={row} reload={providers.reload} />
            {row.id === 'llm' && translateRow && llmRow && (
              <TranslateCard
                translate={translateRow}
                llm={llmRow}
                settings={settingsData.data ?? ({} as SettingsDTO)}
                deploy={deploy.data}
                onUpdated={setUpdated}
                reload={providers.reload}
              />
            )}
          </div>
        ))}
        {setupStatus.data && (
          <>
            <ProviderToggleCard id="subhd" state={setupStatus.data.providers.subhd} reload={setupStatus.reload} />
            <ProviderToggleCard id="zimuku" state={setupStatus.data.providers.zimuku} reload={setupStatus.reload} />
            {setupStatus.data.providers.zimuku.enabled && (
              <ZimukuVisionCard reload={setupStatus.reload} />
            )}
          </>
        )}
      </TabsContent>
      <TabsContent value="media" className="p-6 space-y-6">
        <RootsManager roots={roots} />
      </TabsContent>
      <TabsContent value="security" className="p-6 space-y-6">
        <SecuritySection />
      </TabsContent>
      <TabsContent value="advanced" className="p-6 space-y-6">
        <DeploySection deploy={deploy} />
        <SystemSection />
      </TabsContent>
    </Tabs>
  )
}