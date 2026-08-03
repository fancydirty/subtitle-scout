// web/src/settings/SystemSection.tsx：System 区（spec A §5.4）——Re-run setup wizard 入口。
// 重进机制 = rerun.ts 的 sessionStorage 标记 + reload：BootstrapGate 首探前读标记走 re-run 模式
// （硬门禁满足态直通、可手动 Re-test）。
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { VStack } from '@astryxdesign/core/VStack'
import { useT } from '../i18n/useT.js'
import { requestWizardRerun } from '../setup/rerun.js'

export function SystemSection() {
  const { t } = useT()
  return (
    <section className="settings-section">
      <Text type="label">{t('settings_system_rerun_wizard')}</Text>
      <VStack gap={2}>
        <Text type="supporting" color="secondary">{t('settings_system_rerun_wizard_desc')}</Text>
        <Button size="sm" variant="secondary" label={t('settings_system_rerun_wizard')} onClick={requestWizardRerun} />
      </VStack>
    </section>
  )
}
