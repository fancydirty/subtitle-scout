// web/src/settings/SettingsTabsPage.tsx：设置页四 tab——通用 / 字幕源 / 媒体目录 / 安全。
// Advanced/Deploy 已删除：env 与部署层不是人类设置页的内容。
import { useState } from 'react'
import type { SettingsDTO, ProviderRowDTO, SetupStatusDTO } from '../api/types.js'
import { useSettings, useRoots, useSetupProviders, useSetupStatus } from '../api/hooks.js'
import { isContractViolation } from '../api/contract.js'
import { useT } from '../i18n/useT.js'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs.js'
import { Badge } from '../components/ui/badge.js'
import { BehaviorSection } from './BehaviorSection.js'
import { ProviderCard } from './ProviderCard.js'
import { ProviderToggleCard } from './ProviderToggleCard.js'
import { TranslateCard } from './TranslateCard.js'
import { ZimukuVisionCard } from './ZimukuVisionCard.js'
import { RootsManager } from './RootsManager.js'
import { SecuritySection } from './SecuritySection.js'
import { SystemSection } from './SystemSection.js'
import { parseTargets, deriveVisibleRows, groupSourceRows, type SourceGroup } from './sourceDerivation.js'
import { TARGET_LANGUAGE_AUTONYMS } from './text.js'

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
 *   - `data == null` **且** 不是契约违例（未加载完 / 网络失败）→ **合法缺席**，返回 null，
 *     调用方按"还不知道"降级。
 *   - `data == null` **但** error 是契约违例 → 见下方 §两条路，同样要抛。
 *   - `data` 在但 `providers` 缺席/形状不对 → **契约违例**，抛一个说得清是什么事的错误，
 *     由 AppShell 的 PageBoundary 接住 → 这一页降级，侧栏顶栏都还在。
 *
 *  比起原来那句裸解引用抛出的 `Cannot read properties of undefined (reading 'subhd')`，
 *  这条消息在 console 里直接指认是**谁**违约（后端 setup/status）、少了什么。
 *
 *  ── §两条路：为什么加了 API 边界校验之后**这个函数仍然不能删** ────────────────
 *  `api/contract.ts` 现在会在 `get()` 里先校验一遍 `SETUP_STATUS_SHAPE`，于是违约有了
 *  **两条**可能的到达路径，两条都得堵：
 *
 *   路径 A（边界拦下）：`get()` 抛 → `useSetupStatus` 的 catch → `error` 字符串，
 *     而 `data` 保持 **null**。⚠️ 如果这里只看 `data == null` 就返回 null，那条违约会被
 *     当成"还没加载完"**静静吞掉**，badge 渲染 0/8——一句谎话（"一个源都没配"），
 *     而真相是"不知道"。**这是实测撞出来的**：只加边界校验、不改这里时，
 *     `AppShell.boundary.test.tsx` 立刻变红，因为原本诚实的页面降级退化成了静默 0/8。
 *     故这里读 `error` 并用 `isContractViolation` 把它与网络失败分开——网络失败照旧
 *     降级（那是正常路径，daemon 没起时天天发生），只有违约才抛。
 *
 *   路径 B（边界放过、消费点发现）：契约声明是**只声明致命路径上的键**的（见
 *     contracts.ts 的论证），`SETUP_STATUS_SHAPE` 只覆盖 subhd/zimuku 两支。将来这里
 *     要读第三支时，边界不认识它，仍然只有这个函数能发现。
 *
 *  两道**不是冗余**：A 道知道"形状不对"，B 道知道"`null` 的 data 在语义上意味着什么"
 *  ——后者是消费点才有的知识，契约层永远不会有。 */
function readProviders(
  data: SetupStatusDTO | null,
  error: string | null,
): SetupStatusDTO['providers'] | null {
  if (data == null) {
    // 路径 A：后端违约（边界拦下）。**不许**与"还没加载完"合流——见上方论证。
    if (isContractViolation(error)) throw new Error(error ?? '')
    return null
  }
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
  const { t } = useT()
  const settings = useSettings()
  const roots = useRoots()
  const providers = useSetupProviders()
  const setupStatus = useSetupStatus()

  // BehaviorSection 的种子同步已自备；TranslateSection 的开关回写同样直取响应体。
  // updated 是 settings 的本地覆盖（单键 PUT 成功后直拿响应体，不重新 GET）。
  const [updated, setUpdated] = useState<SettingsDTO | null>(null)
  const settingsData = updated != null ? { ...settings, data: updated } : settings

  // providers tab（registry spec §5.1）：行集合按 target_languages **派生**——infra
  // （TMDB/LLM/AI翻译）恒在，源行只留语言命中的（zh 用户看不见 jimaku，en 用户看不见
  // assrt/subhd/zimuku/r3sub）。x/N 的 N 就是这个派生集合的大小，8 的字面量从此退役。
  const rows = providers.data?.providers ?? []
  const targetsCsv = settingsData.data?.target_languages ?? null
  const targets = parseTargets(targetsCsv)
  const visibleRows = deriveVisibleRows(rows, targetsCsv)
  const translateRow = visibleRows.find((r) => r.id === 'translate')
  // infra 凭据卡（tmdb/llm）——translate 在 llm 卡下面由 TranslateCard 专渲染。
  const infraRows = visibleRows.filter((r) => r.kind === 'infra' && r.id !== 'translate')
  // 源分组：单语言一个 'all' 组（平铺，无标题）；多语言按「语言专属 × 通用」分 section。
  const sourceGroups = groupSourceRows(rows, targets)
  const visibleSources = sourceGroups.flatMap((g) => g.rows)

  // ⚠️ 这里读的是 readProviders 的返回值，**不是**再解引用一次 setupStatus.data。
  // 契约违例在上面那个函数里已经被判成 throw，走到这里的 setupProviders 只有两态：
  // null（还没到）或完整。下面 badge 与卡片区共用同一个值，形状判断只做一次。
  const setupProviders = readProviders(setupStatus.data, setupStatus.error)

  // badge n/N 实算（spec §2 已配置判据不变；N=派生集合大小）。
  // "keyed 凭据卡" 判据仍须显式排除 zimuku：它带着三个 ZIMUKU_VISION_*（视觉兜底），
  // 但本体是开关型源（enabled 才算配好），secrets 全 set 不是它的配好判据。
  const keyedConfigured = (r: ProviderRowDTO) => r.secrets.length > 0 && r.secrets.every((s) => s.set)
  const keyedCount = [...infraRows, ...visibleSources]
    .filter((r) => r.id !== 'subhd' && r.id !== 'zimuku')
    .filter(keyedConfigured).length
  const translateConfigured =
    settingsData.data?.ai_translate_enabled === 'true' &&
    Boolean(translateRow && translateRow.secrets.every((s) => s.set))
  const subhdVisible = visibleSources.some((r) => r.id === 'subhd')
  const zimukuVisible = visibleSources.some((r) => r.id === 'zimuku')
  const subhdConfigured = subhdVisible && (setupProviders?.subhd.enabled ?? false)
  const zimukuConfigured = zimukuVisible && (setupProviders?.zimuku.enabled ?? false)
  const configuredCount: number = keyedCount + (translateConfigured ? 1 : 0) + (subhdConfigured ? 1 : 0) + (zimukuConfigured ? 1 : 0)
  const providerTotal = visibleRows.length
  const providerBadgeVariant = configuredCount === providerTotal ? 'success' : configuredCount === 0 ? 'destructive' : 'warning'
  const mediaUnconfigured = (roots.data?.length ?? 0) === 0

  const groupTitle = (lang: SourceGroup['lang']): string =>
    lang === 'universal'
      ? t('settings_sources_group_universal')
      : (TARGET_LANGUAGE_AUTONYMS as Record<string, string>)[lang] ?? lang

  /** 一张源卡：subhd/zimuku 是开关卡（zimuku 开启时附视觉兜底卡），其余走通用凭据卡。
   *  setupProviders 未到时开关卡不渲染（与旧版 `setupProviders && …` 的降级语义一致）。 */
  const sourceCard = (row: ProviderRowDTO) => {
    if (row.id === 'subhd' || row.id === 'zimuku') {
      if (!setupProviders) return null
      if (row.id === 'subhd') {
        return <ProviderToggleCard key="subhd" id="subhd" state={setupProviders.subhd} reload={setupStatus.reload} />
      }
      return (
        <div key="zimuku" className="space-y-6">
          <ProviderToggleCard id="zimuku" state={setupProviders.zimuku} reload={setupStatus.reload} />
          {setupProviders.zimuku.enabled && <ZimukuVisionCard reload={setupStatus.reload} />}
        </div>
      )
    }
    return <ProviderCard key={row.id} row={row} reload={providers.reload} />
  }

  // 布局 spec 决策 A：设置页收口 --container-form（880px 表单可读横距）。四个 tab
  // 共用这一个顶层 Tabs，不像其他页要在每个 Section 分支上重复。
  return (
    <Tabs defaultValue="general" className="mx-auto w-full max-w-form">
      <TabsList>
        <TabsTrigger value="general">{t('settings_tab_general')}</TabsTrigger>
        <TabsTrigger value="providers">
          {t('settings_tab_providers')}
          {/* rows 还没到（加载中/降级）时不渲染数字徽章——渲染一个猜出来的 0/N 是谎话 */}
          {rows.length > 0 && (
            <Badge variant={providerBadgeVariant} className="ml-1">{configuredCount}/{providerTotal}</Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="media">
          {t('settings_tab_media')}
          {mediaUnconfigured ? <Badge variant="warning" className="ml-1">{t('settings_status_unconfigured')}</Badge> : null}
        </TabsTrigger>
        <TabsTrigger value="security">{t('settings_tab_security')}</TabsTrigger>
      </TabsList>

      <TabsContent value="general" className="p-6 space-y-6">
        <BehaviorSection settings={settingsData} />
        <SystemSection />
      </TabsContent>
      <TabsContent value="providers" className="p-6 space-y-6">
        {infraRows.map((row) => (
          <div key={row.id} className="space-y-6">
            <ProviderCard row={row} reload={providers.reload} />
            {row.id === 'llm' && translateRow && (
              <TranslateCard
                translate={translateRow}
                settings={settingsData.data ?? ({} as SettingsDTO)}
                onUpdated={setUpdated}
                reload={providers.reload}
              />
            )}
          </div>
        ))}
        {/* 源分组（registry spec §5.1）：单语言时唯一的 'all' 组平铺、零标题——观感与旧版
            一致；多语言时每组一个语言自称标题 + 通用组殿后。开关卡仍从 readProviders 判过
            形状的 setupProviders 读 enabled（那三层解引用的白屏史见上）。 */}
        {sourceGroups.map((group) => (
          <div key={group.lang} className="space-y-6">
            {group.lang !== 'all' && (
              <h3 className="text-sm font-medium text-weak">{groupTitle(group.lang)}</h3>
            )}
            {group.rows.map(sourceCard)}
          </div>
        ))}
      </TabsContent>
      <TabsContent value="media" className="p-6 space-y-6">
        <RootsManager roots={roots} />
      </TabsContent>
      <TabsContent value="security" className="p-6 space-y-6">
        <SecuritySection />
      </TabsContent>
    </Tabs>
  )
}
