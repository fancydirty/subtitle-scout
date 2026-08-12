// web/src/settings/SettingsTabsPage.tsx：Settings 五 tab 容器（spec §2/§6）。
// general/providers/media/security/advanced。providers badge n/8（绿全/黄部分/红全无），
// media badge roots.length===0 时 ⚠ Not configured。默认 general tab。
// 阶段 2：骨架 + badge；阶段 3：接入六区。
import { useState } from 'react'
import type { SettingsDTO, ProviderRowDTO, SetupStatusDTO } from '../api/types.js'
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

/** `setup/status` 的 `providers` 子树——**要么完整，要么根本没到**，没有第三种合法形态。
 *
 *  后端契约（`src/dashboard/setupApi.ts` 的 `buildSetupStatus`）把 `providers` 写成一个
 *  五键对象字面量，`SetupStatusDTO` 里它也是非可选。它不是"可能为空的字段"，是**只要
 *  这个响应存在就必然存在的结构**。
 *
 *  所以这里刻意**不**写 `data?.providers?.subhd?.enabled ?? false`：
 *  那行代码读起来像"providers 可以合法缺席"，而契约说不能。真缺席时它会把 badge 静静
 *  算成 0/8——一个看起来正常、实则在撒谎的界面，比崩页更难查（用户会以为自己的 key 掉了，
 *  跑去重填一遍）。把白屏换成静默错误答案不是修复。
 *
 *  正确的分档：
 *   - `data == null`（未加载完 / 请求失败）→ **合法缺席**，返回 null，调用方按"还不知道"降级。
 *   - `data` 在但 `providers` 缺席/形状不对 → **契约违例**，抛一个说得清是什么事的错误，
 *     由 AppShell 的 PageBoundary 接住 → 这一页降级，侧栏顶栏都还在。
 *
 *  比起原来那句裸解引用抛出的 `Cannot read properties of undefined (reading 'subhd')`，
 *  这条消息在 console 里直接指认是**谁**违约（后端 setup/status）、少了什么。 */
function readProviders(data: SetupStatusDTO | null): SetupStatusDTO['providers'] | null {
  if (data == null) return null
  const p: SetupStatusDTO['providers'] | undefined = data.providers
  if (p == null || p.subhd == null || p.zimuku == null) {
    throw new Error(
      'GET /api/v2/setup/status returned a body without a complete `providers` object ' +
        '(expected providers.subhd and providers.zimuku). This violates SetupStatusDTO.',
    )
  }
  return p
}

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

  // ⚠️ 这里读的是 readProviders 的返回值，**不是**再解引用一次 setupStatus.data。
  // 契约违例在上面那个函数里已经被判成 throw，走到这里的 setupProviders 只有两态：
  // null（还没到）或完整。下面 badge 与卡片区共用同一个值，形状判断只做一次。
  const setupProviders = readProviders(setupStatus.data)

  // badge n/8 实算（spec §2 已配置判据）
  const keyedConfigured = (r: ProviderRowDTO) => r.secrets.length > 0 && r.secrets.every((s) => s.set)
  const keyedCount = keyedRows.filter(keyedConfigured).length
  const translateConfigured = settingsData.data?.ai_translate_enabled === 'true'
  const subhdConfigured = setupProviders?.subhd.enabled ?? false
  const zimukuConfigured = setupProviders?.zimuku.enabled ?? false
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
        {/* 同一个 setupProviders：原先这里写的是 `setupStatus.data && …data.providers.subhd`，
            `data &&` 只挡住了 data 本身，providers 缺席时照样在这三行里抛——与 badge 那两行
            是同一个缺陷的第二、三、四处。收敛到一个已判形状的值上，缺陷就没有第二个入口。 */}
        {setupProviders && (
          <>
            <ProviderToggleCard id="subhd" state={setupProviders.subhd} reload={setupStatus.reload} />
            <ProviderToggleCard id="zimuku" state={setupProviders.zimuku} reload={setupStatus.reload} />
            {setupProviders.zimuku.enabled && (
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