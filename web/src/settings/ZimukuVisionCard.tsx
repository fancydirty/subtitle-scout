// web/src/settings/ZimukuVisionCard.tsx：zimuku 视觉兜底配置卡片（可选）。
// 三凭证（ZIMUKU_VISION_BASE_URL/API_KEY/MODEL），全填才能测试，测试通过才能保存。
// Clear 按钮清空三键（PUT 空串 = DELETE），破坏性确认。徽标三态（未配置/已配置/环境锁定）。
// 与 TranslateCard 不同：没有开关（zimuku 本身有 toggle），没有 segmented（只有专用模型一种形态）。
import { useState, useEffect } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../components/ui/alert-dialog.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { SettingsCard } from './SettingsCard.js'

interface Props {
  reload: () => void
}

const VISION_FIELDS = ['ZIMUKU_VISION_BASE_URL', 'ZIMUKU_VISION_API_KEY', 'ZIMUKU_VISION_MODEL'] as const
const PLACEHOLDERS: Record<string, string> = {
  ZIMUKU_VISION_BASE_URL: 'https://api.example.com/v1',
  ZIMUKU_VISION_API_KEY: 'sk-...',
  ZIMUKU_VISION_MODEL: 'gpt-4o',
}

export function ZimukuVisionCard({ reload }: Props) {
  const { t } = useT()
  const [secrets, setSecrets] = useState<Array<{ name: string; set: boolean; source: 'env' | 'db' }>>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // 加载当前配置的 secrets 状态
  useEffect(() => {
    void (async () => {
      try {
        const providers = await api.setupProviders()
        // setupProviders 返回的 secrets 里包含所有已配置的 secret
        // 从中筛选出 ZIMUKU_VISION_* 的三个
        const visionSecrets = providers.secrets.filter((s) =>
          VISION_FIELDS.includes(s.name as typeof VISION_FIELDS[number])
        )
        setSecrets(visionSecrets)
      } catch {
        // 加载失败不阻塞 UI
      }
    })()
  }, [])

  const secretMap = Object.fromEntries(secrets.map((s) => [s.name, s]))
  const isConfigured = VISION_FIELDS.some((n) => secretMap[n]?.set)
  const allEnv = secrets.length > 0 && secrets.every((s) => s.source === 'env')

  // 计算 status（SettingsCard 需要的枚举值）
  const status = allEnv ? 'locked' : isConfigured ? 'configured' : 'unconfigured'

  // 判断是否全部字段已填写（用于启用 Test 按钮）
  const allFilled = VISION_FIELDS.every((n) => {
    const val = drafts[n] ?? ''
    return val.trim().length > 0
  })

  // 判断是否可以保存（必须测试通过且有修改）
  const canSave = testResult?.ok && VISION_FIELDS.some((n) => touched[n])

  const handleChange = (name: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [name]: value }))
    setTouched((prev) => ({ ...prev, [name]: true }))
    // 清除测试结果（内容变化后需要重新测试）
    setTestResult(null)
    setError(null)
  }

  const handleTest = async () => {
    setTesting(true)
    setError(null)
    setTestResult(null)
    try {
      const req = {
        baseUrl: drafts.ZIMUKU_VISION_BASE_URL?.trim() ?? '',
        apiKey: drafts.ZIMUKU_VISION_API_KEY?.trim() ?? '',
        model: drafts.ZIMUKU_VISION_MODEL?.trim() ?? '',
      }
      const res = await api.testVision(req)
      if (res.success) {
        setTestResult({ ok: true, message: t('settings_zimuku_vision_test_ok') })
      } else {
        setTestResult({ ok: false, message: res.error ?? t('settings_zimuku_vision_test_fail') })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setBusy(true)
    setError(null)
    try {
      for (const name of VISION_FIELDS) {
        if (touched[name]) {
          const value = drafts[name]?.trim() ?? ''
          await api.putSecret({ name, value })
        }
      }
      reload()
      setTouched({})
      setTestResult(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    setBusy(true)
    setError(null)
    try {
      // 清空三个 secret（PUT 空串 = DELETE）
      for (const name of VISION_FIELDS) {
        await api.putSecret({ name, value: '' })
      }
      setDrafts({})
      setTouched({})
      setTestResult(null)
      setConfirmOpen(false)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SettingsCard
        title={t('settings_zimuku_vision_heading')}
        description={t('settings_zimuku_vision_description')}
        status={status}
      >
        <div className="space-y-4">
          {/* Model 字段 */}
          <div className="space-y-2">
            <label htmlFor="zimuku-vision-model" className="text-sm font-medium">{t('settings_zimuku_vision_model_label')}</label>
            <Input
              id="zimuku-vision-model"
              value={drafts.ZIMUKU_VISION_MODEL ?? (secretMap.ZIMUKU_VISION_MODEL?.set ? '••••••' : '')}
              onChange={(e) => handleChange('ZIMUKU_VISION_MODEL', e.target.value)}
              placeholder={PLACEHOLDERS.ZIMUKU_VISION_MODEL}
              disabled={busy || allEnv}
            />
          </div>

          {/* Base URL 字段 */}
          <div className="space-y-2">
            <label htmlFor="zimuku-vision-base-url" className="text-sm font-medium">{t('settings_zimuku_vision_base_url_label')}</label>
            <Input
              id="zimuku-vision-base-url"
              value={drafts.ZIMUKU_VISION_BASE_URL ?? (secretMap.ZIMUKU_VISION_BASE_URL?.set ? '••••••' : '')}
              onChange={(e) => handleChange('ZIMUKU_VISION_BASE_URL', e.target.value)}
              placeholder={PLACEHOLDERS.ZIMUKU_VISION_BASE_URL}
              disabled={busy || allEnv}
            />
          </div>

          {/* API Key 字段 */}
          <div className="space-y-2">
            <label htmlFor="zimuku-vision-api-key" className="text-sm font-medium">{t('settings_zimuku_vision_api_key_label')}</label>
            <Input
              id="zimuku-vision-api-key"
              type="password"
              value={drafts.ZIMUKU_VISION_API_KEY ?? (secretMap.ZIMUKU_VISION_API_KEY?.set ? '••••••' : '')}
              onChange={(e) => handleChange('ZIMUKU_VISION_API_KEY', e.target.value)}
              placeholder={PLACEHOLDERS.ZIMUKU_VISION_API_KEY}
              disabled={busy || allEnv}
            />
          </div>

          {/* 测试结果显示 */}
          {testResult && (
            <div className={`text-sm ${testResult.ok ? 'text-green-600' : 'text-red-600'}`}>
              {testResult.message}
            </div>
          )}

          {/* 错误信息 */}
          {error && <div className="text-sm text-red-600">{error}</div>}

          {/* 按钮组 */}
          <div className="flex gap-2">
            <Button
              onClick={handleTest}
              disabled={!allFilled || testing || busy || allEnv}
            >
              {testing ? t('settings_zimuku_vision_testing') : t('settings_zimuku_vision_test_label')}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!canSave || busy || allEnv}
            >
              Save
            </Button>
            {isConfigured && !allEnv && (
              <Button
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
                disabled={busy}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      </SettingsCard>

      {/* 清空确认对话框 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings_zimuku_vision_clear_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings_zimuku_vision_clear_confirm_body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleClear}>{t('settings_zimuku_vision_clear_action')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
