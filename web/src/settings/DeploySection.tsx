// web/src/settings/DeploySection.tsx：部署区（dashboard-F6，只读）——env 脱敏展示，Jellyfin 式
// 部署/产品分界（DESIGN.md §1/§9："挂载=部署层，UI 变不出"）。零输入控件：这个组件树里不渲染
// 任何 <input>/<button> 或其它可交互元素——secrets 只给 present 圆点 + 尾 4 位，nonSecrets 只给
// 原样字符串，改动一律走 environment/compose，不在这里开一个"编辑部署配置"的口子。
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import type { Async } from '../api/hooks.js'
import type { DeploySettingsDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { secretDisplay } from './text.js'

interface Props {
  deploy: Async<DeploySettingsDTO>
}

export function DeploySection({ deploy }: Props) {
  const { t } = useT()

  return (
    <section className="settings-section">
      <Text type="label">{t('settings_deploy_heading')}</Text>
      <Text type="supporting" color="secondary">
        {t('settings_deploy_readonly_note')}
      </Text>

      {deploy.loading && !deploy.data ? (
        <Text type="code" color="secondary">
          loading…
        </Text>
      ) : deploy.error && !deploy.data ? (
        <div className="settings-deploy-error">{t('settings_deploy_error_prefix') + deploy.error}</div>
      ) : deploy.data ? (
        <VStack gap={4}>
          <VStack gap={2}>
            <Text type="supporting" color="secondary">
              {t('settings_deploy_secrets_heading')}
            </Text>
            {Object.entries(deploy.data.secrets).map(([key, secret]) => (
              <div className="settings-deploy-row" key={key}>
                <span className="settings-deploy-key">{key}</span>
                <HStack gap={1.5} vAlign="center">
                  <StatusDot
                    variant={secret.present ? 'success' : 'neutral'}
                    label={secret.present ? t('settings_deploy_present_word') : t('settings_deploy_absent_word')}
                  />
                  {/* 可见同色词——不能只靠圆点色（DESIGN.md §4：色盲/截图场景）。 */}
                  <span
                    className={
                      secret.present
                        ? 'settings-deploy-status-word settings-deploy-status-word-present'
                        : 'settings-deploy-status-word settings-deploy-status-word-absent'
                    }>
                    {secret.present ? t('settings_deploy_present_word') : t('settings_deploy_absent_word')}
                  </span>
                </HStack>
                <span className="settings-deploy-tail">{secretDisplay(secret)}</span>
              </div>
            ))}
          </VStack>
          <VStack gap={2}>
            <Text type="supporting" color="secondary">
              {t('settings_deploy_nonsecrets_heading')}
            </Text>
            {Object.entries(deploy.data.nonSecrets).map(([key, value]) => (
              <div className="settings-deploy-row" key={key}>
                <span className="settings-deploy-key">{key}</span>
                <span className="settings-deploy-value">{value ?? '—'}</span>
              </div>
            ))}
          </VStack>
        </VStack>
      ) : null}
    </section>
  )
}
