// web/src/settings/DeploySection.tsx：部署区（只读）——非密 env 原样展示，Jellyfin 式部署/产品
// 分界（DESIGN.md §1/§9）。secrets 展示 2026-08-02 起归 ProvidersSection（可编辑+测试，
// spec A §5.4）；本区零输入控件的传统不变：改动一律走 environment/compose。
//
// 控件栈（Plan C Task 27 迁移）：Astryx Text/VStack 全卸——Text 按控件事典映射到手写 span，
// VStack 换裸 flex div。本区只读零控件（测试锁 querySelectorAll('input, button, …') 长度 0），
// 迁移一个控件都不许引入。
import type { Async } from '../api/hooks.js'
import type { DeploySettingsDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { localizeError } from '../lib/errorText.js'

interface Props {
  deploy: Async<DeploySettingsDTO>
}

export function DeploySection({ deploy }: Props) {
  const { t, lang } = useT()

  return (
    <section className="settings-section">
      <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_deploy_heading')}</span>
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t('settings_deploy_readonly_note')}
      </span>

      {deploy.loading && !deploy.data ? (
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">
          {t('common_loading')}
        </span>
      ) : deploy.error && !deploy.data ? (
        <div className="settings-deploy-error">{t('settings_deploy_error_prefix') + localizeError(deploy.error, lang)}</div>
      ) : deploy.data ? (
        <div className="flex flex-col gap-2">
          <span className="text-[11px] leading-4 text-muted-foreground">
            {t('settings_deploy_nonsecrets_heading')}
          </span>
          {Object.entries(deploy.data.nonSecrets).map(([key, value]) => (
            <div className="settings-deploy-row" key={key}>
              <span className="settings-deploy-key">{key}</span>
              <span className="settings-deploy-value">
                {value ?? '—'}
                {/* MEDIA_ROOTS 是首启种子，真正生效的守备目录在 media_roots 表（本页下方
                    RootsManager）——原样展示 env 值必须带这句注解，否则用户改 .env 重启后
                    看到这行变了就以为生效了（审计四轮 R4 抓获的既有误导）。 */}
                {key === 'MEDIA_ROOTS' ? (
                  <span className="text-[11px] leading-4 text-muted-foreground">
                    {t('settings_deploy_media_roots_seed_note')}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
