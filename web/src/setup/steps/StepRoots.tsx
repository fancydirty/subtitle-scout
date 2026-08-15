// web/src/setup/steps/StepRoots.tsx：向导步 6——输入媒体目录路径（可跳过）。
// 输入组件为共享的 RootPathInput；每成功添加一个就同步 roots 计数。
import { useRef, useState } from 'react'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { RootPathInput } from '../../settings/RootPathInput.js'
import { StepFooter } from './ui.js'
import type { WizardStepProps } from './types.js'

export function StepRoots({ status, patchStatus, onAdvance, onBack }: WizardStepProps) {
  const { t } = useT()
  const base = useRef(status.roots.count).current // 挂载时真值；换步即重挂
  const addsRef = useRef(0)
  const [added, setAdded] = useState(0)
  const total = base + added

  const onAdded = () => {
    addsRef.current += 1
    setAdded(addsRef.current)
    patchStatus({ roots: { count: base + addsRef.current } })
  }

  return (
    <div className="flex flex-col gap-5">
      <RootPathInput onAdded={onAdded} />
      <p className="text-sm text-weak">{t('wizard_roots_skip_note')}</p>
      <StepFooter onBack={onBack}>
        <Button variant="ghost" onClick={onAdvance}>{t('wizard_skip_step')}</Button>
        <Button disabled={total === 0} onClick={onAdvance}>{t('wizard_continue')}</Button>
      </StepFooter>
    </div>
  )
}
