// web/src/setup/steps/StepRoots.tsx：wizard 步 6——守备目录（可跳过整步，spec A §3 步 6）。
// DirBrowser 是既有共享件（settings/DirBrowser.tsx，RootsManager 同款消费），本步只消费不改。
// addedCount 本地记、每次 onAdded 同步 patchStatus——步 7 Launch 的汇总清单读 roots.count。
import { useRef, useState } from 'react'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { DirBrowser } from '../../settings/DirBrowser.js'
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
      <DirBrowser startPath="/" onAdded={onAdded} />
      <p className="text-sm text-weak">{t('wizard_roots_skip_note')}</p>
      <StepFooter onBack={onBack}>
        <Button variant="ghost" onClick={onAdvance}>{t('wizard_skip_step')}</Button>
        <Button disabled={total === 0} onClick={onAdvance}>{t('wizard_continue')}</Button>
      </StepFooter>
    </div>
  )
}
