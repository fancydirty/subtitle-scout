// web/src/setup/steps/ui.tsx：wizard 步件共享的小件——状态点（灰/转/绿/红）与页脚
// （Back 在左、动作钮在右）。状态点是自绘圆点，不引图标库（spec A §5.3）。
import type { ReactNode } from 'react'
import { useT } from '../../i18n/useT.js'
import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'

export function StatusDot({ tone }: { tone: 'gray' | 'spin' | 'green' | 'red' }) {
  return (
    <span
      data-testid={`status-dot-${tone}`}
      aria-hidden
      className={cn('size-2 shrink-0 rounded-full', {
        'bg-input': tone === 'gray',
        'animate-pulse bg-fn-purple': tone === 'spin',
        'bg-fn-green': tone === 'green',
        'bg-fn-red': tone === 'red',
      })}
    />
  )
}

export function StepFooter({ onBack, children }: { onBack?: () => void; children?: ReactNode }) {
  const { t } = useT()
  return (
    <div className="mt-2 flex items-center justify-between gap-2">
      <div>{onBack ? <Button variant="ghost" onClick={onBack}>{t('wizard_back')}</Button> : null}</div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}
