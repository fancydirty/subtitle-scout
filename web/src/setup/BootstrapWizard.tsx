// web/src/setup/BootstrapWizard.tsx：七步全屏首跑向导（spec A §5.2）。
// 外壳只管步进与框架（步进点 + wordmark + 当前步标题/描述 + 卡片位）；每步的文案、表单、
// Continue/Skip 门禁都在步组件内——硬门禁规则属于步不属于壳。bootstrap 完成前观测台无物可观，
// 不提供 dismiss（spec §5.1 的有意锁死）；全屏 fixed 覆盖层同时服务 re-run 模式（罩住 Shell）。
//
// 分流（registry spec §5.2）：外壳拉一份 /setup/providers 行（kind/languages 派生字段）
// 连同语言步落库的 target_languages 一起下发；步定义的 skip(ctx) 为 true 的步整体不出现
// （步进点与流程都没有它）。语言步在最前，改语言只影响其后的步，activeSteps 重算安全。
import { useState } from 'react'
import type { SetupStatusDTO } from '../api/types.js'
import { useSetupProviders } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { WIZARD_STEPS } from './steps/registry.js'
import type { WizardDeriveCtx, WizardStepDef, WizardStepProps } from './steps/types.js'

export function BootstrapWizard({
  initialStatus,
  rerun,
  onComplete,
  steps = WIZARD_STEPS,
}: {
  initialStatus: SetupStatusDTO
  rerun: boolean
  onComplete: () => void
  /** 测试注入点：stub 步驱动外壳；生产永远走 registry 默认。 */
  steps?: WizardStepDef[]
}) {
  const { t } = useT()
  const [index, setIndex] = useState(0)
  const [status, setStatus] = useState<SetupStatusDTO>(initialStatus)
  const [targetLanguages, setTargetLanguages] = useState<string | null>(null)
  const providers = useSetupProviders()

  const ctx: WizardDeriveCtx = { targetLanguages, providerRows: providers.data?.providers ?? null }
  const activeSteps = steps.filter((s) => !(s.skip?.(ctx) ?? false))
  const step = activeSteps[Math.min(index, activeSteps.length - 1)]
  if (!step) return null

  const props: WizardStepProps = {
    status,
    ...ctx,
    patchStatus: (patch) => setStatus((s) => ({ ...s, ...patch })),
    setTargetLanguages: (csv) => setTargetLanguages(csv),
    rerun,
    onAdvance: () => setIndex((i) => Math.min(i + 1, activeSteps.length - 1)),
    onBack: () => setIndex((i) => Math.max(i - 1, 0)),
    onComplete,
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background text-foreground">
      <div className="mx-auto flex min-h-full w-full max-w-[560px] flex-col px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <span className="text-sm font-semibold tracking-wide">◈ Scout</span>
          <div className="flex items-center gap-2" role="img" aria-label={`${index + 1} / ${activeSteps.length}`}>
            {activeSteps.map((s, i) => (
              <span
                key={s.id}
                aria-hidden
                className={
                  'size-2 rounded-full ' +
                  (i < index ? 'bg-fn-green' : i === index ? 'bg-foreground' : 'bg-input')
                }
              />
            ))}
          </div>
        </div>
        <h1 className="text-xl font-semibold">{t(step.titleKey)}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t(step.descKey)}</p>
        <div className="mt-6 flex-1">
          <step.Component {...props} />
        </div>
      </div>
    </div>
  )
}
