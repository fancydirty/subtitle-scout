// web/src/settings/TranslateSection.tsx：AI 翻译区（审计 Wave 3）——部署门状态行（TRANSLATE_*
// 三件套 present/absent 事实）+ 烧钱开关确认流（off→on 弹 AlertDialog 陈述配额风险）+ 休眠
// 警示（开关开了但部署门缺失=功能休眠,橙字如实）+ Workflow 观测入口。
// 数据源：useSettings（行为开关）+ useDeploySettings（部署门可见性,Wave 0 后端已补 TRANSLATE_*）。
import { useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { Switch } from '@astryxdesign/core/Switch'
import { VStack } from '@astryxdesign/core/VStack'
import { AlertDialog } from '@astryxdesign/core/AlertDialog'
import { Banner } from '@astryxdesign/core/Banner'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import { api } from '../api/client.js'
import type { Async } from '../api/hooks.js'
import type { SettingsDTO, DeploySettingsDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'

interface Props {
  settings: Async<SettingsDTO>
  deploy: Async<DeploySettingsDTO>
  onUpdated: (settings: SettingsDTO) => void
}

/** 部署门三件套的 present 事实——圆点+同色词（DESIGN.md §4 口径），absent=灰。 */
function GateRow({ label, present }: { label: string; present: boolean }) {
  return (
    <div className="settings-deploy-row" data-testid={`translate-gate-${label}`}>
      <StatusDot variant={present ? 'success' : 'neutral'} label={label} />
      <span className="settings-deploy-key">{label}</span>
      <Text type="supporting" color="secondary" as="span">
        {present ? 'present' : 'absent'}
      </Text>
    </div>
  )
}

export function TranslateSection({ settings, deploy, onUpdated }: Props) {
  const { t } = useT()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const enabled = settings.data?.ai_translate_enabled === 'true'
  const gate = deploy.data
    ? {
        baseUrl: (deploy.data.nonSecrets.TRANSLATE_BASE_URL ?? '') !== '',
        model: (deploy.data.nonSecrets.TRANSLATE_MODEL ?? '') !== '',
        apiKey: deploy.data.secrets.TRANSLATE_API_KEY?.present ?? false,
      }
    : null
  const gateReady = gate != null && gate.baseUrl && gate.model && gate.apiKey
  const dormant = enabled && gate != null && !gateReady

  async function commitEnabled(value: boolean) {
    setSaving(true)
    setError(null)
    try {
      const result = await api.updateSettings({ ai_translate_enabled: value ? 'true' : 'false' })
      onUpdated(result)
    } catch (e) {
      setError(t('settings_save_error_prefix') + String(e))
    } finally {
      setSaving(false)
      setConfirmOpen(false)
    }
  }

  return (
    <VStack gap={3}>
      <Text type="supporting" color="secondary" as="div">
        {t('settings_translate_section_heading')}
      </Text>

      {/* 部署门状态行（只读事实，零控件）——三件套缺一,daemon 自动翻译整体休眠。 */}
      <VStack gap={1}>
        <GateRow label="TRANSLATE_BASE_URL" present={gate?.baseUrl ?? false} />
        <GateRow label="TRANSLATE_MODEL" present={gate?.model ?? false} />
        <GateRow label="TRANSLATE_API_KEY" present={gate?.apiKey ?? false} />
      </VStack>

      <VStack gap={2}>
        <Switch
          label={t('settings_ai_translate_label')}
          value={enabled}
          onChange={(checked) => {
            // 烧钱开关:off→on 必须过确认流(PM 审计:重生成 API key 都有 AlertDialog,烧真钱的反而没有);
            // on→off 直存不弹。
            if (checked) setConfirmOpen(true)
            else void commitEnabled(false)
          }}
          isLoading={saving}
          status={error ? { type: 'error', message: error } : undefined}
        />
        <Text type="supporting" color="secondary">
          {t('settings_ai_translate_note')}
        </Text>
        {dormant ? (
          <Banner
            status="warning"
            title={t('settings_translate_dormant_warning')}
            data-testid="translate-dormant-warning"
          />
        ) : null}
        <Text type="supporting" color="secondary" as="div">
          <a href="#/workflow">{t('settings_translate_view_workflow')}</a>
        </Text>
      </VStack>

      <AlertDialog
        isOpen={confirmOpen}
        onOpenChange={(open) => { if (!open) setConfirmOpen(false) }}
        title={t('settings_translate_confirm_title')}
        description={gateReady
          ? t('settings_translate_confirm_body_ready')
          : t('settings_translate_confirm_body_missing')}
        actionLabel={t('settings_translate_confirm_action')}
        actionVariant="primary"
        isActionLoading={saving}
        onAction={() => void commitEnabled(true)}
      />
    </VStack>
  )
}
