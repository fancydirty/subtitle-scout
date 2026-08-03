// web/src/settings/DeploySection.tsx：部署区（只读）——非密 env 原样展示，Jellyfin 式部署/产品
// 分界（DESIGN.md §1/§9）。secrets 展示 2026-08-02 起归 ProvidersSection（可编辑+测试，
// spec A §5.4）；本区零输入控件的传统不变：改动一律走 environment/compose。
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import type { Async } from '../api/hooks.js'
import type { DeploySettingsDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'

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
        <VStack gap={2}>
          <Text type="supporting" color="secondary">
            {t('settings_deploy_nonsecrets_heading')}
          </Text>
          {Object.entries(deploy.data.nonSecrets).map(([key, value]) => (
            <div className="settings-deploy-row" key={key}>
              <span className="settings-deploy-key">{key}</span>
              <span className="settings-deploy-value">
                {value ?? '—'}
                {/* MEDIA_ROOTS 是首启种子，真正生效的守备目录在 media_roots 表（本页下方
                    RootsManager）——原样展示 env 值必须带这句注解，否则用户改 .env 重启后
                    看到这行变了就以为生效了（审计四轮 R4 抓获的既有误导）。 */}
                {key === 'MEDIA_ROOTS' ? (
                  <Text type="supporting" color="secondary">
                    {t('settings_deploy_media_roots_seed_note')}
                  </Text>
                ) : null}
              </span>
            </div>
          ))}
        </VStack>
      ) : null}
    </section>
  )
}
