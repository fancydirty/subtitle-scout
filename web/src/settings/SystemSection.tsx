// web/src/settings/SystemSection.tsx：System 区（spec A §5.4）——Re-run setup wizard 入口。
// 重进机制 = rerun.ts 的 sessionStorage 标记 + reload：BootstrapGate 首探前读标记走 re-run 模式
// （硬门禁满足态直通、可手动 Re-test）。
//
// 控件栈（Plan C Task 26 迁移）：Astryx Text/Button/VStack 全卸——Button children 化
// （label prop 退役），VStack 换裸 flex div，Text 按控件事典映射到手写 span。
import { Button } from '../components/ui/button.js'
import { useT } from '../i18n/useT.js'
import { requestWizardRerun } from '../setup/rerun.js'

export function SystemSection() {
  const { t } = useT()
  return (
    <section className="settings-section">
      <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_system_rerun_wizard')}</span>
      <div className="flex flex-col gap-2">
        <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_system_rerun_wizard_desc')}</span>
        <div>
          <Button size="sm" variant="secondary" onClick={requestWizardRerun}>
            {t('settings_system_rerun_wizard')}
          </Button>
        </div>
      </div>
    </section>
  )
}
