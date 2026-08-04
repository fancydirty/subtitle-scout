// web/src/settings/TranslateSection.tsx：AI 翻译区（审计 Wave 3）——部署门状态行（TRANSLATE_*
// 三件套 present/absent 事实）+ 烧钱开关确认流（off→on 弹 AlertDialog 陈述配额风险）+ 休眠
// 警示（开关开了但部署门缺失=功能休眠,橙字如实）+ Workflow 观测入口。
// 数据源：useSettings（行为开关）+ useDeploySettings（部署门可见性,Wave 0 后端已补 TRANSLATE_*）。
//
// 控件栈（Plan C Task 26 迁移）：Astryx StatusDot/Switch/Banner/AlertDialog/Text/VStack 全卸——
// StatusDot/Banner 走 components/ui 同名零改件；Switch 的 value/onChange 改名
// checked/onCheckedChange（Radix 签名）+ aria-label 手写（Astryx 把 label 提升为可及名，
// shadcn 件没有 label prop），可见文案放旁边 span；Switch status 错误行换 <p role="alert">
// （条件插入即 SR 自动播报）。AlertDialog 换 Radix 组合式：Action 默认 click 即自动关闭，
// 现网语义是 commitEnabled 的 finally 手动关（飞行中保持开启），故 Action onClick 必须
// e.preventDefault() 拦住默认关闭；关闭即整棵卸载（既有断言用 queryByRole('alertdialog')
// 缺席判关——Astryx/Radix 两版都渲染 alertdialog role，不是 dialog）。
import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js'
import { Banner } from '../components/ui/banner.js'
import { StatusDot } from '../components/ui/status-dot.js'
import { Switch } from '../components/ui/switch.js'
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
      <span className="text-[11px] leading-4 text-muted-foreground">
        {present ? 'present' : 'absent'}
      </span>
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
    <div className="flex flex-col gap-3">
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t('settings_translate_section_heading')}
      </span>

      {/* 部署门状态行（只读事实，零控件）——三件套缺一,daemon 自动翻译整体休眠。 */}
      <div className="flex flex-col gap-1">
        <GateRow label="TRANSLATE_BASE_URL" present={gate?.baseUrl ?? false} />
        <GateRow label="TRANSLATE_MODEL" present={gate?.model ?? false} />
        <GateRow label="TRANSLATE_API_KEY" present={gate?.apiKey ?? false} />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Switch
            aria-label={t('settings_ai_translate_label')}
            checked={enabled}
            onCheckedChange={(checked) => {
              // 烧钱开关:off→on 必须过确认流(PM 审计:重生成 API key 都有 AlertDialog,烧真钱的反而没有);
              // on→off 直存不弹。
              if (checked) setConfirmOpen(true)
              else void commitEnabled(false)
            }}
            disabled={saving}
          />
          <span className="text-[13px] font-medium leading-5 text-foreground">
            {t('settings_ai_translate_label')}
          </span>
        </div>
        <span className="text-[11px] leading-4 text-muted-foreground">
          {t('settings_ai_translate_note')}
        </span>
        {error ? <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p> : null}
        {dormant ? (
          <Banner
            status="warning"
            title={t('settings_translate_dormant_warning')}
            data-testid="translate-dormant-warning"
          />
        ) : null}
        <div className="text-[11px] leading-4 text-muted-foreground">
          <a href="#/workflow">{t('settings_translate_view_workflow')}</a>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings_translate_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {gateReady
                ? t('settings_translate_confirm_body_ready')
                : t('settings_translate_confirm_body_missing')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* Cancel 用字面量——i18n 表无此键，不为它加键（Task 26 铁规）。 */}
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(e) => {
                // Radix Action 默认 click 即关闭；现网语义是 commitEnabled 的 finally 手动关
                // （飞行中靠 disabled 守住），这里必须拦住默认关闭，成功/失败都交 finally。
                e.preventDefault()
                void commitEnabled(true)
              }}
            >
              {t('settings_translate_confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
