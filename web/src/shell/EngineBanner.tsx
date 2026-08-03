// web/src/shell/EngineBanner.tsx：引擎关闭常驻细条（spec A §5.6）——仅 engineEnabled=false
// 渲染；Turn on 快捷 PUT 同键后 reload 立即消条（不等 15s 轮询）。加载中/拉取失败 → 不渲染：
// fail-open，宁可少一条 banner 不可误报"引擎已关"（§4.6 脏值哲学）。不画任何新状态页面。
// 用 shadcn Button——新 chrome 件直接落新栈（Task 13 底座已进场），Astryx 壳随 Spec C 迁移。
import { useState } from 'react'
import { api } from '../api/client.js'
import { useSetupStatus } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { Button } from '../components/ui/button.js'

export function EngineBanner() {
  const { t } = useT()
  const { data, reload } = useSetupStatus()
  const [busy, setBusy] = useState(false)

  if (!data || data.engineEnabled) return null

  const turnOn = async () => {
    setBusy(true)
    try {
      await api.updateSettings({ engine_enabled: 'true' })
      reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-2 text-sm">
      <span>{t('engine_banner_off')}</span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void turnOn()}>
        {t('engine_banner_turn_on')}
      </Button>
    </div>
  )
}
